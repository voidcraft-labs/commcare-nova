// lib/domain/placements.ts
//
// Where CommCare HQ keeps one case change of a form: in the form's Case
// Management settings (a basic slot), in the case actions of a form in an
// advanced menu, or in a Save to Case block in the form. A placement is
// derived on every read from the form's case operations; the shapes here
// are what a held placement stores, the slot an operation
// (`forms.ts::caseOperationSchema`'s `placement`) or a form's own close
// (`Form.ownClosePlacement`) keeps when a published app already has the
// change at that place. No mutation payload, tool schema
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

/**
 * The tag of an advanced form's load or open action. HQ writes the action's
 * block at `case_<tag>` and its session value at `case_id_<tag>`, so a tag is
 * one XML element name and never holds `/`.
 */
export const advancedTagSchema = z.string().regex(XML_ELEMENT_NAME_PATTERN);

/** A load or an open action of an advanced form's case actions. `row`: the
 *  open action of a repeat that holds fewer than two indexed open actions,
 *  written at the row's `case`. */
export const advancedPlacementSchema = z.strictObject({
	kind: z.literal("advanced"),
	tag: advancedTagSchema,
	row: z.literal(true).optional(),
});
export type AdvancedPlacement = z.infer<typeof advancedPlacementSchema>;

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
	advancedPlacementSchema,
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
	"value-not-a-question",
	"condition-not-stateable",
	"via-on-indexed-load",
	"owner",
	"retype",
	"link-target",
	"link-renamed-load",
	"repeat-shared",
	"type-not-a-menu",
	"keyed",
	"appended-name-taken",
	"worker-property-name",
	"carried-create",
] as const;
export type PlacementIneligibilityReason =
	(typeof PLACEMENT_INELIGIBILITY_REASONS)[number];

/**
 * Why an operation of an advanced form cannot take a load or an open action
 * and takes Save to Case instead: the reasons
 * `advancedPlacement.ts::loadIneligibility` and `openActionIneligibility`
 * return. `scope` is a subject no load or open action takes, or one that
 * runs in a repeat where a load runs once; `case-changed-before-create`, a
 * new case another change updates or closes, whose open action HQ's build
 * writes after that change.
 */
export const ADVANCED_INELIGIBILITY_REASONS = [
	"scope",
	"case-changed-before-create",
	"value-not-a-question",
	"write-condition",
	"condition-not-stateable",
	"name-repeat",
	"via-on-indexed-load",
	"owner",
	"retype",
	"link-target",
	"link-renamed-load",
	"repeat-shared",
	"type-not-a-menu",
	"keyed",
	"worker-property-name",
] as const satisfies readonly PlacementIneligibilityReason[];
export type AdvancedIneligibility =
	(typeof ADVANCED_INELIGIBILITY_REASONS)[number];

export interface PlacementIneligibility {
	readonly reason: PlacementIneligibilityReason;
	/** Which condition the reason is about, where it is about one: the form's
	 *  open condition, its close condition, or the operation's own. */
	readonly condition?: "open" | "close" | "operation";
}
