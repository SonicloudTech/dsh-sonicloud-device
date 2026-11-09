# uMouseSdk 0.4.20 —— 鼠标/领夹麦设备接入 SDK（macOS arm64）

从系统层接入 uMouse 家族设备（USB 2.4G 接收器 / BLE 蓝牙，自动偏好 USB），
完成 SN 识别、多设备管理、按键/语音音频/电量/会议事件解析与上抛。
内置 SBC / SyPcm / YiChip / ADPCM（TLW 包格式 + 连续流双模式自识别）音频解码。

权威接口文档：`include/umouse_sdk.h`（390 行，含完整注释与**事件 JSON 协议规范**，
集成前必读其头部协议说明段——deviceInfo / keyEvent / dpiChanged / meeting 系列 /
lavalierMicStatus/Battery（领夹麦 0x12/0x13）/ warning 信封的格式定义都在其中）。

## 文件清单

- `libuMouseSdk.dylib` → `libuMouseSdk.0.dylib` → `libuMouseSdk.0.4.20.dylib`（主库）
- **最小化 FFmpeg 闭包（仅 2 个文件，LGPL 2.1+，无 GPL 组件）**：
  `libavcodec.62.dylib` + `libavutil.60.dylib`——按 SDK 实际使用的解码器
  （`sbc`、`adpcm_ima_wav`）定制裁剪构建，依赖表仅系统库，**必须与主库同目录**
  （已改写为 @loader_path 互查，无需 rpath、无需 brew 环境）。
  本目录不含 x264/x265/vpx/dav1d/SvtAv1/mp3lame/opus/ssl/crypto
  （旧版分发包曾整串携带 brew 全功能 FFmpeg，其中 x264/x265 为 GPL 组件）。

### 第三方许可与重建方法

FFmpeg 以 **LGPL-2.1-or-later** 许可随包分发（动态链接，宿主无需开源）。
最小构建的完整复现命令（源码 FFmpeg 8.1.2，与库版本 62.28.102/60.26.102 对应）：

```bash
./configure --enable-shared --disable-static --disable-programs --disable-doc \
  --disable-debug --disable-network --disable-autodetect \
  --disable-avdevice --disable-avfilter --disable-avformat \
  --disable-swscale --disable-swresample \
  --disable-gpl --disable-version3 --disable-everything \
  --enable-decoder=sbc,adpcm_ima_wav --enable-parser=sbc
```

如需向最终用户提供许可文本，请附 FFmpeg 官方 LICENSE/LGPL-2.1 文本。

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

## 平台行为要点（macOS）

- BLE 设备识别：CoreBluetooth 无 MAC，SDK 以厂商服务 UUID + 家族 MAC 桥
  （ioreg）+ 已知设备集合三路提名，接管时以私有特征订阅确证；配对坏态
  （pairingBroken 警告）仅对确证过/家族 MAC 的端点上抛。
- 首次运行会请求蓝牙授权；设备重新配对后开/关一次电源即可被配对扫描自举找回。
- 多设备：默认每规则 4 台、全局 8 台；BLE 多活链超过 2 条会上抛 bleLinkHigh
  预警（射频调度劣化实测阈值）。
