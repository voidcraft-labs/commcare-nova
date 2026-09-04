// lib/doc/searchNoMatchesDependents.ts
//
// What depends on a module's Search when it has a no-matches registration
// form, and the refusals that name those dependents. A no-matches form
// (`Form.entry` of kind `search-no-matches`) needs the module to open on
// Search, and its fields may read the module's Search prompts by identity
// (`#search/<name>`). Taking either away would fail the commit gate on the
// form; refusing up front, with the form and fields named, puts the choice
// with the person instead of bouncing a batch off a finding anchored
// somewhere they were not looking (the same reasoning as
// `formLinkDependents.ts`).

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { entityTargetKey, noMatchesFormOf } from "@/lib/domain";
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

export type SearchNoMatchesDependentsPlan =
	| { readonly kind: "none" }
	| {
			readonly kind: "blocked";
			/** SA voice: tool names intact, every uuid addressable. */
			readonly message: string;
			/** Builder voice. */
			readonly userMessage: string;
	  };

/** What is being taken away from the module's Search. */
export type SearchTakeaway = "search-first" | "search";

/**
 * The refusal, or `none`, for turning Search first off or removing Search
 * from `moduleUuid` while a no-matches registration form depends on it.
 */
export function planSearchTakeawayDependents(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	takeaway: SearchTakeaway,
): SearchNoMatchesDependentsPlan {
	const form = noMatchesFormOf(doc, moduleUuid);
	if (form === undefined) return { kind: "none" };
	const mod = doc.modules[moduleUuid];
	const moduleName = mod?.name ?? "this module";
	const action =
		takeaway === "search-first"
			? "turn Search first off for"
			: "remove Search from";
	const message =
		`Cannot ${action} module "${moduleName}" (${moduleUuid}): form "${form.name}" (${form.uuid}) opens after a search finds no matches, which needs the module to open on Search. ` +
		`Clear that form's entry with update_form (entry: null) so it becomes a menu form, or remove it with remove_form, then change the module's Search.`;
	const userMessage =
		`"${moduleName}" keeps opening on Search for now: "${form.name}" opens when a search finds nothing. ` +
		`Make "${form.name}" a menu form again, or remove it, then try again.`;
	return { kind: "blocked", message, userMessage };
}

/**
 * The refusal, or `none`, for removing Search prompt `inputUuid` while a
 * no-matches form's fields still read its answer.
 */
export function planSearchInputRemovalFieldDependents(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	inputUuid: Uuid,
): SearchNoMatchesDependentsPlan {
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
