// lib/doc/lookupOptionsSourceMutations.ts
//
// The one place a select's lookup options source is written, including the
// removal — and the removal is the whole reason this file exists.
//
// `optionsSource` precedence is PRESENCE-based at every consumer:
// `lib/commcare/xform/builder.ts` branches on `optionsSource !== undefined`,
// and so does the preview's choice evaluation. That makes the two directions
// of the switch asymmetric, and treating them symmetrically ships a Table →
// Inline switch that is observably inert:
//
//   - Inline → Table merely SETS `optionsSource`. The field's inline options
//     stay exactly where they are, and that is deliberate: they are the
//     origin-compatible fallback a pre-S05 receiver reads, and the shape a
//     duplicate reverts to.
//   - Table → Inline must CLEAR it. Leaving the source in place would let the
//     retained table keep winning at every consumer while the editor claims
//     the field is back on its typed-in list.
//
// And the clear must be an explicit `null`, never `undefined`. The reducer
// deletes the slot on either spelling, so both work in memory — they diverge
// the moment the mutation object is itself the DURABLE event. The SSE
// `data-mutations` frame and the persisted jsonb are both `JSON.stringify`,
// which drops an `undefined`-valued key: the clear applies locally, round-trips
// through neither, and the next auto-save rewrites the stale source.
//
// `optionsSource` qualifies for null-as-delete because every reader treats
// absent and `null` identically — the validator rule short-circuits on
// `source?.filter === undefined`, the emitter branches on `!== undefined`, and
// the preview's coverage predicates read absence as "no carrier". Verify that
// per slot rather than assuming it.
//
// The builder does not depend on this planner today: `useBlueprintMutations`
// applies locally and the reconciler persists a document DIFF, and
// `diffDocsToMutations` independently spells an absent source as `null`. Both
// roads already end at `null`. This planner is what makes the mutation OBJECT
// correct on its own, so a durable emitter of these events — the SA and MCP
// tools unit 3 builds — inherits the right spelling instead of rediscovering
// it. The same reasoning `lib/doc/displayConditionMutations.ts` records.

import type { Uuid } from "@/lib/domain";
import type { LookupOptionsSource } from "@/lib/domain/lookupCarriers";
import type { Mutation } from "./types";

/** The two field kinds that can carry a lookup options source. */
export type LookupOptionsSourceCarrierKind = "single_select" | "multi_select";

/**
 * Point a select at a lookup table column, or take it off one.
 *
 * Pass `undefined` to go back to the field's typed-in options; the emitted
 * mutation carries the durable `null`.
 */
export function setFieldOptionsSourceMutation(
	uuid: Uuid,
	targetKind: LookupOptionsSourceCarrierKind,
	next: LookupOptionsSource | undefined,
): Mutation {
	return {
		kind: "updateField",
		uuid,
		targetKind,
		/* Empty on purpose. The inline options are NOT touched by either
		 * direction of the switch: setting a source leaves them as the
		 * fallback, and clearing one reveals them again unchanged. */
		patch: {},
		optionsSource: next ?? null,
	} as Mutation;
}
