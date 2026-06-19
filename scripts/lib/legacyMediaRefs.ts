/**
 * Media-reference scan/repair core — the `--media` arm behind
 * `scripts/scan-legacy-findings.ts` (read-only) and
 * `scripts/repair-legacy-findings.ts` (writer).
 *
 * The blueprint evaluation in `legacyFindingRepairs.ts` deliberately
 * excludes the media-asset manifest (asset state is environment, not
 * blueprint content). This module is that arm's own pass: resolve every
 * asset reference a stored app carries against the live `mediaAssets`
 * rows and judge each one. The live surfaces can no longer mint a bad
 * reference (the at-source attach verdict, `lib/media/attachVerdicts.ts`),
 * so what this finds is exactly the legacy debris + ops damage the
 * export boundary's media rules would refuse.
 *
 * The honesty boundary here is bytes: a reference is DEAD — mechanically
 * clearable, losing nothing — only when its asset has no usable bytes
 * (no row at all, or a row stuck `pending` past the upload window, whose
 * pending object the bucket lifecycle rule has already reaped — see
 * `lib/storage/media.ts::applyPendingObjectLifecycle`). Anything with
 * usable or potentially-usable bytes (a READY asset of the wrong kind, a
 * still-young pending upload, a cross-account reference) is reported
 * needs-owner, never auto-cleared.
 */

import {
	FieldPath,
	type Firestore,
	type Timestamp,
} from "@google-cloud/firestore";
import type { BlueprintDoc, Mutation, Uuid } from "../../lib/doc/types";
import { asUuid, type Media, type SelectOption } from "../../lib/domain";
import {
	type AssetRef,
	describeCarrier,
	walkAssetRefs,
} from "../../lib/domain/mediaRefs";

/** A pending row older than this can never confirm: the bucket lifecycle
 *  rule reaps `pending/` objects after one day, so the bytes are gone. */
export const STALE_PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The asset-row fields the media-ref judgment reads, loaded raw by the
 *  scripts' own Firestore client (the scripts target `--project`
 *  explicitly, never the env-bound `lib/db` singleton). */
export interface ScanAssetRow {
	id: string;
	owner: string | undefined;
	status: string | undefined;
	kind: string | undefined;
	createdAtMs: number | undefined;
}

/** Firestore caps a `documentId() in [...]` query at 30 values. */
const SCAN_ID_BATCH_SIZE = 30;

/** Batch-load the named `mediaAssets` rows with the scan's own client.
 *  Missing rows are simply absent from the map. */
export async function loadAssetRowsForScan(
	db: Firestore,
	ids: readonly string[],
): Promise<Map<string, ScanAssetRow>> {
	const unique = [...new Set(ids)].filter((id) => id.length > 0);
	const out = new Map<string, ScanAssetRow>();
	for (let i = 0; i < unique.length; i += SCAN_ID_BATCH_SIZE) {
		const chunk = unique.slice(i, i + SCAN_ID_BATCH_SIZE);
		const snap = await db
			.collection("mediaAssets")
			.where(FieldPath.documentId(), "in", chunk)
			.get();
		for (const docSnap of snap.docs) {
			const data = docSnap.data();
			out.set(docSnap.id, {
				id: docSnap.id,
				owner: typeof data.owner === "string" ? data.owner : undefined,
				status: typeof data.status === "string" ? data.status : undefined,
				kind: typeof data.kind === "string" ? data.kind : undefined,
				createdAtMs: (data.created_at as Timestamp | undefined)?.toMillis?.(),
			});
		}
	}
	return out;
}

/** One judged media reference: the carrier ref plus which side of the
 *  bytes line it fell on and why, person-readable. */
export interface ClassifiedMediaRef {
	ref: AssetRef;
	judgment: "dead" | "needs-owner";
	reason: string;
}

export interface MediaRefReport {
	/** Provably dead — no usable bytes; clearing loses nothing. */
	dead: ClassifiedMediaRef[];
	/** Anything ambiguous — reported, never auto-cleared. */
	needsOwner: ClassifiedMediaRef[];
	/** Every reference walked (including the healthy ones). */
	total: number;
}

/**
 * Judge every media reference in `doc` against the loaded asset rows.
 * `ownerId` is the app's owner — a row held by anyone else can never
 * resolve for this app (every read site owner-filters).
 */
