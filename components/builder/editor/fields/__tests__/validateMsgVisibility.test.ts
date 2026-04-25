/**
 * validateMsgVisibility — pure tests for the validate-message slot.
 *
 * `XPathEditor` renders for several XPath-valued keys (`relevant`,
 * `validate`, `default_value`, `calculate`) but only the `validate`
 * path owns the optional `validate_msg` UX. These rules decide which
 * of the editor / pill / nothing occupies the slot beneath the XPath
 * input. `XPathEditor` is a thin renderer over these helpers plus
 * `EditableText` for the message itself; the XPath editing UX lives
 * in `XPathField`'s tests + Playwright.
 */

import { describe, expect, it } from "vitest";
import {
	shouldShowValidateMsgEditor,
	shouldShowValidateMsgPill,
} from "../validateMsgVisibility";

const FALSY_HINT = undefined;

describe("shouldShowValidateMsgEditor", () => {
	it("false unless keyName === 'validate'", () => {
		// Other XPath-valued keys (relevant, calculate, default_value)
		// don't carry a message — the editor must skip the bundled UX.
		for (const keyName of ["relevant", "calculate", "default_value"]) {
			expect(
				shouldShowValidateMsgEditor({
					keyName,
					hasValidateMsg: true,
					addingMsg: true,
					focusHint: "validate_msg",
				}),
			).toBe(false);
		}
	});

	it("true when a persisted validate_msg exists", () => {
		expect(
			shouldShowValidateMsgEditor({
				keyName: "validate",
				hasValidateMsg: true,
				addingMsg: false,
				focusHint: FALSY_HINT,
			}),
		).toBe(true);
	});

	it("true when the user just clicked the Add Validation Message pill", () => {
		expect(
			shouldShowValidateMsgEditor({
				keyName: "validate",
				hasValidateMsg: false,
				addingMsg: true,
				focusHint: FALSY_HINT,
			}),
		).toBe(true);
	});

	it("true when undo/redo focus hint targets validate_msg", () => {
		// Restoration path: the editor mounts so the hint can attach
		// even if the value isn't yet persisted in this render.
		expect(
			shouldShowValidateMsgEditor({
				keyName: "validate",
				hasValidateMsg: false,
				addingMsg: false,
				focusHint: "validate_msg",
			}),
		).toBe(true);
	});

	it("false when validate is the key but no signals are active", () => {
		expect(
			shouldShowValidateMsgEditor({
				keyName: "validate",
				hasValidateMsg: false,
				addingMsg: false,
				focusHint: FALSY_HINT,
			}),
		).toBe(false);
	});
});

describe("shouldShowValidateMsgPill", () => {
	it("false unless keyName === 'validate'", () => {
		expect(
			shouldShowValidateMsgPill({
				keyName: "calculate",
				current: "1+1",
				hasValidateMsg: false,
				addingMsg: false,
				focusHint: FALSY_HINT,
			}),
		).toBe(false);
	});

	it("false when the parent validate XPath is empty", () => {
		// A message attached to no validation rule has nothing to assert
		// against — collapse the row so the user isn't tempted to write one.
		expect(
			shouldShowValidateMsgPill({
				keyName: "validate",
				current: "",
				hasValidateMsg: false,
				addingMsg: false,
				focusHint: FALSY_HINT,
			}),
		).toBe(false);
	});

	it("true when validate has a value, no message is set, and no add intent", () => {
		// Canonical pill state: the slot is empty and we're inviting the
		// user to fill it.
		expect(
			shouldShowValidateMsgPill({
				keyName: "validate",
				current: "true()",
				hasValidateMsg: false,
				addingMsg: false,
				focusHint: FALSY_HINT,
			}),
		).toBe(true);
	});

	it("false when the message editor is showing instead", () => {
		// Pill and editor are mutually exclusive — if any signal lit the
		// editor (saved value, pill click, focus hint) the pill stays out.
		for (const editorSignal of [
			{ hasValidateMsg: true, addingMsg: false, focusHint: FALSY_HINT },
			{ hasValidateMsg: false, addingMsg: true, focusHint: FALSY_HINT },
			{ hasValidateMsg: false, addingMsg: false, focusHint: "validate_msg" },
		]) {
			expect(
				shouldShowValidateMsgPill({
					keyName: "validate",
					current: "true()",
					...editorSignal,
				}),
			).toBe(false);
		}
	});
});
