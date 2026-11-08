# Ocean Crew 安全模型

安全评审与本仓库扫描从这里开始。Ocean Crew 只有一个可部署面：装在 DSH Desktop 里的
DSH 插件（`ocean-crew/`）。

## 系统概览与信任边界

Ocean Crew 是构建在 DeepSeek Harness（DSH）之上、由长期存活的 LLM Bot 组成的团队，以插件形式
提供。它只有一种运行方式：**DSH Desktop** 加载 `ocean-crew` 插件，运行在用户自己的电脑上。host 半部
运行在 DSH 的 Node 进程里，把团队数据保存在 `$DSH_HOME/bot` 下；client 半部运行在 DSH Desktop
的 Web UI 中，只通过自己的路由（`POST /api/bot`）访问 Ocean Crew host。

信任边界：

1. 不可信内容 -> 模型 -> Bot 工具。网页、文件、搜索结果、连接器/MCP 结果以及其他 Bot 的消息
   都会进入模型；模型发起的工具调用按该 Bot 的权限预设执行。
2. 普通 Bot -> Main Bot 权限（创建/修改/停止 Bot、群、文件夹），在
   `ocean-crew/src/host/team/tools.ts` 里通过 `rt.isMain` 强制执行。
3. 模型/工具输出 -> 对模型的出站请求（敏感值脱敏在 `ocean-crew/src/host/work/secrets.ts`）。
4. DSH Desktop 窗口 -> host：`POST /api/bot` 通道（`ocean-crew/src/host/chat/channel.ts`，
   `ocean-crew/src/host/core/constants.ts` 里的 `ROUTE`），用浏览器的会话 cookie 认证。
5. Bot 生成的 HTML 视图 -> DSH Desktop 页面：HTML 视图是模型写的标记，由 `deep-view` 的
   `HtmlFrame` 在 `sandbox="allow-scripts"`、无同源的 iframe 里渲染。
6. Bot 浏览器页面 -> 模型：你在浏览器面板里引导的页面经 `read_browser`
   （`ocean-crew/src/host/browser/browser.ts`）到达模型；浏览器后端则在该 Bot 自己的浏览器 profile 里
   操作页面（`browser-plugins.ts`、`browser/`），驱动的是机器上已安装的 Chrome/Chromium。

## 组件

- **host** —— 插件服务端：`ocean-crew/src/index.ts` → `dist/index.js`、`ocean-crew/src/host/`（roster、tools、
  turns/delivery、groups、goals、parts、memory、schedules、permissions、privacy、folders、
  connectors、providers）。
- **secrets** —— `ocean-crew/src/host/work/secrets.ts`（`secrets.json` 权限 600、`$DSH_SECRET_<NAME>`、
  脱敏器）以及 API key/提供方（`providers.ts`、`models.ts`）。
- **client** —— DSH Desktop 里的浏览器 UI：`ocean-crew/src/client/`（聊天、卡片、面板、
  设置、Bot 浏览器面板）以及生成的 `ocean-crew/client.js`。
- **browser** —— Bot 浏览器通道与浏览器后端：`ocean-crew/src/host/browser/browser.ts`、
  `browser-plugins.ts`、`ocean-crew/src/host/browser/`（`refs`、`script`、`task` 三个后端，以及
  `locate.ts`、`mount.ts`、`session.ts`）。后端通过 `playwright-core` 驱动机器上已安装的
  Chrome/Chromium，每个 Bot 用自己的 profile。

## 入口与谁能到达它们

- 用户输入的聊天（可信）。
- Bot 读取的内容：网页（Bot 浏览器、`read_browser`、网页搜索）、工作文件夹里的文件、
  连接器/MCP 工具结果、其他 Bot 和群聊的消息、定时任务的提示词。**攻击者可控制。**
- `/api/bot` HTTP 端点：DSH Desktop 里的本地用户，通过 host 自己的路由注册和浏览器的
  会话 cookie 访问。

## 资产（按维护者排序）

1. **关键：API key 与 Bot 密钥** —— 提供方 key、`secrets.json`、`$DSH_SECRET_*`、连接器
   token。不得泄漏给模型、日志、工具结果、密钥范围之外的其他 Bot，或出站请求。
