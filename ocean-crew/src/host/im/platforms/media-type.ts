// The media type of an image is decided by its bytes, never by what a platform calls
// the file: a declared type that disagrees with the bytes is refused by the host, and a
// mislabeled screenshot would otherwise never reach the model.
export const imageMediaTypeOf = (data: Uint8Array): string => {
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
		return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 6 &&
		(bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")
	)
		return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
		bytes.subarray(8, 12).toString("latin1") === "WEBP"
	)
		return "image/webp";
	return "application/octet-stream";
};
// Only a type the host accepts as an image is announced as one; anything else goes as a
// file so the bytes still reach the model's tools.
export const isSupportedImageType = (mediaType: string): boolean =>
	mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/gif" || mediaType === "image/webp";

// The timing a voice item carries: WeChat draws a voice bubble from the duration, so an
// MP3 read frame by frame gives it without another dependency. A file this cannot parse
// (or a non-MP3 format) gets no timing and the platform decides what to render.
const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_SAMPLE_RATES: Record<number, number[]> = {
	3: [44100, 48000, 32000], // MPEG 1
	2: [22050, 24000, 16000], // MPEG 2
	0: [11025, 12000, 8000], // MPEG 2.5
};

export const mp3Timing = (data: Uint8Array): { durationMs: number; sampleRate: number } | undefined => {
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let at = 0;
	// An ID3v2 tag is not audio: its synchsafe size follows the "ID3" marker.
	if (bytes.length > 10 && bytes.subarray(0, 3).toString("latin1") === "ID3") {
		const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
		at = 10 + size;
	}
	let total = 0;
	let sampleRate = 0;
	let frames = 0;
	while (at + 4 <= bytes.length && frames < 200_000) {
		if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) break;
		const versionBits = (bytes[at + 1] >> 3) & 0x3;
		const layerBits = (bytes[at + 1] >> 1) & 0x3;
		if (versionBits === 1 || layerBits !== 1) break; // reserved version, or not Layer III
		const bitrateIndex = (bytes[at + 2] >> 4) & 0xf;
		const rateIndex = (bytes[at + 2] >> 2) & 0x3;
		if (bitrateIndex === 0 || bitrateIndex === 0xf || rateIndex === 3) break;
		const rate = MP3_SAMPLE_RATES[versionBits]?.[rateIndex];
		if (rate === undefined) break;
		const mpeg1 = versionBits === 3;
		const bitrate = MP3_BITRATES[bitrateIndex] * 1000;
		const padding = (bytes[at + 2] >> 1) & 0x1;
		const length = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / rate) + padding;
		if (length <= 4) break;
		sampleRate = rate;
		total += mpeg1 ? 1152 : 576;
		frames += 1;
		at += length;
	}
	if (frames === 0) return undefined;
	return { durationMs: Math.max(1, Math.round((total / sampleRate) * 1000)), sampleRate };
};
