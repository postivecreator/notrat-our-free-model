/**
 * env —— 路径、端口与配置（本插件唯一的"真相来源"）
 * =================================================
 *
 * 三个目录必须分清，混了就会出问题：
 *
 *   DATA_DIR    ~/.notrat/plugins/data/notrat-our-free-model/
 *               本插件的家：config.json、engine.log、engine.pid。
 *   ENGINE_DIR  <DATA_DIR>/engine/
 *               上游 standalone 的 OFM_HOME —— 它自己的 settings.json、
 *               账号凭据、统计与 service.lock 全落在这里。**不要**让它去写
 *               ~/.our-free-model，那是别人的地盘。
 *   upstream/   随插件分发的上游代码（vendor-sync.mjs 负责刷新）。
 *
 * 端口分两个，职责不同：
 *
 *   enginePort  上游自己的监听端口（默认 18900，被占用时上游会自己换一个，
 *               并把实际端口写回 settings.json 的 standalonePort）。
 *   bridgePort  本插件的桥（默认 8132）。**固定**，重载 Notrat 也不会变，
 *               因为面板 iframe 和 Notrat 的自定义服务商都钉在这个地址上。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "notrat-our-free-model";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 插件根目录（server/ 的上一层）。 */
export const PLUGIN_DIR = path.resolve(HERE, "..");

/** 上游代码根。 */
export const UPSTREAM_DIR = path.join(HERE, "upstream");

/** 上游 standalone 的 CLI 入口。 */
export const CLI_PATH = path.join(UPSTREAM_DIR, "packages", "standalone", "cli.mjs");

const NOTRAT_HOME = path.join(os.homedir(), ".notrat");

/** 本插件数据根。`NOTRAT_OFM_HOME` 覆盖（自检与多实例用）。 */
export const DATA_DIR = process.env.NOTRAT_OFM_HOME
  ? path.resolve(process.env.NOTRAT_OFM_HOME)
  : path.join(NOTRAT_HOME, "plugins", "data", PLUGIN_ID);

/** 上游的家（OFM_HOME）。 */
export const ENGINE_DIR = path.join(DATA_DIR, "engine");

export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const LOG_FILE = path.join(DATA_DIR, "engine.log");
export const PID_FILE = path.join(DATA_DIR, "engine.pid");

/** 上游自己的设置文件（forwardKey / standalonePort / enabled 都在里面）。 */
export const ENGINE_SETTINGS_FILE = path.join(ENGINE_DIR, "settings.json");

/** 上游 service.lock —— 只有它写着谁占着这个数据目录。 */
export const LOCK_FILE = path.join(ENGINE_DIR, "service.lock");

for (const dir of [DATA_DIR, ENGINE_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来时让后续写入自行报错 */
  }
}

/** 默认配置。改端口就改这里，其它地方都读它。 */
export const DEFAULT_CONFIG = {
  /** 上游监听端口。被占用时上游会自己换，实际端口见 info().port。 */
  enginePort: 18900,
  /** 桥端口。固定，别改——面板与自定义服务商都钉在这里。 */
  bridgePort: 8132,
  /** MCP server 一起来就把引擎拉起来。 */
  autoStart: true,
  /** 面板里点「打开管理页」时，是否顺带在系统浏览器里打开一份。 */
  openUiInBrowser: false,
  /** 引擎 stderr 落盘上限（字节），超过就截断重开。 */
  logMaxBytes: 2 * 1024 * 1024,
};

/**
 * 读配置。优先级：环境变量 > config.json > 默认值。
 *
 * 环境变量这一层不是给日常用的，是给**自检与多实例**用的：Notrat 跑起来之后
 * 8132 / 18900 已经被真插件占住，测试再想跑就得换一套端口，否则只会撞
 * EADDRINUSE —— 而那种失败看起来像 bug，其实只是测试没隔离。
 */
export function readConfig() {
  let file = {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (raw && typeof raw === "object") file = raw;
  } catch {
    /* 没配置过就用默认值 */
  }
  const merged = { ...DEFAULT_CONFIG, ...file };
  const envPorts = { enginePort: "NOTRAT_OFM_ENGINE_PORT", bridgePort: "NOTRAT_OFM_BRIDGE_PORT" };
  for (const [key, envName] of Object.entries(envPorts)) {
    const raw = process.env[envName];
    if (raw === undefined || String(raw).trim() === "") continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0 && value <= 65535) merged[key] = value;
  }
  const auto = process.env.NOTRAT_OFM_AUTOSTART;
  if (auto === "0" || auto === "false") merged.autoStart = false;
  if (auto === "1" || auto === "true") merged.autoStart = true;
  return merged;
}

export function writeConfig(patch) {
  const merged = { ...readConfig(), ...(patch && typeof patch === "object" ? patch : {}) };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

/** 上游 settings.json 的只读快照。未首次启动过时返回 {}。 */
export function readEngineSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(ENGINE_SETTINGS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 从上游 settings.json 里取 API Key。
 *
 * 这是唯一不经过 HTTP 就能拿到 key 的路径，启动早期（上游还没响应之前）用。
 * **永远不要把它写进日志或返回值**——出口统一走 maskKey()。
 */
export function readEngineKey() {
  const settings = readEngineSettings();
  return typeof settings.forwardKey === "string" ? settings.forwardKey : "";
}

/** 只露头尾，中间永远打码。 */
export function maskKey(key) {
  const value = String(key ?? "");
  if (value === "") return "";
  if (value.length <= 12) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/** 上游清单里的版本号（upstream/packages/standalone/package.json）。 */
export function upstreamVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(UPSTREAM_DIR, "packages", "standalone", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

/** 本插件清单（manifest.json），面板与 MCP 都用它报版本。 */
export function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  } catch {
    return {};
  }
}
