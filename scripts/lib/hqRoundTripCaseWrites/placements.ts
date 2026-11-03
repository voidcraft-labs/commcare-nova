/**
 * Step 14, `placements` (part 09 §8): where a published app keeps each unit
 * of each form once the cutover has run.
 *
 * A unit is a case operation of the target (the own arm and every operation
 * step 6 made included), a form's own close where `main` wrote it apart, or
 * a query repeat. Each has today's placement, the one `main`'s emission gave
 * it (`frozen/todaysPlacements.ts`, read over the raw document before any
 * step ran). A published deployment's baseline is CommCare HQ's own read of
 * what Nova last pushed there, so where a readable baseline carries a block
 * at today's placement's identity (`lib/commcare/hq/publishedCaseBlocks.ts::
 * publishedCaseBlocks`), or where a published deployment's baseline is
 * unknown (part 03 §12: Nova never read what that project space holds), the
 * unit is held at today's placement, as long as the head can express it
 * there (`lib/doc/placementHolds.ts::holdExpresses`). Then every later
 * publish writes it where HQ already holds it, and no answer path or case
 * block moves.
 *
 * Section 8.5's classes are never held: a create a link carries, every unit
 * of a form whose menu turns advanced, a basic child whose index `main`
 * counted past an inert extension subcase (held instead at its new index
 * where a baseline carried it at the old one), the own arm of a registration
 * that changes its new case before creating it (C11), a query repeat whose
 * rule now gives the count placement, and the own close of a form whose
 * closing operations all held writes (C9). Any other unit that should be
 * held and cannot be expressed is `placement-path-mismatch`, a defect of the
 * stack, and so is a held unit the head's emission does not write at exactly
 * that identity (§8.4, over `lib/commcare/casePlacementPlan.ts::
 * planFormCaseWire`).
 *
 * The holds are one `holdPlacements` mutation per app, applied through the
 * reducer every editor's commit uses. Everything this module returns is
 * content-free but for a blocker's `places`, which only `--debug-details`
 * prints.
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { planFormCaseWire } from "@/lib/commcare/casePlacementPlan";
import { expandDoc } from "@/lib/commcare/expander";
import { linkCarriedCreates } from "@/lib/commcare/formLinkProjection";
import {
	type PublishedCaseBlock,
	type PublishedForm,
	publishedCaseBlocks,
} from "@/lib/commcare/hq/publishedCaseBlocks";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import {
	type PlacementSubject,
	placementIneligibility,
	planBasicSubcases,
	repeatRowPath,
} from "@/lib/commcare/placement";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import type { FormPath } from "@/lib/commcare/xform/formPath";
import {
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { deepEqual } from "@/lib/doc/deepEqual";
import { orderedFieldUuids, orderedFormUuids } from "@/lib/doc/fieldWalk";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	heldPlacementOf,
	holdExpresses,
	type PlacementHoldEntry,
	placementTargetKey,
} from "@/lib/doc/placementHolds";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	CasePlacement,
	Uuid,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	effectiveQueryRepeatPlacement,
	queryRepeatPlacementNeeds,
} from "@/lib/domain/queryRepeatPlacement";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import {
	type RawFormInMenu,
	rawDataPaths,
	rawFormsInOrder,
	recordAt,
	recordsAt,
	stringAt,
} from "./frozen/rawForms";
import type { JsonRecord, RawDocument } from "./oldShape";
import {
	type BlockerPlace,
	type CutoverBlocker,
	compareText,
	type HeldUnit,
	type HoldSource,
	type LiftedFacts,
	type PathMoveCause,
	type PlacementUnit,
	type PlannedChange,
	type PublishedDeployment,
	type TodaysPlacement,
} from "./types";

// ─── Reading a stored baseline (§8.1) ─────────────────────────────────────

/** One `public.app_deployment_baselines` row, as `source.ts` reads it. */
export interface BaselineRow {
	readonly origin: string;
	readonly source_gzip: Uint8Array | null;
	readonly source_digest: string | null;
	readonly observed_at: Date | string;
}

/**
 * A stored baseline as section 8.1 reads it, by the checks
 * `lib/deployment/store.ts::readAppBaseline` makes of the same bytes: the
 * gzip `lib/deployment/service.ts` wrote of the normalized source's
 * canonical text, the SHA-256 of that text in hex, and its JSON. A row that
 * fails any of them was stored as a read of CommCare HQ and no longer
 * verifies, so it is `unreadable` (the blocker `baseline-unreadable`), never
 * read as carrying nothing. Origin `create` is the empty app a first
 * publish makes; `unread`, and no row at all, are unknown.
 */
export function readBaseline(
	row: BaselineRow | null | undefined,
): PublishedDeployment["baseline"] {
	if (row === null || row === undefined)
		return { kind: "unknown", why: "absent" };
	if (row.origin === "unread") return { kind: "unknown", why: "unread" };
	if (row.origin === "create") return { kind: "shell" };
	if (row.origin !== "push" && row.origin !== "cutover")
		throw new Error(
			`A deployment's app baseline has origin "${row.origin}", which the case-writes cutover does not know. Nova writes "create", "push", "cutover" and "unread"; look at the row before running the cutover.`,
		);
	if (row.source_gzip === null || row.source_digest === null)
		return { kind: "unreadable", why: "gunzip" };
	let text: Buffer;
	try {
		text = gunzipSync(row.source_gzip);
	} catch {
		return { kind: "unreadable", why: "gunzip" };
	}
	if (createHash("sha256").update(text).digest("hex") !== row.source_digest)
		return { kind: "unreadable", why: "digest" };
	let source: unknown;
	try {
		source = JSON.parse(text.toString("utf8"));
	} catch {
		return { kind: "unreadable", why: "parse" };
	}
	return {
		kind: "readable",
		source,
		sourceDigest: row.source_digest,
		observedAt:
			typeof row.observed_at === "string"
				? row.observed_at
				: row.observed_at.toISOString(),
	};
}

const publishedForms = new WeakMap<
	PublishedDeployment,
	ReadonlyMap<string, PublishedForm>
>();

/** Every case block a readable baseline carries, by `xmlns`; none for any
 *  other baseline. Read once per deployment. */
