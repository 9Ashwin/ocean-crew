# 架构

Ocean Crew 是跑在 DeepSeek Harness（DSH）上的一支长期存活的 Bot 团队。`ocean-crew/` 就是整个
产品：一个 DSH 插件，host 代码跑在 DSH 的 Node 进程里，client 代码构建成 `client.js`，跑在
DSH Desktop 的 Web UI 里。它只有一种受支持的形态——装进 DSH Desktop 的插件——并且只使用 DSH
公开的插件 API，从不改动 DSH。按需阅读相应章节；仓库级工作规则见 [AGENTS.md](../AGENTS.md)。

## 术语表

| 术语 | 含义 |
| --- | --- |
| **Bot** | 一个长期身份，有自己的聊天、模型、指令和记忆。它的聊天是一条 DSH 根会话链。 |
| **主 Bot**（Main Bot） | 列在 `state.mainBotIds` 里的 Bot。它可以创建、修改和删除其他 Bot；一个团队可以有多个主 Bot。 |
| **群聊**（Room） | 一个有名字、最多 12 个 Bot 的群（`ROOM_MAX_MEMBERS`）。它有自己的会话链，外加每个成员一个隐藏会话。 |
| **会话**（Session） | 一个 DSH 根会话；一轮在其中运行。Bot 的聊天、群聊的聊天，以及每个成员在群里的聊天，都是根会话。 |
| **分段**（Part） | 一条聊天链里的一个会话。Bot 的 id 是第一段的 id，`sessionId` 是当前分段；更早的分段仍可读取。 |
| **Bot 间消息**（Exchange） | 一条 Bot 到 Bot 的消息。`state.exchanges` 保留最新 600 条，每条只留正文前 2,000 个字符。 |
| **IM 连接** | 绑定到某个 Bot 的一个聊天应用机器人账号（`state.im.connections`），带它自己的聊天和配对列表。 |
| **配对**（Pairing） | 用户在某条连接上放行的平台发送者。其他发送者的第一条消息会变成一条请求，由用户允许或丢弃。 |
| **能力**（Capability） | 可以授予某个 Bot 的具名 MCP server、skill 或 pack。 |
| **连接器**（Connector） | 作为 `mcp__<id>__*` 工具挂载的外部服务（GitHub、邮箱）；凭据留作 Ocean Crew 的密钥，从不进 MCP 配置。 |
| **视图**（View） | Bot 在聊天里展示的结构化卡片，通过 `view-reply` 回答；回答以用户消息的形式到达模型。 |
| **卡片**（Card） | 问题、审批、密钥请求或视图在 IM 里的副本。按钮携带 `<kind>:<id>:<choice>` 数据。 |
| **团队锁**（Team lock） | `state.lock`：唯一允许写团队的那个 dsh 进程的 pid、host 和 token。其他 host 只读。 |
| **Supervisor** | `im/supervisor.ts`：每次健康检查对每条连接给出一个纯决策（start、stop、restart 或 none）。 |
| **Steward**（上下文管家） | `steward.ts`：到达检查线时，要么就地压缩当前分段，要么把聊天换到一个新分段。 |
| **伙伴模式**（Companion） | 让一个 Bot 在自己聊天里以角色身份相处：角色卡、心情、好感度、选择性 emoji 回应、可选每日关心（见 `work/companion.ts`）。 |
| **语音**（Voice） | 可配置的语音模型（`work/tts.ts`）：`speak` 工具把文字合成音频发到来源聊天，应用内也能按条播放。 |

## Bot 团队

- 每条聊天都是一条分段链。越过检查线后由上下文管家决定：仍在进行的工作就地压缩成检查点，处在停顿点的工作则换到新分段，旧分段整段归档，新分段以一份交接说明开头。Bot id 和群聊 id 始终是第一段的 id，因此调用方不需要知道当前是哪一段。
- 群聊有自己的会话链，外加每个成员一个隐藏会话。成员通过 `@名字` 点名；普通消息在 `admin` 模式下发给群管理员，在 `everyone` 模式下依次发给每个成员。轮次规则在 `groups/` 里。
- Bot 专用工具注册在每个 Bot 会话自己的作用域里，从不全局注册，因此同一个 dsh 里的普通 DSH 会话看不到它们。
- 最多只有一个 DSH Agent 与这些 Bot 并列。它的会话是普通的根会话，不是 Bot，也不会向它提供 Bot 团队工具。

