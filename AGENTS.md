# Repository Guidelines

## 项目结构与模块职责

本仓库是一个 TypeScript 编写的 VS Code 扩展。`src/extension.ts` 是扩展入口，负责激活、命令注册、编辑器上下文收集与发送流程；`src/aibp.ts` 实现 AIBP 协议、实例发现和 Unix socket 通信。编译产物位于 `out/`，由 TypeScript 生成且不应手动修改。扩展图标在 `images/`，README 截图在 `screenshots/`；发布元数据和命令贡献配置集中在 `package.json`。

## 构建、调试与打包

- `npm install`：安装开发依赖。
- `npm run compile`：以严格 TypeScript 配置编译 `src/` 至 `out/`；提交前必须通过。
- `npm run watch`：启动持续编译，适合本地开发。
- 在 VS Code 中按 `F5`：启动扩展开发宿主进行手动验证。
- `npm run package`：使用 `vsce` 生成可发布的 `.vsix` 包。

## 代码风格与命名

遵循 `.editorconfig`：UTF-8、LF、2 空格缩进、行尾无多余空白且文件以换行结束（Markdown 可保留行尾空白）。TypeScript 使用双引号和分号，保持 `strict` 类型检查。接口、类型和类用 PascalCase，例如 `ContextPayload`；函数、变量和字段用 camelCase，例如 `discoverAsync`。将协议、VS Code API 与 UI 流程的职责保持在相应模块中，避免在入口文件复制协议逻辑。

## 测试与验证

当前未配置自动化测试框架或覆盖率门槛。每次代码修改至少运行 `npm run compile`，并在扩展开发宿主中手动验证受影响命令、选区/输入文档传递以及 AIBP 发送结果。新增测试基础设施时，将测试放在与 `src/` 对应的位置，并使用 `*.test.ts` 命名。

## 提交与拉取请求

提交信息采用 Conventional Commits 风格，如 `feat(scope): 添加能力`、`fix: 修复问题`、`docs: 更新说明`、`chore(package): 更新版本`。每个提交聚焦单一变更。拉取请求应说明用户可见行为、验证命令和手动测试场景；涉及命令 UI、状态栏或截图时附上更新后的截图，并关联相关 issue。

## 配置与发布

不要提交 `node_modules/`、`out/` 或生成的 `.vsix` 文件。修改 `package.json` 中的命令、激活事件或贡献点后，重新编译并通过 `F5` 验证；发布前再执行 `npm run package` 检查包内容。
