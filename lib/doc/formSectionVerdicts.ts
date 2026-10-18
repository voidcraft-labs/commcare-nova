// lib/doc/formSectionVerdicts.ts
//
// The pure readers and the ONE placement verdict behind form sections.
//
// A section is a page of a form, and "a sectioned form" is a closed state
// the validator holds with three rules (`FORM_SECTION_NOT_TOP_LEVEL`,
// `FORM_SECTIONS_INCOMPLETE`, `FORM_SECTION_USER_REPEAT`). Every surface
// that lets a field LAND somewhere — the drag gate, the keyboard move, the
// inspector's move menu, the SA's `add_fields` / `move_field` pre-checks —
// asks `fieldPlacementVerdict` first, so a refusal is explained before a
// batch is built and the three editors say one sentence. The commit gate
// stays the authority; this module exists so nobody meets it by surprise.

import { produce } from "immer";
import {
	type BlueprintDoc,
	entityTargetKey,
	type Field,
	type FieldKind,
	isContainer,
	type Uuid,
} from "@/lib/domain";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import { projectFormExpression } from "./expressionText";
import { orderedFieldUuids } from "./fieldWalk";
import { applyMutation } from "./mutations";
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

/** The form a field belongs to, walking `fieldParent` to the root. */
export function formOfField(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): Uuid | undefined {
	let cursor: Uuid | undefined = fieldUuid;
	const seen = new Set<Uuid>();
	while (cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		if (doc.forms[cursor] !== undefined) return cursor;
		cursor = doc.fieldParent[cursor];
	}
	return undefined;
}

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
	| "expression-invalid-after-move";

export type FieldPlacementVerdict =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: FieldPlacementRefusal;
			/** Nova voice: one sentence of what and one of what to do. The
			 *  SA tools return it verbatim, so the three editors say one thing. */
			readonly message: string;
	  };

/** The four refusal messages, one home. */
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
 * Checks section placement and the expressions whose paths or context change.
 * The commit gate stays authoritative for the complete candidate document.
 * May a field of `kind` (an existing `uuid`, or one being added) land under
 * `toParentUuid`? Sibling position is never the question — only the parent
 * decides — so a drag's placeholder, a keyboard move, the inspector, and a
 * tool pre-check all ask this once per destination.
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

const SLOT_LABELS: Partial<Record<ExpressionSlotRef["slot"], string>> = {
	relevant: "display condition",
	validate: "validation rule",
	calculate: "calculated value",
	default_value: "starting value",
	required: "required condition",
	repeat_count: "repeat count",
	ids_query: "case query",
	assessment_user_score: "assessment score",
	deliver_entity_id: "delivery identifier",
	deliver_entity_name: "delivery name",
};

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

function noPath(
	doc: BlueprintDoc,
	moved: Uuid,
	slot: ExpressionSlotRef,
): FieldPlacementVerdict {
	const reader =
		slot.entity === "field"
			? doc.fields[slot.uuid]?.id
			: slot.entity === "form"
				? doc.forms[slot.uuid]?.name
				: doc.modules[slot.uuid]?.name;
	const label = SLOT_LABELS[slot.slot] ?? "formula";
	return {
		ok: false,
		reason: "expression-no-path",
		message: `Moving "${doc.fields[moved]?.id ?? "this question"}" here would leave "${reader ?? "this reader"}"'s ${label} without a path to it. Change that formula before moving the question.`,
	};
}

/** Only affected carriers are read: inbound references to the moved subtree,
 * plus that subtree's own expressions, whose evaluation context also moves.
 * Running the production move keeps generated nodes and reverse maps exact.
 * The slot checker supplies every semantic refusal; this layer adds no rule. */
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
	const candidate = produce(doc, (draft) => {
		applyMutation(draft, {
			kind: "moveField",
			uuid,
			toParentUuid,
			after: null,
		});
	});
	let verdict: FieldPlacementVerdict = OK;
	const lookup: LookupTypeIndex = new Map();
	for (const carrier of carriers) {
		const owner = expressionOwner(doc, carrier);
		if (owner === undefined) continue;
		for (const { ref, expression } of expressionSlotValues(doc, owner)) {
			const context = slotContext(candidate, ref, lookup);
			const beforeContext = slotContext(doc, ref, lookup);
			if (context === undefined || beforeContext === undefined) continue;
			if (context.ruleSet === "form") {
				const before = projectFormExpression(
					doc,
					ref,
					expression,
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
				if (
					after.unresolved.some((issue) => !known.has(JSON.stringify(issue)))
				) {
					verdict = noPath(doc, uuid, ref);
					break;
				}
			}
			// No lookup snapshot is needed for a structural move. Findings that
			// depend on unavailable external definitions are identical before it.
			const before = new Set(
				checkExpression(expression, beforeContext).errors.map((issue) =>
					JSON.stringify(issue),
				),
			);
			const issue = checkExpression(expression, context).errors.find(
				(error) => !before.has(JSON.stringify(error)),
			);
			if (issue !== undefined) {
				verdict =
					issue.reason === "form-filter-step"
						? noPath(doc, uuid, ref)
						: {
								ok: false,
								reason: "expression-invalid-after-move",
								message: issue.message,
							};
				break;
			}
		}
		if (!verdict.ok) break;
	}
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
