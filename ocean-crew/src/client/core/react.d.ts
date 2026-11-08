// The platform modules the desktop window seeds for a plugin client: React, its DOM
// entry, and DSH's interface primitives. They stay external in the client bundle (DSH
// provides them at run time), so the type check only needs the small surface the client
// uses. This file is a declaration-only environment, not a runtime module.

declare module "react" {
	export type ReactNode = unknown;
	export type Key = string | number;
	export interface RefObject<T> {
		current: T;
	}
	export class Component<P = any, S = any> {
		props: P;
		state: S;
		constructor(props: P);
		setState(next: Partial<S> | ((prev: S, props: P) => Partial<S> | null) | null): void;
		forceUpdate(callback?: () => void): void;
		render(): unknown;
		componentDidMount?(): void;
		componentWillUnmount?(): void;
		componentDidCatch?(error: unknown, info: unknown): void;
		static getDerivedStateFromError?(error: unknown): unknown;
	}
	export const Fragment: any;
	export function createElement(type: any, props?: any, ...children: any[]): any;
	export function createRef<T = any>(): { current: T | null };
	export function memo<T>(component: T, compare?: (prev: any, next: any) => boolean): T;
	export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
	export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	export function useId(): string;
	export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
	export function useRef<T = any>(initial?: T): { current: T };
	export function useState<T = any>(initial?: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
	export function useSyncExternalStore<T>(
		subscribe: (onChange: () => void) => () => void,
		getSnapshot: () => T,
		getServerSnapshot?: () => T,
	): T;
	export function startTransition(action: () => void): void;
}

declare module "react-dom" {
	export function createPortal(children: any, container: any, key?: string | number | null): any;
}

// DSH's interface primitives; the client reaches them through src/client/dsh-primitives.ts.
declare module "@deepseek-ai/dsh-client-ui-primitives" {
	export const FileTypeIcon: any;
	export const JsonBlock: any;
	export const MarkdownText: any;
	export const FishLogo: any;
	export const writeClipboard: (text: string) => Promise<void> | void;
	export const details: any;
	export const exchange: any;
	export const fileExtension: any;
	export const fileSizeText: any;
	export const getSnapshot: any;
	export const leftDrawer: any;
	export const memory: any;
	export const menu: any;
	export const newChat: any;
	export const palette: any;
	export const panelYield: any;
	export const projectUserText: any;
	export const renaming: any;
	export const set: any;
	export const settings: any;
	export const side: any;
	export const subscribe: any;
	export const tab: any;
	export const view: any;
}
