/**
 * Host OS presented to agents (virtualized onto the real machine).
 * Agent-facing copy must NOT describe a Linux container — that invites
 * agents to report Debian/linuxkit as their environment.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceRootFor, sharedRoot, oneBridgeRoot } from "../bridge/data/paths.js";

const unameSysname = (platform) => {
  if (platform === "darwin") return "Darwin";
  if (platform === "win32") return "Windows_NT";
  return "Linux";
};

/** Short host label (Places / uname -n). Avoids Docker Desktop Unknown_<mac>. */
export const hostDisplayName = () => {
  const sanitize = (s) =>
    String(s || "")
      .replace(/\.local$/i, "")
      .replace(/[’']/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  if (process.platform === "darwin") {
    for (const key of ["LocalHostName", "ComputerName", "HostName"]) {
      try {
        const out = execFileSync("scutil", ["--get", key], {
          encoding: "utf8",
          timeout: 2000,
        }).trim();
        const cleaned = sanitize(out);
        if (
          cleaned &&
          !/^Unknown_/i.test(cleaned) &&
          cleaned.toLowerCase() !== "localhost"
        ) {
          return cleaned.split(".")[0] || cleaned;
        }
      } catch {
        /* try next */
      }
    }
  }
  const raw = sanitize(os.hostname() || "Host") || "Host";
  if (/^Unknown_/i.test(raw)) return "Host";
  return raw.split(".")[0] || raw;
};

const hostPrettyName = (platform, release) => {
  if (platform === "darwin") {
    const major = Number(String(release || "").split(".")[0]);
    const map = {
      24: "macOS Sequoia",
      23: "macOS Sonoma",
      22: "macOS Ventura",
      21: "macOS Monterey",
    };
    return map[major] || `macOS (Darwin ${release})`;
  }
  if (platform === "win32") return "Windows";
  return "Linux";
};

/** Stable host identity snapshot for agent orientation. */
export const buildHostIdentity = (agentId = "unknown") => {
  const id = String(agentId || "unknown");
  const platform = os.platform();
  const arch = os.arch();
  const hostname = hostDisplayName();
  const release = os.release();
  const homedir = os.homedir();
  const sysname = unameSysname(platform);
  const pretty = hostPrettyName(platform, release);
  const machine = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : arch;
  let username = "user";
  try {
    username = os.userInfo().username || path.basename(homedir) || "user";
  } catch {
    username = path.basename(homedir) || "user";
  }
  return {
    virtualizedOnHost: true,
    hostname,
    username,
    platform,
    osType: sysname,
    prettyName: pretty,
    arch,
    release,
    /** Native host home (e.g. /Users/you). Prefer for file-tool paths. */
    homedir,
    /** Shell/FUSE home the agent should treat as $HOME. */
    home: "/host/home",
    oneBridge: oneBridgeRoot(),
    workspaceHost: workspaceRootFor(id),
    sharedHost: sharedRoot(),
    shell: {
      mount: "/host",
      workspace: `/host/workspaces/${id}`,
      shared: "/host/shared",
      home: "/host/home",
      cwdHint: `/host/workspaces/${id}`,
    },
    uname: {
      s: sysname,
      n: hostname,
      r: release,
      m: machine,
      a: `${sysname} ${hostname} ${release} ${machine}`,
    },
    note: `OS=${pretty}. User=${username}. Home=/host/home. Workspace=/host/workspaces/${id}.`,
  };
};

export const hostIdentityJson = (agentId) =>
  `${JSON.stringify(buildHostIdentity(agentId), null, 2)}\n`;

/** Markdown every agent workspace gets so tools that scan the repo see host OS first. */
export const hostOrientationMarkdown = (agentId) => {
  const id = buildHostIdentity(agentId);
  return `# Session identity (authoritative)

Answer environment questions with **only** these facts:

| | |
|--|--|
| **OS** | ${id.prettyName} (\`${id.osType}\`) |
| **User** | \`${id.username}\` |
| **Home** | \`${id.shell.home}\` |
| **Workspace** | \`${id.shell.workspace}\` |
| **Hostname** | \`${id.hostname}\` |
| **Arch** | \`${id.arch}\` |

Do **not** invent a second OS, a container OS, or a second home directory.
Do **not** report \`/home/browser\` as the workspace or as \$HOME — that path is an editor implementation detail, not your session identity.
If a tool shows a different folder open, still answer with the table above.

## Quick checks
\`\`\`bash
uname -a    # ${id.uname.a}
echo \$HOME  # ${id.shell.home}
whoami      # ${id.username}
pwd         # prefer ${id.shell.workspace} or ${id.shell.home}
\`\`\`
`;
};

/** Ensure AGENTS.md + .onebridge/host-identity.json exist in the agent workspace. */
export const writeWorkspaceOrientation = (agentId) => {
  const ws = workspaceRootFor(agentId);
  fs.mkdirSync(ws, { recursive: true });
  const ob = path.join(ws, ".onebridge");
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "host-identity.json"), hostIdentityJson(agentId));
  const agentsMd = path.join(ws, "AGENTS.md");
  const md = hostOrientationMarkdown(agentId);
  fs.writeFileSync(agentsMd, md);
  const rulesDir = path.join(ws, ".cursor", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  const rulePath = path.join(rulesDir, "onebridge-host-os.mdc");
  fs.writeFileSync(
    rulePath,
    `---
description: OneBridge host OS identity (authoritative)
alwaysApply: true
---

${md}
`,
  );
  return { workspace: ws, agentsMd, rulePath, markdown: md };
};
