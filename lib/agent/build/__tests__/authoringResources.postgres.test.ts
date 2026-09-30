import { expect, it } from "vitest";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import { type ArchitectLoopArgs, runArchitectLoop } from "../architectLoop";
import { AuthoringSession } from "../authoringSession";
import { architectToolDefinitions } from "../authoringTools";

const h = setupAppStateTestDb("authoring_resources_", {
	authSchema: "migrated",
});

it("discovers place creation before birth, refuses early effects, then creates and assigns a saved Preview place", async () => {
	const actorUserId = "architect",
		projectId = "resource-project",
		runId = "resource-run";
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const claim = await createAndClaimDesignSessionRun({
		projectId,
		actorUserId,
		runId,
		cost: 1,
	});
	const authority = {
		actorUserId,
		projectId,
		runId,
		holderNonce: claim.holderNonce,
		sessionId: claim.designSessionId,
	};
	await writeAppPlan({
		authority,
		writer: { editor: "architect" },
		requestId: "plan",
		expectedRevision: 0,
		change: {
			markdown:
				"Collect a visit report. Give the Preview worker a clearly named test venue.",
		},
	});
	const review = await beginPlanReview(authority, "peer");
	await finishPlanReview(authority, review.reviewId);
	const session = new AuthoringSession(
		authority,
		claim.proposedAppId,
		() => {},
	);
	await session.ensureWorkspace();
	const definitions = architectToolDefinitions({
		role: "architect",
		building: true,
		hasApp: false,
	});
	const levelUuid = "ff52ac5c-e0f0-4a0c-bd9b-94c90b07ac51";
	const personaUuid = "ff52ac5c-e0f0-4a0c-bd9b-94c90b07ac52";
	const place = { levelUuid, name: "Preview venue", expectedRevision: "0" };
	expect(definitions.createLocation).toBeDefined();
	expect(
		architectToolDefinitions({ role: "peer", building: true, hasApp: true })
			.createLocation,
	).toBeUndefined();
	const call = (toolName: string, input: unknown, toolCallId = toolName) =>
		session.shared({ toolName, toolCallId, input }, "architect");
	expect(await call("createLocation", place, "too-early")).toMatchObject({
		error: expect.any(String),
	});
	expect(
		await call("startAppTest", { purpose: "Enter the app" }, "test-too-early"),
	).toMatchObject({ error: expect.any(String) });
	for (const role of ["architect", "peer"] as const)
		expect(
			await session.shared(
				{ toolName: "readAppTest", toolCallId: `history-${role}`, input: {} },
				role,
			),
		).toMatchObject({ error: expect.any(String) });
	expect(await call("createModule", { name: "Visits" })).not.toHaveProperty(
		"error",
	);
	expect(
		await call("createForm", {
			moduleUuid: "Visits",
			name: "Visit",
			type: "survey",
		}),
	).not.toHaveProperty("error");
	expect(
		await call("addFields", {
			formUuid: "Visit",
			fields: [{ kind: "text", id: "note", label: "Note" }],
		}),
	).not.toHaveProperty("error");
	expect(
		await call("addOrganizationLevels", {
			levels: [
				{
					uuid: levelUuid,
					code: "venue",
					name: "Venue",
					description: "Shared venue",
					caseFlow: {
						workers: "assigned",
						ownsCases: true,
						descendantCases: { kind: "none" },
					},
					addressBook: { reach: "own-branch" },
				},
			],
		}),
	).not.toHaveProperty("error");
	expect(
		await call("addPersonas", {
			personas: [{ personaUuid, name: "Preview worker" }],
		}),
	).not.toHaveProperty("error");
	const birthRevision = (await session.getWork()).revision;
	if (!birthRevision) throw new Error("Private birth work has no revision");
	const birth = await session.saveWork("birth", birthRevision);
	expect(birth).toMatchObject({ saved: true });
	const before = (await call("getOrganization", {})) as {
		revision: string;
		locations: unknown[];
	};
	expect(before.locations).toEqual([]);
	expect(
		await call("createLocation", {
			...place,
			expectedRevision: before.revision,
		}),
	).not.toHaveProperty("error");
	const after = (await call("getOrganization", {})) as {
		revision: string;
		locations: { id: string; name: string }[];
	};
	expect(after.locations).toEqual([
		expect.objectContaining({ name: "Preview venue" }),
	]);
	const savedPlace = after.locations[0];
	if (!savedPlace) throw new Error("Place creation returned no saved place");
	expect(
		await call("updatePersona", {
			uuid: personaUuid,
			locationUuids: [savedPlace.id],
		}),
	).not.toHaveProperty("error");
	const assignmentRevision = (await session.getWork()).revision;
	// Reading retained evidence does not require the new private assignment to save.
	expect(await call("readAppTest", {})).not.toHaveProperty("error");
	if (!assignmentRevision)
		throw new Error("Private assignment has no revision");
	const assignment = await session.saveWork("assignment", assignmentRevision);
	expect(assignment).toMatchObject({ saved: true });
	// Exact call identities still refer to their original checkpoint after later saves.
	expect(await session.saveWork("birth", birthRevision)).toEqual(birth);
	expect(await session.saveWork("assignment", assignmentRevision)).toEqual(
		assignment,
	);
	expect(await call("createModule", { name: "Visits" })).toMatchObject({
		saved: false,
	});
	expect((await session.getWork()).pendingChanges).toBe(0);
	const users = await call("getUsers", {});
	expect(users).toMatchObject({
		personas: [
			expect.objectContaining({
				uuid: personaUuid,
				locationUuids: [savedPlace.id],
			}),
		],
	});
});

