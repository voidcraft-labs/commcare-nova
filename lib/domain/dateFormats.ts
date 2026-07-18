// lib/domain/dateFormats.ts
//
// Semantic date-style presets shared by every Nova runtime. The stored
// predicate AST may carry the friendly preset ids (`short` / `long` / `iso`),
// while a case-list column may carry either one of those ids (legacy Nova
// documents) or a concrete CommCare pattern. Every consumer resolves through
// this table before entering the shared JavaRosa parser, so Preview, Postgres,
// suite.xml, and HQ JSON cannot assign different meanings to the same preset.

import { FORMAT_DATE_PRESETS, type FormatDatePreset } from "./predicate/types";

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

const DATE_FORMAT_PRESET_IDS: ReadonlySet<string> = new Set(
	FORMAT_DATE_PRESETS,
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
