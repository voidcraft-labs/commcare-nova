// lib/domain/mediaRefs.ts
//
// The single walk that enumerates every media `AssetId` a blueprint
// references. One source of truth for "which assets does this app
// use," consumed by:
//
//  - the compile / upload manifest loader at
//    `lib/media/manifest.ts::resolveMediaManifest` — loads exactly the
//    referenced assets (rows + optional bytes) into the emission
//    manifest;
//  - the validator's media asset-context rules under
//    `lib/commcare/validator/rules/media/` — walks each reference site
//    by location, asserting the resolved asset's existence, owner,
//    ready status, and kind-vs-slot fit.
//
// The hierarchical walk (modules → forms → fields, with container
// recursion) is load-bearing: every reference site carries its
// owning uuids + display names so the validator can emit a "fix
// this exact slot" error and the SA tool surface can address the
// carrier directly. `collectAssetRefs` keeps the flat-set return
// shape for the manifest loader via a thin wrapper over the typed
// walker — one walk, two consumers.
//
// Carrier scope intentionally OMITS:
//   - `field.required_msg_media` — `jr:requiredMsg` has no commcare-core
//     wire target (verified in `XFormParser::parseBindAttributes`); the
//     authoring slot was rolled back in Segment 3.
//   - `caseListConfig.icon` / `caseListConfig.audioLabel` — Reserved
//     slot with no wire path emit today; bundling its bytes into the
//     CCZ would orphan them.

import type { BlueprintDoc } from "./blueprint";
import { type Field, isContainer } from "./fields";
import type { Media } from "./multimedia";
import type { Uuid } from "./uuid";

/**
 * Which kind a media reference's carrier slot expects. The validator's
 * `mediaKindMatches` rule uses this to assert the resolved asset's
 * `mimeType` falls in the matching MIME partition. Menu-style carriers
 * (`module.icon`, `form.icon`, `blueprintDoc.logo`, image-map mapping)
 * bake the slot kind into the location variant directly; per-question
 * Media bundles report the slot kind they were drawn from
 * (`media.image` → `"image"`, etc.).
 */
export type MediaSlotKind = "image" | "audio" | "video";

/**
 * The Media bundle's three slot keys; their order is also the order
 * the walker emits per-bundle references.
 */
const MEDIA_BUNDLE_KEYS: ReadonlyArray<MediaSlotKind> = [
	"image",
	"audio",
	"video",
];

/**
 * Which field-level Media bundle a reference came from. Mirrors the
 * field schema keys (`label_media`, `hint_media`, `help_media`,
 * `validate_msg_media`). The set is closed by `inputFieldBaseSchema`;
 * `required_msg_media` is deliberately absent.
 */
export type FieldMediaBundleKey =
	| "label_media"
	| "hint_media"
	| "help_media"
	| "validate_msg_media";

const FIELD_MEDIA_BUNDLE_KEYS: ReadonlyArray<FieldMediaBundleKey> = [
	"label_media",
	"hint_media",
	"help_media",
	"validate_msg_media",
];

/**
 * Where a media reference lives in the blueprint. The discriminator
 * is structural — each variant carries the uuids + display names a
 * validator error needs to point at the carrier without the rule
 * re-walking the doc. Per-message-slot variants on fields share one
 * shape (`field_media_bundle`) discriminated by `bundleKey`, since
 * the slot mechanic is the same across them and the bundleKey
 * already encodes the message-slot identity.
 */
