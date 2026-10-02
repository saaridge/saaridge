//! Saaridge mediated /host FUSE (Rust) — IPC to bridge :7333.
mod ipc;

use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fuser::{
    FileAttr, FileType, Filesystem, MountOption, Notifier, ReplyAttr, ReplyData, ReplyDirectory,
    ReplyEmpty, ReplyEntry, ReplyWrite, Request, Session,
};
use libc::{EACCES, EIO, ENOENT, ENOTDIR, EROFS};
use log::{info, warn};
use parking_lot::Mutex;
use serde_json::Value;

use ipc::FsIpc;

const TTL: Duration = Duration::from_secs(1);
const META_TTL: Duration = Duration::from_secs(5);
const TREE_DEPTH: u32 = 4;
const TREE_MAX: u32 = 8000;
const BODY_MAX_FILE: usize = 2 * 1024 * 1024;
const BODY_MAX_TOTAL: usize = 64 * 1024 * 1024;
const BLOCK_SIZE: u64 = 4096;

// Reported by `saaridge-hostfs --capabilities` so the watchdog can detect a
// binary from an older image that silently lacks a feature it depends on.
// Grepping the binary for the feature's string literal does not work: the
// optimiser folds short literal comparisons into immediate loads and drops
// them from .rodata. These tokens are printed, so they always survive.
static CAPABILITIES: &[&str] = &["policy-invalidate", "path-invalidate"];

static EXCLUDES: &[&str] = &[
    "node_modules",
    ".npm",
    ".yarn",
    ".pnpm-store",
    ".parcel-cache",
    ".eslintcache",
    ".next",
    ".nuxt",
    ".turbo",
    ".vercel",
    ".output",
    ".svelte-kit",
    "dist",
    "build",
    "coverage",
    ".venv",
    "venv",
    ".tox",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".eggs",
    ".ipynb_checkpoints",
    "htmlcov",
    ".hypothesis",
    "vendor",
    ".bundle",
    "target",
    ".gradle",
    ".idea",
    "out",
    ".bloop",
    ".metals",
    "Pods",
    "DerivedData",
    "xcuserdata",
    ".swiftpm",
    "bin",
    "obj",
    "packages",
    ".vs",
    ".dart_tool",
    "_build",
    ".elixir_ls",
    "deps",
    ".stack-work",
    "dist-newstyle",
    ".git",
    ".cache",
    "Library",
];

fn is_excluded(name: &str) -> bool {
    EXCLUDES.iter().any(|e| *e == name)
}

fn under_excluded(path: &str) -> bool {
    path.split('/').filter(|p| !p.is_empty()).any(is_excluded)
}

