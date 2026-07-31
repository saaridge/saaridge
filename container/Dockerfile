# Build mediated /host FUSE (Rust) — preferred over Python at runtime.
FROM rust:1.83-bookworm AS hostfs-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    fuse3 libfuse3-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY container/hostfs-rust/Cargo.toml container/hostfs-rust/Cargo.lock /src/
COPY container/hostfs-rust/src /src/src
RUN cargo build --release 2>&1

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates iptables iproute2 sudo \
    chromium \
    fonts-liberation fonts-dejavu-core \
    xvfb x11vnc \
    x11-xserver-utils xterm \
    xfce4 xfce4-terminal dbus-x11 \
    wmctrl xdotool \
    novnc websockify \
    pulseaudio pulseaudio-utils ffmpeg \
    libnss3-tools \
    libglib2.0-bin \
    zenity \
    python3 \
    fuse3 \
    python3-fuse \
    libfuse3-3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash browser \
    && passwd -l browser \
    && mkdir -p /opt/agents /opt/bridge /tmp/agent-scratch /host \
    && chown root:root /opt/bridge \
    && chown -R browser:browser /home/browser \
    && printf '%s\n' \
         '# Agent user: locked password; no general sudo.' \
         '# Host-home write is granted on the host bridge — never via container sudo.' \
         '# Only workspace-app uninstall may run as root without a password:' \
         'browser ALL=(root) NOPASSWD: /opt/bridge/uninstall-workspace-app.sh' \
         > /etc/sudoers.d/onebridge-uninstall \
    && chmod 440 /etc/sudoers.d/onebridge-uninstall \
    && echo 'user_allow_other' >> /etc/fuse.conf

WORKDIR /opt/bridge

COPY container/bridge-package.json /opt/bridge/package.json
RUN npm install --omit=dev

COPY container/bridge-mcp-stdio.mjs /opt/bridge/bridge-mcp-stdio.mjs
COPY container/auth-proxy.mjs /opt/bridge/auth-proxy.mjs
COPY container/audio-stream.mjs /opt/bridge/audio-stream.mjs
COPY container/agent-env.sh /opt/bridge/agent-env.sh
COPY container/bridge-browser.sh /opt/bridge/bridge-browser.sh
COPY container/launch-browser.sh /opt/bridge/launch-browser.sh
COPY container/open-agent.sh /opt/bridge/open-agent.sh
COPY container/open-install-assistant.sh /opt/bridge/open-install-assistant.sh
COPY container/gtk-file-picker.py /opt/bridge/gtk-file-picker.py
COPY container/list-workspace-apps.py /opt/bridge/list-workspace-apps.py
COPY container/record-workspace-package.py /opt/bridge/record-workspace-package.py
COPY container/uninstall-workspace-app.sh /opt/bridge/uninstall-workspace-app.sh
COPY container/install-workspace-app.sh /opt/bridge/install-workspace-app.sh
COPY container/ensure-desktop-icon.py /opt/bridge/ensure-desktop-icon.py
COPY container/workspace-ops-daemon.py /opt/bridge/workspace-ops-daemon.py
COPY container/workspace-ops-client.py /opt/bridge/workspace-ops-client.py
COPY container/repair-desktop.sh /opt/bridge/repair-desktop.sh
COPY container/dedupe-xfce-panel.sh /opt/bridge/dedupe-xfce-panel.sh
COPY container/host-bin/ /opt/bridge/host-bin/
COPY container/hostfs-fuse.py /opt/bridge/hostfs-fuse.py
COPY container/hostfs-watchdog.sh /opt/bridge/hostfs-watchdog.sh
COPY --from=hostfs-builder /src/target/release/onebridge-hostfs /opt/bridge/onebridge-hostfs
COPY container/audio-watchdog.sh /opt/bridge/audio-watchdog.sh
COPY container/trust-mitm-ca.sh /usr/local/bin/trust-mitm-ca.sh
COPY container/start-audio.sh /usr/local/bin/start-audio.sh
COPY container/novnc-onebridge.html /usr/share/novnc/novnc-onebridge.html
COPY container/network-lock.sh /usr/local/bin/network-lock.sh
COPY container/start-desktop.sh /usr/local/bin/start-desktop.sh
COPY container/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /opt/bridge/bridge-browser.sh /opt/bridge/launch-browser.sh \
      /opt/bridge/open-agent.sh /opt/bridge/open-install-assistant.sh \
      /opt/bridge/gtk-file-picker.py \
      /opt/bridge/list-workspace-apps.py \
      /opt/bridge/record-workspace-package.py \
      /opt/bridge/uninstall-workspace-app.sh \
      /opt/bridge/install-workspace-app.sh \
      /opt/bridge/ensure-desktop-icon.py \
      /opt/bridge/workspace-ops-daemon.py \
      /opt/bridge/workspace-ops-client.py \
      /opt/bridge/repair-desktop.sh \
      /opt/bridge/dedupe-xfce-panel.sh \
      /opt/bridge/hostfs-fuse.py \
      /opt/bridge/hostfs-watchdog.sh \
      /opt/bridge/onebridge-hostfs \
      /opt/bridge/audio-watchdog.sh \
      /opt/bridge/agent-env.sh /opt/bridge/host-bin/* \
      /usr/local/bin/network-lock.sh /usr/local/bin/start-desktop.sh \
      /usr/local/bin/start-audio.sh /usr/local/bin/trust-mitm-ca.sh \
      /usr/local/bin/entrypoint.sh \
    && chmod 644 /opt/bridge/*.mjs \
    && rm -f /opt/bridge/token

ENV BRIDGE_URL=http://host.docker.internal:7331
ENV BRIDGE_PROXY_PORT=7332
ENV HOSTFS_IPC_PORT=7333
ENV BROWSER=/opt/bridge/bridge-browser.sh
ENV DISPLAY=:1
ENV RESOLUTION=1920x1080x24
ENV XDG_RUNTIME_DIR=/tmp/runtime-browser
ENV PULSE_RUNTIME_PATH=/tmp/runtime-browser/pulse
ENV PULSE_SERVER=unix:/tmp/runtime-browser/pulse/native

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
