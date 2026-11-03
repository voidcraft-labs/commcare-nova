// lib/doc/searchReadDependents.ts
//
// What depends on a module's search when its forms read it, and the
// refusals that name those dependents. A case list registration form
// (`Module.caseListRegistrationForm`) needs the menu's forms to read the
// search, and a form's fields may read the module's Search fields by identity
// (`#search/<name>`). Taking either away would fail the commit gate on the
// form; refusing up front, with the form and fields named, puts the choice
// with the person instead of bouncing a batch off a finding anchored
// somewhere they were not looking (the same reasoning as
// `formLinkDependents.ts`).

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { caseListRegistrationFormOf, entityTargetKey } from "@/lib/domain";
import { findContainingForm } from "./mutations/helpers";
import { referencingSlotsOf } from "./referenceIndex";

/** A form field whose expression reads one Search prompt's answer. */
export interface SearchAnswerFieldDependent {
	readonly formUuid: Uuid;
	readonly formName: string;
	readonly fieldUuid: Uuid;
	readonly fieldId: string;
	/** The registry slot ids on that field holding the read. */
	readonly slots: readonly string[];
}

/** Every field reading `inputUuid`'s answer, in reference-index order. */
export function searchAnswerFieldDependents(
	doc: BlueprintDoc,
	inputUuid: Uuid,
): readonly SearchAnswerFieldDependent[] {
	const dependents: SearchAnswerFieldDependent[] = [];
	for (const [carrierUuid, slots] of referencingSlotsOf(
		doc,
		entityTargetKey(inputUuid),
	)) {
		const field = doc.fields[carrierUuid];
		if (field === undefined) continue;
		const formUuid = findContainingForm(doc, field.uuid);
		const form = formUuid === undefined ? undefined : doc.forms[formUuid];
		if (formUuid === undefined || form === undefined) continue;
		dependents.push({
			formUuid,
			formName: form.name,
			fieldUuid: field.uuid,
			fieldId: field.id,
			slots,
		});
	}
	return dependents;
}

export type SearchReadDependentsPlan =
	| { readonly kind: "none" }
	| {
			readonly kind: "blocked";
			/** SA voice: tool names intact, every uuid addressable. */
			readonly message: string;
			/** Builder voice. */
			readonly userMessage: string;
	  };

/** What is being taken away from the module's Search. */
export type SearchTakeaway = "forms-read-search" | "search";

/**
 * The refusal, or `none`, for turning Forms read the search off or removing
 * Search from `moduleUuid` while its case list registration form depends on
 * it.
 */
export function planSearchTakeawayDependents(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	takeaway: SearchTakeaway,
): SearchReadDependentsPlan {
	const formUuid = caseListRegistrationFormOf(doc, moduleUuid);
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	if (form === undefined) return { kind: "none" };
	const mod = doc.modules[moduleUuid];
	const moduleName = mod?.name ?? "this module";
	const action =
		takeaway === "forms-read-search"
			? "turn Forms read the search off for"
			: "remove Search from";
	const message =
		`Cannot ${action} module "${moduleName}" (${moduleUuid}): form "${form.name}" (${form.uuid}) opens from the case list when a search finds nothing, which needs the menu's forms to read the search. ` +
		`Stop offering it with update_form (case_list_registration: null), which turns Forms read the search off and drops the starting values its fields read from the search in the same call, or remove it with remove_form, then change the module's Search.`;
	const userMessage =
		`"${moduleName}" keeps its forms reading the search for now: "${form.name}" opens when a search finds nothing. ` +
		`Make "${form.name}" a menu form again (Forms read the search turns off with it), or remove it, then try again.`;
	return { kind: "blocked", message, userMessage };
}

/**
 * The refusal, or `none`, for removing Search prompt `inputUuid` while a
 * form's fields still read its answer.
 */
export function planSearchInputRemovalFieldDependents(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	inputUuid: Uuid,
): SearchReadDependentsPlan {
	const dependents = searchAnswerFieldDependents(doc, inputUuid);
	if (dependents.length === 0) return { kind: "none" };
	const input = doc.modules[moduleUuid]?.caseListConfig?.searchInputs.find(
		(candidate) => candidate.uuid === inputUuid,
	);
	const inputName = input?.name ?? "this Search prompt";
	const references = dependents.map(
		(dependent) =>
			`field "${dependent.fieldId}" in "${dependent.formName}" (field ${dependent.fieldUuid}; ${dependent.slots.join(", ")})`,
	);
	const fieldList = dependents.map((dependent) => `"${dependent.fieldId}"`);
	const joined =
		fieldList.length === 1
			? fieldList[0]
			: `${fieldList.slice(0, -1).join(", ")} and ${fieldList.at(-1)}`;
	const message =
		`Cannot remove Search prompt "${inputName}" (${inputUuid}): ${dependents.length === 1 ? "a field reads" : `${dependents.length} fields read`} its answer as #search/${inputName}: ${references.join("; ")}. ` +
		`Change ${dependents.length === 1 ? "that expression" : "those expressions"} with edit_field, then remove the prompt.`;
	const userMessage =
		`"${inputName}" can't be removed yet: ${joined} in "${dependents[0].formName}" ${dependents.length === 1 ? "uses" : "use"} its answer. ` +
		`Change ${dependents.length === 1 ? "that field" : "those fields"}, then try again.`;
	return { kind: "blocked", message, userMessage };
}