fn mk_attr(ino: u64, is_dir: bool, size: u64, mtime_ms: f64, uid: u32, gid: u32) -> FileAttr {
    let secs = if mtime_ms > 0.0 {
        (mtime_ms / 1000.0) as u64
    } else {
        UNIX_EPOCH
            .elapsed()
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    let mtime = UNIX_EPOCH + Duration::from_secs(secs);
    FileAttr {
        ino,
        size,
        blocks: (size + BLOCK_SIZE - 1) / BLOCK_SIZE,
        atime: mtime,
        mtime,
        ctime: mtime,
        crtime: mtime,
        kind: if is_dir {
            FileType::Directory
        } else {
            FileType::RegularFile
        },
        perm: if is_dir { 0o755 } else { 0o644 },
        nlink: if is_dir { 3 } else { 1 },
        uid,
        gid,
        rdev: 0,
        blksize: BLOCK_SIZE as u32,
        flags: 0,
    }
}

fn ino_for(path: &str) -> u64 {
    let mut h: u64 = 0;
    for b in path.bytes() {
        h = h.wrapping_mul(131).wrapping_add(b as u64);
    }
    if h == 0 {
        1
    } else {
        h
    }
}

#[derive(Clone)]
struct EntryMeta {
    is_dir: bool,
    size: u64,
    mtime_ms: f64,
    /// True when the size came from a per-file stat, which reports the *mediated*
    /// length. Directory listings carry raw host sizes, and mediated text can be
    /// longer (a `vault://` marker replaces a shorter email), so a listing must
    /// never overwrite a verified size: the kernel clamps reads to attr.size and
    /// would hand out a truncated, unresolvable marker.
    verified: bool,
}

/// Merge a listing entry over whatever is cached. A listing reports the raw host
/// size, so when a per-file stat already established the mediated size, keep it —
/// otherwise the next read gets clamped to the shorter raw length.
fn keep_verified_size(cached: Option<&EntryMeta>, fresh: EntryMeta) -> EntryMeta {
    match cached {
        Some(prev) if prev.verified && !fresh.is_dir && !prev.is_dir => EntryMeta {
            size: prev.size,
            verified: true,
            ..fresh
        },
        _ => fresh,
    }
}

struct DirListing {
    entries: Vec<(String, EntryMeta)>,
    at: Instant,
}

struct BodyHit {
    buf: Vec<u8>,
    mtime_ms: f64,
    size: u64,
}

struct BodyMemo {
    map: HashMap<String, BodyHit>,
    order: VecDeque<String>,
    bytes: usize,
}

impl BodyMemo {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
        }
    }

    fn get(&mut self, path: &str, mtime_ms: f64, size: u64) -> Option<Vec<u8>> {
        let hit = self.map.get(path)?;
        if (hit.mtime_ms - mtime_ms).abs() > f64::EPSILON || hit.size != size {
            self.drop(path);
            return None;
        }
        let buf = hit.buf.clone();
        if let Some(pos) = self.order.iter().position(|p| p == path) {
            self.order.remove(pos);
        }
        self.order.push_back(path.to_string());
        Some(buf)
    }

    fn put(&mut self, path: &str, buf: Vec<u8>, mtime_ms: f64, size: u64) {
        if buf.is_empty() || buf.len() > BODY_MAX_FILE || size as usize > BODY_MAX_FILE {
            return;
        }
        self.drop(path);
        self.bytes += buf.len();
        self.map.insert(
            path.to_string(),
            BodyHit {
                buf,
                mtime_ms,
                size,
            },
        );
        self.order.push_back(path.to_string());
        while self.bytes > BODY_MAX_TOTAL {
            if let Some(old) = self.order.pop_front() {
                self.drop(&old);
            } else {
                break;
            }
        }
    }

    fn drop(&mut self, path: &str) {
        if let Some(hit) = self.map.remove(path) {
            self.bytes = self.bytes.saturating_sub(hit.buf.len());
        }
        if let Some(pos) = self.order.iter().position(|p| p == path) {
            self.order.remove(pos);
        }
    }

    fn bust_prefix(&mut self, path: &str) {
        self.drop(path);
        let prefix = if path.ends_with('/') {
            path.to_string()
        } else {
            format!("{path}/")
        };
        let keys: Vec<String> = self
            .map
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for k in keys {
            self.drop(&k);
        }
    }

    fn clear_all(&mut self) {
        self.map.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

struct HostFs {
    ipc: Arc<FsIpc>,
    agent_id: String,
    uid: u32,
    gid: u32,
    next_fh: AtomicU64,
    dirs: Mutex<HashMap<String, DirListing>>,
    meta: Mutex<HashMap<String, EntryMeta>>,
    body: Mutex<BodyMemo>,
    ino_map: Mutex<HashMap<u64, String>>,
    path_ino: Mutex<HashMap<String, u64>>,
    notifier: Arc<Mutex<Option<Notifier>>>,
    invalidate_file: String,
    host_home: Mutex<String>,
    saaridge_root: Mutex<String>,
}

impl HostFs {
    fn new(
        ipc: Arc<FsIpc>,
        agent_id: String,
        uid: u32,
        gid: u32,
        notifier: Arc<Mutex<Option<Notifier>>>,
    ) -> Self {
        let invalidate_file = std::env::var("HOSTFS_INVALIDATE_FILE")
            .unwrap_or_else(|_| "/tmp/saaridge-fs-invalidate".into());
        let fs = Self {
            ipc,
            agent_id,
            uid,
            gid,
            next_fh: AtomicU64::new(2),
            dirs: Mutex::new(HashMap::new()),
            meta: Mutex::new(HashMap::new()),
            body: Mutex::new(BodyMemo::new()),
            ino_map: Mutex::new(HashMap::new()),
            path_ino: Mutex::new(HashMap::new()),
            notifier,
            invalidate_file,
            host_home: Mutex::new(String::new()),
            saaridge_root: Mutex::new(String::new()),
        };
        for p in ["/", "/workspaces", "/shared", "/home"] {
            fs.remember_ino(p);
        }
        fs
    }

    fn remember_ino(&self, path: &str) -> u64 {
        let mut path_ino = self.path_ino.lock();
        if let Some(&ino) = path_ino.get(path) {
            return ino;
        }
        let ino = if path == "/" { 1 } else { ino_for(path) };
        path_ino.insert(path.to_string(), ino);
        self.ino_map.lock().insert(ino, path.to_string());
        ino
    }

    fn path_for_ino(&self, ino: u64) -> Option<String> {
        self.ino_map.lock().get(&ino).cloned()
    }

    fn host_path(&self, fuse: &str) -> String {
        let rel = fuse.trim_start_matches('/');
        if rel == "home" || rel.starts_with("home/") {
            let rest = rel.trim_start_matches("home").trim_start_matches('/');
            if rest.is_empty() {
                "~".into()
            } else {
                format!("~/{rest}")
            }
        } else if rel.is_empty() || rel == "." {
            "~/Saaridge".into()
        } else {
            format!("~/Saaridge/{rel}")
        }
    }

    fn child(parent: &str, name: &str) -> String {
        if parent == "/" {
            format!("/{name}")
        } else {
            format!("{parent}/{name}")
        }
    }

    fn bust(&self, path: &str) {
        let mut dirs = self.dirs.lock();
        let mut meta = self.meta.lock();
        dirs.remove(path);
        meta.remove(path);
        self.body.lock().bust_prefix(path);
        let parent = Path::new(path)
            .parent()
            .map(|p| {
                let s = p.to_string_lossy();
                if s.is_empty() {
                    "/".to_string()
                } else {
                    s.to_string()
                }
            })
            .unwrap_or_else(|| "/".into());
        dirs.remove(&parent);
        let prefix = if path.ends_with('/') {
            path.to_string()
        } else {
            format!("{path}/")
        };
        dirs.retain(|k, _| !(k == path || k.starts_with(&prefix)));
        meta.retain(|k, _| !(k == path || k.starts_with(&prefix)));
    }

    fn host_abs_to_fuse(&self, host_abs: &str) -> Option<String> {
        if host_abs.is_empty() {
            return None;
        }
        let p = host_abs.trim_end_matches('/');
        let home = self.host_home.lock().clone();
        let ob = self.saaridge_root.lock().clone();
        let home = home.trim_end_matches('/');
        let ob = ob.trim_end_matches('/');
        if !ob.is_empty() && (p == ob || p.starts_with(&(ob.to_string() + "/"))) {
            let rest = p[ob.len()..].trim_start_matches('/');
            if rest.is_empty() {
                return Some("/".into());
            }
            return Some(format!("/{rest}"));
        }
        if !home.is_empty() && (p == home || p.starts_with(&(home.to_string() + "/"))) {
            let rest = p[home.len()..].trim_start_matches('/');
            if rest.is_empty() {
                return Some("/home".into());
            }
            return Some(format!("/home/{rest}"));
        }
        None
    }

    fn drain_invalidate_file(&self) {
        let path = &self.invalidate_file;
        let Ok(raw) = std::fs::read_to_string(path) else {
            return;
        };
        let _ = std::fs::write(path, "");
        for line in raw.lines() {
            let host_p = line.trim();
            if host_p.is_empty() {
                continue;
            }
            if matches!(
                host_p,
                "__saaridge_policy__" | "__policy__" | "@policy" | "/"
            ) {
                // Clearing our own maps is not enough: the kernel caches attrs and
                // page contents independently, and it sizes a read from the attr it
                // already holds. A policy change can make the mediated text longer
                // (a `vault://` marker replaces a shorter email), so without an
                // explicit invalidation the next read is clamped to the old size and
                // returns a cut-off marker. Policy changes are rare, so tell the
                // kernel to drop every file it knows about.
                let files: Vec<String> = {
                    let meta = self.meta.lock();
                    meta.iter()
                        .filter(|(_, m)| !m.is_dir)
                        .map(|(p, _)| p.clone())
                        .collect()
                };
                self.body.lock().clear_all();
                self.dirs.lock().clear();
                self.meta.lock().clear();
                self.notify_kernel_many(&files);
                continue;
            }
            if let Some(fuse_p) = self.host_abs_to_fuse(host_p) {
                // External change (MCP/API/other client): bust + kernel inval so
                // open editors re-stat/re-read mediated host bytes.
                self.after_mutate(&fuse_p, true);
            }
        }
    }

    fn refresh_meta(&self, fuse_path: &str) {
        match self.ipc.stat(&self.host_path(fuse_path)) {
            Ok(info) => {
                let m = EntryMeta {
                    is_dir: info
                        .get("isDirectory")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    size: info.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    mtime_ms: info.get("mtimeMs").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    verified: true,
                };
                self.remember_ino(fuse_path);
                self.meta.lock().insert(fuse_path.to_string(), m);
            }
            Err(_) => {
                self.meta.lock().remove(fuse_path);
            }
        }
    }

    /// Entry needed to invalidate one path in the kernel's caches.
    fn inval_target(&self, fuse_path: &str) -> (u64, u64, Option<std::ffi::OsString>) {
        let ino = self.remember_ino(fuse_path);
        let mut parent_ino = 0u64;
        let mut name_owned: Option<std::ffi::OsString> = None;
        if let Some(name) = Path::new(fuse_path).file_name() {
            let parent = Path::new(fuse_path)
                .parent()
                .map(|p| {
                    let s = p.to_string_lossy();
                    if s.is_empty() {
                        "/".to_string()
                    } else {
                        s.to_string()
                    }
                })
                .unwrap_or_else(|| "/".into());
            parent_ino = self.remember_ino(&parent);
            name_owned = Some(name.to_os_string());
        }
        (ino, parent_ino, name_owned)
    }

    /// Invalidate many paths from a single thread. One thread per path would be
    /// thousands of threads after a policy change.
    fn notify_kernel_many(&self, fuse_paths: &[String]) {
        if fuse_paths.is_empty() {
            return;
        }
        let targets: Vec<_> = fuse_paths.iter().map(|p| self.inval_target(p)).collect();
        let notifier = Arc::clone(&self.notifier);
        // Never notify on the FUSE request thread — inval while the kernel is
        // waiting for this reply can deadlock the mount.
        std::thread::spawn(move || {
            let guard = notifier.lock();
            let Some(n) = guard.as_ref() else {
                return;
            };
            for (ino, parent_ino, name) in targets {
                let _ = n.inval_inode(ino, 0, 0);
                if let Some(name) = name.as_ref() {
                    let _ = n.inval_entry(parent_ino, name);
                }
            }
        });
    }

    fn notify_kernel(&self, fuse_path: &str) {
        let ino = self.remember_ino(fuse_path);
        let mut parent_ino = 0u64;
        let mut name_owned: Option<std::ffi::OsString> = None;
        if let Some(name) = Path::new(fuse_path).file_name() {
            let parent = Path::new(fuse_path)
                .parent()
                .map(|p| {
                    let s = p.to_string_lossy();
                    if s.is_empty() {
                        "/".to_string()
                    } else {
                        s.to_string()
                    }
                })
                .unwrap_or_else(|| "/".into());
            parent_ino = self.remember_ino(&parent);
            name_owned = Some(name.to_os_string());
        }
        let notifier = Arc::clone(&self.notifier);
        // Never notify on the FUSE request thread — inval while the kernel is
        // waiting for this reply can deadlock the mount.
        std::thread::spawn(move || {
            let guard = notifier.lock();
            let Some(n) = guard.as_ref() else {
                return;
            };
            let _ = n.inval_inode(ino, 0, 0);
            if let Some(name) = name_owned.as_ref() {
                let _ = n.inval_entry(parent_ino, name);
            }
        });
    }

    /// Bust caches, refresh host stat into RAM, optionally notify the kernel so
    /// open editors re-read mediated bytes after a write (local or via events).
    fn after_mutate(&self, fuse_path: &str, notify: bool) {
        self.bust(fuse_path);
        self.refresh_meta(fuse_path);
        if notify {
            self.notify_kernel(fuse_path);
        }
    }

    fn ingest_tree(&self, root: &str, entries: &[Value]) {
        let mut by_parent: HashMap<String, HashMap<String, EntryMeta>> = HashMap::new();
        for e in entries {
            let rel = e
                .get("rel")
                .or_else(|| e.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim_matches('/');
            if rel.is_empty() {
                continue;
            }
            let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
            if parts.iter().any(|p| is_excluded(p)) {
                continue;
            }
            let is_dir = e
                .get("isDirectory")
                .or_else(|| e.get("isDir"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let size = e.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            let mtime_ms = e.get("mtimeMs").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let mut parent = root.to_string();
            for (i, part) in parts.iter().enumerate() {
                let leaf = i + 1 == parts.len();
                let meta = EntryMeta {
                    is_dir: if leaf { is_dir } else { true },
                    size: if leaf { size } else { 0 },
                    mtime_ms: if leaf { mtime_ms } else { 0.0 },
                    verified: false,
                };
                by_parent
                    .entry(parent.clone())
                    .or_default()
                    .insert((*part).to_string(), meta);
                parent = Self::child(&parent, part);
            }
        }
        let mut dirs = self.dirs.lock();
        let mut meta_map = self.meta.lock();
        meta_map.insert(
            root.to_string(),
            EntryMeta {
                is_dir: true,
                size: 0,
                mtime_ms: 0.0,
                verified: true,
            },
        );
        for (parent, names) in by_parent {
            let mut list = Vec::new();
            for (name, m) in names {
                let child = Self::child(&parent, &name);
                self.remember_ino(&child);
                let m = keep_verified_size(meta_map.get(&child), m);
                meta_map.insert(child, m.clone());
                list.push((name, m));
            }
            dirs.insert(
                parent,
                DirListing {
                    entries: list,
                    at: Instant::now(),
                },
            );
        }
        dirs.entry(root.to_string()).or_insert_with(|| DirListing {
            entries: Vec::new(),
            at: Instant::now(),
        });
    }

    fn ensure_listing(&self, fuse_dir: &str) -> Result<Vec<(String, EntryMeta)>, i32> {
        {
            let dirs = self.dirs.lock();
            if let Some(hit) = dirs.get(fuse_dir) {
                if hit.at.elapsed() < META_TTL {
                    return Ok(hit.entries.clone());
                }
            }
        }
        if under_excluded(fuse_dir) {
            let resp = self
                .ipc
                .list(&self.host_path(fuse_dir), true)
                .map_err(|e| map_err(&e))?;
            let mut list = Vec::new();
            let mut meta_map = self.meta.lock();
            if let Some(arr) = resp.get("entries").and_then(|v| v.as_array()) {
                for e in arr {
                    let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if name.is_empty() || is_excluded(name) || name.starts_with(".saaridge-") {
                        continue;
                    }
                    let m = EntryMeta {
                        is_dir: e
                            .get("isDirectory")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                        size: e.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                        mtime_ms: e.get("mtimeMs").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        verified: false,
                    };
                    let child = Self::child(fuse_dir, name);
                    self.remember_ino(&child);
                    let m = keep_verified_size(meta_map.get(&child), m);
                    meta_map.insert(child, m.clone());
                    list.push((name.to_string(), m));
                }
            }
            meta_map.insert(
                fuse_dir.to_string(),
                EntryMeta {
                    is_dir: true,
                    size: 0,
                    mtime_ms: 0.0,
                    verified: true,
                },
            );
            drop(meta_map);
            self.dirs.lock().insert(
                fuse_dir.to_string(),
                DirListing {
                    entries: list.clone(),
                    at: Instant::now(),
                },
            );
            Ok(list)
        } else {
            let t0 = Instant::now();
            let resp = self
                .ipc
                .tree(&self.host_path(fuse_dir), TREE_DEPTH, TREE_MAX)
                .map_err(|e| map_err(&e))?;
            let entries = resp
                .get("entries")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            self.ingest_tree(fuse_dir, &entries);
            info!(
                "bridge-tree {} entries={} in {}ms",
                fuse_dir,
                entries.len(),
                t0.elapsed().as_millis()
            );
            let dirs = self.dirs.lock();
            Ok(dirs
                .get(fuse_dir)
                .map(|d| d.entries.clone())
                .unwrap_or_default())
        }
    }

    fn stat_path(&self, fuse: &str) -> Result<EntryMeta, i32> {
        {
            let meta = self.meta.lock();
            if let Some(m) = meta.get(fuse) {
                return Ok(m.clone());
            }
        }
        let info = self
            .ipc
            .stat(&self.host_path(fuse))
            .map_err(|e| map_err(&e))?;
        let m = EntryMeta {
            is_dir: info
                .get("isDirectory")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            size: info.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            mtime_ms: info.get("mtimeMs").and_then(|v| v.as_f64()).unwrap_or(0.0),
            verified: true,
        };
        self.remember_ino(fuse);
        self.meta.lock().insert(fuse.to_string(), m.clone());
        Ok(m)
    }
}

fn map_err(e: &ipc::IpcError) -> i32 {
    match e.code.as_str() {
        "ENOENT" => ENOENT,
        "EROFS" => EROFS,
        "EACCES" | "EAUTH" => EACCES,
        "ENOTDIR" => ENOTDIR,
        _ => EIO,
    }
}

impl Filesystem for HostFs {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let Some(parent_path) = self.path_for_ino(parent) else {
            reply.error(ENOENT);
            return;
        };
        let name = name.to_string_lossy();
        if parent_path == "/" {
            if matches!(name.as_ref(), "workspaces" | "shared" | "home") {
                let child = Self::child(&parent_path, &name);
                let ino = self.remember_ino(&child);
                reply.entry(&TTL, &mk_attr(ino, true, 0, 0.0, self.uid, self.gid), 0);
                return;
            }
            reply.error(ENOENT);
            return;
        }
        if parent_path == "/workspaces" {
            if name.as_ref() == self.agent_id {
                let child = Self::child(&parent_path, &name);
                let ino = self.remember_ino(&child);
                reply.entry(&TTL, &mk_attr(ino, true, 0, 0.0, self.uid, self.gid), 0);
                return;
            }
            reply.error(ENOENT);
            return;
        }
        // Parent readdir omits excludes; lookup still allowed so explicit
        // path opens (…/node_modules) can resolve via path knowledge.
        let child = Self::child(&parent_path, &name);
        match self.stat_path(&child) {
            Ok(m) => {
                let ino = self.remember_ino(&child);
                reply.entry(
                    &TTL,
                    &mk_attr(ino, m.is_dir, m.size, m.mtime_ms, self.uid, self.gid),
                    0,
                );
            }
            Err(e) => reply.error(e),
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyAttr) {
        self.drain_invalidate_file();
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        if matches!(
            path.as_str(),
            "/" | "/workspaces" | "/shared" | "/home"
        ) {
            reply.attr(&TTL, &mk_attr(ino, true, 0, 0.0, self.uid, self.gid));
            return;
        }
        // A directory listing only knows the raw host size, and the kernel clamps
        // reads to the attr size it gets here — which would truncate mediated text
        // that grew into an unresolvable `vault://` fragment. Pay for one stat when
        // the cached size is not yet verified. `lookup` deliberately keeps using the
        // listing, so `ls -l` stays a single round trip per directory.
        let cached_unverified = {
            let meta = self.meta.lock();
            matches!(meta.get(&path), Some(m) if !m.verified && !m.is_dir)
        };
        if cached_unverified {
            self.refresh_meta(&path);
        }
        match self.stat_path(&path) {
            Ok(m) => reply.attr(
                &TTL,
                &mk_attr(ino, m.is_dir, m.size, m.mtime_ms, self.uid, self.gid),
            ),
            Err(e) => reply.error(e),
        }
    }

    fn readdir(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        self.drain_invalidate_file();
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        let mut entries: Vec<(u64, FileType, String)> = Vec::new();
        entries.push((ino, FileType::Directory, ".".into()));
        entries.push((1, FileType::Directory, "..".into()));
        if path == "/" {
            for name in ["workspaces", "shared", "home"] {
                let child = Self::child(&path, name);
                entries.push((self.remember_ino(&child), FileType::Directory, name.into()));
            }
        } else if path == "/workspaces" {
            let child = Self::child(&path, &self.agent_id);
            entries.push((
                self.remember_ino(&child),
                FileType::Directory,
                self.agent_id.clone(),
            ));
        } else {
            match self.ensure_listing(&path) {
                Ok(list) => {
                    for (name, m) in list {
                        let child = Self::child(&path, &name);
                        let cino = self.remember_ino(&child);
                        let kind = if m.is_dir {
                            FileType::Directory
                        } else {
                            FileType::RegularFile
                        };
                        entries.push((cino, kind, name));
                    }
                }
                Err(e) => {
                    reply.error(e);
                    return;
                }
            }
        }
        for (i, (cino, kind, name)) in entries.into_iter().enumerate().skip(offset as usize) {
            if reply.add(cino, (i + 1) as i64, kind, name) {
                break;
            }
        }
        reply.ok();
    }

    fn open(&mut self, _req: &Request<'_>, _ino: u64, _flags: i32, reply: fuser::ReplyOpen) {
        let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
        reply.opened(fh, 0);
    }

    fn read(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyData,
    ) {
        self.drain_invalidate_file();
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        let meta = match self.stat_path(&path) {
            Ok(m) => m,
            Err(e) => {
                reply.error(e);
                return;
            }
        };
        let off = offset.max(0) as u64;
        let want_full = off == 0 && (size as u64) >= meta.size && meta.size > 0;
        if want_full && (meta.size as usize) <= BODY_MAX_FILE {
            if let Some(buf) = self.body.lock().get(&path, meta.mtime_ms, meta.size) {
                let end = (size as usize).min(buf.len());
                reply.data(&buf[..end]);
                return;
            }
        }
        match self.ipc.read(&self.host_path(&path), off, Some(size as u64)) {
            Ok(data) => {
                // Mediated text can be longer than the bytes on the host disk: a
                // `vault://email-<hex>` marker replaces a shorter address. The
                // kernel clamps a read to the attr size it last saw, and
                // stat_path serves cached metadata, so that stale smaller size
                // would keep handing out a cut-off marker that nothing can
                // resolve. Adopt the mediated length and let the kernel re-stat.
                let mut gen_size = meta.size;
                if off == 0 && (data.len() as u64) > meta.size {
                    gen_size = data.len() as u64;
                    self.meta.lock().insert(
                        path.clone(),
                        EntryMeta {
                            size: gen_size,
                            verified: true,
                            ..meta.clone()
                        },
                    );
                    self.notify_kernel(&path);
                }
                if want_full && data.len() <= BODY_MAX_FILE {
                    self.body
                        .lock()
                        .put(&path, data.clone(), meta.mtime_ms, gen_size);
                }
                reply.data(&data);
            }
            Err(e) => reply.error(map_err(&e)),
        }
    }

    fn write(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        data: &[u8],
        _write_flags: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyWrite,
    ) {
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        match self
            .ipc
            .write(&self.host_path(&path), data, offset.max(0) as u64, false)
        {
            Ok(_) => {
                // Host has mediated bytes; bust caches + notify kernel so any
                // open handle re-reads the post-transform file from the host.
                self.after_mutate(&path, true);
                reply.written(data.len() as u32);
            }
            Err(e) => reply.error(map_err(&e)),
        }
    }

    fn mkdir(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        let Some(parent_path) = self.path_for_ino(parent) else {
            reply.error(ENOENT);
            return;
        };
        let name = name.to_string_lossy();
        let child = Self::child(&parent_path, &name);
        match self.ipc.mkdir(&self.host_path(&child)) {
            Ok(_) => {
                self.after_mutate(&parent_path, true);
                let ino = self.remember_ino(&child);
                reply.entry(&TTL, &mk_attr(ino, true, 0, 0.0, self.uid, self.gid), 0);
            }
            Err(e) => reply.error(map_err(&e)),
        }
    }

    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let Some(parent_path) = self.path_for_ino(parent) else {
            reply.error(ENOENT);
            return;
        };
        let child = Self::child(&parent_path, &name.to_string_lossy());
        match self.ipc.unlink(&self.host_path(&child)) {
            Ok(_) => {
                self.after_mutate(&child, true);
                self.after_mutate(&parent_path, true);
                reply.ok();
            }
            Err(e) => reply.error(map_err(&e)),
        }
    }

    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        self.unlink(_req, parent, name, reply);
    }

    fn rename(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        _flags: u32,
        reply: ReplyEmpty,
    ) {
        let Some(parent_path) = self.path_for_ino(parent) else {
            reply.error(ENOENT);
            return;
        };
        let Some(new_parent) = self.path_for_ino(newparent) else {
            reply.error(ENOENT);
            return;
        };
        let src = Self::child(&parent_path, &name.to_string_lossy());
        let dst = Self::child(&new_parent, &newname.to_string_lossy());
        match self
            .ipc
            .rename(&self.host_path(&src), &self.host_path(&dst))
        {
            Ok(_) => {
                self.after_mutate(&src, true);
                self.after_mutate(&dst, true);
                self.after_mutate(&parent_path, true);
                self.after_mutate(&new_parent, true);
                reply.ok();
            }
            Err(e) => reply.error(map_err(&e)),
        }
    }

    fn setattr(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<fuser::TimeOrNow>,
        _mtime: Option<fuser::TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<u64>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<u32>,
        reply: ReplyAttr,
    ) {
        let _ = (mode, uid, gid);
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        if let Some(sz) = size {
            if let Err(e) = self.ipc.truncate(&self.host_path(&path), sz) {
                reply.error(map_err(&e));
                return;
            }
            self.after_mutate(&path, true);
        }
        match self.stat_path(&path) {
            Ok(m) => reply.attr(
                &TTL,
                &mk_attr(ino, m.is_dir, m.size, m.mtime_ms, self.uid, self.gid),
            ),
            Err(e) => reply.error(e),
        }
    }

    fn create(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: fuser::ReplyCreate,
    ) {
        let Some(parent_path) = self.path_for_ino(parent) else {
            reply.error(ENOENT);
            return;
        };
        let child = Self::child(&parent_path, &name.to_string_lossy());
        match self.ipc.write(&self.host_path(&child), &[], 0, true) {
            Ok(_) => {
                self.after_mutate(&child, true);
                self.after_mutate(&parent_path, true);
                let ino = self.remember_ino(&child);
                let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
                reply.created(
                    &TTL,
                    &mk_attr(ino, false, 0, 0.0, self.uid, self.gid),
                    0,
                    fh,
                    0,
                );
            }
            Err(e) => reply.error(map_err(&e)),
        }
    }
}

fn load_credentials() -> (String, String, String) {
    let mut token = std::env::var("BRIDGE_TOKEN").unwrap_or_default();
    let mut bridge = std::env::var("BRIDGE_URL")
        .unwrap_or_else(|_| "http://host.docker.internal:7331".into());
    let mut agent_id = std::env::var("AGENT_ID").unwrap_or_default();
    let cred = std::env::var("BRIDGE_CREDENTIALS_FILE").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/browser".into());
        format!("{home}/.bridge-credentials")
    });
    if Path::new(&cred).is_file() {
        if let Ok(raw) = std::fs::read_to_string(&cred) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if token.is_empty() {
                    token = v
                        .get("token")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                }
                if let Some(u) = v.get("bridgeUrl").and_then(|t| t.as_str()) {
                    bridge = u.to_string();
                }
                if agent_id.is_empty() {
                    agent_id = v
                        .get("agentId")
                        .or_else(|| v.get("id"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
        }
    }
    if agent_id.is_empty() {
        agent_id = "workspace-desktop".into();
    }
    (bridge, token, agent_id)
}

fn main() {
    let arg1 = std::env::args().nth(1);
    if arg1.as_deref() == Some("--capabilities") {
        for cap in CAPABILITIES {
            println!("{cap}");
        }
        return;
    }
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mount = arg1
        .or_else(|| std::env::var("HOSTFS_MOUNT").ok())
        .unwrap_or_else(|| "/host".into());
    let (bridge, token, agent_id) = load_credentials();
    if token.is_empty() {
        eprintln!("saaridge-hostfs: missing BRIDGE_TOKEN");
        std::process::exit(2);
    }
    let ipc_host = std::env::var("HOSTFS_IPC_HOST").unwrap_or_else(|_| {
        // Derive from BRIDGE_URL
        bridge
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .split('/')
            .next()
            .unwrap_or("host.docker.internal")
            .split(':')
            .next()
            .unwrap_or("host.docker.internal")
            .to_string()
    });
    let ipc_port: u16 = std::env::var("HOSTFS_IPC_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7333);
    let uid: u32 = std::env::var("HOSTFS_UID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1001);
    let gid: u32 = std::env::var("HOSTFS_GID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1001);

    let ipc = Arc::new(FsIpc::new(ipc_host.clone(), ipc_port, token));
    match ipc.health() {
        Ok(h) => info!("FS IPC ready at {ipc_host}:{ipc_port}: {h}"),
        Err(e) => {
            warn!("FS IPC health failed: {e}");
            std::process::exit(2);
        }
    }

    let notifier_slot: Arc<Mutex<Option<Notifier>>> = Arc::new(Mutex::new(None));
    let fs = HostFs::new(ipc, agent_id.clone(), uid, gid, notifier_slot.clone());
    info!("Mounting {mount} agent={agent_id} ipc={ipc_host}:{ipc_port}");
    let options = [
        MountOption::FSName("saaridge-hostfs".into()),
        MountOption::AllowOther,
        MountOption::AutoUnmount,
    ];
    let mount_path = PathBuf::from(&mount);
    let mut session = match Session::new(fs, &mount_path, &options) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("mount failed: {e}");
            std::process::exit(1);
        }
    };
    *notifier_slot.lock() = Some(session.notifier());
    if let Err(e) = session.run() {
        eprintln!("session failed: {e}");
        std::process::exit(1);
    }
}
