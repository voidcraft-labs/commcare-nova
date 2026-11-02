/**
 * Where CommCare HQ keeps each case change of a form: a slot of the form's
 * Case Management settings (a basic slot) or a Save to Case block in the
 * form's source. The placement decides wire facts, so it lives here, and
 * every emitter reads it through `casePlacementPlan.ts::planFormCaseWire`.
 *
 * A form's subjects are its case operations and, where it cannot share the
 * own arm's place, its own close. Each subject keeps a held placement
 * (`CaseOperation.placement`, `Form.ownClosePlacement`) while that placement
 * still expresses it, and otherwise takes the first eligible of a basic slot
 * and a Save to Case block, in the form's operation order. Which of the own
 * arm and the creates take a basic slot is the domain's one answer
 * (`lib/domain/basicCaseSlots.ts::basicCaseSlots`), which the entry's
 * session values read too; this module adds the worker's record, the closes
 * and every Save to Case path. Save to Case is always eligible, so every
 * operation has a place.
 *
 * Pure, and memoized per document object (documents are replaced, never
 * changed in place) and per options, as `planGeneratedNodes` is.
 */

import type {
	BlueprintDoc,
	CaseOperation,
	CasePlacement,
	PlacementIneligibility,
	SaveToCasePlacement,
	Uuid,
} from "@/lib/domain";
import {
	basicCaseSlots,
	type CaseSlotFacts,
	type ConditionScope,
	caseSlotFacts,
	isWorkerRecordUpdate,
	ownSlotReasons,
	type PlannedBasicSubcase,
	type StatedCondition,
	SUBJECT_CANNOT_HOLD,
	stateCondition,
	subcaseReasons,
	usercaseSlotReasons,
} from "@/lib/domain/basicCaseSlots";
import type { Expression } from "@/lib/domain/expression/types";
import { collectFieldLocations, saveToCaseBlockShape } from "./xform/caseOps";
import { descendFormPathIntoField, FormPath } from "./xform/formPath";
import { planGeneratedNodes } from "./xform/generatedNodes";

export type {
	PlannedBasicSubcase,
	StatedCondition,
} from "@/lib/domain/basicCaseSlots";

/** One thing of a form that takes a place: an operation, or the own close. */
export type PlacementSubject =
	| { readonly kind: "operation"; readonly operationUuid: Uuid }
	| { readonly kind: "own-close" };

/** A subject's key in `FormPlacements.placements`. */
export type PlacementSubjectKey = Uuid | "own-close";

export function placementSubjectKey(
	subject: PlacementSubject,
): PlacementSubjectKey {
	return subject.kind === "own-close" ? "own-close" : subject.operationUuid;
}

export interface PlannedPlacement {
	readonly placement: CasePlacement;
	/** The subject's stored placement, kept because it still expresses it. */
	readonly held: boolean;
	/** A close sharing another operation's place: a basic subcase's
	 *  `close_condition`, or the own close written in the own arm's place. */
	readonly sharesWith?: Uuid;
}

export interface FormPlacements {
	/** Every form is a basic form until advanced modules are emitted. */
	readonly formKind: "basic";
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
}

export interface PlanPlacementsOptions {
	/** Fixes the form kind. Only `basic` exists until advanced modules are
	 *  emitted. */
	readonly moduleKind?: "basic";
	/** Operations kept out of every basic slot. */
	readonly excludeBasic?: ReadonlySet<Uuid>;
}

/** The row path of `repeatUuid` in its form: the scope a block placed in
 *  the repeat stands in. */
export function repeatRowPath(
	doc: BlueprintDoc,
	formUuid: Uuid,
	repeatUuid: Uuid,
): FormPath | undefined {
	const location = collectFieldLocations(doc, formUuid).get(repeatUuid);
	const field = doc.fields[repeatUuid];
	if (location === undefined || field?.kind !== "repeat") return undefined;
	return descendFormPathIntoField(field, location.path);
}

