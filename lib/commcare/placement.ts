/**
 * Where CommCare HQ keeps each case change of a form: a slot of the form's
 * Case Management settings (a basic slot), a load or an open action of an
 * advanced form's case actions, or a Save to Case block in the form's
 * source. The placement decides wire facts, so it lives here, and every
 * emitter reads it through `casePlacementPlan.ts::planFormCaseWire`.
 *
 * A form's kind is its menu's (`moduleKind.ts::emittedModuleKind`): a form
 * of a basic menu tries a basic slot, a form of an advanced menu an
 * advanced action (`advancedPlacement.ts`), and each falls back to Save to
 * Case. A form's subjects are its case operations and, where it cannot
 * share the own arm's place, its own close. Each subject keeps a held
 * placement (`CaseOperation.placement`, `Form.ownClosePlacement`) while that
 * placement still expresses it, and otherwise takes the first eligible
 * place, in the form's operation order. Which of the own arm and the creates
 * take a basic slot is the domain's one answer
 * (`lib/domain/basicCaseSlots.ts::basicCaseSlots`), which the entry's
 * session values read too; this module adds the worker's record, the
 * closes, the advanced actions and every Save to Case path. Save to Case is
 * always eligible, so every operation has a place.
 *
 * A create an after-submit link carries into another form
 * (`lib/domain/advancedEntryDatums.ts::carriedCreates`) needs a session datum, which
 * a Save to Case block never gives it, so a held block no longer expresses
 * it (`carried-create`).
 *
 * Pure, and memoized per document object (documents are replaced, never
 * changed in place) and per options, as `planGeneratedNodes` is.
 */

import {
	type AdvancedPlacement,
	type BlueprintDoc,
	type CaseOperation,
	type CasePlacement,
	formConnectIds,
	type PlacementIneligibility,
	type SaveToCasePlacement,
	type Uuid,
} from "@/lib/domain";
import {
	type AdvancedLoadRef,
	advancedLoadChain,
	advancedLoadOf,
	carriedCreates,
	loadClause,
	openActionClause,
	opensCase,
} from "@/lib/domain/advancedEntryDatums";
import {
	appendedNameTaken,
	basicCaseSlots,
	type CaseSlotFacts,
	type ConditionScope,
	caseSlotFacts,
	isWorkerRecordUpdate,
	ownSlotReasons,
	type PlannedBasicSubcase,
	type StatedCondition,
	SUBJECT_CANNOT_HOLD,
	sameTypeExclusions,
	sharingCloses,
	stateCondition,
	subcaseReasons,
	USERCASE_BLOCK_NAME,
	usercaseSlotReasons,
} from "@/lib/domain/basicCaseSlots";
import type { Expression } from "@/lib/domain/expression/types";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { openActionViewBefore } from "./advancedPlacement";
import type { PlannedLoad } from "./advancedSelections";
import { allocateAdvancedTags } from "./advancedTags";
import { emittedModuleKind } from "./moduleKind";
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
	/** A subject sharing another operation's place: a close as a basic
	 *  subcase's or an open action's `close_condition`, the own close written
	 *  in the own arm's place, or a later change of a case an advanced load
	 *  already carries a change of, which names the first. */
	readonly sharesWith?: Uuid;
}

/**
 * A subject whose stored placement no longer expresses it. The plan places
 * it as if unheld, so every emitter still gets a total answer; the gate
 * refuses the document (`HELD_PLACEMENT_INEXPRESSIBLE`), and the move
 * planner states where it goes.
 */
export interface InexpressibleHold {
	readonly subject: PlacementSubject;
	readonly held: CasePlacement;
	/** Every failed condition, the first in table order first. */
	readonly reasons: readonly [
		PlacementIneligibility,
		...PlacementIneligibility[],
	];
}

