/**
 * Behavior-preservation gate for the `builder.ts` string→DOM rewrite.
 *
 * The XForm oracle proves the emitter is TOTAL (every output is well-formed +
 * parse-legal), but totality is NOT behavior preservation: two valid XForms can
 * differ semantically (a reordered setvalue, a dropped attribute, a changed
 * namespace). This test pins the OLD emitter's behavior as a golden corpus and
 * asserts the NEW emitter reproduces it EXACTLY, modulo the four cosmetic
 * dimensions the canonicalizer normalizes (whitespace, attribute order,
 * self-closing form, entity encoding — see `canonicalXml.ts`).
 *
 * The corpus snapshot was captured from the unchanged emitter BEFORE the
 * rewrite, so it is a fixed target the rewrite is graded
 * against. `buildCorpus()` re-emits the SAME sampled inputs through whatever
 * `buildXForm` is currently compiled in; comparing its canonical output to the
 * recorded canonical value is the proof.
 *
 * If this fails, the new emitter changed behavior. The diff in the failure
 * message is the OLD vs NEW canonical XML for the first divergent form —
 * inspect it: a difference that is NOT one of the four cosmetic dimensions is
 * drift, and drift means the rewrite is wrong, not the gate.
 *
 * SCAFFOLDING — remove after the rewrite lands. This gate (with its ~2 MB
 * `__fixtures__/xformGoldenCorpus.snapshot.json`, `buildCorpus.ts`, and
 * `canonicalXml.ts`) exists to grade ONE migration: it pins the pre-rewrite
 * emitter's bytes, so any intentional emitter change afterward would fail it and
 * force a re-snapshot — churn it can't earn back, because the permanent nets
 * (the XForm oracle + its fuzzer) already prove totality going forward. Keep it
 * only long enough to verify the rewrite, then delete the four files together.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCorpus, CORPUS_PATH } from "./buildCorpus";

describe("XForm emitter behavior preservation (golden corpus)", () => {
	it("reproduces the pre-rewrite canonical output for every corpus entry", () => {
		const golden: Record<string, string> = JSON.parse(
			readFileSync(CORPUS_PATH, "utf-8"),
		);
		const goldenKeys = Object.keys(golden);
		// Guard the acceptance bar: the corpus must hold ≥200 form entries for
		// the proof to be meaningful. A shrunken corpus is itself a failure.
		expect(goldenKeys.length).toBeGreaterThanOrEqual(200);

		// Re-emit the same sampled inputs through the CURRENT emitter.
		const fresh = buildCorpus();

		// Same key set: a missing or extra key means the emitter changed which
		// forms it produces — itself a behavioral change to surface.
		expect(Object.keys(fresh).sort()).toEqual(goldenKeys.sort());

		// Per-entry canonical equivalence. Compare individually so the failure
		// message names the first divergent form and shows its OLD vs NEW
		// canonical XML, not an opaque whole-object mismatch.
		for (const key of goldenKeys) {
			expect(fresh[key], `canonical XForm drift for "${key}"`).toBe(
				golden[key],
			);
		}
	});
});
