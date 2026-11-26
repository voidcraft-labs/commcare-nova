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
//   the worker's load (the chain's loads are there whatever they carry);
// - `advancedLoadTags`: the tag each load takes, so the datum it gives the
//   entry, which `menuScreens.ts` reads to say whether a menu asks for its
//   case first.
//
// `lib/commcare/__tests__/entryDatumAgreement.ts` holds the entry supplies
// to the wire's datums, and the load tags to the planner's, over every
// admitted fuzz document.
//
// Pure, and memoized per document object (documents are replaced, never
// changed in place).

import { advancedChainIndex, advancedKindBlockers } from "./advancedModule";
import { allocateAdvancedTags } from "./advancedTags";
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
import { hasSeveralCaseMapLocations } from "./caseMap";
import { caseWriteValueField } from "./caseWriteViews";
import { detailTileSharesRowAcrossTabs } from "./detailTabs";
import { entrySelections, rootSelectionAlignment } from "./entryDatumSupplies";
import { CASE_TYPE_PATTERN, type Expression } from "./expression/types";
import { walkExpressionTerms } from "./expression/walk";
import { isCaptureField, isContainer } from "./fields";
import {
	type FormCaseSelection,
	implicitFormSelectionId,
} from "./formEntryCases";
import {
	type ResolvedFormLinkTarget,
	resolveFormLinkTarget,
} from "./formLinkTargets";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	type CaseOperationWrite,
	caseOperationRunsPerSelectedCase,
	type Form,
	formLinkEntries,
	opensWithWorkerValue,
	operationCaseType,
	operationSavesOnlyChanged,
	orderedCaseOperations,
	usesFormEntryActions,
} from "./forms";
import { uniqueSlug } from "./idSlug";
import { moduleParent, projectedModulePreorder } from "./moduleHierarchy";
import type { AdvancedIneligibility } from "./placements";
import {
	isReservedCaseOperationWrite,
	isWritableStandardCaseProperty,
} from "./standardCaseProperties";
import { USERCASE_CASE_TYPE } from "./usercase";
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

/** Ordinary advanced forms this menu can open through an additional entry. */
export function shareableForms(doc: BlueprintDoc, menu: Uuid) {
	if (!menuEmittedAdvanced(doc, menu)) return [];
	return doc.moduleOrder.flatMap((owner) => {
		if (!menuEmittedAdvanced(doc, owner)) return [];
		return (doc.formOrder[owner] ?? []).flatMap((uuid) => {
			const form = doc.forms[uuid];
			return form && !form.shadowOf
				? [{ uuid, name: form.name, menu: doc.modules[owner].name }]
				: [];
		});
	});
}

/** The manual load of the owning menu's type that supplies its own case. */
export function ownFormSelectionIndex(
	doc: BlueprintDoc,
	formUuid: Uuid,
): number | undefined {
	const shared = doc.forms[formUuid]?.shadowOf;
	if (shared) {
		const parent = doc.forms[shared.form];
		if (!parent || parent.shadowOf) return undefined;
		const own = ownFormSelectionIndex(doc, parent.uuid);
		if (own === undefined) return undefined;
		const id = formCaseSelections(doc, parent.uuid)[own]?.uuid;
		const index = shared.selections.findIndex(
			(row) => row.kind === "replace" && row.selection === id,
		);
		return index === -1 ? undefined : index;
	}
	if (doc.forms[formUuid]?.type === "registration") return undefined;
	const explicit = explicitFormCaseSelections(doc, formUuid);
	if (explicit !== undefined) {
		const menu = owningModule(doc, formUuid);
		const type = menu === undefined ? undefined : doc.modules[menu]?.caseType;
		const index = explicit.findLastIndex(
			(row) => row.source.kind === "choose" && row.caseType === type,
		);
		return index < 0 ? undefined : index;
	}
	const count = advancedLoadChain(doc, formUuid).length;
	return count === 0 ? undefined : count - 1;
}

/** Which record the shared questions execute against. An omitted parent choice
 * leaves the entry without an own record. A calculated replacement is singular. */
