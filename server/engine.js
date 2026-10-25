/**
 * engine —— 上游 standalone 服务的生命周期 + 管理 API 客户端
 * =========================================================
 *
 * 上游有三张皮：DSH 插件（cordis，index.js）、独立本地服务
 * （packages/standalone/cli.mjs）、Windows 桌面壳。**这里用中间那张**：
 *
 *   · 它不加载 cordis、不读 DSH 凭据、不启动自更新器 —— 移植面最小；
 *   · 它自己就是一个「监听端口 + /v1 推理 + /api/management 管理」的进程，
 *     正好是 Notrat 需要的东西（自定义服务商 + 面板）；
 *   · 它把状态锁在 OFM_HOME 下，我们指到插件数据目录就不会越界写
 *     ~/.our-free-model。
 *
 * 所以本模块不做代码级移植，只做**进程级托管**：
 *
 *   拉起 → 读握手（实际端口 / key）→ 起桥 → 供 MCP 工具与面板取数。
 *
 * 生命周期只有两条纪律：
 *   1. 同一数据目录只许一个实例（上游自己用 service.lock 保证）。
 *      所以要"先探活、再启动"，不能无脑 spawn —— 否则插件重载一次就撞锁。
 *   2. 退出时把自己的子进程收干净（Windows 上父进程退出不会带走子进程）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  CLI_PATH,
  ENGINE_DIR,
  LOG_FILE,
  PID_FILE,
  PLUGIN_DIR,
  UPSTREAM_DIR,
  maskKey,
  readConfig,
  readEngineKey,
  readEngineSettings,
  upstreamVersion,
} from "./env.js";
import { startBridge } from "./bridge.js";

const PRODUCT = "our-free-model-standalone";
const PREFIX = "/api/management";
const MAX_LOG_LINES = 600;
const START_TIMEOUT_MS = 30_000;

/* ─────────────────────────── 单次 HTTP ─────────────────────────── */

/**
 * 打上游端口上的一个路径。
 *
 * 管理面要带同源栅栏所需的两只头（Origin / Referer）与 Bearer key ——
 * 这正是 trust.js 认的那一套；推理面保持原样。
 */
function httpJson(port, pathname, { method = "GET", body, timeout = 20_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const origin = `http://127.0.0.1:${port}`;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        timeout,
        headers: {
          origin,
          referer: `${origin}/`,
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text === "" ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`请求上游超时（${pathname}）`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 探一个端口上是不是"我们这家的"上游。 */
async function probe(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const res = await httpJson(port, "/health", { timeout: 1200 });
    if (res.status !== 200 || res.json?.ok !== true) return null;
    if (res.json.service === PRODUCT || res.json.product === PRODUCT) return res.json;
    return null;
    return null;
  } catch {
    return null;
  }
}

/** 读本插件数据目录里的 service.lock，认出占用它的进程。 */
function readLockOwner() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'service.lock'), 'utf8'));
    if (raw?.product !== PRODUCT) return null;
    if (!Number.isSafeInteger(raw?.pid) || raw.pid <= 0) return null;
    return { pid: raw.pid, token: raw.token };
  } catch {
    return null;
  }
}

/* ─────────────────────────── 引擎 ─────────────────────────── */

