# Changelog

Ocean Crew is the owner's personal project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version can contain
breaking changes.

## [0.6.10] - 2026-11-10

### Fixed

- A Bot can send a voice message without switching on "speak instead of typing". The side-effect
  check classified the plugin's own tools as outside writes — `speak`, `send_file`, `message_bot`,
  `post_to_group`, `ask_user` — so every voice note asked for an approval card, and an unanswered
  card denied it. A card that appears before a Bot can use its own voice is not a protection, it is
  an outage. The plugin's own tools now run as called; third-party writes (`mcp__*` create/send,
  `mail_send`) still ask.

## [0.6.9] - 2026-11-10

### Added

- A Bot now knows where it is talking. When a message comes from Feishu or WeChat, the turn carries
  one context message naming the platform, whether it is a direct or group chat (and the group's
  name), and the rules of that place: keep it short, no headings or status reports, "send it to me"
  means this chat, an answer already reaches the user so do not repeat it, and what the user sent is
  an attachment. Before this the prompt was identical in the window and in a chat, which is why a
  chat could get a report written for a desktop.
- The snapshot is added once per place, not once per step: a long turn does not collect copies, and
  a conversation that moves from a direct chat to a group gets a fresh one.

## [0.6.8] - 2026-11-10

### Added

- Settings → Tool permissions can now **grant** a tool as well as take it back. The page could only
  revoke, so a standing permission could never be given from the window at all: the one place meant
  to hold it was one-directional.

### Changed

- A refused or expired approval now closes that action for the conversation, instead of the tool call
  being asked again. A card that was withdrawn because the action, the chat or the permissions
  changed is *not* a refusal — the user never answered, so the same action may be asked about again
  once the world settles.

## [0.6.7] - 2026-11-10

### Fixed

- The rest of Feishu's emoji now arrives as emoji. The panel writes the emoji's *name* into the text
  (`[了解]`, `[捂脸]`, `[红包]` …), and only a dozen codes were mapped, so the others still read as
  brackets. The table now covers the names the panel writes, the English spelling a client may send
  instead (`[get]`, `[OK]`), and Feishu's own stickers — `[了解]` is its "Get" sticker, which has no
  character of its own, so it maps to the closest one. A code in neither list is still left exactly
  as it came.

## [0.6.6] - 2026-11-10

### Fixed

- An emoji sent from Feishu now arrives as that emoji in the window. Feishu's emoji panel puts a
  code like `[赞]` into the message text, so the message read as brackets everywhere; the codes
  people actually use are mapped back to their character, and an unknown code is left as it came
  rather than guessed at.
- A Feishu sticker is a picture, and it was dropped entirely: no text, no image, no file. It is now
  read as the image the chat shows, and a sticker whose bytes cannot be read still says `[Emoji]`
  instead of vanishing.

## [0.6.5] - 2026-11-10

### Fixed

- A message that is only an image or a file has no bubble, so the companion's mark had nothing to
  hang on and disappeared. It now hangs on the attachment block the same way: half over its bottom
  edge, with the block keeping room underneath.

## [0.6.4] - 2026-11-10

### Changed

- The companion's mark now sits on the message bubble instead of under it: drawn inside the bubble,
  half over its bottom edge, with the bubble keeping a little extra room underneath so the last line
  is never covered. It reads as a reaction to that message rather than as another line in the chat,
  and a tap on it still opens the bubble's own tools.

## [0.6.3] - 2026-11-10

### Fixed

- The companion's reaction now actually appears in the window. The custom user-message row was
  gated on a helper from `@deepseek-ai/dsh-client-ui-primitives`, which the shipped desktop runtime
  does not contain — so the gate read false everywhere and the row this plugin draws was never used,
  which is why a stored mark was never seen. The row now draws itself: its text through the shell's
  own text slot, its file label and size from the attachment, no primitives import at all.

## [0.6.2] - 2026-11-10

### Added

