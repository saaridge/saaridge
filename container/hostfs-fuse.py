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
        timeout: int = 120,
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
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                parse_json = (
                    "application/json" in ctype
                    or path.endswith("/health")
                    or path.endswith("/events")
                    or path.endswith("/tree")
                    or path.endswith("/list")
                    or path.endswith("/stat")
                    or method in ("DELETE", "POST")
                )
                if parse_json:
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
        if code == "EROFS":
            return errno.EROFS
        if code == "EACCES" or http_status == 403:
            # Prefer EROFS messaging when body hints host-home grant.
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


# --- Framed FS IPC (preferred) — falls back to HTTP DataApi ---
# Ops must match host/bridge/data/fs-binary.js
_IPC_OPS = {
    "AUTH": 1,
    "TREE": 2,
    "LIST": 3,
    "STAT": 4,
    "READ": 5,
    "WRITE": 6,
    "MKDIR": 7,
    "UNLINK": 8,
    "RENAME": 9,
    "TRUNCATE": 10,
    "EVENTS": 11,
    "HEALTH": 12,
    "ERROR": 255,
}


class FsIpcClient:
    """Length-prefixed TCP client to bridge FS IPC (:7333)."""

    def __init__(self, host: str, port: int, token: str):
        import socket
        import struct

        self._socket_mod = socket
        self._struct = struct
        self.host = host
        self.port = int(port)
        self.token = token
        self._sock = None
        self._lock = threading.Lock()
        self._req_id = 1
        self._authed = False

    def close(self) -> None:
        with self._lock:
            if self._sock:
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None
                self._authed = False

    def _connect(self) -> None:
        if self._sock is not None:
            return
        s = self._socket_mod.create_connection((self.host, self.port), timeout=10)
        s.setsockopt(self._socket_mod.IPPROTO_TCP, self._socket_mod.TCP_NODELAY, 1)
        self._sock = s
        self._authed = False
        # AUTH
        resp = self._call_unlocked(_IPC_OPS["AUTH"], {"token": self.token})
        if not resp or not resp.get("ok"):
            self.close()
            raise OSError(errno.EACCES, resp.get("error") if resp else "AUTH failed")
        self._authed = True

    def _read_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise OSError(errno.EIO, "FS IPC connection closed")
            buf.extend(chunk)
        return bytes(buf)

    def _call_unlocked(self, op: int, body: dict) -> dict:
        payload = json.dumps(body or {}).encode("utf-8")
        req_id = self._req_id
        self._req_id = (self._req_id + 1) & 0xFFFFFFFF or 1
        length = 1 + 4 + len(payload)
        hdr = self._struct.pack(">I", length)
        mid = bytes([op & 0xFF]) + self._struct.pack(">I", req_id)
        self._sock.sendall(hdr + mid + payload)
        (rlen,) = self._struct.unpack(">I", self._read_exact(4))
        if rlen < 5 or rlen > 64 * 1024 * 1024:
            raise OSError(errno.EIO, "FS IPC bad frame length")
        raw = self._read_exact(rlen)
        rop = raw[0]
        data = json.loads(raw[5:].decode("utf-8") or "{}")
        if rop == _IPC_OPS["ERROR"] or data.get("ok") is False:
            code = data.get("code") or "EIO"
            errn = errno.EACCES if code in ("EACCES", "EAUTH") else errno.EIO
            if code == "EROFS":
                errn = errno.EROFS
            if code == "ENOENT":
                errn = errno.ENOENT
            elif code == "EISDIR":
                errn = errno.EISDIR
            elif code == "EFBIG":
                errn = errno.EFBIG
            raise OSError(errn, data.get("error") or "FS IPC error")
        return data

    def call(self, op_name: str, body: Optional[dict] = None) -> dict:
        op = _IPC_OPS[op_name]
        with self._lock:
            try:
                self._connect()
                return self._call_unlocked(op, body or {})
            except OSError:
                self.close()
                raise
            except Exception as e:
                self.close()
                raise OSError(errno.EIO, str(e)) from e


