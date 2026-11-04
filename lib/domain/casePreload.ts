/**
 * Which answers a form opens showing a case's current value.
 *
 * A preload is a default value: a field opens showing a property of the case
 * the form loaded exactly when its `default_value` is the `form-case` read of
 * that property, with no other operator. Nothing else preloads, and the
 * document says it where every surface reads it: the builder shows the
 * default, the emitter writes it as the question's default setvalue, and the
 * preview engine runs it in its place among the defaults.
 *
 * `writerOffersPreload` is when a new write to the form's own case is born
 * with that default (`lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite`):
 * on a follow-up or close form that opens one case, a write of the own case
 * with no `via`, by a field that is not a capture and holds neither a
 * calculation nor a default yet. A person removes it like any default.
 */

import type { BlueprintDoc } from "./blueprint";
import { fieldCaseWriteViews } from "./caseWriteViews";
import { formOfField } from "./fieldForm";
import type { Field } from "./fields";
import { fieldKindDeclaresKey, isCaptureField } from "./fields";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseWriteVia,
	type FormType,
} from "./forms";
import {
	type CaseSelectionCardinality,
	caseSelectionCardinality,
} from "./modules";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

/** A form whose entry loads exactly one existing case before it opens. */
export function formOpensWithOneCase(
	formType: FormType,
	cardinality: CaseSelectionCardinality,
): boolean {
	return CASE_LOADING_FORM_TYPES.has(formType) && cardinality === "single";
}

/**
 * The case property a field opens showing: its default, when that default is
 * exactly the `form-case` read of a property, with no other operator.
 */
export function fieldPreload(
	field: Field,
): { readonly caseType: string; readonly property: string } | undefined {
	if (!("default_value" in field)) return undefined;
	const value = field.default_value;
	if (value?.kind !== "term" || value.term.kind !== "form-case")
		return undefined;
	return { caseType: value.term.caseType, property: value.term.property };
}

/**
 * Whether a write of `property` by `fieldUuid` to the form's own case should
 * be born with that preload: a one-case follow-up or close form, a write of
 * the own case without `via`, a field that is not a capture, holds no
 * `calculate` and no `default_value`, and is of a kind that holds a default.
 */
export function writerOffersPreload(
	doc: Pick<
		BlueprintDoc,
		"fields" | "forms" | "formOrder" | "modules" | "fieldParent"
	>,
	fieldUuid: Uuid,
	property: string,
	via?: CaseWriteVia,
): boolean {
	if (via !== undefined || property.length === 0) return false;
	const field = Object.hasOwn(doc.fields, fieldUuid)
		? doc.fields[fieldUuid]
		: undefined;
	if (field === undefined || isCaptureField(field)) return false;
	if (!fieldKindDeclaresKey(field.kind, "default_value")) return false;
	if (
		("calculate" in field && field.calculate !== undefined) ||
		("default_value" in field && field.default_value !== undefined)
	)
		return false;
	const formUuid = formOfField(doc, fieldUuid);
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	if (formUuid === undefined || form === undefined) return false;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (module?.caseType === undefined) return false;
	return formOpensWithOneCase(form.type, caseSelectionCardinality(module));
}

/**
 * What a Hidden Value with no value saves, for one whose answer a case
 * operation saves: the one sentence the builder shows under the field's
 * Value control and the SA and MCP tools return when a call leaves the field
 * that way. Undefined for any other field: a visible field, a Hidden Value
 * holding a calculation or a starting value (a preload included), or one no
 * write saves.
 */
export function hiddenWriterBlankNote(
	doc: Parameters<typeof fieldCaseWriteViews>[0] & Pick<BlueprintDoc, "fields">,
	fieldUuid: Uuid,
): string | undefined {
	const field = Object.hasOwn(doc.fields, fieldUuid)
		? doc.fields[fieldUuid]
		: undefined;
	if (field?.kind !== "hidden") return undefined;
	if (field.calculate !== undefined || field.default_value !== undefined)
		return undefined;
	const view = fieldCaseWriteViews(doc, fieldUuid)[0];
	if (view === undefined) return undefined;
	return `Has no value yet, so each submission saves ${view.property} blank.`;
}
