#!/usr/bin/env python3
"""
OneBridge hostfs — FUSE client over the host Data API (:7331 /v1/fs/*).

Mount point: /host
Virtual layout mirrors ~/OneBridge on the host:
  /host/workspaces/<agentId>/...
  /host/shared/...

Requires fuse3 + python3-fuse (fusepy). Auth via BRIDGE_TOKEN or credentials JSON.
"""
from __future__ import annotations

import errno
import json
import logging
import os
import stat
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Optional, Tuple

try:
    import fuse  # python3-fuse / fusepy
    FuseOSError = getattr(fuse, "FuseOSError", OSError)
    Operations = fuse.Operations
    FUSE = fuse.FUSE
except ImportError:
    sys.stderr.write("hostfs-fuse: python3-fuse (fuse) not installed\n")
    sys.exit(1)

LOG = logging.getLogger("hostfs-fuse")
FS_VERSION = "1"
CHUNK = 1024 * 1024  # 1 MiB


def load_credentials() -> Tuple[str, str]:
    token = os.environ.get("BRIDGE_TOKEN", "").strip()
    bridge = os.environ.get("BRIDGE_URL", "http://host.docker.internal:7331").rstrip("/")
    cred_file = os.environ.get("BRIDGE_CREDENTIALS_FILE", "")
    if not cred_file:
        home = os.environ.get("HOME", "/home/browser")
        cand = os.path.join(home, ".bridge-credentials")
        if os.path.isfile(cand):
            cred_file = cand
    if cred_file and os.path.isfile(cred_file):
        with open(cred_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        token = token or data.get("token", "")
        bridge = (data.get("bridgeUrl") or bridge).rstrip("/")
    if not token:
        raise SystemExit("hostfs-fuse: missing BRIDGE_TOKEN / credentials")
    return bridge, token


class DataApi:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.token = token
        self._lock = threading.Lock()

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "*/*",
            "X-OneBridge-FS-Client": FS_VERSION,
        }
        if extra:
            h.update(extra)
        return h

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
                ver = resp.headers.get("X-OneBridge-FS", "")
                if ver and ver != FS_VERSION:
                    LOG.warning("Data API version mismatch: server=%s client=%s", ver, FS_VERSION)
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
        """Map FUSE path under /host to host OneBridge path."""
        rel = rel.lstrip("/")
        if not rel or rel == ".":
            return "~/OneBridge"
        return f"~/OneBridge/{rel}"


class HostFS(Operations):
    def __init__(self, api: DataApi):
        self.api = api
        self.fd_map: Dict[int, str] = {}
        self.next_fd = 3
        self._fd_lock = threading.Lock()

    def _alloc_fd(self, path: str) -> int:
        with self._fd_lock:
            fd = self.next_fd
            self.next_fd += 1
            self.fd_map[fd] = path
            return fd

    def _path(self, path: str) -> str:
        return self.api.host_path(path)

    def _raise(self, err: BaseException):
        if isinstance(err, OSError):
            raise FuseOSError(err.errno or errno.EIO)
        raise FuseOSError(errno.EIO)

    def getattr(self, path, fh=None):
        if path == "/":
            st = dict(
                st_mode=(stat.S_IFDIR | 0o755),
                st_nlink=2,
                st_size=0,
                st_ctime=0,
                st_mtime=0,
                st_atime=0,
                st_uid=os.getuid(),
                st_gid=os.getgid(),
            )
            return st
        try:
            info = self.api.request("GET", "/v1/fs/stat", {"path": self._path(path)})
        except OSError as err:
            self._raise(err)
        mode = stat.S_IFDIR | 0o755 if info.get("isDirectory") else stat.S_IFREG | 0o644
        return dict(
            st_mode=mode,
            st_nlink=2 if info.get("isDirectory") else 1,
            st_size=int(info.get("size") or 0),
            st_ctime=int((info.get("mtimeMs") or 0) / 1000),
            st_mtime=int((info.get("mtimeMs") or 0) / 1000),
            st_atime=int((info.get("mtimeMs") or 0) / 1000),
            st_uid=os.getuid(),
            st_gid=os.getgid(),
        )

    def readdir(self, path, fh):
        entries = [".", ".."]
        try:
            result = self.api.request("GET", "/v1/fs/list", {"path": self._path(path)})
            for e in result.get("entries") or []:
                name = e.get("name")
                if name:
                    entries.append(name)
        except OSError as err:
            if err.errno == errno.ENOENT and path == "/":
                return entries
            self._raise(err)
        return entries

    def open(self, path, flags):
        if flags & getattr(os, "O_TRUNC", 512):
            try:
                self.truncate(path, 0)
            except OSError:
                pass
        return self._alloc_fd(path)

    def create(self, path, mode, fi=None):
        try:
            self.api.request(
                "PUT",
                "/v1/fs/write",
                {"path": self._path(path), "offset": "0", "truncate": "1"},
                body=b"",
            )
        except OSError as err:
            self._raise(err)
        return self._alloc_fd(path)

    def read(self, path, size, offset, fh):
        try:
            data = self.api.request(
                "GET",
                "/v1/fs/read",
                {
                    "path": self._path(path),
                    "offset": str(offset),
                    "length": str(size),
                },
            )
        except OSError as err:
            self._raise(err)
        if isinstance(data, dict) and "_raw" in data:
            return data["_raw"]
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        return b""

    def write(self, path, data, offset, fh):
        try:
            self.api.request(
                "PUT",
                "/v1/fs/write",
                {"path": self._path(path), "offset": str(offset), "truncate": "0"},
                body=data if isinstance(data, (bytes, bytearray)) else bytes(data),
            )
        except OSError as err:
            self._raise(err)
        return len(data)

    def truncate(self, path, length, fh=None):
        try:
            self.api.request(
                "POST",
                "/v1/fs/truncate",
                json_body={"path": self._path(path), "size": int(length)},
            )
        except OSError as err:
            self._raise(err)

    def mkdir(self, path, mode):
        try:
            self.api.request("POST", "/v1/fs/mkdir", json_body={"path": self._path(path)})
        except OSError as err:
            self._raise(err)

    def unlink(self, path):
        try:
            q = urllib.parse.urlencode({"path": self._path(path)})
            self.api.request("DELETE", f"/v1/fs/path?{q}")
        except OSError as err:
            self._raise(err)

    def rmdir(self, path):
        self.unlink(path)

    def rename(self, old, new):
        try:
            self.api.request(
                "POST",
                "/v1/fs/rename",
                json_body={"from": self._path(old), "to": self._path(new)},
            )
        except OSError as err:
            self._raise(err)

    def flush(self, path, fh):
        return 0

    def release(self, path, fh):
        with self._fd_lock:
            self.fd_map.pop(fh, None)
        return 0

    def fsync(self, path, fdatasync, fh):
        return 0


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="[hostfs-fuse] %(levelname)s %(message)s",
    )
    mount = os.environ.get("HOSTFS_MOUNT", "/host")
    if len(sys.argv) > 1:
        mount = sys.argv[1]

    bridge, token = load_credentials()
    api = DataApi(bridge, token)

    try:
        health = api.request("GET", "/v1/fs/health")
        LOG.info("Data API ready: %s", health)
    except Exception as e:
        LOG.error("Data API health failed: %s", e)
        sys.exit(2)

    os.makedirs(mount, exist_ok=True)
    LOG.info("Mounting %s → ~/OneBridge via %s", mount, bridge)
    try:
        FUSE(HostFS(api), mount, foreground=True, allow_other=True)
    except TypeError:
        FUSE(HostFS(api), mount, foreground=True)


if __name__ == "__main__":
    main()
