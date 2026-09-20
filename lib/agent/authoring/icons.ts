import { z } from "zod";
import {
	type BuiltinIconRef,
	builtinIconRef,
	type IconSlug,
	iconCatalogEntry,
	isBuiltinIconRef,
	parseBuiltinIconSlug,
} from "@/lib/domain/builtinIcons";
import { type MediaAssetId, mediaAssetIdSchema } from "@/lib/domain/multimedia";

/** Authors name a built-in icon by its catalog slug; the document stores the
 * reserved `nova-icon:<slug>` identity. Uploaded images are asset ids in both
 * forms. Slugs and asset-id UUIDs cannot collide, so catalog membership decides
 * which one a string is. The slot's canonical schema still restricts a built-in
 * to the module or form catalog after decoding. */
export function printAuthoringIcon(value: unknown): IconSlug | MediaAssetId {
	const stored = z.string().parse(value);
	if (isBuiltinIconRef(stored)) {
		const slug = parseBuiltinIconSlug(stored);
		if (slug) return slug;
	}
	return mediaAssetIdSchema.parse(stored);
}

export function parseAuthoringIcon(
	value: unknown,
): BuiltinIconRef | MediaAssetId {
	const authored = z.string().parse(value);
	return iconCatalogEntry(authored)
		? builtinIconRef(authored as IconSlug)
		: mediaAssetIdSchema.parse(authored);
}