export class OfmEngine {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    /** 我们亲手拉起的子进程；attach 到既有实例时为 null。 */
    this.child = null;
    /** 上游当前端口（握手或探活得来）。 */
    this.port = null;
    /** 一次性登录地址（只在本次 spawn 的握手里出现）。 */
    this.uiUrl = null;
    this.bridge = null;
    this.bridgeStarting = null;
    this.starting = null;
    this.logs = [];
  }

  /* ── 日志：只进内存环形缓冲 + 文件，绝不进 stdout ──────────── */

  push(line) {
    const text = String(line ?? "").replace(/\r$/, "");
    if (text === "") return;
    this.logs.push(text);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    try {
      const cfg = readConfig();
      const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
      if (stat && stat.size > cfg.logMaxBytes) fs.writeFileSync(LOG_FILE, "", "utf8");
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`, "utf8");
    } catch {
      /* 落盘失败不该影响引擎 */
    }
  }

  /* ── 桥 ──────────────────────────────────────────────────── */

  async ensureBridge() {
    if (this.bridge) return this.bridge;
    if (this.bridgeStarting) return this.bridgeStarting;
    const cfg = readConfig();
    this.bridgeStarting = (async () => {
      try {
        this.bridge = await startBridge({
          port: cfg.bridgePort,
          getTargetPort: () => this.port,
          getKey: () => readEngineKey(),
          log: (line) => this.push(`[bridge] ${line}`),
        });
        return this.bridge;
      } catch (error) {
        // 端口被占：先看看是不是上一轮没散干净的自己人。
        const alive = await probe(cfg.bridgePort);
        if (alive) return null;
        this.push(`[bridge] 起桥失败（端口 ${cfg.bridgePort}）：${error?.message ?? error}`);
        throw error;
      } finally {
        this.bridgeStarting = null;
      }
    })();
    return this.bridgeStarting;
  }

  /* ── 状态 ────────────────────────────────────────────────── */

  async state() {
    const cfg = readConfig();
    const settings = readEngineSettings();
    // 已知端口：我们自己握到手的最优先，其次是上游写回 settings 的实际端口。
    const candidates = [this.port, settings.standalonePort, cfg.enginePort].filter(
      (value, index, arr) => Number.isInteger(value) && value > 0 && arr.indexOf(value) === index,
    );
    for (const candidate of candidates) {
      const health = await probe(candidate);
      if (health) {
        this.port = candidate;
        await this.ensureBridge();
        const key = readEngineKey();
        return {
          running: true,
          managed: this.child !== null,
          pid: this.child?.pid ?? null,
          port: candidate,
          bridgePort: this.bridge?.port ?? cfg.bridgePort,
          bridgeUrl: this.bridge?.url ?? `http://127.0.0.1:${cfg.bridgePort}`,
          baseUrl: `http://127.0.0.1:${candidate}/v1`,
          bridgeApiUrl: `http://127.0.0.1:${this.bridge?.port ?? cfg.bridgePort}/v1`,
          uiUrl: `http://127.0.0.1:${this.bridge?.port ?? cfg.bridgePort}/`,
          loginUrl: this.uiUrl,
          keyMasked: maskKey(key),
          hasKey: key !== "",
          version: health.version ?? "",
          upstreamVersion: upstreamVersion(),
          enabled: settings.enabled !== false,
          dataDir: ENGINE_DIR,
          autoStart: cfg.autoStart,
        };
      }
    }
    // 探不到就等于没跑：别把旧端口留在 this.port 上，否则桥会一直往一个死端口转发。
    this.port = null;
    await this.ensureBridge();
    const key = readEngineKey();
    return {
      running: false,
      managed: this.child !== null,
      pid: this.child?.pid ?? null,
      port: null,
      bridgePort: this.bridge?.port ?? cfg.bridgePort,
      bridgeUrl: this.bridge?.url ?? `http://127.0.0.1:${cfg.bridgePort}`,
      baseUrl: "",
      bridgeApiUrl: `http://127.0.0.1:${this.bridge?.port ?? cfg.bridgePort}/v1`,
      uiUrl: `http://127.0.0.1:${this.bridge?.port ?? cfg.bridgePort}/`,
      loginUrl: this.uiUrl,
      keyMasked: maskKey(key),
      hasKey: key !== "",
      version: "",
      upstreamVersion: upstreamVersion(),
      enabled: settings.enabled !== false,
      dataDir: ENGINE_DIR,
      autoStart: cfg.autoStart,
    };
  }

  /* ── 启动 ────────────────────────────────────────────────── */

  async ensure() {
    if (this.starting) return this.starting;
    const current = await this.state();
    if (current.running) return current;
    return this.start();
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.#doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #doStart() {
    const existing = await this.state();
    if (existing.running) return existing;

    const cfg = readConfig();
    this.push(`[engine] 启动 ${PRODUCT}（port=${cfg.enginePort}）`);

    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`上游入口不存在：${CLI_PATH}（先跑 node scripts/vendor-sync.mjs）`);
    }

    const child = spawn(
      process.execPath,
      [CLI_PATH, "--data-dir", ENGINE_DIR, "--port", String(cfg.enginePort)],
      {
        cwd: UPSTREAM_DIR,
        env: { ...process.env, OFM_HOME: ENGINE_DIR, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;

    try {
      fs.writeFileSync(PID_FILE, String(child.pid ?? ""), "utf8");
    } catch {
      /* 记不下 pid 只是少了点信息 */
    }

    /* 握手解析：上游把实际端口写在 stdout 上（`API：…/v1`）。
       只认这一行，不猜端口 —— 端口冲突时上游会自己换一个。 */
    const onLine = (stream, line) => {
      const text = String(line ?? "").trim();
      if (text === "") return;
      this.push(`[${stream}] ${text}`);
      const api = /API[：:]\s*(http:\/\/\S+?)\/v1/.exec(text);
      if (api) {
        try {
          const port = Number(new URL(api[1]).port);
          if (Number.isInteger(port) && port > 0 && port !== this.port) {
            this.port = port;
          }
        } catch {
          /* 解析失败就走探活兜底 */
        }
      }
      const ui = /(http:\/\/\S+#login=\S+)/.exec(text);
      if (ui) this.uiUrl = ui[1];
    };

    for (const [stream, readable] of [
      ["out", child.stdout],
      ["err", child.stderr],
    ]) {
      let buffer = "";
      readable.setEncoding("utf8");
      readable.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) onLine(stream, line);
      });
    }

    let exited = null;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      this.push(`[engine] 退出 code=${code} signal=${signal ?? ""}`);
      if (this.child === child) this.child = null;
      try {
        fs.rmSync(PID_FILE, { force: true });
      } catch {
        /* ignore */
      }
    });

    /* 等它真的能应答：优先握手给的实际端口，否则回落到配置端口。 */
    const deadline = Date.now() + START_TIMEOUT_MS;
    let health = null;
    while (Date.now() < deadline) {
      if (exited) break;
      for (const candidate of [this.port, cfg.enginePort].filter((v, i, a) => v && a.indexOf(v) === i)) {
        health = await probe(candidate);
        if (health) {
          this.port = candidate;
          break;
        }
      }
      if (health) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!health) {
      const tail = this.logs.slice(-12).join("\n");
      const reason = exited
        ? `上游启动后立即退出（code=${exited.code}）。`
        : `等了 ${START_TIMEOUT_MS / 1000}s 没等到上游应答。`;
      throw new Error(`${reason}\n常见原因：数据目录已被另一个服务占用（service.lock），或端口被占。\n最近日志：\n${tail}`);
    }

    this.push(`[engine] 就绪 http://127.0.0.1:${this.port}（${health.version ?? "?"}）`);
    await this.ensureBridge();
    return this.state();
  }

  /**
   * 停掉引擎。
   *
   * 两种来源都要停得掉，否则「停止」按钮会在最需要它的时候失灵：
   *   1. 本进程拉起的子进程 —— 直接 kill；
   *   2. **上一次 Notrat 退出时遗留的实例** —— 插件被关掉时子进程未必跟着走
   *      （Windows 上父进程退出不带走子进程），下次启动就会 attach 到它。
   *      这时我们不能杀「别人的」进程，只能杀**自己数据目录的那一个**：
   *      service.lock 里写着 { pid, product, token }，product 对上才动手。
   */
  async stop() {
    const child = this.child;
    if (child) {
      this.push('[engine] 停止（本进程拉起的子进程）');
      const done = new Promise((resolve) => child.once('exit', resolve));
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
      const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000));
      const result = await Promise.race([done, timeout]);
      if (result === 'timeout' && child.pid) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      this.child = null;
      this.port = null;
      this.uiUrl = null;
      const state = await this.state();
      return { ...state, stopped: true, how: 'child' };
    }

    // 走锁文件：只认自己数据目录、且 product 对得上的那一个。
    const owner = readLockOwner();
    if (owner) {
      this.push(`[engine] 停止（遗留实例 pid=${owner.pid}）`);
      try {
        process.kill(owner.pid);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          const state = await this.state();
          return { ...state, stopped: false, reason: `停不掉遗留实例（${error?.code ?? error?.message}）` };
        }
      }
      // 等它把端口放掉：探不到活才算停干净。
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const still = this.port ? await probe(this.port) : null;
        if (!still) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      this.port = null;
      this.uiUrl = null;
      const state = await this.state();
      return { ...state, stopped: state.running === false, how: 'lock' };
    }

    const state = await this.state();
    return { ...state, stopped: false, reason: state.running ? '实例不属于本插件的数据目录，未停止' : '本来就没跑' };
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  /* ── 管理 API ────────────────────────────────────────────── */

  async api(pathname, options = {}) {
    const state = await this.ensure();
    if (!state.running || !this.port) throw new Error("引擎未运行");
    const key = readEngineKey();
    const res = await httpJson(this.port, `${PREFIX}${pathname}`, {
      ...options,
      headers: key ? { authorization: `Bearer ${key}`, ...(options.headers ?? {}) } : options.headers,
    });
    if (res.status === 401) throw new Error("管理接口拒绝访问（API Key 不匹配，可能刚被轮换）");
    if (res.status >= 400) {
      throw new Error(res.json?.error ?? res.text?.slice(0, 300) ?? `上游返回 ${res.status}`);
    }
    return res.json;
  }

  summary() {
    return this.api("/summary");
  }

  stats() {
    return this.api("/stats");
  }

  /** gateway.getEnabled 一次给全：是否启用、端口、key、模型清单。 */
  gateway() {
    return this.api("/channels/rpc", { method: "POST", body: { method: "gateway.getEnabled" } });
  }

  async models({ refresh = false, probe: doProbe = false } = {}) {
    if (refresh) await this.api("/models/refresh", { method: "POST", body: { probe: doProbe }, timeout: 300_000 });
    const summary = await this.summary();
    return summary?.catalog ?? [];
  }

  modelTest(model) {
    return this.api("/models/test", { method: "POST", body: { model }, timeout: 330_000 });
  }

  patchSettings(patch) {
    return this.api("/settings", { method: "POST", body: patch });
  }

  channelsRpc(method, payload) {
    return this.api("/channels/rpc", { method: "POST", body: { method, payload } });
  }

  /** 上游真 key —— 只在 ofm_wiring includeSecret=true 时出口。 */
  rawKey() {
    return readEngineKey();
  }

  rotateKey() {
    return this.api("/key/rotate", { method: "POST", body: { confirm: true } });
  }

  lanKey() {
    return this.api("/lan/key");
  }

  rotateLanKey() {
    return this.api("/lan/key/rotate", { method: "POST", body: { confirm: true } });
  }

  eac(route, { method = "GET", query = "" } = {}) {
    return this.api(`/eac${route}${query}`, { method, body: method === "POST" ? {} : undefined, timeout: 60_000 });
  }

  /* ── 收尾 ────────────────────────────────────────────────── */

  async close() {
    try {
      await this.bridge?.close();
    } catch {
      /* ignore */
    }
    this.bridge = null;
    await this.stop().catch(() => {});
  }
}

export { PREFIX, PRODUCT, probe as probePort };
