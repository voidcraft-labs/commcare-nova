// lib/domain/commCareDatePattern.ts
//
// JavaRosa date-pattern vocabulary shared by schema validation, Preview, and
// the Postgres compiler. The token set is pinned to
// `commcare-core/.../DateUtils.java::format(DateFields, String, CalendarStrings)`:
// JavaRosa throws on every unknown escape and on a trailing `%`, so Nova does
// the same at construction/compile boundaries instead of letting each runtime
// improvise a different interpretation.

export const COMMCARE_DATE_FORMAT_TOKENS = [
	"%",
	"Y",
	"y",
	"m",
	"n",
	"B",
	"b",
	"d",
	"e",
	"H",
	"h",
	"M",
	"S",
	"3",
	"A",
	"a",
	"w",
	"Z",
] as const;

export type CommCareDateFormatToken =
	(typeof COMMCARE_DATE_FORMAT_TOKENS)[number];

const COMMCARE_DATE_FORMAT_TOKEN_SET: ReadonlySet<string> = new Set(
	COMMCARE_DATE_FORMAT_TOKENS,
);

/**
 * JSON-Schema-compatible validation for the JavaRosa vocabulary. Ordinary
 * characters are literal; every percent sign must introduce a supported
 * escape (including `%%` for a literal percent sign).
 */
export const COMMCARE_DATE_PATTERN_REGEX =
	/^(?:[^%]|%(?:%|Y|y|m|n|B|b|d|e|H|h|M|S|3|A|a|w|Z))*$/;

export const COMMCARE_MONTH_NAMES_LONG = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

export const COMMCARE_MONTH_NAMES_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

export const COMMCARE_DAY_NAMES_LONG = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

export const COMMCARE_DAY_NAMES_SHORT = [
	"Sun",
	"Mon",
	"Tue",
	"Wed",
	"Thu",
	"Fri",
	"Sat",
] as const;

export type CommCareDatePatternSegment =
	| { readonly kind: "literal"; readonly text: string }
	| { readonly kind: "token"; readonly token: CommCareDateFormatToken };

export type CommCareDatePatternParseResult =
	| {
			readonly kind: "parsed";
			readonly segments: readonly CommCareDatePatternSegment[];
	  }
	| {
			readonly kind: "unsupported-pattern";
			readonly index: number;
			readonly escape?: string;
	  };

/** Parse a concrete JavaRosa pattern into safely-separated literal/token runs. */
export function parseCommCareDatePattern(
	pattern: string,
): CommCareDatePatternParseResult {
	const segments: CommCareDatePatternSegment[] = [];
	let literal = "";
	const flushLiteral = () => {
		if (literal === "") return;
		segments.push({ kind: "literal", text: literal });
		literal = "";
	};

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char !== "%") {
			literal += char;
			continue;
		}

		flushLiteral();
		const escapeIndex = index;
		index += 1;
		if (index >= pattern.length) {
			return { kind: "unsupported-pattern", index: escapeIndex };
		}

		const token = pattern[index];
		if (!COMMCARE_DATE_FORMAT_TOKEN_SET.has(token)) {
			return {
				kind: "unsupported-pattern",
				index: escapeIndex,
				escape: `%${token}`,
			};
		}
		segments.push({
			kind: "token",
			token: token as CommCareDateFormatToken,
		});
	}

	flushLiteral();
	return { kind: "parsed", segments };
}

export function isSupportedCommCareDatePattern(pattern: string): boolean {
	return COMMCARE_DATE_PATTERN_REGEX.test(pattern);
}
