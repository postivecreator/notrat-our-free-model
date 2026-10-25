/**
 * notrat-our-free-model —— MCP server（执行宿主）
 * ==============================================
 *
 * 零依赖 stdio JSON-RPC。引擎是模块级单例：第一次用到就启动，
 * 之后各次调用共用同一套引擎 / 桥 / 会话。
 *
 * 三条纪律：
 *   1. **日志只走 stderr**。stdout 是 JSON-RPC 通道，多写一个字节都会破坏协议。
 *      面板的「日志」抽屉读的就是 engine.log 与 stderr。
 *   2. **永不回传明文 key**。所有出口都经过 maskKey()，唯一的例外是桥自己
 *      （它在出站时注入 key，key 从不进入对话或面板）。
 *   3. **不许编造状态**。没起来就报没起来；上游说什么就报什么。
 */
import readline from "node:readline";
import { OfmEngine, PREFIX } from "./engine.js";
import { PLUGIN_ID, maskKey, readConfig, readEngineKey, readManifest, upstreamVersion, writeConfig } from "./env.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: PLUGIN_ID, version: readManifest().version ?? "0.1.0" };

/* ── 日志：只写 stderr ─────────────────────────────────────────── */

function log(level, message) {
  process.stderr.write(`[our-free-model] ${level} ${message}\n`);
}

const logger = {
  info: (m) => log("INFO", String(m)),
  warn: (m) => log("WARN", String(m)),
  error: (m) => log("ERROR", String(m)),
  debug: () => {},
};

/* ── 引擎单例 ──────────────────────────────────────────────────── */

const engine = new OfmEngine({ logger });

/* ── 结果封装 ──────────────────────────────────────────────────── */

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

/* ── 一键接入 Notrat ─────────────────────────────────────────────
 *
 * Notrat 自己提供一个导入通道：notrat://import-ai?type&name&baseUrl&apiKey&model&models
 *
 * 为什么用链接而不是直接写配置：AI 服务商存在渲染进程的 localStorage 里
 * （不是 ~/.notrat 下任何一份 JSON），插件去改写它是越界而且易碎。
 * 链接走的是**应用自己的写入路径**：Notrat 会弹一个确认框，把我们给的字段
 * 一项项列出来（打码后的 Key 也在里面），用户点确认才落盘 —— 既是一键，
 * 也没有绕过任何一道确认。
 *
 * apiKey 给的是占位口令 ofm-bridge：桥在出站时换成上游真 key，
 * 所以真 key 从不进入这份配置，链接被截图也不算泄露。
 */

/** 一次能塞进链接的模型 id 上限。太长会在各处 URL 长度限制上翻车。 */
const LINK_MODEL_LIMIT = 28;

function buildImportLink({ port, models, name = "Our Free Model", limit = LINK_MODEL_LIMIT }) {
  const ids = (Array.isArray(models) ? models : [])
    .map((row) => (typeof row === "string" ? row : row && row.id))
    .filter((id) => typeof id === "string" && id !== "");
  const unique = [...new Set(ids)];
  const wanted = Number.isFinite(Number(limit)) ? Number(limit) : LINK_MODEL_LIMIT;
  const cap = Math.max(1, Math.min(60, wanted));
  const included = unique.slice(0, cap);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const apiKey = "ofm-bridge";
  const query = new URLSearchParams({
    type: "openai",
    name,
    baseUrl,
    apiKey,
    model: included[0] ?? "",
    models: included.join(","),
  });
  return {
    link: `notrat://import-ai?${query.toString()}`,
    json: { name, type: "openai", baseUrl, apiKey, models: included },
    baseUrl,
    apiKey,
    includedModels: included.length,
    truncated: unique.length > included.length,
    totalModels: unique.length,
  };
}

/* ── 工具实现 ──────────────────────────────────────────────────── */

