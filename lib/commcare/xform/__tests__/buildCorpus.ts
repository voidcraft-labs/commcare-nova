/**
 * Golden-corpus generator for the XForm emitter behavior-preservation gate.
 *
 * Run with `npx tsx lib/commcare/xform/__tests__/buildCorpus.ts` to (re)write
 * the corpus snapshot. It samples a FIXED set of schema-valid
 * `BlueprintDoc`s from the shared fuzz arbitrary (`blueprintDocArbitrary`) at a
 * pinned seed, emits every form's XForm through the CURRENT `buildXForm`,
 * canonicalizes the output, and records `{ key → canonicalXml }`.
 *
 * The corpus is the FIXED TARGET for the string→DOM rewrite: it must be
 * captured against the UNCHANGED emitter (before any rewrite edit) so the
 * equivalence test grades the new emitter against the old behavior, not against
 * a moving target. Regenerating it after a behavioral change would defeat its
 * purpose — only regenerate when the OLD-emitter snapshot is what you want to
 * pin (i.e. essentially never after initial capture; a real emitter behavior
 * change is reviewed via the equivalence test failing, not by silently
 * re-snapshotting).
 *
 * Each corpus key is `d{docIndex}:f{formIndex}` — deterministic from the seed
 * (sample order is stable) and the form's POSITION in the doc's form-order
 * walk. Both indices are stable across runs and traceable to a specific
 * generated form.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fc from "fast-check";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { buildXForm } from "../builder";
import { canonicalizeXForm } from "./canonicalXml";

/**
 * Fixed instance namespace used for every corpus form.
 *
 * `expandDoc` generates a FRESH RANDOM `xmlns` per form per call
 * (`http://openrosa.org/formdesigner/<random>`), which would make the emitted
 * XForm — and thus its canonical form — differ between the capture run and
 * every later test run. The corpus must be reproducible, so we drive
 * `buildXForm` directly with a constant `xmlns`. This also isolates the gate to
 * the rewrite target (`buildXForm`) rather than threading through the
 * expander's id allocation. The arbitrary only generates non-Connect docs
 * (`connectType: null`), so no `connect` option is ever needed here.
 */
const FIXED_XMLNS = "http://openrosa.org/formdesigner/CORPUS-FIXED";

/**
 * Pinned sampling parameters. `SEED` matches the XForm oracle fuzzer's seed so
 * the corpus draws from the same generator population the totality proof
 * exercises; `NUM_DOCS` is sized to clear the ≥200-form-entry acceptance bar
 * (each doc emits multiple forms, so the corpus holds well over 200 entries).
 */
export const CORPUS_SEED = 20260522;
export const CORPUS_NUM_DOCS = 220;

/**
 * Absolute path of the checked-in corpus fixture. The `.snapshot.json` name
 * under `__fixtures__/` matches the project's existing Biome ignore pattern for
 * generated snapshot artifacts (`!!**​/__fixtures__/*.snapshot.json` in
 * `biome.json`), so the multi-megabyte fixture is excluded from lint/format the
 * same way every other checked-in snapshot is.
 */
export const CORPUS_PATH = join(
	import.meta.dirname,
	"__fixtures__",
	"xformGoldenCorpus.snapshot.json",
);

/**
 * Build the corpus map by emitting + canonicalizing every form of every
 * schema-valid sampled doc. Shared by the generator script and the equivalence
 * test (the test re-emits the same inputs and compares against the recorded
 * values), so the two can never disagree on which inputs are in scope.
 */
export function buildCorpus(): Record<string, string> {
	const docs = fc.sample(blueprintDocArbitrary, {
		numRuns: CORPUS_NUM_DOCS,
		seed: CORPUS_SEED,
	});
	const corpus: Record<string, string> = {};
	docs.forEach((doc, docIndex) => {
		rebuildFieldParent(doc);
		// Skip any doc the domain validator would reject. The arbitrary is
		// valid-by-construction, so in practice none are skipped — but keeping
		// the guard means a future generator slip can't poison the corpus with
		// an invalid-doc emission.
		if (runValidation(doc).length > 0) return;
		// Walk the doc's forms in document order (module-order × form-order) and
		// emit each via `buildXForm` directly with the fixed namespace.
		let formIndex = 0;
		for (const moduleUuid of doc.moduleOrder) {
			for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
				const xform = buildXForm(doc, formUuid, { xmlns: FIXED_XMLNS });
				corpus[`d${docIndex}:f${formIndex}`] = canonicalizeXForm(xform);
				formIndex++;
			}
		}
	});
	return corpus;
}

// Direct-run guard: only write the file when invoked as a script, never when
// imported by the equivalence test.
if (import.meta.url === `file://${process.argv[1]}`) {
	const corpus = buildCorpus();
	writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
	console.log(
		`Wrote ${Object.keys(corpus).length} canonical XForm entries to ${CORPUS_PATH}`,
	);
}
