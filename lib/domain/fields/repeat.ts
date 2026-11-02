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
//    `#form/desired_count`). The count is read live during entry. Increasing it adds
//    rows; decreasing it retains created rows, answers, and case operations. `jr:noAddRemove="true()"` suppresses Add/Remove.
//
// 3. **`query_bound`** — one row per case id `data_source.ids_query`
//    finds. The repeat has a placement (`queryRepeatPlacement.ts`), held
//    in `placement` once a publish carries it or a migration records it,
//    and otherwise the effective one: model iteration, Vellum's shape,
//    whose rows are the records found when the form opens, only where the
//    repeat is in no repeat, its query reads no answer and no group around
//    it shows on a condition that can change during entry; otherwise the
//    count placement, whose rows follow the query as the form is filled
//    in, each row keeping its place, and a row past the end of the result
//    is not relevant. Text spells both placements alike.
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
import { queryRepeatPlacementSchema } from "../queryRepeatPlacement";
import { containerFieldBase, formLogicSchema } from "./base";

/**
 * Shared shape for all three repeat variants — `kind` discriminator,
 * optional `relevant` (gates the whole container), and the optional
 * label inherited from `containerFieldBase`. Mode-specific fields are
 * added per variant below.
 */
const repeatBase = containerFieldBase.extend({
	kind: z.literal("repeat"),
	relevant: formLogicSchema.optional(),
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
 * Count-bound repeat — `repeat_count` is an XPath read during entry.
 * Common pattern:
 * bind to an integer question elsewhere on the form (`#form/desired_count`).
 * Increasing the count adds rows during entry; decreasing it retains
 * created rows, answers, and case operations in the submission.
 */
export const countBoundRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("count_bound"),
	repeat_count: formLogicSchema,
});

/**
 * Query-bound repeat: one row per case id `data_source.ids_query` finds,
 * each row carrying its id. Used for patterns like "for each open service
 * case, render a row". Its rows are set when the form opens (model
 * iteration) or follow the query as answers change (the count placement);
 * `queryRepeatPlacement.ts::effectiveQueryRepeatPlacement` says which.
 */
export const queryBoundRepeatSchema = repeatBase.extend({
	repeat_mode: z.literal("query_bound"),
	data_source: z.strictObject({
		/** XPath returning a space-separated list of case ids to iterate. */
		ids_query: formLogicSchema,
	}),
	/** Held once a publish first carries the repeat (`publish-placement`) or
	 *  a migration records it. Absent: every export takes the effective
	 *  placement (`effectiveQueryRepeatPlacement`). An identity no author
	 *  chooses: no edit carries it (`HELD_FIELD_KEYS`). */
	placement: queryRepeatPlacementSchema.optional(),
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
	carriesValidation: false,
	saDocs:
		'Repeats its child fields N times. Pick a `repeat_mode`: "user_controlled" for forms where the end user adds entries (e.g. household members). Set repeat_mode and nothing else; "count_bound" for a live count from a whole-number question or expression (set repeat_count); "query_bound" to iterate over case-database query results (set data_source.ids_query). Increasing a count_bound count adds rows; decreasing it keeps created rows and their answers and case operations in the submission. query_bound rows are set when the form opens or follow the query as answers change; the fields guide says which.',
	convertTargets: ["group"],
};
