#!/usr/bin/env node
/**
 * _smoke.mjs —— 不用 Notrat，直接把 MCP server 当子进程说一遍 JSON-RPC
 * ==================================================================
 *
 * 覆盖：握手 → 工具清单 → 启引擎 → 总览 → 接入三件套 → 直打桥的 /v1/models
 *       → 桥上的管理界面（含 CSP 放行）→ 管理 API 经桥 → 停引擎。
 *
 *   node tests/_smoke.mjs           隔离运行（临时数据目录 + 随机端口）
 *   node tests/_smoke.mjs --real    用真数据目录与真端口（先确认 Notrat 没占着）
 *   NOTRAT_OFM_HOME=/tmp/x node tests/_smoke.mjs
 *
 * 为什么默认隔离：Notrat 里真插件装好之后，8132 / 18900 已经被那个进程占住。
 * 测试再抢只会撞 EADDRINUSE —— 那种失败看着像 bug，其实是测试没隔离。
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server", "index.js");

/* ── 隔离：临时数据目录 + 按 pid 偏移的端口 ─────────────────────── */

const REAL = process.argv.includes("--real");
if (!REAL) {
  if (!process.env.NOTRAT_OFM_HOME) {
    process.env.NOTRAT_OFM_HOME = path.join(os.tmpdir(), `ofm-smoke-${Date.now()}`);
  }
  const offset = process.pid % 600;
  if (!process.env.NOTRAT_OFM_BRIDGE_PORT) process.env.NOTRAT_OFM_BRIDGE_PORT = String(18100 + offset);
  if (!process.env.NOTRAT_OFM_ENGINE_PORT) process.env.NOTRAT_OFM_ENGINE_PORT = String(19100 + offset);
}

console.log(`数据目录：${process.env.NOTRAT_OFM_HOME ?? "(插件默认)"}`);
console.log(
  `端口：engine=${process.env.NOTRAT_OFM_ENGINE_PORT ?? "18900(默认)"} bridge=${process.env.NOTRAT_OFM_BRIDGE_PORT ?? "8132(默认)"}`,
);

/* ── JSON-RPC ─────────────────────────────────────────────────── */

let nextId = 1;
const pending = new Map();

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      console.error("非 JSON 输出（协议被破坏）：", text.slice(0, 200));
      continue;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (line.trim() !== "") console.error("  ·", line.trim());
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`超时：${method}`));
    }, 180_000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function callTool(name, args = {}) {
  const reply = await rpc("tools/call", { name, arguments: args });
  const payload = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
  if (reply?.result?.isError) throw new Error(`${name}: ${payload.error}`);
  return payload;
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

let failed = 0;
function check(label, condition, detail) {
  console.log(`${condition ? "  ✓" : "  ✗"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!condition) failed += 1;
}

try {
  section("握手");
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("initialize 有 serverInfo", Boolean(init?.result?.serverInfo?.name), init?.result?.serverInfo?.name);

  section("工具清单");
  const list = await rpc("tools/list", {});
  const names = (list?.result?.tools ?? []).map((tool) => tool.name);
  check("工具数 ≥ 10", names.length >= 10, `${names.length} 个`);
  console.log(`    ${names.join(", ")}`);

  section("启引擎");
  const started = await callTool("ofm_engine", { action: "start" });
  check("running", started.running === true, `port=${started.port} upstream=${started.version}`);
  check("bridgeUrl 有值", typeof started.bridgeUrl === "string" && started.bridgeUrl !== "", started.bridgeUrl);
  check("key 只打码", typeof started.keyMasked === "string" && started.keyMasked.includes("…"), started.keyMasked);
  check("数据目录指向 engine/", String(started.dataDir).endsWith("engine"), started.dataDir);

  section("总览");
  const status = await callTool("ofm_status");
  check("是 running 状态", status.running === true);
  check("模型数 > 0", Number(status.modelCount) > 0, `${status.modelCount} 个，可用 ${status.routableCount}`);
  console.log(`    enabled=${status.enabled} channels=${JSON.stringify(status.channels)}`);

  section("接入三件套");
  const wiring = await callTool("ofm_wiring");
  check("baseUrl 指向桥", String(wiring.baseUrl).endsWith("/v1"), wiring.baseUrl);
  check("apiKey 是占位口令", wiring.apiKey === "ofm-bridge", wiring.apiKey);
  check(
    "有模型 id",
    Array.isArray(wiring.models) && wiring.models.length > 0,
    `前三个：${wiring.models.slice(0, 3).map((m) => m.id).join(", ")}`,
  );

  section("直打桥的 /v1/models（占位口令也能过）");
  const res = await fetch(`${wiring.baseUrl}/models`, { headers: { authorization: "Bearer ofm-bridge" } });
  const body = await res.json();
  check("HTTP 200", res.status === 200, `status=${res.status}`);
  check("返回模型列表", Array.isArray(body?.data) && body.data.length > 0, `${body?.data?.length ?? 0} 个`);

  section("桥上的管理界面");
  const page = await fetch(`http://127.0.0.1:${wiring.bridgePort}/`);
  const html = await page.text();
  check("HTTP 200", page.status === 200);
  check("是管理界面的 HTML", html.includes('id="app"') || html.includes("app.js"), `${html.length} 字节`);
  const csp = page.headers.get("content-security-policy") ?? "";
  check("CSP 允许被 iframe", csp.includes("frame-ancestors *"), csp.slice(0, 70) || "(无 CSP)");

  section("管理 API 经桥（面板走的同一条路）");
  const summaryRes = await fetch(`http://127.0.0.1:${wiring.bridgePort}/api/management/summary`);
  const summary = await summaryRes.json();
  check("HTTP 200", summaryRes.status === 200, `status=${summaryRes.status}`);
  check("拿到 product", summary?.product === "our-free-model-standalone", summary?.product);

  section("口令纪律");
  const key = await callTool("ofm_key", {});
  check("ofm_key 不回明文", typeof key.keyMasked === "string" && key.keyMasked.includes("…"), key.keyMasked);

  section("停引擎");
  const stopped = await callTool("ofm_engine", { action: "stop" });
  check("已停止", stopped.running === false, `how=${stopped.how ?? "-"} ${stopped.reason ?? ""}`.trim());
} catch (error) {
  failed += 1;
  console.error("\n失败：", error?.message ?? error);
} finally {
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    child.kill();
    console.log(`\n${failed === 0 ? "全部通过 ✓" : `${failed} 项失败 ✗`}`);
    process.exit(failed === 0 ? 0 : 1);
  }, 900);
}