export type MediaRefLocation =
	| { readonly kind: "app_logo" }
	| {
			readonly kind: "module_icon";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
	  }
	| {
			readonly kind: "module_audio_label";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
	  }
	| {
			readonly kind: "form_icon";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
			readonly formUuid: Uuid;
			readonly formName: string;
	  }
	| {
			readonly kind: "form_audio_label";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
			readonly formUuid: Uuid;
			readonly formName: string;
	  }
	| {
			readonly kind: "field_media_bundle";
			readonly bundleKey: FieldMediaBundleKey;
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
			readonly formUuid: Uuid;
			readonly formName: string;
			readonly fieldUuid: Uuid;
			readonly fieldId: string;
	  }
	| {
			readonly kind: "option_media";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
			readonly formUuid: Uuid;
			readonly formName: string;
			readonly fieldUuid: Uuid;
			readonly fieldId: string;
			readonly optionValue: string;
	  }
	| {
			readonly kind: "image_map_mapping";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
			readonly columnUuid: Uuid;
			readonly columnHeader: string;
			readonly rowIndex: number;
			readonly rowValue: string;
	  };

/**
 * One media reference site: the asset it points at, the slot kind
 * the carrier expects (so the kind rule can compare against MIME),
 * and the location info a validator error needs to point at the
 * exact carrier.
 *
 * `assetId` is the plain string the doc carries (the `AssetId` brand
 * is compile-time only). Consumers that need the brand re-cast at
 * use; the walker stays brand-agnostic because the doc itself is.
 */
export interface AssetRef {
	readonly assetId: string;
	readonly slotKind: MediaSlotKind;
	readonly location: MediaRefLocation;
}

/**
 * Yield every media reference in the doc, in canonical (module →
 * form → field) walk order. Container fields recurse depth-first so
 * a reference inside a group inside a repeat surfaces with its full
 * field ancestry resolved.
 *
 * The walker carries the doc-level invariant that fields are addressed
 * by uuid: a `fieldOrder` entry whose uuid doesn't resolve to a field
 * is skipped silently (matches the defensive shape of every other doc
 * walker in this package — partial-reducer states must not crash the
 * iterator).
 */
export function* walkAssetRefs(doc: BlueprintDoc): Generator<AssetRef> {
	if (doc.logo) {
		yield {
			assetId: doc.logo,
			slotKind: "image",
			location: { kind: "app_logo" },
		};
	}

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		const moduleName = mod.name;

		if (mod.icon) {
			yield {
				assetId: mod.icon,
				slotKind: "image",
				location: { kind: "module_icon", moduleUuid, moduleName },
			};
		}
		if (mod.audioLabel) {
			yield {
				assetId: mod.audioLabel,
				slotKind: "audio",
				location: { kind: "module_audio_label", moduleUuid, moduleName },
			};
		}

		// `caseListConfig.icon` / `audioLabel` are deliberately NOT walked
		// — see file header. The schema marks them Reserved; surfacing
		// them here would let the manifest loader bundle orphan bytes.
		const columns = mod.caseListConfig?.columns ?? [];
		for (const column of columns) {
			if (column.kind !== "image-map") continue;
			for (let rowIndex = 0; rowIndex < column.mapping.length; rowIndex++) {
				const row = column.mapping[rowIndex];
				yield {
					assetId: row.assetId,
					slotKind: "image",
					location: {
						kind: "image_map_mapping",
						moduleUuid,
						moduleName,
						columnUuid: column.uuid,
						columnHeader: column.header,
						rowIndex,
						rowValue: row.value,
					},
				};
			}
		}

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form) continue;
			const formName = form.name;

			if (form.icon) {
				yield {
					assetId: form.icon,
					slotKind: "image",
					location: {
						kind: "form_icon",
						moduleUuid,
						moduleName,
						formUuid,
						formName,
					},
				};
			}
			if (form.audioLabel) {
				yield {
					assetId: form.audioLabel,
					slotKind: "audio",
					location: {
						kind: "form_audio_label",
						moduleUuid,
						moduleName,
						formUuid,
						formName,
					},
				};
			}

			// Field walk: traverse `fieldOrder` recursively through
			// containers. Visiting the doc through the order arrays
			// (not `Object.values(doc.fields)`) is what gives every
			// reference its owning module + form uuids.
			yield* walkFormFieldRefs(doc, {
				moduleUuid,
				moduleName,
				formUuid,
				formName,
			});
		}
	}
}

/** Per-form-walk context the inner recursion threads through. */
interface FormWalkContext {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly formUuid: Uuid;
	readonly formName: string;
}

