import { z } from "zod";

const simpleLayouts = [
	"dropdown",
	"row",
	"row-without-label",
	"headings",
] as const;
const gridColumns = z.number().int().min(1).max(2_147_483_647);
export const choiceMatchRules = [
	"multiword",
	"fuzzy",
	"android-multiword",
	"android-fuzzy",
] as const;

// When the two readers choose different controls, keep the effective controls
// and their parameters. The wire boundary verifies that the pair can be written.
const ordinary = z.strictObject({ kind: z.literal("ordinary") });
const webBasic = z.strictObject({
	kind: z.literal(["ordinary", "dropdown", "headings", "row-without-label"]),
});
const search = z.strictObject({
	kind: z.literal("search"),
	matchWords: z.enum(["fuzzy", "multiword"]).optional(),
});
const multiGrid = z.strictObject({
	kind: z.literal("grid"),
	columns: gridColumns.optional(),
});
const singleGrid = multiGrid.extend({
	advanceOnChoice: z.literal(true).optional(),
});
const multiPlatformLayout = z.strictObject({
	kind: z.literal("platforms"),
	web: webBasic,
	android: z.discriminatedUnion("kind", [ordinary, multiGrid]),
});
const singlePlatformLayout = z.strictObject({
	kind: z.literal("platforms"),
	web: z.discriminatedUnion("kind", [
		webBasic,
		search,
		z.strictObject({ kind: z.literal("buttons") }),
	]),
	android: z.discriminatedUnion("kind", [ordinary, singleGrid, search]),
});

export const multiChoiceLayoutSchema = z.discriminatedUnion("kind", [
	multiPlatformLayout,
	z.strictObject({ kind: z.literal(simpleLayouts) }),
	z.strictObject({ kind: z.literal("grid"), columns: gridColumns.optional() }),
]);
export const singleChoiceLayoutSchema = z.discriminatedUnion("kind", [
	singlePlatformLayout,
	z.strictObject({
		kind: z.literal([...simpleLayouts, "buttons", "advance-on-choice"]),
	}),
	z.strictObject({
		kind: z.literal("grid"),
		columns: gridColumns.optional(),
		advanceOnChoice: z.literal(true).optional(),
	}),
	z.strictObject({
		kind: z.literal("search"),
		matchWords: z.enum(choiceMatchRules).optional(),
	}),
]);
export type ChoiceLayout = z.infer<typeof singleChoiceLayoutSchema>;
export type MultiChoiceLayout = z.infer<typeof multiChoiceLayoutSchema>;

export const CHOICE_LAYOUT_LABELS: Readonly<
	Record<ChoiceLayout["kind"], string>
> = {
	platforms: "Different layouts by platform",
	dropdown: "Dropdown",
	grid: "Grid",
	row: "Table row",
	"row-without-label": "Table row without a label",
	headings: "Table headings",
	search: "Search box",
	buttons: "Cycling button",
	"advance-on-choice": "Advance after a choice",
};
