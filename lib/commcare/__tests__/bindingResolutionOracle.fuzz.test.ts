/**
 * Property-based fuzzer for the binding-resolution oracle.
 *
 * The oracle (`validator/bindingResolutionOracle.ts`) is a wire-time
 * TEST oracle, not a user gate — `compileCcz` does not call it. Its
 * job here is to PROVE the emitter is total: every schema-valid
 * `BlueprintDoc` the generator produces must compile to a CCZ whose
 * form-XML XPath references all resolve against the suite's session
 * datums + the form's declared instances.
 *
 * Two-layer check per generated doc:
 *   1. `compileCcz` runs to completion without throwing — proves the
 *      emitter handled every schema-admissible shape.
 *   2. For each form, the binding-resolution oracle is invoked
 *      directly on the emitted XForm + the corresponding entry's
 *      session datums. A failing resolution makes the property fail
 *      with a shrunken counterexample.
 *
 * Co-development discipline (same as the other oracle fuzzers): a
 * failing case is one of two things, never a new reject rule:
 *   (A) the oracle is too strict (the reference is legitimate and
 *       JavaRosa would resolve it) → fix the ORACLE;
 *   (B) the emitter produced an unresolvable reference → fix the
 *       EMITTER at source.
 */

import AdmZip from "adm-zip";
import * as fc from "fast-check";
import { Parser } from "htmlparser2";
import { describe, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { validateBindingResolution } from "@/lib/commcare/validator/bindingResolutionOracle";
import { errorToString } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { AssetId } from "@/lib/domain/multimedia";
import {
	blueprintDocArbitrary,
	type FuzzMediaAsset,
	fuzzManifestFromDoc,
} from "./xformDocArbitrary";

/** Fixed seed + run count for reproducibility across runs + CI. */
const SEED = 20260522;
const NUM_RUNS = 500;

/**
 * Per-test timeout for the heavy fuzz body. Each iteration compiles a CCZ,
 * walks every form's XForm, and runs the install-time resolution oracle.
 * 30s gives enough headroom for the heaviest cross-worker contention
 * without hiding a runaway loop.
 */
const FUZZ_TIMEOUT_MS = 30_000;

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

/**
 * Parse suite.xml and return:
 *   - `resources`: the `modules-N/forms-M.xml` path for each `<xform>`
 *     resource block, in emit order.
 *   - `entries`: the set of `<datum id="...">` ids declared inside each
 *     `<entry>` block's `<session>` block, in emit order. Both function
 *     datums (case-create / subcase) and nodeset datums (case-load)
 *     contribute their ids.
 *
 * The compiler emits resources + entries in module/form lockstep, so the
 * Nth resource and the Nth entry describe the same form — the caller
 * zips by index.
 *
 * Parser is htmlparser2 in XML mode (already used elsewhere in the
 * validator family).
 */
function parseSuite(suiteXml: string): {
	resources: string[];
	entries: Array<{ datumIds: Set<string> }>;
} {
	const resources: string[] = [];
	const entries: Array<{ datumIds: Set<string> }> = [];
	let currentEntry: { datumIds: Set<string> } | null = null;

	const parser = new Parser(
		{
			onopentag(name, attribs) {
				// `<xform><resource id="modules-N/forms-M.xml">` — capture
				// the resource id only when the parent is `<xform>`.
				if (name === "resource" && attribs.id?.startsWith("modules-")) {
					resources.push(attribs.id);
					return;
				}
				if (name === "entry") {
					currentEntry = { datumIds: new Set() };
					return;
				}
				if (currentEntry && name === "datum" && attribs.id) {
					currentEntry.datumIds.add(attribs.id);
				}
			},
			onclosetag(name) {
				if (name === "entry" && currentEntry) {
					entries.push(currentEntry);
					currentEntry = null;
				}
			},
		},
		{ xmlMode: true },
	);
	parser.write(suiteXml);
	parser.end();
	return { resources, entries };
}

/**
 * Lift the fuzz manifest to the shape `expandDoc` / `compileCcz` consume,
 * attaching placeholder bytes so the CCZ bundler's byte-contract check
 * passes (the fuzz doesn't validate archive bytes — empty buffers suffice).
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

/** Set of bundled wire paths for the binding-resolution media check. */
function wirePathSet(
	fuzzManifest: ReadonlyMap<AssetId, FuzzMediaAsset>,
): Set<string> {
	return new Set(Array.from(fuzzManifest.values(), (asset) => asset.wirePath));
}

describe("binding-resolution emitter totality (property-based fuzz)", () => {
	it("every schema-valid doc compiles to a CCZ whose XPath references all resolve", {
		timeout: FUZZ_TIMEOUT_MS,
	}, () => {
		fc.assert(
			fc.property(blueprintDocArbitrary, (doc) => {
				prepareAndGuard(doc);

				// Step 1: compileCcz must be total. A throw here is a
				// compiler bug (either an `expandDoc` shape the emitter
				// doesn't handle, or a parse-time / suite-oracle
				// regression). `fc.assert` turns the throw into a
				// shrunken counterexample. Media-on path: thread the
				// fuzz manifest through so case-block-injected forms
				// carry media too.
				const fuzzManifest = fuzzManifestFromDoc(doc);
				const manifest = toAssetManifest(fuzzManifest);
				const manifestPaths = wirePathSet(fuzzManifest);
				const hq = expandDoc(doc, { assets: manifest });
				const ccz = compileCcz(hq, doc.appName, doc, { assets: manifest });

				// Step 2: for each form, run the binding-resolution
				// oracle directly. `compileCcz` no longer invokes it
				// (authoring rejection in `validator/rules/` is the
				// user-visible gate); this fuzz proves the emitter is
				// total — every accepted doc compiles to references the
				// oracle is happy with. Threading the manifest exercises
				// the install-time media-path resolution check.
				const zip = new AdmZip(ccz);
				const suiteEntry = zip.getEntry("suite.xml");
				if (!suiteEntry) {
					throw new Error("CCZ is missing suite.xml");
				}
				const suiteXml = suiteEntry.getData().toString("utf-8");
				const { resources, entries } = parseSuite(suiteXml);
				if (resources.length !== entries.length) {
					throw new Error(
						`suite.xml has ${resources.length} xform resources but ${entries.length} entries — expected lockstep`,
					);
				}

				for (let i = 0; i < resources.length; i++) {
					const formPath = resources[i];
					const xformEntry = zip.getEntry(formPath);
					if (!xformEntry) {
						throw new Error(
							`CCZ references form "${formPath}" but the file is missing`,
						);
					}
					const xform = xformEntry.getData().toString("utf-8");
					// Form / module names aren't structurally important for
					// the oracle — they only appear in error messages that
					// the throw below stringifies.
					const errors = validateBindingResolution(
						xform,
						formPath,
						doc.appName,
						entries[i].datumIds,
						manifestPaths,
					);
					if (errors.length > 0) {
						throw new Error(
							`Binding resolution failed for "${formPath}":\n` +
								errors.map((e) => `  - ${errorToString(e)}`).join("\n"),
						);
					}
				}
				return true;
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});
