---
name: hermes-android-re
description: 调用 Hermes CLI AI Agent 执行安卓逆向全自动化工程任务（包括自动刷机、自动提取 boot 并使用 Kitsune Mask Root、自动编译指定版本的 Android Frida-core/Frida-server、反检测二进制与源码魔改、重命名部署与验证）
modelInvocable: true
---

# Hermes CLI 安卓逆向工程自动化 Agent

本技能封装了基于 52 破解精华实战（帖子 2126444）的 **Hermes CLI AI Agent** 安卓逆向自动化全流程。Hermes 具备自主意图推断、环境适配、自主纠错和自动进化特性，能自主处理从环境准备、刷机、Root 到 Frida 源码与二进制魔改的完整逆向链条。

---

## 1. Hermes CLI 基础指令与调用模式

### 1.1 交互与命令模式
- **单次非交互运行（适合脚本与自动化调度）**：
  ```bash
  hermes -z "你的任务提示词" --yolo
  ```
  > `-z` / `--oneshot`：直接执行单次任务并将最终结果打印到标准输出。
  > `--yolo`：自动跳过危险命令确认提示，实现无人值守自动化。

- **指定模型与 Provider**：
  ```bash
  hermes -z "任务内容" -m deepseek/deepseek-chat --yolo
  # 或使用 Anthropic / OpenAI 兼容接口
  ```

- **任务规划与工作目录**：
  ```bash
  cd /path/to/android-project
  hermes chat -q "检测当前连接设备并初始化 Frida 逆向环境"
  ```

---

## 2. 安逆实战流水线与最佳实践

根据 52pojie 实录规范，Hermes 在安卓逆向工作流分为以下几个核心阶段：

### 阶段一：设备状态自主识别与刷机准备
1. **自动检测状态**：
   - 执行 `adb devices` 检测设备通信。
   - 获取机型与型号：`adb shell getprop ro.product.model`。
   - 检测 Bootloader 解锁状态：`adb shell getprop ro.boot.flash.locked`（0 为已解锁）。
   - 检查当前 Build 指纹：`adb shell getprop ro.build.fingerprint`。
2. **固件自动匹配与刷入**：
   - 引导从指定目录识别匹配机型的官方 ROM 包（如 MIUI/HyperOS/AOSP）。
   - 自动解压验证完整性，调用 fastboot 刷机脚本完成线刷，并使用 `adb wait-for-device` 等待系统正常开机。

### 阶段二：自动化提取 boot 与 Kitsune Mask Root
1. **自动获取 boot 镜像**：
   - 从固件包自动提取 `boot.img` 并通过 `adb push` 推送至手机 `/sdcard/boot.img`。
2. **安装授权工具**：
   - 下载最新版本 Kitsune Mask (狐妖面具) 或 Magisk apk，通过 `adb install -r` 安装。
3. **修补与刷入**：
   - 提示在 App 中完成 `boot.img` 修补后，自动拉取 `adb pull /sdcard/Download/magisk_patched_*.img`。
   - 重启到 bootloader：`adb reboot bootloader`。
   - 刷入修补镜像：`fastboot flash boot patched_boot.img && fastboot reboot`。
4. **Root 权限验证**：
   - 执行 `adb shell su -c id`，确认输出包含 `uid=0(root) gid=0(root)`。

### 阶段三：Frida 源码克隆与指定版本交叉编译
1. **版本与 NDK 矩阵匹配**：
   | Frida 版本 | NDK 版本 | 编译器 | 适用场景 |
   |---|---|---|---|
   | 16.5.x | r25 / r25c | Clang 14.0.7 | 经典稳定性逆向，兼容旧版脚本 |
   | 16.6.x | r25c | Clang 14.0.7 | 过渡版本 |
   | 17.x.x / 最新版 | r29 | Clang 21.0.0 | 新系统 Android 14/15 适配 |

2. **Android arm64 交叉编译流程**：
   - 克隆目标版本源码：`git clone --branch <version> https://github.com/frida/frida-core.git`
   - 设置交叉编译环境变量：
     ```bash
     export ANDROID_NDK_ROOT=/path/to/android-ndk-r25c
     ```
   - 针对目标架构配置与编译：生成 `build/server/frida-server` 等产物。

### 阶段四：Frida 反检测魔改（双重防护）
主流 APP 检测手段包含：端口检测(27042)、进程名(frida-server)、线程名(`pool-frida`, `gum-js-loop`, `gmain`, `gdbus`)、动态库(`frida-agent.so`)以及 `/proc/self/maps` 内存字符串特征。

1. **源码级魔改 (Git Patch)**：
   - 对 `frida-core` 打补丁，随机化 RPC 协议标识、替换工作目录名、随机化通信管道。
   - 对 `frida-gum` 打补丁，修改主循环特征。
2. **二进制级 ELF 魔改 (使用 lief / anti-frida.py)**：
   - 替换 `.rodata` 段特征字符串：
     - `frida` -> 随机 5 字符（如 `dpCWV`）
     - `gum-js-loop` -> 随机 11 字符（如 `uilBHNMyIWc`）
     - `gmain` -> 随机 5 字符（如 `XdJWC`）
     - `gdbus` -> 随机 5 字符（如 `NFzHZ`）
     - `GLib-GIO` / `GDBusProxy` -> 替换为混淆字符串。
   - 验证特征消除：`strings <binary> | grep -E "(pool-frida|gum-js-loop|gmain|gdbus)"` 无输出。

### 阶段五：魔改产物部署、命名伪装与服务启动
1. **清理旧进程**：
   ```bash
   adb shell "su -c 'killall frida-server 2>/dev/null || true'"
   ```
2. **推送并混淆重命名**：
   ```bash
   adb push ./build/server/frida-server /data/local/tmp/<custom_name>
   adb shell "chmod 755 /data/local/tmp/<custom_name>"
   ```
3. **后台启动并绑定地址**：
   ```bash
   adb shell "su -c '/data/local/tmp/<custom_name> -l 0.0.0.0:27042 -D'"
   ```
4. **验证监听与进程状态**：
   ```bash
   adb shell "ps -A | grep <custom_name>"
   frida-ps -H 127.0.0.1:27042  # 转发端口后连接验证
   ```

---

## 3. 常见报错自愈参考
- **SELinux Permission Denied**：
  - 临时宽容模式：`adb shell "su -c 'setenforce 0'"`
- **Vala / Gee 依赖缺失**：
  - `sudo apt-get install -y valac libgee-0.8-dev`
- **二进制魔改后 Segmentation fault**：
  - 说明字符串替换溢出或破坏了 ELF 节头偏移，需改用 lief 严格保持等长替换或在编译期完成替换。
