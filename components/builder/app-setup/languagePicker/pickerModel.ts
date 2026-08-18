// components/builder/app-setup/languagePicker/pickerModel.ts
//
// The pure state model behind the language picker dialogs. The registry's
// search module owns ranking and diacritic folding; this layer adds what the
// dialogs need on top of it: verdict notices for code-shaped queries, the
// language → writing system → regional conventions cascade, duplicate
// detection against the app's existing languages, and the row bound with its
// "keep typing" count line. ISO codes are match keys and record identities
// only — no function here returns a code as display text.

import {
	type AppLanguageIdentity,
	type LanguageDirection,
	type LanguageTag,
	languageTag,
} from "@/lib/domain";
import {
	languageCodeVerdict,
	languageDirection,
	type MacrolanguageMember,
	macrolanguageName,
	regionChoices,
	scriptChoices,
} from "@/lib/domain/languageRegistry";
import type { LanguageRegistrySearch } from "@/lib/domain/languageRegistry/load";
import type { LanguageSearchRow } from "@/lib/domain/languageRegistry/search";

/** The most rows a non-empty query renders; the rest become a count line. */
export const LANGUAGE_ROW_LIMIT = 50;

export interface LanguagePickerRow {
	/** ISO 639:2023 Set 3 identifier — the match key, never rendered. */
	readonly code: string;
	/** The worker-facing label: the endonym where CLDR knows one. */
	readonly primaryLabel: string;
	/** The English name, present when it differs from the primary label. */
	readonly secondaryLabel?: string;
}

/**
 * A code-free explanation shown above the row list when the query is a token
 * the registry recognizes but cannot admit as-is: a macrolanguage, a
 * two-letter shorthand, or a non-living code. Its rows are ordinary
 * selectable languages.
 */
export interface LanguagePickerNotice {
	readonly message: string;
	readonly rows: readonly LanguagePickerRow[];
}

export interface LanguageSearchView {
	readonly notice?: LanguagePickerNotice;
	readonly rows: readonly LanguagePickerRow[];
	/** Matches withheld beyond LANGUAGE_ROW_LIMIT; 0 when every match shows. */
	readonly hiddenMatchCount: number;
}

function toPickerRow(row: LanguageSearchRow): LanguagePickerRow {
	const primaryLabel = row.endonym ?? row.englishName;
	return {
		code: row.code,
		primaryLabel,
		...(primaryLabel !== row.englishName && {
			secondaryLabel: row.englishName,
		}),
	};
}

function memberRow(member: MacrolanguageMember): LanguagePickerRow {
	const primaryLabel = member.endonym ?? member.englishName;
	return {
		code: member.code,
		primaryLabel,
		...(primaryLabel !== member.englishName && {
			secondaryLabel: member.englishName,
		}),
	};
}

/** The picker row for one known Set 3 code, resolved through the registry. */
export function pickerRowForCode(
	data: LanguageRegistrySearch,
	code: string,
): LanguagePickerRow {
	const englishName = data.englishLanguageName(code) ?? code;
	const primaryLabel =
		data.resolvedLanguageDisplayLabel({ language: code }) ?? englishName;
	return {
		code,
		primaryLabel,
		...(primaryLabel !== englishName && { secondaryLabel: englishName }),
	};
}

function codeQueryNotice(
	data: LanguageRegistrySearch,
	token: string,
): LanguagePickerNotice | undefined {
	if (!/^[a-z]{2,3}$/.test(token)) return undefined;
	const verdict = languageCodeVerdict(token);
	switch (verdict.kind) {
		case "individual-living":
		case "unknown":
			return undefined;
		case "set1-alias": {
			if (verdict.resolved === undefined) return undefined;
			const name = data.englishLanguageName(verdict.resolved);
			return {
				message:
					name === undefined
						? "That's a language's two-letter shorthand. Choose the language itself:"
						: `That's the two-letter shorthand for ${name}. Choose the language itself:`,
				rows: [pickerRowForCode(data, verdict.resolved)],
			};
		}
		case "macrolanguage": {
			const name = macrolanguageName(verdict.resolved ?? token);
			return {
				message:
					name === undefined
						? "That names a group of languages, not one language. Choose the one workers speak:"
						: `${name} is a group of languages, not one language. Choose the one workers speak:`,
				rows: (verdict.members ?? []).map(memberRow),
			};
		}
		case "non-living":
			return {
				message: `That names ${verdict.typeLabel ?? "something that is not a living language"}, and app languages are living languages workers speak today`,
				rows: [],
			};
	}
}

/**
 * The row list for one query. An empty query is the full alphabetical
 * catalog with no bound; a non-empty query delegates ranking to the
 * registry's search, caps at LANGUAGE_ROW_LIMIT, and surfaces a verdict
 * notice when the query is a recognizable code the registry rejects.
 */
export function searchLanguageRows(
	data: LanguageRegistrySearch,
	query: string,
): LanguageSearchView {
	const trimmed = query.trim();
	if (trimmed === "") {
		return {
			rows: data.allLanguageSearchRows().map(toPickerRow),
			hiddenMatchCount: 0,
		};
	}
	const result = data.searchLanguages(trimmed, LANGUAGE_ROW_LIMIT);
	const notice = codeQueryNotice(data, trimmed.toLowerCase());
	const noticeCodes = new Set((notice?.rows ?? []).map((row) => row.code));
	const rows = result.rows
		.filter((row) => !noticeCodes.has(row.code))
		.map(toPickerRow);
	const hiddenMatchCount = Math.max(
		0,
		result.totalMatches - result.rows.length,
	);
	return notice === undefined
		? { rows, hiddenMatchCount }
		: { notice, rows, hiddenMatchCount };
}

