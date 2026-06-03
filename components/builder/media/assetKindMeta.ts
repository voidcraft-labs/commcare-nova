// components/builder/media/assetKindMeta.ts
//
// Per-kind presentation metadata shared across the media UI — the
// icon, the human label, the `accept` string for the native file
// input, and a human-readable `extLabel` (the extensions to SHOW the
// user, e.g. "PNG, JPG"). The `accept` is derived from the domain MIME
// partitions so the picker's filter can't drift from what the validator
// accepts; `extLabel` is the user-facing spelling of the same set.

import type { IconifyIcon } from "@iconify/types";
import tablerFileText from "@iconify-icons/tabler/file-text";
import tablerFileTypeDocx from "@iconify-icons/tabler/file-type-docx";
import tablerFileTypePdf from "@iconify-icons/tabler/file-type-pdf";
import tablerFileTypeXls from "@iconify-icons/tabler/file-type-xls";
import tablerMusic from "@iconify-icons/tabler/music";
import tablerPhoto from "@iconify-icons/tabler/photo";
import tablerVideo from "@iconify-icons/tabler/video";
import {
	type AssetKind,
	AUDIO_MIME_TYPES,
	DOCX_MIME_TYPES,
	IMAGE_MIME_TYPES,
	PDF_MIME_TYPES,
	TEXT_MIME_TYPES,
	VIDEO_MIME_TYPES,
	XLSX_MIME_TYPES,
} from "@/lib/domain/multimedia";

export interface AssetKindMeta {
	readonly icon: IconifyIcon;
	/** Capitalized singular label, e.g. "Image". */
	readonly label: string;
	/** `accept` attribute for the file input — the kind's MIME list. */
	readonly accept: string;
	/** User-facing extension list, e.g. "PNG, JPG, GIF, WebP". */
	readonly extLabel: string;
}

export const ASSET_KIND_META: Record<AssetKind, AssetKindMeta> = {
	image: {
		icon: tablerPhoto,
		label: "Image",
		accept: IMAGE_MIME_TYPES.join(","),
		extLabel: "PNG, JPG, GIF, WebP",
	},
	audio: {
		icon: tablerMusic,
		label: "Audio",
		accept: AUDIO_MIME_TYPES.join(","),
		extLabel: "MP3, WAV",
	},
	video: {
		icon: tablerVideo,
		label: "Video",
		accept: VIDEO_MIME_TYPES.join(","),
		extLabel: "MP4",
	},
	// Documents include file extensions in `accept` alongside the MIME
	// types: browsers send unreliable `Content-Type` for office files and
	// `.md` (often empty or `application/octet-stream`), so the extension
	// is what makes the OS file picker show them.
	pdf: {
		icon: tablerFileTypePdf,
		label: "PDF",
		accept: [...PDF_MIME_TYPES, ".pdf"].join(","),
		extLabel: "PDF",
	},
	text: {
		icon: tablerFileText,
		label: "Text",
		accept: [...TEXT_MIME_TYPES, ".txt", ".md"].join(","),
		extLabel: "TXT, MD",
	},
	docx: {
		icon: tablerFileTypeDocx,
		label: "Word",
		accept: [...DOCX_MIME_TYPES, ".docx"].join(","),
		extLabel: "DOCX",
	},
	xlsx: {
		icon: tablerFileTypeXls,
		label: "Excel",
		accept: [...XLSX_MIME_TYPES, ".xlsx"].join(","),
		extLabel: "XLSX",
	},
};
