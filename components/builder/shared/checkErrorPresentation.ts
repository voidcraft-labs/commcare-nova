// components/builder/shared/checkErrorPresentation.ts
//
// Builder-language presentation for predicate / expression checker
// findings. The checker keeps precise implementation detail in
// `CheckError.message` for agents, logs, and developer diagnostics. A
// person editing a condition instead sees one concise next action,
// selected from the stable error code and the slot path.
//
// Never inspect or pattern-match `message` here. Checker prose is free
// to improve without changing the editor's UX contract.

import type {
	CheckError,
	CheckErrorCode,
	CheckPath,
} from "@/lib/domain/predicate";

type DiagnosticPresenter = (path: CheckPath) => string;

/** Return the closest named slot, skipping array indexes. */
function lastNamedSlot(path: CheckPath): string | undefined {
	for (let index = path.length - 1; index >= 0; index--) {
		const segment = path[index];
		if (typeof segment === "string") return segment;
	}
	return undefined;
}

/**
 * A path-aware fallback for an untyped boundary or a future checker
 * category. Even the fallback names the action when the path identifies
 * an editable property, value, Search field, or relationship slot.
 */
function nextActionForPath(path: CheckPath): string {
	switch (lastNamedSlot(path)) {
		case "property":
			return "Choose available case information";
		case "input":
			return "Choose an available Search field";
		case "via":
			return "Choose an available connection to another case";
		case "left":
		case "right":
		case "value":
		case "values":
		case "lower":
		case "upper":
		case "center":
		case "date":
		case "quantity":
		case "on":
		case "when":
		case "then":
		case "else":
		case "fallback":
			return "Choose a value that works here";
		case "clause":
		case "where":
		case "cond":
			return "Review this condition and update the highlighted choice";
		default:
			return "Review this setting and choose an available option";
	}
}

const PRESENT_BY_CODE: Record<CheckErrorCode, DiagnosticPresenter> = {
	"unknown-property": () => "Choose available case information",
	"unknown-search-input": () => "Choose an available Search field",
	"unknown-form-field": () => "Choose an available form answer",
	"unknown-operation-id": () => "Choose an earlier case operation",
	"operation-context-value": () =>
		"Choose a value available in this part of the app",
	"unknown-case-type": () =>
		"Choose information from an available kind of case",
	"unknown-lookup-table": () => "Choose an available lookup table",
	"unknown-lookup-column": () => "Choose an available lookup table column",
	"lookup-table-scope": () => "Choose a column from the lookup table used here",
	"property-scope": () => "Choose information from the related case shown here",
	"incompatible-values": () =>
		"Choose values that use compatible kinds of information",
	"ordered-values": () => "Use numbers, dates, or times for this comparison",
	"location-value": (path) =>
		lastNamedSlot(path) === "property"
			? "Choose location information"
			: "Choose a location or enter coordinates",
	"match-value": (path) =>
		lastNamedSlot(path) === "property"
			? "Choose other case information or a different matching method"
			: "Choose another value or matching method",
	"match-value-empty": () => "Enter a value to match",
	"multi-select-property": () =>
		"Choose multiple-choice information that allows more than one answer",
	"runtime-value": () =>
		"Choose case information, a search answer, or another value that can change",
	"range-order": () => "Set the starting value before the ending value",
	"relation-origin": () => "Choose the kind of case this condition starts from",
	"relation-self": () => "Choose a related case instead of the current case",
	"relation-path": () => "Choose an available connection to another case",
	"relation-destination": () =>
		"Choose a connection that leads to an available kind of case",
	"relation-ambiguous": () => "Choose which kind of related case to use",
	"date-value": () => "Choose a date or date and time value",
	"number-value": () => "Choose a number",
	"text-or-date-value": () => "Choose text, a date, or a date and time value",
	"text-or-number-value": () => "Choose text or a number",
	"branch-values": () =>
		"Make every possible result use the same kind of information",
	"text-value": () => "Choose text",
	"expected-value": () => "Choose a value that fits this setting",
	"constraint-value": () => "Choose a value that fits this setting",
};

/**
 * Present one checker finding in the builder's voice. The indexed access
 * is deliberately runtime-safe because persisted or untyped input can
 * cross a version boundary with a category this build doesn't know yet.
 */
export function presentCheckErrorForEditor(error: CheckError): string {
	const presenter = (
		PRESENT_BY_CODE as Partial<Record<string, DiagnosticPresenter>>
	)[error.code];
	return presenter?.(error.path) ?? nextActionForPath(error.path);
}
