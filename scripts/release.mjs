import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";

function run(command, options = {}) {
  return execSync(command, {
    stdio: options.silent ? "pipe" : "inherit",
    encoding: "utf-8",
    ...options
  });
}

function runOutput(command) {
  return execSync(command, { encoding: "utf-8" }).trim();
}

function printHelp() {
  console.log(`
DeepSeek Harness Desktop - 发版工具

用法:
  .\release.bat [patch|minor|major|<版本号>] [选项]

选项:
  --dry-run       演练模式，仅检查和打印计划，不修改文件和 git 状态
  --no-push       仅在本地修改 package.json、提交并打 Tag，不推送到 GitHub
  --skip-tests    跳过类型检查和单测验证
  --help, -h      显示帮助信息

示例:
  .\release.bat             (默认 patch 递增: 如 0.1.58 -> 0.1.59)
  .\release.bat minor       (minor 递增: 如 0.1.58 -> 0.2.0)
  .\release.bat 0.1.59      (指定具体版本号)
  .\release.bat --dry-run   (演练预览)
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const isDryRun = args.includes("--dry-run");
const noPush = args.includes("--no-push");
const skipTests = args.includes("--skip-tests");
const targetArg = args.find((a) => !a.startsWith("--"));

// 1. 检查 Git 状态与分支
let currentBranch = "";
try {
  currentBranch = runOutput("git branch --show-current");
} catch (e) {
  console.error("[ERROR] 无法获取当前 Git 分支。");
  process.exit(1);
}

if (!currentBranch) {
  console.error("[ERROR] 当前处于分离 HEAD 状态，请切换至具体分支后再发版。");
  process.exit(1);
}

console.log(`[1/6] 当前分支: ${currentBranch}`);

// 检查工作区跟踪文件状态
const status = runOutput("git status --porcelain -uno");
if (status) {
  console.error("[ERROR] 检测到工作区存在未提交的更改，请先提交或 stash：");
  console.error(status);
  process.exit(1);
}

// 2. 计算目标版本
const pkgPath = path.resolve("package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const currentVersion = pkg.version;

let newVersion = "";
const bumpType = (targetArg || "patch").toLowerCase();

if (["patch", "minor", "major"].includes(bumpType)) {
  newVersion = semver.inc(currentVersion, bumpType);
} else if (semver.valid(bumpType)) {
  newVersion = semver.clean(bumpType);
} else {
  console.error(`[ERROR] 无效的版本或增量类型: "${targetArg}"。支持 patch, minor, major 或合法的 semver 版本号。`);
  process.exit(1);
}

if (!newVersion || semver.lte(newVersion, currentVersion)) {
  console.error(`[ERROR] 目标版本 ${newVersion} 必须大于当前版本 ${currentVersion}。`);
  process.exit(1);
}

const shellTag = `shell-v${newVersion}`;
console.log(`[2/6] 版本规划: ${currentVersion} -> ${newVersion} (Tag: ${shellTag})`);

if (isDryRun) {
  console.log("[DRY-RUN] 演练模式结束，未对文件或 Git 做出更改。");
  process.exit(0);
}

// 3. 执行验证 (tsc & vitest)
if (skipTests) {
  console.log("[3/6] 跳过静态检查与单测 (--skip-tests)");
} else {
  console.log("[3/6] 执行类型检查与单元测试...");
  try {
    run("npx tsc --noEmit", { env: { ...process.env, CI: "true" } });
    run("npx vitest run", { env: { ...process.env, CI: "true" } });
    console.log("      验证全部通过！");
  } catch (e) {
    console.error("[ERROR] 校验或测试未通过，已终止发版流程。");
    process.exit(1);
  }
}

// 4. 更新 package.json
console.log(`[4/6] 更新 package.json 版本为 ${newVersion}...`);
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

// 5. Git 提交与打 Tag
console.log(`[5/6] 提交版本更新并打标签 ${shellTag}...`);
try {
  run(`git add package.json`);
  run(`git commit -m "chore: bump version to ${newVersion}"`);
  run(`git tag -f "${shellTag}"`);
} catch (e) {
  console.error("[ERROR] Git 提交或打标签失败。");
  process.exit(1);
}

// 6. 推送远端
if (noPush) {
  console.log(`[6/6] 跳过推送到远端 (--no-push)。本地已完成提交和打标: ${shellTag}`);
} else {
  console.log(`[6/6] 推送分支与标签到远端 origin...`);
  try {
    run(`git push origin ${currentBranch}`);
    run(`git push origin "${shellTag}"`);
    console.log("==============================================================================");
    console.log(`[SUCCESS] 版本发布成功！`);
    console.log(`  - 发布版本: ${newVersion}`);
    console.log(`  - Git 标签: ${shellTag}`);
    console.log(`  - GitHub Actions 已自动触发: Build Shell`);
    console.log("==============================================================================");
  } catch (e) {
    console.error("[ERROR] 推送到远程 origin 失败，请检查网络或 Git 权限。");
    process.exit(1);
  }
}
