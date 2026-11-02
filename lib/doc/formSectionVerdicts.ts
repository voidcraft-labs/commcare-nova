// lib/doc/formSectionVerdicts.ts
//
// The pure readers and the ONE placement verdict behind form sections.
//
// A section is a page of a form, and "a sectioned form" is a closed state
// the validator holds with three rules (`FORM_SECTION_NOT_TOP_LEVEL`,
// `FORM_SECTIONS_INCOMPLETE`, `FORM_SECTION_USER_REPEAT`). The drag gate and
// the SA's `add_fields` / `move_field` pre-checks ask `fieldPlacementVerdict`
// before a batch is built, so those refusals are explained up front in one
// sentence. The keyboard move and the inspector's move menu build their
// batch directly and meet the commit gate's refusal instead. The commit gate
// stays the authority for every editor.

import { produce } from "immer";
import {
	type BlueprintDoc,
	entityTargetKey,
	type Field,
	type FieldKind,
	formOfField,
	isContainer,
	type Uuid,
} from "@/lib/domain";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { shareInferenceAcrossMove } from "@/lib/domain/expression/inference";
import { expressionSlotLabel } from "@/lib/domain/expression/slotLabels";
import {
	type CheckError,
	checkExpression,
} from "@/lib/domain/expression/typeChecker";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import {
	expressionAt,
	type ProseRead,
	prosePartTerm,
	proseReadSlotRef,
	proseSurfaceReads,
} from "@/lib/domain/expressionSource";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import { projectFormExpression } from "./expressionText";
import { planFieldMoveCaseWrites } from "./fieldCaseWriteMutations";
import { orderedFieldUuids } from "./fieldWalk";
import { applyMutations } from "./mutations";
import { referencingCarrierUuids } from "./referenceIndex";

/** The root sections of `formUuid`, in page order. */
export function formSectionsOf(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly Uuid[] {
	return orderedFieldUuids(doc, formUuid).filter(
		(uuid) => doc.fields[uuid]?.kind === "section",
	);
}

/** Whether `formUuid` is split into sections (its root holds one). */
export function formIsSectioned(doc: BlueprintDoc, formUuid: Uuid): boolean {
	return orderedFieldUuids(doc, formUuid).some(
		(uuid) => doc.fields[uuid]?.kind === "section",
	);
}

export { formOfField } from "@/lib/domain/fieldForm";

/**
 * The nearest section ABOVE `fieldUuid` (never the field itself): the page
 * it is on, or `undefined` when it sits outside every section.
 */
export function sectionOf(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): Uuid | undefined {
	let cursor = doc.fieldParent[fieldUuid];
	const seen = new Set<Uuid>();
	while (cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		const field: Field | undefined = doc.fields[cursor];
		if (field === undefined) return undefined;
		if (field.kind === "section") return cursor;
		cursor = doc.fieldParent[cursor];
	}
	return undefined;
}

/** The page `parentUuid` lands on: itself when it is a section, else the
 *  section above it, else `undefined` (the form root or a sectionless
 *  subtree). */
export function landingSectionOf(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): Uuid | undefined {
	if (doc.fields[parentUuid]?.kind === "section") return parentUuid;
	return sectionOf(doc, parentUuid);
}

/**
 * Whether `fieldUuid` is, or holds at any depth, a repeat the worker grows
 * by hand. That is the one field a section cannot hold: a field-list is one
 * screen, and the CommCare app adds repeat entries only from a screen of
 * its own.
 */
export function subtreeHasUserRepeat(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): boolean {
	const stack: Uuid[] = [fieldUuid];
	const seen = new Set<Uuid>();
	while (stack.length > 0) {
		const uuid = stack.pop();
		if (uuid === undefined) break;
		if (seen.has(uuid)) continue;
		seen.add(uuid);
		const field = doc.fields[uuid];
		if (field === undefined) continue;
		if (field.kind === "repeat" && field.repeat_mode === "user_controlled") {
			return true;
		}
		if (isContainer(field)) stack.push(...orderedFieldUuids(doc, uuid));
	}
	return false;
}

type SectionPlacementRefusal =
	| "loose-field-in-sectioned-form"
	| "section-not-root"
	| "section-other-form"
	| "user-repeat-in-section";

export type FieldPlacementRefusal =
	| SectionPlacementRefusal
	| "expression-no-path"
	| "expression-many-values"
	| "expression-invalid-after-move"
	| "case-write-placement";

export type FieldPlacementVerdict =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: FieldPlacementRefusal;
			/** Nova voice: one sentence of what and one of what to do. The
			 *  SA tools return it verbatim, so the three editors say one thing. */
			readonly message: string;
	  };

