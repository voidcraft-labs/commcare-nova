/** Native receipt gate for historical blocked plans. New plans cannot admit
 * blocked actions because no completion producer is registered. Raw receipt
 * fixtures exercise that retained reader policy, not a real completion flow. */
import { beforeEach, expect, it } from "vitest";
import { did, makeContract } from "@/lib/agent/design/__tests__/fixtures";
import {
	persistAcceptedDesignFixture,
	persistAcceptedRevisionFixture,
} from "@/lib/agent/design/__tests__/persistedFixtures";
import {
	insertDesignBuildPlan,
	readDesignBuildPlan,
} from "@/lib/agent/design/artifactStore";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import {
	appDesignContractSchema,
	type ExternalRequirement,
} from "@/lib/agent/design/contract";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	assertRequiredExternalActionsSatisfied,
	ExternalActionRequiredError,
} from "../externalActions";

const h = setupAppStateTestDb("external_actions_", { authSchema: "migrated" });
const authority = {
	actorUserId: "owner-test",
	expectedProjectId: "project-test",
	runId: "external-run",
	holderNonce: "00000000-0000-4000-8000-000000000888",
};
let sessionId: string;
let appId: string;
beforeEach(async () => {
	sessionId = await h.seedDesignSession({
		owner_user_id: authority.actorUserId,
		project_id: authority.expectedProjectId,
		run_id: authority.runId,
		run_holder_nonce: authority.holderNonce,
		run_actor_user_id: authority.actorUserId,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-09",
			reserved: 1,
			settled: false,
			userId: authority.actorUserId,
			runId: authority.runId,
		},
	});
	appId = await h.seedApp({ project_id: authority.expectedProjectId });
});
async function fixture(
	kind: ExternalRequirement["kind"] = "existing-reference",
	blocked = true,
) {
	const contract = makeContract();
	const workflow = contract.workflows[1];
	const requirement = {
		id: did(901),
		name: "Approved facility catalog",
		kind,
		description: "Load the approved facility catalog.",
		relatedWorkflowIds: [workflow.id],
		blocksConstruction: blocked,
	};
	contract.externalRequirements = [requirement];
	workflow.externalRequirementIds = [requirement.id];
	if (blocked) {
		contract.openQuestions.push({
			id: did(902),
			question: "Is the facility catalog available?",
			blocking: true,
			relatedElementIds: [requirement.id],
		});
	}
	const state = await persistAcceptedRevisionFixture({
		designSessionId: sessionId,
		authority,
		contract: appDesignContractSchema.parse(contract),
	});
	const plan = deriveBuildPlan({
		contract: state.accepted.envelope.payload,
		revision: { id: state.accepted.id, digest: state.accepted.artifactDigest },
	});
	const envelope = state.envelope(
		"design-build-plan",
		plan,
		state.accepted.revision,
		state.accepted.id,
		[state.accepted.artifactDigest],
	);
	if (blocked) {
		await expect(
			insertDesignBuildPlan({ envelope, authority }),
		).rejects.toThrow(/no registered completion producer/);
		expect(
			await h.db().selectFrom("design_build_plans").selectAll().execute(),
		).toEqual([]);
		// Historical bytes enter below the new-plan admission policy, with every
		// envelope, source, revision and plan digest still derived and verified.
		await h
			.db()
			.insertInto("design_build_plans")
			.values({
				id: plan.id,
				design_session_id: sessionId,
				design_revision_id: state.accepted.id,
				design_revision_digest: state.accepted.artifactDigest,
				plan_digest: canonicalJsonDigest(plan),
				artifact_digest: envelope.artifactDigest,
				producer_model: envelope.producer.modelId,
				prompt_version: envelope.promptVersion,
				created_by_run_id: authority.runId,
				envelope: JSON.stringify(envelope),
			})
			.execute();
	} else await insertDesignBuildPlan({ envelope, authority });
	const read = await readDesignBuildPlan(plan.id);
	if (!read) throw new Error("Missing admitted historical plan");
	expect(read.envelope.payload).toEqual(plan);
	const slice = plan.slices.find((s) => s.workflowId === workflow.id);
	if (!slice) throw new Error("Missing dependent slice");
	const action = plan.externalActions[0];
	const check = (scope = appId) =>
		assertRequiredExternalActionsSatisfied({
			designSessionId: sessionId,
			projectId: authority.expectedProjectId,
			appId: scope,
			plan,
			slice,
		});
	async function receipt(overrides: Record<string, unknown> = {}) {
		const id = crypto.randomUUID();
		const base = {
			id,
			design_session_id: sessionId,
			build_plan_id: plan.id,
			external_action_id: action.id,
			project_id: authority.expectedProjectId,
			app_id: appId,
			action_digest: canonicalJsonDigest(action),
			outcome: "completed",
			evidence: {
				kind: "nova-operation",
				operationId: crypto.randomUUID(),
				resultDigest: canonicalJsonDigest({ fixtureResult: "catalog loaded" }),
			},
		};
		// Mutable database evidence is intentionally below writer validation.
		await h
			.pool()
			.query(
				"INSERT INTO design_external_action_receipts SELECT * FROM jsonb_populate_record(NULL::design_external_action_receipts, $1::jsonb)",
				[
					JSON.stringify({
						...base,
						completed_at: new Date().toISOString(),
						...overrides,
					}),
				],
			);
		return id;
	}
	return { plan, slice, action, check, receipt };
}

