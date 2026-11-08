# 契约

这里的「契约」是别人依赖的形状：本插件的另一个模块、挂载它的 DSH Desktop 窗口、磁盘上已经存在的团队数据，或用户的习惯。改动其中一个，会弄坏某个调用方、一个打开着的会话或一个已保存的文件。内部辅助函数可以自由改动；下面每一项都需要有意的决定，并在另一侧做相应改动。工作规则见 [AGENTS.md](../AGENTS.md)；各部分怎么拼起来见 [architecture.md](architecture.md)。

## DSH 插件入口

`ocean-crew/src/index.ts` 导出 `name`、`inject`、`apply(ctx, config)` 和 `createRuntime(ctx, config)`；`npm run build` 把它编译成 `ocean-crew/dist/index.js`。

- **`apply` 在返回前就装好团队。** 它调用 `createRuntime`，后者构建一个 `rt` 对象（含 `ctx`、`config`、`dshHome`、`home`、`statePath`、`teamTools`、`defaults`），并按 `MODULES` 顺序运行每个模块的 `install(rt)`。必须保持：列表里每个模块都有 `install`，且顺序不变。若被破坏：一个模块若比它所调用的模块先安装，运行时就会丢掉那个函数；监听器顺序还会改变模型请求和工具调用看到的东西——`usage` 在改写请求的监听器之后计量，`privacy` 在工具钩子运行之前检查调用。
- **`rt` 是模块之间唯一的 API。** 模块在 `install` 里注册自己的监听器、工具和副作用，把其他模块要调用的函数放到 `rt` 上，运行时通过 `rt` 调用这些函数，绝不在安装期间调用。若被破坏：某个 install 里直接调用另一个模块，会在那个模块存在之前运行。
- **`inject` 列出 DSH 服务。** 列表是 `llm`、`tools`、`systemPrompt`、`sessionController`、`sessions`、`sessionTitle`、`workspaceRegistry`、`connection`。可选服务用 `ctx.get(...)` 读取；每个定时器、监听器和 socket 都在 `ctx.effect(...)` 或 `ctx.on(...)` 里注册，以便卸载时释放。必须保持：这些都是 DSH 自己的服务 id，并且 effect 之外没有留下运行中的东西。若被破坏：插件挂不上，或 host 已经消失而工作还在继续。
- **client 入口是声明出来的，不靠发现。** `ocean-crew/package.json` 带有 `dsh.client.platform: "web"`、`exports["./client"]: "./client.js"` 和 `dsh.bundle.patch: "./cordis.patch.yml"`；`exports` 里还有 `"."`（types/import 指向 `./dist/index.js`）和 `"./web-search"`（指向 `./dist/web-search.js`）。`cordis.patch.yml` 插入两个插件行：`bot`（`name: ocean-crew`）和 `web-search-auto`（`name: ocean-crew/web-search`），并把 `web` 行的 `searchProvider` 设为 `auto`、`fetchProvider` 设为 `http`。必须保持：这些字段、export 路径和 patch 插入项。若被破坏：某个 profile 只挂上 host 半边而没有 client，或者网页搜索找不到 provider。
- **patch 里的 config 覆盖整行。** `web` 行的覆盖替换整份条目配置，所以 `fetchProvider` 要重述；profile 里若另外指定了 `searchProvider`（exa、perplexity、deepseek-official 等），以 profile 的为准。只关掉 `web-search-auto` 而不同时给 `web` 换 provider，会让所有 `web_search` 失败并报 `WEB_PROVIDER_CONFIGURED_MISSING`。

## `api/bot` 通道

`channel.ts` 通过 `ctx.connection.fetch.register` 注册 `POST /api/bot`：带缓冲的 JSON，用浏览器的会话 cookie 认证。`feed.ts` 注册插件的另一条路由 `GET /api/bot/feed`：一条 Server-Sent Events 流，报告 `revision`、`live`、`message` 和 `stream` 事件。