export function publishedFormsOf(
	deployment: PublishedDeployment,
): ReadonlyMap<string, PublishedForm> {
	const known = publishedForms.get(deployment);
	if (known !== undefined) return known;
	const forms =
		deployment.baseline.kind === "readable"
			? publishedCaseBlocks(deployment.baseline.source)
			: new Map<string, PublishedForm>();
	publishedForms.set(deployment, forms);
	return forms;
}

/** The form of `formUuid` as `deployment`'s baseline holds it, under the
 *  `xmlns` its identity overrides give the form. */
export function publishedFormOf(
	target: BlueprintDoc,
	deployment: PublishedDeployment,
	formUuid: Uuid,
): PublishedForm | undefined {
	const form = target.forms[formUuid];
	if (form === undefined) return undefined;
	const xmlns = targetWireIdentity(deployment.overrides).formXmlns(form);
	return publishedFormsOf(deployment).get(xmlns);
}

// ─── Identities (§8.3 item 1) ─────────────────────────────────────────────

/** A data path from the instance root, `/data` left out, joined by `/`. */
function relativePath(path: FormPath): string {
	return path
		.segments()
		.slice(1)
		.map((segment) => segment.name)
		.join("/");
}

/** The data path of `repeatUuid`'s row in the target: the repeat's own path,
 *  or its `item` row for a query repeat. */
function targetRowPath(
	target: BlueprintDoc,
	formUuid: Uuid,
	repeatUuid: Uuid,
): string | undefined {
	const path = repeatRowPath(target, formUuid, repeatUuid);
	return path === undefined ? undefined : relativePath(path);
}

/** Where a repeat's rows sit, as a data path, in whichever document a
 *  caller reads paths from; `undefined` for a repeat that document lacks. */
export type RowPaths = (repeatUuid: Uuid) => string | undefined;

/** The target's row paths of `formUuid`. */
export function targetRowPaths(target: BlueprintDoc, formUuid: Uuid): RowPaths {
	return (repeat) => targetRowPath(target, formUuid, repeat);
}

/**
 * The identity of one case block or model-iteration row, in the vocabulary
 * both a baseline and the head's emission are read in:
 *
 * - `own|<case type>` and `usercase`, the basic slots;
 * - `subcase|<index>|<case type>|<repeat row or empty>`, a basic subcase at
 *   `subcase_<index>`, and `subcase-row|<repeat row>|<case type>`, the one
 *   subcase of its repeat, written at the row's own `case`;
 * - `stc|<data path>`, a Save to Case block by every segment of its path
 *   from the data root;
 * - `advanced|<data path>`, an advanced form's load or open action;
 * - `row|<data path>`, a model-iteration repeat's row.
 */
export type BlockIdentity = string;

/** The repeat a bucket unit's key names, `undefined` at the form root. */
function bucketRepeat(unit: PlacementUnit): Uuid | undefined {
	if (!unit.startsWith("child:") && !unit.startsWith("extension:"))
		return undefined;
	const repeat = unit.split(":")[2];
	return repeat === undefined || repeat === "root"
		? undefined
		: (repeat as Uuid);
}

/**
 * A unit's case type and key, as an identity reads them, and the repeat its
 * rows run over where its key names none: an operation unit's `forEach`
 * repeat, which a basic subcase's identity reads once the unit is held
 * there.
 */
export type UnitIdentityFacts = Pick<UnitReading, "unit" | "caseType"> & {
	readonly repeat?: Uuid;
};

/**
 * The identity `placement` names for `reading`, its scope read through
 * `rows`; `undefined` where that scope is not in the document.
 */
export function placementIdentity(
	reading: UnitIdentityFacts,
	placement: TodaysPlacement["placement"],
	rows: RowPaths,
): BlockIdentity | undefined {
	if (placement === "model-iteration") {
		const row = rows(reading.unit.slice("query-repeat:".length) as Uuid);
		return row === undefined ? undefined : `row|${row}`;
	}
	switch (placement.kind) {
		case "basic": {
			const repeat = bucketRepeat(reading.unit) ?? reading.repeat;
			const row = repeat === undefined ? "" : rows(repeat);
			switch (placement.slot) {
				case "own":
					return `own|${reading.caseType}`;
				case "usercase":
					return "usercase";
				case "subcase":
					return row === undefined
						? undefined
						: `subcase|${placement.index}|${reading.caseType}|${row}`;
				case "subcase-row":
					return row === undefined || row === ""
						? undefined
						: `subcase-row|${row}|${reading.caseType}`;
			}
			return undefined;
		}
		case "save-to-case": {
			const scope =
				placement.repeat === undefined ? "" : rows(placement.repeat);
			return scope === undefined
				? undefined
				: `stc|${[...(scope === "" ? [] : [scope]), ...placement.path].join("/")}`;
		}
	}
}

/** The identity a published block is read under. */
export function blockIdentity(block: PublishedCaseBlock): BlockIdentity {
	switch (block.kind) {
		case "basic-own":
			return `own|${block.caseType}`;
		case "basic-usercase":
			return "usercase";
		case "basic-subcase":
			return block.repeatContext !== null && block.path === block.repeatContext
				? `subcase-row|${block.repeatContext}|${block.caseType}`
				: `subcase|${block.index}|${block.caseType}|${block.repeatContext ?? ""}`;
		case "advanced":
			return `advanced|${block.path}`;
		case "save-to-case":
			return `stc|${block.path}`;
	}
}

/**
 * Whether `form` holds a block at `identity`. A Save to Case block is
 * carried where its case type is the unit's, or blank, which is how a block
 * whose type is an expression reads.
 */
function formHolds(
	form: PublishedForm,
	identity: BlockIdentity,
	caseType: string,
): boolean {
	if (identity.startsWith("row|"))
		return form.modelIterationRows.includes(identity.slice("row|".length));
	return form.blocks.some(
		(block) =>
			blockIdentity(block) === identity &&
			(block.kind !== "save-to-case" ||
				block.caseType === null ||
				block.caseType === caseType),
	);
}

// ─── Units (§8.2) ─────────────────────────────────────────────────────────

