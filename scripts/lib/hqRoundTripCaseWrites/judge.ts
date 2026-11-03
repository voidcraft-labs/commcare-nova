/**
 * Step 15, `judge-target` (part 09 §7.13 and §12): whether the document the
 * steps left is one the fleet transaction may write.
 *
 * Over the target, in order:
 *
 * 1. `toPersistableDoc`, then `blueprintDocSchema.parse` (`target-parse`, a
 *    defect of a step; nothing else is judged over a document the head
 *    schema refuses);
 * 2. `mutationCommitVerdict(target, [], lookupContext)`, the absolute gate
 *    every commit runs (`target-gate`, each finding's code with its
 *    `details.reason`);
 * 3. `exportReadinessFindings` with the Project's media records
 *    (`target-export-readiness`);
 * 4. the case-schema comparison of §12: the schemas the target derives
 *    (`lib/case-store/store.ts::buildCaseTypeMap`) against the app's active `case_type_schemas` rows, through the
 *    comparison `scripts/lib/schemaDrift.ts::computeSchemaDrift` performs, so
 *    the cutover's count and the drift writer's work are one computation.
 *    Each difference is a planned cause or `case-schema-unplanned`;
 * 5. idempotence, over a target the checks before it admit: the
 *    transform over the target's own carriers (the rows
 *    `decomposeBlueprint` gives, read back through `oldShape.ts::
 *    readRawDocument`) plans no edit and leaves the same document under
 *    `canonicalJsonDigest` (`not-idempotent`); the changes a step reports
 *    without writing the document (`REPORT_ONLY_CHANGES`) are not edits.
 *
 * The transform passes its own steps in as `rerun`, so this module never
 * imports the transform; that inner run judges nothing, so the comparison
 * asks only what the steps do to the target.
 */

import { blueprintScalars, decomposeBlueprint } from "@/lib/db/blueprintRows";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	CASE_CLAIM_CASE_TYPE,
	type PersistableDoc,
} from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { type CaseTypeDrift, compareStoredSchemas } from "../schemaDrift";
import { type RawDocument, readRawDocument } from "./oldShape";
import type { ExtensionChildrenChange } from "./steps/extensionChildren";
import { issueCode } from "./structure";
import {
	type AppTransform,
	type BlockerPlace,
	type CutoverBlocker,
	compareText,
	type LiftedFacts,
	type PlannedSchemaChange,
	SCHEMA_CAUSES,
	type SchemaCause,
	type StepContext,
} from "./types";

/** What the judgement reads beside the target. */
export interface JudgeInput {
	readonly target: BlueprintDoc;
	readonly ctx: StepContext;
	/** The field writes the structure phase lifted, for `capture-link-property`. */
	readonly facts: Pick<LiftedFacts, "fieldWrites" | "attachmentFields">;
	/**
	 * The transform's steps over a raw document, judging nothing. Absent,
	 * idempotence is not judged: the transform stopped at a
	 * blocker, and the steps after it would change the document it left.
	 */
	readonly rerun?: (raw: RawDocument) => AppTransform;
}

export interface Judgement {
	readonly blockers: readonly CutoverBlocker[];
	/** Every planned case-schema difference, by case type and cause. */
	readonly schemaChanges: readonly PlannedSchemaChange[];
}

type Finding = ReturnType<typeof exportReadinessFindings>[number];

/** A validator finding's codes: its code, and its code with its
 *  `details.reason` where it has one. Never its message. */
function findingCodes(finding: Finding): string[] {
	const reason = finding.details?.reason;
	return reason === undefined
		? [finding.code]
		: [finding.code, `${finding.code}:${reason}`];
}

/** Where a finding was met, for `--debug-details` only. */
function findingPlace(finding: Finding): BlockerPlace {
	const at = finding.location;
	const entity: BlockerPlace["entity"] =
		at.fieldUuid !== undefined
			? {
					kind: "field",
					uuid: at.fieldUuid,
					...(at.fieldId !== undefined && { name: at.fieldId }),
				}
			: at.formUuid !== undefined
				? {
						kind: "form",
						uuid: at.formUuid,
						...(at.formName !== undefined && { name: at.formName }),
					}
				: at.moduleUuid !== undefined
					? {
							kind: "module",
							uuid: at.moduleUuid,
							...(at.moduleName !== undefined && { name: at.moduleName }),
						}
					: undefined;
	return {
		...(entity !== undefined && { entity }),
		findingCode: finding.code,
		message: finding.message,
	};
}

function findingBlocker(
	code: "target-gate" | "target-export-readiness",
	findings: readonly Finding[],
): CutoverBlocker {
	return {
		code,
		count: findings.length,
		findingCodes: [...new Set(findings.flatMap(findingCodes))].sort(
			compareText,
		),
		places: findings.map(findingPlace),
	};
}

