/**
 * Field-identifier verdicts — the shared "is this id usable here?"
 * decision every authoring surface consults BEFORE dispatching a
 * mutation.
 *
 * A field's semantic id is three names at once: the XForm XML element
 * name, the case property name it saves to, and the handle sibling
 * XPath references resolve against. Each role carries a constraint —
 * XML element-name legality, the case-property length cap, the reserved
 * `__nova_` synthetic-node namespace, and sibling-id uniqueness
 * (CommCare requires unique ids among siblings; cousins may share).
 *
 * This module is the single home of those checks for the commit
 * boundary (the connect-slug pattern: one verdict, every caller). The
 * UI rename guard (`FieldHeader` via `classifyRenameOutcome`), the
 * store-level rename pre-check (`useBlueprintMutations.renameField`),
 * and the SA/MCP tools (`addFields`, `editField`'s rename path) all
 * consume the same functions, so "rejected here, accepted there" can't
 * drift. The validator rules (`DUPLICATE_FIELD_ID`, `INVALID_FIELD_ID`,
 * `RESERVED_FIELD_ID_PREFIX`, `CASE_PROPERTY_TOO_LONG`) stay as
 * backstops for docs that predate the guards.
 *
 * Pure — reads the doc, never mutates. Reducers stay total and never
 * call these: a degenerate historical event must still replay.
 */
