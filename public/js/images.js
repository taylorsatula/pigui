// Re-encode oversized camera photos to JPEG (max 2048 px edge, 0.85 quality) before uploading.

const MAX_EDGE = 2048;
const QUALITY = 0.85;
const SKIP_BELOW_BYTES = 1_500_000;

export async function shrinkPhoto(file) {
	if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return { blob: file, name: file.name };
	try {
		const bitmap = await createImageBitmap(file);
		try {
			const edge = Math.max(bitmap.width, bitmap.height);
			const scale = edge > MAX_EDGE ? MAX_EDGE / edge : 1;
			if (scale === 1 && file.size < SKIP_BELOW_BYTES) return { blob: file, name: file.name };
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) return { blob: file, name: file.name };
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
			if (!blob) return { blob: file, name: file.name };
			return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
		} finally {
			bitmap.close();
		}
	} catch {
		return { blob: file, name: file.name };
	}
}