const TOOLS = {
  async ofm_provider_link(args = {}) {
    const state = await engine.start();
    const gateway = await engine.gateway().catch(() => null);
    const models = Array.isArray(gateway?.value?.models) ? gateway.value.models : [];
    const rawName = String(args.name ?? "").trim();
    const name = rawName === "" ? "Our Free Model" : rawName.slice(0, 60);
    const built = buildImportLink({ port: state.bridgePort, models, name, limit: args.limit });
    return {
      ...built,
      sealed: "apiKey 是占位口令 ofm-bridge；桥在出站时替换成上游真 key，所以真 key 不必写进这份配置。",
      how: [
        "点 link（或把它粘进浏览器地址栏 / 运行框）会拉起 Notrat，并弹出导入确认框。",
        "确认框里会列清服务商名、协议、地址、模型与打码后的 Key；点确认才落盘。",
        "已有同名或同地址的配置时，Notrat 会提示「覆盖导入」。",
        "如果链接毫无反应（协议未注册 / 开发版），把 json 贴到 设置 → AI → 导入 里。",
      ],
      fallbackJson: JSON.stringify(built.json, null, 2),
    };
  },

  async ofm_engine(args = {}) {
    const action = String(args.action ?? "info");
    if (action === "info") return engine.state();
    if (action === "start") return engine.start();
    if (action === "stop") return engine.stop();
    if (action === "restart") return engine.restart();
    if (action === "logs") return { lines: engine.logs.slice(-Math.max(1, Math.min(600, Number(args.lines ?? 80)))) };
    if (action === "close") {
      await engine.close();
      return { closed: true };
    }
    throw new Error(`未知 action：${action}（info | start | stop | restart | logs | close）`);
  },

  async ofm_status() {
    const state = await engine.state();
    if (!state.running) {
      return {
        running: false,
        bridgeUrl: state.bridgeUrl,
        upstreamVersion: state.upstreamVersion,
        dataDir: state.dataDir,
        hint: "引擎没在跑。调 ofm_engine action=start，或直接问用户是否要启动。",
      };
    }
    const summary = await engine.summary();
    const catalog = Array.isArray(summary?.catalog) ? summary.catalog : [];
    const routable = catalog.filter((row) => row.routable);
    const channels = summary?.channels ?? null;
    return {
      running: true,
      managed: state.managed,
      version: summary?.version ?? state.version,
      port: state.port,
      bridgeUrl: state.bridgeUrl,
      baseUrl: state.bridgeApiUrl,
      enabled: summary?.settings?.enabled !== false,
      modelCount: catalog.length,
      routableCount: routable.length,
      channels: channels ? { state: channels.state, error: channels.error || undefined } : null,
      eac: summary?.eacAuth ? { loggedIn: summary.eacAuth.loggedIn === true } : null,
      lan: summary?.lan ? { enabled: summary.lan.enabled === true, running: summary.lan.running === true, port: summary.lan.port ?? null } : null,
      catalogSyncedAt: summary?.catalogSyncedAt ?? 0,
      probedAt: summary?.probedAt ?? 0,
      dataDir: state.dataDir,
      keyMasked: maskKey(readEngineKey()),
    };
  },

  async ofm_wiring() {
    const state = await engine.start();
    const gateway = await engine.gateway().catch(() => null);
    const models = Array.isArray(gateway?.value?.models) ? gateway.value.models : [];
    const cfg = readConfig();
    const importLink = buildImportLink({ port: state.bridgePort, models });
    return {
      /** 桥地址是**固定的**，上游换端口不影响这里。 */
      baseUrl: `http://127.0.0.1:${state.bridgePort}/v1`,
      /** 占位口令即可：桥在出站时换成上游真 key，所以真 key 不必贴进配置。 */
      apiKey: "ofm-bridge",
      apiKeyNote: "任意非空字符串都行，桥会替换成真 key。",
      models: models.slice(0, 200).map((row) => ({
        id: row.id,
        name: row.name,
        contextWindow: row.context_window ?? row.contextWindow ?? null,
        vision: row.vision === true,
      })),
      modelCount: models.length,
      /** 一键导入链接：点一下，Notrat 自己弹确认框。 */
      link: importLink.link,
      /** 同一份配置的 JSON 形态，设置页「导入」可以直接粘贴。 */
      json: importLink.json,
      includedModels: importLink.includedModels,
      linkTruncated: importLink.truncated,
      enabled: gateway?.value?.enabled !== false,
      where: "Notrat 设置 → AI → 自定义服务商（OpenAI 兼容）",
      steps: [
        `Base URL 填 ${`http://127.0.0.1:${state.bridgePort}/v1`}`,
        "API Key 填 ofm-bridge（占位即可）",
        "模型名从上面 models[].id 里挑，或先点「获取模型列表」",
      ],
      bridgePort: state.bridgePort,
      enginePort: state.port,
      config: { enginePort: cfg.enginePort, bridgePort: cfg.bridgePort, autoStart: cfg.autoStart },
    };
  },

  async ofm_models(args = {}) {
    const refresh = args.refresh === true;
    const probe = args.probe === true;
    const rows = await engine.models({ refresh, probe });
    const normalized = rows.map((row) => ({
      id: row.id,
      name: row.name,
      channel: row.channel ?? "anonymous",
      routable: row.routable === true,
      vision: row.vision === true,
      reasoning: row.reasoning === true,
      contextWindow: row.contextWindow ?? null,
      maxOutput: row.maxOutput ?? null,
      availability: row.availability ?? null,
    }));
    const onlyRoutable = args.onlyRoutable === true || args.only_routable === true;
    const list = onlyRoutable ? normalized.filter((row) => row.routable) : normalized;
    return {
      total: normalized.length,
      routable: normalized.filter((row) => row.routable).length,
      channels: [...new Set(normalized.map((row) => row.channel))],
      models: list.slice(0, Math.max(1, Math.min(500, Number(args.limit ?? 200)))),
      truncated: list.length > Number(args.limit ?? 200),
    };
  },

  async ofm_model_test(args = {}) {
    const model = String(args.model ?? "").trim();
    if (model === "") throw new Error("需要 model（模型 id，见 ofm_models）");
    return engine.modelTest(model);
  },

  async ofm_settings(args = {}) {
    const patch = args.patch;
    if (patch && typeof patch === "object") {
      const result = await engine.patchSettings(patch);
      return { saved: true, settings: result?.settings ?? null };
    }
    const summary = await engine.summary();
    return { settings: summary?.settings ?? null };
  },

  async ofm_key(args = {}) {
    const action = String(args.action ?? "show");
    if (action === "rotate") {
      const result = await engine.rotateKey();
      return { rotated: true, keyMasked: maskKey(result?.key ?? "") };
    }
    const summary = await engine.summary().catch(() => null);
    return {
      keyMasked: maskKey(readEngineKey()),
      keyFile: summary?.dataDir ? `${summary.dataDir}\\settings.json` : null,
      note: "明文 key 只存在上游 settings.json 里，插件不回传它；桥在出站时自动注入。",
    };
  },

  async ofm_channels(args = {}) {
    const method = typeof args.method === "string" ? args.method : "";
    if (method !== "") return engine.channelsRpc(method, args.payload ?? {});
    const summary = await engine.summary();
    const gateway = await engine.gateway().catch(() => null);
    return {
      channels: summary?.channels ?? null,
      gateway: gateway?.value
        ? {
            enabled: gateway.value.enabled,
            running: gateway.value.running,
            address: gateway.value.address,
            models: Array.isArray(gateway.value.models) ? gateway.value.models.length : 0,
          }
        : null,
      eac: summary?.eacAuth ?? null,
    };
  },

  async ofm_stats() {
    return engine.stats();
  },

  async ofm_eac(args = {}) {
    const route = String(args.route ?? "/status");
    const withSlash = route.startsWith("/") ? route : `/${route}`;
    return engine.eac(withSlash, { method: args.method === "POST" ? "POST" : "GET" });
  },

  async ofm_ui() {
    const state = await engine.start();
    return {
      panelUrl: `http://127.0.0.1:${state.bridgePort}/`,
      loginUrl: state.loginUrl,
      note: "panelUrl 是桥里的管理界面（面板 iframe 用这个）；loginUrl 是一次性登录直链，10 分钟内有效。",
    };
  },

  async ofm_config(args = {}) {
    if (args.patch && typeof args.patch === "object") {
      const patch = {};
      for (const key of ["enginePort", "bridgePort", "autoStart", "openUiInBrowser"]) {
        if (args.patch[key] !== undefined) patch[key] = args.patch[key];
      }
      const next = writeConfig(patch);
      return { saved: true, config: next, note: "端口改动需要 ofm_engine action=restart 才生效（bridgePort 还需要重载插件）。" };
    }
    return { config: readConfig(), upstreamVersion: upstreamVersion() };
  },
};

