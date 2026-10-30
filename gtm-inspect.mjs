#!/usr/bin/env node
/**
 * Inspect one GTM container: workspaces, tags, triggers, variables.
 *
 * Read-only. This is the "export the live container before touching anything"
 * step from references/gtm.md — run it before any build so there is a rollback
 * artifact and a record of what was already in the container.
 *
 * Usage:
 *   node tools/gtm-inspect.mjs "Example account" GTM-EXAMPLE [outfile.json]
 *
 * GTM allows 0.25 QPS, so each call is spaced ~4.2 s by the server. A container
 * inspection takes a minute or two by design.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [, , ACCOUNT_NAME, CONTAINER_PUBLIC_ID, OUTFILE] = process.argv;
if (!ACCOUNT_NAME || !CONTAINER_PUBLIC_ID) {
  console.error('Usage: node tools/gtm-inspect.mjs "<account name>" <GTM-XXXXXX> [outfile.json]');
  process.exit(2);
}

const LAUNCHER = process.env.GTM_MCP_LAUNCHER;
if (!LAUNCHER) {
  console.error("Set GTM_MCP_LAUNCHER to an executable that starts your GTM MCP server.");
  process.exit(2);
}
const child = spawn(LAUNCHER, [], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => {
  const s = String(d).trim();
  if (s && !s.includes("running on stdio")) console.error("  [server]", s);
});

let nextId = 1;
const pending = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) {
        pending.delete(msg.id);
        r(msg);
      }
    } catch {
      /* not a JSON-RPC line */
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout on ${method}`));
    }, 120_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
function jsonOf(res) {
  const c = res?.result?.content;
  const text = Array.isArray(c) ? c.map((p) => p.text ?? "").join("\n") : "";
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, _isError: !!res?.result?.isError };
  }
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gtm-inspect", version: "1.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  const accounts = jsonOf(await call("list_accounts")).account ?? [];
  const account = accounts.find((a) => a.name === ACCOUNT_NAME);
  if (!account) throw new Error(`account "${ACCOUNT_NAME}" not found. Visible: ${accounts.map((a) => a.name).join(", ")}`);
  console.log(`account   ${account.name} (${account.accountId})`);

  const containers = jsonOf(await call("list_containers", { account_id: account.accountId })).container ?? [];
  const container = containers.find((c) => c.publicId === CONTAINER_PUBLIC_ID);
  if (!container) throw new Error(`container ${CONTAINER_PUBLIC_ID} not found. Visible: ${containers.map((c) => c.publicId).join(", ")}`);
  console.log(`container ${container.publicId} "${container.name}" (id ${container.containerId})`);
  console.log(`          usageContext=${JSON.stringify(container.usageContext)} features=${Object.keys(container.features ?? {}).length}`);

  const workspaces = jsonOf(await call("list_workspaces", { account_id: account.accountId, container_id: container.containerId })).workspace ?? [];
  console.log(`workspaces ${workspaces.map((w) => `${w.name}(${w.workspaceId})`).join(", ") || "none"}`);

  const dump = { account, container, workspaces, byWorkspace: {} };

  for (const ws of workspaces) {
    const base = { account_id: account.accountId, container_id: container.containerId, workspace_id: ws.workspaceId };
    const tags = jsonOf(await call("list_tags", base)).tag ?? [];
    const triggers = jsonOf(await call("list_triggers", base)).trigger ?? [];
    const variables = jsonOf(await call("list_variables", base)).variable ?? [];
    dump.byWorkspace[ws.workspaceId] = { name: ws.name, tags, triggers, variables };

    console.log(`\n--- workspace "${ws.name}" (${ws.workspaceId}) ---`);
    console.log(`  TAGS (${tags.length}):`);
    for (const t of tags) {
      const ids = (t.parameter ?? [])
        .filter((p) => /^(tagId|trackingId|measurementId|conversionId|awConversionId|gaSettings)$/i.test(p.key ?? ""))
        .map((p) => `${p.key}=${p.value}`)
        .join(" ");
      console.log(`    - "${t.name}" type=${t.type}${ids ? "  " + ids : ""}  paused=${t.paused ?? false}  firingTriggerId=${JSON.stringify(t.firingTriggerId ?? [])}`);
    }
    console.log(`  TRIGGERS (${triggers.length}):`);
    for (const tr of triggers) console.log(`    - "${tr.name}" type=${tr.type} (${tr.triggerId})`);
    console.log(`  VARIABLES (${variables.length}):`);
    for (const v of variables) console.log(`    - "${v.name}" type=${v.type}`);
  }

  const out = OUTFILE ?? `gtm-${CONTAINER_PUBLIC_ID}-export.json`;
  writeFileSync(out, JSON.stringify(dump, null, 2));
  console.log(`\nrollback artifact written: ${out}`);
} catch (err) {
  console.error("ERROR:", err.message ?? err);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