## 分层

| 层 | 位置 | 做什么 |
| --- | --- | --- |
| 进程与插件入口 | `ocean-crew/src/index.ts` → `dist/index.js` | 导出 `name`、`inject`、`apply` 和 `createRuntime`；构建一个 `rt` 对象，并按 `MODULES` 顺序安装每个模块。 |
| Host 领域逻辑 | `ocean-crew/src/host/` | 名册与存储、群聊、轮次、分段、工具、能力、连接器、定时任务、更新、密钥和 `api/bot` 通道。 |
| 客户端 | `ocean-crew/src/client/` → `ocean-crew/client.js` | 在 DSH Desktop Web UI 里运行的 client 半边：团队侧栏、聊天单元、卡片、面板和设置。它只通过 `api/bot` 访问 Ocean Crew host。 |
| IM 通道 | `ocean-crew/src/host/im/` | 配对、路由、卡片、发送队列和重连决策；`im/platforms/` 负责线上协议。 |
| DSH host 契约 | `ocean-crew/package.json`、`ocean-crew/cordis.patch.yml` | profile 如何挂载插件、DSH 如何找到 client 入口，以及插件注入哪些 host 服务。 |
| 开发与测试 | `ocean-crew/test/`、`ocean-crew/dev/` | 单元测试与集成测试、假 DSH context、本地安装与冒烟脚本、构建产物检查。 |

## 源码布局

| 路径 | 负责 |
| --- | --- |
| `ocean-crew/src/index.ts` | 插件入口：`name`、`inject`、`apply`、`createRuntime`、`MODULES` 列表和默认值（`mainName`、`mainRole`）。 |
| `ocean-crew/src/host/core/runtime.ts`、`store.ts` | `Runtime` 形状与团队文件：加载、迁移、保存、`state.lock`，以及把会话映射到 Bot 或群聊的索引。 |
| `ocean-crew/src/host/team/roster.ts`、`groups/` | Bot 与群聊：创建、修改、删除、主 Bot、成员、轮次和 @提及。 |
| `ocean-crew/src/host/chat/parts.ts`、`chat-index.ts`，`work/steward.ts` | 分段与交接说明、更早分段的翻页、全文索引，以及上下文决策。 |
| `ocean-crew/src/host/chat/turns.ts`、`delivery.ts`、`steer.ts`、`resume.ts`、`feed.ts` | 轮次跟踪、把消息送进会话、转向、DSH 丢掉的工作，以及实时信息流（SSE）。 |
| `ocean-crew/src/host/team/tools.ts`、`prompt.ts`，`work/capabilities.ts`、`work/memory.ts`、`work/learning.ts` | Bot 会话拿到的东西：工具及其作用域、提示词分区、能力、记忆和学习轮。 |
| `ocean-crew/src/host/chat/channel.ts` | `POST /api/bot` 的各个端点，以及客户端渲染的团队视图。 |
| `ocean-crew/src/host/im/` | IM host：连接、配对、路由与来源、卡片、发送队列与持久 outbox、`supervisor.ts` 和 `format.ts`；`platforms/` 里每个平台一个适配器。 |
| `ocean-crew/src/host/work/secrets.ts`，`team/providers.ts`、`team/models.ts` | `secrets.json`、保存值的脱敏，以及模型提供方与每个 Bot 的模型选择。 |
| `ocean-crew/src/host/connectors/` | GitHub 和邮箱，通过本机 MCP 网关挂载。 |
| `ocean-crew/src/host/work/schedules.ts`、`usage.ts`、`update.ts`、`dsh-update.ts`、`diagnostics.ts` | 定时任务、从 DSH token-meter 读取的 token 用量、插件与 DSH 更新，以及错误日志。 |
| `ocean-crew/src/host/work/companion.ts`、`tts.ts`，`src/shared/companion.ts` | 伙伴模式：角色卡、心情与好感度的记录和每回合注入、选择性 emoji 回应、每日关心对应的 DSH 日程；语音模型的调用与设置（`speak` 工具与按条播放）。 |
| `ocean-crew/src/client/` | client 半边，每个界面一个模块；构建成 `client.js`。 |
| `ocean-crew/src/shared/` | 两边共用的代码与类型：配置、状态、api、IM 平台表、@提及解析、群回复解析。 |
| `ocean-crew/test/`、`ocean-crew/dev/` | 单元测试与假 DSH context；本地安装、冒烟测试和构建检查。 |