/** Why a unit is never held (§8.5), or why it has nothing to hold. */
export const UNHELD_CLASSES = [
	/** A create a link carries, of any relationship (part 02 M1). */
	"carried-create",
	/** A unit of a form whose menu is now emitted advanced (part 02 M3). */
	"module-made-advanced",
	/** A basic child `main` numbered past an inert extension subcase, with
	 *  no baseline carrying it at the old index (part 02 M2). */
	"subcase-renumbered",
	/** The own arm of a registration that changes its new case before
	 *  creating it (part 01 C11). */
	"case-changed-before-create",
	/** A query repeat the rule gives the count placement (part 04 Q1). */
	"query-repeat-count",
	/** The own close of a form whose closing operations all held writes
	 *  (part 01 C9): its path stays with the update the writes became. */
	"own-close-moved",
	/** No readable baseline carries it and no published baseline is unknown. */
	"not-carried",
	/** Its writes joined an operation the form already held, which is its own
	 *  unit (`operationsFromFieldWrites` keeps an operation it can join). */
	"merged",
	/** The target holds nothing for it: an operation C10 removed, or a unit of
	 *  a form or question that is gone. */
	"gone",
] as const;
export type UnheldClass = (typeof UNHELD_CLASSES)[number];

/** The cause section 9 names for a unit of each class that moves. */
export function unheldCause(
	unheld: UnheldClass,
	relationship: "child" | "extension" | undefined,
): PathMoveCause {
	switch (unheld) {
		case "carried-create":
			return relationship === "extension"
				? "extension-case-moved"
				: "module-made-advanced";
		case "module-made-advanced":
			return "module-made-advanced";
		case "subcase-renumbered":
			return "subcase-renumbered";
		case "case-changed-before-create":
			return "case-changed-before-create";
		case "query-repeat-count":
			return "repeat-rows-follow-query";
		case "own-close-moved":
			return "own-close-moved";
		case "not-carried":
		case "merged":
		case "gone":
			return "placement-simplified";
	}
}

/** The hold target one unit names in the target document. */
type UnitTarget =
	| {
			readonly target: "case-operation";
			readonly formUuid: Uuid;
			readonly operationUuid: Uuid;
	  }
	| { readonly target: "own-close"; readonly formUuid: Uuid }
	| { readonly target: "query-repeat"; readonly fieldUuid: Uuid };

/** One unit read against the target. */
export interface UnitReading {
	readonly formUuid: Uuid;
	readonly unit: PlacementUnit;
	/** Today's placement, `main`'s; for an own close C9 made, the path of
	 *  the first closing operation it removed. */
	readonly today: TodaysPlacement["placement"];
	/** The case type its block writes: the module's, the worker's record's,
	 *  the bucket's or the operation's. */
	readonly caseType: string;
	/** A create's relationship to the own case, where it has one. */
	readonly relationship?: "child" | "extension";
	/** What it is in the target; absent where the target holds nothing for it. */
	readonly subject?: UnitTarget;
	/** The placement a hold would write: today's, or a renumbered child's
	 *  new index. */
	readonly holdAt?: TodaysPlacement["placement"];
	/** Why it is never held, where it is in a class of §8.5. */
	readonly never?: UnheldClass;
}

/** What the placement step reads beside the target. */
export interface PlacementInput {
	/** The app's carriers as read, for C9's closing operations. */
	readonly raw: RawDocument;
	/** The document every step before this one left. */
	readonly target: BlueprintDoc;
	readonly facts: Pick<LiftedFacts, "todaysPlacements">;
	/** Section 8.1's deployments; empty for an unpublished app. */
	readonly deployments: readonly PublishedDeployment[];
	/** The app's `mutation_seq` at the fleet read, for the frozen check. */
	readonly mutationSeq: number;
	/**
	 * The creates a link carried when step 8 ran, by form, those it
	 * retargeted included: a retarget leaves a create no link carries, and
	 * its Save to Case placement is still never held (§7.6). Absent: read
	 * from the target with `linkCarriedCreates`.
	 */
	readonly carriedCreates?: ReadonlyMap<Uuid, ReadonlySet<Uuid>>;
}

/** C9's closing operations of one form (part 01 §22): `close` operations on
 *  the form's own case in a follow-up or close form. */
export interface ClosingOperations {
	readonly formUuid: Uuid;
	/** Those without writes, which C9 removes, in operation order. */
	readonly removed: readonly Uuid[];
	/** Those holding writes, which C9 makes `update` operations. */
	readonly kept: readonly Uuid[];
}

/** Every form's C9 closing operations, forms in menu order. */
export function closingOperations(raw: RawDocument): ClosingOperations[] {
	const out: ClosingOperations[] = [];
	for (const entry of rawFormsInOrder(raw)) {
		const type = stringAt(entry.form, "type");
		if (type !== "followup" && type !== "close") continue;
		const removed: Uuid[] = [];
		const kept: Uuid[] = [];
		for (const operation of recordsAt(entry.form, "caseOperations")) {
			if (
				stringAt(operation, "action") !== "close" ||
				stringAt(recordAt(operation, "target"), "kind") !== "session"
			)
				continue;
			const uuid = (stringAt(operation, "uuid") ?? "") as Uuid;
			if (recordsAt(operation, "writes").length > 0) kept.push(uuid);
			else removed.push(uuid);
		}
		if (removed.length > 0 || kept.length > 0)
			out.push({ formUuid: entry.formUuid as Uuid, removed, kept });
	}
	return out;
}

function rawOperation(
	entry: RawFormInMenu | undefined,
	operationUuid: string,
): JsonRecord | undefined {
	return recordsAt(entry?.form, "caseOperations").find(
		(operation) => stringAt(operation, "uuid") === operationUuid,
	);
}

/**
 * The operation `operationsFromFieldWrites` made for a field-write unit, or
 * the one the form already held that the bucket joined: the own arm, the
 * update of the worker's record, or the create of the bucket's type in its
 * repeat with a `parent` link of the bucket's relationship.
 */
function bucketOperation(
	unit: PlacementUnit,
	operations: readonly CaseOperation[],
): CaseOperation | undefined {
	if (unit === "own")
		return operations.find((operation) => operation.action === "own");
	if (unit === "usercase")
		return operations.find(
			(operation) =>
				operation.action === "update" &&
				operation.target.kind === "worker-record",
		);
	const [, caseType, repeat] = unit.split(":");
	const relationship = unit.startsWith("extension:") ? "extension" : "child";
	return operations.find(
		(operation) =>
			operation.action === "create" &&
			operation.caseType === caseType &&
			(operation.forEach?.repeat ?? "root") === repeat &&
			(operation.links ?? []).some(
				(link) =>
					link.identifier === "parent" && link.relationship === relationship,
			),
	);
}

