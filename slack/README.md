# MAC-hand · Slack

在 Slack 手机上继续本机 Orca 中的 Claude Code 会话。支持每个会话一个独立私有频道；在电脑终端里输入的内容和模型回复也同步到对应频道。保留原有线程模式。

第一版基于 [feishu-orca](https://github.com/3218923350/feishu-orca) 的工作流独立实现，复用了 MIT 授权的 Claude 记录解析和终端提示解析代码。不会改动现有飞书版的配置、状态或服务。

## 已实现

- `/orca` 和应用 Home 控制台：新建会话、接入运行中的会话、刷新项目与模型。
- 新建时选择 Orca 项目、Claude 模型、思考强度，建立独立工作树。
- 每个会话一个独立私有频道，只有机器人和配置的主人加入；在频道里直接发消息即可继续对应会话。也支持旧版线程模式。
- 电脑与 Slack 双向同步，输出原地更新，长回复自动分段，工具名称和工具报错状态可见。
- 会话卡提供「发指令」「看终端」「中断」「回答 / 按键」「暂停 / 恢复同步」。
- 用「发指令」表单输入 `/compact`、`/clear` 等 Claude 命令，避免与 Slack 自己的斜杠命令冲突。
- 同一终端执行 `/clear` 或切换会话后，按确切 pane 身份跟随；不按目录下最新文件猜测。
- 接收线程里的图片、文件：最多每条 5 个、单个 20 MB，保存在本机供 Claude 阅读。
- 会话列表每页 8 条，显示总数、页码、上一页/下一页；支持全部会话、仅可接入、历史记录与刷新。不可接入的休眠会话、原生聊天或其他模型会显示原因。
- 主人 + Workspace 双重限制，持久化消息去重，重启后保留线程与 Claude 会话映射。
- macOS launchd 安装器、配置向导、doctor、自动化测试。

## 安装

需要 macOS、Node.js 22+、Orca、已经登录的 Claude Code，以及一个可以安装自定义应用的 Slack Workspace。

### 1. 创建专用 Slack 应用

1. 打开 [Slack Apps](https://api.slack.com/apps)，点 **Create New App → From a manifest**。
2. 选择 Workspace，粘贴本项目的 [`slack-manifest.json`](slack-manifest.json)，创建应用。
3. 到 **OAuth & Permissions → Install to Workspace** 安装，取得 **Bot User OAuth Token**（`xoxb-`）。
4. 到 **Basic Information → App-Level Tokens → Generate Token and Scopes**，创建带 `connections:write` scope 的 Token（`xapp-`）。清单已启用 Socket Mode。
5. 创建专用频道（建议私有，例如 `#mac-hand`），执行 `/invite @MAC-hand`。会话内容对这个频道的成员可见。
6. 准备你的 Slack **成员 ID**（个人资料 → ⋯ → Copy member ID）和**频道 ID**（频道详情底部）。

不要把 Token 发到聊天里；下一步在本机终端中隐藏输入。

### 2. 本机配置

在本仓库的 `slack/` 子目录运行：

```bash
npm ci
npm run setup
npm run doctor
./install.sh
```

配置向导会验证 Token、Workspace、机器人是否在频道中以及 Socket Mode 连接，然后将配置保存为权限 `0600` 的本地文件。

安装器将运行代码复制到 `~/Library/Application Support/slack-orca/app`，避免 Documents/iCloud 的文件自动卸载问题。服务名为 `com.slack-orca`，登录 Mac 后自动启动。之后更新源代码再运行 `./install.sh` 即可重新安装并重启。

无需域名、公网服务器或端口映射；Socket Mode 使用本机到 Slack 的出站 WebSocket。[Slack 官方说明](https://docs.slack.dev/apis/events-api/using-socket-mode/)

### 独立聊天模式（从旧版升级）

1. Slack 应用 **OAuth & Permissions → Bot Token Scopes** 添加 `groups:write`，然后 **Reinstall to Workspace** 授权。它允许机器人创建/管理私有频道，并邀请配置的主人。
2. 本地 `~/Library/Application Support/slack-orca/config.json` 设置 `"session_layout": "channel"`，运行 `./install.sh`。
3. 关闭旧弹窗，重新「接入已有会话」。每个会话建立一个 `orca-项目名-随机后缀` 私有频道，频道内卡片显示原始会话标题。重复接入会打开同一频道。
4. 已接入的旧线程会在再次接入时迁移；旧消息保留，后续同步和输入走新频道。失败的迁移保留旧绑定，邀请失败重试不会另建频道。

同一用户和机器人之间的 DM 会复用，因此采用私有频道提供多个独立聊天入口。缺少权限时会显示具体授权步骤，不会悄悄降级回公共频道。

### 3. 开始使用

在 Slack 发 `/orca`，或打开 **MAC-hand Slack → Home**。

| 操作 | 用法 |
|---|---|
| 新会话 | 点「新建会话」，选项目、模型、思考强度，填第一句话 |
| 已有会话 | 点「接入已有会话」，分页查看全部 Orca 会话，选择标记“可接入”的 Claude 终端；也可切换“历史记录” |
| 继续聊天 | 独立频道模式：在对应频道直接发消息；旧版线程模式：在卡片的线程中回复；控制台频道的普通消息不会发给 Claude |
| 发 Claude 命令 | 点「发指令」，输入 `/compact` 或 `/clear` |
| 回答提问 | 看终端后点「回答 / 按键」，选择数字；需要确认时单独发送 Enter |
| 中断 | 点「中断」，向确切的 Claude 终端发送 Esc |
| 暂停 Slack 同步 | 点「暂停同步」；不会关闭本机终端，恢复后补读暂停期间的记录 |

## 稳定性设计

- 发送前匹配 **session ID + 工作目录 + pane + 本地执行主机 + 进程启动时间**，并再次检查终端。
- 查询失败、超时和不完整列表表示“无法确认”，不会清空绑定或误报终端中断。
- 终端已退回 shell 时拒绝发送，不会把聊天文字作为 shell 命令执行。
- Slack 重投事件和重复按钮使用持久化收据去重；发送结果不确定时不会自动重发。
- 新建工作树发生超时不会盲目重新创建；应在桌面检查后接入已创建的会话。
- 断线不会被显示为 Claude 主动中断。实际中断仅从 Claude 会话记录读取。

## 第一版边界

- 支持 **Claude Code 终端**，未实现 Codex 和 Orca 原生聊天标签。
- 不自动恢复已经关闭的 Claude 进程；在 Orca 恢复原会话后，按会话身份重新关联。不会因为一次查询失败另起重复 Claude。
- 没有删除工作树、结束/重开终端按钮；第一版专注聊天和进程状态同步。
- 「接入」从当前记录末尾开始同步，不回放全部历史。
- 工具调用展示名称与报错标记，未实现飞书版的完整可折叠工具参数和结果。
- 不解析 Slack 转发的整个对话历史；需要的上下文请直接贴到线程或上传文件。
- 文件下载不跟随重定向；外部云盘文件或需要跳转的附件会提示无法下载。
- 模型运行在 Mac 上，仍需要电脑唤醒、Orca 运行并能联网。Slack 本身不会让休眠的电脑继续执行任务。
- Orca 的模型目录和会话 hook 数据库属于内部接口。升级后若识别不到会话，先运行 doctor；此版本会拒绝猜测绑定。
- 单人、单 Workspace、一个控制台频道及多个会话私有频道。团队多人权限与应用商店分发不在本版范围。

## 排查和卸载

```bash
npm test
npm run doctor -- --local  # 不需要 Slack Token，只读检查本机 Orca
npm run doctor            # 包括 Slack 配置、频道和 Socket Mode
npm start                 # 前台运行；不要与 launchd 同时运行
launchctl print "gui/$(id -u)/com.slack-orca"
tail -f "$HOME/Library/Application Support/slack-orca/bridge.log"
```

暂停常驻服务（保留配置和会话）：

```bash
launchctl bootout "gui/$(id -u)/com.slack-orca"
```

`config.json`、`state.json`、附件、日志位于 `~/Library/Application Support/slack-orca`。不要提交或分享这些文件，其中可能有凭据及会话内容。`state.json` 损坏时服务会报错退出，避免重置映射后重复发送任务。

## 来源与验证

设计参考：本仓库的飞书版工作流及 MIT 授权实现。Slack 版使用独立配置、依赖和服务，可与飞书版同时运行。

实现使用 Slack 官方 [Bolt JavaScript](https://docs.slack.dev/tools/bolt-js/creating-an-app/)、[Block Kit](https://docs.slack.dev/block-kit/) 和 [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)。安装清单的字段参考 [App manifest](https://docs.slack.dev/reference/app-manifest/)。

本地测试、桌面 Slack 实测及待验证范围见 [`docs/VALIDATION.md`](docs/VALIDATION.md)。

## 开发

`lib/orca.mjs` 负责 Orca 适配；`lib/engine.mjs` 负责会话映射与记录同步；`lib/slack.mjs` 和 `lib/ui.mjs` 负责 Slack 交互。Discord 可以另加适配层，但没有把未实现的平台标为可用。

`lib/claude.mjs` 与 `lib/util.mjs` 改编自 feishu-orca，保留其 MIT 许可证。Slack 版放在 `slack/` 子目录，独立安装和运行。
