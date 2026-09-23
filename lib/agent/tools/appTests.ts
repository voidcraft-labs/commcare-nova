import { z } from "zod";
import { listAppTests, readAppTestSteps } from "@/lib/db/appTests";
import { continueAppTest, startAppTest } from "@/lib/preview/app-tests/service";
import {
	appTestActionSchema,
	appTestStartSchema,
} from "@/lib/preview/app-tests/types";
import type { ToolInvocationContext } from "../workspace/types";

function scope(ctx: ToolInvocationContext) {
	if (!ctx.appId)
		throw new Error("Save the app before testing its worker journey.");
	return {
		appId: ctx.appId,
		actorUserId: ctx.userId,
		projectId: ctx.projectId,
	};
}
const testIdSchema = z
	.uuid()
	.describe("The test identity returned when the journey began.");

export const startAppTestTool = {
	description:
		"Start a worker journey at app entry using saved Preview identities and disposable records. Real records are never copied or changed. Supply only the test records and fictional places the journey needs. Continue through the visible menus, record selection, answers and submissions. Uses Preview and the production Postgres transaction path; does not establish native device, media capture or deployment readiness.",
	inputSchema: appTestStartSchema,
	async execute(
		input: z.infer<typeof appTestStartSchema>,
		ctx: ToolInvocationContext,
	) {
		const admitted = scope(ctx);
		if (ctx.snapshot.canonicalSeq === null)
			return {
				kind: "read" as const,
				data: { error: "Save or refresh the app before starting a journey." },
			};
		return {
			kind: "read" as const,
			data: await startAppTest(admitted, {
				requestId: ctx.invocation.requestId,
				expectedBlueprintSeq: ctx.snapshot.canonicalSeq,
				input,
			}),
		};
	},
};
const continueSchema = z.strictObject({
	testId: testIdSchema,
	expectedStep: z
		.number()
		.int()
		.min(0)
		.describe("The latest returned step; protects against competing actions."),
	action: appTestActionSchema,
});
export const continueAppTestTool = {
	description:
		"Take one worker action in a disposable app test. Choose only identities and destinations the saved app offers. A submission applies ordinary and additional case effects to isolated records, then opens the next task. Finish releases test records while retaining observations. Changed source apps require a new test.",
	inputSchema: continueSchema,
	async execute(
		input: z.infer<typeof continueSchema>,
		ctx: ToolInvocationContext,
	) {
		return {
			kind: "read" as const,
			data: await continueAppTest(scope(ctx), {
				...input,
				requestId: ctx.invocation.requestId,
			}),
		};
	},
};
const readSchema = z.strictObject({ testId: testIdSchema.optional() });
export const readAppTestTool = {
	description:
		"Omit testId to find this app's recent tests by purpose and source revision. Supply a returned identity to read its worker actions and observed results, including failed actions. Evidence remains after test records expire or are discarded. A completed test proves only its exercised behavior.",
	inputSchema: readSchema,
	async execute(input: z.infer<typeof readSchema>, ctx: ToolInvocationContext) {
		return {
			kind: "read" as const,
			data:
				input.testId === undefined
					? await listAppTests(scope(ctx))
					: await readAppTestSteps({ ...scope(ctx), testId: input.testId }),
		};
	},
};
