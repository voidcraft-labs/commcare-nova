/**
 * SA tool input schemas, generated from the field registry.
 *
 * This file exists so consumers (the Solutions Architect, test-schema.ts,
 * callers that want a pre-materialized JSON schema via `.jsonSchema`)
 * import stable named values rather than reaching into the generator.
 *
 * The named shapes here (`addQuestionsSchema`, `addQuestionsQuestionSchema`,
 * `addQuestionQuestionSchema`, `editQuestionUpdatesSchema`) match the names
 * the old hand-written `lib/schemas/toolSchemas.ts` exported — drop-in for
 * every consumer.
 */

import { z } from "zod";
import { generateToolSchemas } from "./toolSchemaGenerator";

const generated = generateToolSchemas("flat-sentinels");

export const addQuestionsQuestionSchema = generated.addQuestionsQuestionSchema;
export const addQuestionQuestionSchema = generated.addQuestionQuestionSchema;
export const editQuestionUpdatesSchema = generated.editQuestionUpdatesSchema;

/**
 * Full `addQuestions` input schema — wraps the question array with module
 * and form indices. Matches the shape of the hand-written export.
 */
export const addQuestionsSchema = {
	schema: z.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		questions: z.array(addQuestionsQuestionSchema),
	}),
	/** Pre-computed JSON schema for scripts/test-schema.ts size checks. */
	get jsonSchema() {
		return z.toJSONSchema(this.schema);
	},
};
