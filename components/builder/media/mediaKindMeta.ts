// components/builder/media/mediaKindMeta.ts
//
// Per-kind presentation metadata shared across the media UI — the
// icon, the human label, and the `accept` string for the native
// file input. Derived from the domain MIME partitions so the
// picker's accept filter can't drift from what the validator
// actually accepts.

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

export interface MediaKindMeta {
	readonly icon: IconifyIcon;
	/** Capitalized singular label, e.g. "Image". */
	readonly label: string;
	/** `accept` attribute for the file input — the kind's MIME list. */
	readonly accept: string;
}

export const MEDIA_KIND_META: Record<AssetKind, MediaKindMeta> = {
	image: {
		icon: tablerPhoto,
		label: "Image",
		accept: IMAGE_MIME_TYPES.join(","),
	},
	audio: {
		icon: tablerMusic,
		label: "Audio",
		accept: AUDIO_MIME_TYPES.join(","),
	},
	video: {
		icon: tablerVideo,
		label: "Video",
		accept: VIDEO_MIME_TYPES.join(","),
	},
	// Documents include file extensions in `accept` alongside the MIME
	// types: browsers send unreliable `Content-Type` for office files and
	// `.md` (often empty or `application/octet-stream`), so the extension
	// is what makes the OS file picker show them.
	pdf: {
		icon: tablerFileTypePdf,
		label: "PDF",
		accept: [...PDF_MIME_TYPES, ".pdf"].join(","),
	},
	text: {
		icon: tablerFileText,
		label: "Text",
		accept: [...TEXT_MIME_TYPES, ".txt", ".md"].join(","),
	},
	docx: {
		icon: tablerFileTypeDocx,
		label: "Word",
		accept: [...DOCX_MIME_TYPES, ".docx"].join(","),
	},
	xlsx: {
		icon: tablerFileTypeXls,
		label: "Excel",
		accept: [...XLSX_MIME_TYPES, ".xlsx"].join(","),
	},
};