/** The "keep typing" line under a bounded row list; undefined at 0. */
export function hiddenMatchesLine(count: number): string | undefined {
	if (count <= 0) return undefined;
	return count === 1
		? "1 more language matches. Keep typing to narrow the list"
		: `${count} more languages match. Keep typing to narrow the list`;
}

/**
 * The picker's in-progress selection. Region undefined means the language's
 * general conventions — region is always skippable.
 */
export interface LanguagePickerChoice {
	readonly language?: string;
	readonly script?: string;
	readonly region?: string;
}

export const EMPTY_LANGUAGE_CHOICE: LanguagePickerChoice = {};

/** Choosing a different language resets the writing system and region. */
export function chooseLanguage(
	choice: LanguagePickerChoice,
	language: string,
): LanguagePickerChoice {
	return choice.language === language ? choice : { language };
}

/** Choosing a different writing system resets the region. */
export function chooseScript(
	choice: LanguagePickerChoice,
	script: string,
): LanguagePickerChoice {
	if (choice.language === undefined) return choice;
	return choice.script === script
		? choice
		: { language: choice.language, script };
}

export function chooseRegion(
	choice: LanguagePickerChoice,
	region: string | undefined,
): LanguagePickerChoice {
	if (choice.language === undefined) return choice;
	return {
		language: choice.language,
		...(choice.script !== undefined && { script: choice.script }),
		...(region !== undefined && { region }),
	};
}

export interface WritingSystemOption {
	readonly script: string;
	readonly label: string;
	/** Present when every identity under this writing system already exists. */
	readonly disabledReason?: string;
}

export function writingSystemOptions(
	language: string,
	existingTags: readonly LanguageTag[],
): readonly WritingSystemOption[] {
	const existing = new Set(existingTags);
	return scriptChoices(language).map((choice) => {
		const identities: AppLanguageIdentity[] = [
			{ language, script: choice.script },
			...regionChoices(language, choice.script).map((region) => ({
				language,
				script: choice.script,
				region: region.region,
			})),
		];
		const exhausted = identities.every((identity) =>
			existing.has(languageTag(identity)),
		);
		return {
			script: choice.script,
			label: choice.label,
			...(exhausted && { disabledReason: "Already in this app" }),
		};
	});
}

export interface RegionalConventionOption {
	/** Undefined is the general-conventions choice, always listed first. */
	readonly region?: string;
	readonly label: string;
	readonly description?: string;
}

export function regionalConventionOptions(
	data: LanguageRegistrySearch,
	language: string,
	script: string | undefined,
): readonly RegionalConventionOption[] {
	const choices = regionChoices(language, script);
	if (choices.length === 0) return [];
	const baseName = data.englishLanguageName(language);
	return [
		{
			label: baseName === undefined ? "General" : `General ${baseName}`,
			description: "Not tailored to one country's conventions",
		},
		...choices.map((choice) => ({
			region: choice.region,
			label: choice.label,
		})),
	];
}

export interface ResolvedLanguageSelection {
	readonly identity: AppLanguageIdentity;
	readonly tag: LanguageTag;
}

/**
 * The complete identity the current choice names, or undefined while the
 * cascade is unanswered: a language whose writing systems branch resolves
 * nothing until one is chosen. A skipped region resolves to the general
 * conventions, and a stale script or region from an earlier choice is
 * ignored rather than producing an unlawful identity.
 */
export function resolvedLanguageSelection(
	choice: LanguagePickerChoice,
): ResolvedLanguageSelection | undefined {
	const { language } = choice;
	if (language === undefined) return undefined;
	const scripts = scriptChoices(language);
	let script: string | undefined;
	if (scripts.length > 0) {
		if (
			choice.script === undefined ||
			!scripts.some((candidate) => candidate.script === choice.script)
		) {
			return undefined;
		}
		script = choice.script;
	}
	const regions = regionChoices(language, script);
	const region =
		choice.region !== undefined &&
		regions.some((candidate) => candidate.region === choice.region)
			? choice.region
			: undefined;
	const identity: AppLanguageIdentity = {
		language,
		...(script !== undefined && { script }),
		...(region !== undefined && { region }),
	};
	return { identity, tag: languageTag(identity) };
}

/**
 * The inline refusal when the resolved identity is already one of the app's
 * languages. Names the language by its English qualified name, never a tag.
 */
export function duplicateLanguageRefusal(
	data: LanguageRegistrySearch,
	selection: ResolvedLanguageSelection,
	existingTags: readonly LanguageTag[],
): string | undefined {
	if (!existingTags.includes(selection.tag)) return undefined;
	const name =
		data.resolvedLanguageEnglishName(selection.identity) ??
		data.resolvedLanguageDisplayLabel(selection.identity) ??
		"This language";
	return `${name} is already one of this app's languages`;
}

export interface LanguageSelectionPreview {
	readonly label: string;
	readonly direction: LanguageDirection;
	readonly directionWord: "left to right" | "right to left";
}

/** The "Workers see …" line once the cascade resolves. */
export function selectionPreview(
	data: LanguageRegistrySearch,
	identity: AppLanguageIdentity,
): LanguageSelectionPreview | undefined {
	const label = data.resolvedLanguageDisplayLabel(identity);
	if (label === undefined) return undefined;
	const direction = languageDirection(identity);
	return {
		label,
		direction,
		directionWord: direction === "rtl" ? "right to left" : "left to right",
	};
}
