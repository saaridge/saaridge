#!/usr/bin/env python3
"""Minimal RFB 3.8 client: connect to x11vnc and send a keysym down+up pair."""
from __future__ import annotations

import socket
import struct
import sys


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("VNC connection closed")
        buf += chunk
    return buf


def connect_vnc(host: str = "127.0.0.1", port: int = 5900) -> socket.socket:
    sock = socket.create_connection((host, port), timeout=8)
    banner = recv_exact(sock, 12)
    if not banner.startswith(b"RFB "):
        raise RuntimeError(f"unexpected VNC banner: {banner!r}")
    sock.sendall(b"RFB 003.008\n")

    ntypes = recv_exact(sock, 1)[0]
    types = recv_exact(sock, ntypes)
    if 1 not in types:
        raise RuntimeError(f"VNC security type 1 (none) unavailable: {list(types)}")
    sock.sendall(b"\x01")
    result = struct.unpack(">I", recv_exact(sock, 4))[0]
    if result != 0:
        raise RuntimeError(f"VNC security handshake failed: {result}")

    sock.sendall(b"\x01")  # shared desktop
    recv_exact(sock, 2)  # width
    recv_exact(sock, 2)  # height
    recv_exact(sock, 16)  # pixel format
    name_len = struct.unpack(">I", recv_exact(sock, 4))[0]
    recv_exact(sock, name_len)  # desktop name
    return sock


def send_key(sock: socket.socket, keysym: int, down: bool) -> None:
    sock.sendall(struct.pack(">BBHI", 4, 1 if down else 0, 0, keysym))


def tap_key(sock: socket.socket, keysym: int) -> None:
    send_key(sock, keysym, True)
    send_key(sock, keysym, False)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: vnc-send-key.py <keysym> [host] [port]", file=sys.stderr)
        return 2
    keysym = int(sys.argv[1], 0)
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    port = int(sys.argv[3]) if len(sys.argv) > 3 else 5900
    sock = connect_vnc(host, port)
    try:
        tap_key(sock, keysym)
    finally:
        sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
