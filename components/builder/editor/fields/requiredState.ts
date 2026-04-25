/**
 * requiredState — pure model for the `required` field's tri-state value.
 *
 * The `required` value encodes three lifecycle positions in one string,
 * sourced directly from CommCare's XForm contract:
 *
 *   - `undefined`   → not required (toggle off)
 *   - `"true()"`    → always required (toggle on, no condition)
 *   - any other XPath → conditionally required (toggle on + condition)
 *
 * Both halves of the editor's logic — what UI state to derive from a
 * value, and what value to write for each user transition — live here as
 * pure functions so they can be exercised at the function level. The
 * RequiredEditor component composes these helpers and renders the
 * resulting UI; it carries no extra branching of its own.
 *
 * Keeping the sentinel string in one module also prevents drift: the
 * editor, the schema, and any future caller all agree on what
 * `ALWAYS_REQUIRED` means.
 */

/** CommCare sentinel: "required with no XPath condition" — i.e. always required. */
export const ALWAYS_REQUIRED = "true()";

/** Derived UI state describing what the editor should render for a given
 *  raw `required` value. */
export interface RequiredState {
	/** True when the toggle should render in the on position. */
	enabled: boolean;
	/** True when the value is a non-sentinel XPath — i.e. a real condition,
	 *  not the always-required default. */
	hasCondition: boolean;
	/** The XPath expression when conditional; empty string otherwise. */
	conditionValue: string;
}

/** Map a raw `required` value to its derived UI state. Pure. */
export function deriveRequiredState(value: string | undefined): RequiredState {
	const enabled = !!value;
	const hasCondition = enabled && value !== ALWAYS_REQUIRED;
	return {
		enabled,
		hasCondition,
		// `value` is `string` here because `enabled && hasCondition` both
		// imply truthy; the cast keeps TS happy without an exclamation.
		conditionValue: hasCondition ? (value as string) : "",
	};
}

/** Discriminated union of every transition the user can drive. */
export type RequiredTransition =
	| { type: "toggle-on" }
	| { type: "toggle-off" }
	| { type: "save-condition"; next: string }
	| { type: "remove-condition" };

/**
 * Compute the next raw `required` value for a given transition. Pure.
 *
 * Notable rules:
 *   - `save-condition` with an empty string falls back to the
 *     always-required sentinel, not undefined — the user committed
 *     "required with no condition" rather than "not required."
 *   - `remove-condition` does NOT clear the toggle; it returns to
 *     always-required so the field stays required after the condition
 *     is removed.
 */
export function nextRequiredValue(
	transition: RequiredTransition,
): string | undefined {
	switch (transition.type) {
		case "toggle-on":
			return ALWAYS_REQUIRED;
		case "toggle-off":
			return undefined;
		case "save-condition":
			// Empty commit → fall back to the sentinel so the toggle stays on.
			return transition.next || ALWAYS_REQUIRED;
		case "remove-condition":
			return ALWAYS_REQUIRED;
	}
}

/**
 * Should the nested XPath editor mount? Pure.
 *
 * The editor renders when the field is required AND any one of:
 *   - there's already a condition value to edit,
 *   - the user just clicked "Add Condition" (`addingCondition`),
 *   - undo/redo restored focus to `required_condition`.
 *
 * Otherwise the Add Condition pill takes its place (or nothing renders
 * if the toggle is off).
 */
export function shouldShowConditionEditor(args: {
	enabled: boolean;
	hasCondition: boolean;
	addingCondition: boolean;
	shouldOpenCondition: boolean;
}): boolean {
	return (
		args.enabled &&
		(args.hasCondition || args.addingCondition || args.shouldOpenCondition)
	);
}
