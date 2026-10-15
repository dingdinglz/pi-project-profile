# pi-project-profile

让 Pi 记住每个工作目录上次使用的模型和思考强度。

在项目 A 选一个模型，在项目 B 选另一个；下次分别进入两个目录启动 Pi，就不用重新选择。支持 Pi 已注册的内置和自定义供应商，同名模型按供应商区分。

## 安装

需要 Node.js 22.19+、Pi 1.2.0+（`@earendil-works/pi-coding-agent`）。

从 GitHub 安装：

```bash
pi install git:github.com/dingdinglz/pi-project-profile
```

或克隆后在本仓库目录执行：

```bash
pi install .
```

这是**全局安装扩展**，不是全局保存模型：扩展在各项目中加载，偏好分别保存在各自的 `.pi/profile.json`。本地安装引用当前路径，不会复制源码，安装后请保留本仓库。

重启 Pi 后生效。也可以先临时试用：

```bash
cd /path/to/your-project
pi -e /absolute/path/to/pi-profile/src/index.ts
```

不需要构建或在每个项目安装依赖。供应商、API key 和登录状态仍由 Pi 管理。

## 使用

1. 在项目目录启动 `pi`。
2. 用 `/model` 或模型切换快捷键选择模型，用 `/thinking` 或思考强度快捷键调整强度。
3. 扩展自动保存到当前目录的 `.pi/profile.json`。
4. 退出后，在同一目录重新启动 `pi`，自动恢复保存的选择。

不需要在 Pi 的选择器里按 `Ctrl+S`；那个操作保存的是 Pi 自身的启动默认值。

首次启动且没有切换时，不会创建文件。也可以用 `/profile save` 主动保存当前选择。

```json
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "thinkingLevel": "high"
}
```

只保存这四个字段，不包含 API key、token、端点或聊天内容。思考强度支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，实际生效值仍受模型能力限制。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/profile` 或 `/profile show` | 查看文件路径、保存的配置和当前选择 |
| `/profile save` | 立即保存当前模型和思考强度 |
| `/profile clear` | 删除配置；下一次切换时重新记录 |
| `pi --no-profile` | 本次运行停用项目模型记忆 |

## 行为边界

- 以 Pi 的工作目录为单位，不搜索父目录或 Git 根目录。在子目录启动 Pi，会使用子目录自己的配置；工具里的 `cd` 不会改变 Pi 的工作目录。
- 自动行为仅面向交互式 TUI；print、JSON、RPC 和非 TUI SDK 会话不自动恢复或保存，避免影响脚本和子代理。
- 显式传入 `--model`、`--provider`、`--models`、`--thinking` 或 `--api-key` 时，本次运行不自动恢复或保存项目配置。这些参数作为临时选择；需要记住时使用 `/profile save`。
- 继续已有对话时，保留该会话的模型选择，不用项目配置覆盖历史状态。之后实际切换仍会更新项目配置。
- 供应商未注册、模型已删除或认证不可用时，提示后保留 Pi 的当前选择，不覆盖原配置。
- 损坏或不支持的配置不会被自动覆盖。修复文件后重新启动，或用 `/profile save` 明确替换。
- 不修改 `.pi/settings.json` 或全局默认设置。通过 `model_select` / `thinking_level_select` 事件保存，没有轮询或常驻定时器。同一会话中其他扩展引起的模型/思考变化也会被记录。
- 遵守 `ctx.isProjectTrusted()`：不信任项目或使用 `--no-approve` 时，不读写配置。注意只有 `.pi/profile.json` 的目录不会触发 Pi 内置的信任询问；共享此文件等于共享模型偏好，请检查其中的供应商和模型。
- 写入通过同目录临时文件原子替换。多个 Pi 同时打开同一个目录时，最后一次切换写入生效；未切换的会话不会在退出时覆盖别人的选择。

不想提交个人偏好时，在项目 `.gitignore` 加入：

```gitignore
.pi/profile.json
.pi/.profile-*.tmp
```

## 开发

```bash
npm install --ignore-scripts
npm run check
npm test
```

运行时只依赖 Node.js 标准库；Pi 提供扩展 API。测试使用临时目录，不读取个人凭据，也不调用模型服务。

## 许可证

[MIT](LICENSE)