/**
 * What Case Management states for `condition` at the subject `scope`, or
 * `undefined` for an unconditional one. Throws where the condition is not
 * stateable; the plan reads it only for a placement it chose by it.
 */
export function statedCondition(
	doc: BlueprintDoc,
	formUuid: Uuid,
	condition: Expression | undefined,
	scope: ConditionScope,
): StatedCondition | undefined {
	const result = stateCondition(caseSlotFacts(doc, formUuid), condition, scope);
	if (result.reasons.length > 0)
		throw new Error(
			`Nova placed a condition of form ${formUuid} in Case Management, which cannot state it (${result.reasons.join(", ")}). The placement and the plan of the form's case changes must agree.`,
		);
	return result.stated;
}

function saveToCaseReasons(
	f: CaseSlotFacts,
	subject: PlacementSubject,
	placement: SaveToCasePlacement,
): PlacementIneligibility[] {
	const operation =
		subject.kind === "operation"
			? f.operations.find((op) => op.uuid === subject.operationUuid)
			: undefined;
	const reasons: PlacementIneligibility[] = [];
	const writes = operation?.writes ?? [];
	if (writes.some((write) => write.onlyIfChanged === true))
		reasons.push({ reason: "only-if-changed" });
	if (writes.some((write) => write.via !== undefined))
		reasons.push({ reason: "via" });
	if (placement.repeat !== operation?.forEach?.repeat)
		reasons.push({ reason: "scope" });
	if (
		placement.path.length !==
		saveToCaseBlockShape(f.doc, f.formUuid, subject).length
	)
		reasons.push({ reason: "block-shape" });
	return reasons;
}

// ── The procedure ───────────────────────────────────────────────────────

interface CorePlan {
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
	readonly subcases: readonly PlannedBasicSubcase[];
	readonly ownBasic: boolean;
	readonly sharers: ReadonlyMap<Uuid, CaseOperation>;
}

interface CoreOptions {
	readonly exclude: ReadonlySet<Uuid>;
	/** Plans this operation in a basic subcase slot where it is eligible,
	 *  whatever the exclusions say. */
	readonly forceBasic?: Uuid;
}

