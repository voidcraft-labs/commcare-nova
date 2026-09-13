/** An isolated comparison surface. Canonical tools still validate every input. */
import { z } from "zod";
import {
	caseTypeRecordSchema,
	closeConditionInputSchema,
} from "@/lib/agent/planningSchemas";
import {
	addFieldsItemSchema,
	editFieldUpdatesSchema,
} from "@/lib/agent/toolSchemas";
import { columnInputSchema } from "@/lib/agent/tools/case-list-config/shared";
import { createFormInputSchema } from "@/lib/agent/tools/createForm";
import { createModuleInputSchema } from "@/lib/agent/tools/createModule";
import { updateFormInputSchema } from "@/lib/agent/tools/updateForm";
import { simpleScalarSearchInputSchema } from "@/lib/domain/modules";
import { expressionSchema, referenceSchema, textSchema } from "./values";

const optionalText = textSchema.nullable().optional();
const optionalExpression = expressionSchema.nullable().optional();
const option = z
	.object({
		value: z.string().min(1),
		label: textSchema,
	})
	.strict();
const optionsSource = z
	.object({
		kind: z.literal("inline"),
		options: z.array(option).min(2),
	})
	.strict()
	.nullable()
	.optional();

const content = {
	label: optionalText,
	hint: optionalText,
	help: optionalText,
	required: optionalExpression,
	relevant: optionalExpression,
	calculate: optionalExpression,
	default_value: optionalExpression,
	validate: z
		.object({ expr: expressionSchema, msg: textSchema.optional() })
		.strict()
		.nullable()
		.optional(),
	optionsSource,
	caseWrite: addFieldsItemSchema.shape.caseWrite
		.unwrap()
		.unwrap()
		.omit({ mode: true })
		.nullable()
		.optional(),
};

export const fieldSchema = z
	.object({
		...addFieldsItemSchema.shape,
		...content,
		kind: z.enum([
			"text",
			"int",
			"decimal",
			"date",
			"time",
			"datetime",
			"single_select",
			"multi_select",
			"label",
			"group",
			"repeat",
			"hidden",
		]),
		repeat: z
			.object({ mode: z.literal("user_controlled") })
			.strict()
			.nullable()
			.optional(),
		parent: referenceSchema.optional(),
	})
	.omit({ fieldUuid: true, parentUuid: true })
	.strict();

const property = caseTypeRecordSchema.shape.properties.element;
const record = z
	.object({
		...caseTypeRecordSchema.shape,
		properties: z
			.array(
				z
					.object({
						name: property.shape.name,
						label: textSchema,
						data_type: property.shape.data_type,
						options: z.array(option).nullable().optional(),
					})
					.strict(),
			)
			.min(1),
	})
	.strict();

// This comparison exercises ordinary Results columns. Recursive list rules,
// lookup sources, media, and advanced configuration need separate cases before
// this interface can replace the full authoring surface.
const plainColumn = columnInputSchema.options[0];
const column = plainColumn.omit({ columnUuid: true });
const closeCondition = z
	.object({ ...closeConditionInputSchema.shape, field: referenceSchema })
	.omit({ fieldUuid: true })
	.strict()
	.nullable()
	.optional();
const existingForm = createModuleInputSchema.shape.forms
	.unwrap()
	.unwrap().element;
const form = z
	.object({
		...existingForm.shape,
		close_condition: closeCondition,
		fields: z.array(fieldSchema).min(1),
	})
	.omit({ formUuid: true })
	.strict();

export const pilotSchemas = {
	declareRecords: z.object({ caseTypes: z.array(record).min(1) }).strict(),
	createModule: z
		.object({
			...createModuleInputSchema.shape,
			parentModuleUuid: referenceSchema.optional(),
			forms: z.array(form).nullable().optional(),
			case_list_columns: z.array(column).nullable().optional(),
		})
		.omit({ moduleUuid: true })
		.strict(),
	createForm: z
		.object({
			...createFormInputSchema.shape,
			close_condition: closeCondition,
			fields: z.array(fieldSchema).min(1),
		})
		.omit({ formUuid: true, entry: true, carry_search_answers: true })
		.strict(),
	addFields: z
		.object({ formUuid: referenceSchema, fields: z.array(fieldSchema).min(1) })
		.strict(),
	editField: z
		.object({
			fieldUuid: referenceSchema,
			updates: z
				.object({
					...editFieldUpdatesSchema.shape,
					...content,
					kind: fieldSchema.shape.kind.optional(),
					repeat: fieldSchema.shape.repeat.unwrap().unwrap().optional(),
					optionsSource: optionsSource.unwrap().unwrap().optional(),
				})
				.strict(),
			confirmConversion: z.boolean().optional(),
		})
		.strict(),
	updateForm: updateFormInputSchema
		.pick({
			formUuid: true,
			name: true,
			post_submit: true,
		})
		.extend({ close_condition: closeCondition }),
	addSearchInputs: z
		.object({
			moduleUuid: referenceSchema,
			searchInputs: z
				.array(
					simpleScalarSearchInputSchema.omit({
						uuid: true,
						required: true,
						validation: true,
						default: true,
						via: true,
					}),
				)
				.min(1),
		})
		.strict(),
	inspect: z.object({ uuid: referenceSchema.optional() }).strict(),
};

export type PilotOperation = keyof typeof pilotSchemas;

export const PILOT_DESCRIPTIONS: Record<PilotOperation, string> = {
	declareRecords:
		"Declare the records this app tracks and their properties. case_name is the display name; forms choose when each answer is required.",
	createModule:
		"Create a menu with complete forms and fields in one atomic change. Case workflows also need a visible case_name Results column.",
	createForm:
		"Add a complete form to an existing menu. Registration creates a record; followup updates one; close closes one; survey stands alone.",
	addFields:
		"Add fields to a form in one atomic change. Parents precede their children.",
	editField:
		"Edit one field. Omission keeps a value; null clears it. Supply kind only to convert the field. Saved-data loss requires the user's consent.",
	updateForm:
		"Update a form's workflow settings. Omitted settings remain unchanged.",
	addSearchInputs:
		"Add questions workers can use to find records in this menu. Text searches can match names approximately with mode {kind: 'fuzzy'}.",
	inspect:
		"Read the app overview, or a module, form, or field by UUID. A form includes its full field tree.",
};
