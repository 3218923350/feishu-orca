# feishu-orca：飞书里的 Orca

离开电脑也能像在 [Orca](https://onorca.dev) 里一样用 Claude Code 干活：在飞书里选项目、选模型，新建一个工作树，模型在你电脑上的 Orca 终端里跑；**一个会话就是一个飞书群**，群里说话就是跟模型说话。回到电脑上，Orca 里就是同一个终端，接着打字就行，两边看到的是同一个会话。

```
飞书 ──事件（lark-cli 长连接）──► bridge.mjs ──orca terminal send──► Orca 终端里的 claude
  ▲                                     │
  └──── 卡片（原地更新）◄──────────── 读 ~/.claude/projects/<目录>/<会话>.jsonl
```

## 能做什么

- **私聊机器人**：发任意一句话出控制台卡片，选项目（Orca 里登记的仓库）、模型、思考强度，点「新建会话」→ 建工作树、在终端里起 Claude、建一个群把你拉进去。群名会自动改成会话标题
- **群里说话就是发给模型**；模型正在跑也直接发，Claude Code 会在下一个工具调用的间隙读到（和在终端里插话一样）
- **转发消息进群**（单条、合并转发都行）、发图片文件：先等你补一句要做什么再一起发；图片文件下载到本地，模型能直接读
- **回复卡片**：每轮一张，回复你那条消息；正文是模型原话全文，工具调用折叠，太长自动续卡
- **模型提问**（AskUserQuestion、确认框）出选项卡，点按钮或直接打字回答
- **电脑上同步**：在 Orca 终端里打字，群里也会出现（标「电脑上」）；终端关了，下次群里说话自动 `--resume` 同一个会话
- **接上已有会话**：私聊发「列表」，Orca 里的 Claude 会话都在，点「接着聊」建群续上
- **会话卡**（群里置顶）：看终端、中断、在 Orca 里打开、重开终端、结束会话、删除工作树。工作树删了（飞书里点或在 Orca 里删）群会自动解散

群里的命令：`/stop` 中断，`/screen` 看终端画面，`/key enter|esc|up|down|tab|1…` 按键；其他 `/xxx`（`/compact`、`/clear`…）照常发给 Claude。

## 要求

- macOS（常驻服务用 launchd），Node.js ≥ 20
- [Orca](https://onorca.dev) 桌面版，并用它管理你的项目（`orca` 命令行随 Orca 安装）
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`claude`），已登录
- [lark-cli](https://github.com/larksuite/cli)：`npm i -g @larksuite/cli`（用来收飞书事件）
- 一个**专用**的飞书机器人应用（setup 可以扫码现建）。飞书一个应用的事件只能有一处在收，别和其他机器人程序共用

## 安装

```bash
git clone <本仓库> && cd feishu-orca
npm install
node bin/setup.mjs     # 扫码新建机器人（或填已有应用），写 ~/.feishu-orca/config.json
./install.sh           # 装成 launchd 常驻服务；改完代码再跑一次就是重启
```

装好后在飞书里私聊机器人发一句话。日志：`tail -f ~/.feishu-orca/bridge.log`。

用已有应用时，权限、事件和回调要自己在开放平台配好，见 [docs/feishu-app.md](docs/feishu-app.md)。

## 配置

`~/.feishu-orca/config.json`（`FEISHU_ORCA_HOME` 可改目录），setup 会写好：

| 键 | 说明 |
|---|---|
| `app_id` / `app_secret` | 机器人应用。secret 也可以放环境变量 `FEISHU_ORCA_APP_SECRET` |
| `owner_open_id` | 你在这个应用下的 open_id：只认你的消息和按钮，别人进群说话不会发给模型 |
| `lark_cli_config_dir` | lark-cli 收事件用的配置目录（setup 建在 `~/.feishu-orca/lark-cli`，不动你默认的 lark-cli 配置） |
| `lark_cli` / `orca` / `claude` | 可选：可执行文件路径，不写按 PATH 找 |
| `doc_url` | 可选：控制台卡片上「📖 使用说明」按钮的链接 |

运行数据也在这个目录：`state.json`（群 ↔ 会话）、`bridge.log`、`media/`（收到的图片文件）。

## 注意

- 模型跑在你的电脑上：离开前别让 Mac 睡眠（合盖会睡）。电脑睡着或 Orca 没开时消息可能收不到
- 模型以 `--dangerously-skip-permissions` 跑（和 Orca 默认一样），群里只认你本人
- Orca 聊天（不是终端）开的会话，接上后在终端里续上；这时电脑上那个聊天标签别同时用
- 控制台卡片的「第一句话」最多 1000 字（飞书限制），长内容进群再发
- 依赖 Orca 的两个内部文件：模型列表 `~/Library/Application Support/orca/agent-model-catalog.json`、Orca 起 Claude 时用的插件目录 `claude-agent-view/`。Orca 升级改了它们的话，模型下拉可能为空、等你回答的提示可能不灵
- 目前只支持 Claude Code（Codex 的会话记录格式不同，还没接）

## 原理

- **发**：群消息 → 文字（合并转发展开、卡片转文字、图片文件换成本地路径）→ `orca terminal send --enter`。发之前确认终端里的 agent 还活着（`agentIdentity=claude`），不是就新开终端 `claude --resume`，免得话发进 shell 里
- **收**：每秒增量读会话记录，按轮切：用户的话开一轮；正文和工具调用更新卡片（1.2 秒节流，CardKit 卡片实体原地更新）；`turn_duration` 结束这一轮；模型忙时插的话是 `queued_command`，显示在当前卡片里；不是从飞书发的那句话就是电脑上打的
- **等你回答**：一轮在跑、记录安静 1.5 秒时看 Orca 的 `agentWait`，有就读终端画面解析问题和选项
- **`/clear`**：终端换了新会话文件就跟过去（只跟比原来的文件新建得晚、又不属于别的群的）
- **工作树删了**：每 10 秒查一次，没了就关终端、解散群

代码：`bridge.mjs` 主进程；`lib/feishu.mjs` 飞书 REST；`lib/inbound.mjs` 收事件；`lib/message.mjs` 飞书消息 → 文字；`lib/orca.mjs` Orca CLI；`lib/claude.mjs` 会话记录；`lib/render.mjs` 一轮 → 卡片；`lib/cards.mjs` 其他卡片；`lib/config.mjs` 配置；`bin/setup.mjs` 安装引导。测试：`npm test`。

## License

MIT
