// lib/domain/placements.ts
//
// Where CommCare HQ keeps one case change of a form: in the form's Case
// Management settings (a basic slot) or in a Save to Case block in the
// form. A placement is derived on every read from the form's case
// operations; the shapes here are what a held placement stores, the slot
// an operation (`forms.ts::caseOperationSchema`'s `placement`) or a
// form's own close (`Form.ownClosePlacement`) keeps when a published app
// already has the change at that place. No mutation payload, tool schema
// or builder control carries one.

import { z } from "zod";
import { XML_ELEMENT_NAME_PATTERN } from "./expression/types";
import { uuidSchema } from "./uuid";

/**
 * One element name of a Save to Case path. Every segment is an XML element
 * name, so a segment holding `/` or starting with a digit (which HQ could
 * not address as one element) is refused.
 */
const xmlNameSchema = z.string().regex(XML_ELEMENT_NAME_PATTERN);

/** A slot of the form's Case Management settings. */
export const basicPlacementSchema = z.discriminatedUnion("slot", [
	z.strictObject({ kind: z.literal("basic"), slot: z.literal("own") }),
	z.strictObject({ kind: z.literal("basic"), slot: z.literal("usercase") }),
	/** `subcases[index]`, written at `subcase_<index>`: at the data root, or in a
	 *  repeat that holds more than one basic subcase. */
	z.strictObject({
		kind: z.literal("basic"),
		slot: z.literal("subcase"),
		index: z.number().int().nonnegative(),
	}),
	/** The one basic subcase of its repeat, written at the row's `case`. Its
	 *  index in `subcases` reaches no path, so it holds none. */
	z.strictObject({ kind: z.literal("basic"), slot: z.literal("subcase-row") }),
]);
export type BasicPlacement = z.infer<typeof basicPlacementSchema>;

/** A Save to Case block in the form. */
export const saveToCasePlacementSchema = z.strictObject({
	kind: z.literal("save-to-case"),
	/** The `forEach` repeat the block was placed in; absent at the form root. */
	repeat: uuidSchema.optional(),
	/** Element names from that scope (the form root, or the repeat's row) to the
	 *  element that carries `vellum:role="SaveToCase"`, every segment. */
	path: z.tuple([xmlNameSchema], xmlNameSchema),
});
export type SaveToCasePlacement = z.infer<typeof saveToCasePlacementSchema>;

export const casePlacementSchema = z.union([
	basicPlacementSchema,
	saveToCasePlacementSchema,
]);
export type CasePlacement = z.infer<typeof casePlacementSchema>;

/** The own close runs once per form, at the root (a close in a repeat is the
 *  cutover's blocker `own-close-in-repeat`), so its block holds no `repeat`. */
export const ownClosePlacementSchema = saveToCasePlacementSchema.omit({
	repeat: true,
});
export type OwnClosePlacement = z.infer<typeof ownClosePlacementSchema>;

/**
 * Why a case change can no longer stay where it is held, or cannot take a
 * place it would otherwise take. Each reason's sentence is
 * `placementCopy.ts::placementIneligibilitySentence`.
 */
export const PLACEMENT_INELIGIBILITY_REASONS = [
	"module-advanced",
	"module-basic",
	"several-cases",
	"value-computed",
	"value-label",
	"value-in-repeat",
	"value-wrong-repeat",
	"name-repeat",
	"write-condition",
	"links",
	"subcase-link",
	"own-not-basic",
	"subcase-type",
	"keyed-id",
	"condition-shape",
	"condition-question-kind",
	"condition-question-repeat",
	"condition-apostrophe",
	"condition-quote-boundary",
	"condition-not-a-choice",
	"case-changed-before-create",
	"subcase-index",
	"subcase-nesting",
	"only-if-changed",
	"via",
	"scope",
	"block-shape",
	"no-close",
] as const;
export type PlacementIneligibilityReason =
	(typeof PLACEMENT_INELIGIBILITY_REASONS)[number];

export interface PlacementIneligibility {
	readonly reason: PlacementIneligibilityReason;
	/** Which condition the reason is about, where it is about one: the form's
	 *  open condition, its close condition, or the operation's own. */
	readonly condition?: "open" | "close" | "operation";
}
