/**
 * SVG's refusal, client-safe so the builder's Upload tab can say it without
 * importing the upload gate's parsers. CommCare HQ types an SVG as an image
 * and cannot store it: `hqmedia/models.py::CommCareImage.attach_data` opens
 * every image with Pillow, which reads no SVG, and the error stops the whole
 * bulk upload. `validate.ts` refuses with it before its allow-list, and the
 * initiate route before its generic sentence.
 */

/** The refusal of an SVG, at upload and in the builder's Upload tab. */
export const SVG_REFUSAL_MESSAGE =
	"CommCare HQ can't store SVG images, so no CommCare app can show this one. Saving it as a PNG fixes that.";

/**
 * Whether a filename or a raw MIME claim names SVG: the name ends `.svg`
 * (case-insensitive), or the claim, lowercased with its parameters stripped,
 * is `image/svg+xml`.
 */
export function namesSvg(filename: string, claimedMimeType: string): boolean {
	const claim = claimedMimeType.trim().toLowerCase().split(";")[0]?.trim();
	return filename.toLowerCase().endsWith(".svg") || claim === "image/svg+xml";
}
