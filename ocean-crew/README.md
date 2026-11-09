# Ocean Crew（海底小队）

Ocean Crew 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：
它把 **DSH Desktop** 变成一支由长期存活的海洋伙伴 Bot 组成的团队。每个 Bot 是一个独立的 DSH
Session，有自己的名字、角色、指令、模型、工作文件夹和形象；它们和你对话，也彼此对话、在群聊里协作。

本仓库只维护一种形态：装进 **DSH Desktop** 里运行的 `ocean-crew` 插件。不提供 Web 部署、Docker
镜像、移动端或自带的桌面应用。

> **个人项目。** 本仓库（[9Ashwin/ocean-crew](https://github.com/9Ashwin/ocean-crew)）是个人学习与
> 日常使用的 Bot 团队项目，不提供商业支持。插件在 DSH 里的包名是 `ocean-crew`。

## 安装

先安装 DSH Desktop，并在 **Settings → Models** 里至少配置一个模型——Ocean Crew 使用 DSH 提供的模型。

构建产物（`dist/`、`client.js`）不进 git，由安装时的 `prepare` 脚本现场构建。在 DSH 的
**Plugins** → **Add plugin** 里填入：

```text
github:9Ashwin/ocean-crew#main&path:/ocean-crew
```

（需要本机装 Git。）点 **Install**、**Enable now**。pnpm 默认拦截依赖的构建脚本；遇到提示时允许
`ocean-crew` 的构建（DSH 的 Plugins 页面会给出确认，或在 profile 的 `pnpm-workspace.yaml` 中加
`allowBuilds`，或在本机 profile 的 `pnpm-workspace.yaml` 里加 `dangerouslyAllowAllBuilds: true`）。

### 从本机检出安装（开发用）

```sh
git clone https://github.com/9Ashwin/ocean-crew.git
cd ocean-crew                          # 仓库根
npm install
npm run build                          # 生成 ocean-crew/dist/ 和 ocean-crew/client.js
cd ocean-crew                          # 插件目录
node dev/install-local.mjs --dry-run   # 只看计划
node dev/install-local.mjs             # 安装并让 DSH 重新加载
```

如果 DSH 提示改动下次启动生效，完全退出 DSH 再打开。团队第一次打开时会创建一个名为 **Chief**
的 Main Bot。

脚本会先备份已安装的副本，只复制发布文件，不改 profile 的依赖声明，也不碰团队数据和密钥。
`--no-reload` 跳过重新加载，`--profile <dir>` 指定别的 profile。client 侧改动重新加载后生效；
host 侧改动需要重启 DSH。

插件按 DSH `0.2.2-rc.1` 的插件 API 编写。

## 快速开始

打开 Ocean Crew，和 Chief 说话。它会带你完成设置；Bot、群聊、能力、连接器和定时任务也都可以直接
让 Bot 创建和修改。

## 功能

- **团队。** 长期存活的 Bot：每个有自己的模型、指令、工作文件夹、记忆、权限预设和形象。Main Bot
  （可以不止一个）管理团队；Bot 之间用 `message_bot` 互相交付工作。
- **群聊。** 多个 Bot 一起干活：管理员先答再点名，或成员按序发言；同一条消息里被 `@` 的成员并行
  工作；没有新内容的成员保持沉默（`[PASS]`）。群可以跑分阶段目标和证据核对，每个群有自己的记忆。
- **长聊天不丢上下文。** Bot 的聊天由分段（part）组成；越过检查线时，上下文管家决定就地压缩成检查点
  还是换新分段，你始终只看到一个聊天。更早的对话和压缩内容可在全文索引（`node:sqlite` FTS5）里搜索。
- **记忆。** 每个 Bot、每个群和整个团队各有一份 Markdown 记忆；每轮结束后由模型复核更新，也可以让
  Bot 用 `remember` / `forget` / `recall` 直接管理。记忆面板里可以看条目、摘要、更改历史并撤销。
- **目标与日程。** 群目标按阶段拆分、逐任务验收（必有证据或豁免），Bot 驱动到完成；定时任务按
  cron 或一次性触发，失败和错过可查。
- **能力与连接器。** 在设置里共享 MCP server、skill 和 pack；用 OAuth 或密钥连接 GitHub、邮箱和远程
  MCP server，凭据留在 Secrets，以 `$DSH_SECRET_*` 提供给工具。
- **密钥。** Bot 在聊天里用卡片请求 API key 或 token，自己永远看不到值；保存后按 Bot 限定范围，在
  工具结果和出站请求里脱敏。
- **浏览器。** 插件不内置浏览器；Bot 需要操作页面时用本机已安装的 Playwright CLI + Chrome，
  通过自己的 shell 工具执行。
- **IM。** 把 Bot 接到飞书（私聊和群聊）或微信私聊：配对、卡片审批和回复都在 IM 里完成，不需要公网地址、不开端口。飞书的群聊可以绑定到内部群聊，群里的点名消息进入该群、群里的发言也回到那个群。
  每条连接是一个 IM 机器人账号、绑定一个 Bot，群聊可以按会话分别指向团队里的 Bot 或群；未配对发送者的第一条消息会变成一条待允许的请求。
  待发文本持久化在 `im/` 下，重启后继续投递；已发出但没拿到回执的会标为「结果不确定」，不会重复发送。
  回复只回到发起对话的那个聊天：同一个 Bot 同时接飞书和微信时，在飞书说的话不会跑到微信；
  在电脑窗口里聊的内容默认完全不发到 IM。
  飞书用富文本 post 渲染 Markdown（加粗、列表、链接、代码块正常显示），回答会挂在提问那条消息下；
  post 被平台拒绝时退回纯文本，长回复分条发送并标注第几段，代码块跨条时自动补围栏。
  微信把短的口语化回复拆成多条气泡发送，更接近真人聊天，并在回复前显示「正在输入」。
- **网页搜索。** 由 DSH 的搜索 provider 提供，在 DSH 设置里配置。
- **侧聊与旁白。** `/side` 在右栏打开侧聊，从 Bot 当前聊天快照作答、不运行工具；旁白（btw）把补充
  说明以卡片形式贴在聊天里。
- **用量与更新。** 设置里的 Usage 显示团队、每个 Bot 与每个群聊的 token 用量（来自 DSH token-meter）；插件和 DSH 有更新时在窗口里提示并可直接安装。
- **重新开始。** 设置 →「重新开始」可以重新初始化团队：清空 Bot、群聊、记忆、学习、日程与 IM 配对，保留密钥、团队工作区和 DSH 会话，重建 Chief 主 Bot；重置前会把数据备份到 `bot/backups/reset-<时间戳>/`。
- **外观。** 12 个海洋形象、13 种颜色（`assets/marine/`，默认蓝鲸 `marine-whale`），也可以上传照片；
  团队主题、强调色、消息布局和动画三档在设置里调。每个形象层与色板由 `ocean-crew/src/client/look/marine-assets.ts`
  统一渲染。仓库顶部配图见根 [README](../README.md)。

## 配置

选项写在 profile 的 `cordis.patch.yml` 里 `bot` 条目下，全部可选：

```yaml
- id: bot
  name: ocean-crew
  config:
    workspace: /path/to/workspace   # Bot 的工作区；默认 <home>/workspace
    home: /path/to/bot-data         # 团队数据位置；默认 $DSH_HOME/bot
    checkRatio: 0.8                 # 上下文管家做判断的位置（可用窗口比例）
    memory: true                    # false 关闭记忆工具、面板和学习轮
    learning: true                  # false 关闭后台学习轮
    updateCheck: true               # 是否检查插件更新
    github: false                   # 隐藏 GitHub 连接器
```

完整键表、默认值与影响见 [docs/contracts.md](../docs/contracts.md#插件配置)。

## 数据与隐私

数据都在你自己的电脑上：团队、密钥、记忆、日志和索引在 `$DSH_HOME/bot`（默认 `~/.dsh/bot`）；
聊天本身是 DSH 存储里的会话，不在插件目录里。`secrets.json` 权限 600；团队同一时刻只有一个持锁
host 可以写，其他 DSH 进程只读。卸载插件不会删除这些数据。安全边界见
[SECURITY_MODEL.md](../SECURITY_MODEL.md)。

## 开发与检查

```sh
cd ocean-crew
npm install
npm run build          # dist/（host 构建产物）+ client.js（client 构建产物），都不进 git
npm test               # 单元测试
node dev/check-bundle.mjs   # 校验 client.js 与 dist/ 和源码一致、发布文件齐全
```

改完在仓库根跑完整门禁：

```sh
npm run check
```

`client.js` 由 `ocean-crew/scripts/build-client.mjs` 从 `ocean-crew/src/client/` 生成，禁止手改；
host 源码在 `ocean-crew/src/host/`。测试从本机 DSH 安装或 DSH 检出解析 `@deepseek-ai/*`，
细节见 `ocean-crew/test/harness-resolve.mjs`。IM 改动需要在 DSH Desktop 里做一次真实飞书或微信
往返验证。

- 工作规则：[AGENTS.md](../AGENTS.md)
- 架构与术语：[docs/architecture.md](../docs/architecture.md)
- 公开契约：[docs/contracts.md](../docs/contracts.md)
- 界面规范：[docs/design/ui-standard.md](../docs/design/ui-standard.md)
- 海洋形象资产：[assets/marine/README.md](../assets/marine/README.md)

## 许可

[MIT License](../LICENSE)，按「原样」提供，不附带任何担保。源自早期 JavaScript 版本的部分仍按 Apache-2.0 提供，第三方代码及其许可归属见
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
