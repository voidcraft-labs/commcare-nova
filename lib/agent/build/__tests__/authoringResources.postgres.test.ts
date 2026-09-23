import { expect, it } from "vitest";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
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
	expect(
		await call("createModule", {
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [{ kind: "text", id: "note", label: "Note" }],
				},
			],
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
	expect(await session.saveWork("birth")).toMatchObject({ saved: true });
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
	expect(await session.saveWork("assignment")).toMatchObject({ saved: true });
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
