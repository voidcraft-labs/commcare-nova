import { describe, expect, it } from "vitest";
import {
	type Literal,
	literal,
	qualifiedLiteral,
} from "@/lib/domain/predicate";
import { rebuildLiteralPreservingDataType } from "../literalRebuild";

describe("literal value rebuilding", () => {
	it.each([
		["date", "2024-01-01", "2025-06-15"],
		["datetime", "2024-01-01T12:00:00Z", "2025-06-15T15:30:00Z"],
		["time", "12:00:00", "15:30:00"],
		["single_select", "active", "inactive"],
		["multi_select", "a b", "b c"],
		["geopoint", "0 0", "1 2"],
		["text", "001", "002"],
		["int", 1, 2],
		["decimal", 1.5, 2.5],
	] as const)(
		"preserves the %s qualifier without mutating the source",
		(type, before, after) => {
			const source = Object.freeze(qualifiedLiteral(before, type));
			expect(rebuildLiteralPreservingDataType(source, after)).toStrictEqual({
				kind: "literal",
				value: after,
				data_type: type,
			});
			expect(source.value).toBe(before);
		},
	);
	it.each([null, true, false, 0, "001"])(
		"leaves an unqualified value unqualified: %j",
		(next) => {
			const source: Literal = Object.freeze(literal("before"));
			expect(rebuildLiteralPreservingDataType(source, next)).toStrictEqual({
				kind: "literal",
				value: next,
			});
			expect(source).toStrictEqual({ kind: "literal", value: "before" });
		},
	);
});
