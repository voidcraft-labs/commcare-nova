// components/builder/media/mediaKindMeta.ts
//
// Per-kind presentation metadata shared across the media UI — the
// icon, the human label, and the `accept` string for the native
// file input. Derived from the domain MIME partitions so the
// picker's accept filter can't drift from what the validator
// actually accepts.

import type { IconifyIcon } from "@iconify/types";
import tablerMusic from "@iconify-icons/tabler/music";
import tablerPhoto from "@iconify-icons/tabler/photo";
import tablerVideo from "@iconify-icons/tabler/video";
import {
	AUDIO_MIME_TYPES,
	IMAGE_MIME_TYPES,
	type MediaKind,
	VIDEO_MIME_TYPES,
} from "@/lib/domain/multimedia";

export interface MediaKindMeta {
	readonly icon: IconifyIcon;
	/** Capitalized singular label, e.g. "Image". */
	readonly label: string;
	/** `accept` attribute for the file input — the kind's MIME list. */
	readonly accept: string;
}

export const MEDIA_KIND_META: Record<MediaKind, MediaKindMeta> = {
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
};
