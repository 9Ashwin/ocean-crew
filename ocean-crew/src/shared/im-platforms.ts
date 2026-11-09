// The IM platforms Ocean Crew can connect to: Feishu (private chats and groups) and
// WeChat (private chats only until iLink's group semantics are confirmed). A group chat
// bound to an in-app group chat is how the Bot team talks to people where they already are.
// The settings page draws the add form from `fields`; `secret` fields are kept as
// Ocean Crew secrets and never leave the host. `buttons`: the platform can show card
// buttons; `login: 'qr'`: the connection starts by scanning a code.
export interface ImPlatformField {
	key: string;
	label: string;
	secret?: boolean;
	options?: [string, string][];
}

export interface ImPlatform {
	id: "feishu" | "weixin";
	name: string;
	fields: ImPlatformField[];
	buttons: boolean;
	groups: boolean;
	login?: "qr";
}

export const IM_PLATFORMS: ImPlatform[] = [
	{
		id: "weixin",
		name: "WeChat",
		fields: [],
		buttons: false,
		groups: false,
		login: "qr",
	},
	{
		id: "feishu",
		name: "Feishu / Lark",
		fields: [
			{
				key: "domain",
				label: "Edition",
				options: [
					["feishu", "Feishu"],
					["lark", "Lark"],
				],
			},
			{ key: "appId", label: "App ID" },
			{ key: "appSecret", label: "App Secret", secret: true },
		],
		buttons: true,
		groups: true,
	},
];

export const imPlatform = (id: unknown): ImPlatform | undefined => IM_PLATFORMS.find((platform) => platform.id === id);

// The platform a user message came in over: IM messages carry im:<platform>:<uuid> as
// their requestId.
export const viaOf = (source: unknown): string | undefined => {
	const requestId = (source as { rpcId?: unknown } | undefined)?.rpcId;
	return typeof requestId === "string" && requestId.startsWith("im:") ? requestId.split(":")[1] : undefined;
};
