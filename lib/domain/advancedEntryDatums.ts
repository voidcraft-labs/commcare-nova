// lib/domain/advancedEntryDatums.ts
//
// What the entry of a form of a menu emitted advanced gives a session value:
// each case it loads, the worker's record where a change takes the worker's
// load, and the case each open action outside a repeat creates
// (`suite_xml/sections/entries.py::EntriesHelper.configure_entry_advanced_form`).
// `entryDatumSupplies.ts` reads it, so the session values the checker admits
// in an advanced form are the ones the wire writes.
//
// These are the one answer to what an advanced entry depends on, and
// `lib/commcare` reads them rather than deciding again:
//
// - `advancedLoadChain`, `chainLoadOfTarget`: the chain loads, which
//   `lib/commcare/advancedSelections.ts` tags and the planners place on;
// - `advancedLoadOf`, `opensCase`, `loadClause`, `openActionClause`: what an
//   advanced action can express, which `lib/commcare/advancedPlacement.ts`
//   and `lib/commcare/placement.ts` ask;
// - `carriedCreates`: the creates an after-submit link carries
//   (`lib/commcare/formLinkProjection.ts::carriedCreateLinks` returns it);
// - `menuEmittedAdvanced`, `advancedKindTriggers`: the menu's kind
//   (`lib/commcare/moduleKind.ts::emittedModuleKind`, `advancedKindReasons`);
// - `advancedEntryActions`: the attachment loop of
//   `lib/commcare/placement.ts::planAdvancedCore`, for the open actions and
//   the worker's load (the chain's loads are there whatever they carry).
//
// `lib/commcare/__tests__/entryDatumAgreement.ts` holds the entry supplies
// to the wire's datums over every admitted fuzz document.
//
// Pure, and memoized per document object (documents are replaced, never
// changed in place).

import { advancedChainIndex, advancedKindBlockers } from "./advancedModule";
import {
	basicCaseSlots,
	type CaseSlotFacts,
	caseSlotFacts,
	heldOwnOrCreateBlockExpresses,
	isWorkerRecordUpdate,
	sharingCloses,
	stateCondition,
} from "./basicCaseSlots";
import type { BlueprintDoc } from "./blueprint";
import { caseWriteValueField } from "./caseWriteViews";
import { entrySelections, rootSelectionAlignment } from "./entryDatumSupplies";
import { CASE_TYPE_PATTERN, type Expression } from "./expression/types";
import { walkExpressionTerms } from "./expression/walk";
import { isCaptureField, isContainer } from "./fields";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	caseOperationRunsPerSelectedCase,
	type FormLinkTarget,
	orderedCaseOperations,
} from "./forms";
import { moduleParent, projectedModulePreorder } from "./moduleHierarchy";
import type { AdvancedIneligibility } from "./placements";
import type { Uuid } from "./uuid";

function owningModule(doc: BlueprintDoc, formUuid: Uuid): Uuid | undefined {
	for (const moduleUuid of doc.moduleOrder)
		if (doc.formOrder[moduleUuid]?.includes(formUuid)) return moduleUuid;
	return undefined;
}

// ── The loads ───────────────────────────────────────────────────────────

/** One module of an advanced form's chain, root first. */
export interface ChainLoad {
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	/** The index name this load follows from the load before it; absent on
	 *  the first. */
	readonly identifier?: string;
}

const chains = new WeakMap<BlueprintDoc, Map<Uuid, readonly ChainLoad[]>>();

/**
 * The chain loads of `formUuid`, root first: one per module of its module's
 * parent selection that has a case type, ending at its module. Empty for a
 * registration, a survey, a form in no module, and a chain whose case types
 * CommCare does not accept.
 */