function planCore(f: CaseSlotFacts, options: CoreOptions): CorePlan {
	const placements = new Map<PlacementSubjectKey, PlannedPlacement>();
	const nodes = planGeneratedNodes(f.doc, f.formUuid);
	const slots = basicCaseSlots(f.doc, f.formUuid, {
		exclude: options.exclude,
		...(options.forceBasic !== undefined && {
			forceBasic: options.forceBasic,
		}),
	});
	const excluded = (uuid: Uuid) =>
		options.forceBasic !== uuid && options.exclude.has(uuid);
	const derivedPath = (subject: PlacementSubject): SaveToCasePlacement =>
		derivedSaveToCase(f, subject, nodes);
	const keepSaveToCase = (
		subject: PlacementSubject,
		held: CasePlacement | undefined,
	): PlannedPlacement | undefined =>
		held?.kind === "save-to-case" &&
		saveToCaseReasons(f, subject, held).length === 0
			? { placement: held, held: true }
			: undefined;
	const asSubject = (op: CaseOperation): PlacementSubject => ({
		kind: "operation",
		operationUuid: op.uuid,
	});
	/** The own arm's or a create's Save to Case place: its held block, or
	 *  the one the allocator gives it. */
	const saveToCaseOf = (op: CaseOperation, held: boolean): PlannedPlacement =>
		held && op.placement?.kind === "save-to-case"
			? { placement: op.placement, held: true }
			: { placement: derivedPath(asSubject(op)), held: false };

	// The own arm and the worker's record take their slots first: each slot
	// has one subject, and the subcases read whether the own arm is basic.
	let usercaseTaken = false;
	for (const op of f.operations) {
		if (op.action === "own") {
			const choice = slots.own;
			placements.set(
				op.uuid,
				choice?.kind === "basic"
					? { placement: { kind: "basic", slot: "own" }, held: choice.held }
					: saveToCaseOf(op, choice?.held === true),
			);
		} else if (isWorkerRecordUpdate(op)) {
			const eligible =
				!usercaseTaken && usercaseSlotReasons(f, op).length === 0;
			const kept =
				op.placement?.kind === "basic" && op.placement.slot === "usercase"
					? eligible
						? { placement: op.placement, held: true }
						: undefined
					: keepSaveToCase(asSubject(op), op.placement);
			const planned =
				kept ??
				(!excluded(op.uuid) && eligible
					? {
							placement: { kind: "basic", slot: "usercase" } as const,
							held: false,
						}
					: { placement: derivedPath(asSubject(op)), held: false });
			placements.set(op.uuid, planned);
			if (planned.placement.kind === "basic") usercaseTaken = true;
		}
	}

	// Creates: the domain's choice, each basic subcase at its slot.
	const { subcases, sharers, ownBasic } = slots;
	const subcaseByUuid = new Map(subcases.map((s) => [s.operationUuid, s]));
	for (const op of f.operations) {
		if (op.action !== "create") continue;
		const choice = slots.creates.get(op.uuid);
		const subcase = subcaseByUuid.get(op.uuid);
		if (choice?.kind === "basic" && subcase !== undefined) {
			if (subcase.inSource) {
				const scope =
					op.forEach === undefined
						? FormPath.root()
						: (repeatRowPath(f.doc, f.formUuid, op.forEach.repeat) ??
							FormPath.root());
				// In a several-case form the block runs once per selected case,
				// in the selected-case row's operations group, named in the
				// operations namespace of its authored scope.
				const path: SaveToCasePlacement["path"] = f.severalCases
					? [
							nodes.selectedCases(scope),
							"item",
							nodes.operations(
								scope.child(nodes.selectedCases(scope)).child("item"),
							),
							nodes.subcase(subcase.index, scope),
						]
					: [nodes.subcases(scope), nodes.subcase(subcase.index)];
				placements.set(op.uuid, {
					placement: {
						kind: "save-to-case",
						...(op.forEach !== undefined && { repeat: op.forEach.repeat }),
						path,
					},
					held: false,
				});
			} else {
				const placement: CasePlacement = subcase.row
					? { kind: "basic", slot: "subcase-row" }
					: { kind: "basic", slot: "subcase", index: subcase.index };
				placements.set(op.uuid, { placement, held: choice.held });
			}
		} else {
			placements.set(op.uuid, saveToCaseOf(op, choice?.held === true));
		}
	}

	// Every other operation: a close sharing a basic subcase, else its own
	// Save to Case block.
	const sharedBy = new Map<Uuid, Uuid>();
	for (const [createUuid, close] of sharers)
		sharedBy.set(close.uuid, createUuid);
	for (const op of f.operations) {
		if (placements.has(op.uuid)) continue;
		const createUuid = sharedBy.get(op.uuid);
		const shared =
			createUuid === undefined ? undefined : placements.get(createUuid);
		const subcase =
			createUuid === undefined ? undefined : subcaseByUuid.get(createUuid);
		if (
			createUuid !== undefined &&
			shared !== undefined &&
			shared.placement.kind === "basic" &&
			subcase !== undefined &&
			!subcase.inSource
		) {
			placements.set(op.uuid, {
				placement: shared.placement,
				held:
					op.placement !== undefined &&
					samePlacement(op.placement, shared.placement),
				sharesWith: createUuid,
			});
			continue;
		}
		placements.set(
			op.uuid,
			keepSaveToCase(asSubject(op), op.placement) ?? {
				placement: derivedPath(asSubject(op)),
				held: false,
			},
		);
	}

	// The own close (§12.6): its own held block first; else the own arm's
	// place where that place can carry it; else a close-only block.
	if (f.closesOwn && f.own !== undefined) {
		const ownCloseSubject: PlacementSubject = { kind: "own-close" };
		const held = f.form.ownClosePlacement;
		const ownPlanned = placements.get(f.own.uuid);
		const keptHeld =
			held === undefined
				? undefined
				: ownCloseReasons(f, { kind: "save-to-case", path: held.path })
							.length === 0
					? {
							placement: { kind: "save-to-case", path: held.path } as const,
							held: true,
						}
					: undefined;
		const shares =
			ownPlanned !== undefined &&
			(ownPlanned.placement.kind === "basic"
				? stateCondition(f, f.form.closeCondition, {
						own: true,
						repeat: undefined,
					}).reasons.length === 0
				: !f.severalCases);
		placements.set(
			"own-close",
			keptHeld ??
				(shares && ownPlanned !== undefined && f.own !== undefined
					? {
							placement: ownPlanned.placement,
							held: false,
							sharesWith: f.own.uuid,
						}
					: { placement: derivedPath(ownCloseSubject), held: false }),
		);
	}
	return { placements, subcases, ownBasic, sharers };
}

