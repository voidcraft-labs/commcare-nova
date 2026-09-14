import { z } from "zod";
import {
	languageTagSchema,
	orderedCaseOperations,
	uuidSchema,
} from "@/lib/domain";
import {
	evaluateForm,
	FormEvaluationInputError,
} from "@/lib/preview/engine/evaluateForm";
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
			.array(
				z.object({ path: pathSchema, value: z.string().max(10000) }).strict(),
			)
			.max(500)
			.describe("Applied in order. Repeat a path to check changing an answer."),
		repeats: z
			.array(
				z
					.object({ path: pathSchema, count: z.number().int().min(1).max(30) })
					.strict(),
			)
			.max(50)
			.optional()
			.describe("Row counts for user-controlled repeats, if needed."),
		caseIds: z
			.array(z.string().min(1))
			.max(100)
			.optional()
			.describe("Existing records selected for a follow-up or close form."),
		personaUuid: uuidSchema
			.optional()
			.describe("Worker to evaluate as. Defaults to the current member."),
		searchAnswers: z
			.array(z.object({ name: z.string(), value: z.string() }).strict())
			.max(100)
			.optional()
			.describe(
				"Values from the preceding Search. Date ranges use name:from and name:to.",
			),
		language: languageTagSchema.optional(),
	})
	.strict();

export const evaluateFormTool = {
	description:
		"Run a form with supplied answers using Preview's engine and the worker's actual records and lookup data. Returns validation, question state and proposed case values. Saves nothing; capture, case operations and submission checks require the running app.",
	inputSchema: evaluateFormInputSchema,
	async execute(
		input: z.infer<typeof evaluateFormInputSchema>,
		ctx: ToolInvocationContext,
	) {
		const address = resolveFormAddress(ctx.snapshot.doc, input);
		if (!address.ok)
			return { kind: "read" as const, data: { error: address.error } };
		try {
			const context = await loadFormEvaluationContext(ctx, input.personaUuid);
			const result = await evaluateForm(ctx.snapshot.doc, input, context);
			const { submission, ...observation } = result;
			const proposedValues = submission && {
				kind: submission.kind,
				...(submission.kind === "registration"
					? { primary: submission.primary }
					: {}),
				...(submission.kind === "followup" || submission.kind === "close"
					? { caseIds: submission.caseIds, patch: submission.patch }
					: {}),
				...(submission.kind !== "survey" && submission.children.length
					? { children: submission.children }
					: {}),
				...(submission.usercase ? { worker: submission.usercase } : {}),
				...(submission.closeConditionAnswers
					? { closeCondition: "not-evaluated" as const }
					: {}),
				...(orderedCaseOperations(ctx.snapshot.doc.forms[input.formUuid]).length
					? { caseOperations: "not-evaluated" as const }
					: {}),
			};
			return {
				kind: "read" as const,
				data: {
					mode: "evaluation" as const,
					workspaceRevision: ctx.snapshot.revision,
					workerId: context.identity.ownerId,
					lookupRevision: context.lookup.projectRevision,
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
					},
				};
			throw error;
		}
	},
};
