// lib/domain/expression/slotLabels.ts
import type { ProseSlotRef, SlotContextRef } from "./types";

/** How an expression slot reads inside a sentence about the thing that
 *  owns it, in the builder's words. The validator's findings and the move
 *  refusals name a slot through this one table. */
export function expressionSlotLabel(slot: SlotContextRef["slot"]): string {
	switch (slot) {
		case "form_badge":
		case "module_badge":
			return "badge";
		case "calculate":
			return "calculated value";
		case "default_value":
			return "starting value";
		case "relevant":
		case "form_display_condition":
			return "display condition";
		case "required":
			return "required condition";
		case "validate":
			return "validation rule";
		case "repeat_count":
			return "repeat count";
		case "ids_query":
			return "case query";
		case "lookup_options_source":
			return "choice filter";
		case "form_selection_source":
			return "case to open with";
		case "form_entry_value":
			return "value calculated at form entry";
		case "form_open_condition":
			return "condition for creating the case";
		case "form_close_condition":
			return "condition for closing the case";
		case "form_link_condition":
			return "after-submit link condition";
		case "form_link_datum_xpath":
			return "after-submit link";
		case "assessment_user_score":
			return "assessment score";
		case "deliver_entity_id":
			return "delivery identifier";
		case "deliver_entity_name":
			return "delivery name";
		default:
			return Object.hasOwn(PROSE_SLOT_LABELS, slot)
				? PROSE_SLOT_LABELS[slot as ProseSlotRef["slot"]]
				: "formula";
	}
}

/** Each text slot's name, total over the prose slots so a new one is named
 *  here before it can compile, rather than read as a "formula". */
const PROSE_SLOT_LABELS: Readonly<Record<ProseSlotRef["slot"], string>> = {
	label: "label",
	hint: "hint",
	help: "help text",
	validate_msg: "validation message",
	extended_text: "extended text",
	qr_code: "QR code",
	spoken_text: "spoken text",
	option_label: "choice label",
};