export function classifyMediaRefs(
	doc: BlueprintDoc,
	ownerId: string | undefined,
	rows: ReadonlyMap<string, ScanAssetRow>,
	opts: { nowMs: number },
): MediaRefReport {
	const dead: ClassifiedMediaRef[] = [];
	const needsOwner: ClassifiedMediaRef[] = [];
	let total = 0;
	for (const ref of walkAssetRefs(doc)) {
		total++;
		const row = rows.get(ref.assetId);
		if (!row) {
			dead.push({
				ref,
				judgment: "dead",
				reason:
					"no asset row exists for this id — the asset was deleted (or never created), so there are no bytes to recover",
			});
			continue;
		}
		if (ownerId !== undefined && row.owner !== ownerId) {
			needsOwner.push({
				ref,
				judgment: "needs-owner",
				reason:
					"the referenced asset belongs to a different account — this app can never load it; clear the slot or re-upload the file under this account",
			});
			continue;
		}
		if (row.status !== "ready") {
			const age =
				row.createdAtMs === undefined
					? undefined
					: opts.nowMs - row.createdAtMs;
			if (age !== undefined && age > STALE_PENDING_WINDOW_MS) {
				dead.push({
					ref,
					judgment: "dead",
					reason: `stuck pending for ${Math.round(age / 3_600_000)}h — its bytes were never confirmed, and the pending storage object is reaped after a day, so it can never become ready`,
				});
			} else {
				needsOwner.push({
					ref,
					judgment: "needs-owner",
					reason:
						age === undefined
							? "pending with no creation timestamp — can't prove the upload window has passed; check the row by hand"
							: `still pending (${Math.round(age / 60_000)}m old) — the upload may still confirm; re-run the scan after the one-day window`,
				});
			}
			continue;
		}
		if (row.kind !== ref.slotKind) {
			needsOwner.push({
				ref,
				judgment: "needs-owner",
				reason: `a ready ${row.kind ?? "unknown-kind"} asset sits in a ${ref.slotKind} slot — the bytes are usable, so clearing would lose content; repoint or clear it by hand`,
			});
		}
	}
	return { dead, needsOwner, total };
}

/** Person-readable line for one classified ref. */
export function describeMediaRef(entry: ClassifiedMediaRef): string {
	return `${describeCarrier(entry.ref)} → asset "${entry.ref.assetId}" — ${entry.reason}`;
}

/** Stable identity of one reference site — used to verify a planned
 *  clear actually removed the ref it targeted. */
export function mediaRefIdentity(ref: AssetRef): string {
	return JSON.stringify([ref.assetId, ref.slotKind, ref.location]);
}

export interface MediaClearPlan {
	/** One line per cleared reference, person-readable. */
	notes: string[];
	mutations: Mutation[];
	/** The identities the post-apply verification must find GONE. */
	clearedIdentities: Set<string>;
	/** Dead refs this plan could NOT clear mechanically (the image-map
	 *  row's image slot is structurally required — no clear-safe shape),
	 *  reported needs-owner instead. */
	unclearable: ClassifiedMediaRef[];
}

/** The `<slot>_media` bundle keys, narrowed for the `setFieldMedia` slot. */
type FieldMediaSlotName = "label" | "hint" | "help" | "validate_msg";

/**
 * Plan the mechanical clears for an app's dead media references — one
 * combined batch through the same clear-safe mutation kinds the live
 * surfaces use (`setAppLogo` / `setModuleMedia` / `setFormMedia` /
 * `setFieldMedia`, wholesale-object rebuilds for case-list slots and
 * select options — never a `{ key: undefined }` patch, which JSON drops
 * on the wire). Refs on the SAME carrier group into one mutation so two
 * dead slots can't fight over a wholesale write.
 *
 * Image-map rows are the one dead shape with no mechanical clear: the
 * entry's `assetId` is schema-required (no empty/absent state), so
 * clearing means deleting the row — and the row's VALUE text is user
 * content. Those come back in `unclearable` for the needs-owner report.
 */
