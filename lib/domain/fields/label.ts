// A worker message and its answer at this point in the form.
// Android confirms passive messages on leaving their screen and lets the
// worker check an interactive one. Web Apps submits OK for either.

import tablerTag from "@iconify-icons/tabler/tag";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { displaySchemas } from "../questionDisplaySchemas";
import { checkedInputFieldBaseSchema } from "./base";

export const labelFieldSchema = checkedInputFieldBaseSchema.extend({
	kind: z.literal("label"),
	banner: displaySchemas.banner.optional(),
	selectableText: displaySchemas.selectableText.optional(),
	/** The worker may check this prompt on Android. Web Apps confirms it on submit. */
	askForConfirmation: z.literal(true).optional(),
});

export type LabelField = z.infer<typeof labelFieldSchema>;

export const labelFieldMetadata: FieldKindMetadata<"label"> = {
	kind: "label",
	xformKind: "trigger",
	dataType: "",
	icon: tablerTag,
	label: "Label",
	isStructural: false,
	isContainer: false,
	carriesValidation: true,
	saDocs:
		"A message for the worker. Set askForConfirmation for an Android checkbox. Web Apps confirms the message when the worker submits.",
	convertTargets: [],
};
