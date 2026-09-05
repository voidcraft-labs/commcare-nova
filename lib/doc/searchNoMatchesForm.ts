// lib/doc/searchNoMatchesForm.ts
//
// Planners for the no-matches registration form: the one form of a
// search-first module that opens from Results after a search found nothing
// (`Form.entry` of kind `search-no-matches`). Setting the entry turns Search
// first on in the same batch when it is off, because the form's rule
// (`SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST`) reads the module, and
// a two-batch flip would leave the first batch failing the gate. Clearing
// it is the mirror image: a registration form on the menu makes the module
// forms-first, which `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE` refuses, and
// a `#search/` read outside a no-matches form is `INVALID_SEARCH_REF`, so
// the clear turns Search first off and drops the starting values read from
// the search in the same batch. The carried-answer fields are the scaffold
// every editor offers: one field per Search prompt, seeded from
// `#search/<name>` and saved to the prompt's property where the prompt has
// one.

import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type FormEntry,
	fieldCaseWrite,
	humanizeId,
	menuFormUuidsOf,
	moduleOpensOnSearch,
	proseText,
	type SearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import { FORBIDDEN_CASE_WRITE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import { walkFormFieldUuids } from "./mutations/helpers";
import { declareCaseTypeForField, formScaffoldMutations } from "./scaffolds";
import {
	type SearchAnswerFieldDependent,
	searchAnswerFieldDependents,
} from "./searchNoMatchesDependents";

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
 * The fields of `formUuid` reading any of `moduleUuid`'s Search prompts,
 * one entry per field with every slot holding a read.
 */
export function searchAnswerReadersOf(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
): readonly SearchAnswerFieldDependent[] {
	const inputs = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
	const readers = new Map<Uuid, SearchAnswerFieldDependent>();
	for (const input of inputs) {
		for (const dependent of searchAnswerFieldDependents(doc, input.uuid)) {
			if (dependent.formUuid !== formUuid) continue;
			const known = readers.get(dependent.fieldUuid);
			readers.set(
				dependent.fieldUuid,
				known === undefined
					? dependent
					: {
							...known,
							slots: [
								...known.slots,
								...dependent.slots.filter(
									(slot) => !known.slots.includes(slot),
								),
							],
						},
			);
		}
	}
	return [...readers.values()];
}

/**
 * The fields of `formUuid` whose only read of the search is their starting
 * value: the ones {@link noMatchesFormEntryMutations} clears when the form
 * returns to the menu. A field reading an answer anywhere else keeps its
 * expression and the gate names it.
 */
export function searchAnswerDefaultsOf(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
): readonly SearchAnswerFieldDependent[] {
	return searchAnswerReadersOf(doc, moduleUuid, formUuid).filter((reader) =>
		reader.slots.every((slot) => slot === "default_value"),
	);
}

/**
 * Set or clear the form's entry, landing a module the gate accepts either
 * way.
 *
 * Existing explicit App home navigation is preserved; a multiple-selection
 * host requires that explicit choice before the commit gate accepts the form.
 * Setting it opens the module on Search when it does not already, and
 * moves the menu shape with the form: a module whose only menu form this
 * was becomes a case list with no menu forms (`caseListOnly`, the one valid
 * formless shape, and the one the search-first rule admits).
 *
 * Clearing it puts a registration form back on the menu, which no module
 * that opens on Search may hold, so Search first turns off in the same
 * batch (the module lands on its case list with a Search button again), a
 * bare host loses `caseListOnly`, and every field whose only search read is
 * its starting value loses that `default_value` (`#search/` resolves inside
 * a no-matches form alone). A read in any other slot is left for the gate
 * to name: it is hand-authored, and dropping it would be a decision made
 * for the person.
 */
export function noMatchesFormEntryMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	entry: FormEntry | null,
): Mutation[] {
	const mod = doc.modules[moduleUuid];
	if (entry === null) {
		const defaultsCleared = searchAnswerDefaultsOf(
			doc,
			moduleUuid,
			formUuid,
		).flatMap((reader): Mutation[] => {
			const field = doc.fields[reader.fieldUuid];
			if (field === undefined) return [];
			return [
				{
					kind: "updateField",
					uuid: field.uuid,
					targetKind: field.kind,
					patch: { default_value: null },
				} as Mutation,
			];
		});
		return [
			...(mod !== undefined && moduleOpensOnSearch(mod)
				? [
						{
							kind: "updateModule" as const,
							uuid: moduleUuid,
							patch: {},
							caseSearchConfigPatch: { searchFirst: null },
						},
					]
				: []),
			...(mod?.caseListOnly === true
				? [
						{
							kind: "updateModule" as const,
							uuid: moduleUuid,
							patch: { caseListOnly: false },
						},
					]
				: []),
			...defaultsCleared,
			{ kind: "updateForm", uuid: formUuid, patch: { entry: null } },
		];
	}
	const otherMenuForms = menuFormUuidsOf(doc, moduleUuid).filter(
		(uuid) => uuid !== formUuid,
	);
	return [
		...searchFirstOnMutations(doc, moduleUuid),
		...(otherMenuForms.length === 0 && mod?.caseListOnly !== true
			? [
					{
						kind: "updateModule" as const,
						uuid: moduleUuid,
						patch: { caseListOnly: true },
					},
				]
			: []),
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
 * `case_name` writer seeded from a text Search prompt on the name when the
 * module has one (a choice prompt on the name is carried as its own choice
 * field instead, since its answer is an option token), one field per
 * remaining prompt seeded from its answer (`searchAnswerFields`), and
 * Search first turned on in the same batch. A module with no menu forms
 * stays the case list it is (`caseListOnly`): the new form is not a menu
 * form, so the scaffold's viewer-to-menu flip would leave a module with no
 * forms and no case list. Returns `null` for a module without a case type
 * (nothing to register).
 */
export function noMatchesRegistrationFormMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	options: { readonly postSubmit?: "app_home" } = {},
): { mutations: Mutation[]; formUuid: Uuid; formName: string } | null {
	const mod = doc.modules[moduleUuid];
	if (mod?.caseType === undefined) return null;
	const scaffold = formScaffoldMutations(doc, moduleUuid, "registration");
	if (scaffold === null) return null;
	const formName = `Register ${humanizeId(mod.caseType).toLowerCase()}`;
	const nameInput = (mod.caseListConfig?.searchInputs ?? []).find(
		(input) =>
			input.kind === "simple" &&
			(input.type === "text" || input.type === "barcode") &&
			input.property === "case_name",
	);
	const keepsViewer =
		mod.caseListOnly === true && menuFormUuidsOf(doc, moduleUuid).length === 0;
	const mutations: Mutation[] = scaffold.mutations.flatMap(
		(mutation): Mutation[] => {
			if (keepsViewer && mutation.kind === "updateModule") {
				const { caseListOnly, ...patch } = mutation.patch;
				if (caseListOnly !== false) return [mutation];
				const rest = { ...mutation, patch };
				const carriesMore =
					Object.keys(patch).length > 0 ||
					Object.keys(rest).some(
						(key) => !["kind", "uuid", "patch"].includes(key),
					);
				return carriesMore ? [rest] : [];
			}
			if (mutation.kind === "addForm") {
				return [
					{
						...mutation,
						form: {
							...mutation.form,
							name: formName,
							entry: { kind: "search-no-matches" },
							...(options.postSubmit !== undefined && {
								postSubmit: options.postSubmit,
							}),
						},
					},
				];
			}
			if (
				mutation.kind === "addField" &&
				nameInput !== undefined &&
				mutation.field.kind === "text" &&
				mutation.field.id === "case_name"
			) {
				return [
					{
						...mutation,
						field: {
							...mutation.field,
							default_value: searchAnswerExpression(nameInput),
						},
					},
				];
			}
			return [mutation];
		},
	);
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
	for (const fieldUuid of walkFormFieldUuids(doc, formUuid)) {
		const field = doc.fields[fieldUuid];
		if (field === undefined) continue;
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
 * pass the gate. Two prompts on one property (a typed and a scanned phone,
 * say) are legal on the Search screen, so the first carries the property
 * and the rest are skipped the same way. `occupiedIds` are field ids
 * already taken on the form; the returned fields' ids and properties are
 * added to the two sets.
 */
export function searchAnswerFields(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	occupiedIds: Set<string>,
	occupiedProperties: Set<string> = new Set(),
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
		if (property !== undefined) {
			if (occupiedProperties.has(property)) continue;
			occupiedProperties.add(property);
		}
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