// ─── The case schema (§12) ────────────────────────────────────────────────

/** One difference of one case type, as the classification reads it. */
type Difference =
	| { readonly kind: "missing-row" }
	| {
			readonly kind:
				| "added"
				| "removed"
				| "refined"
				| "retyped"
				| "unresolvable";
			readonly property: string;
	  };

function differencesOf(drift: CaseTypeDrift): Difference[] {
	if (drift.missingRow) return [{ kind: "missing-row" }];
	return [
		...drift.added.map((property) => ({ kind: "added" as const, property })),
		...drift.removed.map((property) => ({
			kind: "removed" as const,
			property,
		})),
		...drift.refined.map(({ property }) => ({
			kind: "refined" as const,
			property,
		})),
		...drift.retyped.map(({ property }) => ({
			kind: "retyped" as const,
			property,
		})),
		...drift.unresolvable.map(({ property }) => ({
			kind: "unresolvable" as const,
			property,
		})),
	];
}

/**
 * Every `(case type, property)` only attachment-mode capture writers wrote:
 * at least one field write named it, and every field write that did was a
 * capture whose stored mode was `attachment` (C5).
 */
function attachmentOnlyProperties(
	facts: JudgeInput["facts"],
): ReadonlySet<string> {
	const writers = new Map<string, boolean>();
	for (const writes of facts.fieldWrites.values())
		for (const write of writes) {
			const key = JSON.stringify([write.caseType, write.property]);
			const attachment = facts.attachmentFields.has(write.fieldUuid);
			writers.set(key, (writers.get(key) ?? true) && attachment);
		}
	return new Set(
		[...writers].flatMap(([key, onlyAttachment]) =>
			onlyAttachment ? [key] : [],
		),
	);
}

/**
 * The planned cause of one difference, or undefined where it is none:
 *
 * - `claim-type-row`: the `commcare-case-claim` row missing, which every app
 *   gains through the drift writer;
 * - `capture-link-property`: a property only attachment-mode writers wrote,
 *   now written as a link, `added` where `main` materialized no slot for it
 *   and `refined` where it did;
 * - `derivation-drift`: a property both sides carry whose derived spec moved
 *   (`refined` or `retyped`), which is what the merged code deriving a type
 *   differently from `main` looks like when the document's writes are the
 *   same. A property gained or lost, a missing row of any other type, or a
 *   stored spec no arm emits is a write that moved, which no step plans.
 */
function plannedCause(
	caseType: string,
	difference: Difference,
	attachmentOnly: ReadonlySet<string>,
): SchemaCause | undefined {
	if (difference.kind === "missing-row")
		return caseType === CASE_CLAIM_CASE_TYPE ? "claim-type-row" : undefined;
	if (
		(difference.kind === "added" || difference.kind === "refined") &&
		attachmentOnly.has(JSON.stringify([caseType, difference.property]))
	)
		return "capture-link-property";
	if (difference.kind === "refined" || difference.kind === "retyped")
		return "derivation-drift";
	return undefined;
}

/** The stored rows as `compareStoredSchemas` reads them. */
function storedRows(
	storedSchemas: ReadonlyMap<string, string>,
): ReadonlyMap<string, unknown> {
	return new Map(
		[...storedSchemas].map(([caseType, text]) => [
			caseType,
			JSON.parse(text) as unknown,
		]),
	);
}

/** §12's comparison: the planned changes and the unplanned differences. */
function caseSchemaJudgement(
	persisted: PersistableDoc,
	input: JudgeInput,
): {
	readonly schemaChanges: PlannedSchemaChange[];
	readonly unplanned: CutoverBlocker | undefined;
} {
	const attachmentOnly = attachmentOnlyProperties(input.facts);
	const planned = new Map<string, PlannedSchemaChange>();
	const unplanned: string[] = [];
	let unplannedCount = 0;
	for (const drift of compareStoredSchemas(
		persisted,
		storedRows(input.ctx.storedSchemas),
	)) {
		for (const difference of differencesOf(drift)) {
			const cause = plannedCause(drift.caseType, difference, attachmentOnly);
			if (cause === undefined) {
				unplannedCount++;
				unplanned.push(difference.kind);
				continue;
			}
			const key = JSON.stringify([drift.caseType, cause]);
			const prior = planned.get(key);
			planned.set(key, {
				caseType: drift.caseType,
				cause,
				properties:
					(prior?.properties ?? 0) +
					(difference.kind === "missing-row" ? 0 : 1),
			});
		}
	}
	const schemaChanges = [...planned.values()].sort(
		(a, b) =>
			compareText(a.caseType, b.caseType) ||
			SCHEMA_CAUSES.indexOf(a.cause) - SCHEMA_CAUSES.indexOf(b.cause),
	);
	return {
		schemaChanges,
		unplanned:
			unplannedCount === 0
				? undefined
				: {
						code: "case-schema-unplanned",
						count: unplannedCount,
						findingCodes: [...new Set(unplanned)].sort(compareText),
						places: [
							{
								message: `The target derives ${unplannedCount} case-schema difference${unplannedCount === 1 ? "" : "s"} from the stored rows that no step of the cutover plans.`,
							},
						],
					},
	};
}

