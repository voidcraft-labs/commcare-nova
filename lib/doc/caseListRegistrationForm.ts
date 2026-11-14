// lib/doc/caseListRegistrationForm.ts
//
// Planners for a module's case list registration form
// (`Module.caseListRegistrationForm`): a registration form of the module
// that the case list offers on Results after a search found nothing, on no
// menu at all. Naming it turns Forms read the search on in the same batch
// when it is off, because the slot's rule
// (`CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH`) reads the module,
// and a two-batch flip would leave the first batch failing the gate.
// Clearing it is the mirror image: a registration form on the menu makes
// the module forms-first, which `FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE`
// refuses, and a `#search/` read outside the forms of a menu whose forms
// read the search is `INVALID_SEARCH_REF`, so the clear turns Forms read the
// search off and drops the starting values read from the search in the same
// batch. The carried-answer fields are the scaffold every editor offers: one
// field per Search field, seeded from `#search/<name>` and saved to the
// field's property where it has one.

import { produce } from "immer";
import type { Mutation } from "@/lib/doc/types";
import {
	afterEmptySearchRegistrationFormOf,
	asUuid,
	type BlueprintDoc,
	type Field,
	humanizeId,
	menuFormUuidsOf,
	moduleFormsReadSearch,
	moduleHasCaseListMenuItem,
	proseText,
	type SearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { input, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import { FORBIDDEN_CASE_WRITE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import { planFieldCaseWrite } from "./fieldCaseWriteMutations";
import { applyMutations } from "./mutations";
import { walkFormFieldUuids } from "./mutations/helpers";
import { formScaffoldMutations } from "./scaffolds";
import {
	type SearchAnswerFieldDependent,
	searchAnswerFieldDependents,
} from "./searchReadDependents";

/**
 * Turn Forms read the search on for the module, or nothing when its forms
 * already read it. A stored list first is cleared in the same patch, since a
 * menu that opens on its case list can't have its forms read the search
 * (`FORMS_READ_SEARCH_WITH_LIST_FIRST`).
 */
export function formsReadSearchOnMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): Mutation[] {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || moduleFormsReadSearch(mod)) return [];
	// An owner-only module has no Search action for its forms to read; the
	// patch is still emitted so the gate names that and the whole batch
	// refuses together.
	const listFirst =
		mod.caseSearchConfig !== undefined &&
		"workflow" in mod.caseSearchConfig &&
		mod.caseSearchConfig.workflow === "listFirst";
	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {},
			caseSearchConfigPatch: {
				formsReadSearch: true,
				...(listFirst && { workflow: null }),
			},
		},
	];
}

/** Turn Forms read the search off for the module, or nothing when its forms
 * don't read it. */
export function formsReadSearchOffMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): Mutation[] {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || !moduleFormsReadSearch(mod)) return [];
	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {},
			caseSearchConfigPatch: { formsReadSearch: null },
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
 * value: the ones {@link caseListRegistrationMutations} clears when the form
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
 * Name `formUuid` as the module's case list registration form, or stop
 * offering it, landing a module the gate accepts either way.
 *
 * Existing explicit First menu navigation is preserved; a multiple-selection
 * host requires that explicit choice before the commit gate accepts the form.
 * Naming it turns Forms read the search on when the menu's forms don't read
 * it yet. The form leaves the menu, so a module whose only menu form this was
 * gets its case list as a menu entry (`caseListMenuItem: {}`), the one valid
 * shape with no menu forms, when it has none.
 *
 * Clearing it puts a registration form back on the menu, which no menu whose
 * forms read the search may hold, so Forms read the search turns off in the
 * same batch, and every field whose only search read is its starting value
 * loses that `default_value` (`#search/` resolves only in the forms of a menu
 * whose forms read the search). A read in any other slot is left for the
 * gate to name: it is hand-authored, and dropping it would be a decision made
 * for the person. The case list menu entry stays: an authored entry is never
 * removed in passing. A clear of a form the slot does not name plans
 * nothing.
 */
export function caseListRegistrationMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	entry: { readonly label?: string } | null,
): Mutation[] {
	const mod = doc.modules[moduleUuid];
	if (entry === null) {
		if (afterEmptySearchRegistrationFormOf(doc, moduleUuid) !== formUuid)
			return [];
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
			...formsReadSearchOffMutations(doc, moduleUuid),
			...defaultsCleared,
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListRegistrationForm: null },
			},
		];
	}
	const otherMenuForms = menuFormUuidsOf(doc, moduleUuid).filter(
		(uuid) => uuid !== formUuid,
	);
	return [
		...formsReadSearchOnMutations(doc, moduleUuid),
		...(otherMenuForms.length === 0 &&
		mod !== undefined &&
		!moduleHasCaseListMenuItem(mod)
			? [{ kind: "setCaseListMenuItem" as const, uuid: moduleUuid, item: {} }]
			: []),
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {
				caseListRegistrationForm: {
					kind: "after-empty-search",
					formUuid,
					...(entry.label !== undefined && { label: entry.label }),
				},
			},
		},
	];
}

/**
 * The `#search/<name>` expression for one prompt: the typed leaf, so a
 * renamed prompt never rewrites the field.
 */
function searchAnswerExpression(searchInput: SearchInputDef): Expression {
	return term(input(searchInput.uuid));
}

