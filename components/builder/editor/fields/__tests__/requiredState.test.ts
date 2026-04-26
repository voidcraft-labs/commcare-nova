/**
 * requiredState — pure tests for the tri-state lifecycle helpers.
 *
 *   - `deriveRequiredState(value)` decides toggle position + condition
 *     visibility for every value the registry can serve.
 *   - `nextRequiredValue(transition)` decides what value to write for
 *     each user action — including the load-bearing rules that empty
 *     condition input falls back to the sentinel and that removing a
 *     condition leaves the toggle on.
 *   - `shouldShowConditionEditor(...)` decides when the nested XPath
 *     editor mounts vs the Add Condition pill.
 *
 * `RequiredEditor` is a pure renderer over these helpers. The XPath
 * editing experience that mounts when a condition is active is owned
 * by `XPathField`'s tests + Playwright.
 */

import { describe, expect, it } from "vitest";
import {
	ALWAYS_REQUIRED,
	deriveRequiredState,
	nextRequiredValue,
	shouldShowConditionEditor,
} from "../requiredState";

describe("deriveRequiredState", () => {
	it("undefined → off, no condition", () => {
		expect(deriveRequiredState(undefined)).toEqual({
			enabled: false,
			hasCondition: false,
			conditionValue: "",
		});
	});

	it('"true()" sentinel → on, no condition', () => {
		// The sentinel is the always-required default. The toggle reads as
		// on but the condition area collapses to the Add Condition pill —
		// `hasCondition: false` is the signal for that branch.
		expect(deriveRequiredState(ALWAYS_REQUIRED)).toEqual({
			enabled: true,
			hasCondition: false,
			conditionValue: "",
		});
	});

	it("non-sentinel XPath → on, condition surfaces with the raw expression", () => {
		// `conditionValue` becomes the value the XPath editor renders.
		// Pinning the exact string ensures we don't accidentally trim,
		// quote, or normalize the expression on read.
		expect(deriveRequiredState("age > 18")).toEqual({
			enabled: true,
			hasCondition: true,
			conditionValue: "age > 18",
		});
	});

	it("treats the empty string as undefined for derivation", () => {
		// Defensive: empty string isn't a legal `required` value in the
		// schema, but if it ever lands the editor should fall back to off
		// rather than render an empty condition.
		expect(deriveRequiredState("")).toEqual({
			enabled: false,
			hasCondition: false,
			conditionValue: "",
		});
	});
});

describe("nextRequiredValue", () => {
	it("toggle-on writes the always-required sentinel", () => {
		expect(nextRequiredValue({ type: "toggle-on" })).toBe(ALWAYS_REQUIRED);
	});

	it("toggle-off clears the property entirely (undefined)", () => {
		// Undefined is the reducer's removal patch — the property is
		// stripped from the field, not left as an empty string.
		expect(nextRequiredValue({ type: "toggle-off" })).toBeUndefined();
	});

	it("save-condition writes the new XPath verbatim", () => {
		expect(
			nextRequiredValue({ type: "save-condition", next: "age > 18" }),
		).toBe("age > 18");
	});

	it("save-condition with empty input falls back to the always-required sentinel", () => {
		// Critical UX rule: an empty condition commit means "I want it
		// required, but no condition" — the toggle must stay on. Without
		// this fallback the user would silently disable the field.
		expect(nextRequiredValue({ type: "save-condition", next: "" })).toBe(
			ALWAYS_REQUIRED,
		);
	});

	it("remove-condition reverts to the always-required sentinel (toggle stays on)", () => {
		// Removing a condition is "I no longer need this rule", not "I
		// don't want this required" — the toggle remains on.
		expect(nextRequiredValue({ type: "remove-condition" })).toBe(
			ALWAYS_REQUIRED,
		);
	});
});

describe("shouldShowConditionEditor", () => {
	it("false when the toggle is off — no editor, no pill", () => {
		expect(
			shouldShowConditionEditor({
				enabled: false,
				hasCondition: false,
				addingCondition: false,
				shouldOpenCondition: false,
			}),
		).toBe(false);
	});

	it("false when on but no condition exists and no add intent — pill takes over", () => {
		expect(
			shouldShowConditionEditor({
				enabled: true,
				hasCondition: false,
				addingCondition: false,
				shouldOpenCondition: false,
			}),
		).toBe(false);
	});

	it("true when a condition is already saved", () => {
		// Existing-condition path: the editor mounts immediately so the
		// user can see and edit the expression on first render.
		expect(
			shouldShowConditionEditor({
				enabled: true,
				hasCondition: true,
				addingCondition: false,
				shouldOpenCondition: false,
			}),
		).toBe(true);
	});

	it("true when the user just clicked the Add Condition pill", () => {
		// Brand-new condition path: the editor mounts blank and takes
		// focus so typing flows immediately.
		expect(
			shouldShowConditionEditor({
				enabled: true,
				hasCondition: false,
				addingCondition: true,
				shouldOpenCondition: false,
			}),
		).toBe(true);
	});

	it("true when undo/redo restored focus to required_condition", () => {
		// Focus-hint path: the editor opens to receive the restored
		// caret regardless of whether the user clicked the pill in this
		// session.
		expect(
			shouldShowConditionEditor({
				enabled: true,
				hasCondition: false,
				addingCondition: false,
				shouldOpenCondition: true,
			}),
		).toBe(true);
	});
});
