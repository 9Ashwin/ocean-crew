# Changelog

Ocean Crew is the owner's personal project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version can contain
breaking changes.

## [0.4.8] - 2026-11-10

### Changed

- A Bot's answer in Feishu is a plain white card: no coloured header bar, the text alone on
  the card's background. Interactive cards (buttons, forms) keep their header, because the
  buttons need that context.
- The `speak` tool no longer invites the model to announce itself: its result says the line
  already arrived and that the reply should not mention the voice, the tool or the delivery,
  so a spoken answer reads as someone talking instead of a system notice.

## [0.4.7] - 2026-11-10

### Fixed

- A companion's reaction emoji now appears on the user's message. The lookup required the
  chat's session from a slot whose props do not promise one, so every mark was stored and
  never drawn; it asks the message's own chat first and falls back to any chat, since a
  message id is unique.

- `/help` on a plain-text platform is one message instead of one bubble per command.

## [0.4.6] - 2026-11-10

### Fixed

- A marine Bot now smiles and follows the pointer when hovered: its eyes carry a happy arc
  and a gaze group of their own, so the whole cast answers the cursor, not only the
  geometric shapes.

## [0.4.5] - 2026-11-10

### Fixed

- A companion's reaction emoji is stored under the event seq the window numbers a message
  with (and the durable id), so the mark is found instead of saved and lost.

## [0.4.4] - 2026-11-10

### Added

- A companion reacts to some of what the user says with one emoji under the user's bubble
  (love, thanks, laughing, goodnight, tired, food, cute, cheering, questions, surprise),
  at most every other message and never the same emoji twice in a row.

## [0.4.3] - 2026-11-10

### Added

- The mood is legible where the eye lands: one mood emoji on the avatar's corner with the
  mood and closeness on hover, and the mood named next to the Bot's name in the header.

## [0.4.2] - 2026-11-09

### Fixed

- A companion's closeness and mood move on the words the user actually sent: the host's
  user message carries its parts on `data.content`, and reading a nested message skipped
  every message silently.

## [0.4.1] - 2026-11-09

### Fixed

- Settings → Companion renders its page instead of an empty column, and a source check keeps
  every listed settings page and its render branch together.

## [0.4.0] - 2026-11-09

### Added

- A team of long-lived Bots: Main Bots, Bot-to-Bot messages, group chats with rounds and
  relays, hand-offs and a durable work tree.
- Bot memory with review batches, goals with per-task acceptance, approvals, schedules,
  learning proposals and a session chat index.
- The Bot browser (one Chrome profile per Bot), Feishu and WeChat private chats, mail and
  the GitHub connector, computer use, and the web search provider.
- 12 sea characters with picker, colors and moods, plus the Ocean Crew marks and themes.
- Companion mode: a Bot can be a character with its own card (who they are, how they talk,
  what they like), a mood and a growing closeness. The card joins the identity prompt; the
  mood and closeness are injected once at the head of a turn, and the closeness moves a
  little after each message, cooling after days away. Companions speak their answers in
  their own voice, can be heard from the message menu, and may carry a daily check-in that
  creates a real scheduled task.
- Voice: a configurable speech model turns a short line into audio and sends it through the
  attachment path — a Feishu voice bubble (opus) or a WeChat audio file — with a Voice
  settings page (model, voice, language, format, delivery notes, test button) and optional
  spoken copies of every answer.

### Changed

- The plugin is published to npm, so installing it takes the package name `ocean-crew` in
  DSH's plugin dialog: no checkout and no local build. A `v<version>` tag builds, checks and
  publishes it; the token lives in the repository secret. A GitHub spec still works for
  development builds.
- The plugin ships from `ocean-crew/`; `dist/` and `client.js` are build products and
  stay out of git, so an install builds the checkout first.
- The DSH profile patch, host prompts, client module id, i18n namespace and CSS tokens all
  use the `ocean-crew` name.

### Removed

- Platform adapters other than Feishu and WeChat, and the optional browser plugin folder;
  the browser backends ship in the plugin.