2. **关键：用户电脑上的文件** —— Bot 工作文件夹之外的文件。插件自己的文件留在 `home`
   （默认 `$DSH_HOME/bot`）下，Bot 的工作文件夹不能是 DSH 自己的数据文件夹。
3. 其他：每个 Bot 自己浏览器分区和 profile 里的登录状态、对话与记忆。

## 攻击者画像

- **主要（维护者确认）：提示词注入** —— 通过网页、文件或消息让 Bot 越权：泄漏 key/密钥、
  读写范围之外的用户文件、取得 Main Bot 权限、更改其他 Bot、绕过权限预设或脱敏。
- 次要（维护者未选定）：恶意的浏览器后端或连接器、一个自行行动的失控普通 Bot。

## 现有控制

- `tools.ts` 里的 Main Bot 检查（`rt.isMain`、`rt.isAdminOf`）。
- 工作文件夹、团队工作区和 Bot 头像都避开 DSH 的数据和团队数据（`folders.ts` 的
  `guarded`/`inData`）。
- Private Bot（`privacy.ts`）：只有用户能切换；其他 Bot 不能读它的工作文件夹、记忆或
  Session，Private Bot 对外的共享（`message_bot`、共享能力、写自己文件夹之外）需要用户批准；
  删除后保护仍然保留，直到用户在 Settings 里解除。
- 每个 Bot 的权限预设（`permissions.ts`），在每个 Session 上设置。
- 密钥：按 Bot 限定范围（`canUse`），在工具结果和出站模型请求里脱敏（`redactor`，覆盖
  JSON/URL 编码形式）。
- 连接器拒绝非 HTTPS 地址（`connectors.ts`）。
- 视图是由 `deep-view` 以 React 渲染的结构化卡片；HTML 视图例外：它在
  `sandbox="allow-scripts"`、无同源的 iframe 里运行，CSP 阻断所有网络请求，
  `referrerPolicy="no-referrer"`，发生跳转的 frame 会被拦下（`deep-view` 的 `HtmlFrame`）。
- `read_browser` 只读用户打开的页面；它不能点击、输入、滚动或导航。浏览器后端在该 Bot 自己的
  profile（`<home>/browser-profiles/<botId>/`）里运行：不配置 `browserExecutablePath` 时，
  由 `ocean-crew/src/host/browser/locate.ts` 在这台机器已安装的 Chrome/Chromium 中选择（macOS 的
  `/Applications`、Windows 的 Program Files、Linux 的 `PATH`），Playwright 模块可用
  `playwrightUrl` 覆盖；它不下载浏览器，也不打开用户日常 Chrome 的 profile。每个动作都会
  检查：支付被拒绝并交回用户；发布、上传、下载和删除需要用户批准，除非用户已给该 Bot
  授予这一类权限（`browser-plugins.ts`）。浏览器任务提示词通过交接卡片把登录、支付和
  验证码步骤交给用户。
- IM：发送者必须先配对，消息才会触发 Bot 的一轮；未配对发送者的第一条消息会变成一条
  待用户允许或丢弃的请求，群消息必须点名 bot（否则被丢弃）。
- 浏览器面板里的页面位于 DSH Desktop 的 webview 中，每个 Bot 一个存储分区（`bot:<id>`），
  所以 cookie 和登录状态不会在 Bot 之间串用；浏览器后端打开的页面则在本机 Chrome、该 Bot
  自己的 profile 里。

## 不在范围 / 已接受的风险（维护者）

- DSH 本身不在本仓维护范围内；修复属于 DSH 项目（硬规则：绝不修改 DSH）。DSH Desktop
  自己的外壳（窗口、路由和 webview 隔离）属于 DSH；插件依赖它，不重新实现。
- Private Bot 的 shell 仍能触达该账号能访问的任何文件：隐私关闭的是插件自己的工具，以及
  交给文件和 shell 工具的路径，而不是操作系统。

## 待定问题

- 限定给一个 Bot 的密钥，是否也应视为对 Main Bot 隐藏？
