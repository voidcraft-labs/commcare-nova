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
//    by location, asserting the resolved asset's existence, ready
//    status, and kind-vs-slot fit.
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
//   - `field.required_msg_media` — commcare-core's `XFormParser::parseBind`
//     reads the `required` condition but no `requiredMsg` attribute, so a
//     per-question custom required MESSAGE has no on-device carrier. (Case
//     SEARCH prompts do support `required_msg` via formplayer's
//     `DisplayElement`, but that's a separate surface Nova doesn't model.)
//
// `caseListConfig.icon` / `audioLabel` ARE walked, but only for
// `caseListOnly` modules — that's the one shape where CCHQ emits a
// case-list menu command for the icon to land on (see the walk below).

import { produce } from "immer";
import type { BlueprintDoc, PersistableDoc } from "./blueprint";
import { isBuiltinIconRef } from "./builtinIcons";
import { type Field, isContainer } from "./fields";
import { caseListColumnHasRuntimeRole } from "./modules";
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
			readonly kind: "case_list_icon";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
	  }
	| {
			readonly kind: "case_list_audio_label";
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

		// Case-list-link menu media: the icon / audio on the "open case
		// list" command. CCHQ emits that command only when
		// `case_list.show` is true, which Nova sets solely for
		// `caseListOnly` modules (see `expander.ts`'s gate) — so the media
		// has a render target only there. Walking it on a non-caseListOnly
		// module would bundle bytes no command references.
		if (mod.caseListOnly) {
			if (mod.caseListConfig?.icon) {
				yield {
					assetId: mod.caseListConfig.icon,
					slotKind: "image",
					location: { kind: "case_list_icon", moduleUuid, moduleName },
				};
			}
			if (mod.caseListConfig?.audioLabel) {
				yield {
					assetId: mod.caseListConfig.audioLabel,
					slotKind: "audio",
					location: {
						kind: "case_list_audio_label",
						moduleUuid,
						moduleName,
					},
				};
			}
		}
		const columns = mod.caseListConfig?.columns ?? [];
		for (const column of columns) {
			if (!caseListColumnHasRuntimeRole(column)) continue;
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

/**
 * Per-field media-bundle slot walk. Each `Field` arm independently
 * declares which of the four bundle keys it carries — `label_media`
 * is on every visible-input arm and on container arms via
 * `fieldBaseSchema` / `containerFieldBase`; the other three sit on
 * per-kind schemas. The reads below use per-key `in`-narrowing so
 * TypeScript types `field[<key>]` directly off the schema arms — no
 * `as` cast — and a future schema rename that drops a bundle key
 * from every arm fails to compile here.
 *
 * Unrolled rather than looped over `FieldMediaBundleKey` because a
 * looped version requires an indexed-access type the discriminated
 * `Field` union doesn't admit without a cast (the four keys have no
 * single common parent arm).
 */
function* walkFieldMediaSlots(
	field: Field,
	fieldUuid: Uuid,
	ctx: FormWalkContext,
): Generator<AssetRef> {
	const fieldId = field.id;
	if ("label_media" in field) {
		yield* yieldBundleSlots(
			field.label_media,
			"label_media",
			fieldUuid,
			fieldId,
			ctx,
		);
	}
	if ("hint_media" in field) {
		yield* yieldBundleSlots(
			field.hint_media,
			"hint_media",
			fieldUuid,
			fieldId,
			ctx,
		);
	}
	if ("help_media" in field) {
		yield* yieldBundleSlots(
			field.help_media,
			"help_media",
			fieldUuid,
			fieldId,
			ctx,
		);
	}
	if ("validate_msg_media" in field) {
		yield* yieldBundleSlots(
			field.validate_msg_media,
			"validate_msg_media",
			fieldUuid,
			fieldId,
			ctx,
		);
	}
}

/**
 * Walk the three `Media` slot keys (image / audio / video) on one
 * bundle, yielding one `AssetRef` per non-empty slot. The slot set is
 * hand-coupled: `MEDIA_BUNDLE_KEYS` (here) and `MediaSlotKind`
 * (the slot type) are the single source of truth; adding a slot at
 * the `Media` schema layer requires touching both explicitly.
 */
function* yieldBundleSlots(
	bundle: Media | undefined,
	bundleKey: FieldMediaBundleKey,
	fieldUuid: Uuid,
	fieldId: string,
	ctx: FormWalkContext,
): Generator<AssetRef> {
	if (!bundle) return;
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
				fieldId,
			},
		};
	}
}

