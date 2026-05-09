// components/builder/case-list-config/__tests__/literalRebuild.test.ts
//
// Coverage for the qualifier-preserving literal rebuild helpers.
// Pins the regression contract: every literal rebuild path the
// editor uses MUST carry the source's `data_type` qualifier
// through. The naïve rebuild (`literal(nextValue)`) drops the
// qualifier silently.

import { describe, expect, it } from "vitest";
import {
	dateLiteral,
	datetimeLiteral,
	literal,
	qualifiedLiteral,
	timeLiteral,
} from "@/lib/domain/predicate";
import {
	literalToInputText,
	parseInputTextToLiteral,
	rebuildLiteralPreservingDataType,
} from "../literalRebuild";

describe("rebuildLiteralPreservingDataType", () => {
	it("preserves a `date` qualifier across a value change", () => {
		const source = dateLiteral("2024-01-01");
		const next = rebuildLiteralPreservingDataType(source, "2025-06-15");
		expect(next.data_type).toBe("date");
		expect(next.value).toBe("2025-06-15");
	});

	it("preserves a `datetime` qualifier across a value change", () => {
		const source = datetimeLiteral("2024-01-01T12:00:00Z");
		const next = rebuildLiteralPreservingDataType(
			source,
			"2025-06-15T15:30:00Z",
		);
		expect(next.data_type).toBe("datetime");
		expect(next.value).toBe("2025-06-15T15:30:00Z");
	});

	it("preserves a `time` qualifier across a value change", () => {
		const source = timeLiteral("12:00:00");
		const next = rebuildLiteralPreservingDataType(source, "15:30:00");
		expect(next.data_type).toBe("time");
		expect(next.value).toBe("15:30:00");
	});

	it("preserves non-temporal qualifiers (single_select, multi_select, int, etc.)", () => {
		// The schema admits a `data_type` qualifier on every
		// `CasePropertyDataType`. The rebuild routes through
		// `qualifiedLiteral` for any qualifier — temporal or not —
		// so a non-temporal qualifier on the source carries through
		// the rebuild verbatim.
		const source = qualifiedLiteral("active", "single_select");
		const next = rebuildLiteralPreservingDataType(source, "inactive");
		expect(next.data_type).toBe("single_select");
		expect(next.value).toBe("inactive");
	});

	it("emits a bare literal when the source has no qualifier", () => {
		const source = literal("text");
		const next = rebuildLiteralPreservingDataType(source, "other");
		expect(next.data_type).toBeUndefined();
		expect(next.value).toBe("other");
	});

	it("accepts non-string values at a temporal qualifier (parse-time validation lives at the wire boundary)", () => {
		// `qualifiedLiteral` accepts the full schema union
		// (`string | number | boolean | null`) for the value, so the
		// rebuilt literal carries whatever the caller passed. The
		// schema layer + wire emitter reject malformed wire forms at
		// emit time, matching `dateLiteral("not-a-date")`'s
		// parse-time-trust contract.
		const source = dateLiteral("2024-01-01");
		const next = rebuildLiteralPreservingDataType(source, 2025);
		expect(next.data_type).toBe("date");
		expect(next.value).toBe(2025);
	});
});

describe("literalToInputText / parseInputTextToLiteral — symmetric round-trip", () => {
	it("encodes null as empty string and decodes back to null", () => {
		const source = literal(null);
		expect(literalToInputText(source)).toBe("");
		const next = parseInputTextToLiteral("", source);
		expect(next.value).toBe(null);
	});

	it("encodes booleans as 'true' / 'false' and decodes them back", () => {
		expect(literalToInputText(literal(true))).toBe("true");
		expect(literalToInputText(literal(false))).toBe("false");
		const fromTrue = parseInputTextToLiteral("true", literal(false));
		expect(fromTrue.value).toBe(true);
		const fromFalse = parseInputTextToLiteral("false", literal(true));
		expect(fromFalse.value).toBe(false);
	});

	it("encodes numbers as their toString and decodes pure numerics back", () => {
		expect(literalToInputText(literal(42))).toBe("42");
		expect(literalToInputText(literal(3.14))).toBe("3.14");
		const fromInt = parseInputTextToLiteral("100", literal(0));
		expect(fromInt.value).toBe(100);
		const fromFloat = parseInputTextToLiteral("2.5", literal(0));
		expect(fromFloat.value).toBe(2.5);
	});

	it("decodes whitespace-padded numerics as strings (not numbers)", () => {
		// `Number(" 42 ")` returns 42, but the source's intent was
		// almost certainly a string with surrounding whitespace.
		// The trim-equality guard rejects these.
		const next = parseInputTextToLiteral(" 42 ", literal(""));
		expect(next.value).toBe(" 42 ");
	});

	it("preserves a `date` qualifier across decode regardless of input shape", () => {
		// `Number("2024")` parses as 2024. Without qualifier
		// preservation, a typed-date `when` literal would silently
		// turn into a number literal on every blur. The qualifier-
		// driven decode routes through `dateLiteral(text)` always.
		const source = dateLiteral("2024-01-01");
		const next = parseInputTextToLiteral("2024", source);
		expect(next.data_type).toBe("date");
		expect(next.value).toBe("2024");
	});

	it("preserves a `datetime` qualifier across decode", () => {
		const source = datetimeLiteral("2024-01-01T12:00:00Z");
		const next = parseInputTextToLiteral("2025-06-15T15:30:00Z", source);
		expect(next.data_type).toBe("datetime");
		expect(next.value).toBe("2025-06-15T15:30:00Z");
	});

	it("preserves a `time` qualifier across decode", () => {
		const source = timeLiteral("12:00:00");
		const next = parseInputTextToLiteral("15:30:00", source);
		expect(next.data_type).toBe("time");
		expect(next.value).toBe("15:30:00");
	});

	it("empty-text asymmetry — temporal qualifiers route empty input to a typed empty-string literal", () => {
		// The qualifier-driven decode path runs first: a date / datetime
		// / time source produces a typed-empty-string literal when the
		// input is empty, NOT a `literal(null)`. The unqualified path's
		// "empty input → null" heuristic never applies to a temporal
		// source because the qualifier wins. Locks the documented
		// asymmetry against silent regression.
		const dateSource = dateLiteral("2024-01-01");
		const dateEmpty = parseInputTextToLiteral("", dateSource);
		expect(dateEmpty.kind).toBe("literal");
		expect(dateEmpty.value).toBe("");
		expect(dateEmpty.data_type).toBe("date");

		const datetimeEmpty = parseInputTextToLiteral(
			"",
			datetimeLiteral("2024-01-01T00:00:00"),
		);
		expect(datetimeEmpty.value).toBe("");
		expect(datetimeEmpty.data_type).toBe("datetime");

		const timeEmpty = parseInputTextToLiteral("", timeLiteral("12:00:00"));
		expect(timeEmpty.value).toBe("");
		expect(timeEmpty.data_type).toBe("time");

		// Symmetric: an unqualified text source DOES route empty input
		// to `literal(null)`. The two halves of the asymmetry are
		// pinned together so a regression in either branch surfaces.
		const textEmpty = parseInputTextToLiteral("", literal(""));
		expect(textEmpty.value).toBeNull();
		expect(textEmpty.data_type).toBeUndefined();
	});
});
