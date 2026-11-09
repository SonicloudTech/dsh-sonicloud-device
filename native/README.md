# 鼠标 SDK 原生依赖

来源：[SonicloudTech/mouse-sdk v0.4.20](https://github.com/SonicloudTech/mouse-sdk/releases/tag/v0.4.20)。目录保留官方交付包中的主库、动态依赖和平台 README，不修改二进制。

- `darwin-arm64/`：macOS 11+ Apple Silicon。
- `win32-x64/`：Windows 10/11 x64。
- `SOURCE.json`：官方包地址与本次下载的 SHA-256，可用于复核来源。

`THIRD_PARTY_LICENSES.txt`、`COPYING.LGPLv2.1`、`LICENSE.hidapi-bsd` 随插件分发。不要单独复制主库而遗漏依赖；FFmpeg 保持动态链接且可替换。

其他系统/架构需获取对应 SDK，并通过插件配置 `native.libraryPath` 指定主库。本文未声明这些平台已验证。

## 桌面语音组件

`desktop/` 是本项目维护的原生浮层及输入框回填实现，不属于上游鼠标 SDK。macOS ARM64 可执行文件由同目录 Swift 源码构建；Windows 源码由系统 PowerShell 加载。构建、权限和验证范围见[开发说明](../docs/contributing/development.md#桌面语音浮层)。
