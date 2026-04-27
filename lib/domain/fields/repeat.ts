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
//    `#form/desired_count`). The runtime evaluates `jr:count` ONCE at
//    form load and creates that many instances. Per JavaRosa spec, the
//    count does NOT recalculate when its dependencies change — this is
//    a CommCare quirk we mirror, not a Nova design choice.
//    `jr:noAddRemove="true()"` suppresses Add/Remove.
//
// 3. **`query_bound`** — iterates over case-database query results.
//    `data_source.ids_query` is an XPath that resolves to a list of
//    case ids; the wire emitter generates `<setvalue>` setup elements
//    on the `xforms-ready` event to seed each instance's id, plus
//    auto-derives `jr:count` as `<repeat-path>/@count`. Same one-time
//    evaluation as count_bound. The pattern Vellum calls "model
//    iteration".
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
import { containerFieldBase } from "./base";

/**
 * Shared shape for all three repeat variants — `kind` discriminator,
 * optional `relevant` (gates the whole container), and the optional
 * label inherited from `containerFieldBase`. Mode-specific fields are
 * added per variant below.
 */
const repeatBase = containerFieldBase.extend({
	kind: z.literal("repeat"),
	relevant: z.string().optional(),
});

/**
 * User-controlled repeat — the default. Runtime adds/removes instances
 * via UI affordances; no `jr:count` on the wire.
 */
export const userControlledRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("user_controlled"),
});

/**
 * Count-bound repeat — `repeat_count` is an XPath that the runtime
 * evaluates once to determine instance count. Common pattern: bind to
 * a numeric field elsewhere on the form (`#form/desired_count`).
 * JavaRosa does not recalculate after form load; the count is fixed
 * once instances are materialized.
 */
export const countBoundRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("count_bound"),
	repeat_count: z.string(),
});

/**
 * Query-bound repeat (Vellum's "model iteration"). The runtime resolves
 * `data_source.ids_query` once at form load to a list of case ids,
 * materializes one instance per id, and seeds each instance's nested
 * `@id` via setvalue elements emitted by the XForm builder. Used for
 * patterns like "for each open service case, render a row".
 */
export const queryBoundRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("query_bound"),
	data_source: z.object({
		/** XPath returning a space-separated list of case ids to iterate. */
		ids_query: z.string(),
	}),
});

/**
 * Combined union of all three modes. Discriminated on `repeat_mode` so
 * consumers can narrow per-variant; the parent `fieldSchema` includes
 * each variant directly (rather than this combined schema) because Zod's
 * `discriminatedUnion("kind", ...)` requires unique discriminator values
 * per member, and three repeat variants share `kind: "repeat"`.
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
		'Repeats its child fields N times. Pick a `repeat_mode`: "user_controlled" for forms where the end user adds entries (e.g. household members) — set repeat_mode and nothing else; "count_bound" for a fixed count from another XPath (set repeat_count); "query_bound" to iterate over case-database query results (set data_source.ids_query). count_bound and query_bound do NOT recalculate after form load — JavaRosa spec, not a Nova choice.',
	convertTargets: ["group"],
};
