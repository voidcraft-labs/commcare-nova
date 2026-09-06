import * as fc from "fast-check";
import { expect, it } from "vitest";
import { assertGenerated, checkCompilerEvidence } from "./compilerEvidence";
import {
	blueprintDocArbitrary,
	hasFormItextMedia,
	hasSectionedForm,
} from "./xformDocArbitrary";

// Finite seeded corpus, with shrinking enabled. These checks complement the
// independent wire examples; they do not prove acceptance by a native runtime.
it("compiles 500 field-tree samples with valid schema, bindings, and archived resources", {
	timeout: 30_000,
}, () => {
	const census = { total: 0, formItextMedia: 0, sectioned: 0 };
	assertGenerated(
		fc.property(blueprintDocArbitrary, (doc) => {
			checkCompilerEvidence(doc);
			census.total++;
			if (hasFormItextMedia(doc)) census.formItextMedia++;
			if (hasSectionedForm(doc)) census.sectioned++;
		}),
		{ seed: 20260522, numRuns: 500 },
	);
	expect(census.total).toBe(500);
	expect(census.formItextMedia / census.total).toBeGreaterThan(0.3);
	expect(census.sectioned / census.total).toBeGreaterThan(0.3);
});