/**
 * Every unit of every form, read against the target, in the frozen
 * classifier's order. The classes of §8.5 are decided here, once, so the
 * holds and the deployment lines read one answer.
 */
export function readUnits(input: PlacementInput): readonly UnitReading[] {
	const { raw, target } = input;
	const rawForms = new Map(
		rawFormsInOrder(raw).map((entry) => [entry.formUuid, entry]),
	);
	const closing = new Map(
		closingOperations(raw).map((form) => [form.formUuid, form]),
	);
	const byForm = new Map<Uuid, TodaysPlacement[]>();
	for (const today of input.facts.todaysPlacements.values()) {
		const list = byForm.get(today.formUuid) ?? [];
		list.push(today);
		byForm.set(today.formUuid, list);
	}
	const out: UnitReading[] = [];
	for (const [formUuid, todays] of byForm) {
		const rawEntry = rawForms.get(formUuid);
		const form = target.forms[formUuid];
		const moduleUuid = moduleUuidOfForm(target, formUuid);
		const module =
			moduleUuid === undefined ? undefined : target.modules[moduleUuid];
		const moduleCaseType =
			module?.caseType ?? stringAt(rawEntry?.module, "caseType") ?? "";
		const operations = form?.caseOperations ?? [];
		const advanced =
			form !== undefined &&
			moduleUuid !== undefined &&
			emittedModuleKind(target, moduleUuid) === "advanced";
		const carried =
			form === undefined
				? new Set<Uuid>()
				: (input.carriedCreates?.get(formUuid) ??
					linkCarriedCreates(target, formUuid));
		// The units the stored operations are, so a field-write unit that
		// joined one of them reads as merged into it.
		const storedUnits = new Set(
			todays
				.filter((today) => today.unit.startsWith("operation:"))
				.map((today) => today.unit.slice("operation:".length)),
		);
		// `main`'s index of each extension bucket, from its `nova_subcase_<n>`.
		const extensionIndices = todays.flatMap((today) => {
			if (!today.unit.startsWith("extension:")) return [];
			const placement = today.placement;
			if (placement === "model-iteration" || placement.kind !== "save-to-case")
				return [];
			const last = placement.path[placement.path.length - 1] ?? "";
			const index = Number(last.slice("nova_subcase_".length));
			return last.startsWith("nova_subcase_") && Number.isInteger(index)
				? [index]
				: [];
		});
		const closes = closing.get(formUuid);
		const ownCloseToday = todays.find((today) => today.unit === "own-close");
		// Part 01's C11: the own arm today's emission kept in the basic own
		// slot changes its new case before HQ's open action would create it.
		const ownToday = todays.find((today) => today.unit === "own")?.placement;
		const ownOperation = operations.find(
			(operation) => operation.action === "own",
		);
		const changedBeforeCreate =
			!advanced &&
			ownOperation !== undefined &&
			ownToday !== undefined &&
			ownToday !== "model-iteration" &&
			ownToday.kind === "basic" &&
			ownToday.slot === "own" &&
			placementIneligibility(
				target,
				formUuid,
				{ kind: "operation", operationUuid: ownOperation.uuid },
				ownToday,
			).some(({ reason }) => reason === "case-changed-before-create");

		for (const today of todays) {
			const { unit } = today;
			const base = { formUuid, unit, today: today.placement };
			if (form === undefined) {
				out.push({ ...base, caseType: moduleCaseType, never: "gone" });
				continue;
			}

			// A query repeat.
			if (unit.startsWith("query-repeat:")) {
				const fieldUuid = unit.slice("query-repeat:".length) as Uuid;
				const field = target.fields[fieldUuid];
				const structure = formStructure(target, formUuid);
				const subject = { target: "query-repeat", fieldUuid } as const;
				if (
					field?.kind !== "repeat" ||
					field.repeat_mode !== "query_bound" ||
					structure === undefined
				) {
					out.push({ ...base, caseType: "", never: "gone" });
					continue;
				}
				out.push({
					...base,
					caseType: "",
					subject,
					holdAt: "model-iteration",
					...(queryRepeatPlacementNeeds(structure, fieldUuid).length > 0 && {
						never: "query-repeat-count" as const,
					}),
				});
				continue;
			}

			// The own close `main` wrote apart.
			if (unit === "own-close") {
				out.push({
					...base,
					caseType: moduleCaseType,
					subject: { target: "own-close", formUuid },
					holdAt: today.placement,
					...(advanced && { never: "module-made-advanced" as const }),
				});
				continue;
			}

			// A stored operation.
			if (unit.startsWith("operation:")) {
				const operationUuid = unit.slice("operation:".length) as Uuid;
				const operation = operations.find((op) => op.uuid === operationUuid);
				const stored = rawOperation(rawEntry, operationUuid);
				const caseType =
					operation?.action === "own"
						? moduleCaseType
						: (operation?.caseType ?? stringAt(stored, "caseType") ?? "");
				const relationship = createRelationship(operation);
				if (operation === undefined) {
					// C9 removed it: the own close takes its path, from the first
					// removed operation, where `main` wrote no own close apart.
					const firstRemoved = closes?.removed[0];
					if (
						firstRemoved === operationUuid &&
						ownCloseToday === undefined &&
						today.placement !== "model-iteration" &&
						today.placement.kind === "save-to-case" &&
						today.placement.repeat === undefined
					) {
						out.push({
							...base,
							unit: "own-close",
							caseType: moduleCaseType,
							subject: { target: "own-close", formUuid },
							holdAt: today.placement,
							...(advanced && { never: "module-made-advanced" as const }),
						});
						continue;
					}
					out.push({ ...base, caseType, never: "gone" });
					continue;
				}
				out.push({
					...base,
					caseType,
					...(relationship !== undefined && { relationship }),
					subject: { target: "case-operation", formUuid, operationUuid },
					holdAt: today.placement,
					...(advanced
						? { never: "module-made-advanced" as const }
						: carried.has(operationUuid)
							? { never: "carried-create" as const }
							: {}),
				});
				continue;
			}

			// A field-write unit: the own case, the worker's record, a bucket.
			const operation = bucketOperation(unit, operations);
			const caseType =
				unit === "own"
					? moduleCaseType
					: unit === "usercase"
						? USERCASE_CASE_TYPE
						: (unit.split(":")[1] ?? "");
			const relationship = unit.startsWith("extension:")
				? ("extension" as const)
				: unit.startsWith("child:")
					? ("child" as const)
					: undefined;
			const withRelationship = {
				...base,
				caseType,
				...(relationship !== undefined && { relationship }),
			};
			if (operation === undefined) {
				out.push({ ...withRelationship, never: "gone" });
				continue;
			}
			if (unit !== "own" && storedUnits.has(operation.uuid)) {
				out.push({ ...withRelationship, never: "merged" });
				continue;
			}
			const subject = {
				target: "case-operation",
				formUuid,
				operationUuid: operation.uuid,
			} as const;
			if (advanced) {
				out.push({
					...withRelationship,
					subject,
					holdAt: today.placement,
					never: "module-made-advanced",
				});
				continue;
			}
			if (carried.has(operation.uuid)) {
				out.push({
					...withRelationship,
					subject,
					holdAt: today.placement,
					never: "carried-create",
				});
				continue;
			}
			const placement = today.placement;
			if (
				placement !== "model-iteration" &&
				placement.kind === "basic" &&
				placement.slot === "subcase"
			) {
				const before = extensionIndices.filter(
					(index) => index < placement.index,
				).length;
				if (before > 0) {
					out.push({
						...withRelationship,
						subject,
						holdAt: {
							kind: "basic",
							slot: "subcase",
							index: placement.index - before,
						},
						never: "subcase-renumbered",
					});
					continue;
				}
			}
			// C11's own arm takes Save to Case, and with it every basic slot of
			// its form that needs the own case in Case Management: the form's
			// subcases and the worker's record move with it.
			if (
				changedBeforeCreate &&
				placement !== "model-iteration" &&
				placement.kind === "basic" &&
				(unit === "own" ||
					placementIneligibility(
						target,
						formUuid,
						{ kind: "operation", operationUuid: operation.uuid },
						placement,
					).some(({ reason }) => reason === "own-not-basic"))
			) {
				out.push({
					...withRelationship,
					subject,
					holdAt: placement,
					never: "case-changed-before-create",
				});
				continue;
			}
			out.push({ ...withRelationship, subject, holdAt: placement });
		}
	}
	return out;
}

