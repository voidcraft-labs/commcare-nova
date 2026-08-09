/** Required external actions are durable prerequisites, never plan prose. */

import { describe, expect, it } from "vitest";
import { did, makeBuildPlan } from "@/lib/agent/design/__tests__/fixtures";
import type { ExternalAction } from "@/lib/agent/design/buildPlan";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	assertRequiredExternalActionsSatisfied,
	ExternalActionRequiredError,
} from "../externalActions";

const h = setupAppStateTestDb("external_actions_");
const ACTOR = "owner-test";
const PROJECT = "project-test";

describe("assertRequiredExternalActionsSatisfied", () => {
	it("blocks before an attempt and accepts only digest-bound typed evidence", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			project_id: PROJECT,
		});
		const lineage = await h.seedDesignLineage({ existingSessionId: sessionId });
		const appId = await h.seedApp({ project_id: PROJECT });
		const plan = makeBuildPlan();
		plan.id = lineage.buildPlanId;
		const slice = plan.slices[1];
		if (slice === undefined) throw new Error("fixture has a later slice");
		const action: ExternalAction = {
			id: did(900),
			kind: "lookup-write",
			timing: "before-slice",
			requiredFor: "construction",
			description: "Load the approved facility catalog.",
			idempotencyOwner: "nova",
			completionEvidence: "The exact catalog import receipt.",
		};
		plan.externalActions = [action];
		slice.externalActionIds = [action.id];
		const check = () =>
			assertRequiredExternalActionsSatisfied({
				designSessionId: sessionId,
				projectId: PROJECT,
				appId,
				plan,
				slice,
			});

		await expect(check()).rejects.toBeInstanceOf(ExternalActionRequiredError);
		const receiptId = crypto.randomUUID();
		await h
			.db()
			.insertInto("design_external_action_receipts")
			.values({
				id: receiptId,
				design_session_id: sessionId,
				build_plan_id: plan.id,
				external_action_id: action.id,
				project_id: PROJECT,
				app_id: appId,
				action_digest: canonicalJsonDigest(action),
				outcome: "completed",
				evidence: JSON.stringify({
					kind: "user-confirmation",
					confirmationId: crypto.randomUUID(),
					confirmedByUserId: ACTOR,
				}),
			})
			.execute();
		await expect(check()).rejects.toBeInstanceOf(ExternalActionRequiredError);
		await h
			.db()
			.updateTable("design_external_action_receipts")
			.set({ outcome: "manual-confirmed" })
			.where("id", "=", receiptId)
			.execute();
		await expect(check()).rejects.toBeInstanceOf(ExternalActionRequiredError);

		await h
			.db()
			.updateTable("design_external_action_receipts")
			.set({
				outcome: "completed",
				evidence: JSON.stringify({
					kind: "nova-operation",
					operationId: crypto.randomUUID(),
					resultDigest: "a".repeat(64),
				}),
			})
			.where("id", "=", receiptId)
			.execute();
		await expect(check()).resolves.toBeUndefined();

		await h
			.db()
			.updateTable("design_external_action_receipts")
			.set({ action_digest: "b".repeat(64) })
			.where("id", "=", receiptId)
			.execute();
		await expect(check()).rejects.toBeInstanceOf(ExternalActionRequiredError);

		action.timing = "before-materialization";
		const root = plan.slices[0];
		if (root === undefined)
			throw new Error("fixture has a materialization root");
		root.externalActionIds = [action.id];
		await h
			.db()
			.updateTable("design_external_action_receipts")
			.set({
				app_id: null,
				action_digest: canonicalJsonDigest(action),
			})
			.where("id", "=", receiptId)
			.execute();
		await expect(
			assertRequiredExternalActionsSatisfied({
				designSessionId: sessionId,
				projectId: PROJECT,
				appId: null,
				plan,
				slice: root,
			}),
		).resolves.toBeUndefined();
	});
});
