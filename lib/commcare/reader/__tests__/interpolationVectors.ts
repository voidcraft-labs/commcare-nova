/**
 * Texts CommCare HQ's interpolation (`corehq/apps/app_manager/xpath.py`)
 * reads in a way only its exact procedure gives, each with the answer that
 * procedure gives at the pin, worked from its source. The proof lane runs
 * HQ's own `interpolate_xpath` and `dot_interpolate` over the same vectors
 * (`proof/native/test_hq_interpolation.py`, fed by
 * `proof/native/producers/emit-expression-evidence.ts`) and holds the port's
 * answer to HQ's.
 */
import type { HqInterpolated, HqInterpolationSlot } from "../hqInterpolation";

const FORM_CASE =
	"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]";
const USERCASE =
	"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]";

export interface InterpolationVector {
	readonly name: string;
	readonly text: string;
	readonly slot: HqInterpolationSlot;
	readonly expected: HqInterpolated;
}

export interface DotVector {
	readonly name: string;
	readonly text: string;
	readonly replacement: string;
	readonly expected: string;
}

export const INTERPOLATION_VECTORS: readonly InterpolationVector[] = [
	{
		name: "a literal holding #case is replaced inside the quotes",
		text: "p = '#case'",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: true, text: "p = 'current()'" },
	},
	{
		name: "#session/ inside a string is replaced",
		text: "concat('#session/x', '')",
		slot: { interpolateDots: true },
		expected: {
			ok: true,
			text: "concat('instance('commcaresession')/session/x', '')",
		},
	},
	{
		name: "#user names the worker's own case",
		text: "#user/role = 'lead'",
		slot: { interpolateDots: true },
		expected: { ok: true, text: `${USERCASE}/role = 'lead'` },
	},
	{
		name: "a decimal number keeps its dot",
		text: "p > 1.5",
		slot: { interpolateDots: true },
		expected: { ok: true, text: "p > 1.5" },
	},
	{
		name: "a number with no whole part keeps its dot",
		text: "p > .5",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: true, text: "p > .5" },
	},
	{
		name: "a number with no fraction keeps its dot",
		text: "p > 5.",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: true, text: "p > 5." },
	},
	{
		name: "a dot beside an Arabic-Indic digit is a decimal point",
		text: "p = ٣.x",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: true, text: "p = ٣.x" },
	},
	{
		name: "a bare dot is the case",
		text: ". = 'x'",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: true, text: "current() = 'x'" },
	},
	{
		name: "each dot of .. is replaced, its neighbors read raw",
		text: "../p",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: true, text: "current()current()/p" },
	},
	{
		name: "#case is a substring, wherever it occurs",
		text: "#cases/p = 1",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: true, text: "current()s/p = 1" },
	},
	{
		name: "#parent reads the case its parent index names",
		text: "#parent/p = 1",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: {
			ok: true,
			text: "instance('casedb')/casedb/case[@case_id=current()/index/parent]/p = 1",
		},
	},
	{
		name: "#case in a form's display condition is the case chosen last",
		text: "#case/p = 'x'",
		slot: { caseXPath: FORM_CASE, interpolateDots: true },
		expected: { ok: true, text: `${FORM_CASE}/p = 'x'` },
	},
	{
		name: "a dot inside a string is no case reference",
		text: "p = 'a.b'",
		slot: { interpolateDots: true },
		expected: { ok: true, text: "p = 'a.b'" },
	},
	{
		name: "a bare dot with no case is refused",
		text: ". = 'x'",
		slot: { interpolateDots: true },
		expected: { ok: false, reason: "case-reference" },
	},
	{
		name: "a bare dot is read where dots are not interpolated",
		text: ". = 'x'",
		slot: { interpolateDots: false },
		expected: { ok: true, text: ". = 'x'" },
	},
	{
		name: "#case with no case is refused",
		text: "#case/p = 1",
		slot: { interpolateDots: false },
		expected: { ok: false, reason: "case-reference" },
	},
	{
		name: "#parent with no case is refused",
		text: "#parent/p = 1",
		slot: { interpolateDots: true },
		expected: { ok: false, reason: "case-reference" },
	},
	{
		name: "#host with no case is refused",
		text: "#host/p = 1",
		slot: { interpolateDots: true },
		expected: { ok: false, reason: "case-reference" },
	},
	{
		name: "$fixture_value is refused",
		text: "p = $fixture_value",
		slot: { caseXPath: "current()", interpolateDots: true },
		expected: { ok: false, reason: "fixture-value" },
	},
];

export const DOT_VECTORS: readonly DotVector[] = [
	{
		name: "a backslash copies the quote after it",
		text: "concat('a\\'.', .)",
		replacement: "current()",
		expected: "concat('a\\'.', current())",
	},
	{
		name: "an astral digit before a dot is one code point",
		text: "\u{1D7D8}.",
		replacement: "X",
		expected: "\u{1D7D8}.",
	},
	{
		name: "an astral non-digit before a dot is one code point",
		text: "\u{1F600}.",
		replacement: "X",
		expected: "\u{1F600}X",
	},
	{
		name: "a double-quoted string keeps its dots",
		text: `"a.b" = .`,
		replacement: "X",
		expected: `"a.b" = X`,
	},
	{
		name: "a single quote inside a double-quoted string opens nothing",
		text: `"it's" = .`,
		replacement: "X",
		expected: `"it's" = X`,
	},
	{
		name: "a trailing backslash is copied alone",
		text: ". \\",
		replacement: "X",
		expected: "X \\",
	},
];
