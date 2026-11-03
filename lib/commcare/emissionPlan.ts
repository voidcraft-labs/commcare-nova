/**
 * The ONE derived module sequence both emitters walk.
 *
 * Nova's document keeps a case list registration form (the form a module's
 * `caseListRegistrationForm` names) inside the module whose Search it serves. The
 * CommCare wire cannot: a module's forms are its menu, and the form must be
 * reachable only through the Register action on Results. HQ's shape for
 * that is `case_list_form` on the host plus a hidden module that owns the
 * form (`module_filter: "false()"`, `<menu relevant="false()">`), so the
 * boundary lowers each registration form into a SYNTHETIC module appended
 * after every authored module, in host order. The synthetic module carries
 * the host's case type and nothing else: no case list, no Search, no menu
 * media, one form.
 *
 * `expandDoc` and `compileCcz` both call `emissionPlan(doc)` on the
 * authored document and walk `plan.doc`, so `m{N}` indexes, HQ unique ids,
 * and the compiler's lockstep over `hqJson.modules` agree by construction.
 * The synthetic module's uuid is a v5 derivation of the form's uuid, so the
 * plan is deterministic and the HQ-JSON oracle can name it.
 */

import { v5 as uuidv5 } from "uuid";
import {
	asUuid,
	type BlueprintDoc,
	caseListRegistrationFormOf,
	type Form,
	type Module,
	makeTranslationUnitId,
	moduleFormsReadSearch,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { INLINE_SEARCH_INPUT_INSTANCE_ID } from "./suite/case-search/noMatches";

/** Namespace for synthetic module uuids; changing it re-ids every export. */
const SYNTHETIC_MODULE_NAMESPACE = "6f1a9d0e-4b8c-4f0a-9c2d-3e5b7a1c8d2f";

export interface SyntheticModule {
	/** The derived uuid the wire doc lists in `moduleOrder`. */
	readonly moduleUuid: Uuid;
	/** The authored module whose Results offers the form. */
	readonly hostModuleUuid: Uuid;
	/** The case list registration form the synthetic module owns. */
	readonly formUuid: Uuid;
	readonly caseType: string;
}

export interface EmissionPlan {
	/** The document the emitters walk: authored modules with their menu
	 *  forms, then one synthetic module per case list registration form. */
	readonly doc: BlueprintDoc;
	/** Synthetic modules keyed by their derived uuid. */
	readonly synthetic: ReadonlyMap<Uuid, SyntheticModule>;
	/** The host module's case list registration form, keyed by host uuid. */
	readonly caseListRegistrationOf: ReadonlyMap<Uuid, SyntheticModule>;
}

export function syntheticModuleUuid(formUuid: Uuid): Uuid {
	return asUuid(uuidv5(formUuid, SYNTHETIC_MODULE_NAMESPACE));
}

function syntheticModule(
	host: Module,
	form: Form,
	moduleUuid: Uuid,
	caseType: string,
): Module {
	return {
		uuid: moduleUuid,
		id: `${host.id}_${form.id}`,
		name: form.name,
		caseType,
	};
}

/**
 * Whether a module can host its case list registration form on the wire: its
 * forms read the search and it has a case type. Elsewhere the slot is a
 * validator finding, and a total emitter still needs a shape for it, so the
 * form stays a menu form of its module.
 */
export function hostLowersCaseListRegistration(
	host: Module | undefined,
): host is Module & { caseType: string } {
	return (
		host !== undefined &&
		moduleFormsReadSearch(host) &&
		host.caseType !== undefined &&
		host.caseType !== ""
	);
}

export function emissionPlan(doc: BlueprintDoc): EmissionPlan {
	const synthetic = new Map<Uuid, SyntheticModule>();
	const caseListRegistrationOf = new Map<Uuid, SyntheticModule>();
	const modules: Record<string, Module> = { ...doc.modules };
	const formOrder: Record<string, Uuid[]> = {};
	const appended: Uuid[] = [];

	for (const hostUuid of doc.moduleOrder) {
		const host = doc.modules[hostUuid];
		const registration = caseListRegistrationFormOf(doc, hostUuid);
		const menuForms: Uuid[] = [];
		for (const formUuid of doc.formOrder[hostUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			if (formUuid === registration && hostLowersCaseListRegistration(host)) {
				const moduleUuid = syntheticModuleUuid(formUuid);
				const entry: SyntheticModule = {
					moduleUuid,
					hostModuleUuid: hostUuid,
					formUuid,
					caseType: host.caseType,
				};
				synthetic.set(moduleUuid, entry);
				caseListRegistrationOf.set(hostUuid, entry);
				modules[moduleUuid] = syntheticModule(
					host,
					form,
					moduleUuid,
					host.caseType,
				);
				formOrder[moduleUuid] = [formUuid];
				appended.push(moduleUuid);
				continue;
			}
			menuForms.push(formUuid);
		}
		formOrder[hostUuid] = menuForms;
	}
	if (appended.length === 0) {
		return { doc, synthetic, caseListRegistrationOf };
	}
	return {
		doc: {
			...doc,
			modules,
			moduleOrder: [...doc.moduleOrder, ...appended],
			formOrder,
		},
		synthetic,
		caseListRegistrationOf,
	};
}

/**
 * The Register action's label unit: the label the host's
 * `caseListRegistrationForm` holds when it has one, else the form's name.
 */
export function caseListFormLabelUnit(
	doc: BlueprintDoc,
	hostModuleUuid: Uuid,
	formUuid: Uuid,
): TranslationUnitId {
	return doc.modules[hostModuleUuid]?.caseListRegistrationForm?.label !==
		undefined
		? makeTranslationUnitId(
				"module",
				hostModuleUuid,
				"case-list-registration-label",
			)
		: makeTranslationUnitId("form", formUuid, "name");
}

/**
 * The case list menu entry's label unit: the entry's own label when it has
 * one, else the module's name with its translations.
 */
export function caseListMenuItemLabelUnit(
	mod: Pick<Module, "uuid" | "caseListMenuItem">,
): TranslationUnitId {
	return mod.caseListMenuItem?.label !== undefined
		? makeTranslationUnitId("module", mod.uuid, "case-list-menu-item-label")
		: makeTranslationUnitId("module", mod.uuid, "name");
}

/**
 * The `#search/` vocabulary of a case list registration form: the host module's prompt
 * names, read from the inline search's search-input instance.
 */
export function searchAnswersOf(
	doc: BlueprintDoc,
	hostModuleUuid: Uuid,
): {
	readonly instanceId: typeof INLINE_SEARCH_INPUT_INSTANCE_ID;
	readonly names: ReadonlyMap<Uuid, string>;
} {
	return {
		instanceId: INLINE_SEARCH_INPUT_INSTANCE_ID,
		names: new Map(
			(doc.modules[hostModuleUuid]?.caseListConfig?.searchInputs ?? []).map(
				(input) => [input.uuid, input.name],
			),
		),
	};
}
