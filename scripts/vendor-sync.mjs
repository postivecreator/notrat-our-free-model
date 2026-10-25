#!/usr/bin/env node
/**
 * vendor-sync.mjs —— 把上游的"独立本地服务"这一支刷进 server/upstream/
 * ==================================================================
 *
 * 上游仓库有三种皮：DSH 插件（cordis）、独立本地服务、Windows 桌面壳。
 * 本插件只用中间那张，因为它是唯一**不加载 cordis、不读 DSH 凭据、
 * 不启动自更新器**的入口 —— 移植面最小，行为最可预期。
 *
 * 所以这里复制的不是整个仓库，而是它的运行闭包：
 *
 *   src/                                 核心（零 npm 依赖，纯 node: 内建）
 *   packages/standalone/{cli,service,management,eac,login-terminal,open-external}.mjs
 *   packages/standalone/channels/        账号渠道运行时
 *   packages/standalone/web/             已构建好的管理界面（前端源码不复制）
 *   packages/standalone/package.json     service.mjs 从它读 VERSION
 *   LICENSE
 *
 * 不复制：client.js / index.js / adapter/ / packages/desktop / feed / worker /
 *        frontend/（前端源码，用不上已构建的 web/）/ vite.config / tsconfig。
 *
 * 用法：
 *   node scripts/vendor-sync.mjs                     # 用缓存里的上游（没有就下载）
 *   node scripts/vendor-sync.mjs --from D:\dsh       # 用本地已有的 checkout
 *   node scripts/vendor-sync.mjs --rev 2.5.9         # 指定 tag
 *   node scripts/vendor-sync.mjs --check             # 只比对，不写盘
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const DEST = path.join(PLUGIN_DIR, "server", "upstream");

const REPO = "Ebony-Vinyl/dsh-our-free-model";
const CACHE_ROOT = path.join(os.tmpdir(), "notrat-ofm-upstream");

/** 上游 standalone 里**不**随插件分发的东西（构建期/前端源码/文档）。 */
const STANDALONE_SKIP = new Set([
  "frontend",
  "vite.config.mjs",
  "tsconfig.json",
  "components.json",
  "package-lock.json",
  "README.md",
]);

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败（code=${result.status}）`);
}

/** 把上游取到本地：要么用户给的目录，要么下载一个 tarball 解开。 */
function materializeSource() {
  const from = argOf("from");
  if (from) {
    const dir = path.resolve(from);
    if (!fs.existsSync(path.join(dir, "packages", "standalone", "cli.mjs"))) {
      throw new Error(`${dir} 不像上游 checkout（找不到 packages/standalone/cli.mjs）`);
    }
    console.log(`来源：本地 ${dir}`);
    return { dir, revision: "local" };
  }

  const rev = argOf("rev") ?? "main";
  const target = path.join(CACHE_ROOT, rev === "main" ? "main" : `rev-${rev}`);
  const marker = path.join(target, "packages", "standalone", "cli.mjs");
  if (fs.existsSync(marker) && !hasFlag("refresh")) {
    console.log(`来源：缓存 ${target}`);
    return { dir: target, revision: rev };
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const ref = rev === "main" ? "refs/heads/main" : `refs/tags/${rev}`;
  const url = `https://codeload.github.com/${REPO}/tar.gz/${ref}`;
  const tarball = path.join(CACHE_ROOT, `${rev}.tar.gz`);
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  console.log(`下载 ${url}`);
  run("curl", ["-sSL", "--max-time", "180", "-o", tarball, url]);
  // Git Bash 自带 tar；Windows 10+ 也有 bsdtar。
  run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
  if (!fs.existsSync(marker)) throw new Error("解包后仍找不到 packages/standalone/cli.mjs，上游结构变了");
  return { dir: target, revision: rev };
}

function copyTree(source, dest, skip = new Set()) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

function fileCount(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? fileCount(path.join(dir, entry.name)) : 1;
  }
  return count;
}

/** 我们自己需要、上游没有的两个文件（不能靠复制）。 */
function writeOwnFiles() {
  // upstream/src/*.js 是 ESM，但上游根 package.json 的 type 不覆盖到这里；
  // 补一个 type:module 的 package.json，消掉每次启动的 MODULE_TYPELESS_PACKAGE_JSON 警告。
  fs.writeFileSync(
    path.join(DEST, "package.json"),
    `${JSON.stringify({ name: "ofm-upstream", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

function main() {
  const check = hasFlag("check");
  const { dir: source, revision } = materializeSource();

  const standaloneSource = path.join(source, "packages", "standalone");
  const standaloneVersion = JSON.parse(
    fs.readFileSync(path.join(standaloneSource, "package.json"), "utf8"),
  ).version;
  const rootVersion = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version;

  console.log(`上游版本：standalone ${standaloneVersion}（仓库 ${rootVersion}，${revision}）`);

  if (check) {
    const destVersion = fs.existsSync(path.join(DEST, "packages", "standalone", "package.json"))
      ? JSON.parse(fs.readFileSync(path.join(DEST, "packages", "standalone", "package.json"), "utf8")).version
      : "（无）";
    console.log(`已 vendored：${destVersion}`);
    if (destVersion !== standaloneVersion) {
      console.log(`\n落后了：${destVersion} → ${standaloneVersion}，跑 node scripts/vendor-sync.mjs 刷新。`);
      process.exitCode = 1;
    } else {
      console.log("\n已是最新。");
    }
    return;
  }

  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });

  const srcCount = copyTree(path.join(source, "src"), path.join(DEST, "src"));
  const standaloneCount = copyTree(standaloneSource, path.join(DEST, "packages", "standalone"), STANDALONE_SKIP);
  fs.copyFileSync(path.join(source, "LICENSE"), path.join(DEST, "LICENSE"));
  writeOwnFiles();

  fs.writeFileSync(
    path.join(DEST, "VENDOR.json"),
    `${JSON.stringify(
      {
        note: "由 scripts/vendor-sync.mjs 生成，勿手改。",
        repository: `https://github.com/${REPO}`,
        revision,
        versions: { upstream: rootVersion, standalone: standaloneVersion },
        entries: [
          "src/（核心，零 npm 依赖）",
          "packages/standalone/（独立本地服务：cli / service / management / eac / channels / web）",
          "LICENSE",
        ],
        excluded: [
          "index.js（cordis 插件入口，不用）",
          "client.js / adapter/（DSH 宿主壳，不用）",
          "packages/desktop/（Tauri 桌面壳，不用）",
          "packages/standalone/frontend/（前端源码，用已构建的 web/）",
          "feed/ worker/（自更新与公告，standalone 不加载）",
        ],
        files: { src: srcCount, standalone: standaloneCount },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const total = fileCount(DEST);
  console.log(`已刷入：src ${srcCount} 个文件，standalone ${standaloneCount} 个，合计 ${total} 个`);
  console.log(`目标：${DEST}`);
  console.log("\n跑一遍自检：node tests/_smoke.mjs");
}

main();
