/**
 * Media validator rules.
 *
 * Two groups:
 *
 *   - `MEDIA_ASSET_RULES` — the four asset-context rules
 *     (existence / ownership / ready / kind match). Each takes the
 *     full doc, the resolved manifest, and the expected owner. The
 *     runner gates this group on the presence of both a manifest
 *     AND an expected owner; when either is missing (the typical
 *     test path or the offline preview path), the group is skipped
 *     in full — the doc is still structurally valid; the media
 *     references just aren't resolvable in that environment.
 *
 *   - `imageMapValueUnique` — module-scoped totality rule that
 *     fires regardless of manifest presence. Registered alongside
 *     the other case-list rules in `MODULE_RULES` (`../module.ts`).
 *     Not part of `MEDIA_ASSET_RULES` because it has the same
 *     `(mod, moduleUuid, doc)` shape as every other module rule.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import type { ValidationError } from "../../errors";
import { mediaAssetExists } from "./mediaAssetExists";
import { mediaAssetOwnership } from "./mediaAssetOwnership";
import { mediaAssetReady } from "./mediaAssetReady";
import { mediaKindMatches } from "./mediaKindMatches";

export { imageMapValueUnique } from "./imageMapValueUnique";

/**
 * Signature for the asset-context rules — uniform `(doc, manifest,
 * expectedOwner)` shape across all four. Three of the four don't
 * consult the owner (existence / readiness / kind are owner-agnostic),
 * but the uniform signature lets the runner drive every rule through
 * a single loop without per-rule dispatch.
 */
export type MediaAssetRule = (
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	expectedOwner: string,
) => ValidationError[];

export const MEDIA_ASSET_RULES: ReadonlyArray<MediaAssetRule> = [
	mediaAssetExists,
	mediaAssetOwnership,
	mediaAssetReady,
	mediaKindMatches,
];
