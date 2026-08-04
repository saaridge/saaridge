#!/usr/bin/env node
import { purgeEphemeralAgents } from "../host/lib/ephemeral-agents.js";

const dryRun = process.argv.includes("--dry-run");
const { removedIds } = purgeEphemeralAgents({ dryRun });

if (!removedIds.length) {
  console.log(
    dryRun
      ? "No ephemeral agents to remove (dry run)"
      : "No ephemeral agents to remove",
  );
} else {
  console.log(
    `${dryRun ? "Would remove" : "Removed"} ${removedIds.length} agent(s):`,
  );
  for (const id of removedIds) console.log(`  - ${id}`);
}
