import * as fc from "fast-check";
import { expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { assertGenerated, checkCompilerEvidence } from "./compilerEvidence";
import {
	blueprintDocArbitrary,
	hasFormItextMedia,
	hasSectionedForm,
	sessionReadDocArbitrary,
} from "./xformDocArbitrary";

// Finite seeded corpus, with shrinking enabled. These checks complement the
// independent wire examples; they do not prove acceptance by a native runtime.
it("compiles 500 field-tree samples with valid schema, bindings, and archived resources", {
	// The complete synchronous corpus took 34s on a shared CI runner before
	// native media-byte comparison. Keep all 500 samples and scheduling margin.
	timeout: 60_000,
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

// A raw session read is admitted exactly when the form's entry declares the
// datum: then the compiled forms pass every oracle, the binding-resolution
// oracle among them; otherwise the validator refuses the read at its slot and
// nothing is compiled.
it("admits a raw session read only of a datum the form's entry declares", {
	timeout: 60_000,
}, () => {
	const census = { declared: 0, refused: 0 };
	assertGenerated(
		fc.property(sessionReadDocArbitrary, ({ doc, datumId, declared }) => {
			if (declared) {
				checkCompilerEvidence(doc);
				census.declared++;
				return;
			}
			const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			expect(findings.map((finding) => finding.code)).toEqual([
				"SESSION_DATUM_NOT_SUPPLIED",
			]);
			expect(findings[0]?.details).toMatchObject({
				datumId,
				slot: "calculate",
			});
			expect(findings[0]?.location.fieldId).toBe("session_read");
			census.refused++;
		}),
		{ seed: 20261015, numRuns: 120 },
	);
	expect(census.declared).toBeGreaterThan(10);
	expect(census.refused).toBeGreaterThan(10);
});
