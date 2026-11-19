/**
 * What a deployment Nova brought in from CommCare HQ records at its birth,
 * worked out from the reading and the source it accepted: the ids HQ holds
 * for every menu and form, the id prefix each keyed create's cases stand
 * under, the path each media file keeps, the `read` baseline and the plan
 * features the app's source already answers.
 *
 * Pure: it reads no store and asks CommCare HQ nothing. The birth's one
 * transaction writes what these functions give
 * (`store.ts::recordAdoptedDeploymentInTransaction`).
 */

import { gzipSync } from "node:zlib";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { wirePathFor } from "@/lib/commcare/multimedia/assetWirePath";
import { bulkUploadAssets } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { requiredPlanFeatures } from "@/lib/commcare/planPrivileges";
import type { ReadMenuAndFormIdentities } from "@/lib/commcare/reader";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import { type BlueprintDoc, operationCaseType } from "@/lib/domain";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import type { Uuid } from "@/lib/domain/uuid";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import type {
	FirstPublishChangeId,
	FirstPublishView,
	StoredFirstPublish,
} from "@/lib/publish/firstPublishChangeIds";
import { attachmentUrlTarget } from "./attachmentTarget";
import {
	type HqMediaRecord,
	isHoldableWirePath,
	nextHqMediaRecord,
	publishedMediaFiles,
} from "./hqMedia";
import {
	normalizedHqAppSource,
	normalizeHqAppSource,
} from "./hqSourceBaseline";
import { hqImportApplicationSteps } from "./importApplication";
import type { DeploymentTargetKey } from "./store";
import type {
	AppBaselineWrite,
	DeploymentConfirmationKey,
	DeploymentIdentityOverride,
} from "./types";

