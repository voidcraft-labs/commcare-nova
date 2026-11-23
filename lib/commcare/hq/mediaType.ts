import type { MediaKind } from "@/lib/domain/multimedia";

import { HQ_MEDIA_TYPES, type HqMediaType } from "./mediaMap";

export { HQ_MEDIA_TYPES, type HqMediaType };

/** HQ's bulk uploader matches a path only within the file's concrete class. */
export type HqFileMediaType = Exclude<HqMediaType, "CommCareMultimedia">;
export const KIND_OF_MEDIA_TYPE: Readonly<Record<HqFileMediaType, MediaKind>> =
	{
		CommCareImage: "image",
		CommCareAudio: "audio",
		CommCareVideo: "video",
	};

export function matchesHqMediaKind(
	type: HqMediaType,
	kind: MediaKind,
): boolean {
	return type !== "CommCareMultimedia" && KIND_OF_MEDIA_TYPE[type] === kind;
}
