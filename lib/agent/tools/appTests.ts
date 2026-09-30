import { z } from "zod";
import { prepareAuthoringInput } from "@/lib/agent/authoring/input";
import { listAppTests, readAppTestSteps } from "@/lib/db/appTests";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { appTestReadWindowSchema } from "@/lib/preview/app-tests/evidence";
import { continueAppTest, startAppTest } from "@/lib/preview/app-tests/service";
import {
	appTestActionSchema,
	appTestActionsSchema,
	appTestAuthoredActionSchema,
	appTestStartSchema,
} from "@/lib/preview/app-tests/types";
import type { ToolInvocationContext } from "../workspace/types";

function scope(ctx: ToolInvocationContext) {
	if (!ctx.appId) return null;
	return {
		appId: ctx.appId,
		actorUserId: ctx.userId,
		projectId: ctx.projectId,
	};
}
const unsavedApp = {
	kind: "read" as const,
	data: {
		error:
			"Worker journeys need a saved app. You can begin after saving the first complete workflow.",
	},
};
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
		if (!admitted) return unsavedApp;
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
	action: appTestAuthoredActionSchema
		.optional()
		.describe(
			"Compatibility form for one action. Supply either action or actions.",
		),
	actions: appTestActionsSchema.optional(),
});
// The pre-batch shared boundary normalized named references through this
// UUID-shaped singular schema before hashing. Keep its exact preparation for
// old receipt verification only, against the authorized pinned test document.
const legacyContinueSchema = z.strictObject({
	testId: testIdSchema,
	expectedStep: z.number().int().min(0),
	action: appTestActionSchema,
});

export const continueAppTestTool = {
	description:
		"Take up to eight ordered worker actions in a disposable app test using actions. Each returns its own step and observation; the call stops on a refusal or unmet optional expectation, retaining its completed prefix. Choose only identities and destinations the saved app offers. Selecting a record opens its Details when configured; use continue there to enter the task, or back to return. Form observations offer sections; use section to turn a page before answering its questions. Forward turns validate earlier pages. A submission applies ordinary and additional case effects to isolated records, then opens the next task. Finish releases test records while retaining observations. Changed source apps require a new test.",
	inputSchema: continueSchema,
	async execute(
		input: z.infer<typeof continueSchema>,
		ctx: ToolInvocationContext,
	) {
		const admitted = scope(ctx);
		if (!admitted) return unsavedApp;
		return {
			kind: "read" as const,
			data: await continueAppTest(admitted, {
				...input,
				requestId: ctx.invocation.requestId,
				legacyAction:
					input.action === undefined
						? undefined
						: async (snapshot) => {
								const prepared = await prepareAuthoringInput({
									toolName: "continueAppTest",
									schema: legacyContinueSchema,
									input: {
										testId: input.testId,
										expectedStep: input.expectedStep,
										action: input.action,
									},
									ctx: {
										...ctx,
										snapshot: {
											...ctx.snapshot,
											doc: hydratePersistedBlueprint(snapshot.blueprint),
										},
									},
								});
								return prepared.action;
							},
			}),
		};
	},
};
const readSchema = appTestReadWindowSchema.extend({
	testId: testIdSchema.optional(),
});
export const readAppTestTool = {
	description:
		"Omit testId to find this app's recent tests by purpose and source revision. Supply a returned identity to read a bounded page of actions and observations, including failures. Follow nextCursor with its fixed throughStep to keep the same evidence window. Oversized steps return an inspection address: use inspect with the returned step/path and nextOffset to read all retained evidence without truncation. Evidence remains after test records expire or are discarded. A completed test proves only its exercised behavior.",
	inputSchema: readSchema,
	async execute(input: z.infer<typeof readSchema>, ctx: ToolInvocationContext) {
		const admitted = scope(ctx);
		if (!admitted) return unsavedApp;
		return {
			kind: "read" as const,
			data:
				input.testId === undefined
					? await listAppTests(admitted)
					: await readAppTestSteps({
							...admitted,
							...input,
							testId: input.testId,
						}),
		};
	},
};
