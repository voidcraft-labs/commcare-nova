/**
 * Property-based fuzzer that proves the XForm emitter TOTAL: for every doc the
 * generator produces, every emitted XForm passes the oracle clean — both off
 * the raw `expandDoc` output AND off the `compileCcz` output (after the
 * compiler splices `<case>`/`<subcase>` blocks in, the second oracle call site).
 *
 * The oracle (`validateXForm`) and this fuzzer are co-developed — the oracle is
 * defined by its fuzzer role. A failing case is one of two things, never a new
 * reject rule:
 *   (A) the oracle is too strict (Core would accept the form) → fix the ORACLE;
 *   (B) the emitter produced output Core rejects → fix the EMITTER at source.
 *
 * The generator (`blueprintDocArbitrary`) builds docs valid BY CONSTRUCTION,
 * but each property body re-asserts `runValidation(doc).length === 0` first:
 * the totality claim is scoped to schema-valid docs, so a generator slip must
 * fail loud as a generator bug rather than silently feed an invalid doc to the
 * emitter.
 *
 * **Coverage scope (honest).** The generator exercises FIELD / FORM / REPEAT
 * structure: all field kinds, all four form types, all three repeat modes
 * (incl. query_bound model-iteration), nested groups + repeats, same-id COUSIN
 * fields (different parents sharing an `id` — the case the path + itext
 * arithmetic must disambiguate), selects with duplicate option values, the
 * relevant/required/constraint/calculate/default_value/hint XPath surfaces, and
 * case-bearing forms (so case-block injection runs in the compileCcz pass). It
 * also generates CommCare Connect apps (learn + deliver, every sub-config
 * shape), so `buildConnectBlocks`'s data + bind emission is exercised here too.
 * It does NOT yet generate module-level `caseSearchConfig`, `form_links`, or
 * multi-language itext — those are suite-emission / app-shape surfaces outside
 * the XForm parse-time oracle's scope, and out of scope for this fuzzer until
 * those oracles exist.
 *
 * Seeded for reproducibility; 500 runs to be meaningful without ballooning CI.
 */

import * as fc from "fast-check";
import { describe, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { errorToString } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocArbitrary } from "./xformDocArbitrary";

/** Fixed seed + run count so a failure reproduces exactly across runs + CI. */
const SEED = 20260522;
const NUM_RUNS = 500;

/**
 * Prepare a generated doc for consumption: rebuild the reverse parent index
 * (the generator leaves it empty, like `buildDoc`) and assert the doc is
 * schema-valid. A non-empty domain-validator result is a GENERATOR bug, thrown
 * loud here rather than fed to the emitter — the totality claim is scoped to
 * schema-valid docs.
 */
function prepareAndGuard(doc: BlueprintDoc): void {
	rebuildFieldParent(doc);
	const domainErrors = runValidation(doc);
	if (domainErrors.length > 0) {
		throw new Error(
			`Generator produced a doc the domain validator rejects (generator bug, not an emitter finding):\n${domainErrors
				.map((e) => `  - [${e.code}] ${errorToString(e)}`)
				.join("\n")}`,
		);
	}
}

describe("XForm emitter totality (property-based fuzz)", () => {
	it("every form of every schema-valid doc emits oracle-clean XForm", () => {
		fc.assert(
			fc.property(blueprintDocArbitrary, (doc) => {
				prepareAndGuard(doc);

				// Emit + check every form's XForm. A non-empty oracle result is
				// the property failure we're hunting (classify A vs B).
				const hqJson = expandDoc(doc);
				for (const [key, attachment] of Object.entries(hqJson._attachments)) {
					if (!key.endsWith(".xml")) continue;
					if (typeof attachment !== "string") continue;
					const oracleErrors = validateXForm(attachment, key, "fuzz");
					if (oracleErrors.length > 0) {
						throw new Error(
							`Oracle flagged emitted XForm "${key}":\n${oracleErrors
								.map((e) => `  - [${e.code}] ${errorToString(e)}`)
								.join("\n")}\n\n--- emitted XForm ---\n${attachment}`,
						);
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});

	it("compileCcz never trips its post-case-block-injection oracle re-check", () => {
		// The SECOND oracle call site: `compiler.ts` splices <case>/<subcase>
		// blocks into each case-bearing form's XForm, then re-runs `validateXForm`
		// and THROWS if the spliced output is invalid. Driving compileCcz here
		// fuzzes that injected-XForm shape — a throw is a finding (the case-block
		// splice produced output the oracle rejects: classify A vs B from the
		// thrown message). expandDoc-direct fuzzing above never reaches it.
		fc.assert(
			fc.property(blueprintDocArbitrary, (doc) => {
				prepareAndGuard(doc);
				const hqJson = expandDoc(doc);
				// Throws on any post-injection oracle failure; surface it verbatim
				// as the property failure (the message already names the form +
				// the offending oracle codes).
				compileCcz(hqJson, doc.appName, doc);
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});
});
