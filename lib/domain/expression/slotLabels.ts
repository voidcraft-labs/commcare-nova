// lib/domain/expression/slotLabels.ts
import type { SlotContextRef } from "./types";

/** How an expression slot reads inside a sentence about the thing that
 *  owns it, in the builder's words. The validator's findings and the move
 *  refusals name a slot through this one table. */
export function expressionSlotLabel(slot: SlotContextRef["slot"]): string {
	switch (slot) {
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
		case "label":
			return "label";
		case "hint":
			return "hint";
		case "help":
			return "help text";
		case "validate_msg":
			return "validation message";
		case "option_label":
			return "choice label";
		default:
			return "formula";
	}
}
