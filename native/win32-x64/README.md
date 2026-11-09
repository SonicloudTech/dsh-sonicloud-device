# uMouseSdk 0.4.20 —— 声云智能鼠标设备接入 SDK（Windows x64）

从系统层接入 uMouse 家族设备（USB 2.4G 接收器 / BLE 蓝牙，自动偏好 USB），
完成 SN 识别、多设备管理、按键/语音音频/电量/会议事件解析与上抛。
内置 SBC / SyPcm / YiChip / ADPCM（TLW 包格式 + 连续流双模式自识别）音频解码。

权威接口文档：`include/umouse_sdk.h`（含完整注释与**事件 JSON 协议规范**，
集成前必读其头部协议说明段——deviceInfo / keyEvent / dpiChanged / meeting 系列 /
lavalierMicStatus/Battery（领夹麦 0x12/0x13）/ warning 信封的格式定义都在其中）。
完整接入文档（C/C++、C#、Python、Electron/Node.js）与 C 示例见 SDK 发布仓库。

## 文件清单

- `uMouseSdk.dll`（主库）+ `uMouseSdk.lib`（导入库，链接期加载用；
  `LoadLibrary` 动态加载方式可忽略 .lib）
- FFmpeg 编解码闭包：`avcodec-58.dll` / `avutil-56.dll`——与主库同目录
- VC 运行库副本：`msvcp140.dll` / `vcruntime140.dll` / `vcruntime140_1.dll`
  （14.51.36231.0）

## 加载方式（重要）

本目录不在系统默认 DLL 搜索路径内，两种方式二选一：

1. **PATH 前插**：在首次加载任何 SDK DLL 之前，将本目录加入进程 `PATH`
   （`SetEnvironmentVariableW` 修改进程环境即可，无需系统级配置）；
2. **显式加载**：对每个 DLL 用
   `LoadLibraryExW(绝对路径, NULL, LOAD_WITH_ALTERED_SEARCH_PATH)`。

**VC 运行库注意**：系统搜索序中 System32 先于 PATH——若目标机 System32 内存有
旧版 / 测试版 CRT（例如 14.29 一带的云测试版本），会覆盖本目录副本导致崩溃。
稳妥做法：加载 SDK 之前，按 `vcruntime140.dll → vcruntime140_1.dll → msvcp140.dll`
顺序以**绝对路径**预载本目录三个 CRT（同进程内已加载的模块优先，后到的同名
DLL 会被忽略）。目标机已安装 VC++ Redistributable 时亦可直接依赖系统版本。

## 最小集成流程（C ABI）

```c
#include "umouse_sdk.h"

um_sdk_init(1);                      // 装载默认设备规则（debug 日志开关）
um_register_connected(on_connected);   // 设备上线（device_id = SN）
um_register_disconnected(on_disconnected);
um_register_message(on_message);       // 事件 JSON（协议见头文件）
um_register_audio(on_audio);           // 解码后 PCM（16k mono s16le）
um_sdk_start();                       // 启动监测（可省略，init 后自动）

// 语音链路由调用方实现：audio 回调 PCM → 自有识别管线；
// keyEvent(语音键抬起) → 结束识别。
```

## 关键 API 组

- 生命周期：`um_sdk_init` / `um_sdk_start` / `um_sdk_close` / `um_sdk_version`
- 事件注册：`um_register_connected/disconnected/message/audio/raw_frame`
- 设备规则（RAW 接入自定义硬件）：`um_device_rule_*` / `um_set_usb_config` /
  `um_set_ble_config` / `um_usb_add_match` / `um_register_ble_match_device`
- 运行时控制：`um_set_work_mode[_for]`（RAW/FULL）、`um_set_channel_pref[_for]`
  （0=自动 USB 优先 / 1=仅 USB / 2=仅 BLE）、`um_set_device_limit`、
  `um_set_audio_source`（多设备音频出口选定）、`um_meeting_create/pause/resume`
- 诊断：`um_enable_crash_report`

## 平台行为要点（Windows）

- 通道：USB/2.4G 接收器走 HID；BLE 走 WinRT Bluetooth LE API（系统栈），
  自动偏好 USB，同 SN 双通道在线时按 channel_pref 策略择路。
- 无系统授权弹窗；BLE 配对在 Windows 系统蓝牙设置完成，接收器免配对即插即用。
- 多设备：默认每规则 4 台、全局 8 台；BLE 多活链超过 2 条会上抛 bleLinkHigh
  预警（射频调度劣化预警；实测 Windows 约 2 条并发起明显劣化、macOS 1 条即显，
  预警阈值取保守值）。
- 日志：`cpp_modules.log` 落宿主进程当前工作目录（cwd）。