/** The four section refusal messages, one home. The expression refusals
 *  name the moved question and its reader, so they are composed per move. */
export const FIELD_PLACEMENT_MESSAGES: Readonly<
	Record<SectionPlacementRefusal, string>
> = {
	"loose-field-in-sectioned-form":
		"This form is split into sections, so a question belongs inside one. Add it to a section, or remove the sections first.",
	"section-not-root":
		"A section is a page of the form, so it can only sit at the form's top level.",
	"section-other-form":
		"A section belongs to the form it pages. Add a section to that form instead of moving this one.",
	"user-repeat-in-section":
		"A section shows on one screen, and the CommCare app can't add repeat entries there. Keep this repeat outside the sections, or give it a fixed count.",
};

const OK: FieldPlacementVerdict = { ok: true };

function refuse(reason: SectionPlacementRefusal): FieldPlacementVerdict {
	return { ok: false, reason, message: FIELD_PLACEMENT_MESSAGES[reason] };
}

export interface FieldPlacementArgs {
	/** The existing field that would move; absent for a field being added. */
	readonly uuid?: Uuid;
	readonly kind: FieldKind;
	/** Where it lands: a form uuid (the root) or a container field uuid. */
	readonly toParentUuid: Uuid;
	/** For a field being ADDED: whether it is (or carries) an add-entries
	 *  repeat. For an existing field this is read from the document when
	 *  omitted. */
	readonly subtreeHasUserRepeat?: boolean;
}

/**
 * May a field of `kind` (an existing `uuid`, or one being added) land under
 * `toParentUuid`? Checks section placement, then, for an existing field
 * moving to a new parent in its own form, every expression and prose
 * reference whose path or context the move changes: the moved subtree's own
 * slots and every slot that reads a field in it. A refusal is a finding the
 * checker raises after the move and not before it, such as a reader left
 * without a path, or a one-value reader that would read every entry of a
 * repeat. The question is asked once per destination parent, so a finding
 * that depends on the field's position among its new siblings is left to the
 * commit gate, which stays authoritative for the complete candidate
 * document.
 */
export function fieldPlacementVerdict(
	doc: BlueprintDoc,
	args: FieldPlacementArgs,
): FieldPlacementVerdict {
	const section = sectionPlacementVerdict(doc, args);
	if (!section.ok || args.uuid === undefined) return section;
	return expressionPlacementVerdict(doc, args.uuid, args.toParentUuid);
}

function sectionPlacementVerdict(
	doc: BlueprintDoc,
	args: FieldPlacementArgs,
): FieldPlacementVerdict {
	const { uuid, kind, toParentUuid } = args;
	const landsOnForm = doc.forms[toParentUuid] !== undefined;

	if (kind === "section") {
		if (!landsOnForm) return refuse("section-not-root");
		if (uuid !== undefined) {
			const home = formOfField(doc, uuid);
			if (home !== undefined && home !== toParentUuid) {
				return refuse("section-other-form");
			}
		}
		return OK;
	}

	if (landsOnForm) {
		// The root of a sectioned form holds sections only. A field already
		// sitting loose there is a state the gate refused; refusing its
		// re-anchoring at the same root keeps the answer honest.
		return formIsSectioned(doc, toParentUuid)
			? refuse("loose-field-in-sectioned-form")
			: OK;
	}

	if (landingSectionOf(doc, toParentUuid) === undefined) return OK;
	const carriesUserRepeat =
		args.subtreeHasUserRepeat ??
		(uuid !== undefined ? subtreeHasUserRepeat(doc, uuid) : false);
	return carriesUserRepeat ? refuse("user-repeat-in-section") : OK;
}

const expressionPlacements = new WeakMap<
	BlueprintDoc,
	Map<Uuid, Map<Uuid, FieldPlacementVerdict>>
>();

function expressionOwner(
	doc: BlueprintDoc,
	uuid: string,
): ExpressionCarrierRef | undefined {
	const field = doc.fields[uuid];
	if (field !== undefined) return { entity: "field", uuid: field.uuid };
	const form = doc.forms[uuid];
	if (form !== undefined) return { entity: "form", uuid: form.uuid };
	const module = doc.modules[uuid];
	return module === undefined
		? undefined
		: { entity: "module", uuid: module.uuid };
}

/** How a refusal names what moves and what it breaks: the moved question
 *  and the reader's slot, in the words the builder shows. */
