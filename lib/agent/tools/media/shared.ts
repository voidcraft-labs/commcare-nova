/**
 * Shared input schemas + helpers for the dedicated media SA tools.
 *
 * The generic field-mutation tools (`addFields` / `editField`) and the
 * case-list-config tools deliberately OMIT every media slot — the SA can
 * neither mint nor discover an asset id from those surfaces, so exposing
 * a media slot there would only let the model write a dangling reference.
 * The media tools in this package are the dedicated authoring surface:
 * the SA discovers asset ids via `list_media_assets`, then attaches them
 * to a carrier through one of the `attach*` / `set*` tools here.
 *
 * Two carrier families, two slot shapes:
 *
 *   - **Field + option carriers** (a field's label / hint / help /
 *     validation message, and select options) take a full `Media` bundle
 *     — image + audio + video, any subset. `mediaSchema` is the single
 *     source of truth for that bundle; the tools reuse it directly.
 *   - **Menu carriers** (module / form menu tiles, app logo) take only
 *     direct `AssetId` slots (image + audio, or just image for the logo)
 *     — see `lib/domain/multimedia.ts::mediaSchema`'s docstring for why
 *     menu carriers don't use the bundle.
 *
 * Asset existence is NOT checked here. The SA validation loop runs
 * `collectMediaValidationErrors` after every mutation batch, so a bad ref
 * (deleted / pending / foreign-owned / kind-mismatched) surfaces with its
 * carrier location through the same gate every other media reference site
 * uses. The tools persist the reference and let the loop adjudicate.
 * (`remove_media_asset` is the one exception — it guards against
 * orphaning a live reference at the source.)
 */

import { z } from "zod";
import { type AssetId, type Media, mediaSchema } from "@/lib/domain";

/**
 * The full image/audio/video bundle carried by question-message slots and
 * select options. Reuses the domain `mediaSchema` verbatim so the tool
 * boundary and the stored shape can't drift — `mediaSchema` is
 * `.strict()` with three optional `assetIdSchema` slots, none of which
 * carries a `.transform()`, so it lowers cleanly to JSON Schema for the
 * Anthropic compiler.
 *
 * Clearing a slot is "omit it from the bundle" — an absent key resolves
 * to `undefined` and the carrier drops the reference. Passing an empty
 * bundle (`{}`) clears every slot.
 */
export const mediaBundleInput = (description: string) =>
	mediaSchema.describe(description);

/**
 * A single asset-id slot for the menu carriers (module / form icon +
 * audio label, app logo). `assetIdSchema` is a plain non-empty string at
 * runtime (the `AssetId` brand is compile-time only), so it lowers to
 * JSON Schema cleanly. Tool bodies cast the parsed value to `AssetId`
 * before threading it into the branded mutation builders.
 *
 * The SA passes `null` to clear the slot and a non-null asset id to set
 * it — a required-and-nullable shape that removes the "absent vs null"
 * ambiguity (the SA always states intent explicitly). Tool bodies map
 * `null → null` straight through to the mutation builders, which clear.
 */
export const nullableAssetSlot = (description: string) =>
	z.string().min(1).nullable().describe(description);

/**
 * Cast a parsed nullable asset-slot value to the branded `AssetId | null`
 * the mutation builders expect. The runtime value is already a string (or
 * null); the cast only re-applies the compile-time brand the wire schema
 * drops. Centralized here so every menu-media tool brands its slots the
 * same way.
 */
export function brandAssetSlot(value: string | null): AssetId | null {
	return value as AssetId | null;
}

/**
 * Cast a parsed `Media` bundle's slot values to the branded `Media`
 * shape. `mediaSchema` parses each slot to a plain string; the doc stores
 * `AssetId`, whose brand is compile-time only — so the parsed value is
 * structurally identical and the cast just re-applies the brand. Returns
 * the bundle unchanged at runtime.
 */
export function brandMediaBundle(bundle: z.infer<typeof mediaSchema>): Media {
	return bundle as Media;
}

/**
 * The four field-message slots a `Media` bundle can attach to. Mirrors
 * the `*_media` keys on the field schema bases (`label_media` /
 * `hint_media` / `help_media` / `validate_msg_media`) — the SA names the
 * slot by its message role (`label` / `hint` / `help` / `validate_msg`),
 * and the tool maps it to the `<slot>_media` key. `required` is
 * deliberately absent: CommCare's runtime parses no `jr:requiredMsg`, so
 * there is no `required_msg_media` slot to target.
 */
export const FIELD_MEDIA_SLOTS = [
	"label",
	"hint",
	"help",
	"validate_msg",
] as const;
export type FieldMediaSlot = (typeof FIELD_MEDIA_SLOTS)[number];

/** The `<slot>_media` field key a `FieldMediaSlot` maps to. */
export type FieldMediaKey = `${FieldMediaSlot}_media`;

/** Map a slot name to its `<slot>_media` field key. */
export function mediaKeyForSlot(slot: FieldMediaSlot): FieldMediaKey {
	return `${slot}_media`;
}
