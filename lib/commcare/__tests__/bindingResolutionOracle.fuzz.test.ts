/**
 * Property-based fuzzer for the binding-resolution oracle.
 *
 * Same shape as `xformOracle.fuzz.test.ts`: for every schema-valid
 * `BlueprintDoc` the `blueprintDocArbitrary` generator produces, the
 * full compile chain (expandDoc → compileCcz → addCaseBlocks →
 * validateXForm + validateBindingResolution) succeeds without throwing.
 *
 * This proves the oracle/emitter pair TOTAL across the generator's
 * coverage — every doc shape produces a CCZ whose XForm references
 * (every `instance('commcaresession')/session/data/<X>`, every
 * `instance('<id>')`) resolve against the entry's session and the
 * form's declared instances.
 *
 * Co-development discipline (same as the other oracle fuzzers): a
 * failing case is one of two things, never a new reject rule:
 *   (A) the oracle is too strict (the reference is legitimate and
 *       JavaRosa would resolve it) → fix the ORACLE;
 *   (B) the emitter produced an unresolvable reference → fix the
 *       EMITTER at source.
 *
 * `compileCcz` already runs the binding-resolution oracle internally
 * via the post-injection validation gate, so a failing resolution
 * throws — `fc.assert` translates the throw into a property failure
 * with a shrunken counterexample.
 */

import * as fc from "fast-check";
import { describe, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocArbitrary } from "./xformDocArbitrary";

/** Fixed seed + run count for reproducibility across runs + CI. */
const SEED = 20260522;
const NUM_RUNS = 500;

/**
 * Rebuild the per-doc `fieldParent` index (the generator omits it for
 * compactness) and assert schema validity. Mirrors the prep step in
 * `xformOracle.fuzz.test.ts` so the fuzzers share their doc-shape
 * assumptions.
 */
function prepareAndGuard(doc: BlueprintDoc): void {
	rebuildFieldParent(doc);
	const errors = runValidation(doc);
	if (errors.length > 0) {
		throw new Error(
			`Generator slip: produced schema-invalid doc with errors:\n${errors
				.map((e) => `  - ${e.message}`)
				.join("\n")}`,
		);
	}
}

describe("binding-resolution emitter totality (property-based fuzz)", () => {
	it("every schema-valid doc compiles to a CCZ whose XPath references all resolve", () => {
		fc.assert(
			fc.property(blueprintDocArbitrary, (doc) => {
				prepareAndGuard(doc);
				// `compileCcz` invokes `validateBindingResolution` after the
				// case-block splice; a failing resolution throws and fails
				// this property. The expandDoc + compileCcz pair is the
				// same end-to-end shape `xformOracle.fuzz.test.ts` exercises;
				// the binding-resolution oracle is the second post-injection
				// gate the compiler now runs.
				const hq = expandDoc(doc);
				compileCcz(hq, doc.appName, doc);
				return true;
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});