function createRelationship(
	operation: CaseOperation | undefined,
): "child" | "extension" | undefined {
	if (operation?.action !== "create") return undefined;
	const parent = (operation.links ?? []).find(
		(link) => link.identifier === "parent",
	);
	return parent?.relationship === "extension" ? "extension" : "child";
}

/** The forms whose own close C9 leaves at its simplest placement unheld,
 *  because every closing operation held writes. */
export function ownClosesMoved(raw: RawDocument): ReadonlySet<Uuid> {
	return new Set(
		closingOperations(raw)
			.filter((form) => form.removed.length === 0 && form.kept.length > 0)
			.map((form) => form.formUuid),
	);
}

// ─── Carried (§8.3 item 1) ────────────────────────────────────────────────

/**
 * Whether `form`, a baseline's read of the unit's form, carries a block at
 * `placement`'s identity, its scope read in the target's data paths: a
 * question renamed since the push leaves its unit uncarried.
 */
export function formCarries(
	target: BlueprintDoc,
	reading: UnitIdentityFacts & { readonly formUuid: Uuid },
	placement: TodaysPlacement["placement"],
	form: PublishedForm,
): boolean {
	const identity = placementIdentity(
		reading,
		placement,
		targetRowPaths(target, reading.formUuid),
	);
	return identity !== undefined && formHolds(form, identity, reading.caseType);
}

// ─── What the head writes (§8.4, §9) ──────────────────────────────────────

/**
 * Where the head's emission writes each subject of `formUuid`, by subject
 * key (an operation's uuid, or `own-close`): its Save to Case block from the
 * plan's source blocks, its basic slot from the plan's appended blocks and
 * its subcases, each by the identity a baseline is read in.
 */
function emittedSubjects(
	target: BlueprintDoc,
	formUuid: Uuid,
): ReadonlyMap<string, BlockIdentity> {
	const plan = planFormCaseWire(target, formUuid);
	const out = new Map<string, BlockIdentity>();
	const operations = target.forms[formUuid]?.caseOperations ?? [];
	const moduleUuid = moduleUuidOfForm(target, formUuid);
	const moduleCaseType =
		moduleUuid === undefined
			? ""
			: (target.modules[moduleUuid]?.caseType ?? "");
	for (const block of plan.saveToCase) {
		const scope = relativePath(block.scope);
		out.set(
			block.subject.kind === "own-close"
				? "own-close"
				: block.subject.operationUuid,
			`stc|${[...(scope === "" ? [] : [scope]), ...block.path].join("/")}`,
		);
	}
	if (plan.kind !== "basic") return out;
	const slots = new Set(
		plan.appendedNames.flatMap((name) =>
			name.placement.kind === "basic" ? [name.placement.slot] : [],
		),
	);
	const own = operations.find((operation) => operation.action === "own");
	if (own !== undefined && slots.has("own") && !out.has(own.uuid))
		out.set(own.uuid, `own|${moduleCaseType}`);
	const worker = operations.find(
		(operation) =>
			operation.action === "update" &&
			operation.target.kind === "worker-record",
	);
	if (worker !== undefined && slots.has("usercase") && !out.has(worker.uuid))
		out.set(worker.uuid, "usercase");
	for (const subcase of planBasicSubcases(target, formUuid)) {
		if (subcase.inSource) continue;
		const operation = operations.find(
			(candidate) => candidate.uuid === subcase.operationUuid,
		);
		if (operation?.action !== "create") continue;
		const repeat = operation.forEach?.repeat;
		const row =
			repeat === undefined ? "" : targetRowPath(target, formUuid, repeat);
		if (row === undefined) continue;
		out.set(
			operation.uuid,
			subcase.row
				? `subcase-row|${row}|${operation.caseType}`
				: `subcase|${subcase.index}|${operation.caseType}|${row}`,
		);
	}
	return out;
}

/** Whether the head writes the held `reading` at exactly `placement`'s
 *  identity: the slot and index of a basic one, every segment of a Save to
 *  Case one, model iteration for a query repeat. */
