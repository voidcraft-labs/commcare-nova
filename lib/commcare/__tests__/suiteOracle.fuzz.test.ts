/**
 * Property-based fuzzer that proves the SUITE emitter TOTAL: for every
 * schema-valid doc the generator produces, `compileCcz` emits a `suite.xml`
 * (and `app_strings.txt`) the suite oracle passes clean.
 *
 * The oracle (`validateSuite`) and this fuzzer are co-developed — a failing
 * case is one of two things, never a new reject rule:
 *   (A) the oracle is too strict (CommCare would accept the suite) → fix the
 *       ORACLE, citing the Core source that lets the shape through;
 *   (B) the emitter produced output CommCare rejects / misbehaves on → fix the
 *       EMITTER at source (`compiler.ts`, `suite/**`, `session.ts`).
 *
 * The generator (`suiteDocArbitrary`) builds docs valid BY CONSTRUCTION, but
 * each property body re-asserts `runValidation(doc).length === 0` first: the
 * totality claim is scoped to schema-valid docs, so a generator slip fails loud
 * as a generator bug rather than silently feeding an invalid doc to the
 * emitter.
 *
 * **Census.** A generator that never produces multi-module / case-search /
 * child-case / sort docs proves nothing about the cross-reference checks the
 * oracle exists for. The property body increments hand-rolled census counters
 * for each shape, and a final test hard-asserts minimum thresholds after the
 * fuzz run — a printed-only statistic would let a coverage hole pass silently.
 *
 * One check this fuzz run does NOT exercise: the missing-instance / per-entry
 * instance-intersection logic (`SUITE_MISSING_INSTANCE`). Nova's emitted
 * instance vocabulary is closed to the runtime-resolved set, so every declared
 * instance is also a runtime id and the check can't fire on real output — it's
 * a forward-looking regression guard, covered by the hand-built cases in
 * `suiteOracle.test.ts`, not by this generator.
 */

import AdmZip from "adm-zip";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { errorToString } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import {
	hasCaseSearch,
	hasChildCase,
	hasSort,
	moduleCount,
	suiteDocArbitrary,
} from "./suiteDocArbitrary";

/** Fixed seed + run count so a failure reproduces exactly across runs + CI. */
const SEED = 20260522;
const NUM_RUNS = 400;

/**
 * Generous per-test budget for the emit-heavy property below. It's SYNCHRONOUS
 * and compiles `NUM_RUNS` full `.ccz`s — seconds normally, longer under CI /
 * leak-detector load. Vitest's default 5s `testTimeout` flagged it "timed out"
 * whenever the run crossed 5s on a busy machine: a load-dependent FALSE failure,
 * not a hang (bounded by `NUM_RUNS`). Size the budget to the real workload.
 */
const FUZZ_TIMEOUT_MS = 120_000;

/**
 * Rebuild the reverse parent index (the generator leaves it empty, like
 * `buildDoc`) and assert the doc is schema-valid. A non-empty domain-validator
 * result is a GENERATOR bug, thrown loud here rather than fed to the emitter.
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

/**
 * Extract `suite.xml` and the default-locale app_strings key set from a
 * compiled `.ccz` buffer. The fuzzer mirrors the runtime's own read path:
 * the suite is one zip entry, and the locale ids it must resolve against live
 * in `default/app_strings.txt` as `key=value` lines.
 */
function extractSuite(ccz: Buffer): {
	suiteXml: string;
	appStringKeys: Set<string>;
} {
	const zip = new AdmZip(ccz);
	const suiteEntry = zip.getEntry("suite.xml");
	if (suiteEntry === null) {
		throw new Error("compileCcz produced a .ccz with no suite.xml entry.");
	}
	const suiteXml = suiteEntry.getData().toString("utf-8");

	const stringsEntry = zip.getEntry("default/app_strings.txt");
	if (stringsEntry === null) {
		throw new Error(
			"compileCcz produced a .ccz with no default/app_strings.txt entry.",
		);
	}
	const appStringKeys = new Set<string>();
	for (const line of stringsEntry.getData().toString("utf-8").split("\n")) {
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		appStringKeys.add(line.slice(0, eq));
	}

	return { suiteXml, appStringKeys };
}

describe("suite emitter totality (property-based fuzz)", () => {
	// Census counters accumulated across the run; asserted after.
	const census = {
		total: 0,
		multiModule: 0,
		caseSearch: 0,
		childCase: 0,
		sort: 0,
	};

	it(
		"every schema-valid doc emits an oracle-clean suite.xml",
		() => {
			fc.assert(
				fc.property(suiteDocArbitrary, (doc) => {
					prepareAndGuard(doc);

					// Census the doc shape before emitting.
					census.total += 1;
					if (moduleCount(doc) > 1) census.multiModule += 1;
					if (hasCaseSearch(doc)) census.caseSearch += 1;
					if (hasChildCase(doc)) census.childCase += 1;
					if (hasSort(doc)) census.sort += 1;

					const hqJson = expandDoc(doc);
					const ccz = compileCcz(hqJson, doc.appName, doc);
					const { suiteXml, appStringKeys } = extractSuite(ccz);

					const oracleErrors = validateSuite(suiteXml, appStringKeys);
					if (oracleErrors.length > 0) {
						throw new Error(
							`Oracle flagged emitted suite.xml:\n${oracleErrors
								.map((e) => `  - [${e.code}] ${errorToString(e)}`)
								.join("\n")}\n\n--- emitted suite.xml ---\n${suiteXml}`,
						);
					}
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		},
		FUZZ_TIMEOUT_MS,
	);

	it("the run hit minimum coverage thresholds for each cross-ref shape", () => {
		// These ratios are floors, not targets — a generator that drifts below
		// any of them stops exercising the cross-reference check it's meant to,
		// and the suite is silently weaker. Raising the floors is fine; lowering
		// one to make a flaky run pass is the failure mode this guards against.
		expect(census.total).toBeGreaterThan(0);
		expect(census.multiModule / census.total).toBeGreaterThan(0.25);
		expect(census.caseSearch / census.total).toBeGreaterThan(0.25);
		expect(census.childCase / census.total).toBeGreaterThan(0.15);
		expect(census.sort / census.total).toBeGreaterThan(0.3);
	});
});
