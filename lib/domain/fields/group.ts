// lib/domain/fields/group.ts
//
// Structural container that groups a set of child fields under one visual
// header. Groups collapse and re-appear together based on their `relevant`
// condition — no child field needs its own relevant when the group controls
// visibility at the container level. Maps to CommCare <group> control.
//
// Groups do not write to the case — they have no case_property, hint, or
// required fields. Only `relevant` is meaningful at the group level.
//
// **Empty-label groups are transparent at runtime.** Groups extend
// `containerFieldBase` (label optional) rather than `fieldBaseSchema`
// (label required). A non-empty label renders visible chrome (section
// header, collapse, nesting frame); an empty/absent label renders
// structure-only with no visual impact — mirroring CommCare's behavior
// for `<group>` elements without a `<label>`. The Nova preview matches
// this in `InteractiveFormRenderer`; edit-mode rendering still surfaces
// empty-labeled groups via `VirtualFormList` → `GroupBracket` so authors
// can select and edit them. One application is disambiguating two
// hidden fields that share an id (because field id = case property
// name) — wrapping each in its own empty-label group makes them
// cousins instead of siblings, which CommCare allows.

import tablerFolder from "@iconify-icons/tabler/folder";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { containerFieldBase } from "./base";

export const groupFieldSchema = containerFieldBase.extend({
	kind: z.literal("group"),
	relevant: z.string().optional(),
});

export type GroupField = z.infer<typeof groupFieldSchema>;

export const groupFieldMetadata: FieldKindMetadata<"group"> = {
	kind: "group",
	xformKind: "group",
	dataType: "",
	icon: tablerFolder,
	label: "Group",
	isStructural: true,
	isContainer: true,
	saDocs:
		"Groups a set of fields under one visual header. Contents collapse and re-appear together. Leave the label empty to make the group transparent (invisible at runtime) — useful for disambiguating two hidden fields that share an id by giving them different parents.",
	convertTargets: ["repeat"],
};