function emitsAt(
	target: BlueprintDoc,
	reading: UnitReading,
	placement: TodaysPlacement["placement"],
): boolean {
	const subject = reading.subject;
	if (subject === undefined) return false;
	if (subject.target === "query-repeat") {
		const structure = formStructure(target, reading.formUuid);
		return (
			structure !== undefined &&
			effectiveQueryRepeatPlacement(structure, subject.fieldUuid) ===
				"model-iteration"
		);
	}
	const operation =
		subject.target === "case-operation"
			? target.forms[reading.formUuid]?.caseOperations?.find(
					(candidate) => candidate.uuid === subject.operationUuid,
				)
			: undefined;
	const expected = placementIdentity(
		{ ...reading, repeat: operation?.forEach?.repeat },
		placement,
		targetRowPaths(target, reading.formUuid),
	);
	if (expected === undefined) return false;
	const key =
		subject.target === "own-close" ? "own-close" : subject.operationUuid;
	return emittedSubjects(target, reading.formUuid).get(key) === expected;
}

const headReads = new WeakMap<
	BlueprintDoc,
	Map<string, ReadonlyMap<string, PublishedForm>>
>();

/**
 * Every case block and model-iteration row the head's HQ import file of
 * `target` writes, by `xmlns` under `deployment`'s identity overrides, read
 * by the reader a baseline is read by (`publishedCaseBlocks`), so the two
 * compare in one vocabulary: the basic and advanced blocks HQ's build makes
 * of each form's actions, and every Save to Case block of its source, the
 * guards beside each operation's block included. Lookup tables are named by
 * their identities, which no block path reads.
 */
export function headFormsOf(
	target: BlueprintDoc,
	deployment: Pick<PublishedDeployment, "overrides">,
): ReadonlyMap<string, PublishedForm> {
	const key = canonicalJsonText(deployment.overrides);
	let byOverrides = headReads.get(target);
	if (byOverrides === undefined) {
		byOverrides = new Map();
		headReads.set(target, byOverrides);
	}
	const known = byOverrides.get(key);
	if (known !== undefined) return known;
	const forms = publishedCaseBlocks(
		expandDoc(target, {
			identity: targetWireIdentity(deployment.overrides),
			lookupNaming: identityLookupWireNaming(),
		}),
	);
	byOverrides.set(key, forms);
	return forms;
}

// ─── The step ─────────────────────────────────────────────────────────────

export interface PlacementCounts {
	/** Held units by target. */
	readonly byTarget: Readonly<Record<HeldUnit["target"], number>>;
	/** Held units by why they are held. */
	readonly bySource: Readonly<Record<HoldSource, number>>;
	/** Units left unheld, by class. */
	readonly unheld: Readonly<Record<UnheldClass, number>>;
	/** Readable deployments pushed at the app's current revision. */
	readonly frozenChecked: number;
	/** Units and blocks on which the frozen classifier and those baselines
	 *  disagree. */
	readonly frozenDisagrees: number;
}

/** One disagreement of §8.6, for `--debug-details`. */
export interface FrozenDisagreement {
	readonly deploymentId: string;
	readonly formUuid: Uuid;
	/** The unit the baseline does not carry, or the block no unit names. */
	readonly side: "unit-not-carried" | "block-unnamed";
	/** The unit key or the block's identity: ids and element names only. */
	readonly what: string;
}

export interface PlacementResult {
	/** The target holding every hold, or the input where nothing is held or a
	 *  blocker stopped the step. */
	readonly target: BlueprintDoc;
	readonly held: readonly HeldUnit[];
	readonly units: readonly UnitReading[];
	readonly changes: readonly PlannedChange[];
	readonly blockers: readonly CutoverBlocker[];
	readonly counts: PlacementCounts;
	readonly frozen: readonly FrozenDisagreement[];
}

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
	return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

/** Each form's holds in document order: its operations in array order, its
 *  own close, then its query repeats in field order, forms in menu order. */
function documentOrder(target: BlueprintDoc): ReadonlyMap<string, number> {
	const order = new Map<string, number>();
	const add = (entry: Parameters<typeof placementTargetKey>[0]) =>
		order.set(placementTargetKey(entry), order.size);
	for (const moduleUuid of target.moduleOrder)
		for (const formUuid of orderedFormUuids(target, moduleUuid)) {
			const form = target.forms[formUuid];
			if (form === undefined) continue;
			for (const operation of form.caseOperations ?? [])
				add({
					target: "case-operation",
					formUuid,
					operationUuid: operation.uuid,
				});
			add({ target: "own-close", formUuid });
			const walk = (parent: Uuid): void => {
				for (const fieldUuid of orderedFieldUuids(target, parent)) {
					add({ target: "query-repeat", fieldUuid });
					walk(fieldUuid);
				}
			};
			walk(formUuid);
		}
	return order;
}

function holdEntry(
	subject: UnitTarget,
	placement: TodaysPlacement["placement"],
): PlacementHoldEntry | undefined {
	switch (subject.target) {
		case "case-operation":
			return placement === "model-iteration"
				? undefined
				: { ...subject, placement: placement as CasePlacement };
		case "own-close":
			return placement !== "model-iteration" &&
				placement.kind === "save-to-case" &&
				placement.repeat === undefined
				? {
						...subject,
						placement: { kind: "save-to-case", path: placement.path },
					}
				: undefined;
		case "query-repeat":
			return placement === "model-iteration"
				? { ...subject, placement: "model-iteration" }
				: undefined;
	}
}

/** A held unit as the `holdPlacements` entry that writes it. */
function holdOf(held: HeldUnit): PlacementHoldEntry {
	switch (held.target) {
		case "case-operation":
			return {
				target: held.target,
				formUuid: held.formUuid,
				operationUuid: held.operationUuid,
				placement: held.placement,
			};
		case "own-close":
			return {
				target: held.target,
				formUuid: held.formUuid,
				placement: held.placement,
			};
		case "query-repeat":
			return {
				target: held.target,
				fieldUuid: held.fieldUuid,
				placement: held.placement,
			};
	}
}

/** A held unit's placement in today's vocabulary, for the verification;
 *  `count` for a query repeat already held at the count placement, which
 *  no baseline reads. */
