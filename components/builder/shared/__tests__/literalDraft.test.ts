import { describe, expect, it } from "vitest";
import { dateLiteral, literal } from "@/lib/domain/predicate";
import { planLiteralDraft } from "../literalDraft";

describe("literal input commit plans", () => {
	it.each(["", "1.5", "1e", "Infinity", "12oops"])(
		"retains invalid integer draft %j without manufacturing zero",
		(draft) => {
			expect(
				planLiteralDraft({ value: literal(7), draft, kind: "int" }),
			).toEqual({ kind: "rejected", reason: "Enter a whole number" });
		},
	);
	it.each(["1e", "Infinity", "12oops", "NaN"])(
		"retains invalid decimal draft %j",
		(draft) => {
			expect(
				planLiteralDraft({ value: literal(7.5), draft, kind: "decimal" }),
			).toEqual({ kind: "rejected", reason: "Enter a number" });
		},
	);
	it("commits a corrected integer or decimal using the actual parser", () => {
		expect(
			planLiteralDraft({ value: literal(7), draft: "-2", kind: "int" }),
		).toEqual({ kind: "commit", value: literal(-2) });
		expect(
			planLiteralDraft({
				value: literal(7.5),
				draft: "12.25",
				kind: "decimal",
			}),
		).toEqual({ kind: "commit", value: literal(12.25) });
	});
	it("distinguishes optional empty values from required empty drafts", () => {
		expect(
			planLiteralDraft({
				value: literal("Alice"),
				draft: "",
				kind: "text",
				nonEmpty: true,
			}),
		).toEqual({ kind: "rejected", reason: "Enter a value" });
		expect(
			planLiteralDraft({ value: literal("Alice"), draft: "", kind: "text" }),
		).toEqual({ kind: "commit", value: literal("") });
		expect(
			planLiteralDraft({ value: literal(7.5), draft: "", kind: "decimal" }),
		).toEqual({ kind: "commit", value: literal(null) });
	});
	it("does not dispatch untouched text and numeric inputs", () => {
		expect(
			planLiteralDraft({
				value: literal("Alice"),
				draft: "Alice",
				kind: "text",
			}),
		).toEqual({ kind: "unchanged" });
		expect(
			planLiteralDraft({ value: literal(7), draft: "7", kind: "int" }),
		).toEqual({ kind: "unchanged" });
		expect(
			planLiteralDraft({ value: literal(null), draft: "", kind: "decimal" }),
		).toEqual({ kind: "unchanged" });
	});
	it("retains imported qualifiers and creates an unqualified first literal", () => {
		const source = dateLiteral("2026-01-01");
		expect(
			planLiteralDraft({ value: source, draft: "2026-02-02", kind: "text" }),
		).toEqual({ kind: "commit", value: dateLiteral("2026-02-02") });
		expect(source).toEqual(dateLiteral("2026-01-01"));
		expect(
			planLiteralDraft({ value: undefined, draft: "first", kind: "text" }),
		).toEqual({ kind: "commit", value: literal("first") });
	});
});