export function advancedLoadChain(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly ChainLoad[] {
	let forms = chains.get(doc);
	if (forms === undefined) {
		forms = new Map();
		chains.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const chain = computeChain(doc, formUuid);
	forms.set(formUuid, chain);
	return chain;
}

function computeChain(doc: BlueprintDoc, formUuid: Uuid): readonly ChainLoad[] {
	const form = doc.forms[formUuid];
	const moduleUuid = owningModule(doc, formUuid);
	if (
		form === undefined ||
		moduleUuid === undefined ||
		!CASE_LOADING_FORM_TYPES.has(form.type)
	)
		return [];
	const modules: Uuid[] = [moduleUuid];
	const seen = new Set<Uuid>([moduleUuid]);
	let current = doc.modules[moduleUuid]?.parentCaseModuleUuid;
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		modules.unshift(current);
		current = doc.modules[current]?.parentCaseModuleUuid;
	}
	const typed = modules.flatMap((uuid) => {
		const caseType = doc.modules[uuid]?.caseType;
		return caseType ? [{ moduleUuid: uuid, caseType }] : [];
	});
	if (typed.at(-1)?.moduleUuid !== moduleUuid) return [];
	if (typed.some((load) => !CASE_TYPE_PATTERN.test(load.caseType))) return [];
	return typed.map((load, index) => {
		const parent = typed[index - 1];
		if (parent === undefined) return load;
		const chainIndex = advancedChainIndex(doc, load.caseType, parent.caseType);
		return {
			...load,
			identifier:
				chainIndex.kind === "one"
					? chainIndex.identifier
					: (chainIndex.identifiers[0] ?? "parent"),
		};
	});
}

/** The selected case of a module, read exactly as a session datum. */
function selectedCaseModule(expression: Expression): Uuid | undefined {
	if (expression.kind !== "term") return undefined;
	const term = expression.term;
	return term.kind === "session-datum" && term.datum.kind === "selected-case"
		? term.datum.module
		: undefined;
}

/** The chain load a case target names: the own case (`session`) is the
 *  last; an expression that is exactly a chain module's selection is that
 *  module's. */
export function chainLoadOfTarget(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: CaseOperation["target"] | null | undefined,
): number | undefined {
	const chain = advancedLoadChain(doc, formUuid);
	if (chain.length === 0 || target === undefined || target === null)
		return undefined;
	if (target.kind === "session") return chain.length - 1;
	if (target.kind !== "expression") return undefined;
	const module = selectedCaseModule(target.expr);
	if (module === undefined) return undefined;
	const index = chain.findIndex((load) => load.moduleUuid === module);
	return index < 0 ? undefined : index;
}

// ── What an action can express ──────────────────────────────────────────

/** The load a change takes: a chain load by position, or the worker's. */
export type AdvancedLoadRef =
	| { readonly kind: "chain"; readonly index: number }
	| { readonly kind: "worker" };

/** The load `operation` would take: the own arm of a follow-up or close
 *  form its own load, an update or close the chain load its target names,
 *  the form's first `worker-record` update the worker's load. */
export function advancedLoadOf(
	f: CaseSlotFacts,
	operation: CaseOperation,
): AdvancedLoadRef | undefined {
	const chain = advancedLoadChain(f.doc, f.formUuid);
	if (operation.action === "own")
		return chain.length > 0 && !f.registration
			? { kind: "chain", index: chain.length - 1 }
			: undefined;
	if (isWorkerRecordUpdate(operation))
		return f.operations.find(isWorkerRecordUpdate)?.uuid === operation.uuid
			? { kind: "worker" }
			: undefined;
	if (operation.action !== "update" && operation.action !== "close")
		return undefined;
	const index = chainLoadOfTarget(f.doc, f.formUuid, operation.target);
	return index === undefined ? undefined : { kind: "chain", index };
}

/** Whether `operation` is one an open action can carry. */
export function opensCase(f: CaseSlotFacts, operation: CaseOperation): boolean {
	return (
		operation.action === "create" ||
		(operation.action === "own" && f.registration)
	);
}

function readsQuestion(
	f: CaseSlotFacts,
	value: Expression,
	repeat: Uuid | undefined,
): boolean {
	const source = caseWriteValueField(value);
	if (source === undefined || !f.repeatOf.has(source.field)) return false;
	const field = f.doc.fields[source.field];
	if (field === undefined || field.kind === "label" || isContainer(field))
		return false;
	if (source.link && !isCaptureField(field)) return false;
	const stands = f.repeatOf.get(source.field);
	return stands === undefined || stands === repeat;
}

function stateable(
	f: CaseSlotFacts,
	condition: Expression | undefined,
	repeat: Uuid | undefined,
): boolean {
	return (
		stateCondition(f, condition, { own: false, repeat }).reasons.length === 0
	);
}

function ownerExpressible(
	f: CaseSlotFacts,
	owner: Expression | undefined,
	repeat: Uuid | undefined,
	opens: boolean,
): boolean {
	if (owner === undefined) return true;
	if (owner.kind === "acting-user" || owner.kind === "unowned") return opens;
	return readsQuestion(f, owner, repeat);
}

/** The first clause that keeps `operation` from `load`, in the table order
 *  of `lib/commcare/advancedPlacement.ts`. `worker-property-name` waits on
 *  the proof lane's gated run and is not tried; no load meets
 *  `appended-name-taken`, since its tag steps around every root name. */
export function loadClause(
	f: CaseSlotFacts,
	operation: CaseOperation,
	load: AdvancedLoadRef,
): AdvancedIneligibility | undefined {
	if (operation.action !== "own" && operation.forEach !== undefined)
		return "scope";
	const writes = operation.writes ?? [];
	const values: Expression[] = [
		...(operation.action === "own"
			? operation.name === undefined
				? []
				: [operation.name]
			: operation.action === "update" && operation.rename !== undefined
				? [operation.rename]
				: []),
		...writes.map((write) => write.value),
	];
	if (values.some((value) => !readsQuestion(f, value, undefined)))
		return "value-not-a-question";
	if (
		writes.some((write) => write.condition !== undefined) ||
		(operation.action === "update" &&
			operation.condition !== undefined &&
			operation.condition.kind !== "match-all")
	)
		return "write-condition";
	if (
		operation.action === "close" &&
		!stateable(f, operation.condition, undefined)
	)
		return "condition-not-stateable";
	if (
		load.kind === "chain" &&
		load.index > 0 &&
		writes.some((write) => write.via !== undefined)
	)
		return "via-on-indexed-load";
	const owner = operation.action === "close" ? undefined : operation.owner;
	if (!ownerExpressible(f, owner, undefined, false)) return "owner";
	if (operation.action === "update" && operation.retype !== undefined)
		return "retype";
	if (operation.action !== "close" && (operation.links ?? []).length > 0)
		return "link-target";
	return undefined;
}

/** Each earlier change placed on an open action: the repeat it runs in and
 *  whether it carries an index. */
export interface OpenActionView {
	readonly opens: ReadonlyMap<
		Uuid,
		{ readonly repeat: Uuid | undefined; readonly indexed: boolean }
	>;
}

function renamedChainModules(f: CaseSlotFacts): ReadonlySet<Uuid> {
	if (f.moduleUuid === undefined) return new Set();
	const alignment = rootSelectionAlignment(f.doc, {
		kind: "form",
		module: f.moduleUuid,
		form: f.formUuid,
	});
	return new Set(alignment.matches.map((match) => match.targetModuleUuid));
}

/** The first clause that keeps `operation` from an open action. */
export function openActionClause(
	f: CaseSlotFacts,
	operation: CaseOperation,
	view: OpenActionView,
): AdvancedIneligibility | undefined {
	if (!opensCase(f, operation)) return "scope";
	const repeat =
		operation.action === "create" ? operation.forEach?.repeat : undefined;
	if (
		operation.action === "create" &&
		operation.target.kind === "new" &&
		operation.target.idFrom !== undefined
	)
		return "keyed";
	const writes = operation.writes ?? [];
	const name =
		operation.action === "create" || operation.action === "own"
			? operation.name
			: undefined;
	const values: Expression[] = [
		...(name === undefined ? [] : [name]),
		...writes.map((write) => write.value),
	];
	if (values.some((value) => !readsQuestion(f, value, repeat)))
		return "value-not-a-question";
	const nameSource =
		name === undefined ? undefined : caseWriteValueField(name)?.field;
	if (nameSource !== undefined && f.repeatOf.get(nameSource) !== repeat)
		return "name-repeat";
	if (writes.some((write) => write.condition !== undefined))
		return "write-condition";
	const conditions =
		operation.action === "own"
			? [f.form.openCondition, f.form.closeCondition]
			: [operation.condition];
	if (conditions.some((condition) => !stateable(f, condition, repeat)))
		return "condition-not-stateable";
	if (!ownerExpressible(f, operation.owner, repeat, true)) return "owner";
	const links = operation.links ?? [];
	const chain = advancedLoadChain(f.doc, f.formUuid);
	const linkLoad = (target: CaseOperation["target"] | null) =>
		f.registration ? undefined : chainLoadOfTarget(f.doc, f.formUuid, target);
	for (const link of links) {
		const target = link.target;
		if (target === null) return "link-target";
		if (linkLoad(target) !== undefined) continue;
		if (target.kind === "op" && view.opens.has(target.opUuid)) continue;
		return "link-target";
	}
	const renamed = renamedChainModules(f);
	for (const link of links) {
		const index = linkLoad(link.target);
		const module = index === undefined ? undefined : chain[index]?.moduleUuid;
		if (module !== undefined && renamed.has(module)) return "link-renamed-load";
	}
	if (repeat !== undefined) {
		const shared = [...view.opens.values()].filter(
			(open) => open.repeat === repeat,
		);
		const indexed =
			shared.filter((open) => open.indexed).length + (links.length > 0 ? 1 : 0);
		if (shared.length > 0 && indexed < 2) return "repeat-shared";
	}
	const caseType =
		operation.action === "create"
			? operation.caseType
			: (f.module?.caseType ?? "");
	if (!f.moduleCaseTypes.has(caseType) || !CASE_TYPE_PATTERN.test(caseType))
		return "type-not-a-menu";
	const sharer = sharingCloses(f).get(operation.uuid);
	if (
		f.operations.some(
			(other) =>
				other !== sharer &&
				(other.action === "update" || other.action === "close") &&
				other.target.kind === "op" &&
				other.target.opUuid === operation.uuid,
		)
	)
		return "case-changed-before-create";
	return undefined;
}

// ── Creates a link carries ──────────────────────────────────────────────

interface CandidateNewCase {
	readonly operationUuid: Uuid;
	readonly caseType: string;
	readonly own: boolean;
}

/** The creates HQ could give a datum, whatever their placement: the
 *  registration's own case first, then every create at the root with a
 *  minted id, in operation order. */
function candidateNewCases(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
): readonly CandidateNewCase[] {
	const form = doc.forms[formUuid];
	if (form === undefined) return [];
	const operations = form.caseOperations ?? [];
	const moduleCaseType = doc.modules[moduleUuid]?.caseType;
	const candidates: CandidateNewCase[] = [];
	const own = operations.find((op) => op.action === "own");
	if (form.type === "registration" && own !== undefined && moduleCaseType)
		candidates.push({
			operationUuid: own.uuid,
			caseType: moduleCaseType,
			own: true,
		});
	for (const op of operations)
		if (
			op.action === "create" &&
			op.forEach === undefined &&
			op.target.kind === "new" &&
			op.target.idFrom === undefined
		)
			candidates.push({
				operationUuid: op.uuid,
				caseType: op.caseType,
				own: false,
			});
	return candidates;
}

/** One selection datum of a frame: the key that stands for its id
 *  (`entrySelections`) and its case type. */
interface FrameSelection {
	readonly key: string;
	readonly caseType: string | undefined;
}

function frameSelections(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
): FrameSelection[] {
	return entrySelections(doc, {
		kind: "form",
		module: moduleUuid,
		form: formUuid,
	}).map((row) => ({
		key: row.key,
		caseType: doc.modules[row.module]?.caseType,
	}));
}

/**
 * The selection datums of a link target's frame, in frame order
 * (`formLinkProjection.ts::targetFrameChildren`): each ancestor menu's
 * selections where every form of it selects a case (the common prefix of
 * its forms' entries holds a selection only then), root first; then, for a
 * form target, the form's own selections that no ancestor's datum already
 * names.
 */
function targetSelections(
	doc: BlueprintDoc,
	target: FormLinkTarget,
): FrameSelection[] {
	const ancestors: Uuid[] = [];
	const seen = new Set<Uuid>([target.moduleUuid]);
	let parent = moduleParent(doc, target.moduleUuid);
	while (parent !== undefined && parent !== null && !seen.has(parent)) {
		seen.add(parent);
		ancestors.unshift(parent);
		parent = moduleParent(doc, parent);
	}
	const prefix: FrameSelection[] = [];
	for (const module of ancestors) {
		const forms = doc.formOrder[module] ?? [];
		const first = forms[0];
		if (
			first !== undefined &&
			forms.every((uuid) => {
				const form = doc.forms[uuid];
				return form !== undefined && CASE_LOADING_FORM_TYPES.has(form.type);
			})
		)
			prefix.push(...frameSelections(doc, module, first));
	}
	if (target.type === "module") return prefix;
	const prefixed = new Set(prefix.map((row) => row.key));
	return [
		...prefix,
		...frameSelections(doc, target.moduleUuid, target.formUuid).filter(
			(row) => !prefixed.has(row.key),
		),
	];
}

function linkTargetResolves(
	doc: BlueprintDoc,
	target: FormLinkTarget,
): boolean {
	if (!projectedModulePreorder(doc).includes(target.moduleUuid)) return false;
	return (
		target.type === "module" ||
		(doc.formOrder[target.moduleUuid] ?? []).includes(target.formUuid)
	);
}

const carried = new WeakMap<BlueprintDoc, Map<Uuid, ReadonlyMap<Uuid, Uuid>>>();

/**
 * The creates of `formUuid` that its after-submit links carry into a target,
 * each with the first link that carries it, in candidate order
 * (`lib/commcare/formLinkProjection.ts::carriedCreateLinks`):
 *
 * - a link that matches automatically carries each candidate HQ's
 *   `_get_datums_matched_to_source` takes: the target frame's selections
 *   are matched in order against the source entry's selections followed by
 *   the candidates, each to the first unused source datum of its case type,
 *   and a match uses up every source datum under the matched selection's id
 *   (`workflow.py::_find_best_match`);
 * - a link's condition or manual datum values that read `new-case` carry
 *   the registration's own case, and `new-child-case` of type `T` the first
 *   candidate of `T` that is not the own case.
 *
 * Both sides read every menu as basic and no case action, as the wire's
 * does: selections alone, whose ids `entrySelections`' keys stand for.
 */
export function carriedCreates(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlyMap<Uuid, Uuid> {
	let forms = carried.get(doc);
	if (forms === undefined) {
		forms = new Map();
		carried.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const found = computeCarriedCreates(doc, formUuid);
	forms.set(formUuid, found);
	return found;
}

function computeCarriedCreates(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlyMap<Uuid, Uuid> {
	const links = doc.forms[formUuid]?.formLinks ?? [];
	if (links.length === 0) return new Map();
	const moduleUuid = projectedModulePreorder(doc).find((uuid) =>
		(doc.formOrder[uuid] ?? []).includes(formUuid),
	);
	if (moduleUuid === undefined) return new Map();
	const candidates = candidateNewCases(doc, formUuid, moduleUuid);
	if (candidates.length === 0) return new Map();
	// A candidate's key is one no selection's key takes, as its id
	// (`case_id_new_<type>_<n>`) is one no selection datum takes.
	const source = [
		...frameSelections(doc, moduleUuid, formUuid).map((row) => ({
			...row,
			candidate: undefined,
		})),
		...candidates.map((candidate, index) => ({
			key: JSON.stringify(["new", index]),
			caseType: candidate.caseType as string | undefined,
			candidate: candidate.operationUuid,
		})),
	];
	const ownCandidate = candidates.find((candidate) => candidate.own);
	const carriedBy = new Map<Uuid, Uuid>();
	const carry = (operationUuid: Uuid, linkUuid: Uuid): void => {
		if (!carriedBy.has(operationUuid)) carriedBy.set(operationUuid, linkUuid);
	};
	for (const link of links) {
		if (link.datums === undefined && linkTargetResolves(doc, link.target)) {
			let unused = [...source];
			for (const datum of targetSelections(doc, link.target)) {
				const match = unused.find(
					(candidate) =>
						candidate.caseType !== undefined &&
						candidate.caseType === datum.caseType,
				);
				if (match === undefined) continue;
				unused = unused.filter((candidate) => candidate.key !== datum.key);
				if (match.candidate !== undefined) carry(match.candidate, link.uuid);
			}
		}
		const read = [
			...(link.condition === undefined ? [] : [link.condition]),
			...(link.datums ?? []).map((datum) => datum.xpath),
		];
		for (const expression of read)
			walkExpressionTerms(expression, (term) => {
				if (term.kind !== "session-datum") return;
				const { datum } = term;
				if (datum.kind === "new-case" && ownCandidate !== undefined)
					carry(ownCandidate.operationUuid, link.uuid);
				if (datum.kind === "new-child-case") {
					const child = candidates.find(
						(candidate) =>
							!candidate.own && candidate.caseType === datum.caseType,
					);
					if (child !== undefined) carry(child.operationUuid, link.uuid);
				}
			});
	}
	const ordered = new Map<Uuid, Uuid>();
	for (const candidate of candidates) {
		const linkUuid = carriedBy.get(candidate.operationUuid);
		if (linkUuid !== undefined) ordered.set(candidate.operationUuid, linkUuid);
	}
	return ordered;
}

// ── The kind ────────────────────────────────────────────────────────────

/** Whether a basic form gives carried create `operationUuid` a session
 *  datum: as the registration's own case on its basic slot, or as a basic
 *  subcase at the root (`placement.ts::planCore` places on the same
 *  `basicCaseSlots`). */
function givesBasicDatum(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operationUuid: Uuid,
	carriedSet: ReadonlySet<Uuid>,
): boolean {
	const form = doc.forms[formUuid];
	const operation = form?.caseOperations?.find(
		(op) => op.uuid === operationUuid,
	);
	if (form === undefined || operation === undefined) return false;
	const slots = basicCaseSlots(doc, formUuid, { carried: carriedSet });
	if (operation.action === "own")
		return form.type === "registration" && slots.own?.kind === "basic";
	if (operation.action !== "create" || operation.forEach !== undefined)
		return false;
	const subcase = slots.subcases.find(
		(row) => row.operationUuid === operationUuid,
	);
	return (
		slots.creates.get(operationUuid)?.kind === "basic" &&
		subcase !== undefined &&
		!subcase.inSource &&
		!subcase.row
	);
}

/** Why a menu is emitted advanced, for the builder's and the tools'
 *  statements. */
export type AdvancedKindReason =
	| { readonly kind: "held" }
	| {
			readonly kind: "carried-create";
			readonly formUuid: Uuid;
			readonly operationUuid: Uuid;
			/** The first link that carries the create. */
			readonly linkUuid: Uuid;
	  };

const triggers = new WeakMap<
	BlueprintDoc,
	Map<Uuid, readonly AdvancedKindReason[]>
>();

/**
 * What would make the menu advanced, blockers aside: its held kind, then
 * each carried create a basic form gives no session datum, in form order
 * and, within a form, in candidate order.
 */
export function advancedKindTriggers(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly AdvancedKindReason[] {
	let modules = triggers.get(doc);
	if (modules === undefined) {
		modules = new Map();
		triggers.set(doc, modules);
	}
	const known = modules.get(moduleUuid);
	if (known !== undefined) return known;
	const found = computeKindTriggers(doc, moduleUuid);
	modules.set(moduleUuid, found);
	return found;
}

function computeKindTriggers(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly AdvancedKindReason[] {
	const module = doc.modules[moduleUuid];
	if (module === undefined) return [];
	const found: AdvancedKindReason[] = [];
	if (module.heldKind === "advanced") found.push({ kind: "held" });
	for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
		if (doc.forms[formUuid] === undefined) continue;
		const links = carriedCreates(doc, formUuid);
		if (links.size === 0) continue;
		const carriedSet = new Set(links.keys());
		for (const [operationUuid, linkUuid] of links)
			if (!givesBasicDatum(doc, formUuid, operationUuid, carriedSet))
				found.push({
					kind: "carried-create",
					formUuid,
					operationUuid,
					linkUuid,
				});
	}
	return found;
}

const kinds = new WeakMap<BlueprintDoc, Map<Uuid, boolean>>();

/**
 * Whether the menu is emitted advanced (`moduleKind.ts::emittedModuleKind`
 * reads this): nothing blocks it, and its kind is held or one of its forms
 * holds a carried create a basic form gives no session datum.
 */
export function menuEmittedAdvanced(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	let modules = kinds.get(doc);
	if (modules === undefined) {
		modules = new Map();
		kinds.set(doc, modules);
	}
	const known = modules.get(moduleUuid);
	if (known !== undefined) return known;
	// A blocked menu reads no link and a held one needs none.
	const advanced =
		advancedKindBlockers(doc, moduleUuid).length === 0 &&
		(doc.modules[moduleUuid]?.heldKind === "advanced" ||
			advancedKindTriggers(doc, moduleUuid).length > 0);
	modules.set(moduleUuid, advanced);
	return advanced;
}

// ── The advanced form's actions ─────────────────────────────────────────

/** One open action of an advanced form, in `open_cases` order. */
export interface AdvancedEntryOpen {
	readonly operationUuid: Uuid;
	readonly caseType: string;
	/** The registration's own case. */
	readonly own: boolean;
	readonly repeat: Uuid | undefined;
}

export interface AdvancedEntryActions {
	readonly opens: readonly AdvancedEntryOpen[];
	/** A change takes the worker's load. */
	readonly workerLoad: boolean;
}

/** Whether a held Save to Case block of a `worker-record` update still
 *  expresses it (`placement.ts::saveToCaseReasons`). The update's block
 *  takes a condition group for its own condition; one it inherits from a
 *  conditional create it reads (`lib/doc/caseOperationOrder.ts::
 *  caseOperationConditionalGuardUuids`, which the domain cannot read) is not
 *  counted. */
function heldWorkerBlockExpresses(
	f: CaseSlotFacts,
	operation: CaseOperation,
): boolean {
	const held = operation.placement;
	if (held?.kind !== "save-to-case") return false;
	const writes = operation.writes ?? [];
	if (writes.some((write) => write.onlyIfChanged === true)) return false;
	if (writes.some((write) => write.via !== undefined)) return false;
	if (held.repeat !== operation.forEach?.repeat) return false;
	const shape =
		(f.severalCases && caseOperationRunsPerSelectedCase(operation) ? 2 : 0) +
		(operation.action !== "own" &&
		operation.action !== "create" &&
		operation.condition !== undefined
			? 3
			: 2);
	return held.path.length === shape;
}

const actions = new WeakMap<BlueprintDoc, Map<Uuid, AdvancedEntryActions>>();

/**
 * The open actions and the worker's load of `formUuid` planned as an
 * advanced form (`placement.ts::planAdvancedCore`): in operation order, a
 * close that shares a create's open action takes no action of its own; a
 * change keeps a held Save to Case block that still expresses it, unless
 * a link carries it; else it takes the load its target names or an open
 * action where the clauses admit it.
 */
export function advancedEntryActions(
	doc: BlueprintDoc,
	formUuid: Uuid,
): AdvancedEntryActions {
	let forms = actions.get(doc);
	if (forms === undefined) {
		forms = new Map();
		actions.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const f = caseSlotFacts(doc, formUuid);
	const carriedSet = new Set(carriedCreates(doc, formUuid).keys());
	const sharedBy = new Map<Uuid, Uuid>();
	for (const [createUuid, close] of sharingCloses(f))
		sharedBy.set(close.uuid, createUuid);
	const opened = new Set<Uuid>();
	const view = new Map<
		Uuid,
		{ readonly repeat: Uuid | undefined; readonly indexed: boolean }
	>();
	const opens: AdvancedEntryOpen[] = [];
	let workerLoad = false;
	for (const op of orderedCaseOperations(f.form)) {
		const createUuid = sharedBy.get(op.uuid);
		if (createUuid !== undefined && opened.has(createUuid)) continue;
		if (
			op.placement?.kind === "save-to-case" &&
			!carriedSet.has(op.uuid) &&
			(op.action === "own" || op.action === "create"
				? heldOwnOrCreateBlockExpresses(f, op)
				: heldWorkerBlockExpresses(f, op))
		)
			continue;
		const load = advancedLoadOf(f, op);
		if (load !== undefined && loadClause(f, op, load) === undefined) {
			if (load.kind === "worker") workerLoad = true;
			continue;
		}
		if (
			opensCase(f, op) &&
			openActionClause(f, op, { opens: view }) === undefined
		) {
			const repeat = op.action === "create" ? op.forEach?.repeat : undefined;
			opens.push({
				operationUuid: op.uuid,
				caseType:
					op.action === "create" ? op.caseType : (f.module?.caseType ?? ""),
				own: op.action === "own",
				repeat,
			});
			view.set(op.uuid, { repeat, indexed: (op.links ?? []).length > 0 });
			opened.add(op.uuid);
		}
	}
	const result: AdvancedEntryActions = { opens, workerLoad };
	forms.set(formUuid, result);
	return result;
}
