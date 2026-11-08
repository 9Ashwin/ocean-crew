// The deep-view blueprint checker and React views: a DSH dependency bundled into the
// client, so its members are declared here for the type check and left to the bundle
// (esbuild resolves the package itself). One declaration per name the client imports.
declare module "deep-view/core" {
	export function checkShownView(title: unknown, view: unknown): any;
}

declare module "deep-view/react" {
	export const DEEP_VIEW_CSS: string;
	export const ViewUi: any;
	export const WidgetCard: any;
	export const WidgetView: any;
	export const ViewMenuList: any;
}