/** Ascending UTF-16 code-unit order, the order every list here is kept in. */
function codeUnitOrder(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ── Menu and form ids ────────────────────────────────────────────────────

export type AdoptedIdentityRows =
	| { readonly ok: true; readonly rows: readonly DeploymentIdentityOverride[] }
	/** A form of the document has no real id in the aligned read. */
	| { readonly ok: false; readonly at: string };

/** HQ's summarized menus by their id, the first of each id. */
export function alignedMenusById(
	aligned: readonly HqAlignedModule[],
): ReadonlyMap<string, HqAlignedModule> {
	const byUniqueId = new Map<string, HqAlignedModule>();
	for (const module of aligned) {
		if (module.uniqueId !== null && !byUniqueId.has(module.uniqueId)) {
			byUniqueId.set(module.uniqueId, module);
		}
	}
	return byUniqueId;
}

/** The real id HQ's application resource gives one read form, or where none
 *  is (`adoptedIdentityRows`' `at`). */
export function realFormId(
	form: Pick<
		ReadMenuAndFormIdentities["forms"][number],
		"moduleUniqueId" | "xmlns"
	>,
	byUniqueId: ReadonlyMap<string, HqAlignedModule>,
): { readonly uniqueId: string } | { readonly at: string } {
	const module = byUniqueId.get(form.moduleUniqueId);
	if (module === undefined || module.kind === "not-summarized")
		return { at: `menu ${form.moduleUniqueId}` };
	const real = module.forms.find((one) => one.xmlns === form.xmlns);
	if (real === undefined)
		return { at: `form ${form.xmlns} in menu ${form.moduleUniqueId}` };
	return { uniqueId: real.uniqueId };
}

/**
 * One identity row per menu and per form the reading holds: a menu's
 * `unique_id` as the source holds it, a folded hidden menu under the
 * synthetic UUID the reader listed it by, and a form's real `unique_id` from
 * CommCare HQ's application resource beside its `xmlns`. A form whose menu
 * HQ could not summarize, or that the aligned menu does not hold, has no
 * real id, and the answer names it. Rows are sorted by kind, then UUID.
 */
export function adoptedIdentityRows(
	read: Pick<ReadMenuAndFormIdentities, "modules" | "forms">,
	aligned: readonly HqAlignedModule[],
): AdoptedIdentityRows {
	const byUniqueId = alignedMenusById(aligned);
	const rows: DeploymentIdentityOverride[] = read.modules.map((module) => ({
		entityKind: "module",
		novaEntityUuid: module.uuid,
		uniqueId: module.uniqueId,
		xmlns: null,
	}));
	for (const form of read.forms) {
		const real = realFormId(form, byUniqueId);
		if ("at" in real) return { ok: false, at: real.at };
		rows.push({
			entityKind: "form",
			novaEntityUuid: form.uuid,
			uniqueId: real.uniqueId,
			xmlns: form.xmlns,
		});
	}
	rows.sort(
		(a, b) =>
			codeUnitOrder(a.entityKind, b.entityKind) ||
			codeUnitOrder(a.novaEntityUuid, b.novaEntityUuid),
	);
	return { ok: true, rows };
}

// ── Keyed case ids ───────────────────────────────────────────────────────

/** One row of `app_deployment_keyed_case_ids`: the prefix a keyed create's cases stand under. */
export interface AdoptedKeyedCaseId {
	readonly operationUuid: Uuid;
	/** The type the operation created when its prefix was derived. */
	readonly caseType: string;
	readonly prefix: string;
}

/**
 * One row per keyed create the document keeps, with the prefix the source's
 * cases stand under and the type it was derived with, sorted by operation.
 */
export function adoptedKeyedCaseIdRows(
	read: Pick<ReadMenuAndFormIdentities, "keyedCreates">,
): readonly AdoptedKeyedCaseId[] {
	const rows = new Map<Uuid, AdoptedKeyedCaseId>();
	for (const create of read.keyedCreates) {
		if (rows.has(create.operationUuid)) {
			throw new Error(
				`Nova was given two keyed creates for the case operation ${create.operationUuid}. ` +
					"A reading lists each operation it keeps once, so whatever built this list has a mistake to fix.",
			);
		}
		rows.set(create.operationUuid, {
			operationUuid: create.operationUuid,
			caseType: create.caseType,
			prefix: create.prefix,
		});
	}
	return [...rows.values()].sort((a, b) =>
		codeUnitOrder(a.operationUuid, b.operationUuid),
	);
}

/**
 * The prefixes a publish to the adopted deployment prints keyed creates
 * under (`ExpandOptions.keyedCaseIdPrefixes`): each row whose operation the
 * document still holds and still creates the row's case type. An operation
 * whose type changed, and every operation with no row, takes the prefix its
 * app, form, operation and type derive.
 */
export function keyedCaseIdPrefixesFor(
	doc: BlueprintDoc,
	rows: readonly AdoptedKeyedCaseId[],
): ReadonlyMap<Uuid, string> {
	const byOperation = new Map(rows.map((row) => [row.operationUuid, row]));
	const prefixes = new Map<Uuid, string>();
	if (byOperation.size === 0) return prefixes;
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const row = byOperation.get(operation.uuid);
			if (
				row !== undefined &&
				operationCaseType(doc, formUuid as Uuid, operation) === row.caseType
			) {
				prefixes.set(operation.uuid, row.prefix);
			}
		}
	}
	return prefixes;
}

// ── Media paths ──────────────────────────────────────────────────────────

/** The rule for a path a file keeps, beside the media record it keys. */
export { isHoldableWirePath };

/** One file the app's source references, resolved to its asset. */
export interface AdoptedMediaFile {
	/** HQ's path as the source spells it, `jr://file/...`. */
	readonly hqPath: string;
	readonly assetId: MediaAssetId;
	readonly contentHash: string;
	readonly extension: string;
}