- **请求：** `{ endpoint, payload }`。解析不了的请求体按 `endpoint: ''` 处理，也就是未知端点。
- **响应：** 总是 HTTP 200，JSON 主体，要么 `{ ok: true, value }`，要么 `{ ok: false, error: { code, message, details } }`。客户端读 `value`，在 `ok: false` 时抛错；`message` 是给用户看的文本，`code` 是机器字段。
- **端点是封闭集合。** `handle()` 对 `endpoint` 做分支：已知名字走它自己的分支，`computer-*` 名字交给 computer 模块，其余一律回答 `bot/not-found`。增加、重命名或删除端点都是客户端可见的改动。
- **没有团队锁的 host 只回答 `READS`。** `READS`（在 `channel.ts` 里）列出第二个 dsh 仍可提供的端点——`state`、各个读取端点、诊断，以及更新和审批回答。其他端点都以 `bot/read-only` 失败，拒绝消息里会点名另一个 host。若被破坏：两个 host 都写团队文件，互相撤销对方的改动。
- **错误码保留 `bot/` 前缀。** 抛出的错误若 `code` 以 `bot/` 开头就保留；`TypeError`、`ReferenceError`、`RangeError`、`SyntaxError` 或 `E*` 系统错误码变成 `bot/internal`（连同调用栈记入日志）；其余变成 `bot/refused`。在用的错误码包括 `bot/invalid`、`bot/not-found`、`bot/stale`、`bot/read-only`、`bot/forbidden`、`bot/unavailable`、`bot/busy`、`bot/missing`、`bot/browser-off`、`bot/internal`、`bot/refused` 和 `bot/error`。必须保持：已有错误码的含义不变。若被破坏：客户端会把用户的拒绝记成崩溃，或者把崩溃显示成拒绝。
- **`state` 是名册回答。** 它带有 `revision`、团队视图和 live 字段；配合上一次的 `revision`、`modelsKey` 和 `liveKey`，它可以回答 `{ revision, unchanged: true, liveKey }`，而 live 字段按各自的序列化缓存，所以没变化的回答就是一个小对象。必须保持：这三个键。若被破坏：打开着的窗口会停止更新，直到重新加载。

## IM 适配器

适配器是 `ocean-crew/src/host/im/platforms/` 下的一个模块，默认导出注册在 `platforms/index.ts` 里，键是 `ocean-crew/src/shared/im-platforms.ts` 列出的 `id`。配对、路由、卡片、队列和重试归 host；线上协议归适配器。

| 成员 | 形状 | 说明 |
| --- | --- | --- |
| `check(fields, env)` | `{ account: { id, name } }` | 在保存连接之前调用，字段改动后再次调用；拒绝会展示给用户。 |
| `connect(fields, env, handlers)` | 句柄 | 每条运行中的连接调用一次；可以返回带 `stop()` 的句柄。 |
| `send(chat, { text, buttons })` | `{ messageId? }` | 必需。`chat` 是 `{ key, kind, title }`。 |
| `edit(chat, messageId, { text, buttons })` | — | 可选；没有它，结算后的卡片只能作为文本回答重新发送。 |
| `typing(chat)` | — | 可选；目标有轮次在跑时由 host 调用。 |
| `addReaction(chat, messageId, emoji)` / `removeReaction(chat, messageId, reactionId)` | reaction id | 两个都提供才启用；只给其中一个就没有状态表情。 |
| `loginStart(env)` / `loginWait(loginId, env)` | `{ loginId, qr, expiresAt }` / `{ status, connection?, owner? }` | 可选，扫码登录；`status` 是 `waiting`、`scanned`、`expired` 或 `done`，只有 `done` 会创建连接。目前只有 `weixin` 提供。 |

`handlers` 是 `{ onMessage, onAction, onStatus }`：

