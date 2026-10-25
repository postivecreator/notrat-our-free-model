#!/usr/bin/env node
/**
 * notrat-our-free-model 安装 / 更新 / 卸载器
 *
 *   node install.mjs              # 安装或原地更新到 ~/.notrat/plugins/notrat-our-free-model/
 *   node install.mjs --uninstall  # 卸载（不删数据目录）
 *   node install.mjs --to <dir>   # 指定目标根目录
 *   node install.mjs --dry-run    # 只打印计划
 *
 * 三条规矩，跟前几个插件一致：
 *
 *   1) **manifest.json 必须最后落盘** —— 它是宿主的「安装信号」。提前落盘会在
 *      server 脚本还没就位时被 chokidar 抓到 → 启动失败。
 *   2) **更新原地覆盖，不要 rm -rf 再拷** —— 插件加载后目录会被运行中的
 *      MCP server 进程占住（Windows 上 rmdir 直接 EBUSY）。
 *   3) **同一个 id 不要同时存在单文件包** —— 安装前检测并提示。
 *
 * 卸载只删插件本体，`~/.notrat/plugins/data/notrat-our-free-model/`（账号、
 * 设置、用量、日志）保持原样——那是用户数据，重装要能接上。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = "notrat-our-free-model";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
};

const TARGET_ROOT = path.resolve(val("--to", path.join(os.homedir(), ".notrat", "plugins")));
const TARGET = path.join(TARGET_ROOT, ID);
const SINGLE_FILE = path.join(TARGET_ROOT, `${ID}.json`);
const DATA_DIR = path.join(TARGET_ROOT, "data", ID);

/** 随插件分发的东西。`server/upstream` 是上游运行闭包，必须带上。 */
const INCLUDE = ["manifest.json", "package.json", "README.md", "icon.svg", "server", "panels", "scripts", "tests", "install.mjs"];
const SKIP_NAMES = new Set(["node_modules", ".git", ".DS_Store", "VENDOR.json.bak"]);

/** manifest.json 单独最后拷贝——它是安装信号。 */
const LAST = "manifest.json";

function walk(dir, base = dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, files);
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files;
}

function collect() {
  const files = [];
  for (const entry of INCLUDE) {
    const full = path.join(HERE, entry);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) files.push(...walk(full, HERE));
    else files.push(entry);
  }
  return files.filter((file) => !file.endsWith(".bak"));
}

function copyOne(relative) {
  const from = path.join(HERE, relative);
  const to = path.join(TARGET, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function removeSingleFile() {
  if (!fs.existsSync(SINGLE_FILE)) return;
  const backup = `${SINGLE_FILE}.bak`;
  fs.renameSync(SINGLE_FILE, backup);
  console.log(`⚠️  发现同名单文件包，已改名为 ${path.basename(backup)}（目录包与单文件包同 id 会冲突）`);
}

function install({ dryRun }) {
  const files = collect();
  const ordered = files.filter((file) => path.basename(file) !== LAST);
  const last = files.filter((file) => path.basename(file) === LAST);

  console.log(`源：${HERE}`);
  console.log(`目标：${TARGET}`);
  console.log(`文件：${files.length} 个（其中 ${last.length} 个最后落盘）`);

  if (dryRun) {
    for (const file of [...ordered, ...last]) console.log(`  · ${file}`);
    console.log("\n--dry-run：没有写任何东西。");
    return;
  }

  removeSingleFile();
  fs.mkdirSync(TARGET, { recursive: true });
  for (const file of ordered) copyOne(file);
  // 安装信号最后落盘：宿主看到 manifest.json 就开始加载，此时脚本已全部就位。
  for (const file of last) copyOne(file);

  console.log("\n✅ 安装完成。");
  console.log("   · 数据目录（账号 / 设置 / 用量 / 日志）：", DATA_DIR);
  console.log("   · 桥端口 8132（上游默认 18900，被占用时上游会自己换）");
  console.log("   · 打开 Notrat → 状态栏「插件箱」→ 🆓 模型池，点「启动」即可。");
  console.log("   · 接成服务商：设置 → AI → 自定义服务商（OpenAI 兼容）");
  console.log("       Base URL: http://127.0.0.1:8132/v1    API Key: ofm-bridge（占位即可）");
}

function uninstall() {
  if (!fs.existsSync(TARGET)) {
    console.log(`没装：${TARGET}`);
    return;
  }
  // 运行中的 MCP server 会占住目录（Windows EBUSY）。先提示，再尽量删。
  fs.rmSync(TARGET, { recursive: true, force: true });
  console.log(`✅ 已删除 ${TARGET}`);
  if (fs.existsSync(DATA_DIR)) {
    console.log(`   · 数据目录保留：${DATA_DIR}（要一并清掉就手动删）`);
  }
  console.log("   · 已接进「自定义服务商」的配置不会自动消失，自行删掉那一项即可。");
}

if (flag("--uninstall")) uninstall();
else install({ dryRun: flag("--dry-run") });
