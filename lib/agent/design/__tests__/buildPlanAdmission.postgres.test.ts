/** Exact plan semantics at the native artifact writer, using a complete
 * source/draft/review/accepted lineage. Review content is controlled offline. */
import { beforeEach, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { insertDesignBuildPlan, readDesignBuildPlan } from "../artifactStore";
import { type BuildPlan, deriveBuildPlan } from "../buildPlan";
import { did, makeContract } from "./fixtures";
import { persistAcceptedRevisionFixture } from "./persistedFixtures";

const h = setupAppStateTestDb("plan_semantics_", { authSchema: "migrated" });
const authority = {
	actorUserId: "owner-test",
	expectedProjectId: "project-test",
	runId: "plan-run",
	holderNonce: "00000000-0000-4000-8000-000000000877",
};
let state: Awaited<ReturnType<typeof persistAcceptedRevisionFixture>>;
let plan: BuildPlan;
beforeEach(async () => {
	const designSessionId = await h.seedDesignSession({
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
	const contract = makeContract();
	contract.externalRequirements = [
		{
			id: did(903),
			name: "Worker setup",
			kind: "runtime-readiness",
			description: "Configure worker access before using visits.",
			relatedWorkflowIds: [contract.workflows[1].id],
			blocksConstruction: false,
		},
	];
	contract.workflows[1].externalRequirementIds = [did(903)];
	state = await persistAcceptedRevisionFixture({
		designSessionId,
		authority,
		contract,
	});
	plan = deriveBuildPlan({
		contract: state.accepted.envelope.payload,
		revision: { id: state.accepted.id, digest: state.accepted.artifactDigest },
	});
});
function write(candidate: BuildPlan) {
	return insertDesignBuildPlan({
		authority,
		envelope: state.envelope(
			"design-build-plan",
			candidate,
			state.accepted.revision,
			state.accepted.id,
			[state.accepted.artifactDigest],
		),
	});
}
it("persists the complete derived plan unchanged", async () => {
	const stored = await write(plan);
	expect((await readDesignBuildPlan(stored.id))?.envelope.payload).toEqual(
		plan,
	);
});
it.each([
	"duplicate-element",
	"group-kind",
	"missing-area",
	"extra-area",
	"external-omission",
	"external-description",
	"external-timing",
	"external-reference",
	"slice-identity",
	"risk",
] as const)(
	"refuses %s drift from accepted construction semantics",
	async (scenario) => {
		const candidate = structuredClone(plan);
		const group = candidate.slices[0].constructionGroups.find(
			(g) => g.kind === "workflow",
		);
		if (!group) throw new Error("Missing workflow group");
		if (scenario === "duplicate-element")
			group.elements.push(structuredClone(group.elements[0]));
		if (scenario === "group-kind") group.kind = "foundation";
		if (scenario === "missing-area")
			group.blueprintAreas = group.blueprintAreas.filter(
				(area) => area !== "forms",
			);
		if (scenario === "extra-area") group.blueprintAreas.push("automations");
		if (scenario === "external-omission") {
			candidate.externalActions = [];
			candidate.slices[1].externalActionIds = [];
		}
		if (scenario === "external-description")
			candidate.externalActions[0].description = "An unrelated setup task";
		if (scenario === "external-timing")
			candidate.externalActions[0].timing = "manual-setup";
		if (scenario === "external-reference")
			candidate.slices[1].externalActionIds = [];
		if (scenario === "slice-identity") candidate.slices[1].id = did(9998);
		if (scenario === "risk") candidate.slices[1].risk = "ordinary";
		await expect(write(candidate)).rejects.toThrow();
		expect(
			await h.db().selectFrom("design_build_plans").selectAll().execute(),
		).toEqual([]);
	},
);
