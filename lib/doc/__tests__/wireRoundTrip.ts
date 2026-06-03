/**
 * Wire round-trip test helper for the mutation suite.
 *
 * The SA computes `Mutation[]` server-side, then streams them to the
 * client as JSON over SSE (`data-mutations`), where the client feeds the
 * payload straight into `docStore.applyMany`. The in-process Immer output
 * (`result.newDoc` on a tool result, or `applyMany` against the
 * server-side array) does NOT exercise that JSON boundary — and
 * `JSON.stringify` silently DROPS object keys whose value is `undefined`.
 * A mutation that encodes a CLEAR as `{ key: undefined }` therefore looks
 * correct in-process but arrives at the client as `{}`, a no-op clear.
 *
 * `applyOverWire` reproduces the wire: it serializes the mutations to JSON
 * and back BEFORE applying them, so a test asserting on its output catches
 * any clear that depends on a dropped `undefined`. Use it (not bare
 * `applyMany` / `result.newDoc`) in every set+clear test for a media slot
 * or any other clearable field — that blind spot is suite-wide, which is
 * why this helper lives in the shared doc test utils rather than inline in
 * one test file.
 */

import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/**
 * Apply `mutations` to `doc` AFTER a JSON serialize/parse round-trip —
 * exactly what the client does when it receives `data-mutations` over SSE.
 * Returns a new doc; the input is left frozen (matches `applyToDoc`).
 *
 * The round-trip is the whole point: any key the mutation set to
 * `undefined` is gone by the time `applyMutations` runs, so a clear that
 * relied on `{ key: undefined }` will visibly fail to clear here while
 * passing against the in-process Immer output. A correctly-designed
 * clear-safe mutation (explicit `null` on the wire, mapped to `undefined`
 * inside the reducer) survives intact.
 */
export function applyOverWire(
	doc: BlueprintDoc,
	mutations: Mutation[],
): BlueprintDoc {
	// Round-trip through JSON to mirror the SSE wire — `JSON.stringify`
	// drops `undefined`-valued keys, which is the exact failure this helper
	// exists to surface.
	const overWire = JSON.parse(JSON.stringify(mutations)) as Mutation[];
	return produce(doc, (draft) => {
		applyMutations(draft, overWire);
	});
}
