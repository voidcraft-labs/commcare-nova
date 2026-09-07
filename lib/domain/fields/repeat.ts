// lib/domain/fields/repeat.ts
//
// Structural container that repeats its child fields N times at runtime —
// once per household member, site visit, query result row, etc. Maps to
// CommCare's `<repeat>` control. Like `group`, repeat does not write to
// the case directly. `relevant` is meaningful at the container level;
// individual child fields carry their own validation/logic.
//
// ## Three repeat modes
//
// `repeat_mode` is an explicit discriminator over how the iteration count
// is determined at runtime. The wire format and runtime UX differ per
// mode — every consumer (XForm emitter, form engine, preview renderer,
// SA tools) dispatches on this field.
//
// 1. **`user_controlled`** — the default. The user clicks Add/Remove
//    during form fill to manage instances. No `jr:count`. Add/Remove
//    buttons render in the preview.
//
// 2. **`count_bound`** — `repeat_count` is an XPath expression
//    (typically referencing another field on the form, e.g.
//    `#form/desired_count`). Nova fixes the count when the repeat's
//    enclosing instance initializes. The emitter snapshots the expression
//    before passing it to `jr:count`; JavaRosa itself can recalculate an
//    unsnapshotted count. `jr:noAddRemove="true()"` suppresses Add/Remove.
//
// 3. **`query_bound`** — iterates over case-database query results.
//    `data_source.ids_query` is an XPath that resolves to a list of
//    case ids; the wire emitter generates `<setvalue>` setup elements
//    when the enclosing instance initializes to seed each instance's id,
//    plus auto-derives `jr:count` as `<repeat-path>/@count`. Each new
//    enclosing repeat instance initializes its own query snapshot.
//
// ## Empty-label repeats are valid (all modes)
//
// Repeats extend `containerFieldBase` (label optional). A non-empty
// label renders as the section-header title; an empty/absent label drops
// the title text but keeps the surrounding chrome (border, chevron,
// "Repeat" badge) and — for `user_controlled` — the iteration UI. The
// wire emitter (`lib/commcare/xform/builder.ts`) skips the `<label>`
// element when the label is empty so the XForm doesn't carry a dangling
// itext reference.

import tablerRepeat from "@iconify-icons/tabler/repeat";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { containerFieldBase, xpathExpressionSchema } from "./base";

/**
 * Shared shape for all three repeat variants — `kind` discriminator,
 * optional `relevant` (gates the whole container), and the optional
 * label inherited from `containerFieldBase`. Mode-specific fields are
 * added per variant below.
 */
const repeatBase = containerFieldBase.extend({
	kind: z.literal("repeat"),
	relevant: xpathExpressionSchema.optional(),
});

/**
 * The three repeat-mode discriminator literals — the canonical
 * vocabulary tuple for `repeat_mode`. Each entry names one variant of
 * the discriminated union below; consumers that key per-variant data
 * (key sets, reference-slot applicability) derive their key type from
 * this tuple so the variant set has a single declaration site. A test
 * in `__tests__/referenceSlots.test.ts` pins each entry to the
 * matching variant schema's `repeat_mode` literal, so the tuple can't
 * drift from the union.
 */
export const repeatModes = [
	"user_controlled",
	"count_bound",
	"query_bound",
] as const;
export type RepeatMode = (typeof repeatModes)[number];

/**
 * User-controlled repeat — the default. Runtime adds/removes instances
 * via UI affordances; no `jr:count` on the wire.
 */
export const userControlledRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("user_controlled"),
});

/**
 * Count-bound repeat — `repeat_count` is an XPath that the runtime
 * snapshots when its enclosing instance initializes. Common pattern:
 * bind to a numeric field elsewhere on the form (`#form/desired_count`).
 * The fixed count is Nova's contract, implemented in its preview and
 * emitted snapshot; it is not a general JavaRosa restriction.
 */
export const countBoundRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("count_bound"),
	repeat_count: xpathExpressionSchema,
});

/**
 * Query-bound repeat (Vellum's "model iteration"). The runtime resolves
 * `data_source.ids_query` when its enclosing instance initializes to case ids,
 * materializes one instance per id, and seeds each instance's nested
 * `@id` via setvalue elements emitted by the XForm builder. Used for
 * patterns like "for each open service case, render a row".
 */
export const queryBoundRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("query_bound"),
	data_source: z
		.object({
			/** XPath returning a space-separated list of case ids to iterate. */
			ids_query: xpathExpressionSchema,
		})
		.strict(),
});

/**
 * Combined union of all three modes. Discriminated on `repeat_mode` so
 * consumers can narrow per-variant. The parent `fieldSchema` unions this
 * repeat schema with its non-repeat kind union, because all three repeat
 * variants share `kind: "repeat"` and cannot be separate members of one
 * discriminated union on kind.
 */
export const repeatFieldSchema = z.discriminatedUnion("repeat_mode", [
	userControlledRepeatSchema,
	countBoundRepeatSchema,
	queryBoundRepeatSchema,
]);

export type UserControlledRepeatField = z.infer<
	typeof userControlledRepeatSchema
>;
export type CountBoundRepeatField = z.infer<typeof countBoundRepeatSchema>;
export type QueryBoundRepeatField = z.infer<typeof queryBoundRepeatSchema>;
export type RepeatField = z.infer<typeof repeatFieldSchema>;

export const repeatFieldMetadata: FieldKindMetadata<"repeat"> = {
	kind: "repeat",
	xformKind: "repeat",
	dataType: "",
	icon: tablerRepeat,
	label: "Repeat",
	isStructural: true,
	isContainer: true,
	saDocs:
		'Repeats its child fields N times. Pick a `repeat_mode`: "user_controlled" for forms where the end user adds entries (e.g. household members). Set repeat_mode and nothing else; "count_bound" for a fixed count from another XPath (set repeat_count); "query_bound" to iterate over case-database query results (set data_source.ids_query). count_bound and query_bound snapshot their count or query when the enclosing instance initializes. Changing dependencies later does not rebuild those instances. A new enclosing repeat instance initializes its own snapshot.',
	convertTargets: ["group"],
};
