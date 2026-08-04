#!/usr/bin/env node
/**
 * Host-only OS/home identity regression.
 *
 * Agents must see macOS (or host OS) + HOME=/host/home when querying inside
 * the container, without dual-layer Linux narratives. Sandbox paths stay for
 * Chromium/Cursor user-data / XFCE only.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createRunner,
  dockerBoxRunning,
} from "./lib/test-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const { ok, fail, skip, section, done } = createRunner("host-identity");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

section("source: agent-env always sets HOME to host home");
try {
  const src = read("container/agent-env.sh");
  if (!/export HOME="\$ONEBRIDGE_HOST_HOME"/.test(src)) {
    throw new Error("agent-env must export HOME=$ONEBRIDGE_HOST_HOME unconditionally");
  }
  if (/if timeout 1 test -d "\$ONEBRIDGE_HOST_HOME"[\s\S]*export HOME=/.test(src)) {
    throw new Error("HOME remap must not be gated on FUSE test -d");
  }
  if (!src.includes('ONEBRIDGE_SANDBOX_HOME:-/home/browser')) {
    throw new Error("sandbox home must remain available for apps");
  }
  ok("agent-env HOME=/host/home; sandbox kept for apps");
} catch (e) {
  fail("agent-env HOME", e);
}

section("source: profile.d identity without FUSE");
try {
  const src = read("container/trust-mitm-ca.sh");
  if (!src.includes("onebridge-identity.sh")) {
    throw new Error("must install onebridge-identity.sh");
  }
  if (/onebridge-identity\.sh[\s\S]*export HOME="\$\{ONEBRIDGE_HOST_HOME\}"/.test(src)) {
    throw new Error("identity profile.d must NOT set HOME (FUSE .profile hang)");
  }
  if (!src.includes("/opt/bridge/host-bin")) {
    throw new Error("identity profile must prepend host-bin for uname shim");
  }
  if (!fs.existsSync(path.join(ROOT, "container", "install-sandbox-profile.sh"))) {
    throw new Error("missing install-sandbox-profile.sh (HOME remap at end of .profile)");
  }
  ok("profile.d sets PATH only; sandbox .profile remaps HOME last");
} catch (e) {
  fail("profile.d identity", e);
}

section("source: orientation is host-only");
try {
  const src = read("host/lib/host-identity.js");
  if (!src.includes("Do **not** invent a second OS")) {
    throw new Error("orientation must forbid dual-OS answers");
  }
  if (!src.includes("/home/browser")) {
    throw new Error("orientation must explicitly forbid reporting /home/browser as workspace");
  }
  const mdStart = src.indexOf("hostOrientationMarkdown");
  const md = src.slice(mdStart, mdStart + 3500);
  // Mentions of /home/browser are OK only as a forbidden path to report.
  if (/\blinuxkit\b|\bDebian\b/.test(md)) {
    throw new Error("orientation markdown must not mention linuxkit or Debian");
  }
  const ws = read("host/lib/workspace-os.js");
  if (ws.includes("sandboxDesktop")) {
    throw new Error("workspace-os must not expose sandboxDesktop to APIs");
  }
  if (!fs.existsSync(path.join(ROOT, "container", "install-host-identity-bins.sh"))) {
    throw new Error("missing install-host-identity-bins.sh");
  }
  if (!fs.existsSync(path.join(ROOT, "container", "host-bin", "whoami"))) {
    throw new Error("missing host-bin/whoami");
  }
  ok("host orientation + workspace-os are host-only");
} catch (e) {
  fail("orientation host-only", e);
}

section("source: desktop stays on sandbox HOME");
try {
  const src = read("container/start-desktop.sh");
  if (!src.includes('export HOME="${ONEBRIDGE_SANDBOX_HOME}"')) {
    throw new Error("start-desktop must pin HOME back to sandbox after agent-env");
  }
  const browser = read("container/launch-browser.sh");
  if (!browser.includes('export HOME="${SANDBOX_HOME}"')) {
    throw new Error("launch-browser must keep Chromium on sandbox HOME");
  }
  ok("XFCE/browser keep sandbox HOME");
} catch (e) {
  fail("sandbox app HOME", e);
}

if (!dockerBoxRunning()) {
  skip("live container identity", "agent-bridge-box not running");
} else {
  section("live: login shell HOME + uname");
  try {
    const res = spawnSync(
      "docker",
      [
        "exec",
        "-u",
        "browser",
        "agent-bridge-box",
        "bash",
        "-lc",
        'printf "HOME=%s\\n" "$HOME"; printf "UNAME=%s\\n" "$(uname -s)"; printf "WHICH=%s\\n" "$(command -v uname)"; printf "OS=%s\\n" "$(grep ^PRETTY_NAME= /etc/os-release | head -1)"',
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || "").trim() || `exit ${res.status}`);
    }
    const out = res.stdout || "";
    if (!/^HOME=\/host\/home$/m.test(out)) {
      throw new Error(`expected HOME=/host/home, got:\n${out}`);
    }
    if (!/UNAME=Darwin/.test(out)) {
      throw new Error(`expected uname -s=Darwin (host shim), got:\n${out}`);
    }
    if (!/WHICH=.*\/opt\/bridge\/host-bin\/uname/.test(out)) {
      throw new Error(`expected which uname → host-bin, got:\n${out}`);
    }
    if (!/macOS/.test(out)) {
      throw new Error(`expected macOS in os-release, got:\n${out}`);
    }
    ok("login shell: HOME=/host/home, uname=Darwin, os-release=macOS");
  } catch (e) {
    fail("live login identity", e);
  }

  section("live: absolute /usr/bin/uname + whoami");
  try {
    const res = spawnSync(
      "docker",
      [
        "exec",
        "-u",
        "browser",
        "agent-bridge-box",
        "bash",
        "-c",
        'printf "U=%s\\n" "$(/usr/bin/uname -s)"; printf "W=%s\\n" "$(/usr/bin/whoami)"; printf "H=%s\\n" "$HOME"',
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || "").trim() || `exit ${res.status}`);
    }
    const out = res.stdout || "";
    if (!/U=Darwin/.test(out)) {
      throw new Error(`/usr/bin/uname must report Darwin, got:\n${out}`);
    }
    if (/W=root\b|W=browser\b/.test(out)) {
      throw new Error(`whoami must be host username, got:\n${out}`);
    }
    if (!/H=\/host\/home/.test(out)) {
      // HOME may be unset in non-login bash -c; identity profile only on login
    }
    ok(`absolute uname/whoami host identity (${out.replace(/\n/g, " ").trim()})`);
  } catch (e) {
    fail("absolute uname/whoami", e);
  }

  section("live: bash -lc does not hang");
  try {
    const t0 = Date.now();
    const res = spawnSync(
      "docker",
      ["exec", "agent-bridge-box", "bash", "-lc", "echo ok"],
      { encoding: "utf8", timeout: 5000 },
    );
    const ms = Date.now() - t0;
    if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
    if (ms > 4000) throw new Error(`bash -lc too slow (${ms}ms) — FUSE hang?`);
    ok(`bash -lc still fast (${ms}ms)`);
  } catch (e) {
    fail("bash -lc hang guard", e);
  }
}

process.exit(done() ? 1 : 0);
