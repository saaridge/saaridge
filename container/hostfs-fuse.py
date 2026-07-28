#!/usr/bin/env python3
"""
OneBridge hostfs — FUSE client over the host Data API (:7331 /v1/fs/*).

Mount point: /host
Virtual layout:
  /host/workspaces/<agentId>/...   (rw via policy)
  /host/shared/...                 (ro via policy)
  /host/home/...                   (ro → host os.homedir() via policy)

Parents (/, /workspaces, /home) are synthesized so Cursor can browse without
API access to ~/OneBridge itself (policy denies those ancestors).

Uses Debian python3-fuse (fuse-python), not fusepy.
"""
from __future__ import annotations

import errno
import json
import logging
import os
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Optional, Tuple

try:
    import fuse
    from fuse import Fuse
except ImportError:
    sys.stderr.write("hostfs-fuse: python3-fuse not installed\n")
    sys.exit(1)

if not getattr(fuse, "fuse_python_api", None):
    fuse.fuse_python_api = (0, 2)

LOG = logging.getLogger("hostfs-fuse")
FS_VERSION = "1"

# Electron/GTK file dialogs hide FUSE mounts that report 0 blocks via statvfs.
# Present a large synthetic capacity so Open Folder can browse /host.
_STATFS_BLOCK_SIZE = 4096
_STATFS_TOTAL_BLOCKS = 26214400  # 100 GiB
_STATFS_FREE_BLOCKS = 25165824  # 96 GiB


def _resolve_fs_owner() -> Tuple[int, int]:
    """Map presented ownership to the desktop user (not root)."""
    uid_s = os.environ.get("HOSTFS_UID", "").strip()
    gid_s = os.environ.get("HOSTFS_GID", "").strip()
    if uid_s.isdigit() and gid_s.isdigit():
        return int(uid_s), int(gid_s)
    try:
        import pwd

        pw = pwd.getpwnam(os.environ.get("HOSTFS_USER", "browser"))
        return int(pw.pw_uid), int(pw.pw_gid)
    except Exception:
        # Fall back to current process (root when launched by watchdog)
        return os.getuid(), os.getgid()


FS_UID, FS_GID = _resolve_fs_owner()


def load_credentials() -> Tuple[str, str, str]:
    token = os.environ.get("BRIDGE_TOKEN", "").strip()
    bridge = os.environ.get("BRIDGE_URL", "http://host.docker.internal:7331").rstrip("/")
    agent_id = os.environ.get("AGENT_ID", "").strip()
    cred_file = os.environ.get("BRIDGE_CREDENTIALS_FILE", "")
    if not cred_file:
        home = os.environ.get("HOME", "/home/browser")
        cand = os.path.join(home, ".bridge-credentials")
        if os.path.isfile(cand):
            cred_file = cand
    if not cred_file and os.path.isfile("/home/browser/.bridge-credentials"):
        cred_file = "/home/browser/.bridge-credentials"
    if cred_file and os.path.isfile(cred_file):
        with open(cred_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        token = token or data.get("token", "")
        bridge = (data.get("bridgeUrl") or bridge).rstrip("/")
        agent_id = agent_id or str(data.get("agentId") or data.get("id") or "")
    if not token:
        raise SystemExit("hostfs-fuse: missing BRIDGE_TOKEN / credentials")
    if not agent_id:
        agent_id = "workspace-desktop"
    return bridge, token, agent_id


class DataApi:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.token = token

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "*/*",
            "X-OneBridge-FS-Client": FS_VERSION,
        }

    def request(
        self,
        method: str,
        path: str,
        query: Optional[dict] = None,
        body: Optional[bytes] = None,
        json_body: Optional[dict] = None,
    ):
        q = urllib.parse.urlencode({k: v for k, v in (query or {}).items() if v is not None})
        url = f"{self.base}{path}"
        if q:
            url = f"{url}?{q}"
        data = body
        headers = self._headers()
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif body is not None:
            headers["Content-Type"] = "application/octet-stream"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                if "application/json" in ctype or path.endswith("/health") or method in (
                    "DELETE",
                    "POST",
                ):
                    if not raw:
                        return {}
                    try:
                        return json.loads(raw.decode("utf-8"))
                    except Exception:
                        return {"_raw": raw}
                return raw
        except urllib.error.HTTPError as e:
            try:
                payload = e.read().decode("utf-8", errors="replace")
                detail = json.loads(payload)
                code = detail.get("code") or ""
            except Exception:
                detail = {"error": str(e)}
                code = ""
            err = OSError(self._errno(e.code, code), detail.get("error") or str(e))
            raise err from e

    @staticmethod
    def _errno(http_status: int, code: str) -> int:
        if code == "EACCES" or http_status == 403:
            return errno.EACCES
        if code == "ENOENT" or http_status == 404:
            return errno.ENOENT
        if code == "EFBIG" or http_status == 413:
            return errno.EFBIG
        if code in ("EBUSY", "ETIMEDOUT") or http_status == 429:
            return errno.EBUSY
        if code == "EISDIR":
            return errno.EISDIR
        return errno.EIO

    def host_path(self, rel: str) -> str:
        """Map FUSE path under /host to a host Data API path.

        /home → ~ (host homedir, RO via policy)
        everything else → ~/OneBridge/...
        """
        rel = rel.lstrip("/")
        if rel == "home" or rel.startswith("home/"):
            rest = rel[len("home") :].lstrip("/")
            return "~" if not rest else f"~/{rest}"
        if not rel or rel == ".":
            return "~/OneBridge"
        return f"~/OneBridge/{rel}"