function ownCloseReasons(
	f: CaseSlotFacts,
	placement: CasePlacement,
): PlacementIneligibility[] {
	if (!f.closesOwn) return [{ reason: "no-close" }];
	if (placement.kind !== "save-to-case") return [SUBJECT_CANNOT_HOLD];
	return saveToCaseReasons(f, { kind: "own-close" }, placement);
}

function samePlacement(a: CasePlacement, b: CasePlacement): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The Save to Case place today's allocator gives a subject: the wrappers of
 * `saveToCaseBlockShape`, each named by `planGeneratedNodes` (which has
 * reserved every held path's segment first), and the block named by the
 * operation's id.
 */
function derivedSaveToCase(
	f: CaseSlotFacts,
	subject: PlacementSubject,
	nodes: ReturnType<typeof planGeneratedNodes>,
): SaveToCasePlacement {
	const operation =
		subject.kind === "operation"
			? f.operations.find((op) => op.uuid === subject.operationUuid)
			: undefined;
	const repeat = operation?.forEach?.repeat;
	let scope =
		repeat === undefined
			? FormPath.root()
			: (repeatRowPath(f.doc, f.formUuid, repeat) ?? FormPath.root());
	const authoredScope = scope;
	const segments: string[] = [];
	for (const segment of saveToCaseBlockShape(f.doc, f.formUuid, subject)) {
		let name: string;
		switch (segment) {
			case "selected-cases":
				name = nodes.selectedCases(authoredScope);
				break;
			case "selected-case":
				name = "item";
				break;
			case "operations":
				name = nodes.operations(scope);
				break;
			case "keyed":
				if (subject.kind !== "operation")
					throw new Error(
						`Nova gave the own close of form ${f.formUuid} a keyed row. Only a create keyed by an answer stands in one.`,
					);
				name = nodes.keyed(subject.operationUuid);
				break;
			case "condition":
				name =
					subject.kind === "own-close"
						? nodes.conditionClose()
						: operation?.action === "own"
							? nodes.conditionUpdateSelectedCases()
							: nodes.condition(subject.operationUuid);
				break;
			case "block":
				name =
					subject.kind === "own-close"
						? f.severalCases
							? nodes.closeSelectedCases()
							: nodes.close()
						: operation?.action === "own" && f.severalCases
							? nodes.updateSelectedCases()
							: (operation?.id ?? "");
				break;
		}
		segments.push(name);
		scope = scope.child(name);
	}
	const [first, ...rest] = segments;
	if (first === undefined)
		throw new Error(
			`Nova found no Save to Case path for a case change of form ${f.formUuid}. Every block stands in an operations group, so its path has at least two segments.`,
		);
	return {
		kind: "save-to-case",
		...(repeat !== undefined && subject.kind === "operation" && { repeat }),
		path: [first, ...rest],
	};
}

// ── The readers ─────────────────────────────────────────────────────────

const plans = new WeakMap<BlueprintDoc, Map<string, CorePlan>>();

function corePlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options: PlanPlacementsOptions | undefined,
	forceBasic?: Uuid,
): CorePlan {
	const exclude = [...(options?.excludeBasic ?? [])].sort();
	const key = `${formUuid}\u0000${options?.moduleKind ?? "basic"}\u0000${exclude.join(",")}\u0000${forceBasic ?? ""}`;
	let forms = plans.get(doc);
	if (forms === undefined) {
		forms = new Map();
		plans.set(doc, forms);
	}
	const known = forms.get(key);
	if (known !== undefined) return known;
	const plan = planCore(caseSlotFacts(doc, formUuid), {
		exclude: new Set(exclude),
		...(forceBasic !== undefined && { forceBasic }),
	});
	forms.set(key, plan);
	return plan;
}