export function planMediaRefClears(
	doc: BlueprintDoc,
	dead: readonly ClassifiedMediaRef[],
): MediaClearPlan {
	const notes: string[] = [];
	const mutations: Mutation[] = [];
	const clearedIdentities = new Set<string>();
	const unclearable: ClassifiedMediaRef[] = [];

	const note = (entry: ClassifiedMediaRef): void => {
		notes.push(`clear ${describeCarrier(entry.ref)} (${entry.reason})`);
		clearedIdentities.add(mediaRefIdentity(entry.ref));
	};

	// Group per carrier so wholesale writes compose: one mutation per
	// module menu, form menu, field bundle, options array, or case-list
	// config — whatever subset of its slots is dead.
	interface MenuSlots {
		icon?: ClassifiedMediaRef;
		audio?: ClassifiedMediaRef;
	}
	const moduleMenu = new Map<Uuid, MenuSlots>();
	const formMenu = new Map<Uuid, MenuSlots>();
	const caseList = new Map<Uuid, MenuSlots>();
	const fieldBundles = new Map<string, ClassifiedMediaRef[]>();
	const optionMedia = new Map<Uuid, ClassifiedMediaRef[]>();

	for (const entry of dead) {
		const loc = entry.ref.location;
		switch (loc.kind) {
			case "app_logo": {
				mutations.push({ kind: "setAppLogo", logo: null });
				note(entry);
				break;
			}
			case "module_icon":
			case "module_audio_label": {
				const slots = moduleMenu.get(loc.moduleUuid) ?? {};
				slots[loc.kind === "module_icon" ? "icon" : "audio"] = entry;
				moduleMenu.set(loc.moduleUuid, slots);
				break;
			}
			case "form_icon":
			case "form_audio_label": {
				const slots = formMenu.get(loc.formUuid) ?? {};
				slots[loc.kind === "form_icon" ? "icon" : "audio"] = entry;
				formMenu.set(loc.formUuid, slots);
				break;
			}
			case "case_list_icon":
			case "case_list_audio_label": {
				const slots = caseList.get(loc.moduleUuid) ?? {};
				slots[loc.kind === "case_list_icon" ? "icon" : "audio"] = entry;
				caseList.set(loc.moduleUuid, slots);
				break;
			}
			case "field_media_bundle": {
				const key = `${loc.fieldUuid} ${loc.bundleKey}`;
				fieldBundles.set(key, [...(fieldBundles.get(key) ?? []), entry]);
				break;
			}
			case "option_media": {
				optionMedia.set(loc.fieldUuid, [
					...(optionMedia.get(loc.fieldUuid) ?? []),
					entry,
				]);
				break;
			}
			case "image_map_mapping": {
				unclearable.push({
					...entry,
					reason: `${entry.reason}; an image-map row's image is structurally required, so the mechanical clear would delete the row's value mapping — repoint or remove the row by hand`,
				});
				break;
			}
		}
	}

	for (const [moduleUuid, slots] of moduleMenu) {
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		// The dedicated kind sets BOTH slots: the dead one clears (null),
		// the other re-asserts its current value (or null when absent — a
		// clear of an empty slot is a no-op).
		mutations.push({
			kind: "setModuleMedia",
			uuid: moduleUuid,
			icon: slots.icon ? null : (mod.icon ?? null),
			audioLabel: slots.audio ? null : (mod.audioLabel ?? null),
		});
		if (slots.icon) note(slots.icon);
		if (slots.audio) note(slots.audio);
	}

	for (const [formUuid, slots] of formMenu) {
		const form = doc.forms[formUuid];
		if (!form) continue;
		mutations.push({
			kind: "setFormMedia",
			uuid: formUuid,
			icon: slots.icon ? null : (form.icon ?? null),
			audioLabel: slots.audio ? null : (form.audioLabel ?? null),
		});
		if (slots.icon) note(slots.icon);
		if (slots.audio) note(slots.audio);
	}

	for (const [moduleUuid, slots] of caseList) {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (!config) continue;
		// Wholesale rebuild OMITTING the dead keys — a concrete object
		// survives JSON whole, so the dropped key clears cleanly (the same
		// path the case-list workspace's own clear uses).
		const { icon, audioLabel, ...rest } = config;
		mutations.push({
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {
				caseListConfig: {
					...rest,
					...(slots.icon || icon === undefined ? {} : { icon }),
					...(slots.audio || audioLabel === undefined ? {} : { audioLabel }),
				},
			},
		} as unknown as Mutation);
		if (slots.icon) note(slots.icon);
		if (slots.audio) note(slots.audio);
	}

	for (const [key, entries] of fieldBundles) {
		const [fieldUuidRaw, bundleKey] = key.split(" ");
		const field = doc.fields[asUuid(fieldUuidRaw)];
		if (!field) continue;
		const bundle = (field as unknown as Record<string, unknown>)[bundleKey] as
			| Media
			| undefined;
		if (!bundle) continue;
		const cleaned: Media = { ...bundle };
		for (const entry of entries) delete cleaned[entry.ref.slotKind];
		const hasAny =
			cleaned.image !== undefined ||
			cleaned.audio !== undefined ||
			cleaned.video !== undefined;
		mutations.push({
			kind: "setFieldMedia",
			fieldUuid: field.uuid,
			slot: bundleKey.replace(/_media$/, "") as FieldMediaSlotName,
			media: hasAny ? cleaned : null,
		});
		for (const entry of entries) note(entry);
	}

	for (const [fieldUuid, entries] of optionMedia) {
		const field = doc.fields[fieldUuid];
		if (!field || !("options" in field) || !Array.isArray(field.options)) {
			continue;
		}
		const deadByValue = new Map<string, ClassifiedMediaRef[]>();
		for (const entry of entries) {
			if (entry.ref.location.kind !== "option_media") continue;
			const value = entry.ref.location.optionValue;
			deadByValue.set(value, [...(deadByValue.get(value) ?? []), entry]);
		}
		const options: SelectOption[] = (field.options as SelectOption[]).map(
			(option) => {
				const deadHere = deadByValue.get(option.value);
				if (!deadHere || !option.media) return option;
				const cleaned: Media = { ...option.media };
				for (const entry of deadHere) delete cleaned[entry.ref.slotKind];
				const hasAny =
					cleaned.image !== undefined ||
					cleaned.audio !== undefined ||
					cleaned.video !== undefined;
				const { media: _was, ...rest } = option;
				return hasAny ? { ...rest, media: cleaned } : rest;
			},
		);
		// Wholesale concrete-array patch — the rebuilt option simply omits
		// its `media` key, which survives JSON (the same shape the
		// attach_option_media tool writes).
		mutations.push({
			kind: "updateField",
			uuid: field.uuid,
			targetKind: field.kind,
			patch: { options },
		} as unknown as Mutation);
		for (const entry of entries) note(entry);
	}

	return { notes, mutations, clearedIdentities, unclearable };
}
