// lib/doc/searchNoMatchesForm.ts
//
// Planners for the no-matches registration form: the one form of a
// search-first module that opens from Results after a search found nothing
// (`Form.entry` of kind `search-no-matches`). Setting the entry turns Search
// first on in the same batch when it is off, because the form's rule
// (`SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST`) reads the module, and
// a two-batch flip would leave the first batch failing the gate. The
// carried-answer fields are the scaffold every editor offers: one field per
// Search prompt, seeded from `#search/<name>` and saved to the prompt's
// property where the prompt has one.

import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type FormEntry,
	fieldCaseWrite,
	humanizeId,
	moduleOpensOnSearch,
	proseText,
	type SearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import { FORBIDDEN_CASE_WRITE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import { findContainingForm } from "./mutations/helpers";
import { declareCaseTypeForField, formScaffoldMutations } from "./scaffolds";

/** Turn Search first on for the module, or nothing when it already is. */
export function searchFirstOnMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): Mutation[] {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || moduleOpensOnSearch(mod)) return [];
	// An owner-only module has no Search action to open on; the patch is
	// still emitted so the gate's `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`
	// names that and the whole batch refuses together.
	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {},
			caseSearchConfigPatch: { searchFirst: true },
		},
	];
}

/**
 * Set or clear the form's entry. Setting it also opens the module on
 * Search when it does not already; clearing leaves the module's Search as
 * it is (the module keeps opening on Search until someone turns it off).
 */
export function noMatchesFormEntryMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	entry: FormEntry | null,
): Mutation[] {
	return [
		...(entry === null ? [] : searchFirstOnMutations(doc, moduleUuid)),
		{ kind: "updateForm", uuid: formUuid, patch: { entry } },
	];
}

/**
 * The `#search/<name>` expression for one prompt: the typed leaf, so a
 * renamed prompt never rewrites the field.
 */
function searchAnswerExpression(input: SearchInputDef) {
	return {
		parts: [
			{ kind: "search-answer-ref" as const, searchInputUuid: input.uuid },
		],
	};
}

/**
 * The builder's one-step answer to "register a new case when nothing
 * matches": a registration form born as the module's no-matches form, its
 * `case_name` writer seeded from a Search prompt on the name when the
 * module has one, one field per remaining prompt seeded from its answer
 * (`searchAnswerFields`), and Search first turned on in the same batch.
 * Returns `null` for a module without a case type (nothing to register).
 */
export function noMatchesRegistrationFormMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): { mutations: Mutation[]; formUuid: Uuid; formName: string } | null {
	const mod = doc.modules[moduleUuid];
	if (mod?.caseType === undefined) return null;
	const scaffold = formScaffoldMutations(doc, moduleUuid, "registration");
	if (scaffold === null) return null;
	const formName = `Register ${humanizeId(mod.caseType).toLowerCase()}`;
	const nameInput = (mod.caseListConfig?.searchInputs ?? []).find(
		(input) =>
			input.kind === "simple" &&
			input.type !== "date-range" &&
			input.property === "case_name",
	);
	const mutations: Mutation[] = scaffold.mutations.map((mutation) => {
		if (mutation.kind === "addForm") {
			return {
				...mutation,
				form: {
					...mutation.form,
					name: formName,
					entry: { kind: "search-no-matches" },
				},
			};
		}
		if (
			mutation.kind === "addField" &&
			nameInput !== undefined &&
			mutation.field.kind === "text" &&
			mutation.field.id === "case_name"
		) {
			return {
				...mutation,
				field: {
					...mutation.field,
					default_value: searchAnswerExpression(nameInput),
				},
			};
		}
		return mutation;
	});
	const carried = searchAnswerFields(
		doc,
		moduleUuid,
		new Set(["case_name"]),
		new Set(["case_name"]),
	);
	for (const field of carried) {
		mutations.push(...declareCaseTypeForField(doc, field));
		mutations.push({ kind: "addField", parentUuid: scaffold.formUuid, field });
	}
	mutations.push(...searchFirstOnMutations(doc, moduleUuid));
	return { mutations, formUuid: scaffold.formUuid, formName };
}

