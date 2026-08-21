// lib/domain/fields/section.ts
//
// A section is one page of a form. It is a structural container like a
// group, but it carries no logic of its own (no `relevant`, no media on its
// title): a page is a place questions live, not a question. On the wire it
// is a data group whose body always carries `appearance="field-list"`,
// which is how every CommCare runtime that pages learns to put the
// section's questions on one screen. Sections live only at the form root,
// and a form that has one has nothing else at its root: the validator
// (`FORM_SECTION_NOT_TOP_LEVEL`, `FORM_SECTIONS_INCOMPLETE`,
// `FORM_SECTION_USER_REPEAT`) holds those three facts, the emitter never
// has to ask.
//
// The schema extends `structuralFieldBase` (`{ uuid, id }`, strict), so a
// section cannot carry `relevant`, `label_media`, `hint`, or anything else:
// "a page has no logic" is unrepresentable, not validated.

import tablerSection from "@iconify-icons/tabler/section";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { proseTemplateSchema } from "../prose";
import { structuralFieldBase } from "./base";

export const sectionFieldSchema = structuralFieldBase.extend({
	kind: z.literal("section"),
	/** The page title. Optional: an untitled page is still a page. */
	label: proseTemplateSchema.optional(),
});

export type SectionField = z.infer<typeof sectionFieldSchema>;

export const sectionFieldMetadata: FieldKindMetadata<"section"> = {
	kind: "section",
	xformKind: "group",
	dataType: "",
	icon: tablerSection,
	label: "Section",
	isStructural: true,
	isContainer: true,
	saDocs:
		"One page of a form. Sections live only at the form's top level, and once a form has one, every top-level field is a section (put questions inside them). A section carries a title and nothing else: no display condition, no media. On a phone each section is one screen: Next checks the section's answers, Back does not. A repeat whose entries the worker adds can't live inside a section; a repeat with a fixed count or a case query can.",
	convertTargets: [],
};