function heldAsPlacement(
	held: HeldUnit,
): TodaysPlacement["placement"] | "count" | undefined {
	const placement = held.placement;
	if (placement === null) return undefined;
	if (held.target === "query-repeat")
		return placement === "model-iteration" ? "model-iteration" : "count";
	// An advanced action is no placement today's emission gave, so a unit
	// already held at one is not verified here.
	if (typeof placement !== "object" || placement.kind === "advanced")
		return undefined;
	return placement;
}

function blocker(
	code: CutoverBlocker["code"],
	found: readonly { readonly finding: string; readonly place: BlockerPlace }[],
): CutoverBlocker {
	return {
		code,
		count: found.length,
		findingCodes: [...new Set(found.map((one) => one.finding))].sort(
			compareText,
		),
		places: found.map((one) => one.place),
	};
}

/** The form's name, for a blocker's `places` alone. */
function formPlace(
	target: BlueprintDoc,
	formUuid: Uuid,
	message: string,
	findingCode: string,
): BlockerPlace {
	const name = target.forms[formUuid]?.name;
	return {
		entity: {
			kind: "form",
			uuid: formUuid,
			...(name !== undefined && { name }),
		},
		findingCode,
		message,
	};
}

/** The rule a hold that cannot express its target first fails. */
function inexpressibleCode(
	target: BlueprintDoc,
	reading: UnitReading,
	entry: PlacementHoldEntry,
): string {
	if (entry.target === "query-repeat")
		return "HELD_PLACEMENT_INEXPRESSIBLE:query-repeat";
	if (entry.target === "module-kind" || entry.placement === null)
		return "HELD_PLACEMENT_INEXPRESSIBLE";
	const subject: PlacementSubject =
		entry.target === "own-close"
			? { kind: "own-close" }
			: { kind: "operation", operationUuid: entry.operationUuid };
	const [first] = placementIneligibility(
		target,
		reading.formUuid,
		subject,
		entry.placement,
	);
	return first === undefined
		? "HELD_PLACEMENT_INEXPRESSIBLE"
		: `HELD_PLACEMENT_INEXPRESSIBLE:${first.reason}`;
}

/** A raw form's row paths, as `main` wrote them. */
function rawRowPaths(raw: RawDocument, formUuid: Uuid): RowPaths {
	const { repeatBase } = rawDataPaths(raw, formUuid);
	return (repeat) => repeatBase.get(repeat)?.join("/");
}

function rawUnitCaseType(entry: RawFormInMenu, unit: PlacementUnit): string {
	const moduleCaseType = stringAt(entry.module, "caseType") ?? "";
	if (unit === "own" || unit === "own-close") return moduleCaseType;
	if (unit === "usercase") return USERCASE_CASE_TYPE;
	if (unit.startsWith("child:") || unit.startsWith("extension:"))
		return unit.split(":")[1] ?? "";
	if (unit.startsWith("operation:"))
		return (
			stringAt(
				rawOperation(entry, unit.slice("operation:".length)),
				"caseType",
			) ?? ""
		);
	return "";
}

/**
 * The frozen classifier against each readable baseline pushed at the app's
 * current revision, both ways (§8.6): a unit, or one of its guard blocks,
 * the baseline does not carry at today's placement, and a block of the
 * baseline at an identity no unit names. Read in the raw document's paths,
 * since nothing has changed since that push. The inert basic subcase
 * `main` wrote beside each extension's Save to Case block reaches no unit
 * (§8.2), so it is never a block no unit names; neither is a
 * model-iteration row, which only a query repeat unit can name.
 */
function frozenCheck(input: PlacementInput): {
	readonly checked: number;
	readonly disagreements: FrozenDisagreement[];
} {
	const { raw, target } = input;
	const disagreements: FrozenDisagreement[] = [];
	let checked = 0;
	const byForm = new Map<Uuid, TodaysPlacement[]>();
	for (const today of input.facts.todaysPlacements.values()) {
		const list = byForm.get(today.formUuid) ?? [];
		list.push(today);
		byForm.set(today.formUuid, list);
	}
	const rawForms = new Map(
		rawFormsInOrder(raw).map((entry) => [entry.formUuid, entry]),
	);
	for (const deployment of input.deployments) {
		if (
			deployment.baseline.kind !== "readable" ||
			deployment.pushedRevision !== input.mutationSeq
		)
			continue;
		checked++;
		for (const [formUuid, todays] of byForm) {
			const published = publishedFormOf(target, deployment, formUuid);
			const entry = rawForms.get(formUuid);
			if (published === undefined || entry === undefined) continue;
			const rows = rawRowPaths(raw, formUuid);
			const named = new Set<BlockIdentity>();
			for (const today of todays) {
				const reading = {
					unit: today.unit,
					caseType: rawUnitCaseType(entry, today.unit),
				};
				const placements =
					today.placement === "model-iteration"
						? [today.placement]
						: [today.placement, ...today.guards];
				for (const placement of placements) {
					const identity = placementIdentity(reading, placement, rows);
					if (identity !== undefined) named.add(identity);
					if (
						identity === undefined ||
						!formHolds(published, identity, reading.caseType)
					)
						disagreements.push({
							deploymentId: deployment.deploymentId,
							formUuid,
							side: "unit-not-carried",
							what: today.unit,
						});
				}
			}
			for (const block of published.blocks) {
				if (
					block.kind === "basic-subcase" &&
					block.relationship === "extension"
				)
					continue;
				const identity = blockIdentity(block);
				if (!named.has(identity))
					disagreements.push({
						deploymentId: deployment.deploymentId,
						formUuid,
						side: "block-unnamed",
						what: identity,
					});
			}
		}
	}
	return { checked, disagreements };
}

