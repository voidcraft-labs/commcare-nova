import { z } from "zod";
import {
	languageTagSchema,
	orderedCaseOperations,
	uuidSchema,
} from "@/lib/domain";
import { PLATFORMS } from "@/lib/domain/platforms";
import {
	evaluateForm,
	FormEvaluationInputError,
	FormRefusedError,
} from "@/lib/preview/engine/evaluateForm";
import { evaluationScenarioSchema } from "@/lib/preview/engine/evaluationScenario";
import { formAnswerValueSchema } from "@/lib/preview/engine/formAnswerValue";
import { loadFormEvaluationContext } from "../authoring/evaluationContext";
import type { ToolInvocationContext } from "../workspace/types";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";

const pathSchema = z
	.string()
	.min(1)
	.max(1000)
	.describe(
		"Question path, such as borrower or visits[0]/date. Repeat indices start at zero.",
	);
export const evaluateFormInputSchema = formAddressSchema
	.extend({
		answers: z
			.array(z.strictObject({ path: pathSchema, value: formAnswerValueSchema }))
			.max(500)
			.describe(
				"Applied in order, entering each answer’s section first. Repeat a path to check changing an answer. Use an app test for page navigation and its validation.",
			),
		repeats: z
			.array(
				z.strictObject({
					path: pathSchema,
					count: z.number().int().min(0).max(30),
				}),
			)
			.max(50)
			.optional()
			.describe(
				"How many entries to add to each worker-controlled repeating group. A new group starts empty. Use zero to clear an existing group.",
			),
		caseIds: z
			.array(z.string().min(1))
			.max(100)
			.optional()
			.describe(
				"Records selected for a follow-up or close form. Use supplied IDs when evaluating a scenario.",
			),
		openingRecords: z
			.array(
				z.strictObject({
					name: z
						.string()
						.min(1)
						.describe("The opening record's name, as getForm lists it."),
					caseId: z.string().min(1),
				}),
			)
			.max(20)
			.optional()
			.describe(
				"For a form whose openingChoicesFrom is form: the record for each opening record the worker chooses from a list. Use instead of caseIds.",
			),
		scenario: evaluationScenarioSchema.optional(),
		personaUuid: uuidSchema
			.optional()
			.describe("Worker to evaluate as. Defaults to the current member."),
		searchAnswers: z
			.array(z.strictObject({ name: z.string(), value: z.string() }))
			.max(100)
			.optional()
			.describe(
				"Values from the preceding Search, by visible Search field name. Date ranges use name:from and name:to. On Web Apps, a field the worker also searched for blank adds name:blank, set to true; Android's Search screen has no such box. Hidden values are worked out by the search, so leave them out.",
			),
		language: languageTagSchema.optional(),
		platform: z
			.enum(PLATFORMS)
			.optional()
			.describe(
				"Where to run the form: web-apps or android, a platform the app runs on. Omit to use Web Apps when the app runs on both, or its only platform.",
			),
	})
	.strict();

export const evaluateFormTool = {
	description:
		"Run a form using Preview's engine. Supply test records in scenario to check a new app or a specific failure; otherwise use the worker's actual records. Lookup data remains real. Returns validation, question participation and proposed case values. Session values and when calculations re-run follow the platform. Excluded questions may retain an answer, but that is not a submitted value. Saves nothing; capture, case operations and submission checks require the running app.",
	inputSchema: evaluateFormInputSchema,
	async execute(
		input: z.infer<typeof evaluateFormInputSchema>,
		ctx: ToolInvocationContext,
	) {
		const address = resolveFormAddress(ctx.snapshot.doc, input);
		if (!address.ok)
			return { kind: "read" as const, data: { error: address.error } };
		try {
			const context = await loadFormEvaluationContext(
				ctx,
				input.personaUuid,
				input.scenario,
				input,
				input.platform,
			);
			const result = await evaluateForm(ctx.snapshot.doc, input, context);
			const { submission, ...observation } = result;
			// Every case change the form makes, its own case included, is a
			// case operation the running app evaluates at submission.
			const proposedValues = submission && {
				kind: submission.kind,
				...(submission.kind === "followup" || submission.kind === "close"
					? { caseIds: submission.caseIds }
					: {}),
				...(orderedCaseOperations(ctx.snapshot.doc.forms[input.formUuid]).length
					? { caseOperations: "not-evaluated" as const }
					: {}),
			};
			return {
				kind: "read" as const,
				data: {
					mode: input.scenario
						? ("scenario" as const)
						: ("evaluation" as const),
					workspaceRevision: ctx.snapshot.revision,
					workerId: context.identity.ownerId,
					lookupRevision: context.lookup.projectRevision,
					// What the search before the form found, when the form reads it.
					...(context.searchResults === undefined
						? {}
						: {
								searchResults: {
									matched: context.searchResults.totalMatches,
									held: context.searchResults.rows.length,
								},
							}),
					...observation,
					...(proposedValues ? { proposedValues } : {}),
				},
			};
		} catch (error) {
			if (error instanceof FormEvaluationInputError)
				return {
					kind: "read" as const,
					data: {
						error: error.message,
						...(error.fault ? { fault: error.fault } : {}),
						...(error instanceof FormRefusedError
							? { refusal: error.refusal }
							: {}),
					},
				};
			throw error;
		}
	},
};