function moveWords(doc: BlueprintDoc, moved: Uuid, slot: SlotContextRef) {
	const reader =
		slot.entity === "field"
			? doc.fields[slot.uuid]?.id
			: slot.entity === "form"
				? doc.forms[slot.uuid]?.name
				: doc.modules[slot.uuid]?.name;
	return {
		question: doc.fields[moved]?.id ?? "this question",
		reader: reader ?? "this reader",
		label: expressionSlotLabel(slot.slot),
	};
}

function noPath(
	doc: BlueprintDoc,
	moved: Uuid,
	slot: SlotContextRef,
): FieldPlacementVerdict {
	const { question, reader, label } = moveWords(doc, moved, slot);
	return {
		ok: false,
		reason: "expression-no-path",
		message: `Moving "${question}" here would leave "${reader}"'s ${label} without a path to it. Change that formula before moving the question.`,
	};
}

function contextLost(
	doc: BlueprintDoc,
	moved: Uuid,
	slot: SlotContextRef,
): FieldPlacementVerdict {
	const { question, reader, label } = moveWords(doc, moved, slot);
	return {
		ok: false,
		reason: "expression-invalid-after-move",
		message: `Moving "${question}" here would leave "${reader}"'s ${label} without a place in the form to run. You can move the question somewhere else, or change that ${label} first.`,
	};
}

/** A new checker finding, in the checker's own sentence after a lead that
 *  names the move and the reader it changes. */
function newFinding(
	doc: BlueprintDoc,
	moved: Uuid,
	slot: SlotContextRef,
	issue: CheckError,
): FieldPlacementVerdict {
	if (issue.reason === "form-filter-step") return noPath(doc, moved, slot);
	const { question, reader, label } = moveWords(doc, moved, slot);
	return {
		ok: false,
		reason:
			issue.code === "many-values"
				? "expression-many-values"
				: "expression-invalid-after-move",
		message: `Moving "${question}" here changes "${reader}"'s ${label}. ${issue.message}`,
	};
}

/** A finding whose truth depends on the moved field's position among its
 *  new siblings: a choice filter that reads an answer not yet given. The
 *  candidate places the field first under its new parent, which is not the
 *  position the move names, so only the commit gate can judge it. */
function dependsOnSiblingPosition(issue: CheckError): boolean {
	return issue.reason === "field-not-earlier";
}

/** A finding's identity across the move: what went wrong and where, never
 *  its sentence, which prints current paths and so changes with the move. */
function findingKey(issue: CheckError, part = 0): string {
	return JSON.stringify([part, issue.code, issue.reason ?? null, issue.path]);
}

/** Only affected carriers are read: inbound references to the moved subtree,
 * plus that subtree's own expressions and prose, whose evaluation context
 * also moves. Running the production move keeps generated nodes and reverse
 * maps exact. The slot checker supplies every semantic refusal; this layer
 * adds no rule. The candidate places the field first under its new parent,
 * so a finding that reads sibling order is set aside here; the commit gate
 * judges the position the move actually names. */
function expressionPlacementVerdict(
	doc: BlueprintDoc,
	uuid: Uuid,
	toParentUuid: Uuid,
): FieldPlacementVerdict {
	if (doc.fields[uuid] === undefined || doc.fieldParent[uuid] === toParentUuid)
		return OK;
	const home = formOfField(doc, uuid);
	const destination =
		doc.forms[toParentUuid] === undefined
			? formOfField(doc, toParentUuid)
			: toParentUuid;
	// Other move admission owns cross-form and malformed destinations.
	if (home === undefined || destination !== home) return OK;
	const cached = expressionPlacements.get(doc)?.get(uuid)?.get(toParentUuid);
	if (cached !== undefined) return cached;
	const subtree = new Set<Uuid>();
	const pending = [uuid];
	while (pending.length > 0) {
		const field = pending.pop();
		if (field === undefined || subtree.has(field)) continue;
		subtree.add(field);
		pending.push(...orderedFieldUuids(doc, field));
	}
	if (subtree.has(toParentUuid)) return OK;
	const carriers = new Set<string>(subtree);
	for (const field of subtree) {
		for (const carrier of referencingCarrierUuids(
			doc,
			entityTargetKey(field),
		)) {
			carriers.add(carrier);
		}
	}
	// The move as every editor batches it: a write of the moved subtree to a
	// case the form creates in one repeat follows it to the create of its new
	// repeat. A re-home the planner refuses (a new case left without the
	// question that names it) is the move's refusal, in the planner's
	// sentence. Every other case write the move changes reads the moved
	// answer, and the slot checker judges it with every other reader (a write
	// of the form's own case reading inside a repeat is its `many-values`).
	const rehoming = planFieldMoveCaseWrites(doc, uuid, toParentUuid);
	if (!rehoming.ok)
		return {
			ok: false,
			reason: "case-write-placement",
			message: rehoming.message,
		};
	const rehomed = rehoming.mutations;
	const candidate = produce(doc, (draft) => {
		applyMutations(draft, [
			{ kind: "moveField", uuid, toParentUuid, after: null },
			...rehomed,
		]);
	});
	// A move no inferred fact reads the position of keeps the document's
	// inference, so the candidate's slots skip deriving it again. A move
	// that re-homes writes changes operations too, so its candidate derives
	// its own.
	if (rehomed.length === 0) shareInferenceAcrossMove(doc, candidate, subtree);
	// A structural move changes no external definition, so an empty lookup
	// index answers the same before and after. A finding it raises is
	// identical on both sides, and a lookup's own `where` goes unread here;
	// the commit gate reads it with the real tables.
	const lookup: LookupTypeIndex = new Map();
	const verdict = firstRefusal(doc, candidate, uuid, carriers, lookup);
	let byField = expressionPlacements.get(doc);
	if (byField === undefined) {
		byField = new Map();
		expressionPlacements.set(doc, byField);
	}
	let byDestination = byField.get(uuid);
	if (byDestination === undefined) {
		byDestination = new Map();
		byField.set(uuid, byDestination);
	}
	byDestination.set(toParentUuid, verdict);
	return verdict;
}