export interface MediaPathAssignment {
	readonly rows: readonly {
		readonly assetId: MediaAssetId;
		readonly wirePath: string;
	}[];
	/** A file HQ holds under several paths: the one kept and the ones every slot leaves. */
	readonly collapsed: readonly {
		readonly assetId: MediaAssetId;
		readonly kept: string;
		readonly dropped: readonly string[];
	}[];
	/** A path of HQ's that is not held, with why: the file takes its derivation. */
	readonly rederived: readonly {
		readonly assetId: MediaAssetId;
		readonly from: string;
		readonly why: MediaPathRederivedReason;
	}[];
}

export type MediaPathRederivedReason =
	/** HQ's upload cannot address it, or it is no safe archive entry (`isHoldableWirePath`). */
	| "not-holdable"
	/** It is in Nova's derived shape and is not this file's own derived path. */
	| "names-another-file"
	/** Only letter case tells it from a path of another file, and HQ's upload matches without case. */
	| "differs-only-by-case";

const JR_FILE = "jr://file/";

/** Nova's derived path, `commcare/<sha256><ext>`, in lower case. */
const DERIVED_SHAPE = /^commcare\/[0-9a-f]{64}\.[a-z0-9]+$/;

/**
 * The path each file keeps on the deployment, and what the first publish
 * moves. A path is dropped when it is not holdable, when it spells Nova's
 * derived shape for another file, or when only letter case tells it from a
 * path of another file. Of a file's paths that remain, the first in
 * code-unit order is kept; a file left with none takes its derivation.
 */
export function assignMediaPaths(
	files: readonly AdoptedMediaFile[],
): MediaPathAssignment {
	// 1. Each path loses `jr://file/`, and each asset's paths are gathered.
	const assets = new Map<
		MediaAssetId,
		{ readonly derived: string; readonly paths: Set<string> }
	>();
	for (const file of files) {
		if (!file.hqPath.startsWith(JR_FILE)) {
			/* The asset's id names the file, never its path, which is the app's word: a
			 * bring-in's failed line carries this message to Sentry. */
			throw new Error(
				`Nova was given a media path to keep for the asset ${file.assetId}, and it doesn't start with jr://file/. ` +
					"CommCare HQ can't build an app with such a path, so the reader should have reported this file before the app was created.",
			);
		}
		let asset = assets.get(file.assetId);
		if (asset === undefined) {
			asset = {
				derived: wirePathFor(file.contentHash, file.extension),
				paths: new Set(),
			};
			assets.set(file.assetId, asset);
		}
		asset.paths.add(file.hqPath.slice(JR_FILE.length));
	}

	const rederived: {
		assetId: MediaAssetId;
		from: string;
		why: MediaPathRederivedReason;
	}[] = [];
	// 2 and 3. Paths that are not holdable, or that name another file.
	const candidates = new Map<MediaAssetId, string[]>();
	for (const [assetId, asset] of assets) {
		const kept: string[] = [];
		for (const path of asset.paths) {
			if (!isHoldableWirePath(path)) {
				rederived.push({ assetId, from: path, why: "not-holdable" });
			} else if (
				DERIVED_SHAPE.test(path.toLowerCase()) &&
				path !== asset.derived
			) {
				rederived.push({ assetId, from: path, why: "names-another-file" });
			} else {
				kept.push(path);
			}
		}
		candidates.set(assetId, kept);
	}

	// 4. Paths that only letter case tells from a path of another file.
	const folded = new Map<string, Set<MediaAssetId>>();
	for (const [assetId, paths] of candidates) {
		for (const path of paths) {
			const key = path.toLowerCase();
			const owners = folded.get(key) ?? new Set<MediaAssetId>();
			owners.add(assetId);
			folded.set(key, owners);
		}
	}

	// 5 and 6. The first remaining path of each file in code-unit order.
	const rows: { assetId: MediaAssetId; wirePath: string }[] = [];
	const collapsed: {
		assetId: MediaAssetId;
		kept: string;
		dropped: string[];
	}[] = [];
	for (const [assetId, paths] of candidates) {
		const remaining: string[] = [];
		for (const path of paths) {
			if ((folded.get(path.toLowerCase())?.size ?? 0) > 1) {
				rederived.push({ assetId, from: path, why: "differs-only-by-case" });
			} else {
				remaining.push(path);
			}
		}
		remaining.sort(codeUnitOrder);
		const [kept, ...dropped] = remaining;
		if (kept === undefined) continue;
		rows.push({ assetId, wirePath: kept });
		if (dropped.length > 0) collapsed.push({ assetId, kept, dropped });
	}

	rows.sort((a, b) => codeUnitOrder(a.wirePath, b.wirePath));
	collapsed.sort((a, b) => codeUnitOrder(a.kept, b.kept));
	rederived.sort(
		(a, b) =>
			codeUnitOrder(a.from, b.from) || codeUnitOrder(a.assetId, b.assetId),
	);
	return { rows, collapsed, rederived };
}