- `onMessage(msg)`，其中 `chat: { key, kind: 'direct' | 'group', title }`、`sender: { id, name }`、`text`、`images: [{ mediaType, data }]`（base64）、`files: [{ name, data }]`（字节）、`mentioned`、`messageId`。必须保持：这些字段名、`kind` 为 `direct` 或 `group`、`mentioned` 只在群里点名本 bot 的消息上为 true。若被破坏：群消息会被当成未提及而丢弃，或者给已经配对过的聊天发配对请求。
- `onAction(action)`，含 `chat`、`sender`、`data`、`messageId`。按钮数据是 host 放进按钮的 `<kind>:<id>:<choice>` 字符串（`q:` 问题、`a:` 审批）；host 解析第一个和最后一个冒号之间的 id。
- `onStatus(status)`，含 `state: 'connecting' | 'ready' | 'error'`、可选的 `error` 字符串和可选的 `account`。`ready` 重置重试阶梯；`account` 变化会保存到连接上。只有 host 报告 `off`。
- **平台消息最多只派发一次。** host 不做去重；重连后的重投递和跨重启的重投递是适配器的事。`feishu.ts` 和 `weixin.ts` 把见过的 id 存在 `env.runtime` 里。若被破坏：一条消息跑两轮 Bot。
- **supervisor 假定每条连接一个运行器。** `sync()` 在异步工作之前就占住运行器的槽位，每条连接每次健康检查得到一个 `nextAction`：`start`、`stop`、`restart` 或 `none`，重试延迟从 250 ms 到 30 s。一条消息被拒，不代表链路断了：带 `permanent: true` 的错误（或 429 以外的 HTTP 4xx）会被丢弃并标记 `messageError`，因此连接不会重启；`unknown: true` 或 `stopped: true` 丢掉一条消息；其余等待后重试，并遵循 `error.retryAfter`（秒）。每次发送必须有结果，否则 host 在 `imSendTimeoutMs` 之后把它当作未知丢弃。必须保持：这些错误标志。若被破坏：一个坏聊天会让连接永远重启，或者一条消息被悄悄发送两次。
- **`env` 是适配器唯一的外部通道。** 它带有 `fetch`、`WebSocket`、插件 `im` 键下按平台的 `config`、`log.warn`、`uploadFile` 和 `runtime`（`get()` / `set(patch)`，按连接持久化）。需要跨重启存活的状态放进 `runtime`；适配器没有别的东西会被持久化。若被破坏：适配器会留下 host 无法持久化或脱敏的状态。

## 生成的构建产物

`cd ocean-crew && npm run build` 做两件事：pinned TypeScript 把 `src/` 编译成 `dist/`（host 入口 `dist/index.js`，网页搜索入口 `dist/web-search.js`），`scripts/build-client.mjs` 从 `src/client/` 写出 `client.js`。

- `client.js` 和 `dist/` 是本地构建产物，不进 git；`client.js` 以一句 `Generated from src/client by npm run build ... Do not edit by hand` 的横幅开头。`cd ocean-crew && node scripts/build-client.mjs --check` 在与全新构建不一致时失败；`node ocean-crew/dev/check-bundle.mjs` 同时检查 `client.js`、`dist/` 与源码重建是否一致，以及 `package.json` 的 `files` 里每个文件是否存在（本地验证脚本，不发布）。GitHub 安装时 `prepare` 会现场构建；开发 checkout 也先构建再安装。
- 必须保持：`client.js` 用 DSH 的加载器注册一个模块——`window.__ModuleLoader__.load({ id: 'ocean-crew', factory })`——它的 factory 只 require `react`、`react-dom` 和 `@deepseek-ai/dsh-client-ui-primitives`，导出恰好是 `apply` 和 `inject`，其中 `inject` 列出 `sessions`、`uiWorkspace`、`uiConversation`、`slots`、`theme` 和 `layout`。若被破坏：DSH 加载不了 client，或者加载时用到 shell 没有准备好的槽位或服务。
- 必须保持：`client.js` 是 `ocean-crew/src/client/` 的构建结果，`dist/` 是 `ocean-crew/src/` 的构建结果。若被破坏：装进 DSH 的代码与源码不一致，检查门禁也会失败。

## 重新初始化

