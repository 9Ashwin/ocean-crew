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
