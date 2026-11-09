# 鼠标设置

## 范围与维护

本文定义“声云设备”中智能鼠标的设置项、默认值、选项顺序和语言接口映射。配置按设备 SN 保存，已保存的配置优先恢复；选项表行序为对应菜单顺序，`label` 用于显示，`value` 用于保存。设置字段与服务端参数分开定义，经映射后使用。

| 数据 | 运行时来源 |
| --- | --- |
| 识别及翻译语言 | [src/shared/languages.mjs](../../src/shared/languages.mjs) |
| DPI、M 键动作及搜索引擎 | [src/shared/mouse-settings.mjs](../../src/shared/mouse-settings.mjs) |
| 默认值与配置校验 | [src/shared/devices.mjs](../../src/shared/devices.mjs) |
| ASR 参数映射 | [src/asr/languages.mjs](../../src/asr/languages.mjs) |

修改选项、默认值或映射时同步更新本文与源码。页面布局、设备调度和硬件接入见[插件规格](smart-mouse-plugin.md)。

## 设置项与默认值

下表为当前插件保存的配置，不是接口请求体；语言字段的接口对应关系见“语言设置”。

| 设置项 | 配置字段 | 默认值 |
| --- | --- | --- |
| 语音打字语言 | `recognition` | 普通话：`{ language: "zh_cn", accent: "mandarin", rlang: "" }` |
| 标点符号 | `punctuation` | `true`，开启 |
| 翻译源语言 | `from` | `cn`，中文；对应开放平台代码 `zh` |
| 翻译目标语言 | `to` | `en`，English |
| DPI 键 | `dpi` | `"1600"` |
| M 键动作 | `mAction` | `enter`，回车 |
| 搜索引擎 | `searchUrl` | `https://www.baidu.com/baidu?wd=` |
| 一键链接 | `linkUrl` | `""`，未设置 |
| 语音键动作 | `speechAction` | `voice_input`，语音打字 |
| AI 键动作（内部保留，不提供选择控件） | `aiAction` | `openAi` |
| AI 键自动发送 | `aiAutoSend` | `true`，开启 |

搜索引擎仅在 M 键选择“语音搜索”时显示，一键链接仅在选择“一键链接”时显示。标点开关作用于语音打字及语音搜索的识别结果，不处理译文。

## 语言设置

