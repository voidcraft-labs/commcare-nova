import {
	originalPhotoMetadata,
	resizedPhotoWithMetadata,
} from "./androidPhotoMetadata";
import { AttachmentRejected } from "./attachmentClient";

/** FileUtil.scaleAndSaveImage and ImageCaptureProcessing in CommCare Android.
 * The staged attachment contains the resized pixels; ImageWidget shows the raw copy. */
export async function androidPhotoForUpload(
	file: File,
	limit: number,
	signal: AbortSignal,
): Promise<File> {
	const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
	const type =
		extension === ".jpg" || extension === ".jpeg"
			? "image/jpeg"
			: extension === ".png"
				? "image/png"
				: undefined;
	if (!type) return file;
	const { pixels, tiff } = await originalPhotoMetadata(file);
	signal.throwIfAborted();
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(pixels);
	} catch {
		// An undecodable file leaves FileUtil with no bitmap to resize.
		return file;
	}
	try {
		signal.throwIfAborted();
		const side = Math.max(bitmap.width, bitmap.height);
		if (side <= limit) return file;
		const width =
			bitmap.width === side ? limit : Math.floor(limit * (bitmap.width / side));
		const height =
			bitmap.height === side
				? limit
				: Math.floor(limit * (bitmap.height / side));
		if (!width || !height)
			throw new AttachmentRejected(
				"This photo is too narrow for that size. Choose another photo or increase the longest side.",
			);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		try {
			const context = canvas.getContext("2d");
			if (!context)
				throw new AttachmentRejected(
					"This browser could not resize the photo. You can try again or choose a smaller photo.",
				);
			context.imageSmoothingQuality = "high";
			context.drawImage(bitmap, 0, 0, width, height);
			const encoded = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, type, 1),
			);
			signal.throwIfAborted();
			if (!encoded || encoded.type !== type)
				throw new AttachmentRejected(
					"This browser could not save the resized photo. You can try again or choose a smaller photo.",
				);
			return new File(
				[resizedPhotoWithMetadata(encoded, tiff, width, height)],
				file.name,
				{ type, lastModified: file.lastModified },
			);
		} finally {
			canvas.width = 0;
			canvas.height = 0;
		}
	} finally {
		bitmap.close();
	}
}