export function placements(input: PlacementInput): PlacementResult {
	const { target, deployments } = input;
	const byTarget = zeroes<HeldUnit["target"]>([
		"case-operation",
		"own-close",
		"query-repeat",
	]);
	const bySource = zeroes<HoldSource>(["carried", "unknown-baseline"]);
	const unheld = zeroes<UnheldClass>(UNHELD_CLASSES);
	const result = (
		fields: Partial<PlacementResult> & {
			readonly frozen?: readonly FrozenDisagreement[];
			readonly checked?: number;
		},
	): PlacementResult => ({
		target: fields.target ?? target,
		held: fields.held ?? [],
		units: fields.units ?? [],
		changes: fields.changes ?? [],
		blockers: fields.blockers ?? [],
		counts: {
			byTarget,
			bySource,
			unheld,
			frozenChecked: fields.checked ?? 0,
			frozenDisagrees: fields.frozen?.length ?? 0,
		},
		frozen: fields.frozen ?? [],
	});

	const unreadable = deployments.filter(
		(deployment) => deployment.baseline.kind === "unreadable",
	);
	if (unreadable.length > 0)
		return result({
			blockers: [
				{
					code: "baseline-unreadable",
					count: unreadable.length,
					findingCodes: [
						...new Set(
							unreadable.map(
								(deployment) =>
									`baseline-unreadable:${(deployment.baseline as { why: string }).why}`,
							),
						),
					].sort(compareText),
					places: unreadable.map((deployment) => ({
						findingCode: `baseline-unreadable:${(deployment.baseline as { why: string }).why}`,
						message: `Deployment ${deployment.deploymentId} on ${deployment.domain} stores an app baseline whose bytes no longer verify. Refresh that deployment so Nova reads CommCare HQ again, then run the dry run again.`,
					})),
				},
			],
		});

	if (deployments.length === 0) return result({});
	const units = readUnits(input);
	const unknown = deployments.some(
		(deployment) => deployment.baseline.kind === "unknown",
	);
	const readable = deployments.filter(
		(deployment) => deployment.baseline.kind === "readable",
	);
	const carriedBy = (reading: UnitReading): boolean =>
		readable.some((deployment) => {
			const form = publishedFormOf(target, deployment, reading.formUuid);
			return (
				form !== undefined && formCarries(target, reading, reading.today, form)
			);
		});

	const holds: {
		readonly held: HeldUnit;
		readonly reading: UnitReading;
		/** False where the target already holds a placement, which it keeps. */
		readonly write: boolean;
	}[] = [];
	const mismatches: { finding: string; place: BlockerPlace }[] = [];
	for (const reading of units) {
		const subject = reading.subject;
		if (subject === undefined || reading.holdAt === undefined) {
			unheld[reading.never ?? "gone"]++;
			continue;
		}
		// A renumbered child is held at its new index only where a baseline
		// carried it at the old one; every other class is never held.
		const carried = carriedBy(reading);
		if (
			reading.never !== undefined &&
			(reading.never !== "subcase-renumbered" || !carried)
		) {
			unheld[reading.never]++;
			continue;
		}
		const source: HoldSource | undefined = carried
			? "carried"
			: unknown
				? "unknown-baseline"
				: undefined;
		if (source === undefined) {
			unheld["not-carried"]++;
			continue;
		}
		// A unit that already holds a placement keeps it, so a second
		// application holds the same and writes nothing.
		const existing = heldPlacementOf(target, subject);
		if (existing !== null) {
			holds.push({
				reading,
				write: false,
				held: {
					...(subject as HeldUnit),
					placement: existing,
					unit: reading.unit,
					source,
				} as HeldUnit,
			});
			continue;
		}
		const entry = holdEntry(subject, reading.holdAt);
		if (entry === undefined || !holdExpresses(target, entry)) {
			mismatches.push({
				finding:
					entry === undefined
						? "HELD_PLACEMENT_INEXPRESSIBLE:shape"
						: inexpressibleCode(target, reading, entry),
				place: formPlace(
					target,
					reading.formUuid,
					`The head cannot keep ${reading.unit} where CommCare HQ holds it.`,
					"placement-path-mismatch",
				),
			});
			continue;
		}
		holds.push({
			reading,
			write: true,
			held: { ...(entry as HeldUnit), unit: reading.unit, source },
		});
	}
	if (mismatches.length > 0)
		return result({
			units,
			blockers: [blocker("placement-path-mismatch", mismatches)],
		});

	const order = documentOrder(target);
	const rank = (held: HeldUnit) =>
		order.get(placementTargetKey(held)) ?? Number.MAX_SAFE_INTEGER;
	holds.sort((a, b) => rank(a.held) - rank(b.held));

	const toWrite = holds.filter(({ write }) => write);
	let next = target;
	const changes: PlannedChange[] = [];
	if (toWrite.length > 0) {
		const mutation: Mutation = {
			kind: "holdPlacements",
			holds: toWrite.map(({ held }) => holdOf(held)),
		};
		const prepared = prepareMutationCandidate(
			target,
			admitMutationBatch([mutation]),
		);
		if (preparedCandidateHasAdmissionIssue(prepared))
			return result({
				units,
				blockers: [
					blocker(
						"transform-admission",
						toWrite.map(({ reading }) => ({
							finding: "holdPlacements",
							place: formPlace(
								target,
								reading.formUuid,
								`The reducer refused the hold of ${reading.unit}.`,
								"holdPlacements",
							),
						})),
					),
				],
			});
		next = prepared.nextDoc;
		for (const { held } of toWrite)
			changes.push({
				step: "placements",
				kind: `hold-${held.target}`,
				entityUuid:
					held.target === "query-repeat" ? held.fieldUuid : held.formUuid,
				detail: {},
			});
	}

	// The verification: the head writes each held unit at exactly its
	// identity, the slot and index of a basic one, every segment of a Save
	// to Case one.
	const differs: { finding: string; place: BlockerPlace }[] = [];
	for (const { reading, held } of holds) {
		const at = heldAsPlacement(held);
		if (
			!deepEqual(heldPlacementOf(next, held), held.placement) ||
			(at !== "count" && (at === undefined || !emitsAt(next, reading, at)))
		)
			differs.push({
				finding: `EMISSION_DIFFERS:${held.target}`,
				place: formPlace(
					next,
					reading.formUuid,
					`The head's emission does not write ${reading.unit} where it is held.`,
					"placement-path-mismatch",
				),
			});
	}
	if (differs.length > 0)
		return result({
			units,
			blockers: [blocker("placement-path-mismatch", differs)],
		});

	for (const { held } of holds) {
		byTarget[held.target]++;
		bySource[held.source]++;
	}
	const frozen = frozenCheck(input);
	return result({
		target: next,
		held: holds.map(({ held }) => held),
		units,
		changes,
		frozen: frozen.disagreements,
		checked: frozen.checked,
	});
}
