// lib/domain/fields/group.ts
//
// Structural container that groups a set of child fields under one visual
// header. Groups collapse and re-appear together based on their `relevant`
// condition — no child field needs its own relevant when the group controls
// visibility at the container level. Maps to CommCare <group> control.
//
// Groups have no answer of their own, so no case operation saves one,
// and they carry no hint or required. Only `relevant` is meaningful at
// the group level.
//
// **`fieldList` decides the one-screen layout, not the label.** A group
// holding `fieldList: true` shows its questions together on one screen on
// Android (`appearance="field-list"` on the wire); without it the app shows
// them one per screen. A label shows a header and nothing more.
// `groupBornFieldList` is the one birth rule every surface that makes a
// group reads: a new group takes the flag when its label has text and it
// holds no repeat workers add entries to, since the CommCare app can't add
// repeat entries on a shared screen. No later edit changes the flag.
//
// **Empty-label groups are transparent at runtime.** Groups extend
// `containerFieldBase` (label optional) rather than `fieldBaseSchema`
// (label required). A non-empty label renders visible chrome (section
// header, collapse, nesting frame); an empty/absent label renders
// structure-only with no visual impact — mirroring CommCare's behavior
// for `<group>` elements without a `<label>`. An unlabelled group is born
// without `fieldList`, so it stays a transparent wrapper. The Nova preview
// matches this in `InteractiveFormRenderer`; edit-mode rendering still
// surfaces empty-labeled groups via `VirtualFormList` → `GroupBracket` so
// authors can select and edit them. Empty-label groups are a residual
// layout affordance — a place for stray hidden fields that don't fit any
// labeled group. Logical case-scoped grouping (every child field's answer
// saved to the case the group is about) is the primary organization
// pattern; empty-label groups are not a primary disambiguation tool.

import tablerFolder from "@iconify-icons/tabler/folder";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { type ProseTemplate, proseTemplateIsEmpty } from "../prose";
import { containerFieldBase, formLogicSchema } from "./base";

export const groupFieldSchema = containerFieldBase.extend({
	kind: z.literal("group"),
	relevant: formLogicSchema.optional(),
	/** Shows the group's questions together on one screen on Android. Absent: one per screen. */
	fieldList: z.literal(true).optional(),
});

export type GroupField = z.infer<typeof groupFieldSchema>;

/**
 * The `fieldList` a new group is born with: `true` when its label has text
 * and it holds no repeat workers add entries to (at any depth), otherwise
 * absent. A label-less group stays a transparent wrapper, and a group
 * holding a user-controlled repeat shows one question per screen, because
 * the CommCare app can't add repeat entries on a shared screen.
 */
export function groupBornFieldList(input: {
	label?: ProseTemplate;
	holdsUserRepeat: boolean;
}): true | undefined {
	return !proseTemplateIsEmpty(input.label) && !input.holdsUserRepeat
		? true
		: undefined;
}

export const groupFieldMetadata: FieldKindMetadata<"group"> = {
	kind: "group",
	xformKind: "group",
	dataType: "",
	icon: tablerFolder,
	label: "Group",
	isStructural: true,
	isContainer: true,
	carriesValidation: false,
	saDocs:
		"Groups a set of fields under one visual header. Contents collapse and re-appear together. Use logical case-scoped groups (every child field's answer is saved to the case the group is about) as the primary organization pattern. Leave the label empty to make the group transparent (invisible at runtime), a residual layout option for stray hidden fields that don't fit any labeled group, not a primary disambiguation tool.",
	convertTargets: ["repeat"],
};