it("settles a persisted prebirth journey read before buying another peer response", async () => {
	const actorUserId = "reviewer";
	const projectId = "prebirth-project";
	const runId = "prebirth-run";
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const claim = await createAndClaimDesignSessionRun({
		projectId,
		actorUserId,
		runId,
		cost: 1,
	});
	const authority = {
		actorUserId,
		projectId,
		runId,
		sessionId: claim.designSessionId,
		holderNonce: claim.holderNonce,
	};
	let session = new AuthoringSession(authority, claim.proposedAppId, () => {});
	let responses = 0;
	let interrupt = true;
	const args: ArchitectLoopArgs = {
		spec: {
			designSessionId: claim.designSessionId,
			kind: "peer",
			modelId: "test-peer",
			promptVersion: "test-v1",
			contextVersion: "plan-review",
			toolsetDigest: "0".repeat(64),
			authority: {
				actorUserId,
				expectedProjectId: projectId,
				runId,
				holderNonce: claim.holderNonce,
			},
		},
		system: "Review the plan.",
		turnId: "review",
		maxSteps: 3,
		signal: new AbortController().signal,
		additions: [],
		tools: () =>
			architectToolDefinitions({
				role: "peer",
				building: false,
				hasApp: false,
			}),
		modelStep: async ({ messages }) => {
			responses++;
			if (responses > 1) {
				const receipts = messages.flatMap((message) =>
					message.role === "tool"
						? message.content.filter((part) => part.type === "tool-result")
						: [],
				);
				expect(receipts).toHaveLength(1);
				expect(receipts[0]).toMatchObject({
					toolCallId: "prebirth-history",
					toolName: "readAppTest",
				});
				const output = receipts[0]?.output;
				if (output?.type !== "text") throw new Error("Missing history refusal");
				expect(JSON.parse(output.value)).toMatchObject({
					error: expect.any(String),
				});
			}
			return {
				text: responses === 1 ? "" : "The plan is ready to build.",
				toolCalls: [],
				usage: {
					inputTokens: 1,
					outputTokens: 1,
					totalTokens: 2,
					inputTokenDetails: {
						noCacheTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
				},
				responseMessages:
					responses === 1
						? [
								{
									role: "assistant",
									content: [
										{
											type: "tool-call",
											toolCallId: "prebirth-history",
											toolName: "readAppTest",
											input: {},
										},
									],
								},
							]
						: [{ role: "assistant", content: "The plan is ready to build." }],
			};
		},
		dispatch: async (call) => ({
			kind: "result",
			output: await session.shared(call, "peer"),
		}),
		onStep: async () => {
			if (interrupt) {
				interrupt = false;
				throw new Error("Process stopped after response persistence");
			}
		},
		onRecoveredUsage: () => {},
		onFinish: async () => ({ kind: "complete" }),
	};
	await expect(runArchitectLoop(args)).rejects.toThrow(
		"Process stopped after response persistence",
	);
	expect(responses).toBe(1);
	session = new AuthoringSession(authority, claim.proposedAppId, () => {});
	await expect(runArchitectLoop(args)).resolves.toMatchObject({
		kind: "complete",
	});
	expect(responses).toBe(2);
	expect(
		await h.db().selectFrom("app_test_sessions").select("id").execute(),
	).toEqual([]);
});