/**
 * Append a field per Search prompt of `moduleUuid` that `formUuid` does not
 * carry yet: a prompt whose property one of the form's fields already
 * writes is carried by that field. Empty when every prompt is covered.
 */
export function carrySearchAnswersMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
): Mutation[] {
	const occupiedIds = new Set<string>();
	const occupiedProperties = new Set<string>();
	for (const field of Object.values(doc.fields)) {
		if (findContainingForm(doc, field.uuid) !== formUuid) continue;
		occupiedIds.add(field.id);
		const write = fieldCaseWrite(field);
		if (write !== undefined) occupiedProperties.add(write.property);
	}
	return searchAnswerFields(
		doc,
		moduleUuid,
		occupiedIds,
		occupiedProperties,
	).flatMap((field) => [
		...declareCaseTypeForField(doc, field),
		{ kind: "addField" as const, parentUuid: formUuid, field },
	]);
}

/** Whether a hidden prompt's name can be the case property its value is
 * saved under: an authored property name, and not one the case system owns
 * (a prompt named `case_id`, say, is searched, never written). */
function hiddenPromptSavesAs(name: string): boolean {
	return (
		authoredCasePropertyNameSchema.safeParse(name).success &&
		!FORBIDDEN_CASE_WRITE_PROPERTIES.has(name)
	);
}

/**
 * One field per Search prompt of `moduleUuid`, in prompt order, each seeded
 * from the prompt's answer. A prompt on a case property saves back to it
 * (a `select` keeps the prompt's choices); an advanced prompt, a date range,
 * and a hidden value seed a field with no case destination, except that a
 * hidden value is saved under the prompt's name as provenance of the search
 * (a search time, say) when that name can be a case property. A prompt
 * whose property the form already writes (`occupiedProperties`) is skipped:
 * the authored field carries it, and two writers of one property would not
 * pass the gate. `occupiedIds` are field ids already taken on the form; the
 * returned fields' ids are added to it.
 */
export function searchAnswerFields(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	occupiedIds: Set<string>,
	occupiedProperties: ReadonlySet<string> = new Set(),
): Field[] {
	const mod = doc.modules[moduleUuid];
	const caseType = mod?.caseType;
	const inputs = mod?.caseListConfig?.searchInputs ?? [];
	const fields: Field[] = [];
	for (const input of inputs) {
		const property =
			input.kind === "hidden"
				? hiddenPromptSavesAs(input.name)
					? input.name
					: undefined
				: input.kind === "simple" && input.type !== "date-range"
					? input.property
					: undefined;
		if (property !== undefined && occupiedProperties.has(property)) continue;
		const id = suffixUntilFree(input.name, occupiedIds);
		occupiedIds.add(id);
		const uuid = asUuid(crypto.randomUUID());
		const label = proseText(
			input.label.trim().length > 0 ? input.label : input.name,
		);
		const default_value = searchAnswerExpression(input);
		const caseWrite =
			property !== undefined && caseType !== undefined
				? { caseWrite: { caseType, property } }
				: {};
		if (input.kind === "hidden") {
			fields.push({
				kind: "hidden",
				uuid,
				id,
				default_value,
				...caseWrite,
			});
			continue;
		}
		switch (input.type) {
			case "date":
				fields.push({
					kind: "date",
					uuid,
					id,
					label,
					default_value,
					...caseWrite,
				});
				break;
			case "select":
				fields.push({
					kind: "single_select",
					uuid,
					id,
					label,
					optionsSource: input.options,
					default_value,
					...caseWrite,
				});
				break;
			case "multi-select":
				fields.push({
					kind: "multi_select",
					uuid,
					id,
					label,
					optionsSource: input.options,
					default_value,
					...caseWrite,
				});
				break;
			case "text":
			case "barcode":
			case "date-range":
				fields.push({
					kind: "text",
					uuid,
					id,
					label,
					default_value,
					...caseWrite,
				});
				break;
		}
	}
	return fields;
}
