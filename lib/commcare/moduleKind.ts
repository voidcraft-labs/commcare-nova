/**
 * Whether CommCare HQ receives a menu as a basic module or an advanced one.
 *
 * Nova never offers the kind as a choice. A menu is emitted advanced where
 * nothing keeps it from being one (`lib/domain/advancedModule.ts::
 * advancedKindBlockers`) and either its kind is held (`Module.heldKind`: a
 * publish or the cutover recorded that CommCare HQ holds it as advanced) or
 * one of its forms holds a create an after-submit link carries that a basic
 * form gives no session datum. HQ gives a basic form's new case a datum
 * only as the registration's own case or as a subcase outside a repeat
 * (`suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`),
 * and an advanced form's to every open action outside a repeat, which is
 * what a link's target reads (`suite_xml/post_process/workflow.py::
 * _find_best_match`).
 *
 * The answer is the domain's (`lib/domain/advancedEntryDatums.ts::
 * menuEmittedAdvanced`, with `advancedKindTriggers` for why), because the
 * session values an entry supplies read it too. It reads the basic slots a
 * form would take (`lib/domain/basicCaseSlots.ts::basicCaseSlots`), which
 * never ask a menu's kind, and the carried creates
 * (`advancedEntryDatums.ts::carriedCreates`), which read every menu's entry
 * as a basic menu's; so the kind of one menu never asks another's, and the
 * answer is the same whichever menu is asked first.
 */

import {
	advancedKindBlockers,
	type BlueprintDoc,
	type Uuid,
} from "@/lib/domain";
import {
	type AdvancedKindReason,
	advancedKindTriggers,
	menuEmittedAdvanced,
} from "@/lib/domain/advancedEntryDatums";

export type { AdvancedKindReason } from "@/lib/domain/advancedEntryDatums";

export type EmittedModuleKind = "basic" | "advanced";

/**
 * Why `moduleUuid` is emitted advanced: its held kind, then each carried
 * create its forms hold that a basic form gives no session datum. Empty
 * where the menu is emitted basic, a blocker included.
 */
export function advancedKindReasons(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly AdvancedKindReason[] {
	return advancedKindBlockers(doc, moduleUuid).length > 0
		? []
		: advancedKindTriggers(doc, moduleUuid);
}

/**
 * The kind the emitter writes for a module: advanced where its kind is held
 * or a carried create needs it, and nothing blocks it.
 */
export function emittedModuleKind(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): EmittedModuleKind {
	return menuEmittedAdvanced(doc, moduleUuid) ? "advanced" : "basic";
}