CACHE_ROOT = os.environ.get("HOSTFS_CACHE", "/var/cache/onebridge-vfs")
FRESH_MARKER = ".onebridge-fresh"
BODY_MARKER_SUFFIX = ".onebridge-body"
META_MARKER_SUFFIX = ".onebridge-meta"
TREE_EXCLUDE = (
    "node_modules,.git,Library,.cache,dist,build,.next,target,.npm,__pycache__,.turbo"
)
# Progressive boundary: each folder visit fetches this many levels; drill expands.
HYDRATE_DEPTH = 3
# Directory listing TTL — re-fetch from host so creates/deletes show up.
DIR_TTL_SEC = 25.0


def _mk_stat(is_dir: bool, size: int = 0, mtime: int = 0, ino: int = 0) -> "fuse.Stat":
    st = fuse.Stat()
    st.st_mode = (stat.S_IFDIR | 0o755) if is_dir else (stat.S_IFREG | 0o644)
    st.st_nlink = 3 if is_dir else 1
    st.st_size = int(size or 0)
    st.st_uid = FS_UID
    st.st_gid = FS_GID
    st.st_ino = (int(ino) & 0xFFFFFFFF) or 1
    now = int(mtime or 0) or int(time.time())
    st.st_atime = now
    st.st_mtime = now
    st.st_ctime = now
    return st


def _ino_for(path: str) -> int:
    h = 0
    for ch in path:
        h = ((h * 131) + ord(ch)) & 0xFFFFFFFF
    return h or 1


def _stat_from_os(cp: str) -> "fuse.Stat":
    st_os = os.lstat(cp)
    st = fuse.Stat()
    st.st_mode = st_os.st_mode
    st.st_nlink = st_os.st_nlink if st_os.st_nlink > 1 else (3 if stat.S_ISDIR(st_os.st_mode) else 1)
    st.st_size = st_os.st_size
    st.st_uid = FS_UID
    st.st_gid = FS_GID
    st.st_ino = (int(st_os.st_ino) & 0xFFFFFFFF) or _ino_for(cp)
    st.st_atime = int(st_os.st_atime) or 1
    st.st_mtime = int(st_os.st_mtime) or 1
    st.st_ctime = int(st_os.st_ctime) or 1
    return st