/**
 * Per-option media walk for select-shaped fields. Discriminator-
 * narrowed on `field.kind` so `field.options` reads off the two select
 * arms with their declared `SelectOption[]` type — a future schema
 * change that ships an `options` slot of a different shape on a new
 * arm fails to compile here, rather than getting laundered through a
 * structural cast.
 */
function* walkFieldOptionMedia(
	field: Field,
	fieldUuid: Uuid,
	ctx: FormWalkContext,
): Generator<AssetRef> {
	if (field.kind !== "single_select" && field.kind !== "multi_select") return;
	for (const option of field.options) {
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

/**
 * Every asset id PRESENT in the doc — the superset {@link collectAssetRefs} would
 * yield if nothing were render-gated. It adds the one gated slot the gated walk
 * omits: `caseListConfig.icon` / `audioLabel` on NON-`caseListOnly` modules and
 * image-map rows on fully off-screen, unsorted legacy columns. Those don't
 * render today (so the validator/manifest rightly ignore them), but they
 * PERSIST in the doc and {@link remapAssetRefs} rewrites them un-gated — so a
 * move must copy + repoint them too, or making the carrier active later would
 * surface a dangling cross-Project ref. This is the move's (and the reverse-
 * index's) collection basis; the gated `collectAssetRefs` stays the emit/
 * validate basis.
 */
export function collectMovableAssetRefs(doc: BlueprintDoc): Set<string> {
	const ids = collectAssetRefs(doc);
	for (const mod of Object.values(doc.modules)) {
		if (!mod.caseListOnly) {
			if (mod.caseListConfig?.icon) ids.add(mod.caseListConfig.icon);
			if (mod.caseListConfig?.audioLabel)
				ids.add(mod.caseListConfig.audioLabel);
		}
		for (const column of mod.caseListConfig?.columns ?? []) {
			if (column.kind !== "image-map") continue;
			for (const row of column.mapping) ids.add(row.assetId);
		}
	}
	return ids;
}

/**
 * The doc's PRESENT asset ids MINUS the built-in `nova-icon:` slugs — i.e. the
 * ids that resolve to a real Postgres/GCS asset. The single home for the "real
 * (non-built-in) refs" idiom shared by the reverse-index sync and the
 * cross-Project move (which copy + re-tenant only real assets; built-ins are
 * shared and row-less, so they must never reach the reverse index or a copy).
 * Built on {@link collectMovableAssetRefs} so a dead-but-present ref is still
 * indexed (deletion guard) and carried by a move.
 */
export function collectRealAssetRefs(doc: BlueprintDoc): string[] {
	return [...collectMovableAssetRefs(doc)].filter(
		(id) => !isBuiltinIconRef(id),
	);
}

/**
 * Rewrite every media `AssetId` the blueprint references through `idMap`,
 * returning a new doc (the input is untouched). An id absent from the map —
 * a built-in `nova-icon:` ref, or any id the caller chose not to remap — is
 * left exactly as-is, so a partial map only touches the ids it names.
 *
 * The WRITE counterpart of {@link walkAssetRefs}: it must touch every slot the
 * walk reads, or a moved app would keep a stale ref the walk still surfaces.
 * The two are pinned together by a coverage-parity test
 * (`collectAssetRefs(remapAssetRefs(doc, fullMap))` equals the mapped set), so
 * a slot added to the walk but not here fails CI. The single consumer is the
 * cross-Project move (`lib/db/moveAppToProject.ts`), which copies an app's
 * referenced assets into the destination Project and repoints the blueprint at
 * the copies — built-ins (shared, Project-agnostic) are never copied, so they
 * never appear in `idMap` and fall through unchanged.
 *
 * Unlike the walk, fields are visited flat (`doc.fields`) rather than through
 * `fieldOrder`: ancestry is irrelevant to an id rewrite, and rewriting a field
 * that's momentarily unreachable from the order arrays still can't leave a
 * stale ref behind. `produce` keeps untouched subtrees structurally identical.
 */
export function remapAssetRefs(
	doc: PersistableDoc,
	idMap: ReadonlyMap<string, string>,
): PersistableDoc {
	if (idMap.size === 0) return doc;
	const remap = (id: string): string => idMap.get(id) ?? id;
	return produce(doc, (draft) => {
		if (draft.logo) draft.logo = remap(draft.logo);

		for (const moduleUuid of draft.moduleOrder) {
			const mod = draft.modules[moduleUuid];
			if (!mod) continue;
			if (mod.icon) mod.icon = remap(mod.icon);
			if (mod.audioLabel) mod.audioLabel = remap(mod.audioLabel);
			if (mod.caseListConfig?.icon) {
				mod.caseListConfig.icon = remap(mod.caseListConfig.icon);
			}
			if (mod.caseListConfig?.audioLabel) {
				mod.caseListConfig.audioLabel = remap(mod.caseListConfig.audioLabel);
			}
			for (const column of mod.caseListConfig?.columns ?? []) {
				if (column.kind !== "image-map") continue;
				for (const row of column.mapping) {
					row.assetId = remap(row.assetId);
				}
			}
		}

		for (const form of Object.values(draft.forms)) {
			if (form.icon) form.icon = remap(form.icon);
			if (form.audioLabel) form.audioLabel = remap(form.audioLabel);
		}

		for (const field of Object.values(draft.fields)) {
			remapFieldMedia(field, remap);
		}
	});
}

/** Rewrite the media ids on one field's message bundles + select options. */
function remapFieldMedia(field: Field, remap: (id: string) => string): void {
	if ("label_media" in field) remapMediaBundle(field.label_media, remap);
	if ("hint_media" in field) remapMediaBundle(field.hint_media, remap);
	if ("help_media" in field) remapMediaBundle(field.help_media, remap);
	if ("validate_msg_media" in field) {
		remapMediaBundle(field.validate_msg_media, remap);
	}
	if (field.kind === "single_select" || field.kind === "multi_select") {
		for (const option of field.options) remapMediaBundle(option.media, remap);
	}
}

/** Rewrite the image/audio/video slots on one `Media` bundle in place. */
function remapMediaBundle(
	bundle: Media | undefined,
	remap: (id: string) => string,
): void {
	if (!bundle) return;
	for (const slotKind of MEDIA_BUNDLE_KEYS) {
		const assetId = bundle[slotKind];
		if (assetId) bundle[slotKind] = remap(assetId);
	}
}

/**
 * Whether a carrier's bytes reach the device through CommCare HQ's bulk
 * multimedia upload. HQ matches each uploaded file against the app's
 * FORM and MENU media references only — `ApplicationMediaMixin.all_media`
 * deliberately EXCLUDES app-level media (the logo) from that set — so an
 * app-level carrier's file is reported unmatched by the bulk upload and
 * never installed. Every other carrier (module/form menu media, field
 * and option media, case-list detail images) DOES carry.
 *
 * The single home for that one CommCare fact: both the proactive
 * app-settings warning (`uncarriedLogoAsset`) and the post-upload
 * reconciliation (`lib/media/uploadOutcome.ts`) read it, so the rule
 * can't drift across the two surfaces. Today only the app logo is
 * app-level; when CommCare adds another app-level surface, this is the
 * one place to teach.
 */
export function carriesViaBulkUpload(location: MediaRefLocation): boolean {
	return location.kind !== "app_logo";
}

/**
 * The app logo's `AssetId` IF it won't reach the device on its own —
 * otherwise `undefined`.
 *
 * An image used ONLY as the app logo is never carried by the bulk upload
 * (see `carriesViaBulkUpload`) — the web-apps banner stays blank. The
 * SAME image also used as a form/menu graphic DOES carry (it matches via
 * that reference and resolves to the shared path), so this returns
 * `undefined` whenever the logo asset is referenced by any carrier that
 * carries.
 *
 * This is the proactive (pre-upload) predicate the app-settings warning
 * reads; the upload route reconciles the same fact against HQ's actual
 * unmatched-file report (`lib/media/uploadOutcome.ts`).
 */
export function uncarriedLogoAsset(doc: BlueprintDoc): string | undefined {
	const logo = doc.logo;
	if (!logo) return undefined;
	for (const ref of walkAssetRefs(doc)) {
		if (ref.assetId === logo && carriesViaBulkUpload(ref.location)) {
			return undefined;
		}
	}
	return logo;
}

/**
 * Render a media reference's carrier into a human-readable phrase that
 * names the slot + the entity it lives on, in the authoring layer's own
 * nouns (module / form / field / option / logo — never wire vocabulary).
 * The single carrier-naming describer: the deletion-refusal message
 * (`lib/media/assetDeletion.ts`) and the upload-attach warning
 * (`lib/media/uploadOutcome.ts`) both read it, so the same carrier reads
 * the same way everywhere. The validator's `describeLocation` is a
 * separate, location-only variant (it has no `slotKind` and deliberately
 * says "media", not the specific kind, since its job is to flag a
 * wrong-kind asset).
 *
 * The `switch` is exhaustive over `MediaRefLocation.kind`; a new carrier
 * variant fails to compile here until it's described.
 */
export function describeCarrier(ref: AssetRef): string {
	const loc = ref.location;
	switch (loc.kind) {
		case "app_logo":
			return "the app logo";
		case "module_icon":
			return `the icon on module "${loc.moduleName}"`;
		case "module_audio_label":
			return `the audio label on module "${loc.moduleName}"`;
		case "case_list_icon":
			return `the case-list icon on module "${loc.moduleName}"`;
		case "case_list_audio_label":
			return `the case-list audio label on module "${loc.moduleName}"`;
		case "form_icon":
			return `the icon on form "${loc.formName}" (module "${loc.moduleName}")`;
		case "form_audio_label":
			return `the audio label on form "${loc.formName}" (module "${loc.moduleName}")`;
		case "field_media_bundle":
			return `the ${ref.slotKind} on field "${loc.fieldId}"'s ${bundleSlotLabel(loc.bundleKey)} (form "${loc.formName}")`;
		case "option_media":
			return `the ${ref.slotKind} on option "${loc.optionValue}" of field "${loc.fieldId}" (form "${loc.formName}")`;
		case "image_map_mapping":
			return `the image-map row "${loc.rowValue}" in column "${loc.columnHeader}" (module "${loc.moduleName}")`;
	}
}

/** Friendly label for a field message-bundle key, for `describeCarrier`. */
function bundleSlotLabel(bundleKey: FieldMediaBundleKey): string {
	switch (bundleKey) {
		case "label_media":
			return "label";
		case "hint_media":
			return "hint";
		case "help_media":
			return "help";
		case "validate_msg_media":
			return "validation message";
	}
}

/**
 * Adapt a `PersistableDoc` (the on-disk shape, no derived `fieldParent`) into
 * the `BlueprintDoc` the asset walk types against. `walkAssetRefs` traverses
 * only `logo` / `moduleOrder` / `modules` / `formOrder` / `forms` / `fields` /
 * case-list columns — never `fieldParent` — so an empty stand-in is sound, and
 * this avoids rebuilding the field-parent reverse index just to read media refs
 * off a persisted blueprint. The single home for that contract, so the two
 * server callers (the reverse-index sync on save, the delete guard's carrier
 * walk) can't each hand-cast it and drift on whether the cast is safe.
 */
export function asWalkableDoc(doc: PersistableDoc): BlueprintDoc {
	return { ...doc, fieldParent: {} } as BlueprintDoc;
}
