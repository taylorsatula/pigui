// Phone photos are several megabytes; they are scaled down before upload so sending one is quick on a mobile network.
// The server fits them again to the model's own limits.

const MAX_EDGE = 2048;
const QUALITY = 0.85;

export type ShrunkPhoto = {
	blob: Blob;
	name: string;
	/** The photo as shot, before this scaling; absent when it could not be decoded (a GIF or SVG passes through). */
	width?: number;
	height?: number;
};

/** A JPEG no larger than MAX_EDGE on its long edge, or the file itself when it is not a photo or already small. */
export async function shrinkPhoto(file: File): Promise<ShrunkPhoto> {
	if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return { blob: file, name: file.name };
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		return { blob: file, name: file.name };
	}
	const { width, height } = bitmap;
	const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
	if (scale === 1 && file.size < 1_500_000) {
		bitmap.close();
		return { blob: file, name: file.name, width, height };
	}
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
	if (blob === null) return { blob: file, name: file.name, width, height };
	return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg", width, height };
}
