import tablerClipboardCheck from "@iconify-icons/tabler/clipboard-check";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { uuidSchema } from "../uuid";
import { structuralFieldBase } from "./base";

/** The position of a case change in the submitted form. The operation holds
 * the change's effects and can also be edited from the form's case settings. */
export const caseChangeFieldSchema = structuralFieldBase.extend({
	kind: z.literal("case_change"),
	operationUuid: uuidSchema,
});

export type CaseChangeField = z.infer<typeof caseChangeFieldSchema>;

export const caseChangeFieldMetadata: FieldKindMetadata<"case_change"> = {
	kind: "case_change",
	xformKind: "data-only",
	dataType: "",
	icon: tablerClipboardCheck,
	label: "Case change",
	isStructural: false,
	isContainer: false,
	carriesValidation: false,
	saDocs: "Holds the place of an existing case change in the submitted form.",
	convertTargets: [],
};