`reset-team` 是破坏性端点：它把 `bot/` 下的 `state.json`、`memory/`、`learning/`、`im/`、`chat-index.sqlite`、`inflight.json`、`scheduler-state.json` 复制到 `backups/reset-<ISO 时间戳>/`，然后用空团队覆盖 `state.json` 并重建第一个 Main Bot。保留 `secrets.json`、团队工作区设置、`logs/`、`usage.sqlite` 和 DSH 自己的会话。执行中若有 turn 在跑返回 `bot/busy`，只读 host 返回 `bot/read-only`；如果没有可运行的工作，重置也会完成。若被破坏：用户的团队数据在没有备份的情况下被删除，或者重置后没有主 Bot 可用。

## 团队数据

host 拥有 `home` 下的所有东西（默认 `$DSH_HOME/bot`）。这些文件只由 host 读写；手改会与整份写入竞争，并可能丢字段。

| 文件 | 内容 | 规则 |
| --- | --- | --- |
| `state.json` | Bot、群聊、DSH Agent、Bot 间消息、问题、视图、偏好、IM 连接及其配对 | 整份、原子写入，每次保存递增 `revision`。有 dsh 在跑时不要手改。 |
| `state.lock` | 唯一写入方的 pid、host 和 token，带心跳（60 秒过期，15 秒一跳） | 由 `home-lock.ts` 管理；删掉活锁会让两个 host 都写。 |
| `secrets.json` | 保存的密钥名和值，权限 600 | 只归 host。不要打印、复制进日志或提交；Bot 以 `$DSH_SECRET_*` 收到值。 |
| `im/<connection id>.json` | 适配器运行时和已发送的卡片，权限 600 | IM host 写，适配器读。丢了可能重发卡片或重答消息。 |
| `update.json` | 更新安装留给下次启动的说明 | 由 `update.ts` 写和消费；不是用户数据。 |
| `chat-index.sqlite`、`usage.sqlite`、`logs/diagnostics.jsonl` | 索引和日志 | 可重建，或可安全删除。 |

聊天本身是 DSH 自己存储里的 DSH 会话，位于 `home` 之外；插件从不直接写它们。

## 网页搜索插件

`ocean-crew/web-search` 是同一 package 里的第二个插件入口，注册 DSH 的搜索提供方 `auto`
（代码在 `ocean-crew/src/web-search.ts`，构建为 `dist/web-search.js`）。

- 导出 `name = 'web-search-auto'`、`inject = ['web']`、`AUTO_PROVIDER_ID = 'auto'` 和 `DEFAULTS`，
  并由 `cordis.patch.yml` 里的 `web-search-auto` 行挂载、`web` 行设成默认。
- 配置键（都可选，写在 profile patch 的 `web-search-auto` 条目下）：`native`、`fallback`、
  `engines`、`searchApis`、`nativeTimeoutMs`、`fallbackTimeoutMs`，默认值见 `DEFAULTS`。
  `SEARCH_APIS` 也可以用 `searchApis` 扩展。
- 每次搜索的顺序：profile 指定的其他 provider 优先；否则用当前模型路由自己的搜索（认识
  Anthropic Messages、OpenAI Responses、Gemini 协议，以及 Ollama、Kimi、Zhipu、MiMo 等搜索
  API）；再否则走 Bing / DuckDuckGo 的公开结果页回退；都不行就失败并告诉模型不要猜地址。
  每个结果以一行 `Search backend: …` 开头说明它走的路径。
- 必须保持：provider id `auto`、上面的配置键和 `Search backend:` 行；若被破坏：profile 里指向
  `auto` 的 `web` 行会找不到 provider，所有 `web_search` 都失败。

## 插件配置

每个键都是可选的，写在 profile patch 的 `bot` 条目下。模块读取它用到的键；下表是全部键。

