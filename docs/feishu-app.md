# 飞书机器人应用要配什么

`node bin/setup.mjs` 选「扫码新建」时，下面这些会预填到确认页，点同意就行。用已有的应用时，到[飞书开放平台](https://open.feishu.cn/app)自己配，配完要**发布版本**才生效。

## 权限（应用身份）

| 权限 | 用来做什么 |
|---|---|
| `im:message`、`im:message:send_as_bot` | 发卡片、回复消息 |
| `im:message.group_msg` | 收会话群里的所有消息（不用 @机器人） |
| `im:message.p2p_msg:readonly` | 收私聊（控制台） |
| `im:message:update` | 更新卡片 |
| `im:message.reactions:write_only` | 在你的消息上点「了解」「DONE」表情 |
| `im:message.pins:write_only` | 置顶会话卡 |
| `im:resource` | 下载你发进群的图片、文件 |
| `im:chat:create`、`im:chat:update`、`im:chat:read` | 建会话群、改群名 |
| `im:chat:delete` | 工作树删了时解散群（没有也能用，群会改名成「【已删除】…」留着） |
| `cardkit:card:write` | 卡片实体（回复卡片原地更新） |
| `contact:user.base:readonly` | 合并转发里显示发言人的名字（没有就显示 open_id） |

## 你的身份（lark-cli 用户登录）

给会话群打项目标签（飞书消息列表的「标签」分组）只能用你自己的身份做，走 `lark-cli --as user`：用 `lark-cli auth login --scope "im:feed_group_v1:read im:feed_group_v1:write"` 登录（以前建的群解散不掉时也会用你的身份试一次，要 `im:chat:delete`）。没登录也能用，只是群不会打标签；登录好后重启服务，没打上的会补上。

## 事件与回调

- 事件订阅方式选**长连接**，订阅 `im.message.receive_v1`（接收消息）
- 卡片回调也用**长连接**，订阅 `card.action.trigger`（卡片按钮）
- 应用要开启**机器人**能力

一个应用的长连接事件只能有一处在收：别在别的机器或程序上对同一个应用跑 `lark-cli event consume` 或其他机器人程序，否则消息和按钮会随机丢（lark-cli 会报 `another event bus is already connected`）。