// ─── Idempotence ──────────────────────────────────────────────────────────

/** The carriers the writer stores for `persisted`: its `apps` columns as
 *  text and one `blueprint_entities` row per entity. */
export function carriersOf(persisted: PersistableDoc): {
	readonly root: PersistedBlueprintRootText;
	readonly rows: readonly PersistedEntityRowText[];
} {
	const scalars = blueprintScalars(persisted);
	const text = (value: unknown): string | null =>
		value === undefined || value === null ? null : JSON.stringify(value);
	return {
		root: {
			app_name: scalars.app_name,
			connect_type: scalars.connect_type ?? null,
			case_types_text: text(scalars.case_types),
			localization_text: text(scalars.localization),
			app_settings_text: text(scalars.app_settings),
			logo: (scalars.logo ?? null) as PersistedBlueprintRootText["logo"],
		},
		rows: decomposeBlueprint(persisted).map((row) => ({
			uuid: row.uuid,
			kind: row.kind,
			parent_uuid: row.parent_uuid,
			ordinal: row.ordinal,
			data_text: JSON.stringify(row.data),
		})),
	};
}

/**
 * The change kinds a step reports without writing the document: step 8's
 * carried creates and the menus they make advanced, which the head derives
 * from the document as it stands (§7.6: "a carried create needs no stored
 * change"). They describe the target, so a second application reports them
 * again; every other kind is an edit, which a second application must not
 * plan.
 */
const REPORT_ONLY_CHANGES: ReadonlySet<string> = new Set(
	(
		[
			"carried-create",
			"non-extension-carried-create",
			"module-made-advanced",
		] satisfies readonly ExtensionChildrenChange[]
	).map((kind) => `extension-children:${kind}`),
);

function idempotenceBlocker(
	persisted: PersistableDoc,
	appId: string,
	rerun: NonNullable<JudgeInput["rerun"]>,
): CutoverBlocker | undefined {
	const again = rerun(readRawDocument(appId, carriersOf(persisted)));
	const edits = again.changes.filter(
		(change) => !REPORT_ONLY_CHANGES.has(`${change.step}:${change.kind}`),
	);
	const codes = [
		...edits.map((change) => `change:${change.step}:${change.kind}`),
		...again.blockers.map((blocker) => `blocker:${blocker.code}`),
		...(again.target === null ||
		canonicalJsonDigest(toPersistableDoc(again.target)) !==
			canonicalJsonDigest(persisted)
			? ["digest"]
			: []),
	];
	if (codes.length === 0) return undefined;
	return {
		code: "not-idempotent",
		count: Math.max(1, edits.length + again.blockers.length),
		findingCodes: [...new Set(codes)].sort(compareText),
		places: [
			{
				message:
					"The cutover's steps, run again over the document they made, change it again.",
			},
		],
	};
}

// ─── The step ─────────────────────────────────────────────────────────────

/** Step `judge-target` over one target. */
export function judge(input: JudgeInput): Judgement {
	const { target, ctx } = input;
	const persisted = toPersistableDoc(target);
	const parsed = blueprintDocSchema.safeParse(persisted);
	if (!parsed.success)
		return {
			blockers: [
				{
					code: "target-parse",
					count: parsed.error.issues.length,
					findingCodes: [...new Set(parsed.error.issues.map(issueCode))].sort(
						compareText,
					),
				},
			],
			schemaChanges: [],
		};

	const blockers: CutoverBlocker[] = [];
	const verdict = mutationCommitVerdict(target, [], ctx.lookupContext);
	if (!verdict.ok && verdict.findings.length > 0)
		blockers.push(findingBlocker("target-gate", verdict.findings));
	const readiness = exportReadinessFindings(
		target,
		ctx.lookupContext,
		ctx.mediaRecords,
	);
	if (readiness.length > 0)
		blockers.push(findingBlocker("target-export-readiness", readiness));
	const schema = caseSchemaJudgement(persisted, input);
	if (schema.unplanned !== undefined) blockers.push(schema.unplanned);
	/* Idempotence asks what the steps do to a target the gate admits: over a
	 * refused one, which is blocked already, the steps' emission-reading
	 * planners have no document they are defined over. */
	if (input.rerun !== undefined && blockers.length === 0) {
		const blocker = idempotenceBlocker(persisted, ctx.appId, input.rerun);
		if (blocker !== undefined) blockers.push(blocker);
	}
	return { blockers, schemaChanges: schema.schemaChanges };
}