/** Where each case change of `formUuid` is kept in CommCare HQ. */
export function planPlacements(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options?: PlanPlacementsOptions,
): FormPlacements {
	return {
		formKind: "basic",
		placements: corePlan(doc, formUuid, options).placements,
	};
}

/**
 * Whether a basic action carries the operation `operationUuid` of `formUuid`,
 * or the own case's change, wherever it is placed: the questions such an
 * action reads a case name or an external id from take the trimmed sibling
 * (`lib/domain/caseScalarTextGuard.ts`), where any other Save to Case block
 * trims and checks its own values.
 */
export function placedBasic(
	doc: BlueprintDoc,
	formUuid: Uuid,
): (operationUuid: Uuid) => boolean {
	const { placements } = planPlacements(doc, formUuid);
	// An inert subcase (an extension child, or a child of a several-case
	// form) keeps its place in `subcases` while its create is a block in the
	// source, so its action still names the question's trimmed sibling, as
	// the own case's change does in a several-case form, whose wrapper per
	// selected case reads it.
	const subcases = new Set(
		planBasicSubcases(doc, formUuid).map((subcase) => subcase.operationUuid),
	);
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation) => operation.action === "own",
	)?.uuid;
	return (operationUuid) =>
		operationUuid === own ||
		placements.get(operationUuid)?.placement.kind === "basic" ||
		subcases.has(operationUuid);
}

