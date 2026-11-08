// Every platform with an adapter. This builds only the connectors the owner uses:
// Feishu and WeChat, private chats only.
// `id`, `check`, `connect` (which owns the wire and returns the send handle).
import feishu from "./feishu.ts";
import weixin from "./weixin.ts";

export const adapters = { feishu, weixin };
