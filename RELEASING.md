# 发布说明（npm Trusted Publishing + 分阶段发布 / staged publishing）

本仓库的发布**完全不使用任何 npm token**，而且 **CI 没有发布权限，只有送审权限**：

```
tag push ──► GitHub Actions（OIDC 身份，权限 = npm stage publish）
                │  门禁校验 + 打包取证 + 送审
                ▼
          npm staging 区（还没上线）  ◄── 维护者本机核对 + 2FA 批准
                │
                ▼
          正式发布（带 provenance 证明）
```

凭证只有一个：GitHub 在 job 内签发的 OIDC 身份，npm 校验「这个身份 + 这个仓库 + 这个工作流文件 +
这个环境 + 这个权限」后才接受送审，并自动生成 provenance 证明。即使 CI 被攻破，攻击者也只能送审，
**无法让包上线** —— 上线必须由维护者在本机用 2FA 批准。

工作流文件：`.github/workflows/publish.yml`（文件名会被 npm 校验，改名必须同步改 npm 侧配置）。

## 一次性配置

### 1. npm 侧：配置 Trusted Publisher

在 <https://www.npmjs.com/package/antd3-esm/access> 的 **Trusted Publisher** 处选择 GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization or user | `citisen` |
| Repository | `antd3-esm` |
| Workflow filename | `publish.yml` |
| Environment name | `npm-publish` |
| Permissions | **`npm stage publish`**（只送审，不能直接发布） |

> 前提：包必须已在 npm 上存在（首次发布新包名不能用 trusted publishing，需要先用 token 发一次；
> `antd3-esm` 已存在，所以不需要）。
> 配置完成后，删除仓库里可能存在的 `NPM_TOKEN` secret —— 本工作流不读取任何 secret。

### 2. npm 侧：把发布权限收紧到「必须 2FA、禁止 token」

在同一个页面（Package → Settings → **Publishing access**）选择
**“Require two-factor authentication and disallow tokens”**。

### 3. GitHub 侧：给发布环境加人工审批

`Settings → Environments → npm-publish`：

- **Required reviewers**：加上维护者本人（谁能触发 CI 送审也需要人工确认）。
- **Deployment branches and tags**：只允许 tag，规则填 `v*`。
- 该环境被工作流引用，若尚未创建，GitHub 会在第一次运行时自动创建（无任何保护），建议提前手动建好。

## 发布流程

```bash
# 1. 改版本号（必须是 npm 上还不存在的版本）
npm version patch --no-git-tag-version   # 或直接改 package.json

# 2. 提交
git commit -am "chore: release vX.Y.Z"
git push

# 3. 打 tag 并推送 —— 只有这一步会触发 CI 送审
git tag vX.Y.Z
git push origin vX.Y.Z
```

CI 跑完后，job summary 里会有 **stage id** 和 **integrity**，以及可以直接复制的命令。

```bash
# 4. 控制台先看一眼这次送审的内容
npm stage view <stage-id>

# 5. 本机核对（下载 registry 上的 staged tarball，逐字节比对 CI 指纹；不带 --approve 时只核对）
node .github/scripts/approve-stage.mjs <stage-id> --expect-integrity <sha512-...>

# 6. 核对通过后批准（会要求输入 2FA 的 OTP，这一步才真正发布）
node .github/scripts/approve-stage.mjs <stage-id> --expect-integrity <sha512-...> --approve

# 7. 批准后核对线上产物（integrity / shasum / registry 签名 / provenance）
node .github/scripts/verify-published.mjs --version X.Y.Z --expect-integrity <sha512-...>
```

不想要这次送审时：

```bash
npm stage reject <stage-id>     # 从 staging 区移除
```

> 提示：staging 区里的内容有生命周期，长期不批准会被清理；要发就尽快批准或 reject 掉重发。

## 各个脚本的职责

| 脚本 | 何时运行 | 做什么 |
| --- | --- | --- |
| `.github/scripts/verify-release.mjs` | CI，送审前 | 门禁：校验 8 类不变量（见下），并打包产出 `release-evidence.json`（含 sha512 SRI / sha1） |
| `.github/scripts/record-stage.mjs` | CI，送审后 | 把 `npm stage publish --json` 的输出与门禁指纹交叉比对，写入 stage id，生成 job summary 与批准命令 |
| `.github/scripts/approve-stage.mjs` | 维护者本机 | `npm stage view` + `npm stage download`，逐字节核对后（可选）执行 `npm stage approve` |
| `.github/scripts/verify-published.mjs` | 维护者本机，批准后 | 校验线上 integrity/shasum/体积、registry 签名、provenance 证明 |

## 门禁校验的是什么（`verify-release.mjs`）

任何一条不满足就中止，不会送审：

1. tag 必须严格等于 `package.json` 的版本，且是合法 semver；
2. `package.json` 不允许有任何会在发布/安装时执行的生命周期脚本
   （`preinstall` / `install` / `postinstall` / `prepare` / `prepublish*` / `prepack` / `postpack`）——
   否则脚本能拿到 OIDC 权限；
3. `publishConfig` 必须指向 `https://registry.npmjs.org/`、`access: public`、`provenance: true`；
4. 依赖里不允许出现 `file:` / `link:` / `git:` / `http` / `workspace:` 等非 registry 协议；
5. 仓库内不允许存在 `.npmrc`；
6. `npm pack` 的文件清单必须在白名单内（`dist/**`、`package.json`、LICENSE/README/NOTICE/CHANGELOG），
   且 `exports` 里声明的每个入口都真实存在于包内；
7. CI 环境必须「零 token」：存在 `NPM_TOKEN` / `NODE_AUTH_TOKEN` 直接失败，
   同时必须存在 `ACTIONS_ID_TOKEN_REQUEST_*`（证明 `id-token: write` 生效）；
8. tag 指向的提交必须位于默认分支 `main` 上（防止从游离提交发布）。

## 其他保证

- 触发器只有 `push` tag `v*`：没有 `workflow_dispatch`、没有分支发布、没有本地发布入口
  （`publishConfig.provenance: true` 也会让本地 `npm publish` 直接失败）。
- job 权限最小化：`permissions: {}` + 仅 `contents: read`、`id-token: write`。
- 第三方 action 全部按 commit SHA 固定，runner 固定 `ubuntu-24.04`。
- npm CLI 版本钉住（见工作流的 `NPM_VERSION`），并断言 `npm stage publish` 真实可用。
- 不执行任何依赖包代码：CI 不 `npm install` 依赖，发布的 `dist/` 就是仓库里已提交、可 review 的产物；
  job 级 `NPM_CONFIG_IGNORE_SCRIPTS=true` 再兜一层。
- 同一时间只允许一个发布在跑（`concurrency: npm-publish`），且不取消进行中的送审。