/** A prose read's whole identity: its slot and every index of its place
 *  in the field, so a read before the move is compared with the same read
 *  after it. */
function proseReadKey(read: Pick<ProseRead, "slot" | "indices">): string {
	return JSON.stringify([read.slot, read.indices]);
}

function firstRefusal(
	doc: BlueprintDoc,
	candidate: BlueprintDoc,
	moved: Uuid,
	carriers: ReadonlySet<string>,
	lookup: LookupTypeIndex,
): FieldPlacementVerdict {
	for (const carrier of carriers) {
		const owner = expressionOwner(candidate, carrier);
		if (owner === undefined) continue;
		for (const { ref, expression } of expressionSlotValues(candidate, owner)) {
			const context = slotContext(candidate, ref, lookup);
			const beforeContext = slotContext(doc, ref, lookup);
			if (beforeContext === undefined) continue;
			if (context === undefined) return contextLost(doc, moved, ref);
			if (context.ruleSet === "form") {
				const beforeExpression = expressionAt(doc, ref) ?? expression;
				const before = projectFormExpression(
					doc,
					ref,
					beforeExpression,
					"unavailable",
				);
				const after = projectFormExpression(
					candidate,
					ref,
					expression,
					"unavailable",
				);
				const known = new Set(
					before.unresolved.map((issue) => JSON.stringify(issue)),
				);
				if (after.unresolved.some((issue) => !known.has(JSON.stringify(issue))))
					return noPath(doc, moved, ref);
			}
			const before = new Set(
				checkExpression(
					expressionAt(doc, ref) ?? expression,
					beforeContext,
				).errors.map((issue) => findingKey(issue)),
			);
			const issue = checkExpression(expression, context).errors.find(
				(error) =>
					!dependsOnSiblingPosition(error) && !before.has(findingKey(error)),
			);
			if (issue !== undefined) return newFinding(doc, moved, ref, issue);
		}
		if (owner.entity !== "field") continue;
		const field = candidate.fields[owner.uuid];
		const previous = doc.fields[owner.uuid];
		if (field === undefined || previous === undefined) continue;
		for (const read of proseSurfaceReads(field, candidate)) {
			const ref = proseReadSlotRef(field, read);
			if (ref === undefined) continue;
			const beforeContext = slotContext(doc, ref, lookup);
			if (beforeContext === undefined) continue;
			const context = slotContext(candidate, ref, lookup);
			if (context === undefined) return contextLost(doc, moved, ref);
			const before = new Set<string>();
			for (const prior of proseSurfaceReads(previous, doc)) {
				if (proseReadKey(prior) !== proseReadKey(read)) continue;
				prior.template.parts.forEach((part, index) => {
					const term = prosePartTerm(part);
					if (term === undefined) return;
					for (const issue of checkExpression(
						{ kind: "term", term },
						beforeContext,
					).errors)
						before.add(findingKey(issue, index));
				});
			}
			for (const [index, part] of read.template.parts.entries()) {
				const term = prosePartTerm(part);
				if (term === undefined) continue;
				const issue = checkExpression(
					{ kind: "term", term },
					context,
				).errors.find(
					(error) =>
						!dependsOnSiblingPosition(error) &&
						!before.has(findingKey(error, index)),
				);
				if (issue !== undefined) return newFinding(doc, moved, ref, issue);
			}
		}
	}
	return OK;
}