// ── The `read` baseline ──────────────────────────────────────────────────

/** The two list lines worked out again from where the app runs, never stored. */
const DECLARATION_IDS: ReadonlySet<FirstPublishChangeId> = new Set([
	"web-apps-turned-off",
	"web-apps-turned-on",
]);

/** CommCare HQ's source of an app Nova brings in, as the adopted baseline
 *  stores it; it throws where that source is no application Nova can read,
 *  which the create's own read has already refused. */
export function adoptedSourceNormalized(
	remoteAppId: string,
	source: HqAppSource,
): Extract<ReturnType<typeof normalizeHqAppSource>, { readonly text: string }> {
	const normalized = normalizeHqAppSource(source.raw);
	if ("malformed" in normalized)
		throw unreadableAdoptedSource(remoteAppId, normalized.malformed);
	return normalized;
}

/** `adoptedSourceNormalized`'s normalized source alone, with no text or
 *  digest made of it: what a review reads of the baseline's source. */
export function adoptedSourceTree(
	remoteAppId: string,
	source: HqAppSource,
): unknown {
	const read = normalizedHqAppSource(source.raw);
	if ("malformed" in read)
		throw unreadableAdoptedSource(remoteAppId, read.malformed);
	return read.normalized;
}

function unreadableAdoptedSource(remoteAppId: string, at: string): Error {
	return new Error(
		`Nova was asked to record CommCare HQ's source of app ${remoteAppId} as the app it brought in, ` +
			`and that source isn't an application Nova can read (at ${at}). ` +
			"The create reads that same source before it gets here, so check what reached the birth.",
	);
}

/** What the adopted baseline records Nova owns: the descriptor of the first
 *  import the app's document gives over its source (`adoptedAppBaselineWrite`). */
