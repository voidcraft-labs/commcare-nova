/**
 * Field-identifier verdicts — the shared "is this ID usable here?"
 * decision every authoring surface consults BEFORE dispatching a
 * mutation.
 *
 * A field's semantic ID is its XForm XML element name and the handle sibling
 * XPath references resolve against. Its case-storage destination is the
 * independent `caseWrite` pair. Field IDs therefore carry only form-path
 * constraints:
 * XML element-name legality, the reserved `__nova_` synthetic-node namespace,
 * and sibling-ID uniqueness (CommCare requires unique ids among siblings;
 * cousins may share).
 *
 * This module is the single home of those checks for the commit
 * boundary (the connect-slug pattern: one verdict, every caller). The
 * UI rename guard (`FieldIdentitySection` via `classifyRenameOutcome`), the
 * store-level rename pre-check (`useBlueprintMutations.renameField`),
 * and the SA/MCP tools (`addFields`, `editField`'s rename path) all
 * consume the same functions, so "rejected here, accepted there" can't
 * drift. The validator rules (`DUPLICATE_FIELD_ID`, `INVALID_FIELD_ID`,
 * `RESERVED_FIELD_ID_PREFIX`) stay as
 * backstops for docs that predate the guards.
 *
 * Pure — reads the doc, never mutates. Reducers stay total and never
 * call these: a degenerate historical event must still replay.
 */
