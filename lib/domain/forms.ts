// lib/domain/forms.ts
import { z } from "zod";
import { uuidSchema } from "./uuid";

export const FORM_TYPES = [
	"registration",
	"followup",
	"close",
	"survey",
] as const;
export type FormType = (typeof FORM_TYPES)[number];

export const CASE_FORM_TYPES: ReadonlySet<FormType> = new Set([
	"registration",
	"followup",
	"close",
]);

export const CASE_LOADING_FORM_TYPES: ReadonlySet<FormType> = new Set([
	"followup",
	"close",
]);

export const POST_SUBMIT_DESTINATIONS = [
	"app_home",
	"root",
	"module",
	"parent_module",
	"previous",
] as const;
export type PostSubmitDestination = (typeof POST_SUBMIT_DESTINATIONS)[number];

const closeConditionSchema = z.object({
	field: z.string(), // was `question` — renamed
	answer: z.string(),
	operator: z.enum(["=", "selected"]).optional(),
});

const formLinkDatumSchema = z.object({
	name: z.string(),
	xpath: z.string(),
});

const formLinkTargetSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("form"),
		moduleUuid: uuidSchema, // was moduleIndex
		formUuid: uuidSchema, // was formIndex
	}),
	z.object({
		type: z.literal("module"),
		moduleUuid: uuidSchema,
	}),
]);

const formLinkSchema = z.object({
	condition: z.string().optional(),
	target: formLinkTargetSchema,
	datums: z.array(formLinkDatumSchema).optional(),
});
export type FormLink = z.infer<typeof formLinkSchema>;

// Connect config — same shape as current lib/schemas/blueprint.ts.
const connectLearnModuleSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	description: z.string(),
	time_estimate: z.number().int().positive(),
});
const connectAssessmentSchema = z.object({
	id: z.string().optional(),
	user_score: z.string(),
});
const connectDeliverUnitSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	entity_id: z.string(),
	entity_name: z.string(),
});
const connectTaskSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	description: z.string(),
});
const connectConfigSchema = z.object({
	learn_module: connectLearnModuleSchema.optional(),
	assessment: connectAssessmentSchema.optional(),
	deliver_unit: connectDeliverUnitSchema.optional(),
	task: connectTaskSchema.optional(),
});
export type ConnectConfig = z.infer<typeof connectConfigSchema>;
export type ConnectLearnModule = z.infer<typeof connectLearnModuleSchema>;
export type ConnectAssessment = z.infer<typeof connectAssessmentSchema>;
export type ConnectDeliverUnit = z.infer<typeof connectDeliverUnitSchema>;
export type ConnectTask = z.infer<typeof connectTaskSchema>;

export const formSchema = z.object({
	uuid: uuidSchema,
	id: z.string(),
	name: z.string(),
	type: z.enum(FORM_TYPES),
	purpose: z.string().optional(),
	closeCondition: closeConditionSchema.optional(),
	connect: connectConfigSchema.nullable().optional(),
	postSubmit: z.enum(POST_SUBMIT_DESTINATIONS).optional(),
	formLinks: z.array(formLinkSchema).optional(),
});
export type Form = z.infer<typeof formSchema>;

export type FormKindMetadata = {
	icon: string;
	saDocs: string;
};
export const formMetadata: FormKindMetadata = {
	icon: "tabler:file-text",
	saDocs:
		"A form is a single data-collection surface within a module. Its type (registration/followup/close/survey) determines its case behavior.",
};
