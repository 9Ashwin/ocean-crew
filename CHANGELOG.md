# Changelog

Ocean Crew is the owner's personal project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version can contain
breaking changes.

## [0.4.0] - 2026-11-08

### Added

- A team of long-lived Bots: Main Bots, Bot-to-Bot messages, group chats with rounds and
  relays, hand-offs and a durable work tree.
- Bot memory with review batches, goals with per-task acceptance, approvals, schedules,
  learning proposals and a session chat index.
- The Bot browser (one Chrome profile per Bot), Feishu and WeChat private chats, mail and
  the GitHub connector, computer use, and the web search provider.
- 12 sea characters with picker, colors and moods, plus the Ocean Crew marks and themes.

### Changed

- The plugin ships from `ocean-crew/`; `dist/` and `client.js` are build products and
  stay out of git, so an install builds the checkout first.
- The DSH profile patch, host prompts, client module id, i18n namespace and CSS tokens all
  use the `ocean-crew` name.

### Removed

- Platform adapters other than Feishu and WeChat, and the optional browser plugin folder;
  the browser backends ship in the plugin.