import {
	isReservedXFormNodeName,
	MAX_CASE_PROPERTY_LENGTH,
	RESERVED_XFORM_NODE_PREFIX,
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare";
import { declarersOf } from "@/lib/doc/referenceIndex";
import {
	type BlueprintDoc,
	fieldCasePropertyOn,
	type Uuid,
} from "@/lib/domain";

/** Why an id was rejected. Useful for tests and for callers that brand
 *  failure classes differently; human-facing copy rides `message` /
 *  `userMessage`. */
export type FieldIdRejectionCode =
	| "illegal_xml_name"
	| "reserved_prefix"
	| "too_long"
	| "sibling_conflict";

/**
 * The one verdict shape every caller consumes — carrying TWO renderings
 * of the same rejection for two audiences:
 *
 *   - `message` — the verbose, person-to-person sentence that names the
 *     underlying constraint (it's an XML element name, the case-property
 *     cap, …). The SA/MCP tool layer reads this; the agent acts on the
 *     "why", and the detail is what lets it self-correct.
 *   - `userMessage` — the concise builder-UI line. A person renaming a
 *     field doesn't need to know an id is also an XML element name — only
 *     that this one won't work and what to do instead. No platform
 *     mechanics, no wire vocabulary.
 *
 * Same rejection, two voices: deepen the explanation in `message`, never
 * in `userMessage`. The UI renders `userMessage`; the agent reads
 * `message`.
 */
export type FieldIdVerdict =
	| { ok: true }
	| {
			ok: false;
			code: FieldIdRejectionCode;
			message: string;
			userMessage: string;
	  };

const OK: FieldIdVerdict = { ok: true };

/** Format-class checks shared by the add and rename verdicts: XML
 *  element-name legality, the reserved synthetic-node prefix, and the
 *  case-property length cap. Sibling uniqueness is scope-dependent and
 *  lives with each caller-shaped verdict below. */
function formatVerdict(proposedId: string): FieldIdVerdict {
	if (proposedId.length === 0) {
		return {
			ok: false,
			code: "illegal_xml_name",
			message:
				"A field id can't be empty. The id becomes the question's name in the form and the case property it saves to — give it a short name like \"first_name\".",
			userMessage:
				'A field needs an id. Try something short, like "first_name".',
		};
	}
	if (!XML_ELEMENT_NAME_REGEX.test(proposedId)) {
		return {
			ok: false,
			code: "illegal_xml_name",
			message: `"${proposedId}" can't be a field id. Ids become XML element names, so they must start with a letter or underscore and contain only letters, digits, or underscores — no spaces, hyphens, or special characters.`,
			userMessage: `"${proposedId}" won't work as a field id. Stick to letters, numbers, and underscores, starting with a letter — no spaces or punctuation.`,
		};
	}
	if (isReservedXFormNodeName(proposedId)) {
		return {
			ok: false,
			code: "reserved_prefix",
			message: `"${proposedId}" starts with "${RESERVED_XFORM_NODE_PREFIX}", which is reserved for nodes Nova generates behind the scenes (for example the hidden counter a fixed-count repeat needs). Pick an id that doesn't start with "${RESERVED_XFORM_NODE_PREFIX}".`,
			userMessage: `"${proposedId}" starts with "${RESERVED_XFORM_NODE_PREFIX}", which is reserved. Pick an id that starts with something else.`,
		};
	}
	if (proposedId.length > MAX_CASE_PROPERTY_LENGTH) {
		return {
			ok: false,
			code: "too_long",
			message: `"${proposedId.slice(0, 40)}…" is ${proposedId.length} characters long. A field id is also the name of the case property it saves to, and CommCare caps property names at ${MAX_CASE_PROPERTY_LENGTH} characters. Use a shorter, more concise id.`,
			userMessage: `That id's a bit too long (${proposedId.length} characters). Keep it to ${MAX_CASE_PROPERTY_LENGTH} or fewer.`,
		};
	}
	return OK;
}

/** Build the sibling-conflict rejection. `where` is an optional
 *  location note (e.g. ` in "Follow Up"`) for conflicts the caller
 *  can't see on screen — a case-property peer's form on a rename. */
function siblingConflict(proposedId: string, where = ""): FieldIdVerdict {
	return {
		ok: false,
		code: "sibling_conflict",
		message: `Another field at the same level${where} is already named "${proposedId}". Fields that sit side by side share an XML path, so each needs a unique id — pick a different one or rename the other field first.`,
		userMessage: `Another field${where} is already named "${proposedId}". Give this one a different id, or rename that one first.`,
	};
}

/** True when `parentUuid`'s children (minus the excluded uuid) already
 *  contain a field named `proposedId`. */
function parentHasSibling(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	proposedId: string,
	exclude: ReadonlySet<Uuid>,
): boolean {
	for (const siblingUuid of doc.fieldOrder[parentUuid] ?? []) {
		if (exclude.has(siblingUuid)) continue;
		if (doc.fields[siblingUuid]?.id === proposedId) return true;
	}
	return false;
}

/** Walk `fieldParent` up from a parent handle (a form uuid or a
 *  container-field uuid) to the containing form's display name.
 *  Returns `undefined` if the walk dead-ends (degenerate doc). */
function containingFormName(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): string | undefined {
	const seen = new Set<Uuid>();
	let cursor: Uuid | null | undefined = parentUuid;
	while (cursor && !seen.has(cursor)) {
		const form = doc.forms[cursor];
		if (form) return form.name;
		seen.add(cursor);
		cursor = doc.fieldParent[cursor];
	}
	return undefined;
}

/** Input for {@link fieldIdVerdict} — the add-shaped, single-parent
 *  check. Options-object signature so call sites read as named args. */
export interface FieldIdVerdictInput {
	doc: BlueprintDoc;
	/** The parent the field lands under — a form uuid for top-level
	 *  fields, a group/repeat field uuid for nested ones. */
	parentUuid: Uuid;
	proposedId: string;
	/** Uuid to skip in the sibling scan — the field itself when the
	 *  caller is re-checking an id it already holds. */
	excludeUuid?: Uuid;
	/** Ids already claimed under the same parent by earlier items of an
	 *  in-flight batch (not yet in the doc). `addFields` threads its
	 *  per-parent accumulation through here so two new fields can't land
	 *  side by side with the same id. */
	pendingSiblingIds?: ReadonlySet<string>;
}

/**
 * Verdict for placing a field with `proposedId` under `parentUuid`:
 * format legality, the reserved namespace, the case-property length
 * cap, and uniqueness among that parent's children. Cousins (same id
 * under a different parent) pass — only siblings share an XML path.
 */
export function fieldIdVerdict({
	doc,
	parentUuid,
	proposedId,
	excludeUuid,
	pendingSiblingIds,
}: FieldIdVerdictInput): FieldIdVerdict {
	const format = formatVerdict(proposedId);
	if (!format.ok) return format;
	const exclude = new Set<Uuid>(excludeUuid ? [excludeUuid] : []);
	if (
		parentHasSibling(doc, parentUuid, proposedId, exclude) ||
		pendingSiblingIds?.has(proposedId)
	) {
		return siblingConflict(proposedId);
	}
	return OK;
}

/**
 * Find the parent under which renaming `fieldUuid` to `newId` would
 * collide with an existing sibling, or `undefined` when the rename is
 * conflict-free.
 *
 * The scan is peer-aware: a rename of a case-bound field also renames
 * every other field with the same `(id, case_property_on)` pair (the
 * reducer's case-property cascade), so the destination parents are the
 * primary field's parent AND each peer's parent. Skipping the peers
 * would let the cascade silently mint duplicate sibling ids in another
 * form. A sibling that is itself in the renaming set is NOT a conflict
 * — it becomes `newId` in lockstep.
 *
 * Exported on its own (alongside {@link renameFieldIdVerdict}) because
 * the store-level pre-check in `useBlueprintMutations.renameField`
 * consumes just the conflict scan — its callers own format checking.
 */
export function findRenameSiblingConflict(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	newId: string,
): Uuid | undefined {
	const field = doc.fields[fieldUuid];
	if (!field) return undefined;

	// Peers rename in lockstep with the primary — same id, same
	// non-empty case_property_on. The candidates come from the reference
	// index's declarations lookup (the same source the reducer's cascade
	// consumes), each verified against the live doc so the verdict's
	// peer set mirrors `cascadeCasePropertyRename`'s exactly.
	const caseType = fieldCasePropertyOn(field);
	const renaming = new Set<Uuid>([fieldUuid]);
	if (caseType !== undefined) {
		for (const uuid of declarersOf(doc, caseType, field.id)) {
			if (uuid === fieldUuid) continue;
			const candidate = doc.fields[uuid as Uuid];
			if (!candidate || candidate.id !== field.id) continue;
			if (fieldCasePropertyOn(candidate) !== caseType) continue;
			renaming.add(uuid as Uuid);
		}
	}

	const parents = new Set<Uuid>();
	for (const uuid of renaming) {
		const parent = doc.fieldParent[uuid];
		if (parent) parents.add(parent);
	}
	for (const parent of parents) {
		if (parentHasSibling(doc, parent, newId, renaming)) return parent;
	}
	return undefined;
}

/** Input for {@link renameFieldIdVerdict}. */
export interface RenameFieldIdVerdictInput {
	doc: BlueprintDoc;
	/** The field being renamed. An unknown uuid passes — not-found is
	 *  the caller's channel, not this verdict's. */
	fieldUuid: Uuid;
	newId: string;
}

/**
 * Verdict for renaming `fieldUuid` to `newId`: a rename to the current
 * id passes (no-op), then format legality, the reserved namespace, the
 * length cap, and the peer-aware sibling-conflict scan. When the
 * conflict sits in a different form than the renamed field (a
 * case-property peer's destination), the message names that form — the
 * collision isn't on the caller's screen.
 */
export function renameFieldIdVerdict({
	doc,
	fieldUuid,
	newId,
}: RenameFieldIdVerdictInput): FieldIdVerdict {
	const field = doc.fields[fieldUuid];
	if (!field) return OK;
	if (field.id === newId) return OK;

	const format = formatVerdict(newId);
	if (!format.ok) return format;

	const conflictParent = findRenameSiblingConflict(doc, fieldUuid, newId);
	if (conflictParent !== undefined) {
		const ownParent = doc.fieldParent[fieldUuid];
		const conflictForm = containingFormName(doc, conflictParent);
		const ownForm = ownParent ? containingFormName(doc, ownParent) : undefined;
		const where =
			conflictForm !== undefined && conflictForm !== ownForm
				? ` in "${conflictForm}"`
				: "";
		return siblingConflict(newId, where);
	}
	return OK;
}