/* ── 工具清单 ──────────────────────────────────────────────────── */

const TOOL_DEFS = [
  {
    name: "ofm_engine",
    description:
      "引擎（本地 upstream 服务）生命周期。action: info | start | stop | restart | logs | close。info 也会顺手报告 running/port/bridgeUrl/keyMasked。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["info", "start", "stop", "restart", "logs", "close"] },
        lines: { type: "number", description: "action=logs 时返回多少行，默认 80" },
      },
    },
  },
  {
    name: "ofm_status",
    description: "总览：是否运行、模型数、可用模型数、渠道状态、EAC 登录态、LAN 中继。不启动引擎，只读。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ofm_wiring",
    description:
      "取接入 Notrat 自定义服务商的三件套（baseUrl / apiKey 占位 / 模型 id 列表）。baseUrl 固定指向本机桥，上游换端口也不变。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ofm_provider_link",
    description:
      "生成一键接入 Notrat 的导入链接（notrat://import-ai?…）与等价 JSON。用户说「怎么接进来 / 一键接入 / 配到 Notrat」时调它，然后把 link 给用户点（或你自己用系统打开），不要手抄 baseUrl。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "服务商显示名，默认 Our Free Model" },
        limit: { type: "number", description: `链接里带多少个模型 id，默认 ${LINK_MODEL_LIMIT}` },
      },
    },
  },
  {
    name: "ofm_models",
    description: "列模型目录。refresh=true 先从上游重新拉目录（可能几十秒）；probe=true 额外做可用性探测（会发真实请求）。",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean" },
        probe: { type: "boolean" },
        onlyRoutable: { type: "boolean", description: "只返回当前可路由的模型" },
        limit: { type: "number", description: "最多返回多少条，默认 200" },
      },
    },
  },
  {
    name: "ofm_model_test",
    description: "对单个模型发一次真实推理测试，返回上游结论。会消耗额度。",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "模型 id（见 ofm_models）" } },
      required: ["model"],
    },
  },
  {
    name: "ofm_settings",
    description: "读或改上游设置（上游白名单字段）。不传 patch 就是读。",
    inputSchema: {
      type: "object",
      properties: { patch: { type: "object", description: "要改的设置字段，例如 { enabled: true }" } },
    },
  },
  {
    name: "ofm_key",
    description: "查看（打码）/ 轮换上游 API Key。明文 key 永不回传——桥在出站时自动注入。",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["show", "rotate"] } },
    },
  },
  {
    name: "ofm_channels",
    description: "渠道状态，或直接向渠道运行时发 RPC（method+payload）。不传 method 时只报状态。",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        payload: { type: "object" },
      },
    },
  },
  {
    name: "ofm_stats",
    description: "用量统计（按天、按模型）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ofm_eac",
    description: "桌面端 EAC 协付渠道：route 取 /status、/pool、/login/start、/login/cancel、/logout（后三个用 method=POST）。",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
      },
    },
  },
  {
    name: "ofm_ui",
    description: "取管理界面的两个地址：panelUrl（桥里的界面，面板 iframe 用）与 loginUrl（一次性登录直链）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ofm_config",
    description: "本插件自己的配置（enginePort / bridgePort / autoStart）。不传 patch 就是读。",
    inputSchema: { type: "object", properties: { patch: { type: "object" } } },
  },
];