class BridgeClient:
    """Prefer FS IPC; fall back to HTTP Data API."""

    def __init__(self, http: DataApi, ipc: Optional["FsIpcClient"] = None):
        self.http = http
        self.ipc = ipc
        self.use_ipc = ipc is not None
        self.token = http.token
        self.base = http.base

    def host_path(self, rel: str) -> str:
        return self.http.host_path(rel)

    def health(self) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call("HEALTH", {})
            except Exception as e:
                LOG.warning("FS IPC health failed, using HTTP: %s", e)
                self.use_ipc = False
        return self.http.request("GET", "/v1/fs/health")

    def tree(self, path: str, max_depth: int, max_entries: int) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call(
                    "TREE",
                    {
                        "path": path,
                        "maxDepth": max_depth,
                        "maxEntries": max_entries,
                    },
                )
            except Exception as e:
                LOG.warning("FS IPC TREE failed, HTTP fallback: %s", e)
                self.use_ipc = False
        return self.http.request(
            "GET",
            "/v1/fs/tree",
            {
                "path": path,
                "maxDepth": str(max_depth),
                "maxEntries": str(max_entries),
            },
        )

    def list(
        self, path: str, *, include_excluded: bool = False, with_stats: bool = True
    ) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call(
                    "LIST",
                    {
                        "path": path,
                        "shallow": True,
                        "withStats": with_stats,
                        "includeExcluded": include_excluded,
                    },
                )
            except Exception as e:
                LOG.warning("FS IPC LIST failed, HTTP fallback: %s", e)
                self.use_ipc = False
        q = {"path": path, "shallow": "1", "stats": "1" if with_stats else "0"}
        if include_excluded:
            q["includeExcluded"] = "1"
        return self.http.request("GET", "/v1/fs/list", q)

    def stat(self, path: str) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call("STAT", {"path": path})
            except Exception as e:
                LOG.warning("FS IPC STAT failed, HTTP fallback: %s", e)
                self.use_ipc = False
        return self.http.request("GET", "/v1/fs/stat", {"path": path})

    def read(self, path: str, offset: int = 0, length=None) -> bytes:
        if self.use_ipc and self.ipc:
            try:
                body = {"path": path, "offset": int(offset) or 0}
                if length is not None and int(length) > 0:
                    body["length"] = int(length)
                resp = self.ipc.call("READ", body)
                if resp.get("encoding") == "base64":
                    import base64

                    return base64.b64decode(resp.get("data") or "")
                return (resp.get("data") or "").encode("utf-8")
            except Exception as e:
                LOG.warning("FS IPC READ failed, HTTP fallback: %s", e)
                self.use_ipc = False
        q = {"path": path, "offset": str(int(offset) or 0)}
        if length is not None and int(length) > 0:
            q["length"] = str(int(length))
        data = self.http.request("GET", "/v1/fs/read", q)
        if isinstance(data, dict) and "_raw" in data:
            return data["_raw"]
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        return b""

    def write(
        self, path: str, data: bytes, offset: int = 0, truncate: bool = False
    ) -> dict:
        if self.use_ipc and self.ipc:
            try:
                import base64

                return self.ipc.call(
                    "WRITE",
                    {
                        "path": path,
                        "offset": int(offset) or 0,
                        "truncate": bool(truncate),
                        "encoding": "base64",
                        "data": base64.b64encode(data).decode("ascii"),
                    },
                )
            except Exception as e:
                LOG.warning("FS IPC WRITE failed, HTTP fallback: %s", e)
                self.use_ipc = False
        return self.http.request(
            "PUT",
            "/v1/fs/write",
            {
                "path": path,
                "offset": str(offset),
                "truncate": "1" if truncate else "0",
            },
            body=data,
        )

    def mkdir(self, path: str) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call("MKDIR", {"path": path})
            except Exception as e:
                LOG.warning("FS IPC MKDIR failed, HTTP fallback: %s", e)
                self.use_ipc = False
        return self.http.request("POST", "/v1/fs/mkdir", json_body={"path": path})

    def unlink(self, path: str) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call("UNLINK", {"path": path})
            except Exception as e:
                LOG.warning("FS IPC UNLINK failed, HTTP fallback: %s", e)
                self.use_ipc = False
        q = urllib.parse.urlencode({"path": path})
        return self.http.request("DELETE", f"/v1/fs/path?{q}")

    def rename(self, src: str, dst: str) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call("RENAME", {"from": src, "to": dst})
            except Exception as e:
                LOG.warning("FS IPC RENAME failed, HTTP fallback: %s", e)
                self.use_ipc = False
        return self.http.request(
            "POST", "/v1/fs/rename", json_body={"from": src, "to": dst}
        )

    def truncate(self, path: str, size: int) -> dict:
        if self.use_ipc and self.ipc:
            try:
                return self.ipc.call("TRUNCATE", {"path": path, "size": int(size)})
            except Exception as e:
                LOG.warning("FS IPC TRUNCATE failed, HTTP fallback: %s", e)
                self.use_ipc = False
        return self.http.request(
            "POST", "/v1/fs/truncate", json_body={"path": path, "size": int(size)}
        )

    def request(self, method, path, query=None, body=None, json_body=None, timeout=120):
        """HTTP escape hatch used by legacy call sites."""
        return self.http.request(
            method, path, query=query, body=body, json_body=json_body, timeout=timeout
        )


