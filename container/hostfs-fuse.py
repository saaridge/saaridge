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


def _mk_stat(is_dir: bool, size: int = 0, mtime: int = 0, ino: int = 0) -> "fuse.Stat":
    st = fuse.Stat()
    st.st_mode = (stat.S_IFDIR | 0o755) if is_dir else (stat.S_IFREG | 0o644)
    # Non-empty dirs: nlink>2 so clients don't treat the folder as vacant.
    st.st_nlink = 3 if is_dir else 1
    st.st_size = int(size or 0)
    st.st_uid = FS_UID
    st.st_gid = FS_GID
    st.st_ino = (int(ino) & 0xFFFFFFFF) or 1
    now = int(mtime or 0) or 1
    st.st_atime = now
    st.st_mtime = now
    st.st_ctime = now
    return st


def _ino_for(path: str) -> int:
    # Stable non-zero inode per path (Electron/Node file trees break on inode 0 collisions).
    h = 0
    for ch in path:
        h = ((h * 131) + ord(ch)) & 0xFFFFFFFF
    return h or 1


class HostFS(Fuse):
    def __init__(self, api: DataApi, agent_id: str, *args, **kw):
        Fuse.__init__(self, *args, **kw)
        self.api = api
        self.agent_id = agent_id
        self.fd_map: Dict[int, str] = {}
        self.next_fd = 3
        self._fd_lock = threading.Lock()
        self._getattr_cache: Dict[str, Tuple[float, object]] = {}
        self._getattr_lock = threading.Lock()
        self._getattr_ttl = 2.0

    def _path(self, path: str) -> str:
        return self.api.host_path(path)

    def _norm(self, path: str) -> str:
        return path.rstrip("/") or "/"

    def _err(self, err: BaseException) -> int:
        if isinstance(err, OSError):
            return -int(err.errno or errno.EIO)
        return -errno.EIO

    def getattr(self, path):
        p = self._norm(path)
        now = time.time()
        with self._getattr_lock:
            hit = self._getattr_cache.get(p)
            if hit and now - hit[0] < self._getattr_ttl:
                return hit[1]

        if p in ("/", "/workspaces", "/shared", "/home"):
            st = _mk_stat(True, ino=_ino_for(p))
            with self._getattr_lock:
                self._getattr_cache[p] = (now, st)
            return st
        if p.startswith("/workspaces/") and not (
            p == f"/workspaces/{self.agent_id}"
            or p.startswith(f"/workspaces/{self.agent_id}/")
        ):
            return -errno.ENOENT
        try:
            info = self.api.request("GET", "/v1/fs/stat", {"path": self._path(path)})
        except OSError as err:
            return self._err(err)
        st = _mk_stat(
            bool(info.get("isDirectory")),
            int(info.get("size") or 0),
            int((info.get("mtimeMs") or 0) / 1000),
            ino=_ino_for(p),
        )
        with self._getattr_lock:
            self._getattr_cache[p] = (now, st)
        return st

    def access(self, path, mode):
        # allow_other + browser ownership: permit read/write/exec checks for desktop user
        st = self.getattr(path)
        if isinstance(st, int) and st < 0:
            return st
        return 0

    def statfs(self, path=None):
        # Critical for Electron/Chromium GtkFileChooser — zero blocks ⇒ mount hidden.
        # Keep values modest so 32-bit statvfs fields never overflow.
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
        # (name, type_mode or None) — include type so Node/Cursor withFileTypes
        # does not fire a getattr storm (which wedges single-thread FUSE).
        entries = [(".", stat.S_IFDIR), ("..", stat.S_IFDIR)]
        if p == "/":
            entries += [
                ("workspaces", stat.S_IFDIR),
                ("shared", stat.S_IFDIR),
                ("home", stat.S_IFDIR),
            ]
        elif p == "/workspaces":
            entries += [(self.agent_id, stat.S_IFDIR)]
        else:
            try:
                result = self.api.request("GET", "/v1/fs/list", {"path": self._path(path)})
                for e in result.get("entries") or []:
                    name = e.get("name")
                    if not name:
                        continue
                    if e.get("isDirectory"):
                        mode = stat.S_IFDIR
                    elif e.get("isSymbolicLink"):
                        mode = stat.S_IFLNK
                    else:
                        mode = stat.S_IFREG
                    entries.append((name, mode))
            except OSError as err:
                yield -int(err.errno or errno.EIO)
                return
        for name, mode in entries:
            yield fuse.Direntry(name, type=mode)

    def open(self, path, flags):
        return 0

    def read(self, path, length, offset):
        try:
            data = self.api.request(
                "GET",
                "/v1/fs/read",
                {
                    "path": self._path(path),
                    "offset": str(offset),
                    "length": str(length),
                },
            )
        except OSError as err:
            return self._err(err)
        if isinstance(data, dict) and "_raw" in data:
            return data["_raw"]
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        return b""

    def write(self, path, buf, offset):
        data = buf if isinstance(buf, (bytes, bytearray)) else bytes(buf)
        try:
            self.api.request(
                "PUT",
                "/v1/fs/write",
                {"path": self._path(path), "offset": str(offset), "truncate": "0"},
                body=data,
            )
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
        except OSError as err:
            return self._err(err)
        return 0

    def mkdir(self, path, mode):
        try:
            self.api.request("POST", "/v1/fs/mkdir", json_body={"path": self._path(path)})
        except OSError as err:
            return self._err(err)
        return 0

    def unlink(self, path):
        try:
            q = urllib.parse.urlencode({"path": self._path(path)})
            self.api.request("DELETE", f"/v1/fs/path?{q}")
        except OSError as err:
            return self._err(err)
        return 0

    def rmdir(self, path):
        return self.unlink(path)

    def rename(self, old, new):
        try:
            self.api.request(
                "POST",
                "/v1/fs/rename",
                json_body={"from": self._path(old), "to": self._path(new)},
            )
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
    server = HostFS(
        api,
        agent_id,
        version="%prog OneBridge hostfs",
        usage="hostfs-fuse MOUNTPOINT",
        # Multithreaded: Cursor/Node issue many parallel getattr/readdir calls.
        dash_s_do="setsingle",
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
    try:
        # Avoid kernel applying root-only DAC that confuses file dialogs
        server.fuse_args.add("default_permissions")
    except Exception:
        pass
    try:
        server.fuse_args.add("nonempty")
    except Exception:
        pass
    # Prefer multi-threaded request handling when libfuse supports it.
    try:
        server.fuse_args.add("max_readahead=131072")
    except Exception:
        pass
    server.main()


if __name__ == "__main__":
    main()