/**
 * Walk one form's field tree, yielding every Media-bundle slot ref and
 * per-option media ref. Iterates `fieldOrder[parentUuid]` in document
 * order, descending into container kinds (group, repeat).
 */
function* walkFormFieldRefs(
	doc: BlueprintDoc,
	ctx: FormWalkContext,
): Generator<AssetRef> {
	const stack: Uuid[] = [...(doc.fieldOrder[ctx.formUuid] ?? [])];
	// `stack` is processed in canonical order: shift from the front
	// rather than pop, so siblings yield in document order and the
	// pre-order DFS matches the on-screen reading order.
	while (stack.length > 0) {
		const fieldUuid = stack.shift();
		if (!fieldUuid) break;
		const field = doc.fields[fieldUuid];
		if (!field) continue;

		yield* walkFieldMediaSlots(field, fieldUuid, ctx);
		yield* walkFieldOptionMedia(field, fieldUuid, ctx);

		if (isContainer(field)) {
			// Prepend children to maintain pre-order DFS through the
			// document-ordered subtree.
			const children = doc.fieldOrder[fieldUuid] ?? [];
			stack.unshift(...children);
		}
	}
}

/** Per-field media-bundle slot walk (`label_media`, `hint_media`, etc.). */
function* walkFieldMediaSlots(
	field: Field,
	fieldUuid: Uuid,
	ctx: FormWalkContext,
): Generator<AssetRef> {
	// Field bases extend differently per kind (containers and hidden
	// don't declare every slot), so the read is a generic property
	// lookup against the optional bundle keys. The set of bundle keys
	// is closed at type level by `FieldMediaBundleKey`.
	const bundles = field as Partial<Record<FieldMediaBundleKey, Media>>;
	for (const bundleKey of FIELD_MEDIA_BUNDLE_KEYS) {
		const bundle = bundles[bundleKey];
		if (!bundle) continue;
		for (const slotKind of MEDIA_BUNDLE_KEYS) {
			const assetId = bundle[slotKind];
			if (!assetId) continue;
			yield {
				assetId,
				slotKind,
				location: {
					kind: "field_media_bundle",
					bundleKey,
					moduleUuid: ctx.moduleUuid,
					moduleName: ctx.moduleName,
					formUuid: ctx.formUuid,
					formName: ctx.formName,
					fieldUuid,
					fieldId: field.id,
				},
			};
		}
	}
}

/** Per-option media walk for select-shaped fields. */
function* walkFieldOptionMedia(
	field: Field,
	fieldUuid: Uuid,
	ctx: FormWalkContext,
): Generator<AssetRef> {
	const options = (
		field as {
			readonly options?: ReadonlyArray<{ value: string; media?: Media }>;
		}
	).options;
	if (!options) return;
	for (const option of options) {
		const media = option.media;
		if (!media) continue;
		for (const slotKind of MEDIA_BUNDLE_KEYS) {
			const assetId = media[slotKind];
			if (!assetId) continue;
			yield {
				assetId,
				slotKind,
				location: {
					kind: "option_media",
					moduleUuid: ctx.moduleUuid,
					moduleName: ctx.moduleName,
					formUuid: ctx.formUuid,
					formName: ctx.formName,
					fieldUuid,
					fieldId: field.id,
					optionValue: option.value,
				},
			};
		}
	}
}

/**
 * Collect the de-duplicated set of every media `AssetId` referenced
 * anywhere in the blueprint — a thin wrapper over `walkAssetRefs` for
 * consumers (the manifest loader) that need only the asset ids.
 *
 * Returns plain asset-id strings (the doc carries `AssetId` as a plain
 * string — the brand is compile-time only). The caller re-brands when
 * keying the resolved manifest.
 */
export function collectAssetRefs(doc: BlueprintDoc): Set<string> {
	const ids = new Set<string>();
	for (const ref of walkAssetRefs(doc)) {
		ids.add(ref.assetId);
	}
	return ids;
}