CACHE_ROOT = os.environ.get("HOSTFS_CACHE", "/var/cache/onebridge-vfs")

# Exact basenames omitted from normal listings / tree hydrate (mirrors host
# agent-fs-excludes.js). Explicit open of such a path uses a single list.
# Health /v1/fs/health may overwrite this set at mount time.
AGENT_FS_EXCLUDES = set(
    {
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
    }
)

TREE_MAX_DEPTH = int(os.environ.get("HOSTFS_TREE_DEPTH", "4") or "4")
TREE_MAX_ENTRIES = int(os.environ.get("HOSTFS_TREE_MAX", "8000") or "8000")
BODY_MEMO_MAX_FILE = int(
    os.environ.get("ONEBRIDGE_BODY_MEMO_MAX_FILE", str(2 * 1024 * 1024))
)
BODY_MEMO_MAX_TOTAL = int(
    os.environ.get("ONEBRIDGE_BODY_MEMO_TOTAL", str(64 * 1024 * 1024))
)
META_TTL_SEC = float(os.environ.get("HOSTFS_META_TTL", "15") or "15")


class _BodyMemo:
    """Gen-based body LRU (mtimeMs, size). Cap file + total bytes."""

    def __init__(self):
        self._lock = threading.Lock()
        self._map: Dict[str, dict] = {}  # path → {buf, mtimeMs, size}
        self._order: list = []
        self._bytes = 0

    def get(self, path: str, mtime_ms: float, size: int):
        with self._lock:
            hit = self._map.get(path)
            if not hit:
                return None
            if float(hit["mtimeMs"]) != float(mtime_ms) or int(hit["size"]) != int(
                size
            ):
                self._drop(path)
                return None
            if path in self._order:
                self._order.remove(path)
            self._order.append(path)
            return hit["buf"]

    def put(self, path: str, buf: bytes, mtime_ms: float, size: int) -> None:
        if not buf or len(buf) > BODY_MEMO_MAX_FILE or int(size) > BODY_MEMO_MAX_FILE:
            return
        with self._lock:
            self._drop(path)
            self._map[path] = {
                "buf": buf,
                "mtimeMs": float(mtime_ms),
                "size": int(size),
            }
            self._order.append(path)
            self._bytes += len(buf)
            while self._bytes > BODY_MEMO_MAX_TOTAL and self._order:
                self._drop(self._order[0])

    def bust(self, path: str) -> None:
        with self._lock:
            self._drop(path)
            prefix = path if path.endswith("/") else path + "/"
            for key in list(self._map.keys()):
                if key.startswith(prefix):
                    self._drop(key)

    def clear(self) -> None:
        with self._lock:
            self._map.clear()
            self._order.clear()
            self._bytes = 0

    def _drop(self, path: str) -> None:
        hit = self._map.pop(path, None)
        if hit:
            self._bytes -= len(hit["buf"])
        if path in self._order:
            self._order.remove(path)

    def stats(self) -> dict:
        with self._lock:
            return {
                "entries": len(self._map),
                "bytes": self._bytes,
                "maxFile": BODY_MEMO_MAX_FILE,
                "maxTotal": BODY_MEMO_MAX_TOTAL,
            }


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


def _under_excluded(fuse_path: str) -> bool:
    """True if any path component is a standard exclude (no tree hydrate)."""
    return any(part in AGENT_FS_EXCLUDES for part in fuse_path.split("/") if part)


