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
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { errorToString } from "@/lib/commcare/validator/errors";
import { validateMediaSuite } from "@/lib/commcare/validator/mediaSuiteOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { AssetId } from "@/lib/domain/multimedia";
import {
	hasCaseSearch,
	hasChildCase,
	hasSort,
	hasSuiteMedia,
	moduleCount,
	suiteDocArbitrary,
} from "./suiteDocArbitrary";
import { type FuzzMediaAsset, fuzzManifestFromDoc } from "./xformDocArbitrary";

/** Fixed seed + run count so a failure reproduces exactly across runs + CI. */
const SEED = 20260522;
const NUM_RUNS = 400;

/**
 * Per-test timeout for the heavy fuzz body. Each iteration compiles a CCZ,
 * extracts suite + media_suite + app_strings, and runs two oracles — the
 * body itself is ~2.5s for 400 runs in isolation, but cross-worker
 * contention under the full vitest run can push past Vitest's 5s default.
 * 30s gives enough headroom for the heaviest contention case without
 * hiding a runaway loop (which would still exceed it).
 */
const FUZZ_TIMEOUT_MS = 30_000;

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
 * Extract `suite.xml`, the default-locale app_strings key→value map, and the
 * `commcare/<file>` wire-path set from a compiled `.ccz` buffer. The fuzzer
 * mirrors the runtime's own read path: the suite is one zip entry, the
 * locale ids it must resolve against live in `default/app_strings.txt` as
 * `key=value` lines, and the bundled-media set is every zip entry under the
 * `commcare/` directory.
 */
function extractSuite(ccz: Buffer): {
	suiteXml: string;
	mediaSuiteXml: string;
	appStringKeys: Set<string>;
	appStringValues: Map<string, string>;
	bundledPaths: Set<string>;
} {
	const zip = new AdmZip(ccz);
	const suiteEntry = zip.getEntry("suite.xml");
	if (suiteEntry === null) {
		throw new Error("compileCcz produced a .ccz with no suite.xml entry.");
	}
	const suiteXml = suiteEntry.getData().toString("utf-8");

	const mediaSuiteEntry = zip.getEntry("media_suite.xml");
	if (mediaSuiteEntry === null) {
		throw new Error(
			"compileCcz produced a .ccz with no media_suite.xml entry.",
		);
	}
	const mediaSuiteXml = mediaSuiteEntry.getData().toString("utf-8");

	const stringsEntry = zip.getEntry("default/app_strings.txt");
	if (stringsEntry === null) {
		throw new Error(
			"compileCcz produced a .ccz with no default/app_strings.txt entry.",
		);
	}
	const appStringKeys = new Set<string>();
	const appStringValues = new Map<string, string>();
	for (const line of stringsEntry.getData().toString("utf-8").split("\n")) {
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1);
		appStringKeys.add(key);
		appStringValues.set(key, value);
	}

	const bundledPaths = new Set<string>();
	for (const entry of zip.getEntries()) {
		if (entry.entryName.startsWith("commcare/")) {
			bundledPaths.add(entry.entryName);
		}
	}

	return {
		suiteXml,
		mediaSuiteXml,
		appStringKeys,
		appStringValues,
		bundledPaths,
	};
}

/**
 * Lift the fuzz-synthesized manifest to the `AssetManifest` shape the
 * emitter and compiler consume, attaching placeholder bytes so the CCZ
 * bundler's byte-contract throw doesn't fire (the archive bytes themselves
 * aren't a suite-oracle concern — empty buffers are fine).
 */
function toAssetManifest(
	fuzzManifest: ReadonlyMap<AssetId, FuzzMediaAsset>,
): AssetManifest {
	const placeholderBytes = Buffer.alloc(0);
	const m = new Map<AssetId, ResolvedMediaAsset>();
	for (const [id, fuzz] of fuzzManifest) {
		m.set(id, {
			assetId: fuzz.assetId,
			wirePath: fuzz.wirePath,
			kind: fuzz.kind,
			mimeType: fuzz.mimeType,
			contentHash: fuzz.contentHash,
			extension: fuzz.extension,
			bytes: placeholderBytes,
		});
	}
	return m;
}

