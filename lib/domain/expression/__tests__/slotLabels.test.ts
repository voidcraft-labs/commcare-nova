/**
 * How a slot reads inside a finding or a refusal about it.
 *
 * Contract: every text slot of a field is named as the text it is, so a finding about a
 * reference inside a QR code says "QR code", not the question's "formula".
 *
 * Plausible failure: a prose slot added to the domain without a name here, read as a formula.
 */

import { describe, expect, it } from "vitest";
import { FIELD_PROSE_SLOTS } from "../../labelForms";
import { expressionSlotLabel } from "../slotLabels";

describe("expressionSlotLabel", () => {
	it("names each text slot as the text it is", () => {
		expect(
			Object.fromEntries(
				[...FIELD_PROSE_SLOTS, "option_label" as const].map((slot) => [
					slot,
					expressionSlotLabel(slot),
				]),
			),
		).toEqual({
			label: "label",
			hint: "hint",
			help: "help text",
			validate_msg: "validation message",
			extended_text: "extended text",
			extended_hint: "extended hint",
			extended_help: "extended help",
			extended_validate_msg: "extended validation message",
			qr_code: "QR code",
			spoken_text: "spoken text",
			addFirstLabel: "first entry button",
			addLabel: "add entry button",
			option_label: "choice label",
		});
		expect(expressionSlotLabel("calculate")).toBe("calculated value");
	});
});
