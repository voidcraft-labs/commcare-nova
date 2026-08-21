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

import {
	type BlueprintDoc,
	type Field,
	type FieldKind,
	isContainer,
	type Uuid,
} from "@/lib/domain";
import { orderedFieldUuids } from "./fieldWalk";

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

export type FieldPlacementRefusal =
	| "loose-field-in-sectioned-form"
	| "section-not-root"
	| "section-other-form"
	| "user-repeat-in-section";

export type FieldPlacementVerdict =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: FieldPlacementRefusal;
			/** Nova voice: one sentence of what and one of what to do. The
			 *  SA tools return it verbatim, so the three editors say one thing. */
			readonly message: string;
	  };

/** The three sentences, one home. */
export const FIELD_PLACEMENT_MESSAGES: Readonly<
	Record<FieldPlacementRefusal, string>
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

function refuse(reason: FieldPlacementRefusal): FieldPlacementVerdict {
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
 * `toParentUuid`? Sibling position is never the question — only the parent
 * decides — so a drag's placeholder, a keyboard move, the inspector, and a
 * tool pre-check all ask this once per destination.
 */
export function fieldPlacementVerdict(
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
