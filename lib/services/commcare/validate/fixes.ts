/**
 * Auto-fix registry — maps validation error codes to mutation-producing fixes.
 *
 * Each fix inspects a `ValidationError` + the current `BlueprintDoc` and
 * returns a list of domain `Mutation`s that resolve the issue. The fix loop
 * (`validationLoop.ts`) applies those mutations to the doc and re-runs
 * validation. Returning an empty list means "no fix available" — the loop
 * keeps the error and moves on.
 *
 * Fixes never mutate the doc directly; all state change flows through the
 * mutation pipeline so undo history, stream emission, and Firestore
 * persistence stay consistent with manual edits.
 */

import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, FieldPatch, Uuid } from "@/lib/domain";
import { XML_ELEMENT_NAME_REGEX } from "../constants";
import type { ValidationError, ValidationErrorCode } from "./errors";

/** A fix: (error, doc) → zero-or-more mutations that resolve the error. */
type FixFn = (error: ValidationError, doc: BlueprintDoc) => Mutation[];

// ── Lookup helpers ─────────────────────────────────────────────────

/**
 * Find the form's uuid for an error. Prefers the explicit `formUuid`
 * location key; falls back to a name-based lookup when only `formName`
 * is available (deep-XPath errors include name but not uuid).
 */
function findFormUuid(
	doc: BlueprintDoc,
	error: ValidationError,
): Uuid | undefined {
	if (error.location.formUuid) return error.location.formUuid;
	if (!error.location.formName) return undefined;
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (doc.forms[formUuid].name === error.location.formName) {
				return formUuid;
			}
		}
	}
	return undefined;
}

/** Find the module that owns a given form, if any. */
function findModuleUuidForForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Uuid | undefined {
	for (const moduleUuid of doc.moduleOrder) {
		if ((doc.formOrder[moduleUuid] ?? []).includes(formUuid)) return moduleUuid;
	}
	return undefined;
}

/**
 * Find the first field under `parentUuid` that looks like a case-name
 * candidate: text kind with `case_property` set and an id containing
 * "name" (case-insensitive). Falls back to the first field with any
 * `case_property` set so a best-effort rename still succeeds.
 */
function findCaseNameCandidate(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): Field | undefined {
	// Prefer text fields whose id hints at "name".
	const stack: Uuid[] = [...(doc.fieldOrder[parentUuid] ?? [])];
	const caseProperty = (f: Field) =>
		(f as { case_property?: string }).case_property;

	// First pass: text kind + case_property + "name" in id.
	const firstPass = [...stack];
	while (firstPass.length > 0) {
		const uuid = firstPass.pop();
		if (!uuid) break;
		const field = doc.fields[uuid];
		if (!field) continue;
		if (
			caseProperty(field) &&
			/name/i.test(field.id) &&
			field.kind === "text"
		) {
			return field;
		}
		const children = doc.fieldOrder[uuid];
		if (children) firstPass.push(...children);
	}

	// Second pass: any field with case_property.
	const secondPass = [...(doc.fieldOrder[parentUuid] ?? [])];
	while (secondPass.length > 0) {
		const uuid = secondPass.pop();
		if (!uuid) break;
		const field = doc.fields[uuid];
		if (!field) continue;
		if (caseProperty(field)) return field;
		const children = doc.fieldOrder[uuid];
		if (children) secondPass.push(...children);
	}
	return undefined;
}

/** Find a field whose id matches `prop` AND has any `case_property` set. */
function findFieldByCaseProperty(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	prop: string,
): Field | undefined {
	const stack: Uuid[] = [...(doc.fieldOrder[parentUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop();
		if (!uuid) break;
		const field = doc.fields[uuid];
		if (!field) continue;
		const cp = (field as { case_property?: string }).case_property;
		if (field.id === prop && cp) return field;
		const children = doc.fieldOrder[uuid];
		if (children) stack.push(...children);
	}
	return undefined;
}

function sanitizeToXmlName(id: string): string {
	let result = id.replace(/[^a-zA-Z0-9_]/g, "_");
	if (!/^[a-zA-Z_]/.test(result)) result = `q_${result}`;
	return result;
}

// ── Fixes ──────────────────────────────────────────────────────────

/**
 * NO_CASE_TYPE: Derive a module's case_type from its display name
 * (snake-cased). A minimal heuristic that gets the validator unstuck; the
 * SA can refine later via an explicit update.
 */
const fixNoCaseType: FixFn = (error, doc) => {
	const moduleUuid = error.location.moduleUuid;
	if (!moduleUuid) return [];
	const mod = doc.modules[moduleUuid];
	if (!mod || mod.caseType) return [];
	const caseType = mod.name.toLowerCase().replace(/\s+/g, "_");
	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: { caseType },
		},
	];
};