it("blocks a dependent slice without receipts, but does not block an unrelated root", async () => {
	const f = await fixture();
	await expect(f.check()).rejects.toBeInstanceOf(ExternalActionRequiredError);
	const root = f.plan.slices.find((s) => s.role === "materialization-root");
	if (!root) throw new Error("Missing root");
	await expect(
		assertRequiredExternalActionsSatisfied({
			designSessionId: sessionId,
			projectId: authority.expectedProjectId,
			appId: null,
			plan: f.plan,
			slice: root,
		}),
	).resolves.toBeUndefined();
	expect(
		await h.db().selectFrom("design_slice_attempts").selectAll().execute(),
	).toEqual([]);
});
it.each(["existing-reference", "deployment-readiness"] as const)(
	"new nonblocking %s plans require no completion receipt",
	async (kind) => {
		const f = await fixture(kind, false);
		await expect(f.check()).resolves.toBeUndefined();
	},
);
it.each(["operation", "external", "confirmation"] as const)(
	"accepts typed %s completion evidence at its correct outcome",
	async (kind) => {
		const f = await fixture(
			kind === "confirmation" ? "user-prerequisite" : "existing-reference",
		);
		const evidence =
			kind === "operation"
				? {
						kind: "nova-operation",
						operationId: crypto.randomUUID(),
						resultDigest: canonicalJsonDigest("operation"),
					}
				: kind === "external"
					? {
							kind: "external-system",
							referenceDigest: canonicalJsonDigest("reference"),
							resultDigest: canonicalJsonDigest("result"),
						}
					: {
							kind: "user-confirmation",
							confirmationId: crypto.randomUUID(),
							confirmedByUserId: authority.actorUserId,
						};
		await f.receipt({
			outcome: kind === "confirmation" ? "manual-confirmed" : "completed",
			evidence,
		});
		await expect(f.check()).resolves.toBeUndefined();
	},
);
it.each(["project", "app", "action", "digest"] as const)(
	"refuses a receipt with different %s identity",
	async (field) => {
		const f = await fixture();
		const otherApp =
			field === "app"
				? await h.seedApp({ id: crypto.randomUUID() })
				: undefined;
		await f.receipt(
			field === "project"
				? { project_id: "other-project" }
				: field === "app"
					? { app_id: otherApp }
					: field === "action"
						? { external_action_id: crypto.randomUUID() }
						: { action_digest: canonicalJsonDigest("other action") },
		);
		await expect(f.check()).rejects.toBeInstanceOf(ExternalActionRequiredError);
	},
);
it.each([
	"completed-confirmation",
	"manual-operation",
	"manual-external",
	"wrong-action-kind",
] as const)("refuses incompatible %s evidence", async (scenario) => {
	const f = await fixture();
	const evidence =
		scenario === "manual-operation"
			? {
					kind: "nova-operation",
					operationId: crypto.randomUUID(),
					resultDigest: canonicalJsonDigest("operation"),
				}
			: scenario === "manual-external"
				? {
						kind: "external-system",
						referenceDigest: canonicalJsonDigest("reference"),
						resultDigest: canonicalJsonDigest("result"),
					}
				: {
						kind: "user-confirmation",
						confirmationId: crypto.randomUUID(),
						confirmedByUserId: authority.actorUserId,
					};
	await f.receipt({
		outcome:
			scenario === "completed-confirmation" ? "completed" : "manual-confirmed",
		evidence,
	});
	await expect(f.check()).rejects.toBeInstanceOf(ExternalActionRequiredError);
});
it.each([
	{},
	{
		kind: "nova-operation",
		operationId: "not-uuid",
		resultDigest: "a".repeat(64),
	},
	{
		kind: "external-system",
		referenceDigest: "no",
		resultDigest: "a".repeat(64),
	},
	{
		kind: "nova-operation",
		operationId: "00000000-0000-4000-8000-000000000123",
		resultDigest: "a".repeat(64),
		unexpected: true,
	},
])("refuses malformed persisted evidence %#", async (evidence) => {
	const f = await fixture();
	await f.receipt({ evidence });
	await expect(f.check()).rejects.toThrow();
});

it.each(["session", "plan"] as const)(
	"does not borrow a receipt bound to another %s",
	async (scope) => {
		const f = await fixture();
		const otherSession = await h.seedDesignSession({
			owner_user_id: authority.actorUserId,
			project_id: authority.expectedProjectId,
			run_id: authority.runId,
			run_holder_nonce: authority.holderNonce,
			run_actor_user_id: authority.actorUserId,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-09",
				reserved: 1,
				settled: false,
				userId: authority.actorUserId,
				runId: authority.runId,
			},
		});
		const other = await persistAcceptedDesignFixture({
			designSessionId: otherSession,
			authority,
		});
		await f.receipt(
			scope === "session"
				? { design_session_id: otherSession }
				: { build_plan_id: other.plan.id },
		);
		await expect(f.check()).rejects.toBeInstanceOf(ExternalActionRequiredError);
	},
);
it("a pre-app receipt satisfies the same session before and after materialization", async () => {
	const f = await fixture();
	await f.receipt({ app_id: null });
	await expect(
		assertRequiredExternalActionsSatisfied({
			designSessionId: sessionId,
			projectId: authority.expectedProjectId,
			appId: null,
			plan: f.plan,
			slice: f.slice,
		}),
	).resolves.toBeUndefined();
	await expect(f.check()).resolves.toBeUndefined();
});
it("an app-specific receipt cannot satisfy a pre-app check", async () => {
	const f = await fixture();
	await f.receipt();
	await expect(
		assertRequiredExternalActionsSatisfied({
			designSessionId: sessionId,
			projectId: authority.expectedProjectId,
			appId: null,
			plan: f.plan,
			slice: f.slice,
		}),
	).rejects.toBeInstanceOf(ExternalActionRequiredError);
});