import {
	CASE_TYPE_REGEX,
	MAX_CASE_INDEX_IDENTIFIER_LENGTH,
	MAX_CASE_PROPERTY_LENGTH,
	MAX_CASE_TYPE_LENGTH,
	RESERVED_XFORM_NODE_PREFIX,
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare/constants";
import { isReservedXFormNodeName } from "@/lib/commcare/identifierValidation";
import { RESERVED_CASE_TYPE_NAMES } from "@/lib/commcare/validator/reservedNamespaces";
import {
	authoredCasePropertyNameSchema,
	type BlueprintDoc,
	CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	CASE_OPERATION_PROPERTY_FORMAT_MESSAGE,
	FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES,
	isCaseOperationIdentifier,
	isCaseOperationProperty,
	type Uuid,
} from "@/lib/domain";

/** Why an ID was rejected. Useful for tests and for callers that brand
 *  failure classes differently; human-facing copy rides `message` /
 *  `userMessage`. */
export type FieldIdRejectionCode =
	| "illegal_xml_name"
	| "reserved_prefix"
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
 *     field doesn't need to know an ID is also an XML element name — only
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

/** Format-class checks shared by the add and rename verdicts: XML element-name
 * legality and the reserved synthetic-node prefix. Sibling uniqueness lives
 * with each caller-shaped verdict below. */
/** The format half of the id law alone — legal characters, no leading
 *  digit, no reserved prefix — with no sibling scan. For a caller whose
 *  sibling universe is not the document's current one (the section
 *  planner collides against the root its plan PRODUCES). */
export function fieldIdFormatVerdict(proposedId: string): FieldIdVerdict {
	return formatVerdict(proposedId);
}

function formatVerdict(proposedId: string): FieldIdVerdict {
	if (proposedId.length === 0) {
		return {
			ok: false,
			code: "illegal_xml_name",
			message:
				"A field ID can't be empty. The ID becomes the question's name in the form. Give it a short name like \"first_name\".",
			userMessage:
				'A field needs an ID. Try something short, like "first_name".',
		};
	}
	if (!XML_ELEMENT_NAME_REGEX.test(proposedId)) {
		return {
			ok: false,
			code: "illegal_xml_name",
			message: `"${proposedId}" can't be a field ID. IDs become XML element names, so they must start with a letter or underscore and contain only letters, digits, or underscores, no spaces, hyphens, or special characters.`,
			userMessage: `"${proposedId}" won't work as a field ID. Stick to letters, numbers, and underscores, starting with a letter, no spaces or punctuation.`,
		};
	}
	if (isReservedXFormNodeName(proposedId)) {
		return {
			ok: false,
			code: "reserved_prefix",
			message: `"${proposedId}" starts with "${RESERVED_XFORM_NODE_PREFIX}", which is reserved for nodes Nova generates behind the scenes (for example the hidden counter a fixed-count repeat needs). Pick an ID that doesn't start with "${RESERVED_XFORM_NODE_PREFIX}".`,
			userMessage: `"${proposedId}" starts with "${RESERVED_XFORM_NODE_PREFIX}", which is reserved. Pick an ID that starts with something else.`,
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
		message: `Another field at the same level${where} is already named "${proposedId}". Fields that sit side by side share an XML path, so each needs a unique ID. Pick a different one or rename the other field first.`,
		userMessage: `Another field${where} is already named "${proposedId}". Give this one a different ID, or rename that one first.`,
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

/** Input for {@link fieldIdVerdict} — the add-shaped, single-parent
 *  check. Options-object signature so call sites read as named args. */
export interface FieldIdVerdictInput {
	doc: BlueprintDoc;
	/** The parent the field lands under — a form uuid for top-level
	 *  fields, a group/repeat field uuid for nested ones. */
	parentUuid: Uuid;
	proposedId: string;
	/** Uuid to skip in the sibling scan — the field itself when the
	 *  caller is re-checking an ID it already holds. */
	excludeUuid?: Uuid;
	/** IDs already claimed under the same parent by earlier items of an
	 *  in-flight batch (not yet in the doc). `addFields` threads its
	 *  per-parent accumulation through here so two new fields can't land
	 *  side by side with the same ID. */
	pendingSiblingIds?: ReadonlySet<string>;
}

/**
 * Verdict for placing a field with `proposedId` under `parentUuid`:
 * format legality, the reserved namespace, the case-property length
 * cap, and uniqueness among that parent's children. Cousins (same ID
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

	const parent = doc.fieldParent[fieldUuid];
	if (parent === undefined) return undefined;
	return parentHasSibling(doc, parent, newId, new Set([fieldUuid]))
		? parent
		: undefined;
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
 * ID passes (no-op), then format legality, the reserved namespace, the
 * sibling-conflict scan.
 */
export function renameFieldIdVerdict({
	doc,
	fieldUuid,
	newId,
}: RenameFieldIdVerdictInput): FieldIdVerdict {
	const field = doc.fields[fieldUuid];
	if (!field) return OK;

	const format = formatVerdict(newId);
	if (!format.ok) return format;
	if (field.id === newId) return OK;

	const conflictParent = findRenameSiblingConflict(doc, fieldUuid, newId);
	if (conflictParent !== undefined) {
		return siblingConflict(newId);
	}
	return OK;
}

// ── Case-type names ─────────────────────────────────────────────────
//
// A module's case type is a CommCare wire identifier too: it must match
// `CASE_TYPE_REGEX`, stay within `MAX_CASE_TYPE_LENGTH`, and avoid the
// reserved reference namespaces (`form`/`user`/`case`/`parent`) that would
// collide with the hashtag system. The same constraints the validator's
// `INVALID_CASE_TYPE_FORMAT` / `CASE_TYPE_TOO_LONG` (`rules/module.ts`) and
// `RESERVED_CASE_TYPE_NAME` (`rules/app.ts`) rules enforce as backstops — this
// verdict lets the create-new-case-type picker disable an illegal name inline
// (valid-by-construction) instead of letting the commit gate reject it after.

/** Why a proposed case-type name can't be used. */
export type CaseTypeNameRejectionCode =
	| "empty"
	| "illegal_format"
	| "reserved"
	| "too_long"
	| "duplicate";

export type CaseTypeNameVerdict =
	| { ok: true }
	| { ok: false; code: CaseTypeNameRejectionCode; userMessage: string };

const CASE_TYPE_OK: CaseTypeNameVerdict = { ok: true };

/**
 * Adjudicate a new case-type NAME against the wire's identifier rules plus the
 * app's existing types (a brand-new type can't reuse an existing name —
 * "create new" would otherwise silently target the existing one). `existing`
 * is the set of case-type names already in use (module case types and/or the
 * catalog). The reserved check is case-insensitive (the wire resolver lowercases
 * reserved namespaces); the DUPLICATE check is case-SENSITIVE — CommCare case
 * types are case-sensitive and there's no `DUPLICATE_CASE_TYPE` validator rule,
 * so "Patient" is a distinct, wire-valid type when only "patient" exists, and
 * rejecting it would be stricter than the wire. Only an exact match means
 * "pick it from the list instead".
 */
export function caseTypeNameVerdict(
	name: string,
	existing: ReadonlySet<string>,
): CaseTypeNameVerdict {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return { ok: false, code: "empty", userMessage: "Enter a case type name." };
	}
	if (!CASE_TYPE_REGEX.test(trimmed)) {
		return {
			ok: false,
			code: "illegal_format",
			userMessage:
				"Start with a letter; use only letters, digits, underscores, or hyphens.",
		};
	}
	if (trimmed.length > MAX_CASE_TYPE_LENGTH) {
		return {
			ok: false,
			code: "too_long",
			userMessage: `Keep it to ${MAX_CASE_TYPE_LENGTH} characters or fewer.`,
		};
	}
	if (RESERVED_CASE_TYPE_NAMES.has(trimmed.toLowerCase())) {
		return {
			ok: false,
			code: "reserved",
			userMessage: `"${trimmed}" is reserved. Try something like "${trimmed}_record".`,
		};
	}
	if (existing.has(trimmed)) {
		return {
			ok: false,
			code: "duplicate",
			userMessage: `"${trimmed}" already exists. Pick it from the list instead.`,
		};
	}
	return CASE_TYPE_OK;
}

// ── User-data property slugs ────────────────────────────────────────
//
// The rule itself is a CommCare rule and lives with the validator; it is
// re-exported here so every authoring surface keeps ONE import home for
// "is this identifier usable?", the same way the field and case-type
// verdicts above do.
export {
	type UserPropertySlugRejectionCode,
	type UserPropertySlugVerdict,
	userPropertySlugVerdict,
} from "@/lib/commcare/validator/userPropertySlug";

// ── Case-operation ids ──────────────────────────────────────────────────
//
// An operation's id is its author-facing handle — the name a refusal
// speaks ("'update_client' uses this change's result") and the name the
// emitted XForm node carries. It is therefore both a person-facing label
// and an XML element name, and it must be unique within its form so two
// changes can never be confused for one another in a refusal. The
// validator enforces the same three rules as backstops
// (`CASE_OPERATION_INVALID_ID`, `CASE_OPERATION_DUPLICATE_ID`); this
// verdict lets the rename input refuse inline instead.

/** Why a proposed case-operation id can't be used. */
export type CaseOperationIdRejectionCode =
	| "empty"
	| "illegal_format"
	| "reserved_prefix"
	| "duplicate";

export type CaseOperationIdVerdict =
	| { ok: true }
	| { ok: false; code: CaseOperationIdRejectionCode; userMessage: string };

const CASE_OPERATION_ID_OK: CaseOperationIdVerdict = { ok: true };

/**
 * Adjudicate a case-operation id against the wire's element-name rules
 * and the ids already used by the same form. `taken` must exclude the
 * operation being renamed, so keeping its current name is never a
 * duplicate.
 */
export function caseOperationIdVerdict(
	id: string,
	taken: ReadonlySet<string>,
): CaseOperationIdVerdict {
	const trimmed = id.trim();
	if (trimmed.length === 0) {
		return {
			ok: false,
			code: "empty",
			userMessage: "Give this change a name.",
		};
	}
	if (id !== trimmed || !isCaseOperationIdentifier(trimmed)) {
		return {
			ok: false,
			code: "illegal_format",
			userMessage: CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
		};
	}
	if (trimmed.startsWith(RESERVED_XFORM_NODE_PREFIX)) {
		return {
			ok: false,
			code: "reserved_prefix",
			userMessage: `Names starting with "${RESERVED_XFORM_NODE_PREFIX}" are reserved.`,
		};
	}
	if (taken.has(trimmed)) {
		return {
			ok: false,
			code: "duplicate",
			userMessage: `"${trimmed}" is already used by another change in this form.`,
		};
	}
	return CASE_OPERATION_ID_OK;
}

/** Why a proposed case-operation write property can't be used. */
export type CaseOperationPropertyRejectionCode =
	| "empty"
	| "invalid_case_property_name"
	| "illegal_format"
	| "reserved"
	| "too_long"
	| "duplicate";

export type CaseOperationPropertyVerdict =
	| { ok: true }
	| {
			ok: false;
			code: CaseOperationPropertyRejectionCode;
			userMessage: string;
	  };

const CASE_OPERATION_PROPERTY_OK: CaseOperationPropertyVerdict = { ok: true };

/**
 * Adjudicate a case property a case operation would write.
 *
 * Reserved properties are the ones the operation's own facets own (the
 * name, the owner) or that the two runtimes disagree about, so writing
 * one through the generic slot would mean two different things on a
 * device and on HQ. `alreadyWritten` is the set this operation already
 * writes: one operation may not write the same property twice.
 */
export function caseOperationWritePropertyVerdict(
	property: string,
	alreadyWritten: ReadonlySet<string>,
): CaseOperationPropertyVerdict {
	const trimmed = property.trim();
	if (trimmed.length === 0) {
		return { ok: false, code: "empty", userMessage: "Enter a property name." };
	}
	if (property !== trimmed || !isCaseOperationProperty(trimmed)) {
		return {
			ok: false,
			code: "illegal_format",
			userMessage: CASE_OPERATION_PROPERTY_FORMAT_MESSAGE,
		};
	}
	const authoredName = authoredCasePropertyNameSchema.safeParse(trimmed);
	if (!authoredName.success) {
		return {
			ok: false,
			code: "invalid_case_property_name",
			userMessage:
				authoredName.error.issues[0]?.message ??
				"Enter a valid Nova case property name.",
		};
	}
	if (trimmed.length > MAX_CASE_PROPERTY_LENGTH) {
		return {
			ok: false,
			code: "too_long",
			userMessage: `Keep it to ${MAX_CASE_PROPERTY_LENGTH} characters or fewer.`,
		};
	}
	if (FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES.has(trimmed)) {
		return {
			ok: false,
			code: "reserved",
			userMessage: `"${trimmed}" is set by this change itself, not saved as a property.`,
		};
	}
	if (alreadyWritten.has(trimmed)) {
		return {
			ok: false,
			code: "duplicate",
			userMessage: `This change already saves "${trimmed}".`,
		};
	}
	return CASE_OPERATION_PROPERTY_OK;
}

/** Whether a property is owned by an operation facet rather than a write. */
export function isReservedCaseOperationProperty(property: string): boolean {
	return FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES.has(property);
}

/**
 * Adjudicate a link identifier — the name of one connection between two
 * cases ("parent", "host", "referred_by"). It is an XML element name on
 * the wire, capped by CommCare's index-identifier length, and unique
 * within its operation: two links of one change cannot share a name,
 * because the second would replace the first.
 */
export function caseOperationLinkIdentifierVerdict(
	identifier: string,
	taken: ReadonlySet<string>,
): CaseOperationIdVerdict {
	const trimmed = identifier.trim();
	if (trimmed.length === 0) {
		return { ok: false, code: "empty", userMessage: "Name this connection." };
	}
	if (identifier !== trimmed || !isCaseOperationIdentifier(trimmed)) {
		return {
			ok: false,
			code: "illegal_format",
			userMessage: CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
		};
	}
	if (trimmed.startsWith(RESERVED_XFORM_NODE_PREFIX)) {
		return {
			ok: false,
			code: "reserved_prefix",
			userMessage: `Names starting with "${RESERVED_XFORM_NODE_PREFIX}" are reserved.`,
		};
	}
	if (trimmed.length > MAX_CASE_INDEX_IDENTIFIER_LENGTH) {
		return {
			ok: false,
			code: "illegal_format",
			userMessage: `Keep it to ${MAX_CASE_INDEX_IDENTIFIER_LENGTH} characters or fewer.`,
		};
	}
	if (taken.has(trimmed)) {
		return {
			ok: false,
			code: "duplicate",
			userMessage: `This change already has a connection called "${trimmed}".`,
		};
	}
	return CASE_OPERATION_ID_OK;
}
