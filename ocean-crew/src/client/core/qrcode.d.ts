// WeChat QR sign-in draws its code with qrcode-generator, the same library the
// reference client used. It stays a normal dependency of the plugin; this only declares
// the small surface the IM page uses for the type check.
declare module "qrcode-generator" {
	export interface QrCode {
		addData(data: string): void;
		make(): void;
		getModuleCount(): number;
		isDark(row: number, column: number): boolean;
	}
	export default function qrcode(typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H"): QrCode;
}
