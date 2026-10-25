/**
 * The platforms cutover's transform of one app (part 09 §5): pure, from the
 * source document and what the fleet read gives beside it to the target, its
 * content-free changes, its notice entries and its blockers.
 *
 *   1. `declare-platforms`: the declaration the content other than media
 *      allows, with the date-and-time split where that is the only way the
 *      app runs anywhere (`lib/doc/platformDeclaration.ts`, the one planner
 *      the fuzz mapping also reaches);
 *   2. `remove-unplayed-media`: each authored reference whose file does not
 *      play on every declared platform, removed (skipped by the scan, which
 *      classifies no media);
 *   3. `judge-target`: the target is one every editor would accept, the
 *      synthetic writer can replay, and the case store need not change for;
 *   4. `deployment-lines`: writes nothing, selects each live deployment's
 *      lines.
 *
 * Each step applies its mutations through the reducer every editor's commit
 * uses (`prepareMutationCandidate` over `admitMutationBatch`). A blocker stops
 * that app's transform: the app is reported and the plan has no target for
 * it.
 */

import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { deepEqual } from "@/lib/doc/deepEqual";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { planContentDeclaration } from "@/lib/doc/platformDeclaration";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { type AssetRef, walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import { UNPLAYABLE_MEDIA_FORMAT } from "@/lib/domain/multimedia";
import { declaredPlatforms } from "@/lib/domain/platforms";
import { ownRecordValue } from "@/lib/domain/records";
import { unplayableReferences } from "@/lib/media/platformPlayback";
import type {
	DocumentNoticeEntry,
	MigrationNoticeEntry,
	NoticeEntityRef,
} from "@/lib/notices/migrationNotice";
import { NOTICE_TEXT_MAX } from "@/lib/notices/migrationNotice";
import {
	appNoticeEntries,
	deploymentLines,
	noticeText,
	type SourceDeployment,
} from "./notice";
import { removalsFor } from "./removals";
import {
	CUTOVER_BLOCKER_CODES,
	type CutoverBlocker,
	type CutoverBlockerCode,
	type MediaPlan,
	type PlannedChange,
	type RemovalCause,
} from "./types";

/** What each step reads beside the document, all of it from Nova's database. */
export interface PlatformsStepContext {
	readonly appId: string;
	readonly projectId: string;
	/** The Project's lookup definitions, read once per Project. */
	readonly lookupContext: LookupValidationContext;
	/** The Project's media plans by asset id; null in the scan, which skips step 2. */
	readonly formatOf: ((assetId: string) => MediaPlan | undefined) | null;
	/** The Project's media records, each with its classified format, for export readiness. */
	readonly mediaRecords: ReadonlyMap<string, MediaAssetRecord>;
	/** The app's deployments with a live `app` mapping, for step 4. */
	readonly deployments: readonly SourceDeployment[];
}

export interface AppTransform {
	/** The target; the source itself where no step changed anything. */
	readonly target: BlueprintDoc;
	/** Whether the target differs from the source, so the writer writes it. */
	readonly changed: boolean;
	/** The declaration the target holds; null where a blocker stopped step 1. */
	readonly declaration: "both" | "web-apps" | "android" | null;
	readonly changes: readonly PlannedChange[];
	/** With names; never printed. Empty where the app gets no notice row. */
	readonly notice: readonly MigrationNoticeEntry[];
	/** One per code met, in `CUTOVER_BLOCKER_CODES` order. */
	readonly blockers: readonly CutoverBlocker[];
}

/** A step's result: the document it leaves, or the blockers that stopped it. */
type StepOutcome =
	| {
			readonly ok: true;
			readonly doc: BlueprintDoc;
			readonly changes: readonly PlannedChange[];
			readonly notice: readonly DocumentNoticeEntry[];
	  }
	| { readonly ok: false; readonly blockers: readonly CutoverBlocker[] };

function blocker(
	code: CutoverBlockerCode,
	count: number,
	findingCodes: Iterable<string> = [],
): CutoverBlocker {
	return { code, count, findingCodes: [...new Set(findingCodes)].sort() };
}

function inRegistryOrder(
	blockers: readonly CutoverBlocker[],
): CutoverBlocker[] {
	return [...blockers].sort(
		(a, b) =>
			CUTOVER_BLOCKER_CODES.indexOf(a.code) -
			CUTOVER_BLOCKER_CODES.indexOf(b.code),
	);
}

/**
 * Apply one step's mutations through the reducer every editor's commit uses;
 * an admission issue is the blocker `transform-admission`.
 */
function applied(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): { ok: true; doc: BlueprintDoc } | { ok: false; blocker: CutoverBlocker } {
	if (mutations.length === 0) return { ok: true, doc };
	let prepared: ReturnType<typeof prepareMutationCandidate>;
	try {
		prepared = prepareMutationCandidate(doc, admitMutationBatch(mutations));
	} catch (error) {
		return {
			ok: false,
			blocker: blocker("transform-admission", 1, [
				error instanceof Error ? error.constructor.name : "unknown",
			]),
		};
	}
	if (preparedCandidateHasAdmissionIssue(prepared)) {
		return {
			ok: false,
			blocker: blocker("transform-admission", 1, [
				...(prepared.identityAdmissionIssue !== undefined ? ["identity"] : []),
				...(prepared.sequenceAdmissionIssue !== undefined ? ["sequence"] : []),
				...(prepared.targetAdmissionIssue === true ? ["target"] : []),
				...(prepared.renamePlanIssue !== undefined ? ["rename"] : []),
			]),
		};
	}
	return { ok: true, doc: prepared.nextDoc };
}

function appEntity(doc: BlueprintDoc): NoticeEntityRef {
	return { type: "app", nameAtMigration: noticeText(doc.appName) };
}

// ── Step 1: declare-platforms ──────────────────────────────────────

function declarePlatforms(doc: BlueprintDoc): StepOutcome {
	const plan = planContentDeclaration(doc);
	if (plan.kind === "runs-on-neither") {
		return {
			ok: false,
			blockers: [
				blocker("runs-on-neither", 1, [
					...plan.webAppsUnavailable.map((id) => `web-apps:${id}`),
					...plan.androidUnavailable.map((id) => `android:${id}`),
				]),
			],
		};
	}
	if (plan.kind === "split-refused") {
		return {
			ok: false,
			blockers: [blocker("datetime-split-refused", 1, [plan.reason])],
		};
	}
	const next = applied(doc, plan.mutations);
	if (!next.ok) return { ok: false, blockers: [next.blocker] };
	if (plan.mutations.length === 0 || plan.runsOnlyOn === undefined) {
		return { ok: true, doc: next.doc, changes: [], notice: [] };
	}
	const changes: PlannedChange[] = [
		{
			step: "declare-platforms",
			entityUuid: null,
			detail: {
				runsOn: plan.runsOnlyOn,
				causes: plan.causes.join(","),
				split: plan.splits.length,
			},
		},
	];
	const notice: DocumentNoticeEntry[] = [
		{
			kind: "document",
			reason: "platforms-declared",
			entity: appEntity(doc),
			detail: {
				runsOn: plan.runsOnlyOn,
				causes: plan.causes.join(","),
				...(plan.splits.length > 0 && { split: String(plan.splits.length) }),
			},
		},
	];
	for (const split of plan.splits) {
		const field = ownRecordValue(doc.fields, split.fieldUuid);
		const form = ownRecordValue(doc.forms, split.formUuid);
		changes.push({
			step: "declare-platforms",
			entityUuid: split.fieldUuid,
			detail: {
				split: 1,
				writer:
					field !== undefined &&
					"caseWrite" in field &&
					field.caseWrite !== undefined
						? 1
						: 0,
			},
		});
		notice.push({
			kind: "document",
			reason: "datetime-question-split",
			entity: {
				type: "field",
				uuid: split.fieldUuid,
				nameAtMigration: noticeText(field?.id),
			},
			detail: {
				...(form !== undefined && { form: noticeText(form.name) }),
				date: noticeText(split.dateId),
				time: noticeText(split.timeId),
			},
		});
	}
	return { ok: true, doc: next.doc, changes, notice };
}

// ── Step 2: remove-unplayed-media ──────────────────────────────────

/** The notice entity, the owner's `detail` and the carrier of one reference. */
function carrierNotice(
	doc: BlueprintDoc,
	ref: AssetRef,
): {
	readonly entity: NoticeEntityRef;
	readonly detail: Record<string, string>;
} {
	const at = ref.location;
	switch (at.kind) {
		case "app_logo":
			return { entity: appEntity(doc), detail: { carrier: "logo" } };
		case "module_icon":
		case "module_audio_label":
			return {
				entity: {
					type: "module",
					uuid: at.moduleUuid,
					nameAtMigration: noticeText(at.moduleName),
				},
				detail: {
					carrier: at.kind === "module_icon" ? "menu-icon" : "menu-audio",
				},
			};
		case "case_list_icon":
		case "case_list_audio_label":
			return {
				entity: {
					type: "module",
					uuid: at.moduleUuid,
					nameAtMigration: noticeText(at.moduleName),
				},
				detail: {
					carrier:
						at.kind === "case_list_icon" ? "case-list-icon" : "case-list-audio",
				},
			};
		case "form_icon":
		case "form_audio_label":
			return {
				entity: {
					type: "form",
					uuid: at.formUuid,
					nameAtMigration: noticeText(at.formName),
				},
				detail: {
					module: noticeText(at.moduleName),
					carrier: at.kind === "form_icon" ? "menu-icon" : "menu-audio",
				},
			};
		case "field_media_bundle":
			return {
				entity: {
					type: "field",
					uuid: at.fieldUuid,
					nameAtMigration: noticeText(at.fieldId),
				},
				detail: {
					form: noticeText(at.formName),
					carrier: at.bundleKey === "label_media" ? "label" : "help",
				},
			};
		case "option_media":
			return {
				entity: {
					type: "field",
					uuid: at.fieldUuid,
					nameAtMigration: noticeText(at.fieldId),
				},
				detail: {
					form: noticeText(at.formName),
					carrier: "option",
					option: noticeText(at.optionValue),
				},
			};
		case "image_map_mapping":
			return {
				entity: {
					type: "caseListColumn",
					uuid: at.columnUuid,
					nameAtMigration: noticeText(at.columnHeader),
				},
				detail: {
					module: noticeText(at.moduleName),
					carrier: "image-map-row",
					row: noticeText(at.rowValue),
				},
			};
	}
}

/** The entity a removal change names, content-free: the carrier's owner. */
function ownerUuid(ref: AssetRef): string | null {
	const at = ref.location;
	switch (at.kind) {
		case "app_logo":
			return null;
		case "module_icon":
		case "module_audio_label":
		case "case_list_icon":
		case "case_list_audio_label":
			return at.moduleUuid;
		case "form_icon":
		case "form_audio_label":
			return at.formUuid;
		case "field_media_bundle":
		case "option_media":
			return at.fieldUuid;
		case "image_map_mapping":
			return at.columnUuid;
	}
}

function removalCause(
	plan: MediaPlan,
	missing: readonly string[],
): RemovalCause {
	if (plan.cause === "missing" || plan.cause === "too-large") return plan.cause;
	if (plan.format === UNPLAYABLE_MEDIA_FORMAT) return "neither";
	/* Every variant plays on at least one platform, so a variant a declared
	 * platform can't play names exactly one. */
	return missing[0] === "android" ? "android" : "web-apps";
}

function removeUnplayedMedia(
	doc: BlueprintDoc,
	ctx: PlatformsStepContext,
): StepOutcome {
	const formatOf = ctx.formatOf;
	if (formatOf === null) return { ok: true, doc, changes: [], notice: [] };
	/* The kernel refuses a reference with no row; `unplayableReferences`
	 * skips one, so the cutover holds that guard itself. */
	const withoutRow = [...walkAuthoredAssetRefs(doc)].filter(
		(ref) =>
			!isBuiltinIconRef(ref.assetId) && formatOf(ref.assetId) === undefined,
	);
	if (withoutRow.length > 0) {
		return {
			ok: false,
			blockers: [blocker("media-row-missing", withoutRow.length)],
		};
	}
	const formats = new Map<
		string,
		{ mediaFormat: MediaPlan["format"]; mimeType: string }
	>();
	for (const ref of walkAuthoredAssetRefs(doc)) {
		const plan = isBuiltinIconRef(ref.assetId)
			? undefined
			: formatOf(ref.assetId);
		if (plan !== undefined)
			formats.set(ref.assetId, {
				mediaFormat: plan.format,
				mimeType: plan.mimeType,
			});
	}
	const unplayable = unplayableReferences(doc, formats, declaredPlatforms(doc));
	if (unplayable.length === 0)
		return { ok: true, doc, changes: [], notice: [] };
	const changes: PlannedChange[] = [];
	const notice: DocumentNoticeEntry[] = [];
	for (const reference of unplayable) {
		const plan = formatOf(reference.ref.assetId) as MediaPlan;
		const cause = removalCause(plan, reference.missing);
		const { entity, detail } = carrierNotice(doc, reference.ref);
		const record = ctx.mediaRecords.get(reference.ref.assetId);
		const name =
			record?.displayName !== undefined && record.displayName !== ""
				? record.displayName
				: record?.originalFilename;
		/* Stored only whole, never cut; `noticeText` keeps a lone surrogate
		 * from reaching the jsonb row. */
		const file =
			name !== undefined && name.length <= NOTICE_TEXT_MAX
				? noticeText(name)
				: undefined;
		changes.push({
			step: "remove-unplayed-media",
			entityUuid: ownerUuid(reference.ref),
			detail: {
				carrier: detail.carrier as string,
				media: reference.ref.slotKind,
				format: plan.format,
				cause,
			},
		});
		notice.push({
			kind: "document",
			reason: "media-not-played-removed",
			entity,
			detail: {
				...detail,
				media: reference.ref.slotKind,
				...(file !== undefined && file.length > 0 && { file }),
				cause,
			},
		});
	}
	const next = applied(
		doc,
		removalsFor(
			doc,
			unplayable.map((reference) => reference.ref),
		),
	);
	if (!next.ok) return { ok: false, blockers: [next.blocker] };
	return { ok: true, doc: next.doc, changes, notice };
}

// ── Step 3: judge-target ────────────────────────────────────────────

/** A validator finding as the report counts it: its code, reason and checker code. */
function findingCodesOf(
	findings: readonly {
		readonly code: string;
		readonly details?: Readonly<Record<string, string>>;
	}[],
): string[] {
	return findings.flatMap((finding) => [
		finding.code,
		...(finding.details?.reason !== undefined
			? [`${finding.code}:${finding.details.reason}`]
			: []),
		...(finding.details?.checkCode !== undefined
			? [
					`${finding.code}:${finding.details.checkCode}:${finding.details.checkReason ?? ""}`,
				]
			: []),
	]);
}

/** A case-type map as a comparable value: its entries in code-point order. */
function caseTypeEntries(doc: BlueprintDoc): unknown {
	return [...buildCaseTypeMap(toPersistableDoc(doc))].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
}

/** Steps 1 and 2 over a document: the mutations they would make, counted. */
function remainingStepChanges(
	doc: BlueprintDoc,
	ctx: PlatformsStepContext,
): number {
	const declared = declarePlatforms(doc);
	if (!declared.ok) return 1;
	if (declared.changes.length > 0) return declared.changes.length;
	const media = removeUnplayedMedia(doc, ctx);
	if (!media.ok) return 1;
	return media.changes.length;
}

/**
 * Step 3 alone, over any target: the blockers it finds, empty where the
 * target is clean. Exported so a test can judge a target no step would make.
 */
export function judgeTarget(
	source: BlueprintDoc,
	target: BlueprintDoc,
	ctx: PlatformsStepContext,
): readonly CutoverBlocker[] {
	const blockers: CutoverBlocker[] = [];
	// 1. The head schema.
	try {
		blueprintDocSchema.parse(toPersistableDoc(target));
	} catch {
		return [blocker("target-parse", 1)];
	}
	// 2. The absolute gate every commit and the runtime probe run.
	const verdict = mutationCommitVerdict(target, [], ctx.lookupContext);
	if (!verdict.ok) {
		blockers.push(
			blocker(
				"target-gate",
				verdict.findings.length,
				findingCodesOf(verdict.findings),
			),
		);
	}
	// 3. Export readiness, with the Project's classified media records. The
	// scan classifies nothing, so it cannot decide whether a file plays.
	const readiness = exportReadinessFindings(
		target,
		ctx.lookupContext,
		ctx.mediaRecords,
	).filter(
		(finding) =>
			ctx.formatOf !== null || finding.code !== "MEDIA_FORMAT_NOT_PLAYED",
	);
	if (readiness.length > 0) {
		blockers.push(
			blocker(
				"target-export-readiness",
				readiness.length,
				findingCodesOf(readiness),
			),
		);
	}
	// 4. Representable: the synthetic writer's own pure checks, in its order.
	if (!deepEqual(toPersistableDoc(source), toPersistableDoc(target))) {
		let representable = false;
		try {
			const mutations = admitMutationBatch(
				diffDocsToMutations(
					source,
					hydratePersistedBlueprint(toPersistableDoc(target)),
				),
			);
			const prepared = prepareMutationCandidate(source, mutations);
			representable =
				deepEqual(
					toPersistableDoc(prepared.nextDoc),
					toPersistableDoc(target),
				) && !mutationTargetsInvalid(source, mutations);
		} catch {
			representable = false;
		}
		if (!representable) blockers.push(blocker("not-representable", 1));
	}
	// 5. The case store: no derivation moves.
	if (!deepEqual(caseTypeEntries(source), caseTypeEntries(target))) {
		blockers.push(blocker("case-schema-changed", 1));
	}
	// 6. Idempotent: steps 1 and 2 over the target change nothing.
	const remaining = remainingStepChanges(target, ctx);
	if (remaining > 0) blockers.push(blocker("not-idempotent", remaining));
	return inRegistryOrder(blockers);
}

// ── The transform ──────────────────────────────────────────────────

function declarationOf(doc: BlueprintDoc): "both" | "web-apps" | "android" {
	return doc.appSettings.runsOnlyOn ?? "both";
}

/** Steps 1 and 2, then `judgeTarget`, then step 4. */
export function transformApp(
	source: BlueprintDoc,
	ctx: PlatformsStepContext,
): AppTransform {
	const stopped = (
		blockers: readonly CutoverBlocker[],
		declaration: AppTransform["declaration"],
	): AppTransform => ({
		target: source,
		changed: false,
		declaration,
		changes: [],
		notice: [],
		blockers: inRegistryOrder(blockers),
	});
	const declared = declarePlatforms(source);
	if (!declared.ok) return stopped(declared.blockers, null);
	const media = removeUnplayedMedia(declared.doc, ctx);
	if (!media.ok) return stopped(media.blockers, declarationOf(declared.doc));
	const target = media.doc;
	const judged = judgeTarget(source, target, ctx);
	if (judged.length > 0) return stopped(judged, declarationOf(target));
	const changed = !deepEqual(
		toPersistableDoc(source),
		toPersistableDoc(target),
	);
	const lines = deploymentLines(target, ctx.deployments, changed);
	return {
		target: changed ? target : source,
		changed,
		declaration: declarationOf(target),
		changes: [
			...declared.changes,
			...media.changes,
			...lines.map(
				(line): PlannedChange => ({
					step: "deployment-lines",
					entityUuid: line.deployment.deploymentId,
					detail: { reason: line.reason, ...(line.detail ?? {}) },
				}),
			),
		],
		notice: appNoticeEntries(lines, [...declared.notice, ...media.notice]),
		blockers: [],
	};
}