def _is_internal_name(name: str) -> bool:
    return (
        name == FRESH_MARKER
        or name.endswith(BODY_MARKER_SUFFIX)
        or name.endswith(META_MARKER_SUFFIX)
    )


class HostFS(Fuse):
    """
    Progressive mediated host view.

    On each folder visit: fetch up to HYDRATE_DEPTH levels via Data API, materialize
    placeholders (with real sizes) under CACHE_ROOT. Drill-down re-fetches the next
    boundary. Directory TTL is short so host changes appear on refresh. File bodies
    download on open/read (revalidated against host mtime).
    """

    def __init__(self, api: DataApi, agent_id: str, *args, **kw):
        Fuse.__init__(self, *args, **kw)
        self.api = api
        self.agent_id = agent_id
        self.fd_map: Dict[int, str] = {}
        self.next_fd = 3
        self._fd_lock = threading.Lock()
        self._hydrate_lock = threading.Lock()
        self._hydrating: Dict[str, threading.Event] = {}
        os.makedirs(CACHE_ROOT, exist_ok=True)

    def _path(self, path: str) -> str:
        return self.api.host_path(path)

    def _norm(self, path: str) -> str:
        return path.rstrip("/") or "/"

    def _cache_path(self, fuse_path: str) -> str:
        p = self._norm(fuse_path)
        if p == "/":
            return CACHE_ROOT
        return os.path.join(CACHE_ROOT, p.lstrip("/"))

    def _fresh_path(self, cache_dir: str) -> str:
        return os.path.join(cache_dir, FRESH_MARKER)

    def _body_marker(self, cache_file: str) -> str:
        return cache_file + BODY_MARKER_SUFFIX

    def _meta_path(self, cache_file: str) -> str:
        return cache_file + META_MARKER_SUFFIX

    def _is_fresh(self, cache_dir: str, ttl: float = DIR_TTL_SEC) -> bool:
        fp = self._fresh_path(cache_dir)
        try:
            return (time.time() - os.path.getmtime(fp)) < ttl
        except OSError:
            return False

    def _mark_fresh(self, cache_dir: str) -> None:
        os.makedirs(cache_dir, exist_ok=True)
        fp = self._fresh_path(cache_dir)
        with open(fp, "w", encoding="utf-8") as f:
            f.write(str(time.time()))

    def _err(self, err: BaseException) -> int:
        if isinstance(err, OSError):
            return -int(err.errno or errno.EIO)
        return -errno.EIO

    def _write_meta(self, cp: str, size: int, mtime_ms: float = 0) -> None:
        meta = {
            "size": int(size or 0),
            "mtimeMs": float(mtime_ms or 0),
        }
        with open(self._meta_path(cp), "w", encoding="utf-8") as f:
            json.dump(meta, f)

    def _read_meta(self, cp: str) -> Optional[dict]:
        try:
            with open(self._meta_path(cp), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError, json.JSONDecodeError):
            return None

    def _touch_placeholder(self, cp: str, is_dir: bool, size: int = 0, mtime_ms: float = 0) -> None:
        if is_dir:
            os.makedirs(cp, exist_ok=True)
            return
        os.makedirs(os.path.dirname(cp), exist_ok=True)
        old = self._read_meta(cp)
        if not os.path.lexists(cp):
            open(cp, "a", encoding="utf-8").close()
        marker = self._body_marker(cp)
        if os.path.isfile(marker):
            old_size = int((old or {}).get("size") or -1)
            old_mtime = float((old or {}).get("mtimeMs") or 0)
            if int(size or 0) != old_size or (
                mtime_ms and old_mtime and abs(float(mtime_ms) - old_mtime) > 1
            ):
                try:
                    os.unlink(marker)
                except OSError:
                    pass
                open(cp, "wb").close()
        self._write_meta(cp, size, mtime_ms)

    def _remove_cache_entry(self, cp: str) -> None:
        import shutil

        for extra in (self._body_marker(cp), self._meta_path(cp)):
            try:
                os.unlink(extra)
            except OSError:
                pass
        try:
            if os.path.isdir(cp) and not os.path.islink(cp):
                shutil.rmtree(cp, ignore_errors=True)
            elif os.path.lexists(cp):
                os.unlink(cp)
        except OSError:
            pass

    def _hydrate_tree(self, fuse_dir: str) -> None:
        """Fetch HYDRATE_DEPTH levels for this folder; reconcile local placeholders."""
        p = self._norm(fuse_dir)
        cp = self._cache_path(p)
        with self._hydrate_lock:
            if self._is_fresh(cp):
                return
            if p in self._hydrating:
                ev = self._hydrating[p]
                worker = False
            else:
                ev = threading.Event()
                self._hydrating[p] = ev
                worker = True
        if not worker:
            ev.wait(timeout=120)
            return
        try:
            t0 = time.time()
            result = self.api.request(
                "GET",
                "/v1/fs/tree",
                {
                    "path": self._path(p),
                    "maxDepth": str(HYDRATE_DEPTH),
                    "maxEntries": "8000",
                    "exclude": TREE_EXCLUDE,
                },
            )
            entries = result.get("entries") or []
            os.makedirs(cp, exist_ok=True)
            top_names = set()
            for e in entries:
                rel = e.get("rel") or e.get("name")
                if not rel:
                    continue
                top_names.add(rel.split("/", 1)[0])
                child = os.path.join(cp, rel)
                self._touch_placeholder(
                    child,
                    bool(e.get("isDirectory")),
                    int(e.get("size") or 0),
                    float(e.get("mtimeMs") or 0),
                )
            # Drop immediate children removed on host
            try:
                for name in os.listdir(cp):
                    if _is_internal_name(name):
                        continue
                    if name not in top_names:
                        self._remove_cache_entry(os.path.join(cp, name))
            except OSError:
                pass
            self._mark_fresh(cp)
            LOG.info(
                "hydrated %s depth=%s entries=%s in %.0fms",
                p,
                HYDRATE_DEPTH,
                len(entries),
                (time.time() - t0) * 1000,
            )
        except OSError as err:
            LOG.warning("tree hydrate failed for %s: %s — falling back to list", p, err)
            try:
                self._hydrate_list(p)
            except OSError:
                pass
        finally:
            with self._hydrate_lock:
                self._hydrating.pop(p, None)
            ev.set()

    def _hydrate_list(self, fuse_dir: str) -> None:
        p = self._norm(fuse_dir)
        cp = self._cache_path(p)
        result = self.api.request(
            "GET",
            "/v1/fs/list",
            {"path": self._path(p), "shallow": "1"},
        )
        os.makedirs(cp, exist_ok=True)
        skip = {
            "Library",
            ".cache",
            ".Trash",
            "node_modules",
            ".git",
            FRESH_MARKER,
        }
        top_names = set()
        for e in result.get("entries") or []:
            name = e.get("name")
            if not name or name in skip or _is_internal_name(name):
                continue
            top_names.add(name)
            self._touch_placeholder(
                os.path.join(cp, name),
                bool(e.get("isDirectory")),
                int(e.get("size") or 0),
                float(e.get("mtimeMs") or 0),
            )
        try:
            for name in os.listdir(cp):
                if _is_internal_name(name):
                    continue
                if name not in top_names:
                    self._remove_cache_entry(os.path.join(cp, name))
        except OSError:
            pass
        self._mark_fresh(cp)

    def _ensure_dir(self, fuse_dir: str) -> None:
        p = self._norm(fuse_dir)
        if p in ("/", "/workspaces", "/shared"):
            os.makedirs(self._cache_path(p), exist_ok=True)
            if p == "/workspaces":
                os.makedirs(self._cache_path(f"/workspaces/{self.agent_id}"), exist_ok=True)
            return
        if p.startswith("/workspaces/") and not (
            p == f"/workspaces/{self.agent_id}"
            or p.startswith(f"/workspaces/{self.agent_id}/")
        ):
            raise OSError(errno.ENOENT, "Not found")
        cp = self._cache_path(p)
        if self._is_fresh(cp):
            return
        # /home: shallow list only. Deeper paths: progressive depth-N tree.
        if p == "/home" or p.count("/") < 2:
            self._hydrate_list(p)
        else:
            self._hydrate_tree(p)

    def _ensure_file_body(self, fuse_path: str) -> str:
        p = self._norm(fuse_path)
        cp = self._cache_path(p)
        marker = self._body_marker(cp)
        meta = self._read_meta(cp)
        if os.path.isfile(marker) and os.path.isfile(cp):
            # Revalidate against cached host size when meta present
            if meta is None or os.path.getsize(cp) == int(meta.get("size") or 0):
                return cp
        parent = self._norm(os.path.dirname(p))
        self._ensure_dir(parent if parent else "/")
        data = self.api.request(
            "GET",
            "/v1/fs/read",
            {"path": self._path(p), "offset": "0"},
        )
        if isinstance(data, dict) and "_raw" in data:
            raw = data["_raw"]
        elif isinstance(data, (bytes, bytearray)):
            raw = bytes(data)
        else:
            raw = b""
        os.makedirs(os.path.dirname(cp), exist_ok=True)
        with open(cp, "wb") as f:
            f.write(raw)
        with open(marker, "w", encoding="utf-8") as f:
            f.write(str(len(raw)))
        self._write_meta(cp, len(raw), time.time() * 1000)
        return cp

    def getattr(self, path):
        p = self._norm(path)
        if p in ("/", "/workspaces", "/shared", "/home"):
            os.makedirs(self._cache_path(p), exist_ok=True)
            return _mk_stat(True, ino=_ino_for(p))
        if p.startswith("/workspaces/") and not (
            p == f"/workspaces/{self.agent_id}"
            or p.startswith(f"/workspaces/{self.agent_id}/")
        ):
            return -errno.ENOENT
        cp = self._cache_path(p)
        if not os.path.lexists(cp):
            parent = self._norm(os.path.dirname(p) or "/")
            try:
                self._ensure_dir(parent)
            except OSError as err:
                return self._err(err)
        if not os.path.lexists(cp):
            try:
                info = self.api.request("GET", "/v1/fs/stat", {"path": self._path(p)})
            except OSError as err:
                return self._err(err)
            self._touch_placeholder(
                cp,
                bool(info.get("isDirectory")),
                int(info.get("size") or 0),
                float(info.get("mtimeMs") or 0),
            )
            if not info.get("isDirectory") and int(info.get("size") or 0) == 0:
                open(self._body_marker(cp), "a", encoding="utf-8").close()
        if not os.path.lexists(cp):
            return -errno.ENOENT
        st = _stat_from_os(cp)
        # Placeholders are 0-byte on disk — report host size so editors can open.
        if not os.path.isdir(cp) and not os.path.isfile(self._body_marker(cp)):
            meta = self._read_meta(cp)
            if meta is not None:
                st.st_size = int(meta.get("size") or 0)
                mtime_ms = float(meta.get("mtimeMs") or 0)
                if mtime_ms > 0:
                    st.st_mtime = int(mtime_ms / 1000) or st.st_mtime
        return st

    def access(self, path, mode):
        return 0

    def statfs(self, path=None):
        return fuse.StatVfs(
            f_bsize=_STATFS_BLOCK_SIZE,
            f_frsize=_STATFS_BLOCK_SIZE,
            f_blocks=_STATFS_TOTAL_BLOCKS,
            f_bfree=_STATFS_FREE_BLOCKS,
            f_bavail=_STATFS_FREE_BLOCKS,
            f_files=1_000_000,
            f_ffree=999_000,
            f_favail=999_000,
            f_flag=0,
            f_namemax=255,
        )

    def readdir(self, path, offset):
        p = self._norm(path)
        entries = [(".", stat.S_IFDIR), ("..", stat.S_IFDIR)]
        if p == "/":
            for name in ("workspaces", "shared", "home"):
                os.makedirs(self._cache_path(f"/{name}"), exist_ok=True)
                entries.append((name, stat.S_IFDIR))
        elif p == "/workspaces":
            os.makedirs(self._cache_path(f"/workspaces/{self.agent_id}"), exist_ok=True)
            entries.append((self.agent_id, stat.S_IFDIR))
        else:
            try:
                self._ensure_dir(p)
            except OSError as err:
                yield -int(err.errno or errno.EIO)
                return
            cp = self._cache_path(p)
            try:
                for name in os.listdir(cp):
                    if _is_internal_name(name):
                        continue
                    child = os.path.join(cp, name)
                    mode = stat.S_IFDIR if os.path.isdir(child) else stat.S_IFREG
                    entries.append((name, mode))
            except OSError as err:
                yield -int(err.errno or errno.EIO)
                return
        for name, mode in entries:
            yield fuse.Direntry(name, type=mode)

    def open(self, path, flags):
        cp = self._cache_path(path)
        if os.path.isdir(cp):
            return 0
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND):
            return 0
        try:
            self._ensure_file_body(path)
        except OSError as err:
            return self._err(err)
        return 0

    def read(self, path, length, offset):
        try:
            cp = self._ensure_file_body(path)
            with open(cp, "rb") as f:
                f.seek(int(offset) or 0)
                return f.read(int(length) or 0)
        except OSError as err:
            return self._err(err)

    def write(self, path, buf, offset):
        data = buf if isinstance(buf, (bytes, bytearray)) else bytes(buf)
        try:
            self.api.request(
                "PUT",
                "/v1/fs/write",
                {"path": self._path(path), "offset": str(offset), "truncate": "0"},
                body=data,
            )
            cp = self._cache_path(path)
            os.makedirs(os.path.dirname(cp), exist_ok=True)
            with open(cp, "r+b" if os.path.exists(cp) else "wb") as f:
                f.seek(int(offset) or 0)
                f.write(data)
            open(self._body_marker(cp), "a", encoding="utf-8").close()
            try:
                self._write_meta(cp, os.path.getsize(cp), time.time() * 1000)
            except OSError:
                pass
        except OSError as err:
            return self._err(err)
        return len(data)

    def truncate(self, path, size):
        try:
            self.api.request(
                "POST",
                "/v1/fs/truncate",
                json_body={"path": self._path(path), "size": int(size)},
            )
            cp = self._cache_path(path)
            os.makedirs(os.path.dirname(cp), exist_ok=True)
            with open(cp, "ab") as f:
                f.truncate(int(size) or 0)
            open(self._body_marker(cp), "a", encoding="utf-8").close()
        except OSError as err:
            return self._err(err)
        return 0

    def mknod(self, path, mode, dev):
        try:
            self.api.request(
                "PUT",
                "/v1/fs/write",
                {"path": self._path(path), "offset": "0", "truncate": "1"},
                body=b"",
            )
            cp = self._cache_path(path)
            self._touch_placeholder(cp, False)
            open(self._body_marker(cp), "a", encoding="utf-8").close()
        except OSError as err:
            return self._err(err)
        return 0

    def mkdir(self, path, mode):
        try:
            self.api.request("POST", "/v1/fs/mkdir", json_body={"path": self._path(path)})
            self._touch_placeholder(self._cache_path(path), True)
            self._mark_fresh(self._cache_path(path))
        except OSError as err:
            return self._err(err)
        return 0

    def unlink(self, path):
        try:
            q = urllib.parse.urlencode({"path": self._path(path)})
            self.api.request("DELETE", f"/v1/fs/path?{q}")
            cp = self._cache_path(path)
            for cand in (cp, self._body_marker(cp)):
                try:
                    os.unlink(cand)
                except OSError:
                    pass
        except OSError as err:
            return self._err(err)
        return 0

    def rmdir(self, path):
        try:
            q = urllib.parse.urlencode({"path": self._path(path)})
            self.api.request("DELETE", f"/v1/fs/path?{q}")
            cp = self._cache_path(path)
            import shutil

            shutil.rmtree(cp, ignore_errors=True)
        except OSError as err:
            return self._err(err)
        return 0

    def rename(self, old, new):
        try:
            self.api.request(
                "POST",
                "/v1/fs/rename",
                json_body={"from": self._path(old), "to": self._path(new)},
            )
            import shutil

            op, np = self._cache_path(old), self._cache_path(new)
            os.makedirs(os.path.dirname(np), exist_ok=True)
            if os.path.lexists(op):
                shutil.move(op, np)
        except OSError as err:
            return self._err(err)
        return 0

    def utime(self, path, times):
        return 0

    def chmod(self, path, mode):
        return 0

    def chown(self, path, uid, gid):
        return 0


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="[hostfs-fuse] %(levelname)s %(message)s",
    )
    mount = os.environ.get("HOSTFS_MOUNT", "/host")
    # fuse-python takes mountpoint from argv; keep optional positional for watchdog.
    argv = [sys.argv[0]]
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        mount = sys.argv[1]
        argv.append(mount)
        argv.extend(sys.argv[2:])
    else:
        argv.append(mount)
        argv.extend(sys.argv[1:])
    sys.argv = argv

    bridge, token, agent_id = load_credentials()
    api = DataApi(bridge, token)

    try:
        health = api.request("GET", "/v1/fs/health")
        LOG.info("Data API ready: %s", health)
    except Exception as e:
        LOG.error("Data API health failed: %s", e)
        sys.exit(2)

    os.makedirs(mount, exist_ok=True)
    LOG.info(
        "Mounting %s → ~/OneBridge (agent=%s) via %s",
        mount,
        agent_id,
        bridge,
    )

    LOG.info("Presenting files as uid=%s gid=%s", FS_UID, FS_GID)
    LOG.info("VFS cache root: %s", CACHE_ROOT)
    server = HostFS(
        api,
        agent_id,
        version="%prog OneBridge hostfs",
        usage="hostfs-fuse MOUNTPOINT",
        # Default is multithreaded; don't use setsingle (serializes Cursor).
        dash_s_do="undef",
    )
    server.multithreaded = True
    server.parser.add_option(
        mountopt="allow_other",
        metavar="allow_other",
        default=True,
        help="allow other users to access the mount",
    )
    server.parse(errex=1)
    # Ensure allow_other even if parser ignored it
    try:
        server.fuse_args.add("allow_other")
    except Exception:
        pass
    # NOTE: do NOT enable default_permissions — it forces access()+getattr on
    # every name and turns a 1-list folder open into hundreds of HTTP calls.
    try:
        server.fuse_args.add("nonempty")
    except Exception:
        pass
    for opt in (
        # Short attr cache: placeholder size → real body must be visible to editors.
        "attr_timeout=2",
        "entry_timeout=10",
        "negative_timeout=5",
        "max_readahead=1048576",
    ):
        try:
            server.fuse_args.add(opt)
        except Exception:
            pass
    # Do NOT enable kernel_cache — it freezes size=0 placeholders and breaks open.

    def _prefetch():
        time.sleep(1.0)
        try:
            LOG.info("prefetch start /home")
            server._ensure_dir("/home")
            LOG.info("prefetch done /home")
        except Exception as err:
            LOG.warning("prefetch /home failed: %s", err)

    threading.Thread(target=_prefetch, name="hostfs-prefetch", daemon=True).start()
    server.main()


if __name__ == "__main__":
    main()
