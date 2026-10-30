#!/usr/bin/env node
/**
 * Smoke test for the GTM MCP server, driven over stdio exactly as an MCP client
 * would drive it. Proves the install by invoking tools, not by checking exit codes.
 *
 * Sequence: initialize -> tools/list -> list_accounts -> list_containers ->
 * list_workspaces -> read one tag, then the NEGATIVE test:
 *
 *   publish_version(action="publish") against a deliberately non-existent
 *   version id. The response distinguishes the two states we care about:
 *     403 -> the OAuth token lacks tagmanager.publish. Publishing is impossible. PASS.
 *     404 -> the token HAS publish rights and only the version id was wrong. FAIL.
 *
 * A bogus id is used on purpose so the test can never publish anything.
 *
 * GTM allows 0.25 QPS (25 calls / 100 s), and the server spaces requests ~4.2 s
 * apart by default, so a full run takes a couple of minutes. That is the API,
 * not the script.
 *
 * Usage: node tools/gtm-smoke.mjs
 */
import { spawn } from "node:child_process";

const LAUNCHER = process.env.GTM_MCP_LAUNCHER;
if (!LAUNCHER) {
  console.error("Set GTM_MCP_LAUNCHER to an executable that starts your GTM MCP server.");
  process.exit(2);
}
const BOGUS_VERSION_ID = "999999999";

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
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
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

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

/** Tool results come back as text content; parse JSON when the tool returned JSON. */
function textOf(res) {
  const c = res?.result?.content;
  if (!Array.isArray(c)) return { text: "", isError: !!res?.result?.isError };
  return { text: c.map((p) => p.text ?? "").join("\n"), isError: !!res.result.isError };
}
function jsonOf(res) {
  const { text } = textOf(res);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function call(name, args = {}) {
  return rpc("tools/call", { name, arguments: args });
}

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

try {
  console.log("=== handshake ===");
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gtm-smoke", version: "1.0" },
  });
  notify("notifications/initialized", {});
  record("initialize", !!init.result, `server ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
  record("tools/list", names.length > 0, `${names.length} tools: ${names.join(", ")}`);
  record(
    "publish_version is exposed (expected — gating is by scope, not by config)",
    names.includes("publish_version"),
    names.includes("publish_version") ? "present" : "absent",
  );

  console.log("\n=== read path (each call is rate-limited ~4.2s by the server) ===");
  const accountsRes = await call("list_accounts");
  const accounts = jsonOf(accountsRes)?.account ?? [];
  record("list_accounts", accounts.length > 0, accounts.map((a) => `${a.name}(${a.accountId})`).join(", ") || "none visible");
  if (!accounts.length) throw new Error("no GTM accounts visible to this identity — cannot continue");

  const accountId = accounts[0].accountId;
  const containersRes = await call("list_containers", { account_id: accountId });
  const containers = jsonOf(containersRes)?.container ?? [];
  record("list_containers", containers.length > 0, containers.map((c) => `${c.publicId}:${c.name}`).join(", ") || "none");
  if (!containers.length) throw new Error("no containers in the first account");

  const container = containers[0];
  const containerId = container.containerId;

  const wsRes = await call("list_workspaces", { account_id: accountId, container_id: containerId });
  const workspaces = jsonOf(wsRes)?.workspace ?? [];
  record("list_workspaces", workspaces.length > 0, `${container.publicId}: ` + (workspaces.map((w) => `${w.name}(${w.workspaceId})`).join(", ") || "none"));

  if (workspaces.length) {
    const tagsRes = await call("get_resource", {
      account_id: accountId,
      container_id: containerId,
      workspace_id: workspaces[0].workspaceId,
      resource: "tag",
    });
    const tags = jsonOf(tagsRes)?.tag ?? [];
    record("read tags", !textOf(tagsRes).isError, tags.length ? tags.map((t) => `${t.name}[${t.type}]`).join(", ") : "workspace has no tags");
  }

  console.log("\n=== NEGATIVE: publish must be refused by missing scope ===");
  const pub = await call("publish_version", {
    account_id: accountId,
    container_id: containerId,
    action: "publish",
    version_id: BOGUS_VERSION_ID,
  });
  const { text: pubText } = textOf(pub);
  const is403 = /\b403\b|PERMISSION_DENIED|insufficient (authentication|permission)|forbidden/i.test(pubText);
  const is404 = /\b404\b|NOT_FOUND/i.test(pubText);
  record(
    "publish_version blocked by scope",
    is403 && !is404,
    is403 ? "403 — token has no tagmanager.publish, publishing is impossible" : is404 ? "404 — TOKEN CAN PUBLISH, only the version id was wrong" : `unexpected: ${pubText.slice(0, 200)}`,
  );
} catch (err) {
  record("run completed", false, String(err.message ?? err));
} finally {
  child.stdin.end();
  child.kill();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}