class HostFS(Fuse):
    """
    Agent-oriented mediated host view.

    Folder open → one GET /v1/fs/tree (metadata batch) into RAM dir map.
    Excluded basenames omitted from listings; explicit open → one list only.
    File bodies always via GET /v1/fs/read (never prefetched on folder open).
    """

    def __init__(self, api: DataApi, agent_id: str, *args, **kw):
        Fuse.__init__(self, *args, **kw)
        self.api = api
        self.agent_id = agent_id
        self.fd_map: Dict[int, str] = {}
        self.next_fd = 3
        self._fd_lock = threading.Lock()
        self._inflight_lock = threading.Lock()
        self._inflight: Dict[str, threading.Event] = {}
        # Session metadata only (no file bodies).
        # NOTE: must not use the name `_attrs` — Fuse.main registers ops from Fuse._attrs.
        self._map_lock = threading.Lock()
        self._dirs: Dict[str, list] = {}  # fuse dir → [{name, isDir, size, mtimeMs}]
        self._path_meta: Dict[str, dict] = {}  # fuse path → {isDir, size, mtimeMs}
        self._events_since = 0
        self._host_home = ""
        self._onebridge_root = ""
        self._invalidate_file = os.environ.get(
            "HOSTFS_INVALIDATE_FILE", "/tmp/onebridge-fs-invalidate"
        )
        self._dir_ts: Dict[str, float] = {}  # fuse dir → monotonic time listed
        self._body_memo = _BodyMemo()
        os.makedirs(CACHE_ROOT, exist_ok=True)

    def _path(self, path: str) -> str:
        return self.api.host_path(path)

    def _norm(self, path: str) -> str:
        return path.rstrip("/") or "/"

    def _child(self, parent: str, name: str) -> str:
        parent = self._norm(parent)
        if parent == "/":
            return self._norm(f"/{name}")
        return self._norm(f"{parent}/{name}")

    def _host_abs_to_fuse(self, host_abs: str) -> Optional[str]:
        """Map a host absolute path from /v1/fs/events to a FUSE path under /host."""
        if not host_abs:
            return None
        p = host_abs.rstrip("/")
        home = (self._host_home or "").rstrip("/")
        ob = (self._onebridge_root or "").rstrip("/")
        # OneBridge is under home — check it first.
        if ob and (p == ob or p.startswith(ob + "/")):
            rest = p[len(ob) :].lstrip("/")
            if not rest:
                return "/"
            if rest.startswith("workspaces/") or rest == "workspaces":
                return self._norm("/" + rest)
            if rest.startswith("shared/") or rest == "shared":
                return self._norm("/" + rest)
            return self._norm("/" + rest)
        if home and (p == home or p.startswith(home + "/")):
            rest = p[len(home) :].lstrip("/")
            return self._norm("/home" if not rest else f"/home/{rest}")
        return None

    def _start_events_poller(self) -> None:
        # Invalidation is drained on getattr/read/write/readdir (no FUSE bg thread).
        LOG.info("invalidate-file on getattr/read/write/readdir %s", self._invalidate_file)

    def _drain_invalidate_file(self) -> None:
        path = self._invalidate_file
        if not path or not os.path.isfile(path):
            return
        try:
            with open(path, "r+", encoding="utf-8") as f:
                lines = f.read().splitlines()
                f.seek(0)
                f.truncate()
        except Exception:
            return
        if not lines:
            return
        msg = f"[hostfs-fuse] invalidate drain lines={len(lines)} home={self._host_home!r} ob={self._onebridge_root!r}\n"
        sys.stderr.write(msg)
        sys.stderr.flush()
        for line in lines:
            host_p = line.strip()
            if not host_p:
                continue
            fuse_p = self._host_abs_to_fuse(host_p)
            if fuse_p:
                self._after_mutate(fuse_p)
                sys.stderr.write(f"[hostfs-fuse] events-bust {fuse_p} <- {host_p}\n")
                sys.stderr.flush()
            else:
                sys.stderr.write(
                    f"[hostfs-fuse] events-unmap {host_p} home={self._host_home!r} ob={self._onebridge_root!r}\n"
                )
                sys.stderr.flush()

    def _err(self, err: BaseException) -> int:
        if isinstance(err, OSError):
            return -int(err.errno or errno.EIO)
        return -errno.EIO

    def _coalesce(self, key: str):
        """Return (worker: bool, event). Non-workers wait on event."""
        with self._inflight_lock:
            if key in self._inflight:
                return False, self._inflight[key]
            ev = threading.Event()
            self._inflight[key] = ev
            return True, ev

    def _coalesce_done(self, key: str, ev: threading.Event) -> None:
        with self._inflight_lock:
            self._inflight.pop(key, None)
        ev.set()

    def _bust(self, *paths: str) -> None:
        """Drop RAM metadata for paths and their parents (and clear all on rename)."""
        with self._map_lock:
            if not paths:
                self._dirs.clear()
                self._path_meta.clear()
                self._dir_ts.clear()
                self._body_memo.clear()
                return
            for p in paths:
                p = self._norm(p)
                self._dirs.pop(p, None)
                self._path_meta.pop(p, None)
                self._dir_ts.pop(p, None)
                self._body_memo.bust(p)
                parent = self._norm(os.path.dirname(p) or "/")
                self._dirs.pop(parent, None)
                self._dir_ts.pop(parent, None)
                # Drop any cached descendants of p
                prefix = p if p.endswith("/") else p + "/"
                for key in list(self._dirs.keys()):
                    if key == p or key.startswith(prefix):
                        self._dirs.pop(key, None)
                        self._dir_ts.pop(key, None)
                for key in list(self._path_meta.keys()):
                    if key == p or key.startswith(prefix):
                        self._path_meta.pop(key, None)

    def _after_mutate(self, *paths: str) -> None:
        """Drop caches then restat so open editors see post-mediation size/mtime."""
        norms = [self._norm(p) for p in paths if p]
        self._bust(*norms)
        for p in norms:
            try:
                # Force bridge STAT (skip stale RAM) after bust cleared meta.
                info = self.api.stat(self._path(p))
                if not isinstance(info, dict):
                    continue
                with self._map_lock:
                    self._path_meta[p] = {
                        "isDir": bool(
                            info.get("isDir")
                            if "isDir" in info
                            else info.get("isDirectory")
                        ),
                        "size": int(info.get("size") or 0),
                        "mtimeMs": float(info.get("mtimeMs") or 0),
                    }
            except OSError:
                pass

    def _store_dir_entries(self, fuse_dir: str, entries: list) -> None:
        """Write filtered listing + child attrs into the RAM map."""
        fuse_dir = self._norm(fuse_dir)
        clean = []
        with self._map_lock:
            for e in entries:
                name = e.get("name")
                if not name or name.startswith(".onebridge-") or name == ".DS_Store":
                    continue
                if name in AGENT_FS_EXCLUDES:
                    continue
                is_dir = bool(e.get("isDir") if "isDir" in e else e.get("isDirectory"))
                size = int(e.get("size") or 0)
                mtime_ms = float(e.get("mtimeMs") or 0)
                clean.append(
                    {"name": name, "isDir": is_dir, "size": size, "mtimeMs": mtime_ms}
                )
                child = self._child(fuse_dir, name)
                self._path_meta[child] = {
                    "isDir": is_dir,
                    "size": size,
                    "mtimeMs": mtime_ms,
                }
            self._dirs[fuse_dir] = clean
            if fuse_dir not in self._path_meta:
                self._path_meta[fuse_dir] = {
                    "isDir": True,
                    "size": 0,
                    "mtimeMs": time.time() * 1000,
                }

    def _ingest_tree(self, root: str, tree_entries: list) -> None:
        """Expand /v1/fs/tree metadata into RAM dir listings (no bodies)."""
        root = self._norm(root)
        by_parent: Dict[str, Dict[str, dict]] = {}

        def add_child(parent: str, name: str, is_dir: bool, size: int, mtime_ms: float):
            if not name or name in AGENT_FS_EXCLUDES or name.startswith(".onebridge-"):
                return
            parent = self._norm(parent)
            bucket = by_parent.setdefault(parent, {})
            bucket[name] = {
                "name": name,
                "isDir": is_dir,
                "size": size,
                "mtimeMs": mtime_ms,
            }

        for e in tree_entries or []:
            rel = (e.get("rel") or e.get("name") or "").strip("/")
            if not rel:
                continue
            parts = [p for p in rel.split("/") if p]
            if any(part in AGENT_FS_EXCLUDES for part in parts):
                continue
            is_dir = bool(e.get("isDirectory") if "isDirectory" in e else e.get("isDir"))
            size = int(e.get("size") or 0)
            mtime_ms = float(e.get("mtimeMs") or 0)
            parent = root
            for i, part in enumerate(parts):
                child = self._child(parent, part)
                leaf = i == len(parts) - 1
                add_child(
                    parent,
                    part,
                    is_dir if leaf else True,
                    size if leaf else 0,
                    mtime_ms if leaf else 0,
                )
                parent = child

        with self._map_lock:
            if root not in self._path_meta:
                self._path_meta[root] = {
                    "isDir": True,
                    "size": 0,
                    "mtimeMs": time.time() * 1000,
                }
            # Ensure every parent we saw has a listing (possibly empty).
            for parent, names in by_parent.items():
                self._dirs[parent] = list(names.values())
                for name, meta in names.items():
                    child = self._child(parent, name)
                    self._path_meta[child] = {
                        "isDir": bool(meta.get("isDir")),
                        "size": int(meta.get("size") or 0),
                        "mtimeMs": float(meta.get("mtimeMs") or 0),
                    }
            # Root may have zero children after excludes.
            if root not in self._dirs:
                self._dirs[root] = []

    def _hydrate_tree(self, fuse_dir: str) -> list:
        """One batched tree request; fill RAM map; return this dir's entries."""
        p = self._norm(fuse_dir)
        key = "tree:" + p
        worker, ev = self._coalesce(key)
        if not worker:
            ev.wait(timeout=120)
            with self._map_lock:
                return list(self._dirs.get(p) or [])
        try:
            t0 = time.time()
            result = self.api.tree(self._path(p), TREE_MAX_DEPTH, TREE_MAX_ENTRIES)
            # Ensure JSON even if Content-Type was odd.
            if isinstance(result, (bytes, bytearray)):
                result = json.loads(result.decode("utf-8"))
            entries = result.get("entries") or []
            self._ingest_tree(p, entries)
            LOG.info(
                "bridge-tree %s entries=%s dirs_cached=%s in %.0fms via=%s",
                p,
                len(entries),
                len(self._dirs),
                (time.time() - t0) * 1000,
                "ipc" if getattr(self.api, "use_ipc", False) else "http",
            )
            with self._map_lock:
                return list(self._dirs.get(p) or [])
        finally:
            self._coalesce_done(key, ev)

    def _list_shallow(
        self, fuse_dir: str, *, include_excluded: bool = False
    ) -> list:
        """Single-dir list via bridge (used for excluded-path lazy open)."""
        p = self._norm(fuse_dir)
        key = "list:" + p + (":inc" if include_excluded else "")
        worker, ev = self._coalesce(key)
        if not worker:
            ev.wait(timeout=60)
            with self._map_lock:
                return list(self._dirs.get(p) or [])
        try:
            t0 = time.time()
            result = self.api.list(self._path(p), include_excluded=include_excluded)
            if isinstance(result, (bytes, bytearray)):
                result = json.loads(result.decode("utf-8"))
            raw = []
            for e in result.get("entries") or []:
                name = e.get("name")
                if not name:
                    continue
                raw.append(
                    {
                        "name": name,
                        "isDir": bool(e.get("isDirectory")),
                        "size": int(e.get("size") or 0),
                        "mtimeMs": float(e.get("mtimeMs") or 0),
                    }
                )
            if include_excluded:
                # Explicit open of an excluded dir: show its children, but still
                # omit nested standard excludes from the listing.
                filtered = [
                    e
                    for e in raw
                    if e["name"] not in AGENT_FS_EXCLUDES
                    and not e["name"].startswith(".onebridge-")
                    and e["name"] != ".DS_Store"
                ]
                with self._map_lock:
                    self._dirs[p] = filtered
                    self._path_meta[p] = {
                        "isDir": True,
                        "size": 0,
                        "mtimeMs": time.time() * 1000,
                    }
                    for e in filtered:
                        child = self._child(p, e["name"])
                        self._path_meta[child] = {
                            "isDir": bool(e.get("isDir")),
                            "size": int(e.get("size") or 0),
                            "mtimeMs": float(e.get("mtimeMs") or 0),
                        }
                listed = filtered
            else:
                self._store_dir_entries(p, raw)
                with self._map_lock:
                    listed = list(self._dirs.get(p) or [])
            LOG.info(
                "bridge-list %s entries=%s includeExcluded=%s in %.0fms via=%s",
                p,
                len(listed),
                include_excluded,
                (time.time() - t0) * 1000,
                "ipc" if getattr(self.api, "use_ipc", False) else "http",
            )
            return listed
        finally:
            self._coalesce_done(key, ev)

    def _ensure_listing(self, fuse_dir: str) -> list:
        p = self._norm(fuse_dir)
        with self._map_lock:
            if p in self._dirs:
                # Short TTL so MCP writes become visible without relying only on events.
                ts = float(self._dir_ts.get(p) or 0)
                if (time.time() - ts) < META_TTL_SEC:
                    return list(self._dirs[p])
                self._dirs.pop(p, None)
        if _under_excluded(p):
            # Lazy: one shallow list only — never tree-recurse into dep dirs.
            listed = self._list_shallow(p, include_excluded=True)
        else:
            listed = self._hydrate_tree(p)
        with self._map_lock:
            self._dir_ts[p] = time.time()
        return listed

    def _stat_bridge(self, fuse_path: str) -> dict:
        p = self._norm(fuse_path)
        with self._map_lock:
            if p in self._path_meta:
                return self._path_meta[p]
        # Parent listing may already know this name.
        parent = self._norm(os.path.dirname(p) or "/")
        with self._map_lock:
            if parent in self._dirs and p in self._path_meta:
                return self._path_meta[p]
        key = "stat:" + p
        worker, ev = self._coalesce(key)
        if not worker:
            ev.wait(timeout=60)
            with self._map_lock:
                if p in self._path_meta:
                    return self._path_meta[p]
        try:
            info = self.api.stat(self._path(p))
            attr = {
                "isDir": bool(info.get("isDirectory")),
                "size": int(info.get("size") or 0),
                "mtimeMs": float(info.get("mtimeMs") or 0),
            }
            with self._map_lock:
                self._path_meta[p] = attr
            return attr
        finally:
            if worker:
                self._coalesce_done(key, ev)

    def _read_bridge(self, fuse_path: str, offset: int, length) -> bytes:
        """Read via IPC/HTTP with gen-based body memo for full-file hits."""
        p = self._norm(fuse_path)
        # Gen revalidate via cached meta or STAT.
        try:
            attr = self._stat_bridge(p)
        except OSError:
            attr = {"mtimeMs": 0, "size": 0, "isDir": False}
        mtime_ms = float(attr.get("mtimeMs") or 0)
        size = int(attr.get("size") or 0)
        # Only memo whole-file reads (offset 0 covering full size or open-ended).
        want_full = (int(offset) or 0) == 0 and (
            length is None or int(length) <= 0 or int(length) >= size
        )
        if want_full and size > 0 and size <= BODY_MEMO_MAX_FILE:
            hit = self._body_memo.get(p, mtime_ms, size)
            if hit is not None:
                if length is not None and int(length) > 0:
                    return hit[: int(length)]
                return hit
        data = self.api.read(
            self._path(p),
            offset=int(offset) or 0,
            length=int(length) if length is not None and int(length) > 0 else None,
        )
        if want_full and data and len(data) <= BODY_MEMO_MAX_FILE:
            self._body_memo.put(p, data, mtime_ms, size or len(data))
        return data

    def getattr(self, path):
        self._drain_invalidate_file()
        p = self._norm(path)
        if p in ("/", "/workspaces", "/shared", "/home"):
            return _mk_stat(True, ino=_ino_for(p))
        if p.startswith("/workspaces/") and not (
            p == f"/workspaces/{self.agent_id}"
            or p.startswith(f"/workspaces/{self.agent_id}/")
        ):
            return -errno.ENOENT
        try:
            attr = self._stat_bridge(p)
        except OSError as err:
            return self._err(err)
        return _mk_stat(
            bool(attr.get("isDir")),
            size=int(attr.get("size") or 0),
            mtime=int(float(attr.get("mtimeMs") or 0) / 1000) or int(time.time()),
            ino=_ino_for(p),
        )

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
        self._drain_invalidate_file()
        p = self._norm(path)
        entries = [(".", stat.S_IFDIR), ("..", stat.S_IFDIR)]
        if p == "/":
            for name in ("workspaces", "shared", "home"):
                entries.append((name, stat.S_IFDIR))
        elif p == "/workspaces":
            entries.append((self.agent_id, stat.S_IFDIR))
        else:
            try:
                listed = self._ensure_listing(p)
            except OSError as err:
                yield -int(err.errno or errno.EIO)
                return
            for e in listed:
                mode = stat.S_IFDIR if e.get("isDir") else stat.S_IFREG
                entries.append((e["name"], mode))
        for name, mode in entries:
            yield fuse.Direntry(name, type=mode)

    def open(self, path, flags):
        # No body prefetch — read() hits the bridge.
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND):
            return 0
        return 0

    def read(self, path, length, offset):
        self._drain_invalidate_file()
        try:
            ln = int(length) if length else 0
            return self._read_bridge(
                path, int(offset) or 0, ln if ln > 0 else None
            )
        except OSError as err:
            return self._err(err)

    def write(self, path, buf, offset):
        self._drain_invalidate_file()
        data = buf if isinstance(buf, (bytes, bytearray)) else bytes(buf)
        try:
            self.api.write(
                self._path(path),
                bytes(data),
                offset=int(offset) or 0,
                truncate=False,
            )
            # Host has mediated bytes; restat so next getattr/read matches disk.
            self._after_mutate(self._norm(path))
        except OSError as err:
            return self._err(err)
        return len(data)

    def truncate(self, path, size):
        try:
            self.api.truncate(self._path(path), int(size))
            self._after_mutate(self._norm(path))
        except OSError as err:
            return self._err(err)
        return 0

    def mknod(self, path, mode, dev):
        try:
            self.api.write(self._path(path), b"", offset=0, truncate=True)
            self._after_mutate(self._norm(path))
        except OSError as err:
            return self._err(err)
        return 0

    def mkdir(self, path, mode):
        try:
            self.api.mkdir(self._path(path))
            self._after_mutate(self._norm(path))
        except OSError as err:
            return self._err(err)
        return 0

    def unlink(self, path):
        try:
            self.api.unlink(self._path(path))
            self._after_mutate(self._norm(path))
        except OSError as err:
            return self._err(err)
        return 0

    def rmdir(self, path):
        try:
            self.api.unlink(self._path(path))
            self._after_mutate(self._norm(path))
        except OSError as err:
            return self._err(err)
        return 0

    def rename(self, old, new):
        try:
            self.api.rename(self._path(old), self._path(new))
            self._after_mutate(self._norm(old), self._norm(new))
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
        force=True,
    )
    # Line-buffer stdio so redirected logs appear promptly.
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass
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
    http = DataApi(bridge, token)

    # Prefer framed FS IPC (:7333). Docker Desktop → host.docker.internal.
    ipc_host = os.environ.get("HOSTFS_IPC_HOST", "").strip()
    ipc_port = int(os.environ.get("HOSTFS_IPC_PORT", "7333") or "7333")
    if not ipc_host:
        # Derive from BRIDGE_URL host when possible.
        try:
            from urllib.parse import urlparse

            u = urlparse(bridge)
            ipc_host = u.hostname or "host.docker.internal"
        except Exception:
            ipc_host = "host.docker.internal"
    ipc = None
    if os.environ.get("HOSTFS_IPC", "1").strip() not in ("0", "false", "no"):
        try:
            ipc = FsIpcClient(ipc_host, ipc_port, token)
            # Probe AUTH+HEALTH
            ipc.call("HEALTH", {})
            LOG.info("FS IPC ready at %s:%s", ipc_host, ipc_port)
        except Exception as e:
            LOG.warning("FS IPC unavailable (%s); using HTTP %s", e, bridge)
            if ipc:
                ipc.close()
            ipc = None

    api = BridgeClient(http, ipc)

    try:
        health = api.health()
        LOG.info("Data API ready: %s", health)
        # Prefer host-published exclude list when available.
        if isinstance(health, dict) and health.get("excludes"):
            AGENT_FS_EXCLUDES.clear()
            AGENT_FS_EXCLUDES.update(str(x) for x in health["excludes"])
        root = ""
        if isinstance(health, dict):
            root = str(health.get("root") or "")
    except Exception as e:
        LOG.error("Data API health failed: %s", e)
        sys.exit(2)

    try:
        os.makedirs(mount, exist_ok=True)
    except OSError:
        pass
    LOG.info(
        "Mounting %s → ~/OneBridge (agent=%s) via %s ipc=%s",
        mount,
        agent_id,
        bridge,
        bool(ipc),
    )

    LOG.info("Presenting files as uid=%s gid=%s", FS_UID, FS_GID)
    LOG.info(
        "Agent FS: tree-hydrate depth=%s maxEntries=%s excludes=%s",
        TREE_MAX_DEPTH,
        TREE_MAX_ENTRIES,
        len(AGENT_FS_EXCLUDES),
    )
    server = HostFS(
        api,
        agent_id,
        version="%prog OneBridge hostfs",
        usage="hostfs-fuse MOUNTPOINT",
        # Default is multithreaded; don't use setsingle (serializes Cursor).
        dash_s_do="undef",
    )
    # Derive host home from OneBridge root (.../OneBridge → parent).
    if root.endswith("/OneBridge") or root.endswith("OneBridge"):
        server._onebridge_root = root.rstrip("/")
        server._host_home = os.path.dirname(server._onebridge_root)
    elif root:
        server._onebridge_root = root.rstrip("/")
    server._start_events_poller()
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
        # Short TTLs so post-write mediated size/mtime propagate to open apps.
        "attr_timeout=1",
        "entry_timeout=1",
        "negative_timeout=1",
        "max_readahead=1048576",
    ):
        try:
            server.fuse_args.add(opt)
        except Exception:
            pass
    # Do NOT enable kernel_cache — it freezes size=0 placeholders and breaks open.

    server.main()


if __name__ == "__main__":
    main()
