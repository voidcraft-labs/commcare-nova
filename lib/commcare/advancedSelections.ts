/**
 * The cases an advanced form loads.
 *
 * An advanced form makes the selections its module's parent-selection chain
 * gives, and the worker's load where it writes the worker's record. The
 * chain is the domain's (`lib/domain/advancedEntryDatums.ts::
 * advancedLoadChain`), which the entry's session values read too: each
 * module of the chain, from the root of the module's parent selection down
 * to the module, is one load in root-first order, each after the first
 * indexed to the one before it under the one index name the app's links
 * between the two types use (`lib/domain/advancedModule.ts::
 * advancedChainIndex`). The last is the form's own load, which is HQ's
 * `last_real_action` (`xform.py::XForm._create_casexml_advanced`: the last
 * load of the module's type that HQ does not select on its own).
 * Registrations and surveys load no case: HQ's entry asks for no case before
 * a form that needs none
 * (`suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module`),
 * and `AdvancedForm.is_registration_form` holds only for a form with no
 * load of its own.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { planPlacements } from "./placement";

/** One load of an advanced form, in `load_update_cases` order. */
export interface PlannedLoad {
	readonly tag: string;
	readonly caseType: string;
	/** The module whose list the case is chosen from; null for the worker's
	 *  load, which HQ selects from the session. */
	readonly listModule: Uuid | null;
	/** The load this one is chosen under, and the index name it follows. */
	readonly index?: { readonly tag: string; readonly identifier: string };
	/** The form's own case: the chain's last load. */
	readonly own: boolean;
	/** The worker's own record, the form's last load. */
	readonly worker: boolean;
}

/**
 * The loads of `formUuid`, in `load_update_cases` order: its chain's, root
 * first, then the worker's where the form's placements put a `worker-record`
 * update on it. Each load's tag is the one its placements hold (part 01's
 * `{advanced, tag}`), allocated by `advancedTags.ts::allocateAdvancedTags`.
 * Empty for a form its menu emits as a basic form.
 */
export function advancedFormLoads(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly PlannedLoad[] {
	return planPlacements(doc, formUuid).advanced?.loads ?? [];
}
