#!/usr/bin/env node
/**
 * 打一个可分发的插件包。
 *
 *   node scripts/pack.mjs            # 用 package.json 的版本
 *   node scripts/pack.mjs --version   # 只打印版本号
 *
 * 用 `git archive` 而不是自行遍历目录，是为了让产物**恰好等于一次提交的内容**：
 *   - .gitignore 自动生效，node_modules / dist / 本地 settings.json 不会混进去；
 *   - 同一个 commit 反复打包得到逐字节相同的 zip（记录 sha256 便于比对）；
 *   - 无需引入 zip 依赖 —— GNU tar 不会造 zip，PowerShell 又只能在 Windows 跑。
 *
 * 代价：工作区必须已提交，未提交的改动不会进包（会明确提示）。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

if (process.argv.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
}

/* ── 前置检查：必须是 git 仓库，且工作区干净 ────────────────────── */
try {
  git(["rev-parse", "--is-inside-work-tree"]);
} catch {
  console.error("✗ 这不是 git 仓库。打包依赖 git archive，请先 git init 并提交。");
  process.exit(1);
}

const dirty = git(["status", "--porcelain"]).trim();
if (dirty) {
  console.error("✗ 工作区有未提交的改动，这些改动不会被包进去：\n");
  console.error(
    dirty
      .split("\n")
      .slice(0, 12)
      .map((l) => "    " + l)
      .join("\n"),
  );
  console.error("\n  先提交（或 stash）再打包，避免打出一个和源码不一致的包。");
  process.exit(1);
}

/* ── 打包 ──────────────────────────────────────────────────────── */
const name = pkg.name || "plugin";
const tag = `${name}-${pkg.version}`;
const outDir = path.join(ROOT, "dist");
fs.mkdirSync(outDir, { recursive: true });

const out = path.join(outDir, `${tag}.zip`);
fs.rmSync(out, { force: true });

/* --prefix 让解压后是一个同名目录，而不是散落一地。 */
git([
  "archive",
  "--format=zip",
  `--prefix=${name}/`,
  "-o",
  out,
  "HEAD",
]);

const buf = fs.readFileSync(out);
const sha = createHash("sha256").update(buf).digest("hex");

/* 数一下包里的文件，和仓库对照，避免「以为打了其实空包」。 */
const listed = git(["ls-files"]);
const fileCount = listed.split("\n").filter(Boolean).length;

console.log(`✓ ${path.relative(ROOT, out)}`);
console.log(`  版本      ${pkg.version}`);
console.log(`  提交      ${git(["rev-parse", "--short", "HEAD"]).trim()}`);
console.log(`  大小      ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  文件      ${fileCount} 个（git 跟踪）`);
console.log(`  sha256    ${sha}`);
console.log(`\n  解压后目录名：${name}/`);