/**
 * NO_CASE_NAME_FIELD: Rename the best candidate field to `case_name` and
 * wire it to the module's case_type. When the module has no case_type,
 * the rename alone still gets the registration validator unstuck.
 */
const fixNoCaseNameField: FixFn = (error, doc) => {
	const formUuid = findFormUuid(doc, error);
	if (!formUuid) return [];
	const candidate = findCaseNameCandidate(doc, formUuid);
	if (!candidate) return [];
	const moduleUuid =
		error.location.moduleUuid ?? findModuleUuidForForm(doc, formUuid);
	const moduleCaseType = moduleUuid
		? doc.modules[moduleUuid]?.caseType
		: undefined;

	const mutations: Mutation[] = [
		{
			kind: "renameField",
			uuid: candidate.uuid,
			newId: "case_name",
		},
	];
	if (moduleCaseType) {
		mutations.push({
			kind: "updateField",
			uuid: candidate.uuid,
			patch: { case_property: moduleCaseType } as FieldPatch,
		});
	}
	return mutations;
};

/**
 * RESERVED_CASE_PROPERTY: Rename any field whose id == reservedName AND
 * carries a `case_property`, appending `_value` to dodge the CommCare
 * reserved-word collision.
 */
const fixReservedCaseProperty: FixFn = (error, doc) => {
	const formUuid = findFormUuid(doc, error);
	const reserved = error.details?.reservedName;
	if (!formUuid || !reserved) return [];
	const stack: Uuid[] = [...(doc.fieldOrder[formUuid] ?? [])];
	const mutations: Mutation[] = [];
	while (stack.length > 0) {
		const uuid = stack.pop();
		if (!uuid) break;
		const field = doc.fields[uuid];
		if (!field) continue;
		const cp = (field as { case_property?: string }).case_property;
		if (field.id === reserved && cp) {
			mutations.push({
				kind: "renameField",
				uuid: field.uuid,
				newId: `${reserved}_value`,
			});
		}
		const children = doc.fieldOrder[uuid];
		if (children) stack.push(...children);
	}
	return mutations;
};

/**
 * MEDIA_CASE_PROPERTY: Strip `case_property` from a media field — the
 * attachment is handled separately. We emit an updateField patch whose
 * `case_property` is the empty sentinel; the mutation reducer treats an
 * empty string the same as clearing the value.
 */
const fixMediaCaseProperty: FixFn = (error, doc) => {
	const formUuid = findFormUuid(doc, error);
	const prop = error.details?.property;
	if (!formUuid || !prop) return [];
	const field = findFieldByCaseProperty(doc, formUuid, prop);
	if (!field) return [];
	return [
		{
			kind: "updateField",
			uuid: field.uuid,
			// case_property is optional on every input kind; passing the
			// empty string clears it at the XForm emitter without
			// triggering a schema rejection on write.
			patch: { case_property: "" } as FieldPatch,
		},
	];
};

/**
 * UNQUOTED_STRING_LITERAL: Wrap the bare word in single quotes so the
 * XPath parser reads it as a literal. The exact XPath field affected is
 * carried in `error.details.field` (domain key — e.g. `validate`,
 * `calculate`).
 */
const fixUnquotedStringLiteral: FixFn = (error, doc) => {
	const fieldUuid = error.location.fieldUuid;
	const bare = error.details?.bareWord;
	const key = error.details?.field;
	if (!fieldUuid || !bare || !key) return [];
	const field = doc.fields[fieldUuid];
	if (!field) return [];
	const patchValue = `'${bare}'`;
	// Typed cast: the FieldPatch union accepts any variant's partial so
	// long as the value shape matches. All XPath keys are `string`, so
	// this assignment is sound.
	return [
		{
			kind: "updateField",
			uuid: fieldUuid,
			patch: { [key]: patchValue } as unknown as FieldPatch,
		},
	];
};

/** SELECT_NO_OPTIONS: Seed two default options so the field is emittable. */
const fixSelectNoOptions: FixFn = (error, doc) => {
	const fieldUuid = error.location.fieldUuid;
	if (!fieldUuid) return [];
	const field = doc.fields[fieldUuid];
	if (!field) return [];
	if (field.kind !== "single_select" && field.kind !== "multi_select") {
		return [];
	}
	return [
		{
			kind: "updateField",
			uuid: fieldUuid,
			patch: {
				options: [
					{ value: "option_1", label: "Option 1" },
					{ value: "option_2", label: "Option 2" },
				],
			} as FieldPatch,
		},
	];
};

/**
 * CLOSE_CONDITION_*: All three close-condition errors dissolve the same
 * way — drop the closeCondition entirely. Callers can re-add a valid one
 * later.
 */
const fixCloseCondition: FixFn = (error, doc) => {
	const formUuid = findFormUuid(doc, error);
	if (!formUuid) return [];
	return [
		{
			kind: "updateForm",
			uuid: formUuid,
			patch: { closeCondition: undefined },
		},
	];
};

