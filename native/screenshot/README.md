# 截图运行组件

随插件提供 ScreenTool 1.2.2 的 Windows x64、macOS ARM64 客户端与独立 helper。两端 helper 均应用 [入口显隐补丁](patches/hide-cloud-actions.patch) 后重建；macOS 另叠加[权限前检补丁](patches/mac-permissions.patch)。来源与文件 SHA-256 见 [SOURCE.json](SOURCE.json)。

- Windows：使用 Qt 5.15.2 重建 helper，保留原包的 Qt、图像格式、TLS、滚动截图与 VC 运行依赖；客户端 `screentool.dll` 来自同套 Electron 示例的 `lib/`。
- macOS：使用 Qt 6.2.4 重建 ARM64 helper，复用原包客户端、框架、PixPin 和 `Info.plist`，以原 Team `F3TYM6YPF7` 的 Developer ID 签名并通过 `codesign --verify --deep --strict`。本次未执行 Apple 公证。交付包要求 macOS 26.0+，该最低版本来自保留的客户端库。
- macOS 权限检查或截图前通过系统 `ditto` 将 `screentool-macos-1.2.2.zip` 解压到按压缩包 SHA-256 区分的用户缓存，保留签名、软链接与执行权限；新包使用新的缓存目录。
- 截图在独立进程执行，插件通过隔离的 Node worker 调用客户端库。停用插件时关闭 helper 及贴图，并等待原生回调线程退出。
- 选区、标注、复制、保存、贴图及滚动截图由 helper 提供。OCR、图像翻译与 Word 云转换未接入；界面效果与完整操作由用户人工验收。

## 两端入口隐藏机制

截图 worker 每次连接 helper 后先通过 `sct_set_config` 下发 `ocr_visible: false`、`trans_enabled: false`，配置成功后再发起截图。两端使用相同补丁：

- `trans_enabled: false` 使 Qt 工具条隐藏图片翻译按钮。
- `ocr_visible: false` 隐藏普通 OCR，并在每次滚动截图开始前移除自定义 OCR 动作；该动作原本用于启动 Word 导出。`onConvertImage` 同时检查此开关，阻止旧动作启动转换。
- 工具条宽度随隐藏按钮收缩；滚动截图按钮、PixPin 拼接以及复制、保存、贴图操作保留。

## macOS 权限前检

安装后的首次启用和服务重连会查询权限，在“声云设备”中显示持久引导；检查本身不申请系统权限、不创建截图蒙层。各组件所需权限与人工操作见[用户指南](../../README.zh.md#macos-首次授权)。

- helper 宣告 `permission_preflight` 能力，通过 `sct_query_state` 返回屏幕录制、辅助功能和组件路径。只有用户点击授权按钮后，宿主才以 `sct_set_config` 的 `permission_request` 字段请求 `screen` 或 `accessibility`，由 screenhelper 调用系统接口；请求受理不等于已授权。
- 宿主在发送截图命令前检查屏幕录制权限；原生进程也在创建选区、抓屏和显示蒙层前再次检查。缺权限时回报状态并结束截图会话，不显示蒙层，也避免触发客户端会话启动看门狗。
- 普通截图和手动滚动不要求辅助功能。重新检查时，仅在无活动截图或贴图的情况下重启截图 helper，以重新读取系统权限；不打断已有截图和贴图。

## 重建

- Windows：`node scripts/native/build-screenshot.mjs --source <ScreenTool源码目录>`。
- macOS：`node scripts/native/build-screenshot-macos.mjs --source <ScreenTool源码目录>`；需要 Qt 6.2.4、构建工具及原 Team 的有效签名身份。

脚本在插件 `work/` 中应用补丁、编译并运行原生离屏回归。macOS 脚本依次应用入口显隐与权限前检补丁，使用 `ditto` 复用并重新归档原 bundle，严格验签后生成新 ZIP 和构建回执；正式随包文件与来源记录由交付流程核对后更新。离屏回归与签名校验不代替首次授权、弹窗层级和完整截图操作的人工验收。

这些供应商二进制及 Qt、OpenSSL、Microsoft VC Runtime、PixPinScrollCapture 等依赖保留各自许可，不适用仓库代码的 MIT 许可。原压缩包未提供单独的组件许可文件；公开再分发所需的完整声明与授权材料待供应商补齐。
