/**
 * Media validator rules.
 *
 * Two groups:
 *
 *   - `MEDIA_ASSET_RULES` — the three asset-context rules (existence /
 *     ready / kind match). Each takes the doc + the resolved
 *     manifest. The runner runs the group only when the caller
 *     supplies a manifest (the SA validation loop's path); without one
 *     (the typical test path, the offline preview path) the group is
 *     skipped — the doc is still structurally valid; the media refs
 *     just aren't resolvable in that environment.
 *
 *   - `imageMapValueUnique` — module-scoped totality rule that
 *     fires regardless of manifest presence. Registered alongside
 *     the other case-list rules in `MODULE_RULES` (`../module.ts`).
 *     Not part of `MEDIA_ASSET_RULES` because it has the same
 *     `(mod, moduleUuid, doc)` shape as every other module rule.
 *
 * Cross-owner refs aren't a dedicated rule: `loadAssetsByIds` filters
 * by owner at the load layer (closes the cross-tenant enumeration
 * vector), so a foreign-owned ref reads as a manifest miss and
 * surfaces as `mediaAssetExists`'s `MEDIA_ASSET_NOT_FOUND` — the same
 * message the user sees for a deleted asset, which is the right UX
 * (the foreign-owner distinction stays below the privacy line).
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import type { ValidationError } from "../../errors";
import { mediaAssetExists } from "./mediaAssetExists";
import { mediaAssetReady } from "./mediaAssetReady";
import { mediaKindMatches } from "./mediaKindMatches";

export { imageMapValueUnique } from "./imageMapValueUnique";

/**
 * Signature for the asset-context rules — uniform `(doc, manifest)`
 * across the three. The runner drives every rule through a single
 * loop without per-rule dispatch.
 */
export type MediaAssetRule = (
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
) => ValidationError[];

export const MEDIA_ASSET_RULES: ReadonlyArray<MediaAssetRule> = [
	mediaAssetExists,
	mediaAssetReady,
	mediaKindMatches,
];
