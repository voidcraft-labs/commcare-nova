/**
 * Behavioral pin for `moduleNotFoundResult` — the typed Elm-style error
 * helper consumed by every SA tool family that addresses a module by
 * positional index.
 *
 * The helper has one job — return a `MutatingToolResult` whose mutation
 * list is empty, whose doc is the input verbatim, and whose result
 * carries an Elm-style three-component error string. The test pins all
 * three plus the error voice so a future cross-family edit doesn't
 * accidentally drift one tool's wording out of sync with the others.
 */

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { moduleNotFoundResult } from "../moduleNotFoundResult";

/**
 * Minimal `BlueprintDoc` for the helper test. The helper reads no
 * fields off `doc` — it threads the input through as-is — so the
 * shape only has to type-check against `BlueprintDoc`.
 */
function makeDoc(): BlueprintDoc {
	return {
		appId: "test-app",
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/**
 * The helper is generic over the success arm (`R`); the no-op return
 * always lands on the `error` arm of `R | { error: string }`. We bind
 * `R = never` at every call site so the result type narrows directly
 * to `{ error: string }` and the assertions read without a redundant
 * `if ("error" in ...)` narrow.
 */

describe("moduleNotFoundResult", () => {
	it("returns the canonical no-op MutatingToolResult shape", () => {
		const doc = makeDoc();
		const result = moduleNotFoundResult<never>(
			doc,
			7,
			"set the case-search claim",
		);

		expect(result.kind).toBe("mutate");
		expect(result.mutations).toEqual([]);
		expect(result.newDoc).toBe(doc);
	});

	it("produces an Elm-style three-component error message", () => {
		// Voice contract — the error must carry: (1) what was tried + the
		// concrete failure, (2) the index that missed, (3) the recovery
		// hint pointing at `getModule`'s projection. Pinned here so a
		// future tweak to the helper's wording stays consistent across
		// every consuming family.
		const result = moduleNotFoundResult<never>(
			makeDoc(),
			42,
			"set the case-search display",
		);

		expect(result.result.error).toContain(
			"Tried to set the case-search display",
		);
		expect(result.result.error).toContain("module index 42");
		expect(result.result.error).toContain("Found no module at that index");
		expect(result.result.error).toContain("`getModule`'s projection");
	});

	it("preserves the supplied `actionPhrase` verbatim", () => {
		// Tools build their own verb-phrase on each call. Asserting two
		// distinct phrases land verbatim guards against an accidental
		// hard-code at the helper's call site.
		const r1 = moduleNotFoundResult<never>(
			makeDoc(),
			0,
			"add a case list column",
		);
		const r2 = moduleNotFoundResult<never>(
			makeDoc(),
			0,
			"set the case list filter",
		);

		expect(r1.result.error).toContain("add a case list column");
		expect(r2.result.error).toContain("set the case list filter");
	});
});