/** The basic subcases of `formUuid`, in `subcases` index order. */
export function planBasicSubcases(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly PlannedBasicSubcase[] {
	return corePlan(doc, formUuid, undefined).subcases;
}

const appPlans = new WeakMap<BlueprintDoc, ReadonlyMap<Uuid, FormPlacements>>();

/** Every form's placements, in module and form order. */
export function appPlacements(
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, FormPlacements> {
	const known = appPlans.get(doc);
	if (known !== undefined) return known;
	const all = new Map<Uuid, FormPlacements>();
	for (const moduleUuid of doc.moduleOrder)
		for (const formUuid of doc.formOrder[moduleUuid] ?? [])
			if (doc.forms[formUuid] !== undefined)
				all.set(formUuid, planPlacements(doc, formUuid));
	appPlans.set(doc, all);
	return all;
}

/**
 * Why `placement` cannot express `subject` on the document as it stands,
 * every failed condition in table order; empty when it can.
 */
export function placementIneligibility(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
	placement: CasePlacement,
): readonly PlacementIneligibility[] {
	const f = caseSlotFacts(doc, formUuid);
	if (subject.kind === "own-close") return ownCloseReasons(f, placement);
	const operation = f.operations.find(
		(op) => op.uuid === subject.operationUuid,
	);
	if (operation === undefined)
		throw new Error(
			`Nova was asked where the case change ${subject.operationUuid} of form ${formUuid} can be kept, and the form holds no such change.`,
		);
	if (placement.kind === "save-to-case")
		return saveToCaseReasons(f, subject, placement);
	switch (placement.slot) {
		case "own":
			return ownSlotReasons(f, operation);
		case "usercase": {
			const reasons = usercaseSlotReasons(f, operation);
			const first = f.operations.find(isWorkerRecordUpdate);
			return first !== undefined && first.uuid !== operation.uuid
				? [...reasons, SUBJECT_CANNOT_HOLD]
				: reasons;
		}
		case "subcase":
		case "subcase-row": {
			const plan = corePlan(doc, formUuid, undefined);
			const reasons = subcaseReasons(
				f,
				operation,
				{ ownBasic: plan.ownBasic, sharers: plan.sharers },
				"child",
			);
			if (reasons.some((r) => r.reason === "scope")) return reasons;
			const others = plan.subcases.filter(
				(s) => s.operationUuid !== operation.uuid,
			);
			const k = others.length + 1;
			const repeat = operation.forEach?.repeat;
			const inRepeat =
				repeat === undefined
					? 0
					: others.filter(
							(s) =>
								f.operations.find((op) => op.uuid === s.operationUuid)?.forEach
									?.repeat === repeat,
						).length + 1;
			const row = inRepeat === 1;
			if (placement.slot === "subcase") {
				const claimed = others.some((s) => {
					const held = f.operations.find(
						(op) => op.uuid === s.operationUuid,
					)?.placement;
					return (
						held?.kind === "basic" &&
						held.slot === "subcase" &&
						held.index === placement.index &&
						s.index === placement.index
					);
				});
				if (placement.index >= k || claimed)
					reasons.push({ reason: "subcase-index" });
				if (row) reasons.push({ reason: "subcase-nesting" });
			} else if (!row) reasons.push({ reason: "subcase-nesting" });
			return reasons;
		}
	}
}

export function placementExpresses(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
	placement: CasePlacement,
): boolean {
	return placementIneligibility(doc, formUuid, subject, placement).length === 0;
}

/**
 * The placements eligible for `subject` on the document as it stands,
 * simplest first: a basic slot, then Save to Case, each with the index or
 * path the procedure would give it.
 */
export function placementCandidates(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
): readonly CasePlacement[] {
	const f = caseSlotFacts(doc, formUuid);
	const plan = corePlan(doc, formUuid, undefined);
	const nodes = planGeneratedNodes(doc, formUuid);
	if (subject.kind === "own-close") {
		if (!f.closesOwn || f.own === undefined) return [];
		const planned = plan.placements.get("own-close");
		return [
			planned !== undefined && planned.sharesWith === undefined
				? planned.placement
				: derivedSaveToCase(f, subject, nodes),
		];
	}
	const operation = f.operations.find(
		(op) => op.uuid === subject.operationUuid,
	);
	const planned = plan.placements.get(subject.operationUuid);
	if (operation === undefined || planned === undefined) return [];
	const saveToCase =
		planned.placement.kind === "save-to-case"
			? planned.placement
			: derivedSaveToCase(f, subject, nodes);
	const basic: CasePlacement[] = [];
	if (operation.action === "own" && ownSlotReasons(f, operation).length === 0)
		basic.push({ kind: "basic", slot: "own" });
	if (
		isWorkerRecordUpdate(operation) &&
		f.operations.find(isWorkerRecordUpdate)?.uuid === operation.uuid &&
		usercaseSlotReasons(f, operation).length === 0
	)
		basic.push({ kind: "basic", slot: "usercase" });
	if (operation.action === "create") {
		if (planned.placement.kind === "basic") basic.push(planned.placement);
		else if (
			subcaseReasons(
				f,
				operation,
				{ ownBasic: plan.ownBasic, sharers: plan.sharers },
				"child",
			).length === 0
		) {
			const forced = corePlan(
				doc,
				formUuid,
				undefined,
				operation.uuid,
			).placements.get(operation.uuid);
			if (forced?.placement.kind === "basic") basic.push(forced.placement);
		}
	}
	return [...basic, saveToCase];
}
