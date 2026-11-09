# 本地开发与代码贡献

本项目是 DeepSeek Harness 插件，前端和后端均由宿主加载。本文面向开发者，说明本地调试、技术配置、验证和贡献流程。普通用户的安装与使用说明见 [README](../../README.zh.md)。以下命令在仓库根目录执行。

## 环境准备

- 安装 Git、Node.js 22 或更高版本及 npm。本仓库统一使用 npm 与 `package-lock.json`。
- 安装 DeepSeek Harness 0.2.1-rc.5 或更高版本；先启动一次完成初始化，再完全退出。
- 需要实机调试时连接智能鼠标。仓库随包提供 macOS ARM64、Windows x64 的 mouse-sdk 0.4.20；系统要求、依赖与许可证见 [原生 SDK 说明](../../native/README.md)。其他平台需提供对应 SDK 并配置 `native.libraryPath`。

在本地仓库创建工作分支并安装依赖：

```sh
git switch -c feat/your-change
npm ci
```

仅修改业务代码时无需更新依赖锁文件。增删或升级依赖使用 `npm install` / `npm uninstall`，同时提交 `package.json` 与 `package-lock.json` 的对应变更。

Harness profile 自身的 pnpm 配置由宿主管理，与本仓库的 npm 开发流程独立；普通用户通过插件界面安装，见 [README](../../README.zh.md#安装与启用)。

## 启动开发模式

确认 Harness 已完全退出后执行：

```sh
npm run dev:setup
npm run dev
```

`dev:setup` 构建开发包，并将 `desktop` profile 中的插件切换为 `work/dev-plugin` 的本地链接。保持 `dev` 运行，重新启动 Harness，在插件管理中启用 `dsh-sonicloud-device`，进入“声云设备”。按 SN 保存的设备偏好继续保留，升级时自动清理本插件旧服务凭据。

macOS 的安装脚本会自动查找 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`；找不到时使用 PATH 中的 CLI。自定义 CLI 或 profile：

```sh
npm run dev:setup -- --dsh "/绝对路径/dsh" --profile desktop
```

也可通过 `DSH_CLI` 指定 CLI。使用自定义 `DSH_HOME` 时，CLI 与宿主必须使用同一个目录；默认是用户目录下的 `.dsh`。安装到其他 profile 后，应启动对应 profile 的宿主。

### 保存与重载

保存源码后自动构建，成功后由 Harness HMR 重载插件：

- “构建成功”：新产物已生成，正在等待宿主加载。
- “后端已重载，前端更新已通知”：宿主已确认加载；仍需检查实际界面和设备行为。
- 构建失败：保留上一版运行代码，修正并保存后重试。运行时激活失败需查看宿主日志。

连续保存会合并构建，前端、后端和 SDK worker 全部编译成功后才发布。重载会取消当前语音会话、重建设备连接并重新挂载界面。已保存的设备设置保留，尚未保存成功的编辑不保证保留。原生库按构建版本复制，重载确认后保留当前和上一版本，清理更早的产物。

当前监听范围为 `src/`、`native/`、`docs/`、`package.json`、`package-lock.json` 和 `cordis.patch.yml`。修改 `scripts/` 后重启监听；修改依赖后停止监听、退出 Harness，重新运行 `dev:setup` 和 `dev`。移动仓库目录也需重新安装开发链接。

`Ctrl+C` 停止监听，宿主继续使用最后一次成功构建；`npm run dev -- --once` 只构建一次。开发链接生效期间不要删除 `work/dev-plugin`。同一仓库只运行一个监听进程。

### 退出开发模式

停止监听并完全退出 Harness，生成正式安装包：

```sh
npm pack --pack-destination artifacts
```

使用命令输出的实际文件名安装，然后重新启动 Harness：

```sh
dsh plugin --profile desktop add /绝对路径/项目目录/artifacts/实际包名.tgz
```

上述 `dsh` 需已加入 PATH，否则使用 CLI 完整路径；profile 应与开发时一致。仅停止监听不会解除本地开发链接。

## 代码与文档位置

| 路径 | 职责 |
| --- | --- |
| `src/client/` | React 设备设置、偏好编辑、AI 对话桥接与连接重试 |
| `src/desktop/`、`native/desktop/` | 桌面浮层进程、私有标准流协议及系统输入框回填 |
| `src/host/` | 宿主插件入口、Remote 注册与存储适配 |
| `src/devices/` | SDK 独立进程、设备管理、偏好、语音会话与按键动作 |
| `src/asr/` | 语音服务配置、鉴权与流式识别 |
| `src/shared/` | 前后端共享协议、语言映射和鼠标设置定义 |
| `native/` | 原生 SDK、依赖库、来源与许可证 |
| `scripts/`、`tests/` | 构建、开发辅助脚本与自动化测试 |
| `docs/specs/` | [插件规格](../specs/smart-mouse-plugin.md)、[鼠标设置](../specs/mouse-settings.md)与[发布规格](../specs/ci-cd.md) |
| `dist/`、`work/` | 正式前端构建产物与本地开发产物，不提交 |

## 桌面语音浮层

运行行为与验收要求见[插件规格第 3–4 节](../specs/smart-mouse-plugin.md#34-ai-键动作)。实现入口：

- `DeviceManager` 串行处理设备事件和偏好保存，分别处理连接、身份、电量、DPI 上报及按键；语音识别与最终结果输出分开处理，共用会话取消和清理路径。
- AI 键通过 `watchAi` / `answerAi` Remote 通道连接前端。前端使用 `sessions`、`workspaces`、`layout`、`uiWorkspace` 和 `conversation.input` 公共接口，保留目标引用，以 `workspaceId` 创建对话，并通过输入扩展槽等待组件挂载。
- `insert` 携带录音时的 `aiAutoSend`，通过 `requestDraftInitialization` 追加草稿，按开关调用目标组件的 `inputActions.submit()`。请求绑定同一前端连接；断开不重放填充，结束释放引用。原生浮层对 `ai_input` 只提供预览、取消和失败结果复制。

- macOS：`native/desktop/VoicePanel.swift` 构建不激活的 NSPanel，默认采用兼容粘贴，核对进程、窗口、文档、焦点和输入活动计数；可读取内容与选区时同时检查，不再要求辅助功能写入接口。随包提供 ARM64 应用；修改源码后在 macOS 执行 `node scripts/native/build-desktop.mjs`，需要 Xcode Command Line Tools。普通用户无需 Swift 工具链。
- Windows：`windows.ps1` 在隐藏的 STA 进程中加载 `VoicePanel.cs`，使用系统 WinForms 与 UI Automation，无需额外下载运行时。不支持安全回填的控件显示结果供复制。验证范围见下文记录。
- 浮层和 Host 通过私有 stdin/stdout 交换 JSON，文字不进入命令行、临时文件或日志；macOS 默认通过临时粘贴回填，随后恢复此前的全部剪贴板类型，若期间有新复制则保留新内容。其他剪贴板写入仅来自用户点击“复制结果”。辅助功能权限不足不阻止预览，但不能自动回填。
- 开发代际复制 `native/desktop/` 并将浮层模块的资源路径固定到对应代际。修改开发构建脚本后须重启 `npm run dev`。

macOS 的 `npm test` 会编译并执行 `CompatibilityPolicy.swift` 的保护条件测试，需要 Swift 工具链。

验收时分别检查：Harness 最小化/隐藏、无对话页、其他应用输入框、编辑内容/选区变化、取消、翻译失败、浮层进程异常、插件禁用、双屏及全屏。原生窗口检查使用合成文本不代表真实鼠标/实网链路通过。

## 技术配置与服务限制

配置通过宿主插件配置传入，结构以 [`src/devices/config.mjs`](../../src/devices/config.mjs) 为准。设备设置页不显示服务配置；统一使用[插件规格](../specs/smart-mouse-plugin.md#5-接口与鉴权)中的接入地址。旧翻译配置仅保留 `translation.timeoutMs`，其余字段须从宿主插件配置中移除。

| 字段 | 用途 |
| --- | --- |
| `native.libraryPath` | 可选，自定义 SDK 主动态库绝对路径；依赖库须在同目录。 |
| `recognitionLanguages` | 语言映射数组；每项为 `language`、`accent`、`rlang` 和 `query`。`query` 填服务实际支持的识别参数；省略整个数组时使用内置 43 项映射，指定数组时替换内置映射。 |
| `translation.timeoutMs` | 翻译超时，默认 15000 ms，可配置 1000–60000 ms。 |
| `dpiLevels` | DPI 数值字符串到固件档位字节的映射，见下文。 |
| `dpiReportLevels` | DPI 数值字符串到硬件上报档位字节的映射，独立于下发映射，见下文。 |
| `tailMs` | 松键后收集 SDK 尾部 PCM 的窗口，默认 150 ms；需实际鼠标验证。 |

自定义语音识别映射示例（以下配置只启用普通话；使用全部内置映射时无需填写）：

```json
{
  "recognitionLanguages": [
    {
      "language": "zh_cn",
      "accent": "mandarin",
      "rlang": "",
      "query": { "lid": "0", "lanid": "0", "role": "0" }
    }
  ]
}
```

DPI 选项及保存值见[鼠标设置](../specs/mouse-settings.md#dpi-设置)。SDK 下发默认采用其公开头文件给出的主流固件映射 `{ "800": 21, "1200": 32, "1600": 42, "2400": 63 }`。其他固件需覆盖 `dpiLevels`，不能把 DPI 数值直接作为协议字节。软件设置没有硬件确认回执，不能将设置保存成功视为硬件已应用；失败时界面提示重新选择后重试。

设备偏好默认值不代表硬件当前状态；首次保存前不会向设备下发默认 DPI。

硬件 `dpiChanged.level` 默认按 `{ "800": 0, "1200": 1, "1600": 2, "2400": 3 }` 映射（与现有鼠标客户端一致）。其他固件可覆盖 `dpiReportLevels`；未知、歧义或无效档位不修改 DPI 偏好。有效上报更新对应 SN 的保存值并推送界面，不再次下发指令；重复值不增加配置版本。硬件广播还可能出现在连接及通道切换时，不能当作软件设置的确认回执。实际固件档位仍需实机验收。

鉴权、凭据迁移和翻译流程见[插件规格第 5–6 节](../specs/smart-mouse-plugin.md#5-接口与鉴权)，语言选项及映射见[鼠标设置](../specs/mouse-settings.md)。

## 验证变更

提交代码前执行：

```sh
npm test
```

`pretest` 会先构建前端，再由 Node.js 测试运行器执行 `tests/*.test.mjs`；`npm run check` 等价于 `npm test`。集成测试包含本地 HTTP / WebSocket 服务，运行环境需允许监听回环地址。

按变更范围选择补充验证：

| 场景 | 操作与验收 |
| --- | --- |
| 快速检查单个模块 | `node --test tests/devices.test.mjs`，文件名替换为目标测试；直接调用不会触发构建，依赖 `dist/` 时先运行 `npm run build` |
| 界面与热重载 | 在 Harness 中保存源码，确认重载日志、界面更新、设置保存及重载后配置恢复 |
| 设备与语音 | 用实际鼠标验证相关连接方式、按键、录音、取消、重连及多设备隔离；记录平台与设备信息 |
| 包内容或安装入口 | `npm pack --dry-run` 检查文件列表；再打包安装，确认包含前端产物、宿主源码、patch、原生库及许可证，不包含 `work/` 等开发产物 |
| ASR 服务连通性 | 按需运行 `npm run probe -- <设备SN>`；该命令访问真实 Token / WSS 服务，仅检查鉴权握手，不采集或发送音频 |

`prepack` 会自动构建，无需在 `npm pack` 前重复执行构建。自动化测试或握手成功不代表硬件录音、按键动作或翻译实网验收通过；没有设备或服务条件时，在合并请求中注明未验证项。

### 已有验证记录

以下汇总截至 2026-11-09 的历史记录，不代表每次提交均已通过。维护者已确认完成 0.1.0 的 README 实机验收；专项验证仍以表内范围为准，未记录的场景不推定通过。发布平台记录单独维护在 [CI/CD 规格](../specs/ci-cd.md#6-验收与平台状态)。

| 范围 | 已验证 | 边界 |
| --- | --- | --- |
| 自动化与安装包 | 构建、真实 Harness Gateway 与本地 Token/ASR 模拟服务、包内容检查；覆盖设备隔离、保存、取消、重连、末句、翻译、搜索、DPI 和界面 | 不替代真实硬件与实网验收 |
| AI 键 | 自动化覆盖目标对话、工作区归属、组件就绪、追加草稿、自动发送、旧配置、去重、取消和 Gateway；安装包曾实测关闭设置及从设置/插件页新建对话后填充 | 实机填充记录来自自动发送加入前；真实鼠标长按、尾音、窗口唤起及自动发送联调待验证 |
| macOS 回填 | ARM64 浮层编译、显示、最小化后可见；Zed 和 VS Code 的中英文、多行兼容粘贴；用户确认真实鼠标在 Zed 可回填；保护策略自动化覆盖目标/输入变化与新剪贴板内容 | 其他应用、多屏/全屏、完整翻译链路待验证 |
| macOS SDK | 加载、初始化和退出；2026-11-05 退出 ClawMouse 后，Harness 显示 USB 鼠标、SN 和电量 | 该次连接检查未覆盖录音与按键 |
| 开发重载 | 隔离 profile 下同一 Host 进程替换后端、通知前端、重建 SDK；自动化覆盖失败保护、监听、恢复及退出清理 | 桌面实际重绘及 Windows 开发流程待验证 |
| 语言与服务 | 语言范围曾核对官方文档；普通话、英语、日语、粤语、法语及普通话繁体通过合成音频抽样 | 其余语言、新鉴权与文本翻译实网链路待验证 |

专项待验证：BLE/2.4G 音频与尾音时序、DPI 固件映射、系统按键及辅助功能权限、Windows 原生浮层与真实鼠标链路。产品与硬件待确认事项见[插件规格第 8 节](../specs/smart-mouse-plugin.md#8-待确认与联调)。

## 贡献流程

1. 从团队约定的目标分支创建工作分支，一次变更聚焦一个问题。目标分支和合并策略待维护者确认；`dev`、`main` 的推送会触发[发布流程](../specs/ci-cd.md)，合并前确认版本与产物要求。
2. 按所属模块修改代码；修复缺陷或新增行为时，补充能验证该行为的测试。功能、配置或使用方式变化时同步相关文档。
3. 执行适用的自动化与手工验证，区分通过、失败和未验证项。对用户或贡献者有意义的变更，同步记录到 [中文更新日志](../../CHANGELOG.zh.md)和[英文更新日志](../../CHANGELOG.md)的未发布章节；格式遵循 [项目规范](../../AGENTS.md)。
4. 用 `git diff`、`git status --short` 检查范围，只暂存本次变更的文件。不提交构建产物、开发链接、个人配置或真实凭据。
5. 按 [Git 提交规范](../../AGENTS.md#git-提交规范)提交，一个逻辑变更对应一个 commit。例如：`fix(devices): 修复设备重连后状态未刷新`。
6. 发起合并请求，说明问题、变更后的行为、测试结果及未完成项。界面变更附截图；硬件相关变更注明系统、Harness 版本、设备和连接方式，便于复现。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `dev:setup` 提示 profile 锁 | 完全退出对应 Harness 后重试，不删除正在使用的锁 |
| 提示已有开发构建进程 | 停止旧监听；仅在确认无开发进程且锁文件损坏时清理 `work/dev-plugin/watch.lock` |
| 构建成功但未收到重载确认 | 检查插件是否启用、profile 与 `DSH_HOME` 是否一致，再检查宿主日志；首次使用需先安装开发链接 |
| 同一 profile 中其他插件的 HMR 失效 | 在 profile 的用户 patch 中将各插件入口一起加入 `hmr.config.root`；用户 patch 优先级更高 |
| SDK 初始化成功但没有鼠标 | 检查鼠标电源、连接模式与接收器占用；ClawMouse 等应用可能独占数据接口，排查方法见 [README](../../README.zh.md#接收器已插入但没有设备) |

接收器占用诊断目前仅适用于 macOS 默认 uMouse 接收器，Windows 尚未提供占用进程诊断。SDK 初始化成功不代表设备已连接；排查时分别确认 SDK 状态、设备列表与实际按键、音频事件。
