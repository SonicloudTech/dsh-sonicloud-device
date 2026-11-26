# 插件多语言规格

状态：已实现；自动化验证通过，两端宿主实机与布局验收待完成。更新日期：2026-11-26。

## 1. 语言与范围

插件自动跟随 DeepSeek Harness 的界面语言，不提供独立语言菜单，不保存按设备区分的界面语言。支持以下 8 种语言，标识与宿主一致：

| 标识 | 名称 | 约定 |
| --- | --- | --- |
| `zh` | 中文 | 简体中文；宿主文档标签为 `zh-CN` |
| `en` | English | 沿用宿主英语资源 |
| `ja` | 日本語 | 沿用宿主日语资源 |
| `es` | Español | 沿用宿主西班牙语资源 |
| `fr` | Français | 沿用宿主法语资源 |
| `de` | Deutsch | 沿用宿主德语资源 |
| `ru` | Русский | 沿用宿主俄语资源 |
| `pt` | Português | 巴西葡萄牙语，也承接宿主解析的 `pt-PT` 请求 |

地区标签由宿主解析，插件不新增地区或繁体中文资源。依据：[语言服务][harness-locale]、[语言包说明][harness-locale-readme]。

| 范围 | 要求 |
| --- | --- |
| 插件页面与入口 | 设置页、侧边栏、设备信息、设置选项、空状态及操作说明支持 8 种语言 |
| 操作反馈 | 状态、校验、通知、错误、权限引导及插件内截图入口支持 8 种语言 |
| 桌面语音浮层 | macOS、Windows 的状态、复制、取消、关闭、回填提示及 Windows“一键提交”支持 8 种语言 |
| 无障碍文本 | 控件名称、图像说明和工具提示与界面语言一致 |
| 插件管理页 | 名称与简介按第 3 节处理 |
| 截图独立界面 | ScreenTool/helper 的选区、标注、复制、保存、贴图和滚动截图界面不纳入本期 |
| 系统界面及文档 | 系统弹窗遵循系统语言；README、开发文档、更新日志及开发日志不扩展为 8 种语言 |

设备功能保持[插件规格](smart-mouse-plugin.md)约定，识别及翻译语种保持[鼠标设置](mouse-settings.md)约定。

## 2. 切换与同步

- 初次加载、重新启用及重启后读取宿主活动语言；宿主切换时，插件页面、入口、提示和语音浮层即时更新，无需重启或重连设备。
- 切换只影响展示，保留当前设备、滚动位置、焦点、未提交草稿及保存状态；不重复注册入口、保存配置或发送设备指令。
- 活动语音会话不中断，不改变识别/翻译参数、输入目标和自动发送行为；识别结果、译文及对话草稿保持原样。
- 后台和浮层以宿主最终确认的语言为准，包括宿主无显式偏好时的自动解析结果。多窗口初始化、重连、过期连接及迟到消息不得覆盖更新的有效状态。
- 窗口关闭、隐藏或断连但宿主后台仍运行时，保留最近一次有效语言；恢复连接后同步最新有效值。无有效值时使用英语，完全退出宿主后停止后台与浮层。
- 翻译沿宿主回退链查找：先查插件命名空间，再查 `common`；本期非英语资源回退到 `en`，额外语言包沿其声明的回退链处理。
- 缺译属于验收缺陷。动态错误无法匹配时显示本地化通用提示，不显示资源键、`undefined` 或空白按钮。

## 3. 文案规则

- 品牌：中文使用“声云”，其余语言统一使用 `Sonicloud`；功能名称按目标语言翻译，包标识和既有组件专名保持不变。
- 插件简介：`zh` 使用 [README.zh.md](../../README.zh.md)，其他 7 种语言使用 [README.md](../../README.md)，不另行翻译简介。
- 业务数据：识别三元组 `language/accent/rlang`、翻译 `from/to`、服务参数、设备偏好及语种范围、顺序和可用性保持不变。业务语种表中的 `locale` 不作界面语言使用。
- 语种名称：沿用原生名称；中文及方言名称在非中文界面提供本地化名称，可保留原生名称。简繁体、不可用等说明随界面语言翻译。
- 原样内容：用户输入、识别结果、译文、设备返回的名称、SN、路径和 URL 不翻译。
- 翻译资源：随插件发布，使用稳定语义键、完整句子和命名占位参数；数量文案处理目标语言的复数形式，不依赖在线翻译。
- 术语与布局：各界面术语一致，“后退”准确表达 Backspace；支持重音、日文、西里尔字符及菜单原生文字。长文案可换行，关键内容不可遮挡或截断。

## 4. 宿主接入与兼容