export function formEntryRecord(doc: BlueprintDoc, uuid: Uuid) {
	const form = doc.forms[uuid];
	const content = form?.shadowOf?.form ?? uuid;
	const owner = owningModule(doc, content);
	const menu = owner && doc.modules[owner];
	if (!form?.shadowOf || form.type === "registration")
		return {
			caseType: menu?.caseType,
			contentCaseType: menu?.caseType,
			menu,
			requiresCase: !!form && CASE_LOADING_FORM_TYPES.has(form.type),
		};
	const index = ownFormSelectionIndex(doc, uuid);
	const row =
		index === undefined
			? undefined
			: explicitFormCaseSelections(doc, uuid)?.[index];
	const list =
		row?.source.kind === "choose" ? doc.modules[row.source.module] : undefined;
	return {
		caseType: row?.caseType,
		contentCaseType: menu?.caseType,
		menu: list,
		requiresCase: !!row && CASE_LOADING_FORM_TYPES.has(form.type),
	};
}

/** Resolve each replacement from its parent's identity, which keeps its
 * original tag when the entry moves it or chooses a different case type. */
export function explicitFormCaseSelections(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly FormCaseSelection[] | undefined {
	const form = doc.forms[formUuid];
	if (!form?.shadowOf) return form?.caseSelections;
	const parent = doc.forms[form.shadowOf.form];
	if (!parent || parent.shadowOf) return [];
	const rows = new Map(
		formCaseSelections(doc, parent.uuid).map((row) => [row.uuid, row]),
	);
	return form.shadowOf.selections.flatMap((row) => {
		if (row.kind === "add") {
			const { kind: _kind, ...selection } = row;
			return [selection];
		}
		const original = rows.get(row.selection);
		return original
			? [{ ...original, caseType: row.caseType, source: row.source }]
			: [];
	});
}

/** The exact ordered entries a person sees before a form opens. The first edit
 * can store this projection as-is, keeping the allocated tags and UUIDs. */
export function formCaseSelections(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly FormCaseSelection[] {
	const form = doc.forms[formUuid];
	if (!form) return [];
	const explicit = explicitFormCaseSelections(doc, formUuid);
	if (explicit !== undefined) return explicit;
	const chain = advancedLoadChain(doc, formUuid);
	const tags = advancedLoadTags(doc, formUuid);
	const result: FormCaseSelection[] = chain.map((row, index) => {
		const previous = chain[index - 1];
		const tag = tags[index];
		if (!tag)
			throw new Error("An implicit case choice needs its allocated tag.");
		return {
			uuid: implicitFormSelectionId(formUuid, row.moduleUuid),
			name: doc.modules[row.moduleUuid]?.name ?? row.caseType,
			caseType: row.caseType,
			tag,
			source: {
				kind: "choose",
				module: row.moduleUuid,
				...(previous &&
					row.identifier && {
						under: {
							selection: implicitFormSelectionId(formUuid, previous.moduleUuid),
							identifier: row.identifier,
						},
					}),
			},
		};
	});
	const workerTag = tags[chain.length];
	if (workerTag)
		result.push({
			uuid: implicitFormSelectionId(formUuid, "worker-record"),
			name: "Worker’s record",
			caseType: USERCASE_CASE_TYPE,
			tag: workerTag,
			source: { kind: "worker-record" },
		});
	return result;
}

/** The declared tag a physical advanced load has in this version. */
export function emittedSelectionTag(
	doc: BlueprintDoc,
	formUuid: Uuid,
	selection: Uuid,
): string | undefined {
	const module = owningModule(doc, formUuid);
	if (!module || !menuEmittedAdvanced(doc, module)) return undefined;
	return formCaseSelections(doc, formUuid).find((row) => row.uuid === selection)
		?.tag;
}

/** A previously published choice still drawn from the menu keeps its tag. */
export function heldImplicitSelectionTag(
	doc: BlueprintDoc,
	form: Uuid,
	menu: Uuid | "worker-record",
): string | undefined {
	return doc.forms[form]?.heldSelectionTags?.[
		implicitFormSelectionId(form, menu)
	];
}

/** A placement target names a form selection by UUID. Legacy menu references can
 * identify a selection only when exactly one choice uses that list. */
export function chainLoadOfTarget(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: CaseOperation["target"] | null | undefined,
): number | undefined {
	if (target?.kind === "session") return ownFormSelectionIndex(doc, formUuid);
	if (
		target?.kind !== "expression" ||
		target.expr.kind !== "term" ||
		target.expr.term.kind !== "session-datum"
	)
		return undefined;
	const ref = target.expr.term.datum;
	const explicit = explicitFormCaseSelections(doc, formUuid);
	if (explicit) {
		const positions = explicit.flatMap((row, index) =>
			(ref.kind === "form-selection" && row.uuid === ref.selection) ||
			(ref.kind === "selected-case" &&
				row.source.kind === "choose" &&
				row.source.module === ref.module)
				? [index]
				: [],
		);
		return positions.length === 1 ? positions[0] : undefined;
	}
	const chain = advancedLoadChain(doc, formUuid);
	const index = chain.findIndex((row) =>
		ref.kind === "selected-case"
			? row.moduleUuid === ref.module
			: ref.kind === "form-selection" &&
				implicitFormSelectionId(formUuid, row.moduleUuid) === ref.selection,
	);
	return index < 0 ? undefined : index;
}

/** A shared entry can load another type into a parent selection. The parent
 * still defines every operation and how to read the answer that feeds it. */
export function entryOperationCaseType(
	doc: BlueprintDoc,
	entryUuid: Uuid,
	op: CaseOperation,
): string | undefined {
	const shared = doc.forms[entryUuid]?.shadowOf;
	const contentUuid = shared?.form ?? entryUuid;
	const original = operationCaseType(doc, contentUuid, op);
	const parent = doc.forms[contentUuid];
	if (!shared || !parent || parent.shadowOf || op.action === "create")
		return original;
	if (op.action === "own" || op.target.kind === "session")
		return formEntryRecord(doc, entryUuid).caseType;
	const index =
		op.target.kind === "worker-record"
			? sharedWorkerSelectionIndex(doc, parent, op)
			: chainLoadOfTarget(doc, parent.uuid, op.target);
	if (index === undefined) return original;
	const selection = formCaseSelections(doc, parent.uuid)[index]?.uuid;
	return shared.selections.find(
		(row) => row.kind === "replace" && row.selection === selection,
	)?.caseType;
}

/** The parent's worker update can be an independent XForm block, or an
 * update of an opening choice. Only the latter follows a replacement. */
function sharedWorkerSelectionIndex(
	doc: BlueprintDoc,
	parent: Form,
	op: CaseOperation,
): number | undefined {
	const facts = caseSlotFacts(doc, parent.uuid);
	if (heldWorkerBlockExpresses(facts, op)) return undefined;
	const load = advancedLoadOf(facts, op);
	if (!load || loadClause(facts, op, load) !== undefined) return undefined;
	return load.kind === "chain"
		? load.index
		: advancedLoadChain(doc, parent.uuid).length;
}

/** The worker update in a shared XForm still reads its parent's session
 * leaf when the entry selects another worker or another kind of record. */
export function sharedWorkerTarget(
	doc: BlueprintDoc,
	entryUuid: Uuid,
	op: CaseOperation,
): Uuid | undefined {
	const shared = doc.forms[entryUuid]?.shadowOf;
	const parent = shared && doc.forms[shared.form];
	if (!shared || !parent || parent.shadowOf || !isWorkerRecordUpdate(op))
		return undefined;
	const index = sharedWorkerSelectionIndex(doc, parent, op);
	if (index === undefined) return undefined;
	const id = formCaseSelections(doc, parent.uuid)[index]?.uuid;
	if (
		shared.selections.some(
			(row) =>
				row.kind === "replace" &&
				row.selection === id &&
				row.source.kind !== "worker-record",
		)
	)
		return id;
	return undefined;
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
	if (operation.action === "own") {
		const index = ownFormSelectionIndex(f.doc, f.formUuid);
		return !f.registration && index !== undefined
			? { kind: "chain", index }
			: undefined;
	}
	if (isWorkerRecordUpdate(operation) && f.form.caseSelections !== undefined) {
		const positions = f.form.caseSelections.flatMap((row, index) =>
			row.source.kind === "worker-record" ? [index] : [],
		);
		return positions.length === 1 && positions[0] !== undefined
			? { kind: "chain", index: positions[0] }
			: undefined;
	}
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

/** A passive label's submitted value is ordinary text. Keep its Advanced load
 * away from the case facets and properties HQ routes to dedicated columns. */
export function isAdvancedOwnLabelProperty(property: string): boolean {
	return (
		property !== "hq_user_id" &&
		!isReservedCaseOperationWrite({ property }) &&
		!isWritableStandardCaseProperty(property)
	);
}

function readsOwnPassiveLabel(
	f: CaseSlotFacts,
	write: CaseOperationWrite,
): boolean {
	if (
		write.via !== undefined ||
		write.onlyIfChanged ||
		!isAdvancedOwnLabelProperty(write.property)
	)
		return false;
	const source = caseWriteValueField(write.value);
	if (source === undefined || source.link) return false;
	const field = f.doc.fields[source.field];
	return (
		field?.kind === "label" &&
		field.askForConfirmation !== true &&
		field.banner === undefined &&
		field.default_value === undefined &&
		!f.form.openingAssignments?.some(({ field }) => field === source.field) &&
		f.doc.fieldOrder[f.formUuid]?.includes(source.field) === true &&
		f.submittedChildren.get(f.formUuid)?.includes(source.field) === true
	);
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

/** An expression can target the same load as the own update. Keep a close
 * on that record separate so the load continues to read as a follow-up. */
function loadCarriesOwnPassiveLabel(
	f: CaseSlotFacts,
	load: Extract<AdvancedLoadRef, { kind: "chain" }>,
): boolean {
	const own = f.own;
	return (
		own !== undefined &&
		f.form.type === "followup" &&
		ownFormSelectionIndex(f.doc, f.formUuid) === load.index &&
		!f.positionedOperations.has(own.uuid) &&
		!heldOwnOrCreateBlockExpresses(f, own) &&
		own.writes?.some((write) => readsOwnPassiveLabel(f, write)) === true &&
		loadClause(f, own, load) === undefined
	);
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
	// A conditioned direct worker update must keep its conditional source
	// block even when its authored condition is a constant match-all.
	if (isWorkerRecordUpdate(operation) && operation.condition !== undefined)
		return "write-condition";
	const writes = operation.writes ?? [];
	const name =
		operation.action === "own"
			? operation.name
			: operation.action === "update"
				? operation.rename
				: undefined;
	const ownFollowup =
		operation.action === "own" &&
		f.form.type === "followup" &&
		!f.severalCases &&
		load.kind === "chain" &&
		f.module?.caseType !== USERCASE_CASE_TYPE;
	if (
		(name !== undefined && !readsQuestion(f, name, undefined)) ||
		writes.some(
			(write) =>
				!readsQuestion(f, write.value, undefined) &&
				!(ownFollowup && readsOwnPassiveLabel(f, write)),
		)
	)
		return "value-not-a-question";
	if (
		writes.some((write) => write.condition !== undefined) ||
		(operation.action === "update" &&
			operation.condition !== undefined &&
			operation.condition.kind !== "match-all")
	)
		return "write-condition";
	if (operation.action === "close") {
		if (!stateable(f, operation.condition, undefined))
			return "condition-not-stateable";
		if (load.kind === "chain" && loadCarriesOwnPassiveLabel(f, load))
			return "scope";
	}
	if (
		load.kind === "chain" &&
		(f.form.caseSelections === undefined
			? load.index > 0
			: f.form.caseSelections[load.index]?.source.kind === "choose" &&
				"under" in (f.form.caseSelections[load.index]?.source ?? {})) &&
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
	if (operation.ownerAfterCreate !== undefined) return "write-condition";
	const repeat =
		operation.action === "create" ? operation.forEach?.repeat : undefined;
	if (
		operation.action === "create" &&
		operation.target.kind === "new" &&
		(operation.target.idFrom !== undefined ||
			operation.target.expr !== undefined)
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
		f.registration && f.form.caseSelections === undefined
			? undefined
			: chainLoadOfTarget(f.doc, f.formUuid, target);
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
			op.ownerAfterCreate === undefined &&
			op.forEach === undefined &&
			op.target.kind === "new" &&
			op.target.idFrom === undefined &&
			op.target.expr === undefined
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
	target: ResolvedFormLinkTarget,
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
	target: ResolvedFormLinkTarget,
): boolean {
	if (!projectedModulePreorder(doc).includes(target.moduleUuid)) return false;
	return (
		target.type === "module" ||
		(doc.formOrder[target.moduleUuid] ?? []).includes(target.formUuid)
	);
}

const carried = new WeakMap<BlueprintDoc, Map<Uuid, ReadonlyMap<Uuid, Uuid>>>();

/**
 * The creates of `formUuid` that its after-submit links (its destinations
 * and its otherwise link, `forms.ts::formLinkEntries`) carry into a target,
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
	const form = doc.forms[formUuid];
	const links =
		form === undefined
			? []
			: formLinkEntries(form).map(({ link }) => ({
					uuid: link.uuid,
					condition: "condition" in link ? link.condition : undefined,
					datums: link.datums,
					target: resolveFormLinkTarget(doc, formUuid, link.target),
				}));
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
		const target = link.target;
		if (
			link.datums === undefined &&
			target !== undefined &&
			linkTargetResolves(doc, target)
		) {
			let unused = [...source];
			for (const datum of targetSelections(doc, target)) {
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
	| { readonly kind: "several-map-locations" }
	| { readonly kind: "detail-tile-tabs" }
	| { readonly kind: "form-entry"; readonly formUuid: Uuid }
	| { readonly kind: "list-entry" }
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
	if (hasSeveralCaseMapLocations(module.caseListConfig))
		found.push({ kind: "several-map-locations" });
	if (module.heldKind === "advanced") found.push({ kind: "held" });
	if (detailTileSharesRowAcrossTabs(module.caseListConfig))
		found.push({ kind: "detail-tile-tabs" });
	if (module.autoSelectSingle || module.caseType === USERCASE_CASE_TYPE)
		found.push({ kind: "list-entry" });
	for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
		const form = doc.forms[formUuid];
		// A second entry never makes its menu advanced: it needs a menu that
		// already is, as its own validation states.
		if (!form || form.shadowOf) continue;
		if (usesFormEntryActions(form))
			found.push({ kind: "form-entry", formUuid });
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
	if (operationSavesOnlyChanged(operation)) return false;
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

/** The actions of an advanced form, with the tag each takes from a held
 *  placement (`placement.ts::planAdvancedCore`'s `attach`: an action takes
 *  the held tag of the first change it carries whose tag no earlier change
 *  took). */
interface EntryActionPlan {
	readonly actions: AdvancedEntryActions;
	/** By chain load, root first. */
	readonly chainHeld: readonly (string | undefined)[];
	readonly workerHeld: string | undefined;
	/** By open action, in `opens` order. */
	readonly openHeld: readonly (string | undefined)[];
}

const actions = new WeakMap<BlueprintDoc, Map<Uuid, EntryActionPlan>>();

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
	const shared = doc.forms[formUuid]?.shadowOf;
	if (shared && doc.forms[shared.form] && !doc.forms[shared.form].shadowOf) {
		return {
			opens: entryActionPlan(doc, shared.form).actions.opens,
			workerLoad:
				explicitFormCaseSelections(doc, formUuid)?.some(
					(row) => row.source.kind === "worker-record",
				) ?? false,
		};
	}
	return entryActionPlan(doc, formUuid).actions;
}

function entryActionPlan(doc: BlueprintDoc, formUuid: Uuid): EntryActionPlan {
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
	let workerLoad = opensWithWorkerValue(doc.forms[formUuid]);
	const chainHeld: (string | undefined)[] = advancedLoadChain(
		doc,
		formUuid,
	).map((load) => heldImplicitSelectionTag(doc, formUuid, load.moduleUuid));
	let workerHeld = heldImplicitSelectionTag(doc, formUuid, "worker-record");
	const openHeld: (string | undefined)[] = [];
	const usedHeld = new Set(
		[
			...(f.form.caseSelections ?? []).map((row) => row.tag),
			...chainHeld,
			workerHeld,
		].filter((tag) => tag !== undefined),
	);
	const heldTagOf = (op: CaseOperation): string | undefined => {
		const held = op.placement;
		if (held?.kind !== "advanced" || usedHeld.has(held.tag)) return undefined;
		usedHeld.add(held.tag);
		return held.tag;
	};
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
			if (load.kind === "worker") {
				workerLoad = true;
				workerHeld ??= heldTagOf(op);
			} else if (chainHeld[load.index] === undefined)
				chainHeld[load.index] = heldTagOf(op);
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
			openHeld.push(heldTagOf(op));
			view.set(op.uuid, { repeat, indexed: (op.links ?? []).length > 0 });
			opened.add(op.uuid);
		}
	}
	const result: EntryActionPlan = {
		actions: { opens, workerLoad },
		chainHeld,
		workerHeld,
		openHeld,
	};
	forms.set(formUuid, result);
	return result;
}

/** Every element name the form's data root holds that a load's
 *  `case_<tag>` block must not take (`placement.ts::advancedRootNames`): its
 *  root questions' ids, its Connect block ids, and the first segment of each
 *  Save to Case block held at the root, the own close's included. */
function advancedRootNames(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlySet<string> {
	const names = new Set<string>();
	for (const uuid of doc.fieldOrder[formUuid] ?? []) {
		const field = doc.fields[uuid];
		if (field !== undefined) names.add(field.id);
	}
	const form = doc.forms[formUuid];
	for (const op of form?.caseOperations ?? [])
		if (
			op.placement?.kind === "save-to-case" &&
			op.placement.repeat === undefined
		)
			names.add(op.placement.path[0]);
	if (form?.ownClosePlacement !== undefined)
		names.add(form.ownClosePlacement.path[0]);
	return names;
}

const tagsByDoc = new WeakMap<BlueprintDoc, Map<Uuid, readonly string[]>>();

/**
 * The tag of each load of `formUuid` planned as an advanced form, in
 * `load_update_cases` order: the chain's, root first, then the worker's where
 * a change takes it, as `placement.ts::planAdvancedCore` tags them
 * (`advancedTags.ts::allocateAdvancedTags`). A load gives the form's entry the
 * datum `case_id_<tag>` (`models/form_actions.py::LoadUpdateAction.case_session_var`),
 * so the first tag names the first case the entry asks for, unless the load is
 * aligned with a root menu's. Loads are tagged before every open action, so an
 * open action counts only by the held tag it takes.
 */
export function advancedLoadTags(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly string[] {
	const explicit = explicitFormCaseSelections(doc, formUuid);
	if (explicit) return explicit.map((row) => row.tag);
	let forms = tagsByDoc.get(doc);
	if (forms === undefined) {
		forms = new Map();
		tagsByDoc.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const plan = entryActionPlan(doc, formUuid);
	const chain = advancedLoadChain(doc, formUuid);
	const tags = allocateAdvancedTags({
		loads: [
			...chain.map((load, index) => ({
				caseType: load.caseType,
				worker: false,
				held: plan.chainHeld[index],
			})),
			...(plan.actions.workerLoad
				? [
						{
							caseType: USERCASE_CASE_TYPE,
							worker: true,
							held: plan.workerHeld,
						},
					]
				: []),
		],
		opens: plan.actions.opens.flatMap((open, index) => {
			const held = plan.openHeld[index];
			return held === undefined ? [] : [{ caseType: open.caseType, held }];
		}),
		rootNames: advancedRootNames(doc, formUuid),
	}).loads;
	forms.set(formUuid, tags);
	return tags;
}

/** HQ's advanced entry confirms the record when its list has a long detail
 * and the last action referring to this choice is not another load. HQ
 * builds the load rows first and the opens next, so an open wins. */
export function formSelectionShowsConfirm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	index: number,
): boolean {
	const rows = formCaseSelections(doc, formUuid);
	const choice = rows[index];
	if (choice?.source.kind !== "choose") return false;
	const list = doc.modules[choice.source.module];
	if (
		!(list?.caseListConfig?.columns ?? []).some(
			(row) => row.visibleInDetail !== false,
		)
	)
		return false;
	const narrowed = rows.some(
		(row) =>
			row.source.kind === "choose" &&
			row.source.under?.selection === choice.uuid,
	);
	if (!narrowed) return true;
	const opens = new Set(
		advancedEntryActions(doc, formUuid).opens.map((row) => row.operationUuid),
	);
	return (doc.forms[formUuid]?.caseOperations ?? []).some(
		(op) =>
			opens.has(op.uuid) &&
			(op.links ?? []).some(
				(link) => chainLoadOfTarget(doc, formUuid, link.target) === index,
			),
	);
}

/** Ordinary form formulas name the same supply the picker shows. A stable UUID
 * disambiguates two identical labels and can also be pasted into a formula. */
export function namedEntrySupplies(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly {
	ref: Extract<
		import("./expression/types").DatumRef,
		{ kind: "form-selection" | "entry-value" }
	>;
	name: string;
	uuid: Uuid;
}[] {
	return [
		...formCaseSelections(doc, formUuid).map((row) => ({
			ref: { kind: "form-selection" as const, selection: row.uuid },
			name: row.name,
			uuid: row.uuid,
		})),
		...(doc.forms[formUuid]?.computedDatums ?? []).map((row) => ({
			ref: { kind: "entry-value" as const, datum: row.uuid },
			name: row.key,
			uuid: row.uuid,
		})),
	];
}

export function namedEntrySupplyRead(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ref: import("./expression/types").DatumRef,
): string | undefined {
	if (ref.kind !== "form-selection" && ref.kind !== "entry-value")
		return undefined;
	const uuid = ref.kind === "form-selection" ? ref.selection : ref.datum;
	const supplies = namedEntrySupplies(doc, formUuid).filter(
		(row) => row.ref.kind === ref.kind,
	);
	const supply = supplies.find((row) => row.uuid === uuid);
	if (!supply) return undefined;
	const name = supply.name;
	const safeName =
		supplies.filter((row) => row.name === name || row.uuid === name).length ===
			1 && !(name.includes("'") && name.includes('"'))
			? name
			: uuid;
	const quote = safeName.includes("'") ? '"' : "'";
	return (
		(ref.kind === "form-selection" ? "opening-record" : "opening-value") +
		"(" +
		quote +
		safeName +
		quote +
		")"
	);
}

/** Allocate a selection tag once. Subsequent edits use this stored tag. */
export function newFormSelectionTag(
	doc: BlueprintDoc,
	formUuid: Uuid,
	name: string,
): string {
	const form = doc.forms[formUuid];
	const taken = new Set(
		[
			...formCaseSelections(doc, formUuid),
			...(form?.shadowOf ? formCaseSelections(doc, form.shadowOf.form) : []),
		].map((row) => row.tag),
	);
	for (const op of form?.caseOperations ?? [])
		if (op.placement?.kind === "advanced") taken.add(op.placement.tag);
	for (const row of form?.computedDatums ?? [])
		if (row.key.startsWith("case_id_"))
			taken.add(row.key.slice("case_id_".length));
	return uniqueSlug(`use_${name}`, "use_record", taken);
}