/** One open action of an advanced form, in `open_cases` order. */
export interface PlannedOpenAction {
	readonly tag: string;
	/** The create, or the registration's own arm. */
	readonly operationUuid: Uuid;
	readonly caseType: string;
	/** The `forEach` repeat it runs in; absent at the form root. */
	readonly repeat?: Uuid;
	/** Written at its repeat row's own `case`: the repeat holds fewer than
	 *  two open actions with indices (`xform.py::get_action_path`). */
	readonly row: boolean;
}

/** An advanced form's actions, each by the tag its placements hold. */
export interface AdvancedFormActionsPlan {
	readonly loads: readonly PlannedLoad[];
	readonly opens: readonly PlannedOpenAction[];
}

export interface FormPlacements {
	/** The form's kind, its menu's unless the options fix it. */
	readonly formKind: "basic" | "advanced";
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
	/** An advanced form's loads and open actions. */
	readonly advanced?: AdvancedFormActionsPlan;
	/** Every held subject the plan could not keep where it is held, in the
	 *  form's subject order: its operations, then its own close. */
	readonly inexpressible: readonly InexpressibleHold[];
}

export interface PlanPlacementsOptions {
	/** Fixes the form kind, so `moduleKind.ts::emittedModuleKind` can ask
	 *  what a basic form would give without asking itself. Absent: the
	 *  kind its menu is emitted as. */
	readonly moduleKind?: "basic" | "advanced";
	/** Operations kept out of every basic slot and every advanced action,
	 *  besides the unheld creates of the menu's own case type, which always
	 *  are. */
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
	readonly formKind: "basic" | "advanced";
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
	readonly subcases: readonly PlannedBasicSubcase[];
	readonly ownBasic: boolean;
	readonly sharers: ReadonlyMap<Uuid, CaseOperation>;
	readonly advanced?: AdvancedFormActionsPlan;
	/** An advanced form's action tags, each with the operation whose hold
	 *  gave it, where one did. */
	readonly advancedTags?: ReadonlyMap<string, Uuid | undefined>;
}

interface CoreOptions {
	readonly exclude: ReadonlySet<Uuid>;
	/** Plans this operation in a basic subcase slot where it is eligible,
	 *  whatever the exclusions say. */
	readonly forceBasic?: Uuid;
	/** The creates an after-submit link carries into another form. */
	readonly carried: ReadonlySet<Uuid>;
}