| 键 | 默认值 | 效果 |
| --- | --- | --- |
| `home` | `$DSH_HOME/bot`（未设置时为 `~/.dsh/bot`） | 团队保存的位置。 |
| `workspace` | `<home>/workspace` | 团队工作区，给没有自己文件夹的 Bot 用。 |
| `mainName`、`mainRole` | `Chief`、`Chief of Staff` | 新团队第一个主 Bot 的名字和角色。 |
| `imReconcileMs` | `15000` | IM 健康检查间隔；大于 0 的值会替换默认值。 |
| `imSendTimeoutMs` | `60000` | 单条消息发送超时；大于 0 的值会替换默认值。 |
| `imReactions` | `true` | `false` 关闭状态表情。 |
| `im` | 无 | 按平台的适配器配置，作为 `env.config` 传给适配器。 |
| `checkRatio` | `0.8` | 上下文管家做决定的位置占可用窗口的比例；必须在 0 和 1 之间。 |
| `memory` | `true` | `false` 移除记忆工具、记忆面板和学习轮。 |
| `memoryReview` | `true` | `false` 只依赖 Bot 自己的 `remember` 调用。 |
| `memoryReviewDelayMs` | `2000` | 一轮结束后，开始复查前的延迟。 |
| `learning` | `true` | `false` 关闭后台学习轮。 |
| `learningTimes` | 内置时序 | 覆盖学习轮的时序和大小限制（`learning.ts` 里的 `LEARNING`）。 |
| `agentsMd` | `true` | `false` 让后台学习轮不再提议修改 `AGENTS.md`。 |
| `updateCheck` | `true` | `false` 停止插件和 DSH 的更新检查。 |
| `updateRegistry` | 所有已配置的 registry | 只向这个 npm registry 查询更新。 |
| `github` | 显示 | `false` 隐藏 GitHub 连接器。 |
| `mail` | 使用 host 自己的传输 | 覆盖邮件连接器的 IMAP 连接及其 `fetch`。 |
| `browser` | DSH Desktop 里为开 | 控制 DSH Desktop 窗口里的浏览器面板和 `read_browser`；布尔值强制开或关。它不影响 `browserPlugin` 挂载的浏览器工具。 |
| `browserPlugin` | 无 | `refs`、`script` 或 `task`；不配置就不挂载浏览器插件工具。挂载后由内置后端驱动本机 Chrome，每个 Bot 用自己的 profile。 |
| `browserPluginApi` | 无 | 注入一个浏览器插件对象，替代内置的。 |
| `browserHeadless` | 无显示的 Linux 上为无头 | 无头运行 Bot 浏览器。 |
| `browserComplete` | 计算得出 | 提供浏览器插件等待的 "page is complete" 检查。 |
| `ocrModel` | DSH 默认图像模型，否则取第一个可用的 | 把图片转成文字、供不能读图的模型使用的模型。 |
| `textOnlyModels` | 无 | `provider/model` 引用，这些模型必须收到文本，绝不收到图片。 |
| `handoffListTokens`、`handoffRecentTokens` | `4096`、`16384` | 交接包中列表段与最近消息段的大小。 |
| `timeRefreshIntervalMs` | `600000` | 时间上下文多久刷新一次。 |
| `timeZone` | 未设置 | 覆盖时间上下文报告的时区。 |
| `playwrightUrl`、`browserExecutablePath` | 无 | 挂载浏览器插件的覆盖项。不配置 `playwrightUrl` 时，`loadChromium` 依次尝试 `playwright`、`playwright-core`；不配置 `browserExecutablePath` 时，`browser/locate.ts` 自动探测本机 Chrome/Chromium（macOS 的应用目录、Windows 的 Program Files、Linux 的 `PATH`），探测不到就交给 Playwright 自己决定（它会报自己找不到可执行文件的错误）。 |
| `diagnosticsFile` | `true` | `false` 只把错误日志留在内存里。 |

Bot 浏览器由本机 Chrome 驱动：`ocean-crew` 依赖 `playwright-core`（不需要自带 Chromium 的
`playwright`），profile 按 Bot 隔离在 `<home>/browser-profiles/<botId>`，不碰用户日常 Chrome 的 profile。