/* ── JSON-RPC 分发 ─────────────────────────────────────────────── */

async function callTool(name, args) {
  const handler = TOOLS[name];
  if (!handler) return fail(new Error(`未知工具：${name}`));
  try {
    return ok(await handler(args ?? {}));
  } catch (error) {
    logger.warn(`tool ${name} 失败：${error?.message ?? error}`);
    return fail(error);
  }
}

async function dispatch(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } };
  }
  if (method === "tools/call") {
    const name = params?.name;
    const result = await callTool(name, params?.arguments);
    return { jsonrpc: "2.0", id, result };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return null;
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `未实现的方法：${method}` } };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    return;
  }
  void dispatch(message)
    .then((reply) => {
      if (reply) send(reply);
    })
    .catch((error) => {
      send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } });
    });
});

/* 开局：把桥挂上（面板要在引擎还没起来时也能拿到地址），引擎按配置自动拉起。 */
void (async () => {
  try {
    await engine.ensureBridge();
    logger.info(`bridge ready at ${engine.bridge?.url ?? "(未就绪)"}`);
  } catch (error) {
    logger.error(`bridge 起不来：${error?.message ?? error}`);
  }
  const cfg = readConfig();
  if (cfg.autoStart) {
    try {
      const state = await engine.start();
      logger.info(
        state.running
          ? `engine ready port=${state.port} upstream=${state.version}`
          : "engine 未运行",
      );
    } catch (error) {
      logger.warn(`engine 自动启动失败：${error?.message ?? error}`);
    }
  } else {
    logger.info("autoStart=false，引擎需手动 ofm_engine action=start");
  }
})();

/* 退出时把自己的子进程收干净（Windows 上父进程退出不会带走子进程）。 */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    void engine.close().finally(() => process.exit(0));
  });
}
process.on("exit", () => {
  try {
    engine.child?.kill();
  } catch {
    /* ignore */
  }
});

logger.info(`MCP server ready (${PREFIX} → upstream, plugin v${SERVER_INFO.version})`);