接口依据为[实时识别完整语种表](https://open.sinicloud.com/documents/webapi/stream-asr)和[文本翻译语种表](https://open.sinicloud.com/documents/webapi/translate-text)。

| 功能 | 数量 | 支持条件 |
| --- | --- | --- |
| 语音打字 | 43 | 有明确对应的识别语种、方言及字形。 |
| 翻译源语言 | 27 | 文本翻译支持，且有明确的 ASR 映射。 |
| 翻译目标语言 | 28 | 文本翻译支持。 |

### 实时识别接口字段

实时识别通过 WebSocket `/talentStreamAsr` 接收音频，连接参数使用 URL Query。鉴权字段 `X-SC-Authorization` 为用户 Token，`X-SC-User-Id` 为客户定义的用户标识；二者在 Query 缺省时可从同名 Header 读取，不属于鼠标语言选项。

| 接口参数 | 类型与默认值 | 含义及使用规则 |
| --- | --- | --- |
| `lanid` | String，默认 `"0"` | 识别语种编号，支持 `0–127`；普通话为 `"0"`、粤语为 `"4"`、繁体中文为 `"100"`。鼠标选项映射见下表。 |
| `lid` | String，默认 `"0"` | 工作模式：`"0"` 为识别，`"1"` 为同声传译。当前插件使用 `"0"`。 |
| `role` | Integer，默认 `0` | 是否区分说话人：`0` 不区分、`1` 区分；仅在 `lid=0` 时有效。当前插件取 `0`，序列化到 Query 后为字符串 `"0"`。 |
| `fromlan` | String，`lid=1` 时必填 | 流式翻译的源语言代码，取自实时识别语种表的“语言代码”列；不是 `lanid` 编号。当前插件不传。 |
| `tolan` | String，`lid=1` 时必填 | 流式翻译的目标语言代码，规则同 `fromlan`。当前插件不传。 |

`lid=0` 且提供 `fromlan/tolan` 时，接口支持识别后翻译；`lid=1` 为双向同声传译，限 `lanid=0–99`。流式翻译不支持 `lanid>=100` 的语种。当前鼠标翻译流程为“源语言识别 → 最终文本 → 独立文本翻译”，不使用流式翻译模式。

识别结果使用 `result`；`End>0` 表示一句完整结果，`errCode="10"` 表示整个流结束。流式翻译的 `trans` 是该 WebSocket 接口的译文字段，不能作为文本翻译接口的响应字段。

### 文本翻译接口字段

开放平台接口为 `POST /v1/translate/text`。以下参数与返回字段依据[文本翻译文档](https://open.sinicloud.com/documents/webapi/translate-text)。

| 字段 | 类型与要求 | 含义 |
| --- | --- | --- |
| `text` | String，必填，最多 5000 字符 | 待翻译文本；语音翻译使用 ASR 完成后的最终文本。 |
| `from` | String，参数表标注可选，默认 `auto` | 源语言代码。鼠标已指定源语言，应显式传对应代码；中文简体使用 `zh`。 |
| `to` | String，必填 | 目标语言代码；不能与 `from` 相同。 |
| `code` | Integer，响应字段 | `0` 表示成功，其他值按该接口错误码处理。 |
| `msg` | String，响应字段 | 状态或错误说明。 |
| `data.resultText` | String，成功响应字段 | 翻译后的文本。 |

官方参数表允许省略 `from`，错误码表同时列有“源语言必填”；鼠标请求显式传入源代码，不依赖缺省行为。`auto` 是接口的自动检测值，当前设置不提供此选项。

[翻译适配器](../../src/devices/translate.mjs)已接入开放平台，使用来源设备 Token，按本节映射语言代码并读取 `data.resultText`；缓存和重试规则见[插件规格](smart-mouse-plugin.md#5-接口与鉴权)。

### 项目内部语言字段

| 内部字段 | 含义 | 接口对应关系 |
| --- | --- | --- |
| `zh_name` | 选项中文名称。 | 仅用于展示和说明，不发送。 |
| `label` | 菜单显示文本。 | 不发送，不作为配置标识。 |
| `language` | 项目识别语言标识，如 `zh_cn`、`en_us`。 | 与 `accent/rlang` 共同查找 `lanid`，不是接口语言代码。 |
| `accent` | 项目方言或选项分组标识。外语中的 `mandarin` 是内部占位值，不表示以普通话识别。 | 不单独发送，由完整三元组决定 `lanid`。 |
| `rlang` | 项目输出字形选项：`""` 为默认项，`zh-hk` 为当前普通话繁体选项。 | 接口没有独立 `rlang` 参数；普通话繁体通过 `lanid="100"` 选择，不表示任意语种都支持繁体转换。 |
| `value` | 设置保存的翻译语言标识。 | 按翻译表映射为开放平台 `from/to`；中文 `cn → zh`，其余当前选项同值。 |
| `locale` | 翻译源关联的项目识别语言。 | 匹配 `language=locale, accent=mandarin, rlang=""`，再取得 `lanid`；不发送到翻译接口。 |

三元组完整保存，保留大小写、连字符、下划线及空字符串；不能直接拼成服务端参数。实时识别的 `fromlan/tolan` 与文本翻译的 `from/to` 分别使用各自文档的代码表，例如马来语在前者标为 `ml`、后者为 `ms`，不可混用。

### 语音打字选项

以下 43 项对应运行时 `REC_LANG_LIST`。`language/accent/rlang` 为内部键，`lanid` 为实际识别请求参数；编号在 Query 中以字符串发送。

| 中文名称（zh_name） | 显示文本（label） | 内部 language | 内部 accent | 内部 rlang | 接口 lanid |
| --- | --- | --- | --- | --- | --- |
| 普通话 | 普通话 | `zh_cn` | `mandarin` | `""` | 0 |
| 英语 | English | `en_us` | `mandarin` | `""` | 1 |
| 东北话 | 东北话 | `zh_cn` | `dongbeiese` | `""` | 107 |
| 甘肃话 | 甘肃话 | `zh_cn` | `gansunese` | `""` | 109 |
| 广东话 | 广东话 | `zh_cn` | `cantonese` | `""` | 4 |
| 贵州话 | 贵州话 | `zh_cn` | `guizhounese` | `""` | 110 |
| 河北话 | 河北话 | `zh_cn` | `hebeinese` | `""` | 122 |
| 河南话 | 河南话 | `zh_cn` | `henannese` | `""` | 105 |
| 闽南话 | 闽南话 | `zh_cn` | `minnanese` | `""` | 101 |
| 宁夏话 | 宁夏话 | `zh_cn` | `ningxianese` | `""` | 114 |
| 山东话 | 山东话 | `zh_cn` | `shandongnese` | `""` | 116 |
| 陕西话 | 陕西话 | `zh_cn` | `shanxinese` | `""` | 106 |
| 上海话 | 上海话 | `zh_cn` | `shanghainese` | `""` | 119 |
| 四川话 | 四川话 | `zh_cn` | `lmz` | `""` | 102 |
| 天津话 | 天津话 | `zh_cn` | `tianjinese` | `""` | 108 |
| 云南话 | 云南话 | `zh_cn` | `yunnanese` | `""` | 111 |
| 普通话（繁体） | 普通话（繁體） | `zh_cn` | `mandarin` | `zh-hk` | 100 |
| 阿拉伯语 | عربي | `ar_il` | `mandarin` | `""` | 6 |
| 波兰语 | Polski | `pl_pl` | `mandarin` | `""` | 14 |
| 波斯语 | فارسی | `fa_IR` | `mandarin` | `""` | 42 |
| 丹麦语 | Dansk | `da_DK` | `mandarin` | `""` | 27 |
| 德语 | Deutsch | `de_DE` | `mandarin` | `""` | 11 |
| 俄语 | Русский | `ru-ru` | `mandarin` | `""` | 5 |
| 法语 | Français | `fr_fr` | `mandarin` | `""` | 10 |
| 芬兰语 | Suomi | `fi_fi` | `mandarin` | `""` | 20 |
| 韩语 | 한국어 | `ko_kr` | `mandarin` | `""` | 3 |
| 荷兰语 | Nederlands | `nl_NL` | `mandarin` | `""` | 16 |
| 捷克语 | Čeština | `cs_CZ` | `mandarin` | `""` | 25 |
| 马来西亚语 | Bahasa Melayu | `ms_MY` | `mandarin` | `""` | 24 |
| 葡萄牙语 | Português | `pt_PT` | `mandarin` | `""` | 12 |
| 日语 | 日本語 | `ja_jp` | `mandarin` | `""` | 2 |
| 瑞典语 | Svenska | `sv_SE` | `mandarin` | `""` | 17 |
| 泰语 | ไทย | `th_TH` | `mandarin` | `""` | 31 |
| 土耳其语 | Türkçe | `tr_TR` | `mandarin` | `""` | 13 |
| 西班牙语 | Español | `es_es` | `mandarin` | `""` | 7 |
| 希伯来语 | עברית | `he_il` | `mandarin` | `""` | 21 |
| 希腊语 | Ελληνικά | `el_GR` | `mandarin` | `""` | 23 |
| 意大利语 | Italiano | `it_IT` | `mandarin` | `""` | 8 |
| 印地语 | हिन्दी | `hi_in` | `mandarin` | `""` | 19 |
| 越南语 | Tiếng Việt | `vi_VN` | `mandarin` | `""` | 9 |
| 乌兹别克语 | Uzbek | `uz_UZ` | `mandarin` | `""` | 79 |
| 高棉语 | ភាសាខ្មែរ | `km_KH` | `mandarin` | `""` | 65 |
| 印尼语 | Bahasa Indonesia | `id_ID` | `mandarin` | `""` | 18 |

- 广东话使用粤语编号 `4`；闽南话对应官方闽南语，马来西亚语对应官方马来语。
- 印尼语 `18` 与马来语 `24` 分开映射，不互相替代。
- `shanxinese` 表示陕西话 `106`，不是山西话 `104`。
- 普通话繁体使用 `100`。

### 翻译语言选项

下表全部 28 项对应 `TRANS_TO_LANG_LIST`；其中有 `locale` 的 27 项按同一顺序组成 `TRANS_FROM_LANG_LIST`。目标选项包含 `value / label / zh_name`，源选项另含 `locale`；“—”表示不提供该源语言。

| 中文名称（zh_name） | 显示文本（label） | 内部 value | 内部源语言 locale | 文本翻译 from/to |
| --- | --- | --- | --- | --- |
| 中文 | 中文 | `cn` | `zh_cn` | `zh` |
| 英文 | English | `en` | `en_us` | `en` |
| 日语 | 日本語 | `ja` | `ja_jp` | `ja` |
| 韩语 | 한국어 | `ko` | `ko_kr` | `ko` |
| 德语 | Deutsch | `de` | `de_DE` | `de` |
| 法语 | Français | `fr` | `fr_fr` | `fr` |
| 俄语 | Русский | `ru` | `ru-ru` | `ru` |
| 阿拉伯语 | العربية | `ar` | `ar_il` | `ar` |
| 波兰语 | Polski | `pl` | `pl_pl` | `pl` |
| 波斯语 | فارسی | `fa` | `fa_IR` | `fa` |
| 丹麦语 | Dansk | `da` | `da_DK` | `da` |
| 芬兰语 | Suomi | `fi` | `fi_fi` | `fi` |
| 荷兰语 | Nederlands | `nl` | `nl_NL` | `nl` |
| 捷克语 | Čeština | `cs` | `cs_CZ` | `cs` |
| 马来西亚语 | Bahasa Melayu | `ms` | `ms_MY` | `ms` |
| 蒙古语 | Монгол | `mn` | — | `mn` |
| 葡萄牙语 | Português | `pt` | `pt_PT` | `pt` |
| 瑞典语 | Svenska | `sv` | `sv_SE` | `sv` |
| 泰语 | ไทย | `th` | `th_TH` | `th` |
| 土耳其语 | Türkçe | `tr` | `tr_TR` | `tr` |
| 西班牙语 | Español | `es` | `es_es` | `es` |
| 希伯来语 | עברית | `he` | `he_il` | `he` |
| 希腊语 | Ελληνικά | `el` | `el_GR` | `el` |
| 意大利语 | Italiano | `it` | `it_IT` | `it` |
| 印地语 | हिन्दी | `hi` | `hi_in` | `hi` |
| 越南语 | Tiếng Việt | `vi` | `vi_VN` | `vi` |
| 乌兹别克语 | Uzbek | `uz` | `uz_UZ` | `uz` |
| 高棉语 | ភាសាខ្មែរ | `km` | `km_KH` | `km` |

- 当前鼠标设置中的蒙古语（西里尔）`mn` 仅作为翻译目标；这是产品选项范围，不表示文本翻译接口不支持它作为源语言。
- 文本翻译代码 `zh` 表示简体中文，`cht` 表示繁体中文；当前目标选项仅含简体中文。ASR 的 `rlang` 不决定翻译译文的字形。

## DPI 设置

以下选项对应 `DPI_LIST`，`label` 与 `value` 均为字符串。

| 显示文本（label） | 配置值（value） |
| --- | --- |
| 800 | `800` |
| 1200 | `1200` |
| 1600 | `1600` |
| 2400 | `2400` |

保存的 DPI 数值需转换为固件档位后下发，不直接作为协议字节。映射配置见 [开发说明](../contributing/development.md#技术配置与服务限制)。指令仅作用于当前 SN；下发成功不代表硬件确认生效，失败可重试。

## M 键设置

### 动作选项

以下 6 项对应 `M_KEY_FUNC_LIST`。

| 显示文本（label） | 配置值（value） |
| --- | --- |
| 回车 | `enter` |
| 后退 | `backspace` |
| 语音翻译 | `translate` |
| 语音打字 | `voice_input` |
| 语音搜索 | `speechSearch` |
| 一键链接 | `openWebUrl` |

“后退”执行 Backspace。语音打字、翻译和搜索使用当前鼠标的音频及设置；一键链接打开配置的 URL。动作执行规则见[插件规格第 3.3 节](smart-mouse-plugin.md#33-m-键动作)。

### 搜索引擎

以下 3 项对应 `M_KEY_SEARCH_URL_LIST`，`value` 为完整 URL 前缀。

| 显示文本（label） | 配置值（value） |
| --- | --- |
| 百度 | `https://www.baidu.com/baidu?wd=` |
| bing | `https://www.bing.com/search?q=` |
| google | `https://www.google.com/search?q=` |

搜索地址为所选前缀加 `encodeURIComponent(最终识别文本.trim())`。识别使用语音打字语言，不翻译搜索词；仅在识别成功且文本非空时打开浏览器。

### 一键链接

`linkUrl` 最长 4096 字符。输入框右侧提供“确认”按钮，不显示“链接地址”标签或行内校验提示。输入和失焦时只保留草稿，点击“确认”后去除首尾空白并校验，允许省略 `http://` 或 `https://`（例如 `www.google.com`），也支持完整 HTTP/HTTPS 地址；输入框、保存值及传给浏览器的地址均保留原文，不自动补写协议，不允许凭据、内部空白、控制字符或反斜杠。有效地址与当前动作一并保存，保存成功后 toast 提示“链接设置成功，已生效”，后续按键使用新地址；无效地址或保存失败通过 toast 报错，修改不生效，仍使用此前已保存的设置。保存期间禁用确认按钮。设备状态刷新不覆盖地址草稿。

## 语音键与 AI 键

| 按键 | 显示文本 | 配置值 |
| --- | --- | --- |
| 语音键 | 语音打字 | `voice_input` |
| 语音键 | 语音翻译 | `translate` |

AI 键显示标题“AI 键”和说明“长按语音打字，松手自动将文字填充到 AI 对话输入框”，右侧显示“自动发送”开关，复用“标点符号”开关的样式与交互。不提供动作下拉框，内部配置 `aiAction: openAi` 保留。

“自动发送”对应 `aiAutoSend`，默认开启，按设备 SN 保存；旧配置缺少该字段时按开启读取，“恢复默认”也恢复为开启。开启时，语音识别结束并成功填充后自动发送；关闭时仅填充草稿，由用户手动发送。录音使用按下时的配置，开关修改影响后续会话；语音键与 M 键不受影响。

AI 键仅作用于 DeepSeek Harness：不在前台时自动调至前台；已在 AI 对话页时使用当前对话，否则新建对话。长按语音打字、松开结束录音，最终文字自动填充目标对话输入框，不要求输入框已获得焦点，随后按“自动发送”设置决定是否发送。完整规则及实现状态见[插件规格第 3.4 节](smart-mouse-plugin.md#34-ai-键动作)及第 9 节。

## 保存与校验

链接地址点击“确认”后校验并保存，其余有效修改自动保存并应用到当前 SN；无效配置提示尚未生效，保存失败回退到已确认配置。“恢复默认”重置当前设备全部偏好，不影响其他设备和共享 ASR 配置。语音会话固定使用启动时的设置，修改影响后续会话。

设置菜单仅展示本文选项。已保存的语言值若不在支持范围内，界面显示“请重新选择”并阻止相关语音请求，不自动切换语言；选择有效语言或恢复默认后才保存。

自定义 `recognitionLanguages` 替换内置 ASR 映射，语言范围仍以上表为准；缺少映射的选项禁用。

## 验证状态

语言范围已完成官方文档核对。普通话、英语、日语、粤语、法语及普通话繁体已通过合成语音抽样验证；其余识别选项尚未逐项实网验收。开放平台文本翻译已接入，自动化覆盖请求、响应及鉴权重试，实网链路待验证。DPI 固件映射和系统按键动作仍需实机验收。
