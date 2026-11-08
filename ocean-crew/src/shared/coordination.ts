// source identity, prepared delivery, result publication and notification obligations.
// They are types only (no storage, no behavior); the store keeps its `state.json` shape

//
// adding fields later is a
// schema change and needs a migration.

export const COORDINATION_SCHEMA_VERSION = 1;

/** Where a message or a piece of work logically lives: a Bot or a group, across parts. */
export interface ConversationRef {
	botId?: string;
	roomId?: string;
	logicalConversationId: string;
	sessionId?: string;
}

/** Trust level of a source event; user text is the only one that carries user intent. */
export type TrustLevel = "user" | "bot" | "tool" | "web" | "mcp";

/** How a message reached the team: the exact entry point, not the most recent one. */
export interface Origin {
	actorId: string;
	connectionId?: string;
	directChatId?: string;
	messageId?: string;
	requestId: string;
	bindingRevision?: number;
	trustLevel: TrustLevel;
}

/** One delivery's state. Errors never collapse into "done": unknown stays unknown. */
export type DeliveryState =
	| "queued"
	| "attempting"
	| "accepted"
	| "retryable"
	| "rejected"
	| "unknown"
	| "blocked"
	| "cancelled_before_attempt";

/** The declared capability of an IM adapter's prepared-delivery contract. */
export interface DeliveryCapabilities {
	preparedVersion: 1;
	supportsIdempotency: boolean;
	supportsLookup: boolean;
	supportsEdit: boolean;
	receiptLevel: "accepted" | "delivered";
}

export interface DeliveryPart {
	deliveryId: string;
	partIndex: number;
	payloadHash: string;
	/** A part that must be accepted before this one may be sent. */
	dependsOn?: number[];
}

export interface DeliveryAttempt {
	deliveryId: string;
	attempt: number;
	startedAt: number;
	receipt?: { messageId?: string; acceptedAt: number };
	outcome: DeliveryState;
}

/** A reply prepared in full before any transport call; nothing is split after this point. */
export interface PreparedReply {
	replyId: string;
	parts: DeliveryPart[];
	payloadHash: string;
}

export interface Delivery {
	deliveryId: string;
	obligationId: string;
	destination: { key: string; kind: "origin" | "explicit" | "mirror" };
	parts: DeliveryPart[];
	state: DeliveryState;
	attempts: DeliveryAttempt[];
}

/** Who owes the user an answer, and why. */
export interface NotificationObligation {
	obligationId: string;
	causalEventId: string;
	kind: "requested_result" | "subscribed_change" | "optional_suggestion";
	audienceKey: string;
	route: "origin" | "explicit" | "mirrors";
	state: "open" | "deferred" | "prepared" | "satisfied" | "closed_with_reason";
}

/** A result that must reach its owner; publication is the durable promise to deliver it. */
export interface ResultPublication {
	runId: string;
	resultRevision: number;
	workId?: string;
	obligationId?: string;
	completedAt: number;
}

/** What an approval was given for; it is checked again before the action runs. */
export interface ApprovalRef {
	workId?: string;
	runId?: string;
	toolCallId: string;
	argsHash: string;
	target: string;
	audience?: string;
	permissionRevision?: number;
	expiry?: number;
}

/** Whether durable sends and dispatches may proceed on this host. */
export type WriterMode = "owned" | "readonly" | "degraded";