已核对 `dsh-v0.2.3-alpha.2`（提交 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`）和最低宿主版本 `dsh-v0.2.1-rc.5`（提交 `b830ec950faba0a46dda564be3e2d854afed94f1`）。源码核对不等于插件运行验证。

| 用途 | 接口与要求 |
| --- | --- |
| 读取语言 | 声明客户端 `locale` 服务依赖，通过 `ctx.locale.getLocale()` / `getSnapshot()` 读取 `active`、`locales`、`revision` |
| 订阅变化 | `ctx.locale.subscribe(listener)` 响应语言及字典变化并返回取消订阅函数；`locale/change` 事件仅响应活动语言切换 |
| 字典与翻译 | `ctx.locale.register(namespace, dictionaries)` 注册资源并返回清理函数；`bind(namespace)` 返回按当前语言翻译的函数 |
| 页面刷新 | slot 指定 `locale` 命名空间；组件订阅快照并使用 `bind(namespace)`，保持组件与编辑状态 |
| 入口刷新 | `settings.section`、`sidebar.panellist` 使用 `label: () => t(key)`；宿主负责订阅并刷新，不缓存固定译文或重注册入口 |
| 包文本 | `ctx.locale.resolveText(text)` 解析普通字符串或含 `en` 回退的语言映射 |

依据：[语言服务][harness-locale]、[设置入口][harness-settings]、[侧边栏入口][harness-sidebar]。宿主翻译函数最终缺键时返回键名，且不内置复数规则，插件须按第 2、3 节处理。

`0.2.1-rc.5` 已有上述 API，但内置语言仅为 `zh/en`；`0.2.3-alpha.2` 已注册全部 8 种语言。保持现有最低版本要求，旧宿主跟随其实际活动语言。[旧版语言服务][harness-locale-rc5]

后台读取 `settings.describe()` 中的 `locale` 配置版本，并监听 `settings/document-updated`。客户端仅在 `configForms.get('locale')` 已加载时提交活动语言和配置版本；后台拒绝过期版本及与已确认偏好不符的结果。自动解析时保留当前版本首次有效结果，防止其他窗口覆盖。

插件名和摘要通过随包 `locale/<lang>.json` 的 `meta.title`、`meta.description` 提供；`meta.detail` 指向对应 README。README 详情语言选择依赖宿主支持 `meta.detail`（已核对 `0.2.3-alpha.2`），旧版仅保证名称和摘要。

插件只消费宿主语言，不调用 `addLanguage` 或 `setLocale`，不读取菜单 DOM 或私有存储。前端、后台和两端原生浮层须处理初始同步、有效状态判定、过期更新及卸载清理；后台状态与错误使用稳定代码和参数，在展示端本地化，不通过匹配中文文本决定业务行为。

## 5. 验收

自动化验证：`npm test` 178 项通过，1 项 Windows 专用测试因当前平台为 macOS 跳过；macOS ARM64 浮层编译、Developer ID 签名验证及安装包文件检查通过。

待验收：macOS、Windows 宿主中的真实切换、原生窗口和布局。验收时记录宿主版本、插件版本及结果。

| 项目 | 通过条件 |
| --- | --- |
| 语言覆盖 | 8 语种宿主上逐一检查第 1 节范围，无缺译、空值、占位参数错误或乱码；`zh` 为简体，`pt` 为巴西葡萄牙语 |
| 旧版兼容 | `0.2.1-rc.5` 的中英文显示、切换及入口刷新正常 |
| 切换与业务隔离 | 页面和浮层即时更新，第 2 节要求保留的界面状态、业务参数与活动会话不变 |
| 多窗口与恢复 | 已确认的新语言不被其他窗口的临时或旧状态覆盖；重启、断连恢复、窗口关闭或隐藏符合第 2 节 |
| 品牌与简介 | 中文显示“声云”及中文 README，其余语言显示 `Sonicloud` 及英文 README |
| 异常反馈 | 覆盖无设备、多设备、身份未确认、权限不足、保存/DPI/服务/回填失败、超时及语言回退，无资源键外露 |
| 数量与布局 | 检查 0、1、2、5、21 台设备的数量文案，长文案、窄侧边栏和深浅主题下内容可读 |
| 无障碍 | 键盘操作与焦点恢复正常，可访问名称和工具提示使用当前语言 |

[harness-locale]: https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client/locale/src/client/index.ts
[harness-locale-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client/locale/README.zh.md
[harness-settings]: https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client/ui-settings-general/src/client/index.ts
[harness-sidebar]: https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client/ui-sidebar/src/client/index.ts
[harness-locale-rc5]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/locale/src/client/index.ts