## 数据流

**一条 IM 消息进来。** 平台事件到达它的适配器，适配器把一条消息交给 host：`chat`、`sender`、`text`、
`images`、`files`、`mentioned` 和 `messageId`。然后由 IM host 决策。未配对发送者的第一条消息会变成配对
请求（在群里，只有 bot 被 @ 时才如此）；群里未被 @ 的消息被丢弃；`/start` 和 `/stop` 立即回答；一个
纯数字回答最新的未决问题或审批卡片。其他消息解析出聊天目标（一个 Bot 或一个群聊），把文本、图片和
上传的文件转成 DSH 内容块，再调用 `rt.sendUser`；后者通过 `ctx.sessionController` 提示目标的当前分段，
请求 id 以 `im:` 开头。

**一条 Bot 回复出去。** IM host 监听 `session/event`。`displayItems` 为某个 Bot 会话产出的每个 `bot` 或
`view` 项，都通过连接的按聊天发送队列，回到产生这一轮的那个聊天：host 在入站时按 request id 把来源记进
`state.im.origins`，并用 DSH 回显的 `source.rpcId` 把「会话 + turn」绑定到该请求，出站只发那里，同一 Bot
的其他绑定聊天收不到。连接设了 `mirror: "all"` 时恢复广播；没有来源的轮次（在窗口里发起）不发 IM，
开启 `imDeliverAnswers` 时只发最终回答。群聊发言
（`rt.onRoomLine`）和审批（`rt.onApproval`）走同一条路径。`edit` 在卡片得到回答后结算它；平台支持
表情回应时，用一个状态表情标出请求这项工作的消息。

**客户端渲染什么。** `client.js` 是 DSH Desktop 加载的客户端包；`apply(ctx)` 声明它需要的服务，并注册到
DSH 的槽位（`conversation.*`、`sidebar.*`、`settings.*`、`shell.overlay`），用 Bot 的形象替换部分单元。
它的数据来自 `POST api/bot`：每 1.5 秒轮询一次（窗口隐藏时 10 秒一次），发送上一次的 `revision`、
`modelsKey` 和 `liveKey`，因此没变化的回答只是一个小对象，有变化的回答会被索引进各界面订阅的本地数据
源。轮次内容是 DSH 自己的对话；插件在它周围提供单元和停靠面板，并通过 `ctx.sessions` 读取会话状态。
`GET api/bot/feed` 是同一份数据的 SSE 流，用来推送新消息和流式文本。

**伙伴 Bot 的一轮。** 开启伙伴模式的 Bot 在自己的聊天里仍是同一个 Session，只是多了三处变化：身份提示
多一段角色卡（`team/prompt.ts` 读 `companionOf`）；每回合第一步追加一条关系快照（`agent/pre-step`，来源
`ocean-crew-companion`，每回合只一次，系统提示前缀不变）；用户消息到达后按措辞小幅更新心情与好感度，
并按需贴一个 emoji（存在 `companionReactions`，随 roster 一次下发）。回答默认自动语音：`work/tts.ts` 调
配置的语音模型，飞书请求 opus 走语音条、微信按 mp3 音频文件发出；应用内的「播放语音」走
`companion-audio` 端点，播放期间给该 Bot 的所有头像加说话动画。

**磁盘上的状态。** host 把团队保存在内存里，整份原子写入 `state.json`（先写临时文件，再替换），并递增
`revision`。只有持锁者能写；同一份数据上的另一个 host 只回答读，拒绝写。密钥单独放在
`secrets.json`（权限 600），所以团队备份和密钥备份是两件事。每条连接的 IM 运行时（`im/<id>.json`）携带
适配器跨重启需要的东西，例如已投递的消息 id 和已发送的卡片；`im/<id>.outbox.json` 记下还没确认
送达的文本，重启后继续投递。`chat-index.sqlite` 是可重建的索引；聊天本身是 DSH 自己存储里的
DSH 会话，不在插件 home 里。
