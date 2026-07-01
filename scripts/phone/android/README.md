# Android 后端 (redroid) —— ttmux「手机」标签

为控制台「手机」标签提供一台 Android 设备。`backend/phone`(Linux→Android) 经 `adb` 镜像它的画面、转发点按/输入。

## 一键起停（自适应，推荐）

```bash
bash scripts/phone/android-redroid.sh up         # 自适应：探测宿主机 → 选版本/渲染 → 起容器 → 等开机
bash scripts/phone/android-redroid.sh status      # 容器 + adb + 实际选用的配置
bash scripts/phone/android-redroid.sh down        # 停（数据保留）
```

脚本会**按宿主机能力自适应**：

| 探测项 | 行为 |
|---|---|
| **binder** | 未加载则 `sudo modprobe binder_linux`（redroid 必需） |
| **ashmem** | Android 16 的 system_server 硬依赖 `/dev/ashmem`；主线内核 6.x 已移除 → 本机无 ashmem 时**自动把目标从 16 回退到 15**（15 及以下走 memfd，正常开机） |
| **GPU** | 找到 Intel(`0x8086`)/AMD(`0x1002`) 渲染节点 → `gpu_mode=host` 硬件加速（SurfaceFlinger 才稳）；只有 NVIDIA 或无核显 → `gpu_mode=guest` 软件渲染 |

实际生效的 compose 由脚本生成到 `~/.ttmux/android/docker-compose.yml`，数据挂载在 **`~/.ttmux/android/data`**（bind mount，删容器不丢数据）。

可选覆盖：`TTMUX_ANDROID_VERSION=15`、`TTMUX_ANDROID_DATA=/path`、`TTMUX_ANDROID_W/H/DPI`。

## 前置条件

| 项 | 说明 |
|---|---|
| 平台 | **仅 Linux**（redroid 用宿主 Linux 内核的 binder）。macOS/Windows 不支持。 |
| 内核 | `CONFIG_ANDROID_BINDERFS`。`grep binder /proc/filesystems` 有输出即可。 |
| Docker | 必需，`--privileged`。 |

## 为什么不是 Android 16

Android 16 的 `ApplicationSharedMemory`（system_server 启动期）**硬依赖 ashmem 设备**。
ashmem 驱动在主线内核 5.18 后被移除（改用 memfd），且无维护良好的外挂模块可在 6.x 编译。
所以在这类内核上 16 会卡在 `zygote` 崩溃（`Failed to create ashmem`）。**Android 15 是这类内核能开机的最高版本**，脚本默认即自动落到它。换到带 ashmem 的内核后，`up 16` 会自动用 16。

ARM 兼容性不受影响：`_64only` 镜像自带 `libndk_translation`（`abilist=x86_64,arm64-v8a`），arm64-v8a App 可跑（32 位 ARM 不行）。

## 排查

```bash
docker logs ttmux-redroid                                   # 启动/boot 日志
adb -s localhost:5555 shell getprop sys.boot_completed       # 1=开机完成
adb -s localhost:5555 shell getprop sys.init.updatable_crashing_process_name  # 崩溃中的进程
```