- The companion's reaction now also lands on the message in Feishu, on the same terms as in the
  window: one mark every few messages, never the same emoji twice in a row. The emoji the window
  shows is mapped to the platform's own key (`❤️` → `HEART`, `🤔` → `THINKING`, …); a mark with no
  key, a chat with no message to mark, or a mark the service refuses simply leaves the chat
  unmarked — the window still shows it, and nothing waits on it.

## [0.6.1] - 2026-11-10

No product change: 0.6.0's test suite failed on one DSH version in CI over a test that asserted
answer routing the harness does not bind there. The test now asserts what the change is about — a
companion adds no speech of its own — and this release is the same code with a green gate.

## [0.6.0] - 2026-11-10

### Added

- Temporary workers: `spawn_worker` starts a side job in its own session that is not on the team,
  writes no memory and is archived when it finishes, and `stop_worker` stops one. DSH's own
  delegation service runs the child with caller delivery, so the Bot decides what to tell the user
  and the worker's answer comes back as a tool result. Three workers per Bot, twenty minutes each,
  and a worker that did not survive a restart says so instead of looking busy.
- Event-triggered routines: `create_routine`, `list_routines` and `delete_routine` set up work that
  starts on something happening rather than on a clock — an incoming IM message containing one of
  its words, optionally in one chat only. The turn it opens is framed as a scheduled task, so the
  run records, the `[PASS]` silence rule and the failure notice apply unchanged.
- Temporary workers are in the background view and are stopped by the team stop.

### Notes

- Only the `im_keyword` source is wired; a mail trigger is deliberately not declared, because a
  trigger that never fires would look like a feature.

## [0.5.3] - 2026-11-10

### Added

- One stop for the whole team: `/stop all` in IM and "Stop everything" in a Bot's details stop
  every running chat turn, every group round and the work they handed on, close the results still
  owed as abandoned with the reason, and report what could not be stopped and what already went
  out — because a stop is not an undo.
- A background view of the team's work: what each running Session is doing, since when, and for
  which hand-off. A run that repeats the same call with the same arguments, or makes no progress
  for ten minutes, is marked as stuck and announced once.

## [0.5.2] - 2026-11-10

### Added

- Content from outside the team no longer reads like the user's words: a web page, an email or a
  connector read is wrapped in a fence named `<untrusted-…>` with a random per-read suffix, the
  text's own copies of the closing marker are defused, and the Bot's prompt carries the rule that
  a fence is data and never instructions.
- A turn that read fenced content must show a card before it sends, deletes or pays, even for a
  tool the user allowed in advance: the grant answers for the tool they know, not for a turn fed
  someone else's text.

## [0.5.1] - 2026-11-10

### Added

- A tool call that sends, deletes or pays is shown to the user before it runs, whatever tool
  carries it: the call is classified by name (`read`, `draft`, `external_send`, `destructive`,
  `payment`) and an unrecognised name counts as strict. The card is DSH's own approval card, so
  there is no second approval system; IM and the window both answer it.
- A refusal is terminal for that turn: the same call is not asked twice, the same target is
  refused even through another tool, and only a call that actually dispatched counts as a grant.
- Settings → Tool permissions lists the standing grants, and removing one brings the card back.

## [0.5.0] - 2026-11-10

### Added

- A scheduled task that ran and failed now says so: every firing leaves a run record (task,
  chat, start, finish, outcome, reason), the settings page shows the last run of each task and
  marks a failure, and a failed scheduled turn sends one notice per failure code — cleared by
  the next success, so a recurrence is news again.
- An answer of `[PASS]` to a routine is silence by agreement: nothing is pushed, and the run is
  recorded as `silent`.
- One gate for every unsolicited message (`work/notice-gate.ts`): the pure policy decides
  dedupe, quiet hours and preferences, and a receipt is written only after the platform
  accepted the notice, so a failed send is retried as news.

## [0.4.9] - 2026-11-10

### Fixed

- An answer is no longer said twice: companion mode used to force a spoken copy of every
  reply, so each one arrived as both text and audio. Speaking is now only what Settings →
  Voice asks for ("Speak answers instead of typing them"), and when it is on the audio
  **replaces** that answer's text instead of repeating it. A speech that fails falls back to
  sending the words as text, so an answer is never lost.

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
