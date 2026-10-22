#!/usr/bin/env node
/**
 * 移动端开发环境自检（只读）：JDK / Android SDK / adb / NDK / Rust targets / Tauri Android 工程 / 设备与 AVD。
 * 用法：node scripts/check-mobile-env.mjs
 * 不修改任何环境，只打印检查结果与下一步命令。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const appDir = path.join(ROOT, "packages", "app");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "AppData", "Local", "Android", "Sdk");
const jdk = process.env.JAVA_HOME || path.join(ROOT, ".tools", "jdk-21.0.12.1+1");
const adb = path.join(sdk, "platform-tools", "adb.exe");
const ndkDir = path.join(sdk, "ndk");

const rows = [];
function add(name, ok, detail) { rows.push({ 检查项: name, 状态: ok ? "OK" : "缺", 详情: detail }); }

add("JDK", fs.existsSync(path.join(jdk, "bin", "java.exe")), jdk);
add("Android SDK", fs.existsSync(sdk), sdk);
add("adb", fs.existsSync(adb), adb);
const ndks = fs.existsSync(ndkDir) ? fs.readdirSync(ndkDir) : [];
add("NDK", ndks.length > 0, ndks.join(", ") || "未安装");
add("Gradle 工程", fs.existsSync(path.join(appDir, "src-tauri", "gen", "android", "gradlew.bat")), "packages/app/src-tauri/gen/android");
add("Tauri 配置", fs.existsSync(path.join(appDir, "src-tauri", "tauri.android.conf.json")), "tauri.android.conf.json");

let targets = "";
try {
  const r = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
  targets = (r.stdout || "").split(/\r?\n/).filter((t) => t.includes("android")).join(", ");
} catch {}
add("Rust Android targets", targets.length > 0, targets || "未安装");

let devices = "";
try {
  const r = spawnSync(adb, ["devices"], { encoding: "utf8" });
  devices = (r.stdout || "").split(/\r?\n/).filter((l) => l && !l.startsWith("List of")).join("; ");
} catch {}
add("已连接设备", devices.length > 0, devices || "未连接（用 USB 打开调试后重试）");

let avds = "";
try {
  const emulator = path.join(sdk, "emulator", "emulator.exe");
  if (fs.existsSync(emulator)) {
    const r = spawnSync(emulator, ["-list-avds"], { encoding: "utf8" });
    avds = (r.stdout || "").trim();
  }
} catch {}
add("模拟器 AVD", avds.length > 0, avds || "无（需要先装 system-image 并创建 AVD）");

console.table(rows);

const javaHome = jdk;
const ready = rows.filter((r) => r.状态 === "OK").length;
console.log("\n通过 " + ready + "/" + rows.length + " 项。");
console.log("提示：运行 Android 开发前先设置 JAVA_HOME=" + javaHome + "，并 adb reverse tcp:1420 tcp:1420（让手机访问电脑上的 dev server）。");
if (!devices) console.log("下一步：手机打开「开发者选项 → USB 调试」，连接后执行 adb devices，并在手机上点「允许 USB 调试」。");