export function adoptedBaselineOwnership(
	input: AdoptedBaselineOwnershipInput,
): AppBaselineWrite["ownership"] {
	const steps = adoptedBaselineOwnershipSteps(input);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

interface AdoptedBaselineOwnershipInput {
	readonly remoteAppId: string;
	readonly source: HqAppSource;
	readonly prepared: Pick<
		PreparedExportBoundary,
		"doc" | "assets" | "attachmentTarget" | "lookupNaming"
	>;
	readonly target: DeploymentTargetKey;
	readonly identity: WireIdentity;
}

/** `adoptedBaselineOwnership` a part at a time, its import's emission
 *  stopping between its parts (`importApplication.ts::hqImportApplicationSteps`). */
export function* adoptedBaselineOwnershipSteps(
	input: AdoptedBaselineOwnershipInput,
): Generator<void, AppBaselineWrite["ownership"], void> {
	const imported = yield* hqImportApplicationSteps({
		prepared: input.prepared,
		target: input.target,
		compatibility: { advisories: [] },
		update: { appId: input.remoteAppId, source: input.source },
		identity: input.identity,
		languageNames: "target",
		seeds: "target",
		/* The descriptor reads what the overlays set, and no case id prefix
		 * reaches one. */
		keyedCaseIdPrefixes: new Map(),
	});
	return imported.ownership;
}

/**
 * The baseline an adopted deployment is born with: CommCare HQ's source as
 * the create accepted it, under the ownership the first publish's body over
 * that source gives on an adopted mapping, with the birth's revision, the
 * HQ file at each held path a publish sends, and the reviewed list of what
 * the first publish changes, less the two lines that follow where the app
 * runs.
 *
 * The media record holds only the paths the bulk upload carries: a held path
 * only the logo uses is no path a publish sends, so no review settles it, and
 * a logo replaced in CommCare HQ would read as a moved file on every Refresh
 * while the review found nothing changed.
 */
export function adoptedAppBaselineWrite(input: {
	readonly remoteAppId: string;
	/** The source the create accepted. */
	readonly source: HqAppSource;
	readonly prepared: Pick<
		PreparedExportBoundary,
		"doc" | "assets" | "attachmentTarget" | "lookupNaming"
	>;
	readonly target: DeploymentTargetKey;
	/** `targetWireIdentity` of the adopted identity rows. */
	readonly identity: WireIdentity;
	/** The birth's sequence. */
	readonly novaRevision: number;
	/** CommCare HQ's file at each held media path, the logo's included. */
	readonly mediaFiles: HqMediaRecord;
	readonly observedAt: string;
	/** The chosen declaration's list, from the create's own acceptance, as a
	 *  list stores it (`reading/firstPublishChanges.ts::firstPublishListToStore`). */
	readonly firstPublish: FirstPublishView;
}): AppBaselineWrite & { readonly origin: "read" } {
	const normalized = adoptedSourceNormalized(input.remoteAppId, input.source);
	const ownership = adoptedBaselineOwnership(input);
	const list: StoredFirstPublish = {
		ids: input.firstPublish.ids.filter((id) => !DECLARATION_IDS.has(id)),
		webAppsOnInHq: input.source.cloudcareEnabled,
		of: "first-publish",
	};
	return {
		origin: "read",
		remoteAppId: input.remoteAppId,
		sourceGzip: gzipSync(Buffer.from(normalized.text, "utf8")),
		sourceBytes: normalized.bytes,
		sourceDigest: normalized.digest,
		ownership,
		observedAt: input.observedAt,
		discard: null,
		novaRevision: input.novaRevision,
		mediaFiles: {
			kind: "set",
			files: nextHqMediaRecord({
				published: publishedMediaFiles(
					bulkUploadAssets(input.prepared.doc, input.prepared.assets),
				),
				previous: null,
				learned: input.mediaFiles,
				reported: {},
			}),
		},
		firstPublish: { kind: "set", list },
	};
}

// ── Confirmations ────────────────────────────────────────────────────────

/**
 * The plan features the app's source already uses, recorded as confirmed at
 * adoption: every feature the document needs when the publish sends no table
 * and no place, except Web Apps where CommCare HQ holds the app's setting off
 * and Save to Case where the source holds no Save to Case block. The first
 * publish leaves each of these as the source has it, so asking would change
 * nothing a person could decide.
 */
export function adoptionPlanFeatureConfirmations(input: {
	readonly doc: BlueprintDoc;
	readonly target: DeploymentTargetKey;
	/** `HqAppSource.cloudcareEnabled` of the accepted source. */
	readonly sourceWebAppsOn: boolean;
	/** Whether the accepted source holds a Save to Case block. */
	readonly sourceHoldsSaveToCase: boolean;
}): readonly DeploymentConfirmationKey[] {
	return requiredPlanFeatures(
		input.doc,
		{ lookupTables: false, places: false },
		attachmentUrlTarget(input.target),
	)
		.filter((feature) =>
			feature.id === "web-apps"
				? input.sourceWebAppsOn
				: feature.id === "advanced-case-actions"
					? input.sourceHoldsSaveToCase
					: true,
		)
		.map((feature) => ({ kind: "plan-feature", subject: feature.id }));
}
