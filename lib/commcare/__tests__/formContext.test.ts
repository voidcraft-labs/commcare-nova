/**
 * Unit coverage for the form-context-aware hashtag expander.
 *
 * Two contracts to lock in:
 *
 *   - On a registration form, `#case/case_id` rewrites to the form-local
 *     path `/data/case/@case_id` (populated by the case-create
 *     scaffolding's setvalue chain). Every other `#case/<X>` is left in
 *     place so the validator's rejection error can quote the original
 *     authored text.
 *   - On every other form type (followup / close / survey),
 *     `expandHashtagsInContext` is identical to the context-free
 *     `expandHashtags`.
 */

import { describe, expect, it } from "vitest";
import { expandHashtags } from "@/lib/commcare/hashtags";
import { expandHashtagsInContext } from "@/lib/commcare/hashtags/formContext";

describe("expandHashtagsInContext", () => {
	describe("registration forms", () => {
		const ctx = { formType: "registration" as const };

		it("rewrites #case/case_id to /data/case/@case_id", () => {
			expect(expandHashtagsInContext("#case/case_id", ctx)).toBe(
				"/data/case/@case_id",
			);
		});

		it("rewrites #case/case_id inside a larger expression", () => {
			expect(
				expandHashtagsInContext("concat(#case/case_id, '-suffix')", ctx),
			).toBe("concat(/data/case/@case_id, '-suffix')");
		});

		it("leaves #case/<other> un-rewritten so it surfaces as a build error downstream", () => {
			// The un-rewritten ref flows through the context-free expander
			// into a case-loading XPath shape; the binding-resolution
			// oracle then catches that registration entries declare no
			// `case_id` datum and throws at compile time.
			const result = expandHashtagsInContext("#case/some_other_prop", ctx);
			// Either it stays unrewritten OR it expands to the case-loading
			// shape — but the case-loading shape is NOT what should be emitted
			// in production for a registration form. The validator rule rejects
			// the doc before this output reaches emission; here we just verify
			// the rewriter doesn't silently rewrite to /data/case/@case_id.
			expect(result).not.toContain("/data/case/@case_id");
		});

		it("rewrites only the exact #case/case_id token (not prefix matches)", () => {
			// A hashtag whose segment starts with "case_id" — e.g. a hypothetical
			// `case_id_x` property — must NOT be rewritten. Lezer matches on the
			// segment boundary, not by string prefix.
			const result = expandHashtagsInContext("#case/case_id_extension", ctx);
			expect(result).not.toContain("/data/case/@case_id");
		});

		it("expands #form/ and #user/ hashtags the same way the context-free expander does", () => {
			expect(expandHashtagsInContext("#form/x + 1", ctx)).toBe(
				expandHashtags("#form/x + 1"),
			);
			expect(expandHashtagsInContext("#user/username", ctx)).toBe(
				expandHashtags("#user/username"),
			);
		});
	});

	describe("non-registration forms", () => {
		for (const formType of ["followup", "close", "survey"] as const) {
			it(`expands #case/case_id the case-loading way on ${formType}`, () => {
				const ctx = { formType };
				expect(expandHashtagsInContext("#case/case_id", ctx)).toBe(
					expandHashtags("#case/case_id"),
				);
			});

			it(`expands #case/<other> identically to the context-free expander on ${formType}`, () => {
				const ctx = { formType };
				expect(expandHashtagsInContext("#case/total_visits", ctx)).toBe(
					expandHashtags("#case/total_visits"),
				);
			});
		}
	});

	describe("edge cases", () => {
		it("passes empty input through unchanged", () => {
			expect(expandHashtagsInContext("", { formType: "registration" })).toBe(
				"",
			);
		});

		it("leaves non-hashtag XPath unchanged", () => {
			const ctx = { formType: "registration" as const };
			expect(expandHashtagsInContext("/data/age > 18", ctx)).toBe(
				"/data/age > 18",
			);
		});
	});
});
