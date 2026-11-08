# 开发指南

工作规则见 [AGENTS.md](AGENTS.md)，分层与公开形状见 [docs/architecture.md](docs/architecture.md) 与
[docs/contracts.md](docs/contracts.md)，界面规则见 [docs/design/ui-standard.md](docs/design/ui-standard.md)。
本文是从一份 checkout 到一次已验证改动的短路径。

## 环境

- Node.js 22.18 及以上（见根 `package.json` 的 `engines`），npm。
- 在仓库根运行 `npm install`：安装构建、检查和测试用的工具（TypeScript、Biome、esbuild 等）。
- `npm run harness`（只需一次）：安装测试与类型检查使用的 DSH 包，版本固定在
  `dev/harness/package.json`。根 `package.json` 的脚本名和版本文件位置以实际为准；如果这里没有
  `npm run harness`，用 `npm run` 看当前可用的等价脚本。
- 不需要 API Key：测试用 mock 模型；本地测试台的数据放在仓库根的 `.dsh-test-<name>/`。

## 改动流程

1. 先读行为的所有者（`ocean-crew/src/host/`、`ocean-crew/src/client/` 或 IM 适配器）和它碰到的
   契约（[docs/contracts.md](docs/contracts.md)）。
2. 改源码。改过 `ocean-crew/src/` 后构建：

   ```sh
   cd ocean-crew && npm run build   # 或回到仓库根 npm run build
   ```

   它生成 `ocean-crew/dist/`（host 构建产物）和 `ocean-crew/client.js`（client 构建产物）。两者
   都是生成物，要和源码一起提交；`client.js` 禁止手改。
3. 给可观察行为补回归测试（`ocean-crew/test/`，用 `node:test`）。测试夹具不要带用户数据、
   凭据或本机状态。
4. 跑下面的检查。host 改动再跑一次 smoke 测试；client 改动还要在 DSH Desktop 里看一眼结果。
5. 把改动、命令和结果写进本仓 `tasks/<task>/progress.md`，验证证据放
   `tasks/<task>/evidence/`（见 [AGENTS.md](AGENTS.md)）。用户要求时再在 `main` 上提交。

## 检查

单元测试和构建产物检查：

```sh
cd ocean-crew
npm test
node dev/check-bundle.mjs   # client.js、dist/ 与源码一致，发布文件齐全
```

在仓库根跑完整门禁：

```sh
npm run check
```

CI（`.github/workflows/test.yml`）只在 push 到 `main` 时触发，运行同样的门禁，并加一次对跟踪文件
的泄漏扫描。

## Smoke 测试

改 `ocean-crew/src/host/` 或插件入口后，先构建，再跑本地 smoke。它会从 DSH harness/checkout 启动
一个一次性 DSH，在 HTTP 层检查插件 apply/inject、`POST /api/bot` 的 `state`、`GET /api/bot/feed`
的 hello 事件，以及 Bot 的创建、问候和删除：

```sh
cd ocean-crew
npm run build
node dev/smoke.mjs --name smoke --port 3097 --mock-port 3098
```

- 需要一份 DSH harness 或 checkout：脚本会优先用 `DSH_HARNESS`，否则从仓库旁找；也可以显式传
  `--harness <dir>`。
- 其他选项：`--keep-data` 保留测试数据，`--skip-build-check` 跳过构建产物检查。
- 数据只写在仓库根的 `.dsh-test-<name>/`，跑完会清理；不要指向真实的 `~/.dsh`。
- 用空闲端口，跑完停掉自己启动的进程。

## 验证与证据

- 验证的人要真的跑起来、看到它声称要测的那件事，并到达预期状态。生成或批量改过的文件要读回来。
- 验证证据放在任务目录的 `evidence/` 下（如 `tasks/<task>/evidence/`）。哪些在真机验过、哪些只是
  测试里验过，要分开写清楚。
- 单元测试通过不等于平台行为正确：client 改动要在 DSH Desktop 里看；IM 改动要用真实的飞书或微信
  账号做一次往返，结果记进任务，不能用单测代替。
- 不要为了看起来改完而放宽门禁、删掉失败的用例或跳过平台检查。保留原始错误并把它暴露出来。

## 在本机 DSH Desktop 里跑本地构建

先按 [README](README.md) 的安装步骤把插件装进 DSH Desktop，再构建并覆盖 profile 里的副本：

```sh
cd ocean-crew
npm install
npm run build
node dev/install-local.mjs --dry-run   # 只看计划
node dev/install-local.mjs             # 安装并让 DSH 重新加载
```

`dev/install-local.mjs` 把这份 checkout 的发布文件复制进本机 DSH Desktop 的 profile（默认
`~/.dsh/profiles/desktop`；设置了 `DSH_HOME` 时是 `$DSH_HOME/profiles/desktop`），并让 DSH 重新加载
插件。`--dry-run` 只打印计划；`--no-reload` 跳过重新加载；`--profile <dir>` 指定别的 profile；
`--json` 输出机器可读的结果。它会先备份已安装的副本，不碰团队数据和密钥库。client 改动重新加载后
生效；host 改动可能要重启 DSH，所以不要擅自重启用户正在用的 DSH。

## 提交

英文 Conventional Commits，祈使句标题，正文写原因。一个提交只做一件事。显式暂存路径并检查 diff；
`client.js` 和 `dist/` 是生成物，与源码在同一提交里更新。不要提交 `node_modules`、`DSH_HOME` 内容、
密钥、cookie 或带个人信息的截图。不向其他仓库推送或开 PR；发布只走本仓库。

除非任务另有说明，直接在 `main` 上改；只在用户要求时提交和推送。
