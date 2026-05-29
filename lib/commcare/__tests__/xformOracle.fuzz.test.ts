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
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { errorToString } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { AssetId } from "@/lib/domain/multimedia";
import {
	blueprintDocArbitrary,
	type FuzzMediaAsset,
	fuzzManifestFromDoc,
} from "./xformDocArbitrary";

/** Fixed seed + run count so a failure reproduces exactly across runs + CI. */
const SEED = 20260522;
const NUM_RUNS = 500;

/**
 * Per-test timeout for the heavy fuzz body. Each iteration expands or
 * compiles a doc and walks every emitted XForm. 30s covers worst-case
 * cross-worker contention without hiding a runaway loop.
 */
const FUZZ_TIMEOUT_MS = 30_000;

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

/**
 * Lift the fuzz-synthesized manifest to the shape `expandDoc` / `compileCcz`
 * expect. `withBytes: true` attaches a single shared empty buffer to every
 * asset so the CCZ bundler completes without the byte-load contract throw
 * — the fuzz doesn't validate archive bytes (the file gets sniffed at the
 * upload route, not by the oracles), so empty placeholder bytes are fine.
 */
function toAssetManifest(
	fuzzManifest: ReadonlyMap<AssetId, FuzzMediaAsset>,
	withBytes: boolean,
): AssetManifest {
	// All assets share one zero-byte buffer — the wire-path dedup in the
	// bundler keys on `wirePath`, not on the buffer identity, and the
	// archive bytes themselves aren't an oracle concern in this fuzz.
	const placeholderBytes = withBytes ? Buffer.alloc(0) : undefined;
	const m = new Map<AssetId, ResolvedMediaAsset>();
	for (const [id, fuzz] of fuzzManifest) {
		m.set(id, {
			assetId: fuzz.assetId,
			wirePath: fuzz.wirePath,
			kind: fuzz.kind,
			mimeType: fuzz.mimeType,
			contentHash: fuzz.contentHash,
			extension: fuzz.extension,
			...(placeholderBytes !== undefined ? { bytes: placeholderBytes } : {}),
		});
	}
	return m;
}

/** The set of wire paths the oracle's media-resolution check resolves against. */
function wirePathSet(
	fuzzManifest: ReadonlyMap<AssetId, FuzzMediaAsset>,
): Set<string> {
	return new Set(Array.from(fuzzManifest.values(), (asset) => asset.wirePath));
}

describe("XForm emitter totality (property-based fuzz)", () => {
	it("every form of every schema-valid doc emits oracle-clean XForm", {
		timeout: FUZZ_TIMEOUT_MS,
	}, () => {
		fc.assert(
			fc.property(blueprintDocArbitrary, (doc) => {
				prepareAndGuard(doc);

				// Build the fuzz manifest covering every media reference the doc
				// makes; thread it into `expandDoc` so the XForm emitter actually
				// emits the `<value form="image|audio|video">jr://...` siblings the
				// oracle's media-resolution check resolves. The set of wire paths
				// drives the oracle's manifest gate.
				const fuzzManifest = fuzzManifestFromDoc(doc);
				// `expandDoc` is the path-only consumer — no bytes needed.
				const manifest = toAssetManifest(fuzzManifest, false);
				const manifestPaths = wirePathSet(fuzzManifest);

				const hqJson = expandDoc(doc, { assets: manifest });
				for (const [key, attachment] of Object.entries(hqJson._attachments)) {
					if (!key.endsWith(".xml")) continue;
					if (typeof attachment !== "string") continue;
					const oracleErrors = validateXForm(
						attachment,
						key,
						"fuzz",
						manifestPaths,
					);
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

	it("compileCcz never trips its post-case-block-injection oracle re-check", {
		timeout: FUZZ_TIMEOUT_MS,
	}, () => {
		// The SECOND oracle call site: `compiler.ts` splices <case>/<subcase>
		// blocks into each case-bearing form's XForm, then re-runs `validateXForm`
		// and THROWS if the spliced output is invalid. Driving compileCcz here
		// fuzzes that injected-XForm shape — a throw is a finding (the case-block
		// splice produced output the oracle rejects: classify A vs B from the
		// thrown message). expandDoc-direct fuzzing above never reaches it.
		//
		// Media-on path: thread the same fuzz manifest through compile so the
		// case-block splice runs against media-bearing forms too, exercising
		// the media path through the second oracle invocation.
		fc.assert(
			fc.property(blueprintDocArbitrary, (doc) => {
				prepareAndGuard(doc);
				// `compileCcz` requires bytes per the buildMediaBundle contract —
				// attach placeholder bytes to every asset.
				const manifest = toAssetManifest(fuzzManifestFromDoc(doc), true);
				const hqJson = expandDoc(doc, { assets: manifest });
				// Throws on any post-injection oracle failure; surface it verbatim
				// as the property failure (the message already names the form +
				// the offending oracle codes).
				compileCcz(hqJson, doc.appName, doc, { assets: manifest });
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});
});