describe("suite emitter totality (property-based fuzz)", () => {
	// Census counters accumulated across the run; asserted after.
	const census = {
		total: 0,
		multiModule: 0,
		caseSearch: 0,
		childCase: 0,
		sort: 0,
		// The media-resolution checks (menu locales + image-map literals) only
		// exercise on docs carrying SUITE-borne media — menu icon/audioLabel or
		// an image-map column. A drift to zero of that population would silently
		// weaken the suite oracle's media path; the assertion below floors it.
		// (Deliberately NOT the broader `hasMedia`: logo + field-itext media
		// lower elsewhere and wouldn't keep this check exercised.)
		suiteMedia: 0,
	};

	it("every schema-valid doc emits an oracle-clean suite.xml", {
		timeout: FUZZ_TIMEOUT_MS,
	}, () => {
		fc.assert(
			fc.property(suiteDocArbitrary, (doc) => {
				prepareAndGuard(doc);

				// Census the doc shape before emitting.
				census.total += 1;
				if (moduleCount(doc) > 1) census.multiModule += 1;
				if (hasCaseSearch(doc)) census.caseSearch += 1;
				if (hasChildCase(doc)) census.childCase += 1;
				if (hasSort(doc)) census.sort += 1;
				if (hasSuiteMedia(doc)) census.suiteMedia += 1;

				// Media-on path: thread the fuzz manifest through expand + compile
				// so menu-icon locales + image-map XPath literals land in the
				// emitted suite.xml; the suite oracle's media-resolution check
				// then verifies every reference resolves against the bundled set.
				const fuzzManifest = fuzzManifestFromDoc(doc);
				const manifest = toAssetManifest(fuzzManifest);
				const hqJson = expandDoc(doc, { assets: manifest });
				const ccz = compileCcz(hqJson, doc.appName, doc, { assets: manifest });
				const {
					suiteXml,
					mediaSuiteXml,
					appStringKeys,
					appStringValues,
					bundledPaths,
				} = extractSuite(ccz);

				const oracleErrors = validateSuite(suiteXml, appStringKeys, {
					appStringValues,
					manifest: new Set(
						Array.from(fuzzManifest.values(), (a) => a.wirePath),
					),
				});
				if (oracleErrors.length > 0) {
					throw new Error(
						`Oracle flagged emitted suite.xml:\n${oracleErrors
							.map((e) => `  - [${e.code}] ${errorToString(e)}`)
							.join("\n")}\n\n--- emitted suite.xml ---\n${suiteXml}`,
					);
				}

				// Parallel media-suite oracle pass. The bundled-paths set from the
				// CCZ entries IS the install-time resolution target; a divergence
				// between the media-suite descriptor and the bundled files would
				// surface here as a `MEDIA_LOCATION_PATH_NOT_BUNDLED` finding.
				const mediaSuiteErrors = validateMediaSuite(
					mediaSuiteXml,
					bundledPaths,
				);
				if (mediaSuiteErrors.length > 0) {
					throw new Error(
						`Oracle flagged emitted media_suite.xml:\n${mediaSuiteErrors
							.map((e) => `  - [${e.code}] ${errorToString(e)}`)
							.join(
								"\n",
							)}\n\n--- emitted media_suite.xml ---\n${mediaSuiteXml}`,
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});

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
		// Suite-borne-media docs exercise the menu-locale + image-map
		// XPath-literal resolution paths. A drift below this floor stops
		// exercising the media-OFF→media-ON contract and silently weakens the
		// suite oracle's media-resolution check.
		expect(census.suiteMedia / census.total).toBeGreaterThan(0.3);
	});
});
