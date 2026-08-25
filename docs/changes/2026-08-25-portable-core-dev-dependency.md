# Core 开发依赖改为可迁移的 Git 精确提交

日期：2026-08-25

## 现象

Maintenance 从 Sidechat 提交创建临时干净工作树时，安装阶段尝试访问工作树外的 `../dsh-annotation-core/dsh-annotation-core-0.1.0.tgz`，因此无法构建内容寻址产物，也无法为 Generation 写入可追溯部署记录。

## 原因

运行时依赖已经正确声明为 `peerDependencies`，但开发依赖仍指向本机相邻目录。该路径只在原开发机布局中成立，不属于 Git 提交的一部分。

## 修复

- 开发依赖固定到公开仓库 `linmu115/dsh-annotation-core` 的精确提交。
- Core 使用标准 `prepare` 钩子，在作为 Git 依赖安装时生成未纳入 Git 的 `lib/`。
- 中英文 README 增加 Core 仓库链接；运行时仍要求 Core 作为 DSH `web` Profile 的独立顶层插件安装。

## 验证

- 在临时干净 Git 工作树中执行 `pnpm install`。
- `pnpm typecheck`、`pnpm build`、`pnpm test`。
- Maintenance 能从精确 Sidechat 提交生成 artifact 并写入部署账本。
