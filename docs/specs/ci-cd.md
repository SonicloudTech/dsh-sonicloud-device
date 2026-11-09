# CI/CD 发布方案

状态：计划，尚未实现。仅定义 GitHub Actions 流程，不包含工作流代码。

## 1. 触发与产物

正式 npm 包名：`@sonicloud/dsh-sonicloud-device`，公开发布到 `https://registry.npmjs.org/`。

| 事件 | 操作 | 产物去向 |
| --- | --- | --- |
| `push dev` | 校验、测试、构建测试版 `.tgz` | 上传 Actions Artifact，不发布 npm |
| `push main` | 校验、测试、构建正式版 `.tgz` | 上传 Actions Artifact，发布 npm `latest` |

仅使用 `release.yml`，监听 `dev`、`main` 两个分支的 `push` 事件。`main` 的每次推送均视为一次正式发布请求；结果、更新日志和包地址统一展示在 Actions 运行摘要中。

## 2. 版本与更新日志

- 正式版本以 `package.json.version` 为准，必须是未发布、比当前正式版高的稳定 SemVer 版本；`package-lock.json` 同步更新。CI 不自动提交版本修改。
- 测试版本格式：`<目标正式版本>-dev.<run_number>.<run_attempt>`，例如 `0.3.0-dev.128.1`；仅修改 CI 工作副本中的包版本及锁文件。
- 开发阶段在两份 CHANGELOG 的“未发布 / Unreleased”中维护变更；正式发布前，移入对应版本和日期章节，保留顶部未发布章节。格式遵循 [项目规范](../AGENTS.md)。
- 测试运行摘要读取当前提交的中文“未发布”章节，标明“本轮累计变更”；正式运行摘要读取当前版本章节，附对应提交的完整日志链接。
- 无变更说明、正式版本重复或中英文版本/日期/分类/条目结构不一致时，停止发布并报告原因；翻译内容一致性由维护者确认。

## 3. 构建与分发

共用流程：检出触发提交 → `npm ci` → `npm test` → `npm pack` → 检查包内容并记录 SHA-256。当前 `pretest`、`prepack` 已负责构建，无需额外重复调用 `npm run build`。

- 使用 GitHub 托管 runner，固定 Node 24 和满足 OIDC 要求的 npm 版本；正式发布环境不复用依赖缓存。
- 包内必须包含 `dist/client.js`、宿主源码、`cordis.patch.yml`、平台原生库及许可证；不得包含开发链接产物、测试凭据或发布密钥。包名迁移后验证 patch 引用和安装入口。
- 每次打包生成 `.tgz`、校验文件和发布信息（版本、提交 SHA、工作流地址）；包名与文件名从打包结果读取，不硬编码。
- 测试产物上传 Actions Artifact，保留 30 天；运行摘要提供下载地址及有效期。下载后解压外层归档获得 `.tgz`。下载需要登录 GitHub；公开仓库的 Artifact 不作为内部保密分发渠道。[下载规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
- 正式产物与发布信息先存入 Artifact，保留 30 天供重跑核对；再发布已经检查的同一份 `.tgz`，指定 `--access public --tag latest`。发布后查询 npm，确认版本、`latest` 和包完整性一致；运行摘要提供 npm 版本页面和该版本 `dist.tarball` 下载地址。
- CI 通过仅代表自动化验证通过；推送到 `main` 前完成 [README 验收项](../README.md) 中与本次变更相关的实机验证。

安装前完全退出 Harness，安装后重新启动并启用插件：

```sh
# 测试包：文件名以实际产物为准
dsh plugin --profile desktop add /绝对路径/测试包.tgz

# 正式包：替换为本次确切版本
dsh plugin --profile desktop add @sonicloud/dsh-sonicloud-device@<版本>
```

## 4. 权限与首次配置

- 包名从 `dsh-sonicloud-device` 迁移到 `@sonicloud/dsh-sonicloud-device`；同步锁文件、patch 中的包引用、开发安装脚本和文档。保留插件实例 ID 与配置存储键，验证旧包移除、新包安装及配置保留。
- 配置 GitHub 仓库 `repository` 元数据、`sonicloud` 组织发布权限及公开许可。首次由维护者完成受控发布并配置 npm Trusted Publisher，后续交给 CI。
- Trusted Publisher 绑定实际 GitHub 所有者、仓库、`release.yml` 和 `npm-production` Environment，并允许直接 `npm publish`。Environment 限定 `main` 分支，不增加额外人工审批。[npm OIDC 配置](https://docs.npmjs.com/trusted-publishers/)
- 默认仅授予 `contents: read`；仅正式发布 job 授予 `id-token: write`，不配置长期 npm 发布 Token。
- 第三方 Actions 固定提交 SHA，日志内容按数据处理，不直接拼接执行命令。[GitHub 安全说明](https://docs.github.com/en/actions/reference/security/secure-use)
- 仓库公开前处理 `src/asr/config.mjs` 中的内置凭据及 Git 历史中的秘密；CI Secrets 不得重新注入公开源码或安装包。

## 5. 失败与重跑

- 测试、构建或包检查失败：停止上传和发布，在 Actions 运行摘要中记录失败阶段，仅展示实际可用的产物链接。
- 正式发布串行执行，不取消正在进行的发布；新发布不得使 `latest` 回退。发布前再次核对 npm 版本状态，重复版本不覆盖。
- 同一次运行重试时，若 npm 已存在该版本，核对已保存发布记录与 npm 包完整性；一致则继续验证并补全运行摘要，不一致或无法核对则失败，禁止静默跳过。
- 已发布问题版本通过新修复版本替代，不自动删除或覆盖现有 npm 版本。

## 6. 验收与待配置

验收：仅 `push dev/main` 触发；`dev` 产出可安装测试包；`main` 发布 npm 正式版；运行摘要中的版本、日志和产物对应；失败及重跑不误报、不重复发布；首次迁移保留既有配置。

待配置：GitHub 仓库地址、首个正式版本、npm `sonicloud` 组织权限及 Trusted Publisher。
