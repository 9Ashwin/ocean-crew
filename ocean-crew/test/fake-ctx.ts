// In-memory stand-ins for the DSH plugin context and the services it exposes. A host
// module is installed against one of these and the test asserts on what it registered:
// `calls` (every registration in order), `listeners`, `registeredTools`, `guards`,
// `sections` and the `llm` adapters. the types are local
// on purpose, so this file does not chase the changing src/host/runtime.ts context type.

// A generic file in DSH's `attachments` service.
export interface FakeAttachment {
	attachmentId: string;
	name: string;
	bytes: number;
}

// DSH's `attachments` service for generic files, in memory. Reads come back in small
// chunks that split characters, as a stream may.
export function fakeAttachments() {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		async saveFile({ data, name }: { data: Uint8Array; name: string }): Promise<FakeAttachment> {
			const ref = { attachmentId: `sha256:${files.size + 1}`, name, bytes: data.length };
			files.set(ref.attachmentId, data);
			return ref;
		},
		async *readFileStream(ref: { attachmentId: string }): AsyncGenerator<Uint8Array> {
			const data = files.get(ref.attachmentId);
			if (data === undefined) throw new Error("no such file");
			for (let at = 0; at < data.length; at += 1001) yield data.subarray(at, at + 1001);
		},
	};
}

// DSH's `approval` service, recording every request. `outcome` is either the answer to
// always give or a function of the request count and the request itself.
export function fakeApproval<Request = unknown>(outcome: unknown = "allowed-once") {
	const requests: Request[] = [];
	return {
		requests,
		async request(request: Request): Promise<unknown> {
			requests.push(request);
			return typeof outcome === "function"
				? (outcome as (count: number, request: Request) => unknown)(requests.length, request)
				: outcome;
		},
	};
}

export type FakeListener = (...args: any[]) => unknown;

// A tool object as a host module registers it; the fake records the object as-is, so the
// remaining fields stay open and a test can call `execute` and its like.
export type FakeTool = Record<string, any> & { name: string };

// A system-prompt section; `text` is normally the section's prompt function.
export type FakeSection = Record<string, any> & { name: string; order?: number };

// A `connection.fetch.register` route.
export type FakeRoute = Record<string, any> & { methods: readonly string[]; path: string };

// A tool guard: called with a tool call and returns why it is refused, or nothing.
export type FakeGuard = (...args: any[]) => unknown;

// The Agent handle `ctx.scopeAgent` gives a test; its tool scope feeds the same
// `registeredTools` map the global registrations use.
export interface FakeAgentHandle {
	id: string;
	session: { id: string };
	ctx: {
		tools: { register(tool: FakeTool): () => void };
		effect(execute: () => unknown, label?: string): void;
		on(name: string, listener: FakeListener, options?: { prepend?: boolean }): () => void;
	};
}

// An `llm.registerAdapter` handle; `replace` swaps the routes of the adapter last added.
export interface FakeAdapterHandle {
	(): void;
	replace(routes: any): void;
}

export interface FakeContext {
	// Registration calls in order, as short labels: "on event", "tool name", "effect label",
	// "prompt name order", "route METHODS path", "tools guard".
	calls: string[];
	registeredTools: Map<string, FakeTool>;
	guards: FakeGuard[];
	// Listeners by event name, in registration order.
	listeners: Map<string, FakeListener[]>;
	sections: Map<string, FakeSection>;
	logger: { warn(...args: unknown[]): void; info(...args: unknown[]): void };
	get(name: string): any;
	// As in real cordis: the plugin does not inject this service, so reading it throws.
	readonly subagents: never;
	// The real ctx guards plain access with `inject`; service() reads this.
	reflect: { get(name: string): any };
	on(name: string, listener: FakeListener, options?: { prepend?: boolean }): () => void;
	// Calls the plain listeners of an event; middleware (with `next`) is not run.
	emit(name: string, payload?: unknown): void;
	// emit, but waits for async listeners — for paths like agent/created whose work must
	// finish before the test goes on.
	emitAsync(name: string, payload?: unknown): Promise<void>;
	scopeAgent(sessionId: string): FakeAgentHandle;
	effect(execute: () => unknown, label?: string): void;
	// Settles once every cleanup has, including the writes some of them wait for.
	dispose(): Promise<PromiseSettledResult<unknown>[]>;
	tools: {
		register(tool: FakeTool): () => void;
		guard(guard: FakeGuard): () => void;
		schemas(): unknown[];
	};
	systemPrompt: {
		section(section: FakeSection): () => void;
	};
	connection: {
		fetch: {
			register(route: FakeRoute): () => void;
		};
	};
	llm: {
		listProviders(): unknown[];
		registerAdapter(routes: any, adapter: any): FakeAdapterHandle;
	};
	adapters?: Array<{ routes: any; adapter: any }>;
}

export interface FakeContextOptions {
	services?: Record<string, any>;
}

// A stand-in for the plugin context that records what apply() registers, in order,
// without starting any service.
export function fakeContext({ services = {} }: FakeContextOptions = {}): FakeContext {
	const calls: string[] = [];
	const disposers: Array<() => unknown> = [];
	const registeredTools = new Map<string, FakeTool>();
	const guards: FakeGuard[] = [];
	const listeners = new Map<string, FakeListener[]>();
	const sections = new Map<string, FakeSection>();
	const ctx: FakeContext = {
		calls,
		registeredTools,
		guards,
		listeners,
		sections,
		logger: { warn() {}, info() {} },
		get: (name) => services[name],
		get subagents(): never {
			throw new Error('cannot get property "subagents" without inject');
		},
		reflect: { get: (name) => ctx.get(name) },
		on(name, listener, options) {
			calls.push(`on ${name}${options?.prepend ? " (prepend)" : ""}`);
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return () => {};
		},
		emit(name, payload) {
			for (const listener of listeners.get(name) ?? []) {
				if (listener.length < 2) listener(payload);
			}
		},
		async emitAsync(name, payload) {
			for (const listener of listeners.get(name) ?? []) {
				if (listener.length < 2) await listener(payload);
			}
		},
		scopeAgent(sessionId) {
			return {
				id: sessionId,
				session: { id: sessionId },
				ctx: {
					tools: {
						register: (tool) => {
							registeredTools.set(tool.name, tool);
							return () => {};
						},
					},
					effect: () => {},
					on: () => () => {},
				},
			};
		},
		effect(execute, label) {
			calls.push(`effect ${label}`);
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
		dispose() {
			return Promise.allSettled(
				disposers
					.splice(0)
					.reverse()
					.map((dispose) => dispose()),
			);
		},
		tools: {
			register(tool) {
				calls.push(`tool ${tool.name}`);
				registeredTools.set(tool.name, tool);
				return () => {};
			},
			guard(guard) {
				calls.push("tools guard");
				guards.push(guard);
				return () => {};
			},
			schemas: () => [],
		},
		systemPrompt: {
			section(section) {
				calls.push(`prompt ${section.name} ${section.order}`);
				sections.set(section.name, section);
				return () => {};
			},
		},
		connection: {
			fetch: {
				register(route) {
					calls.push(`route ${route.methods.join(",")} ${route.path}`);
					return () => {};
				},
			},
		},
		llm: {
			listProviders: () => [],
			registerAdapter: (routes, adapter) => {
				ctx.adapters = [...(ctx.adapters ?? []), { routes, adapter }];
				const handle: FakeAdapterHandle = () => {};
				handle.replace = (next) => {
					ctx.adapters!.at(-1)!.routes = next;
				};
				return handle;
			},
		},
	};
	return ctx;
}
