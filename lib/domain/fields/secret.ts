// lib/domain/fields/secret.ts
//
// Sensitive single-line string input (passwords, PINs). Maps to CommCare
// <input> with xsd:string type. Intentionally omits `calculate` — computed
// secrets don't make semantic sense and would expose derived values in the
// instance model in plain text.

import tablerLock from "@iconify-icons/tabler/lock";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	formLogicSchema,
	inputFieldBaseSchema,
	proseTemplateSchema,
} from "./base";

export const secretFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("secret"),
	validate: formLogicSchema.optional(),
	validate_msg: proseTemplateSchema.optional(),
	default_value: formLogicSchema.optional(),
});

export type SecretField = z.infer<typeof secretFieldSchema>;

export const secretFieldMetadata: FieldKindMetadata<"secret"> = {
	kind: "secret",
	xformKind: "input",
	dataType: "xsd:string",
	icon: tablerLock,
	label: "Secret",
	isStructural: false,
	isContainer: false,
	carriesValidation: true,
	saDocs: "Sensitive input (password, PIN).",
	convertTargets: ["text"],
};
