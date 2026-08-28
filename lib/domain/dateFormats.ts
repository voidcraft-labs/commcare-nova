// lib/domain/dateFormats.ts
//
// Semantic date-style presets for the `format-date` ValueExpression. Case-list
// columns store a concrete CommCare pattern; their preset picker is only an
// authoring projection and no live runtime or emitter resolves stored column
// values through this table.

import type { FormatDatePreset } from "./predicate/types";

export interface DateFormatPresetDefinition {
	readonly label: string;
	readonly commCarePattern: string;
	readonly example: string;
}

/**
 * Nova's three date styles expressed in the one authored vocabulary:
 * JavaRosa's `DateUtils.format` escapes. Preview implements that vocabulary;
 * Postgres parses and lowers it token by token.
 */
export const DATE_FORMAT_PRESET_DEFINITIONS: Readonly<
	Record<FormatDatePreset, DateFormatPresetDefinition>
> = {
	short: {
		label: "Short",
		commCarePattern: "%m/%d/%Y",
		example: "07/17/2026",
	},
	long: {
		label: "Long",
		commCarePattern: "%B %e, %Y",
		example: "July 17, 2026",
	},
	iso: {
		label: "Year-month-day",
		commCarePattern: "%Y-%m-%d",
		example: "2026-07-17",
	},
};

/* The definition table is already the runtime source of truth. Deriving its
 * keys here keeps Preview formatting from importing predicate schemas merely
 * to recognize these three ids. */
const DATE_FORMAT_PRESET_IDS: ReadonlySet<string> = new Set(
	Object.keys(DATE_FORMAT_PRESET_DEFINITIONS),
);

export function isDateFormatPreset(value: string): value is FormatDatePreset {
	return DATE_FORMAT_PRESET_IDS.has(value);
}

/** Resolve a semantic preset id to the pattern JavaRosa actually accepts. */
export function resolveCommCareDatePattern(pattern: string): string {
	return isDateFormatPreset(pattern)
		? DATE_FORMAT_PRESET_DEFINITIONS[pattern].commCarePattern
		: pattern;
}
