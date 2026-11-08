# Third-party notices

Ocean Crew — Copyright 2026 9Ashwin and the Ocean Crew contributors.

This project is a personal, non-commercial project for learning and everyday
use. The project's own material is released under the MIT License (see
LICENSE). Portions of the code derive from DS Bot
(https://github.com/Fei2411/DS-Bot), Copyright 2026 Fei2411 and the DS Bot
contributors, distributed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). The sources under ocean-crew/src/
are modified ports of
the JavaScript build this plugin shipped as before the rewrite (removed from
the repository in 2026): they were ported to TypeScript, renamed and
restructured that year. Those portions remain available
under the Apache License, Version 2.0; the MIT License covers the project's
original material. The notices below are kept for the third-party code they
cover.

==============================================================================
Third-party code in this repository
==============================================================================

Deep View (https://github.com/Fei2411/deep-view)
Apache License, Version 2.0, Copyright 2026 Fei2411 and the Deep View
contributors

  - ocean-crew/src/client/widget-cell.ts imports deep-view/core and
    deep-view/react; the client bundle inlines that code into client.js, so it
    is distributed with the plugin. Deep View's own README says its view
    components and core were ported from DS Bot under the same license.

Simple Icons (https://simpleicons.org)
CC0 1.0 Universal, the Simple Icons contributors

  - ocean-crew/src/client/connector-marks.ts keeps the single-color brand path
    of each connector service from Simple Icons 16.36.0 (the SI table), the
    Gmail, iCloud and QQ paths for the mailbox rows, and the Telegram, WeChat
    and Discord paths for the IM page.

Context7 (https://github.com/upstash/context7)
MIT License, Copyright (c) Upstash

  - ocean-crew/src/client/connector-marks.ts keeps the Context7 connector mark
    from public/context7-icon.svg, without the brand square.

Microsoft Playwright (https://github.com/microsoft/playwright) and
Playwright MCP (https://github.com/microsoft/playwright-mcp)
Apache License, Version 2.0, Copyright (c) Microsoft Corporation

  - ocean-crew/src/host/browser/ follows the browser tools of Playwright MCP:
    the ARIA page snapshot with [ref=eN] element refs, a fresh snapshot
    returned by every action, and the per-action tool set (open, snapshot,
    click, upload, type, select, press, tabs, back, screenshot). The session
    drives the browser through the Playwright API itself
    (ariaSnapshot({ mode: 'ai' }) and the aria-ref locators those refs
    resolve to). The playwright-core package is a runtime dependency of the
    plugin; it is installed from npm and is not bundled, and the plugin loads
    it at run time from the install it is pointed at (playwrightUrl), the same
    way it uses the host's @deepseek-ai/* packages.

dsh-im (https://github.com/xmanrui/dsh-im)
MIT License, Copyright (c) 2026 xmanrui

  - ocean-crew/src/host/im/platforms/weixin.ts follows the iLink mapping of
    src/channels/weixin/weixin-api.mjs and weixin-controller.mjs: the QR
    login poll, getupdates with the get_updates_buf cursor, context_token
    per user, typing tickets, and the AES image download. It also follows
    the session start (msg/notifystart and client headers), reconnect
    backoff, message deduplication and context-token binding of
    src/channels/weixin/weixin-runtime.mjs and state-store.mjs.
  - ocean-crew/src/host/im/supervisor.ts follows the retry ladder and failure
    classification of dsh-im's connection supervisor
    (plugin-src/host/channels/feishu/connection-supervisor.mjs).
  - ocean-crew/src/host/im/reaction.ts follows the status-reaction lifecycle
    of src/channels/shared/status-reaction.mjs: a processing reaction on the
    message that asked for the work, removed and replaced by the success or
    error reaction when the turn ends, with transitions serialized per message
    and every provider failure absorbed.
  - ocean-crew/src/host/im/platforms/feishu.ts maps the official
    @larksuiteoapi/node-sdk events onto the Ocean Crew IM contract; the
    adapter follows the chat/mention contract of dsh-im's Feishu bridge
    (plugin-src/host/channels/feishu).
  - ocean-crew/src/host/im/format.ts follows the Markdown chunking of
    src/channels/shared/markdown-chunks.mjs and telegram-rich-message.mjs
    there: code fences stay whole where they fit and are re-fenced when they
    must be split.

  The MIT License text: see "License texts" below.

Runtime dependencies (installed from npm, not bundled; each package ships its
own license):

  - @larksuiteoapi/node-sdk 1.76.0 — MIT — the Feishu/Lark long connection
    and OpenAPI calls in host/im/platforms/feishu.ts.
  - playwright-core 1.65.0 — Apache-2.0 — the browser engine, loaded at run
    time; see Microsoft Playwright above.
  - imapflow 2.9.1 — MIT — the IMAP transport of the mail connector.
  - mailparser 3.12.4 — MIT — the message parser of the mail connector.
  - nodemailer 10.2.1 — MIT-0 — the SMTP transport of the mail connector.
  - qrcode-generator 2.0.4 — MIT, Copyright (c) Kazuhiko Arase — QR codes
    for the WeChat sign-in in the client bundle.

The plugin uses the @deepseek-ai/* packages of the DeepSeek Harness install it
runs in, and the React and interface modules the DSH Desktop window seeds;
they are not bundled. esbuild is a build tool only and is not distributed.

==============================================================================
License texts
==============================================================================

MIT License (covers this project's original material and the MIT-licensed
third-party code above):

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.

Apache License 2.0 (covers the derived portions and Deep View):
https://www.apache.org/licenses/LICENSE-2.0

==============================================================================
Original artwork
==============================================================================

The marine character pack (ocean-crew/src/client/marine-assets.ts and
assets/marine/: twelve shapes, thirteen colors, the eye layouts and the SVG
renderer) and the project's own illustrations in docs/images/ are original
artwork by the Ocean Crew contributors. They are not taken from any third
party; the only third-party marks in the interface are the Simple Icons and
Context7 marks listed above.

==============================================================================
Projects that gave us ideas (no code copied)
==============================================================================

We thank these projects for the designs they published. This project's design
was informed by them through its DS Bot history; it does not contain their
code.

  - AgentMemoryRepo (https://github.com/AgentMemoryRepo/agentmemoryrepo), MIT:
    the Markdown format of Bot memory (one entry per line with [key: value]
    metadata, a MEMORY.md index that links topic files).
  - OpenAI Codex (https://github.com/openai/codex), Apache-2.0:
    keeping the user's messages next to the summary in a checkpoint, and
    message anchors for searching earlier chat.
  - OpenMausBot (https://github.com/milind-soni/OpenMausBot), Apache-2.0:
    group chat rounds and @mention relays between Bots.
  - Hermes Agent (https://github.com/NousResearch/hermes-agent) and
    Hermes Bot Mode (https://github.com/NousResearch/Hermes-Bot-Mode), MIT:
    one Session per member per group chat, and the list of earlier user
    messages that the plugin, not the model, writes into the handoff.
  - OpenCode (https://github.com/sst/opencode), MIT;
    goose (https://github.com/block/goose), Apache-2.0;
    pi (https://github.com/badlogic/pi-mono), MIT;
    Gemini CLI (https://github.com/google-gemini/gemini-cli), Apache-2.0:
    when to condense a long conversation, and what a handoff note holds.
  - obelisk (https://github.com/tommy0103/obelisk), AGPL-3.0:
    searching a Bot's own chat with a SQLite FTS5 index ranked by BM25.
  - DeepSeek Harness Voice Input plugin
    (packages/experimental/client-ui-voice-input), MIT: the voice chat
    records with the same steps (record, resample to 16 kHz mono, PCM16 WAV)
    before it calls the plugin's speech service.
