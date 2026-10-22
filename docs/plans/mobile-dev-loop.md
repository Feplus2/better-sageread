# 移动端开发/验收流程（2026-10-22 环境自检版）

> 目标：电脑上改代码 → 手机上看手感，且**不要求每轮都手动点安装**。
> 环境自检脚本：`node scripts/check-mobile-env.mjs`（只读，随时可跑）。

## 1. 本机现状（自检 7/9 通过）

| 检查项 | 状态 | 详情 |
|---|---|---|
| JDK 21 | ✅ | `F:\MyProjects\SageRead\.tools\jdk-21.0.12.1+1` |
| Android SDK | ✅ | `C:\Users\20995\AppData\Local\Android\Sdk` |
| adb | ✅ | `platform-tools\adb.exe`（v1.0.41） |
| NDK | ✅ | `ndk\30.0.16138531` |
| Gradle 工程 | ✅ | `packages/app/src-tauri/gen/android`（含 gradlew.bat） |
| Tauri Android 配置 | ✅ | `src-tauri/tauri.android.conf.json` |
| Rust Android targets | ✅ | aarch64 / armv7 / i686 / x86_64-linux-android 全部已装 |
| 已连接设备 | ❌ | 未连接 |
| 模拟器 AVD | ❌ | 未创建（SDK 里没有 system-image） |

应用标识：`com.bettersageread.dev`（开发版），minSdk 24 / targetSdk 36。

## 2. 推荐路线：真机 + USB 反向端口（只装一次）

核心思路：**手机上的 App 加载电脑上的 dev server（localhost:1420），通过 `adb reverse` 把手机的 1420 转发到电脑的 1420。**
这样日常改前端（React/CSS）由 Vite HMR 热更新，**不用重装 App**；只有改 Rust/Android 原生代码时才需要重新构建安装。

一次性准备：

```powershell
$env:JAVA_HOME = 'F:\MyProjects\SageRead\.tools\jdk-21.0.12.1+1'
$env:ANDROID_HOME = 'C:\Users\20995\AppData\Local\Android\Sdk'
$env:NDK_HOME = 'C:\Users\20995\AppData\Local\Android\Sdk\ndk\30.0.16138531'
# 手机打开「开发者选项 → USB 调试」，连 USB 后：
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices
& "$env:ANDROID_HOME\platform-tools\adb.exe" reverse tcp:1420 tcp:1420
```

首次构建安装（会编译 Rust，第一次慢，几分钟起）：

```powershell
pnpm --filter app tauri android dev
```

构建期间 `tauri android dev` 会自动跑 Gradle 并把 APK 装到设备。首次安装后：

- 日常改前端：只改 `packages/app/src` 下的 React/CSS，Vite HMR 自动生效；`adb reverse` 保持连接即可；
- 改 Rust：`tauri android dev` 会自动重新编译安装（这次必须装，但只发生在改原生代码时）；
- 换手机/换 USB 口：重新执行一次 `adb reverse`。

## 3. 备选路线：构建 debug APK 后手动增量安装

```powershell
pnpm --filter app tauri android build --debug
# 产物一般在：packages/app/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb install -r -d --user 0 <上面那个 apk>
```

`-r` 表示覆盖安装；同一台机器 debug 签名不变时，**通常不需要再点确认**。如果每次都弹窗，见第 4 节。

## 4. 华为/荣耀手机的一次性授权清单（减少重复弹窗）

在手机上依次确认：

1. 设置 → 关于手机 → 连续点「版本号」7 次，打开开发者模式；
2. 设置 → 系统与更新 → 开发人员选项 → 打开「USB 调试」；
3. 连 USB 后，手机通知栏把「仅充电」改成「传输文件」；
4. 电脑 `adb devices` 首次会出现 `unauthorized`：在手机弹窗里勾选「始终允许」并确定；
5. 开发人员选项里找到 **「监控 ADB 安装应用」** → **关闭**（这是华为每次安装都要点确认的主要开关）；
6. 如仍有「外部来源应用」提示：设置 → 安全 → 更多安全设置 → 外部来源应用安装，允许对应的文件管理器/USB 安装；
7. 若安装被应用市场/安全扫描拦截：在华为应用市场设置里关闭「安装应用安全检测」或安装时选择「继续安装」。

可再用一条命令关掉系统安装校验（部分机型有效，不行就靠上面第 5 条）：

```powershell
adb shell settings put global verifier_verify_adb_installs 0
```

## 5. 模拟器路线（没有真机时）

当前 SDK **没有任何 system-image**，所以 `emulator -list-avds` 为空。要用模拟器需先下载镜像（较大，几 GB）：

```powershell
# 在 Android SDK 的 cmdline-tools\latest\bin 下
sdkmanager "platform-tools" "platforms;android-36" "system-images;android-36;google_apis;x86_64" "emulator"
avdmanager create avd -n sage -k "system-images;android-36;google_apis;x86_64" -d pixel_7
emulator -avd sage
```

注意：模拟器需要开启 Windows 虚拟化（Hyper-V/WHPX），且触控手感与真机不同。**建议优先真机**。

## 6. 常见坑

- **手机打不开 1420**：`adb reverse tcp:1420 tcp:1420` 忘了执行/断开重连后失效；
- **首次安装被拒**：见第 4 节第 5、6 条；
- **`tauri android dev` 报找不到 JDK/NDK**：检查第 2 节三个环境变量是否都在当前终端生效；
- **应用与桌面版数据**：手机是独立设备，数据不共享；调试数据只影响手机上的 dev 包；
- **鸿蒙/HarmonyOS 机型**：WebView 实现与 Android 标准版可能不同，遇到渲染差异先记录机型与系统版本。

## 7. 今晚的执行顺序（建议）

1. 手机开 USB 调试并连接，跑 `node scripts/check-mobile-env.mjs` 确认「已连接设备」变 OK；
2. 跑 `adb reverse tcp:1420 tcp:1420`；
3. 首次 `pnpm --filter app tauri android dev`（我负责构建与排错，你只需要在手机点一次「允许」）；
4. 之后你验收手感，我在电脑上改前端即可热更新，不用你反复点安装；
5. 只有改原生能力时才需要第二次安装确认。
