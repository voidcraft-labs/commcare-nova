// components/builder/media/assetKindMeta.ts
//
// Per-kind presentation metadata shared across the media UI, the
// icon, the human label, the `accept` string for the native file
// input, and a human-readable `extLabel` (the formats to SHOW the
// user, e.g. "PNG, JPEG"). Both `accept` and `extLabel` derive from the
// domain registry (`ACCEPTED_FORMATS`) so the picker's filter can't drift
// from what the validator accepts.

import type { IconifyIcon } from "@iconify/types";
import tablerFileText from "@iconify-icons/tabler/file-text";
import tablerFileTypeDocx from "@iconify-icons/tabler/file-type-docx";
import tablerFileTypePdf from "@iconify-icons/tabler/file-type-pdf";
import tablerFileTypeXls from "@iconify-icons/tabler/file-type-xls";
import tablerMusic from "@iconify-icons/tabler/music";
import tablerPhoto from "@iconify-icons/tabler/photo";
import tablerVideo from "@iconify-icons/tabler/video";
import { ACCEPTED_FORMATS, type AssetKind } from "@/lib/domain/multimedia";

export interface AssetKindMeta {
	readonly icon: IconifyIcon;
	/** Capitalized singular label, e.g. "Image". */
	readonly label: string;
	/** `accept` attribute for the file input: the kind's MIME types and extensions. */
	readonly accept: string;
	/** User-facing format list, e.g. "PNG, JPEG, GIF, WebP, BMP". */
	readonly extLabel: string;
}

/**
 * The `accept` string and the format list of one kind's accepted formats,
 * leaving out each format `excluded` names by its canonical MIME. `accept`
 * holds each format's MIME types and its declared extensions: browsers report
 * `.m4a`, `.flac`, `.opus`, `.ogg`, `.md` and office files inconsistently (an
 * empty type or `application/octet-stream`), so the extension is what makes
 * the OS file picker show them.
 */
export function kindFormats(
	kind: AssetKind,
	excluded: (mimeType: string) => boolean = () => false,
): { readonly accept: string; readonly extLabel: string } {
	const formats = ACCEPTED_FORMATS.filter(
		(format) => format.kind === kind && !excluded(format.mime),
	);
	return {
		accept: formats
			.flatMap((format) => [format.mime, ...format.declaredExtensions])
			.join(","),
		extLabel: formats.map((format) => format.label).join(", "),
	};
}

const KIND_PRESENTATION: Record<
	AssetKind,
	{ readonly icon: IconifyIcon; readonly label: string }
> = {
	image: { icon: tablerPhoto, label: "Image" },
	audio: { icon: tablerMusic, label: "Audio" },
	video: { icon: tablerVideo, label: "Video" },
	pdf: { icon: tablerFileTypePdf, label: "PDF" },
	text: { icon: tablerFileText, label: "Text" },
	docx: { icon: tablerFileTypeDocx, label: "Word" },
	xlsx: { icon: tablerFileTypeXls, label: "Excel" },
};

export const ASSET_KIND_META = Object.fromEntries(
	(Object.keys(KIND_PRESENTATION) as AssetKind[]).map((kind) => [
		kind,
		{ ...KIND_PRESENTATION[kind], ...kindFormats(kind) },
	]),
) as Record<AssetKind, AssetKindMeta>;
