# 发布说明

## 首次开源发布（v0.1.0）

1. 在将要推送的 Git 工作区检查 `package.json` 版本为 `0.1.0`，并运行 `node scripts/preflight.mjs`、`npm ci --prefix test && npm test --prefix test`、`npm pack --dry-run --json`。确认包内仅有运行文件与公开文档、预览图，没有测试依赖或本地配置。
2. 检查 Git 将提交的文件及历史，确保没有密钥、个人配置或官方样式导出。`.gitignore` 已排除 `node_modules/`、`platform-css/`、`.env*`、`.npmrc` 等本地内容。
3. 将完整源码推送到 `SHISHISHI465/dsh-effort-minimal`，确认 GitHub 页面显示源码、README、MIT 许可和工作流。仓库 About 建议填写：`DSH reasoning-effort control for the composer, with a minimal slider and model switcher.`；主题建议使用 `dsh-plugin`、`deepseek-harness`、`reasoning-effort`。
4. 若只发布 GitHub 源码，可创建 `v0.1.0` tag 与 GitHub Release，并使用 [CHANGELOG](../CHANGELOG.md) 的 `v0.1.0` 条目作为说明。
5. 若也要发布 npm，首次需由包拥有者在本地登录 npm 后运行 `npm publish --access public`，确认 `dsh-effort-minimal@0.1.0` 可见。随后到 npm 包设置中添加 GitHub Actions Trusted Publisher：用户 `SHISHISHI465`、仓库 `dsh-effort-minimal`、工作流文件名 `publish.yml`。完成后创建 GitHub Release。

## 后续版本

1. 更新 `package.json` 版本与 `CHANGELOG.md`，运行预检、测试和打包检查。
2. 推送源码与相同版本的 tag，例如 `v0.1.1`。
3. 在 GitHub Actions 手动运行 `publish` 工作流，输入已存在的 tag。工作流会核对 tag 与 `package.json` 的版本、运行检查，并通过 npm Trusted Publishing 发布。该工作流不会因创建 GitHub Release 自动运行。
4. npm 发布成功后，创建同版本 GitHub Release，并核对 GitHub 源码与 npm 包内容。

发布工作流不使用仓库内的 npm token。可信发布依赖 npm CLI `>=11.5.1`、Node `>=22.14.0` 和 GitHub 的 OIDC 权限；见 [npm 官方文档](https://docs.npmjs.com/trusted-publishers/)。
