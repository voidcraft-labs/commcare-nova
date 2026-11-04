/**
 * Hand-built advanced form actions and one advanced app holding them, at the
 * values Nova writes (part 02 §7.3): a load chosen from a menu's case list, a
 * load of a case it indexes, the worker's own record and a create linked to
 * the first load. The shells' tests and the HQ JSON oracle's read these.
 */

import type {
	AdvancedFormActions,
	AdvancedOpenCaseAction,
	HqApplication,
	LoadUpdateAction,
} from "@/lib/commcare";
import {
	type HqAdvancedFormTree,
	type HqAdvancedModuleTree,
	type HqApplicationTree,
	serializeHqApplication,
} from "../hqJson/xpath";
import {
	advancedFormShell,
	advancedModuleShell,
	alwaysCondition,
	applicationShell,
	detailColumn,
	detailPair,
	ifCondition,
	neverCondition,
	noCaseIndex,
} from "../hqShells";

export const LIST_MODULE_ID = "advanced-module-id";

/** The household chosen from this menu's case list, with one property written. */
export function listLoad(): LoadUpdateAction {
	return {
		doc_type: "LoadUpdateAction",
		case_type: "household",
		case_tag: "load_household_0",
		details_module: LIST_MODULE_ID,
		case_properties: {
			visited: { question_path: "/data/visited", update_mode: "always" },
		},
		preload: {},
		close_condition: neverCondition(),
		case_index: noCaseIndex(),
		auto_select: null,
		load_case_from_fixture: null,
		show_product_stock: false,
		product_program: "",
	};
}

/** A member case loaded as a child of the household, closed on an answer. */
export function childLoad(): LoadUpdateAction {
	return {
		...listLoad(),
		case_type: "member",
		case_tag: "load_member_1",
		case_properties: {},
		close_condition: ifCondition("/data/moved", "yes"),
		case_index: {
			doc_type: "CaseIndex",
			tag: "load_household_0",
			reference_id: "parent",
			relationship: "child",
			relationship_question: "",
		},
	};
}

/** The worker's own record, chosen automatically, with no case list. */
export function workerLoad(): LoadUpdateAction {
	return {
		...listLoad(),
		case_type: "commcare-user",
		case_tag: "load_commcare-user_2",
		details_module: null,
		case_properties: {
			last_visit: { question_path: "/data/today", update_mode: "always" },
		},
		auto_select: {
			doc_type: "AutoSelectCase",
			mode: "usercase",
			value_source: "",
			value_key: "",
		},
	};
}

/** A visit created as an extension of the household. */
export function openExtension(): AdvancedOpenCaseAction {
	return {
		doc_type: "AdvancedOpenCaseAction",
		case_type: "visit",
		case_tag: "open_visit_0",
		name_update: {
			question_path: "/data/nova_trimmed_visit_name",
			update_mode: "always",
		},
		case_properties: {
			kind: { question_path: "/data/kind", update_mode: "always" },
		},
		repeat_context: "",
		case_indices: [
			{
				doc_type: "CaseIndex",
				tag: "load_household_0",
				reference_id: "host",
				relationship: "extension",
				relationship_question: "",
			},
		],
		open_condition: alwaysCondition(),
		close_condition: neverCondition(),
	};
}

export function advancedActions(): AdvancedFormActions {
	return {
		doc_type: "AdvancedFormActions",
		load_update_cases: [listLoad(), childLoad(), workerLoad()],
		open_cases: [openExtension()],
	};
}

export function advancedForm(
	actions: AdvancedFormActions = advancedActions(),
): HqAdvancedFormTree {
	return advancedFormShell(
		"advanced-form-id",
		{ en: "Visit household" },
		"http://openrosa.org/formdesigner/advanced-visit",
		actions,
		{},
		{},
		"default",
		null,
		[],
	);
}

export function advancedModule(
	forms: HqAdvancedFormTree[] = [advancedForm()],
	languages: readonly string[] = ["en"],
): HqAdvancedModuleTree {
	return advancedModuleShell(
		LIST_MODULE_ID,
		{ en: "Households" },
		"household",
		forms,
		detailPair([detailColumn("name", "Name")]),
		languages[0] ?? "en",
		languages,
	);
}

export function advancedAppTree(): HqApplicationTree {
	return applicationShell(
		"Households",
		[advancedModule()],
		{},
		{ cloudcareEnabled: true },
	);
}

export function advancedApp(): HqApplication {
	return serializeHqApplication(advancedAppTree());
}
