# CI/CD 发布规格

状态：已实现工作流和发布校验工具；平台发布验证见第 6 节。工作流：[`release.yml`](../../.github/workflows/release.yml)，校验与发布工具：[`scripts/ci`](../../scripts/ci/)。

GitHub 仓库：[SonicloudTech/dsh-sonicloud-device](https://github.com/SonicloudTech/dsh-sonicloud-device)。

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
- 开发阶段在两份 CHANGELOG 的“未发布 / Unreleased”中维护变更；正式发布前，建议移入对应版本和日期章节，保留顶部未发布章节——未折叠时发布流程自动回退采用未发布章节内容，完全折叠（无未发布章节）时直接采用当前版本章节。格式遵循 [项目规范](../../AGENTS.md)。
- 测试运行摘要读取当前提交的中文“未发布”章节，标明“本轮累计变更”；正式运行摘要读取当前版本章节（无版本章节时回退读取未发布章节），附对应提交的完整日志链接。
- 无变更说明、正式版本重复或中英文版本/日期/分类/条目结构不一致时，停止发布并报告原因；翻译内容一致性由维护者确认。

## 3. 构建与分发

共用流程：检出触发提交 → `npm ci` → `npm test` → `npm pack` → 检查包内容并记录 SHA-256。当前 `pretest`、`prepack` 已负责构建，无需额外重复调用 `npm run build`。

- 使用 GitHub 托管 runner，固定 Node 24.18.0 和 npm 11.16.0（OIDC 要求 npm ≥ 11.5.1）；正式发布环境不复用依赖缓存。
- 包内必须包含 `dist/client.js`、宿主源码、`cordis.patch.yml`、平台原生库及许可证；不得包含开发链接产物、测试凭据或发布密钥。包名迁移后验证 patch 引用和安装入口。
- 每次打包生成 `.tgz`、校验文件和发布信息（版本、提交 SHA、工作流地址）；包名与文件名从打包结果读取，不硬编码。
- 测试产物上传 Actions Artifact，保留 30 天；运行摘要提供下载地址及有效期。下载后解压外层归档获得 `.tgz`。下载需要登录 GitHub；公开仓库的 Artifact 不作为内部保密分发渠道。[下载规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
- 正式产物与发布信息先存入 Artifact，保留 30 天供重跑核对；再发布已经检查的同一份 `.tgz`，指定 `--access public --tag latest`。发布后等待 npm 异步处理（最多 3 分钟），查询并下载 npm 产物，确认版本、`latest`、SRI 和 SHA-256 一致；运行摘要提供 npm 版本页面和该版本 `dist.tarball` 下载地址。
- CI 通过仅代表自动化验证通过；推送到 `main` 前完成 [README 使用流程](../../README.zh.md) 中与本次变更相关的实机验证。

测试包与正式包的安装、更新和旧包迁移见 [README](../../README.zh.md#安装与启用)。

## 4. 权限与首次配置

### 4.1 仓库与包准备

- 包元数据与 `package-lock.json` 保持一致；`repository` 指向上述仓库。插件实例 ID 与设备配置存储键保持兼容，包名迁移须验证旧包移除、新包安装及配置保留。
- 项目代码采用 MIT 许可，原生 SDK 和第三方组件保留各自许可。
- 第三方 Actions 固定提交 SHA，日志内容按数据处理，不直接拼接执行命令。[GitHub 安全说明](https://docs.github.com/en/actions/reference/security/secure-use)
- 当前 `src/asr/config.mjs` 不含内置凭据；打包检查拒绝常见密钥和凭据字面量。CI Secrets 不得注入公开源码或安装包，历史泄露凭据需单独撤销。

### 4.2 npm `sonicloud` 组织权限

npm 组织 `sonicloud` 与 GitHub 组织 `SonicloudTech` 独立管理，加入 GitHub 组织不会自动获得 npm 发布权限。

1. 在 npm 登录个人账号并启用 2FA。由 npm `sonicloud` 的 Owner 在组织设置中邀请该账号，接受邀请；组织尚未创建时，先确认名称可用并创建。
2. 首次创建组织包可使用 Member 角色；Owner 负责成员与角色管理，Admin 可管理团队和包访问权限，无需仅为发布授予 Owner。[组织角色说明](https://docs.npmjs.com/organization-roles-and-permissions/)
3. 包已存在时，在 npm 的 Account → `sonicloud` → Teams → 发布者所在团队 → Packages 中，添加 `@sonicloud/dsh-sonicloud-device` 并授予 `read/write`。新包首次发布后也应检查团队权限。[团队包权限设置](https://docs.npmjs.com/managing-team-access-to-organization-packages/)

### 4.3 首次发布

首次建包由维护者发布首个正式版本，再为该包配置 Trusted Publisher。若目标包已有版本，先确认维护权限和已发布版本，跳过首次建包步骤。

完成 4.1 后，在本地执行以下命令；发布参数使用已经检查的实际 `.tgz` 路径，按提示完成账号验证：

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish /绝对路径/已检查的正式包.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

组织作用域包需显式指定 `--access public` 才会公开发布。[发布组织包](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/)

手动发布会占用该版本；后续 CI 首次发布必须使用更高的新版本，并同步两份 CHANGELOG，不能重新发布手动发布过的版本。

### 4.4 GitHub Environment 与 npm Trusted Publisher

首次配置时先提交 `.github/workflows/release.yml`，再配置 Trusted Publisher；现有配置与验证记录见第 6 节。

1. 在 [仓库设置](https://github.com/SonicloudTech/dsh-sonicloud-device/settings/environments) → Environments 创建 `npm-production`。Deployment branches and tags 选择 Selected branches and tags，仅添加 Branch 类型的 `main`；不设置 Required reviewers。私有组织仓库使用此功能需 GitHub Team 或 Enterprise，本仓库的配置记录见第 6 节。[Environment 配置](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
2. 正式发布 job 仅在 `main` 运行，声明 `environment: npm-production`；默认权限为 `contents: read`，仅该 job 增加 `id-token: write`。按第 3 节发布已检查的 `.tgz`，不配置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN` 发布密钥。
3. 由具备包设置权限的维护者打开 [npm 包页面](https://www.npmjs.com/package/@sonicloud/dsh-sonicloud-device) → Settings → Trusted publishing，添加 GitHub Actions，按下表填写并保存。

| npm 字段 | 配置值 |
| --- | --- |
| Organization or user | `SonicloudTech`（GitHub 所有者，不填 npm 组织名） |
| Repository | `dsh-sonicloud-device` |
| Workflow filename | `release.yml`（不含目录） |
| Environment name | `npm-production` |
| Allowed actions | 启用直接 `npm publish`；不需要额外启用 `npm dist-tag` |

字段需大小写完全匹配。新建配置后须在 **2 天内成功发布一次**；过期则删除并重新创建。配置保存成功不代表发布验证通过，应以首次 OIDC 发布结果为准。[npm Trusted Publisher 配置与限制](https://docs.npmjs.com/trusted-publishers/)

4. 完成首次 CI 发布并核对 npm 版本、`latest` 和包完整性后，可在包 Settings → Publishing access 选择 Require two-factor authentication and disallow tokens；该设置不阻止 Trusted Publisher 使用 OIDC 发布。

## 5. 失败与重跑

- 测试、构建或包检查失败：停止上传和发布，在 Actions 运行摘要中记录失败阶段，仅展示实际可用的产物链接。
- 正式发布串行执行，不取消正在进行的发布；新发布不得使 `latest` 回退。发布前再次核对 npm 版本状态，重复版本不覆盖。
- 同一次运行重试时，恢复该运行保存的正式 Artifact 并重新执行测试，不重新打包；记录必须匹配仓库、提交 SHA、运行 ID、包名、版本和哈希。若 npm 已存在该版本，再核对 npm 完整性与 `latest`；一致则补全摘要，不一致、产物过期或记录缺失则失败。
- 重跑前确认原 Artifact 仍可下载；仅发布 job 失败时优先重跑失败 job，保留构建结果。若原 Artifact 已不可用，不用新打包结果冒充原产物，也不重新发布已存在版本；核查首次发布结果后，后续改动使用新版本。
- 已发布问题版本通过新修复版本替代，不自动删除或覆盖现有 npm 版本。

## 6. 验收与平台状态

验收：仅 `push dev/main` 触发；`dev` 产出可安装测试包；`main` 发布 npm 正式版；运行摘要中的版本、日志和产物对应；失败及重跑不误报、不重复发布；首次迁移保留既有配置。

以下为 2026-11-09 的验收记录，不表示平台实时状态；插件功能的实机范围见[开发说明](../contributing/development.md#已有验证记录)。

| 范围 | 结果与证据 |
| --- | --- |
| 本地校验 | 全量测试、正式包内容、隔离 Harness profile 迁移及 actionlint 通过；插件 ID 与配置数据保留 |
| 平台配置 | 仓库公开；`npm-production` 仅允许 `main`、无人工审批；维护者具备 npm `sonicloud` Owner 权限并启用 2FA；Trusted Publisher 按第 4.4 节保存且当时状态为 `Valid` |
| 测试分支 | [`dev` 实际运行](https://github.com/SonicloudTech/dsh-sonicloud-device/actions/runs/42594309932)通过，上传测试产物，跳过 npm 发布 |
| 首次建包 | `0.1.0` 由维护者发布，核对版本、`latest`、SRI 和下载 SHA-256；临时登录已撤销，凭据文件已删除 |
| OIDC 发布 | [`0.1.1` 第 1 次尝试](https://github.com/SonicloudTech/dsh-sonicloud-device/actions/runs/42595306280/attempts/1)通过；当时 `latest=0.1.1`，SRI、SHA-256 及 provenance 的仓库、分支、工作流、提交均匹配 |
| 产物缺失保护 | [`0.1.1` 第 2 次尝试](https://github.com/SonicloudTech/dsh-sonicloud-device/actions/runs/42595306280/attempts/2)在 preflight 停止，未重新打包或重复发布；原 Artifact 列表为空、ID 查询返回 404，消失原因未确定，首次 npm 发布不受影响 |

尚未完成平台验收：原 Artifact 可用时的成功恢复分支；该分支已通过本地测试。
