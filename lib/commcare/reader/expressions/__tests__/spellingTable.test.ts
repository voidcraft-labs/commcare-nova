/**
 * The reader's equivalence table and the vectors Core reads it with
 * (`spellingVectors.ts`) say the same: two spellings Core answers alike
 * compare as one tree, and a negative control's two compare apart. The
 * failure this holds: a row of `syntaxCompare.ts` wider or narrower than the
 * vectors the lane runs through Core.
 */
import { describe, expect, it } from "vitest";
import { sameXPathText } from "../../syntaxCompare";
import { SPELLING_VECTORS } from "./spellingVectors";

describe("the equivalence table holds the spellings Core reads alike", () => {
	for (const vector of SPELLING_VECTORS)
		it(`${vector.row}: ${vector.name}`, () => {
			const record = sameXPathText(vector.a, vector.b, { ruleSet: "record" });
			const form = sameXPathText(vector.a, vector.b, { ruleSet: "form" });
			if (vector.apart !== undefined) {
				expect(record).toBe(false);
				expect(form).toBe(false);
				return;
			}
			expect(record).toBe(true);
			// `cond` is a call form logic holds as written (S1 is record-only).
			expect(form).toBe(vector.row !== "S1");
		});
});