function planCore(f: CaseSlotFacts, options: CoreOptions): CorePlan {
	const placements = new Map<PlacementSubjectKey, PlannedPlacement>();
	const nodes = planGeneratedNodes(f.doc, f.formUuid);
	const slots = basicCaseSlots(f.doc, f.formUuid, {
		exclude: options.exclude,
		carried: options.carried,
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
			// An unheld update takes the slot only where no author's name
			// stands at the `commcare_usercase` HQ's build appends; a held
			// one keeps it, and the gate refuses the name.
			const planned =
				kept ??
				(!excluded(op.uuid) &&
				eligible &&
				!appendedNameTaken(f, USERCASE_BLOCK_NAME, undefined)
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
				// The block runs once per selected case, in the selected-case
				// row's operations group, named in the operations namespace of
				// its authored scope.
				const path: SaveToCasePlacement["path"] = [
					nodes.selectedCases(scope),
					"item",
					nodes.operations(
						scope.child(nodes.selectedCases(scope)).child("item"),
					),
					nodes.subcase(subcase.index, scope),
				];
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
	return { formKind: "basic", placements, subcases, ownBasic, sharers };
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

// ── The advanced procedure ──────────────────────────────────────────────

/** Where an advanced form's change stands: a load or an open action, by
 *  position. */
type AdvancedSlot =
	| { readonly kind: "load"; readonly index: number }
	| { readonly kind: "open"; readonly index: number };

interface ActionState {
	/** The tag a kept hold gives the action. */
	held?: string;
	/** The first change placed on the action. */
	first?: Uuid;
}

/**
 * Every element name of the form's data root a case block HQ appends must
 * not take (`case_<tag>`): its root questions' ids, its root Connect block
 * ids and the first segment of every held Save to Case path at the root.
 * Nova's generated names all start `nova_`, so none is a `case_` name.
 */
function advancedRootNames(f: CaseSlotFacts): ReadonlySet<string> {
	const names = new Set<string>(formConnectIds(f.doc, f.formUuid));
	for (const uuid of f.doc.fieldOrder[f.formUuid] ?? []) {
		const field = f.doc.fields[uuid];
		if (field !== undefined) names.add(field.id);
	}
	for (const op of f.operations)
		if (
			op.placement?.kind === "save-to-case" &&
			op.placement.repeat === undefined
		)
			names.add(op.placement.path[0]);
	const ownClose = f.form.ownClosePlacement;
	if (ownClose !== undefined) names.add(ownClose.path[0]);
	return names;
}

/** Every name the rows of `repeat` hold: its questions' ids and the first
 *  segment of each Save to Case block held there. */
function advancedRowNames(f: CaseSlotFacts, repeat: Uuid): ReadonlySet<string> {
	const names = new Set<string>();
	for (const uuid of f.doc.fieldOrder[repeat] ?? []) {
		const field = f.doc.fields[uuid];
		if (field !== undefined) names.add(field.id);
	}
	for (const op of f.operations)
		if (op.placement?.kind === "save-to-case" && op.placement.repeat === repeat)
			names.add(op.placement.path[0]);
	return names;
}

/**
 * The procedure in a form of an advanced menu. In operation order, each
 * change keeps a held Save to Case block that still expresses it; else, if
 * it is not excluded, takes the load its target names or an open action,
 * where `advancedPlacement.ts` admits it; else takes Save to Case. A close of
 * a create placed on an open action shares that action. Then the actions are
 * tagged (`allocateAdvancedTags`): the chain's loads, the worker's, then the
 * open actions, a kept hold's tag first.
 */
function planAdvancedCore(f: CaseSlotFacts, options: CoreOptions): CorePlan {
	const nodes = planGeneratedNodes(f.doc, f.formUuid);
	const chain = advancedLoadChain(f.doc, f.formUuid);
	const excluded = new Set([...options.exclude, ...sameTypeExclusions(f)]);
	const sharers = sharingCloses(f);
	const sharedBy = new Map<Uuid, Uuid>();
	for (const [createUuid, close] of sharers)
		sharedBy.set(close.uuid, createUuid);

	const loads: Array<
		ActionState & {
			readonly caseType: string;
			readonly worker: boolean;
			readonly listModule: Uuid | null;
			readonly identifier?: string;
		}
	> = chain.map((load) => ({
		caseType: load.caseType,
		worker: false,
		listModule: load.moduleUuid,
		...(load.identifier !== undefined && { identifier: load.identifier }),
	}));
	const opens: Array<
		ActionState & {
			readonly operationUuid: Uuid;
			readonly caseType: string;
			readonly repeat: Uuid | undefined;
			readonly indexed: boolean;
		}
	> = [];
	const view = new Map<
		Uuid,
		{ readonly repeat: Uuid | undefined; readonly indexed: boolean }
	>();
	const usedHeld = new Set<string>();
	const onAction = new Map<
		Uuid,
		{ readonly slot: AdvancedSlot; readonly sharesWith?: Uuid }
	>();
	const elsewhere = new Map<Uuid, PlannedPlacement>();
	const asSubject = (op: CaseOperation): PlacementSubject => ({
		kind: "operation",
		operationUuid: op.uuid,
	});
	const attach = (
		op: CaseOperation,
		slot: AdvancedSlot,
		state: ActionState,
	): void => {
		const held = op.placement;
		if (
			held?.kind === "advanced" &&
			state.held === undefined &&
			!usedHeld.has(held.tag)
		) {
			state.held = held.tag;
			usedHeld.add(held.tag);
		}
		onAction.set(op.uuid, {
			slot,
			...(state.first !== undefined && { sharesWith: state.first }),
		});
		state.first ??= op.uuid;
	};
	let workerLoad: number | undefined;
	const loadIndex = (ref: AdvancedLoadRef): number => {
		if (ref.kind === "chain") return ref.index;
		if (workerLoad === undefined) {
			workerLoad = loads.length;
			loads.push({
				caseType: USERCASE_CASE_TYPE,
				worker: true,
				listModule: null,
			});
		}
		return workerLoad;
	};

	for (const op of f.operations) {
		const createUuid = sharedBy.get(op.uuid);
		const shared =
			createUuid === undefined ? undefined : onAction.get(createUuid);
		if (createUuid !== undefined && shared?.slot.kind === "open") {
			onAction.set(op.uuid, { slot: shared.slot, sharesWith: createUuid });
			continue;
		}
		const held = op.placement;
		if (
			held?.kind === "save-to-case" &&
			!options.carried.has(op.uuid) &&
			saveToCaseReasons(f, asSubject(op), held).length === 0
		) {
			elsewhere.set(op.uuid, { placement: held, held: true });
			continue;
		}
		if (!excluded.has(op.uuid) || options.forceBasic === op.uuid) {
			const load = advancedLoadOf(f, op);
			if (load !== undefined && loadClause(f, op, load) === undefined) {
				const index = loadIndex(load);
				const state = loads[index];
				if (state !== undefined) {
					attach(op, { kind: "load", index }, state);
					continue;
				}
			}
			if (
				opensCase(f, op) &&
				openActionClause(f, op, { opens: view }) === undefined
			) {
				const repeat = op.action === "create" ? op.forEach?.repeat : undefined;
				const indexed = (op.links ?? []).length > 0;
				const state: (typeof opens)[number] = {
					operationUuid: op.uuid,
					caseType:
						op.action === "create" ? op.caseType : (f.module?.caseType ?? ""),
					repeat,
					indexed,
				};
				opens.push(state);
				view.set(op.uuid, { repeat, indexed });
				attach(op, { kind: "open", index: opens.length - 1 }, state);
				continue;
			}
		}
		elsewhere.set(op.uuid, {
			placement: derivedSaveToCase(f, asSubject(op), nodes),
			held: false,
		});
	}

	const tags = allocateAdvancedTags({
		loads: loads.map((load) => ({
			caseType: load.caseType,
			worker: load.worker,
			...(load.held !== undefined && { held: load.held }),
		})),
		opens: opens.map((open) => ({
			caseType: open.caseType,
			...(open.held !== undefined && { held: open.held }),
			...(open.repeat !== undefined && {
				rowNames: advancedRowNames(f, open.repeat),
			}),
		})),
		rootNames: advancedRootNames(f),
	});
	const indexedIn = new Map<Uuid, number>();
	for (const open of opens)
		if (open.repeat !== undefined && open.indexed)
			indexedIn.set(open.repeat, (indexedIn.get(open.repeat) ?? 0) + 1);
	const plannedOpens: PlannedOpenAction[] = opens.map((open, index) => ({
		tag: tags.opens[index] ?? "",
		operationUuid: open.operationUuid,
		caseType: open.caseType,
		...(open.repeat !== undefined && { repeat: open.repeat }),
		row: open.repeat !== undefined && (indexedIn.get(open.repeat) ?? 0) < 2,
	}));
	const plannedLoads: PlannedLoad[] = loads.map((load, index) => {
		const previous =
			index > 0 && !load.worker ? tags.loads[index - 1] : undefined;
		return {
			tag: tags.loads[index] ?? "",
			caseType: load.caseType,
			listModule: load.listModule,
			...(previous !== undefined &&
				load.identifier !== undefined && {
					index: { tag: previous, identifier: load.identifier },
				}),
			own: !load.worker && index === chain.length - 1,
			worker: load.worker,
		};
	});
	const actionPlacement = (slot: AdvancedSlot): AdvancedPlacement => {
		if (slot.kind === "load")
			return { kind: "advanced", tag: plannedLoads[slot.index]?.tag ?? "" };
		const open = plannedOpens[slot.index];
		return {
			kind: "advanced",
			tag: open?.tag ?? "",
			...(open?.row === true && { row: true as const }),
		};
	};

	const placements = new Map<PlacementSubjectKey, PlannedPlacement>();
	for (const op of f.operations) {
		const action = onAction.get(op.uuid);
		if (action === undefined) {
			const planned = elsewhere.get(op.uuid);
			if (planned !== undefined) placements.set(op.uuid, planned);
			continue;
		}
		const placement = actionPlacement(action.slot);
		placements.set(op.uuid, {
			placement,
			held:
				op.placement !== undefined && samePlacement(op.placement, placement),
			...(action.sharesWith !== undefined && {
				sharesWith: action.sharesWith,
			}),
		});
	}

	// The own close: its own held block first; else the own arm's action,
	// as the load's or the open action's `close_condition`, where the
	// condition can be stated; else the own arm's Save to Case block; else a
	// close-only block.
	if (f.closesOwn && f.own !== undefined) {
		const own = f.own;
		const held = f.form.ownClosePlacement;
		const ownPlanned = placements.get(own.uuid);
		const keptHeld =
			held !== undefined &&
			ownCloseReasons(f, { kind: "save-to-case", path: held.path }).length === 0
				? {
						placement: { kind: "save-to-case", path: held.path } as const,
						held: true,
					}
				: undefined;
		const shares =
			ownPlanned !== undefined &&
			(ownPlanned.placement.kind === "advanced"
				? stateCondition(f, f.form.closeCondition, {
						own: false,
						repeat: undefined,
					}).reasons.length === 0
				: ownPlanned.placement.kind === "save-to-case" && !f.severalCases);
		placements.set(
			"own-close",
			keptHeld ??
				(shares && ownPlanned !== undefined
					? {
							placement: ownPlanned.placement,
							held: false,
							sharesWith: own.uuid,
						}
					: {
							placement: derivedSaveToCase(f, { kind: "own-close" }, nodes),
							held: false,
						}),
		);
	}

	const advancedTags = new Map<string, Uuid | undefined>();
	const holderOf = (state: ActionState): Uuid | undefined =>
		state.held === undefined
			? undefined
			: f.operations.find(
					(op) =>
						op.placement?.kind === "advanced" &&
						op.placement.tag === state.held &&
						onAction.has(op.uuid),
				)?.uuid;
	loads.forEach((load, index) => {
		advancedTags.set(plannedLoads[index]?.tag ?? "", holderOf(load));
	});
	opens.forEach((open, index) => {
		advancedTags.set(plannedOpens[index]?.tag ?? "", holderOf(open));
	});
	return {
		formKind: "advanced",
		placements,
		subcases: [],
		ownBasic: false,
		sharers,
		advanced: { loads: plannedLoads, opens: plannedOpens },
		advancedTags,
	};
}

// ── The readers ─────────────────────────────────────────────────────────

/** The kind `formUuid` is planned as: `moduleKind` where given, else the
 *  kind its menu is emitted as. */
function formKindOf(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleKind: PlanPlacementsOptions["moduleKind"],
): "basic" | "advanced" {
	if (moduleKind !== undefined) return moduleKind;
	const moduleUuid = caseSlotFacts(doc, formUuid).moduleUuid;
	return moduleUuid === undefined
		? "basic"
		: emittedModuleKind(doc, moduleUuid);
}

const plans = new WeakMap<BlueprintDoc, Map<string, CorePlan>>();

function corePlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options: PlanPlacementsOptions | undefined,
	forceBasic?: Uuid,
): CorePlan {
	const kind = formKindOf(doc, formUuid, options?.moduleKind);
	const exclude = [...(options?.excludeBasic ?? [])].sort();
	const key = `${formUuid}\u0000${kind}\u0000${exclude.join(",")}\u0000${forceBasic ?? ""}`;
	let forms = plans.get(doc);
	if (forms === undefined) {
		forms = new Map();
		plans.set(doc, forms);
	}
	const known = forms.get(key);
	if (known !== undefined) return known;
	const f = caseSlotFacts(doc, formUuid);
	const core: CoreOptions = {
		exclude: new Set(exclude),
		carried: new Set(carriedCreates(doc, formUuid).keys()),
		...(forceBasic !== undefined && { forceBasic }),
	};
	const plan =
		kind === "advanced" ? planAdvancedCore(f, core) : planCore(f, core);
	forms.set(key, plan);
	return plan;
}

const formPlans = new WeakMap<BlueprintDoc, Map<string, FormPlacements>>();
const inexpressibleHolds = new WeakMap<
	BlueprintDoc,
	Map<Uuid, readonly InexpressibleHold[]>
>();

/**
 * Every subject of `formUuid` holding a placement that no longer expresses
 * it, with every failed condition: an operation's `placement`, and the
 * form's `ownClosePlacement` (on a form that no longer closes its own case,
 * `no-close`). Whether a hold expresses its subject reads the document
 * alone, so the list is one per form whatever options a plan is made with.
 */
function formInexpressibleHolds(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly InexpressibleHold[] {
	let forms = inexpressibleHolds.get(doc);
	if (forms === undefined) {
		forms = new Map();
		inexpressibleHolds.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const f = caseSlotFacts(doc, formUuid);
	const found: InexpressibleHold[] = [];
	const check = (subject: PlacementSubject, held: CasePlacement): void => {
		const [first, ...rest] = placementIneligibility(
			doc,
			formUuid,
			subject,
			held,
		);
		if (first !== undefined)
			found.push({ subject, held, reasons: [first, ...rest] });
	};
	for (const op of f.operations)
		if (op.placement !== undefined)
			check({ kind: "operation", operationUuid: op.uuid }, op.placement);
	const ownClose = f.form.ownClosePlacement;
	if (ownClose !== undefined)
		check({ kind: "own-close" }, { kind: "save-to-case", path: ownClose.path });
	forms.set(formUuid, found);
	return found;
}

/**
 * Where each case change of `formUuid` is kept in CommCare HQ. The
 * inexpressible holds are found when first read: finding them asks what
 * each hold's menu kind is, and the menu kind asks for plans of a basic
 * form (`moduleKind.ts`), which never read them.
 */
export function planPlacements(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options?: PlanPlacementsOptions,
): FormPlacements {
	const kind = formKindOf(doc, formUuid, options?.moduleKind);
	const exclude = [...(options?.excludeBasic ?? [])].sort();
	const key = `${formUuid}\u0000${kind}\u0000${exclude.join(",")}`;
	let forms = formPlans.get(doc);
	if (forms === undefined) {
		forms = new Map();
		formPlans.set(doc, forms);
	}
	const known = forms.get(key);
	if (known !== undefined) return known;
	const core = corePlan(doc, formUuid, { ...options, moduleKind: kind });
	let inexpressible: readonly InexpressibleHold[] | undefined;
	const plan: FormPlacements = {
		formKind: core.formKind,
		placements: core.placements,
		...(core.advanced !== undefined && { advanced: core.advanced }),
		get inexpressible() {
			inexpressible ??= formInexpressibleHolds(doc, formUuid);
			return inexpressible;
		},
	};
	forms.set(key, plan);
	return plan;
}

/**
 * Whether a basic or an advanced action carries the operation
 * `operationUuid` of `formUuid`, or the own case's change, wherever it is
 * placed: the questions such an action reads a case name or an external id
 * from take the trimmed sibling (`lib/domain/caseScalarTextGuard.ts`), where
 * any other Save to Case block trims and checks its own values.
 */
export function placedBasic(
	doc: BlueprintDoc,
	formUuid: Uuid,
): (operationUuid: Uuid) => boolean {
	const { placements } = planPlacements(doc, formUuid);
	// An inert subcase (a child of a several-case form) keeps its place in
	// `subcases` while its create is a block in the source, so its action
	// still names the question's trimmed sibling, as the own case's change
	// does in a several-case form, whose wrapper per selected case reads it.
	const subcases = new Set(
		planBasicSubcases(doc, formUuid).map((subcase) => subcase.operationUuid),
	);
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation) => operation.action === "own",
	)?.uuid;
	return (operationUuid) => {
		const kind = placements.get(operationUuid)?.placement.kind;
		return (
			operationUuid === own ||
			kind === "basic" ||
			kind === "advanced" ||
			subcases.has(operationUuid)
		);
	};
}

/** The basic subcases of `formUuid`, in `subcases` index order; none in a
 *  form of an advanced menu, unless `moduleKind` fixes the form as basic. */
export function planBasicSubcases(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleKind?: "basic",
): readonly PlannedBasicSubcase[] {
	return corePlan(
		doc,
		formUuid,
		moduleKind === undefined ? undefined : { moduleKind },
	).subcases;
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

const CARRIED_CREATE: PlacementIneligibility = { reason: "carried-create" };

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
	const kind = formKindOf(doc, formUuid, undefined);
	const carried = carriedCreates(doc, formUuid).has(operation.uuid);
	if (placement.kind === "save-to-case")
		return [
			...saveToCaseReasons(f, subject, placement),
			...(carried ? [CARRIED_CREATE] : []),
		];
	if (placement.kind === "advanced")
		return advancedPlacementReasons(doc, f, operation, placement, {
			kind,
			carried,
		});
	const reasons = basicPlacementReasons(doc, formUuid, f, operation, placement);
	// A carried create keeps a session datum in a basic form only as the
	// registration's own case or a subcase at the form root.
	const keepsDatum =
		(placement.slot === "own" && f.registration) ||
		(placement.slot === "subcase" && operation.forEach === undefined);
	return [
		...(kind === "advanced" ? [{ reason: "module-advanced" as const }] : []),
		...reasons,
		...(carried && !keepsDatum ? [CARRIED_CREATE] : []),
	];
}

/** Why a basic slot cannot express `operation`, the menu's kind aside. */
function basicPlacementReasons(
	doc: BlueprintDoc,
	formUuid: Uuid,
	f: CaseSlotFacts,
	operation: CaseOperation,
	placement: Extract<CasePlacement, { kind: "basic" }>,
): PlacementIneligibility[] {
	if (operation.action === "close")
		return sharedCloseReasons(doc, formUuid, f, operation, placement);
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
			const plan = corePlan(doc, formUuid, { moduleKind: "basic" });
			const reasons = subcaseReasons(f, operation, {
				ownBasic: plan.ownBasic,
				sharers: plan.sharers,
			});
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

/**
 * Why `placement`, a load or an open action, cannot express `operation`:
 * a form of a basic menu has none (`module-basic`); else the first clause
 * of `advancedPlacement.ts` that holds; else a tag another action of the
 * form takes, or the tag of an action whose place another change's hold
 * gives (`scope`), and a repeat shape the action no longer has
 * (`repeat-shared`). A carried create keeps its session datum only on an
 * open action outside a repeat.
 */
function advancedPlacementReasons(
	doc: BlueprintDoc,
	f: CaseSlotFacts,
	operation: CaseOperation,
	placement: AdvancedPlacement,
	{ kind, carried }: { kind: "basic" | "advanced"; carried: boolean },
): PlacementIneligibility[] {
	if (kind === "basic") return [{ reason: "module-basic" }];
	const plan = corePlan(doc, f.formUuid, { moduleKind: "advanced" });
	const planned = plan.placements.get(operation.uuid);
	const sharedCreate = [...plan.sharers].find(
		([, close]) => close.uuid === operation.uuid,
	)?.[0];
	if (
		sharedCreate !== undefined &&
		planned?.sharesWith === sharedCreate &&
		planned.placement.kind === "advanced"
	)
		return samePlacement(planned.placement, placement)
			? []
			: [SUBJECT_CANNOT_HOLD];
	const load = advancedLoadOf(f, operation);
	const clause =
		load !== undefined
			? loadClause(f, operation, load)
			: opensCase(f, operation)
				? openActionClause(
						f,
						operation,
						openActionViewBefore(doc, f, operation),
					)
				: "scope";
	if (clause !== undefined) return [{ reason: clause }];
	const reasons: PlacementIneligibility[] = [];
	const tags = plan.advancedTags ?? new Map<string, Uuid | undefined>();
	if (planned?.placement.kind === "advanced") {
		const planTag = planned.placement.tag;
		const holder = tags.get(planTag);
		if (
			placement.tag !== planTag &&
			(tags.has(placement.tag) ||
				(holder !== undefined && holder !== operation.uuid))
		)
			reasons.push(SUBJECT_CANNOT_HOLD);
		if ((placement.row === true) !== (planned.placement.row === true))
			reasons.push({ reason: "repeat-shared" });
	} else if (tags.has(placement.tag)) reasons.push(SUBJECT_CANNOT_HOLD);
	if (carried && placement.row === true) reasons.push(CARRIED_CREATE);
	return reasons;
}

/**
 * Why a close cannot hold the basic subcase place `placement`. A close keeps
 * a basic place only by sharing the place of the create it closes (HQ's
 * `close_condition`), so it expresses exactly the place the plan shares;
 * otherwise the reasons are the close's own (its scope and its condition),
 * then the create's for that place, and a place the create could take but
 * does not is `subcase-index`.
 */
function sharedCloseReasons(
	doc: BlueprintDoc,
	formUuid: Uuid,
	f: CaseSlotFacts,
	close: CaseOperation,
	placement: Extract<CasePlacement, { kind: "basic" }>,
): PlacementIneligibility[] {
	const planned = corePlan(doc, formUuid, {
		moduleKind: "basic",
	}).placements.get(close.uuid);
	if (
		planned?.sharesWith !== undefined &&
		samePlacement(planned.placement, placement)
	)
		return [];
	const target = close.target;
	const createUuid = target?.kind === "op" ? target.opUuid : undefined;
	const create = f.operations.find(
		(op) => op.uuid === createUuid && op.action === "create",
	);
	if (
		create === undefined ||
		(placement.slot !== "subcase" && placement.slot !== "subcase-row")
	)
		return [SUBJECT_CANNOT_HOLD];
	const repeat = create.forEach?.repeat;
	const reasons: PlacementIneligibility[] = [];
	if (close.forEach?.repeat !== repeat) reasons.push({ reason: "scope" });
	for (const reason of stateCondition(f, close.condition, {
		own: false,
		repeat,
	}).reasons)
		reasons.push(
			reason.startsWith("condition-")
				? { reason, condition: "operation" }
				: { reason },
		);
	if (reasons.length > 0) return reasons;
	const createReasons = basicPlacementReasons(
		doc,
		formUuid,
		f,
		create,
		placement,
	);
	return createReasons.length > 0
		? [...createReasons]
		: [{ reason: "subcase-index" }];
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
 * simplest first: a basic slot in a basic form, or the advanced action the
 * plan gives it in an advanced form, then Save to Case, each with the
 * index, tag or path the procedure would give it.
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
	if (plan.formKind === "advanced")
		return planned.placement.kind === "advanced"
			? [planned.placement, saveToCase]
			: [saveToCase];
	const basic: CasePlacement[] = [];
	if (operation.action === "own" && ownSlotReasons(f, operation).length === 0)
		basic.push({ kind: "basic", slot: "own" });
	if (
		isWorkerRecordUpdate(operation) &&
		f.operations.find(isWorkerRecordUpdate)?.uuid === operation.uuid &&
		usercaseSlotReasons(f, operation).length === 0 &&
		(planned.placement.kind === "basic" ||
			!appendedNameTaken(f, USERCASE_BLOCK_NAME, undefined))
	)
		basic.push({ kind: "basic", slot: "usercase" });
	if (operation.action === "create") {
		if (planned.placement.kind === "basic") basic.push(planned.placement);
		else if (
			subcaseReasons(f, operation, {
				ownBasic: plan.ownBasic,
				sharers: plan.sharers,
			}).length === 0
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
