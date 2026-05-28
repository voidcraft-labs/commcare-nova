/**
 * Property-based fuzzer that proves `expandDoc` TOTAL against CommCare HQ's
 * import-deserialization contract: for every schema-valid doc the generator
 * produces, `expandDoc` emits an `HqApplication` the HQ-JSON oracle passes clean.
 *
 * The oracle (`validateHqJson`) and this fuzzer are co-developed — a failing
 * case is one of two things, never a new reject rule:
 *   (A) the oracle is too strict (CommCare's `Application.wrap` would accept the
 *       app) → fix the ORACLE, citing the `models.py` symbol that lets the shape
 *       through;
 *   (B) `expandDoc` produced output `Application.wrap` would reject at import →
 *       fix the EMITTER at source (`expander.ts`, `hqJson/**`, `formActions.ts`,
 *       `session.ts`).
 *
 * The generator (`suiteDocArbitrary`) is the richest in the suite — multi-
 * module, all six column kinds, child cases, sort, and an optional
 * `caseSearchConfig` spanning every search-input shape — so it exercises the
 * action-shape + workflow + condition + subcase-relationship + detail-display
 * surfaces the HQ-JSON oracle's enum checks key off. Each property body re-asserts
 * `runValidation(doc).length === 0` first: the totality claim is scoped to
 * schema-valid docs, so a generator slip fails loud as a generator bug rather
 * than silently feeding an invalid doc to the emitter.
 *
 * **Census.** The oracle's enum checks only mean something if the fuzz run
 * actually drives the slots they guard. A doc with no case-bearing forms never
 * exercises the condition / update_mode checks; one with no child cases never
 * exercises the subcase-relationship check. The property body increments
 * hand-rolled census counters for the import-fatal surfaces, and a final test
 * hard-asserts minimum thresholds — a coverage hole would otherwise let the
 * oracle pass "proven" on docs that never tested most of it.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { errorToString } from "@/lib/commcare/validator/errors";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { AssetId } from "@/lib/domain/multimedia";
import {
	hasCaseSearch,
	hasChildCase,
	hasSort,
	moduleCount,
	suiteDocArbitrary,
} from "./suiteDocArbitrary";
import { type FuzzMediaAsset, fuzzManifestFromDoc } from "./xformDocArbitrary";

/** Fixed seed + run count so a failure reproduces exactly across runs + CI. */
const SEED = 20260522;
const NUM_RUNS = 400;

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
 * Whether any module's expanded forms carry an active (non-`never`) case action.
 * An active action is what makes the condition / update_mode checks meaningful —
 * a survey-only app emits only `never` conditions and empty update maps, so it
 * exercises none of the action-shape enum surface.
 */
function hasActiveCaseAction(doc: BlueprintDoc): boolean {
	return Object.values(doc.forms).some((f) => f.type !== "survey");
}

/**
 * Lift the fuzz manifest to `AssetManifest` for `expandDoc({assets})`. The
 * expander is the only consumer here — it doesn't need bytes (no archive
 * write); `bytes` stays undefined so the manifest is the path-only shape
 * the upload path also produces.
 */
function toAssetManifest(
	fuzzManifest: ReadonlyMap<AssetId, FuzzMediaAsset>,
): AssetManifest {
	const m = new Map<AssetId, ResolvedMediaAsset>();
	for (const [id, fuzz] of fuzzManifest) {
		m.set(id, {
			assetId: fuzz.assetId,
			wirePath: fuzz.wirePath,
			kind: fuzz.kind,
			mimeType: fuzz.mimeType,
			contentHash: fuzz.contentHash,
			extension: fuzz.extension,
		});
	}
	return m;
}

describe("HQ import-JSON emitter totality (property-based fuzz)", () => {
	// Census counters accumulated across the run; asserted after.
	const census = {
		total: 0,
		multiModule: 0,
		caseSearch: 0,
		childCase: 0,
		sort: 0,
		activeCaseAction: 0,
	};

	it("every schema-valid doc expands to an oracle-clean HqApplication", () => {
		fc.assert(
			fc.property(suiteDocArbitrary, (doc) => {
				prepareAndGuard(doc);

				// Census the doc shape before emitting.
				census.total += 1;
				if (moduleCount(doc) > 1) census.multiModule += 1;
				if (hasCaseSearch(doc)) census.caseSearch += 1;
				if (hasChildCase(doc)) census.childCase += 1;
				if (hasSort(doc)) census.sort += 1;
				if (hasActiveCaseAction(doc)) census.activeCaseAction += 1;

				// Media-on path: thread the fuzz manifest through `expandDoc` so
				// the multimedia_map + nav-media dicts + logo_refs land on the
				// expanded application, which is what the oracle's
				// `multimedia_map`/nav-media/logo shape checks resolve against.
				const manifest = toAssetManifest(fuzzManifestFromDoc(doc));
				const hqJson = expandDoc(doc, { assets: manifest });
				const oracleErrors = validateHqJson(hqJson);
				if (oracleErrors.length > 0) {
					throw new Error(
						`Oracle flagged expanded HqApplication:\n${oracleErrors
							.map((e) => `  - [${e.code}] ${errorToString(e)}`)
							.join("\n")}\n\n--- expanded modules ---\n${JSON.stringify(
							hqJson.modules,
							null,
							2,
						)}`,
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});

	it("the run hit minimum coverage thresholds for each import-fatal surface", () => {
		// These ratios are floors, not targets — a generator that drifts below any
		// of them stops exercising the enum check it's meant to, and the oracle is
		// silently weaker. Raising the floors is fine; lowering one to make a flaky
		// run pass is the failure mode this guards against.
		expect(census.total).toBeGreaterThan(0);
		// Multi-module exercises the per-module doc_type + detail-display checks
		// across more than the trivial one-module shape.
		expect(census.multiModule / census.total).toBeGreaterThan(0.25);
		// Active case actions drive the condition + update_mode enum checks; child
		// cases drive the subcase-relationship check. Both must be common.
		expect(census.activeCaseAction / census.total).toBeGreaterThan(0.6);
		expect(census.childCase / census.total).toBeGreaterThan(0.15);
		// Case search + sort exercise the search_config projection + the column
		// number/format propagation onto the detail surfaces.
		expect(census.caseSearch / census.total).toBeGreaterThan(0.25);
		expect(census.sort / census.total).toBeGreaterThan(0.3);
	});
});