/**
 * UNKNOWN_FUNCTION: Only fixes case-mismatched function names
 * (e.g. `Today` → `today`). Rewrites every XPath field on the affected
 * field that contains the wrong function name.
 */
const fixUnknownFunction: FixFn = (error, doc) => {
	const match = error.message.match(
		/Unknown function "(\w[\w-]*)[\w-]*\(\)" — did you mean "(\w[\w-]*)[\w-]*\(\)"/,
	);
	if (!match) return [];
	const [, wrong, correct] = match;
	const fieldUuid = error.location.fieldUuid;
	if (!fieldUuid) return [];
	const field = doc.fields[fieldUuid];
	if (!field) return [];
	return rewriteXPathFields(field, (value) =>
		value.includes(`${wrong}(`)
			? value.replaceAll(`${wrong}(`, `${correct}(`)
			: value,
	);
};

/** WRONG_ARITY: Only fixes `round(x, 2)` → `round(x)` as a known pattern. */
const fixWrongArity: FixFn = (error, doc) => {
	if (!error.message.includes("round()")) return [];
	const fieldUuid = error.location.fieldUuid;
	if (!fieldUuid) return [];
	const field = doc.fields[fieldUuid];
	if (!field) return [];
	return rewriteXPathFields(field, (value) =>
		value.replace(/round\(([^,)]+),\s*[^)]+\)/g, "round($1)"),
	);
};

/**
 * INVALID_FIELD_ID: Rename the field to a sanitized XML-safe form. The
 * mutation reducer handles XPath rewriting across the form automatically.
 */
const fixInvalidFieldId: FixFn = (error, doc) => {
	const fieldUuid = error.location.fieldUuid ?? error.details?.fieldUuid;
	if (!fieldUuid) return [];
	const field = doc.fields[fieldUuid];
	if (!field) return [];
	const sanitized = sanitizeToXmlName(field.id);
	if (sanitized === field.id || !XML_ELEMENT_NAME_REGEX.test(sanitized)) {
		return [];
	}
	return [
		{
			kind: "renameField",
			uuid: field.uuid,
			newId: sanitized,
		},
	];
};

/** CASE_PROPERTY_BAD_FORMAT: Rename the field-id (== property name) to a sanitized form. */
const fixCasePropertyBadFormat: FixFn = (error, doc) => {
	const formUuid = findFormUuid(doc, error);
	const prop = error.details?.property;
	if (!formUuid || !prop) return [];
	const field = findFieldByCaseProperty(doc, formUuid, prop);
	if (!field) return [];
	const sanitized = sanitizeToXmlName(field.id);
	if (sanitized === field.id) return [];
	return [
		{
			kind: "renameField",
			uuid: field.uuid,
			newId: sanitized,
		},
	];
};

/**
 * For each XPath-bearing key present on a field's variant, apply a
 * transform to its value and emit a single `updateField` with every
 * changed key. Returns no mutations if nothing changed.
 */
function rewriteXPathFields(
	field: Field,
	transform: (value: string) => string,
): Mutation[] {
	const xpathKeys = [
		"relevant",
		"calculate",
		"default_value",
		"validate",
		"required",
	] as const;
	const fieldAny = field as unknown as Record<string, unknown>;
	const patch: Record<string, string> = {};
	for (const key of xpathKeys) {
		const value = fieldAny[key];
		if (typeof value !== "string" || value.length === 0) continue;
		const next = transform(value);
		if (next !== value) patch[key] = next;
	}
	if (Object.keys(patch).length === 0) return [];
	return [
		{
			kind: "updateField",
			uuid: field.uuid,
			patch: patch as unknown as FieldPatch,
		},
	];
}

// ── Registry ───────────────────────────────────────────────────────

export const FIX_REGISTRY = new Map<ValidationErrorCode, FixFn>([
	["NO_CASE_TYPE", fixNoCaseType],
	["NO_CASE_NAME_FIELD", fixNoCaseNameField],
	["RESERVED_CASE_PROPERTY", fixReservedCaseProperty],
	["MEDIA_CASE_PROPERTY", fixMediaCaseProperty],
	["UNQUOTED_STRING_LITERAL", fixUnquotedStringLiteral],
	["SELECT_NO_OPTIONS", fixSelectNoOptions],
	["CLOSE_CONDITION_WRONG_TYPE", fixCloseCondition],
	["CLOSE_CONDITION_INCOMPLETE", fixCloseCondition],
	["CLOSE_CONDITION_FIELD_NOT_FOUND", fixCloseCondition],
	["UNKNOWN_FUNCTION", fixUnknownFunction],
	["WRONG_ARITY", fixWrongArity],
	["INVALID_FIELD_ID", fixInvalidFieldId],
	["CASE_PROPERTY_BAD_FORMAT", fixCasePropertyBadFormat],
]);
