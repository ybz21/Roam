# Android 后端（本机模拟器 / AVD）—— ttmux「手机」标签

为控制台「手机」标签提供一台 Android 设备。`backend/phone` 经 `adb` 镜像它的画面、转发点按/输入。

**正常路径是在设置页里点，不用碰命令行**：设置 › 手机 › Android，来源选「本机模拟器」，
列表里会把本机所有 AVD 都摆出来（没运行的也在，灰着，行尾一个「启动」），
右上角「新建模拟器」能从零建一台——机型、系统版本、名称选完就建，缺的系统镜像会自动下载。

下面这些是排查用的等效命令。

## 手工起停

```bash
$ANDROID_SDK_ROOT/emulator/emulator -list-avds                 # 有哪些 AVD
$ANDROID_SDK_ROOT/emulator/emulator -avd <名> -no-window -no-audio -no-boot-anim -accel on -gpu host &
adb -s emulator-5554 emu avd name                              # 这台 emulator-xxxx 是哪个 AVD
adb -s emulator-5554 emu kill                                  # 关机
```

ttmux 起模拟器时会 `setsid` 脱离自己的进程组——后端重启不该把用户的模拟器一起带走。
启动日志落在 `~/.roam/android/avd-<名>.log`。

## 前置条件

| 项 | 说明 |
|---|---|
| Android SDK | `emulator` + `platform-tools`；**新建功能**另需 `cmdline-tools`（`avdmanager`/`sdkmanager`） |
| 位置 | `$ANDROID_SDK_ROOT` / `$ANDROID_HOME`，或默认的 `~/Android/Sdk`（macOS 是 `~/Library/Android/sdk`） |
| KVM | Linux 上必需：`ls /dev/kvm` 要在，且当前用户在 `kvm` 组里（改组后要重新登录） |
| 图形 | 有 Intel/AMD 渲染节点走 `-gpu host`；只有 NVIDIA 或无核显时回落 `swiftshader_indirect`（软件渲染，慢） |

## 电视（Android TV）

TV 镜像没有触摸屏，交互靠遥控器焦点。新建时用途选「电视」，会：

- 只列 `android-tv` 的机型档与系统镜像；
- 把 `config.ini` 写成 1920×1080 @ 320dpi（= 960×540dp，TV 设计画布就是这个尺寸）；
- 打开 `hw.dPad` —— `avdmanager` 建出来的 TV 档未必带方向键，没有方向键的电视就是块砖。

## redroid 去哪了

早先这里是 redroid（Docker 容器里的 Android）。它已下线：成本压在宿主内核上
（`binder` 要 `sudo modprobe`，内核没有 `ashmem` 就封顶 Android 15），
却拿不出 TV/Wear/Google Play 镜像，也只能在 Linux 上跑。

旧配置会自动迁移（见 `backend/phone/config.go` 的 `sanitizeAndroid`）：
「本地 redroid」→ 本机模拟器；「远程 redroid」→ 远程设备，地址原样保留，照样连得上。
**遗留的容器与数据不会被删**——想清理自己来：

```bash
docker rm -f ttmux-redroid           # 容器
rm -rf ~/.roam/android/data          # 它的 /data（应用与数据，删了不可恢复）
docker rmi $(docker images -q redroid/redroid)   # 镜像（每个 2G 上下）
```

## 排查

```bash
adb devices -l                                        # 谁挂着、什么状态
adb -s emulator-5554 shell getprop sys.boot_completed # 1=开机完成
tail -f ~/.roam/android/avd-<名>.log                  # 启动日志（起不来先看它）
adb -s emulator-5554 shell wm size; adb -s emulator-5554 shell wm density
```