/**
 * The builder's one-step answer to "register a new case when nothing
 * matches": a registration form born as the module's case list registration
 * form, its `case_name` writer seeded from a text Search field on the name
 * when the module has one (a choice token cannot seed the name writer, and a
 * second writer of that property is skipped), one field per remaining Search
 * field seeded from its answer (`searchAnswerFields`), and Forms read the
 * search turned on in the same batch. The new form is on no menu, so the
 * module keeps the menu shape it has: a bare case list stays one. Returns
 * `null` for a module without a case type (nothing to register).
 */
export function caseListRegistrationFormMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	options: { readonly postSubmit?: "firstMenu" } = {},
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
	const mutations: Mutation[] = scaffold.mutations.map((mutation): Mutation => {
		if (mutation.kind === "addForm") {
			return {
				...mutation,
				form: {
					...mutation.form,
					name: formName,
					...(options.postSubmit !== undefined && {
						postSubmit: options.postSubmit,
					}),
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
	mutations.push(
		...searchAnswerFieldMutations(doc, scaffold.formUuid, carried, mutations),
	);
	mutations.push(...formsReadSearchOnMutations(doc, moduleUuid));
	mutations.push({
		kind: "updateModule",
		uuid: moduleUuid,
		patch: {
			caseListRegistrationForm: {
				kind: "after-empty-search",
				formUuid: scaffold.formUuid,
			},
		},
	});
	return { mutations, formUuid: scaffold.formUuid, formName };
}

/**
 * Append a field per Search field of `moduleUuid` that `formUuid` does not
 * carry yet: a prompt whose property the form's own case already saves is
 * carried by that write. Empty when every prompt is covered.
 */
export function carrySearchAnswersMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
): Mutation[] {
	const occupiedIds = new Set<string>();
	for (const fieldUuid of walkFormFieldUuids(doc, formUuid)) {
		const field = doc.fields[fieldUuid];
		if (field !== undefined) occupiedIds.add(field.id);
	}
	const occupiedProperties = new Set<string>();
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation) => operation.action === "own",
	);
	if (own?.name !== undefined) occupiedProperties.add("case_name");
	for (const write of own?.writes ?? []) {
		if (write.via === undefined) occupiedProperties.add(write.property);
	}
	return searchAnswerFieldMutations(
		doc,
		formUuid,
		searchAnswerFields(doc, moduleUuid, occupiedIds, occupiedProperties),
		[],
	);
}

/**
 * One carried answer: the field seeded from its prompt, and the property of
 * the form's own case it saves to, when it saves to one.
 */
export interface SearchAnswerField {
	readonly field: Field;
	readonly savesTo?: { readonly caseType: string; readonly property: string };
}

/**
 * The batch that adds each carried answer to `formUuid` and saves it where
 * it saves, after the `prior` mutations of the same batch. Each write is
 * planned by the one "Saves to" planner (`planFieldCaseWrite`) over the
 * document with every earlier mutation applied, so the batch is the one
 * every editor would build. A write the planner refuses is left out and the
 * field still carries the answer, saving it nowhere.
 */
function searchAnswerFieldMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	answers: readonly SearchAnswerField[],
	prior: readonly Mutation[],
): Mutation[] {
	const mutations: Mutation[] = answers.map(({ field }) => ({
		kind: "addField",
		parentUuid: formUuid,
		field,
	}));
	if (answers.every((answer) => answer.savesTo === undefined)) return mutations;
	let candidate = produce(doc, (draft) => {
		applyMutations(draft, [...prior, ...mutations]);
	});
	for (const { field, savesTo } of answers) {
		if (savesTo === undefined) continue;
		const plan = planFieldCaseWrite(candidate, field.uuid, savesTo);
		if (!plan.ok) continue;
		mutations.push(...plan.mutations);
		candidate = produce(candidate, (draft) => {
			applyMutations(draft, plan.mutations);
		});
	}
	return mutations;
}

/** Whether a hidden prompt's name can be the case property its value is
 * saved under: an authored property name, and not one the case system owns
 * (a prompt named `case_id`, say, is searched, never written). */
function hiddenPromptSavesAs(name: string): boolean {
	return (
		authoredCasePropertyNameSchema.validate(name) &&
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
): SearchAnswerField[] {
	const mod = doc.modules[moduleUuid];
	const caseType = mod?.caseType;
	const inputs = mod?.caseListConfig?.searchInputs ?? [];
	const fields: SearchAnswerField[] = [];
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
		const savesTo =
			property !== undefined && caseType !== undefined
				? { caseType, property }
				: undefined;
		const field = searchAnswerField(input, { uuid, id, label, default_value });
		fields.push(savesTo === undefined ? { field } : { field, savesTo });
	}
	return fields;
}

/** The field one prompt's answer is carried in, by the prompt's kind. */
function searchAnswerField(
	input: SearchInputDef,
	base: {
		readonly uuid: Uuid;
		readonly id: string;
		readonly label: ReturnType<typeof proseText>;
		readonly default_value: Expression;
	},
): Field {
	const { uuid, id, label, default_value } = base;
	if (input.kind === "hidden")
		return { kind: "hidden", uuid, id, default_value };
	switch (input.type) {
		case "date":
			return { kind: "date", uuid, id, label, default_value };
		case "select":
			return {
				kind: "single_select",
				uuid,
				id,
				label,
				optionsSource: input.options,
				default_value,
			};
		case "multi-select":
			return {
				kind: "multi_select",
				uuid,
				id,
				label,
				optionsSource: input.options,
				default_value,
			};
		case "text":
		case "barcode":
		case "date-range":
			return { kind: "text", uuid, id, label, default_value };
	}
}
