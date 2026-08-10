/**
 * The slice execution brief — closure derivation, scenario claiming, digest
 * stability, and the rendered volatile message.
 */

import { describe, expect, it } from "vitest";
import {
	briefDigest,
	deriveSliceExecutionBrief,
	renderBriefMessage,
	type SliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import {
	ids,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { PLATFORM_CONSTRAINT_CODES } from "@/lib/agent/design/platformConstraints";

const REVISION = { id: ids.revisionId, digest: "b".repeat(64) };

function rootBrief(): SliceExecutionBrief {
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: REVISION,
		plan: makeBuildPlan(),
		sliceId: ids.sliceRegister,
	});
}

function visitBrief(): SliceExecutionBrief {
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: REVISION,
		plan: makeBuildPlan(),
		sliceId: ids.sliceVisit,
	});
}

describe("deriveSliceExecutionBrief", () => {
	it("carries the slice's owned intents and its transitive closure", () => {
		const brief = rootBrief();

		expect(brief.owningIntentIds).toEqual(
			makeBuildPlan().slices[0]?.ownedIntentIds,
		);
		/* recVisit is reached transitively — the patient queue selects into the
		 * visit task, whose transition creates the visit record. */
		expect(brief.records.map((r) => r.id)).toEqual([
			ids.recPatient,
			ids.recVisit,
		]);
		expect(brief.tasks.map((t) => t.id)).toEqual([
			ids.taskRegister,
			ids.taskVisit,
		]);
		expect(brief.rules.map((r) => r.id)).toEqual([ids.ruleRisk]);
		expect(brief.readModels.map((m) => m.id)).toEqual([ids.rmPatients]);
		expect(brief.accessPolicies.map((p) => p.id)).toEqual([
			ids.accessSupervisor,
		]);
		expect(brief.navigation.map((n) => n.id)).toEqual([ids.navMain]);
		/* Both actors: the CHW owns the task, the supervisor arrives through the
		 * read model and the access policy. */
		expect(brief.actors.map((a) => a.id)).toEqual([
			ids.actorChw,
			ids.actorSupervisor,
		]);
		/* The lookup-sourced fact pulls in the table intent it reads. */
		expect(brief.lookupIntents.map((l) => l.id)).toEqual([ids.lookupVillages]);
	});

	it("excludes contract objects outside the closure", () => {
		const brief = visitBrief();

		/* The visit slice names no access policy or navigation intent, and
		 * nothing it does name reaches one — so neither rides its brief. */
		expect(brief.accessPolicies).toEqual([]);
		expect(brief.navigation).toEqual([]);
		expect(brief.dependencyIntentIds).not.toContain(ids.accessSupervisor);
		expect(brief.dependencyIntentIds).not.toContain(ids.navMain);
		/* Its own record and the parent it hangs from are both present. */
		expect(brief.records.map((r) => r.id)).toEqual([
			ids.recPatient,
			ids.recVisit,
		]);
	});

	it("follows a fact's source to what produces it", () => {
		const brief = visitBrief();

		/* The slice names the patient queue, which scans risk_level; risk_level
		 * is derived by a rule, and the rule reads age. Every one of those is a
		 * dependency the executor must not re-implement — and must not mistake
		 * for something this slice owns. */
		expect(brief.rules.map((r) => r.id)).toEqual([ids.ruleRisk]);
		expect(brief.facts.map((f) => f.id)).toContain(ids.factRisk);
		expect(brief.facts.map((f) => f.id)).toContain(ids.factAge);
		/* The lookup-sourced fact drags in the table intent it reads. */
		expect(brief.lookupIntents.map((l) => l.id)).toEqual([ids.lookupVillages]);
		for (const id of [ids.ruleRisk, ids.factRisk, ids.factAge]) {
			expect(brief.owningIntentIds).not.toContain(id);
			expect(brief.dependencyIntentIds).toContain(id);
		}
	});

	it("splits owned intents from dependencies", () => {
		const brief = visitBrief();
		const owned = new Set(brief.owningIntentIds);

		expect(owned.has(ids.taskVisit)).toBe(true);
		expect(brief.dependencyIntentIds).toContain(ids.recPatient);
		expect(brief.dependencyIntentIds).toContain(ids.rmPatients);
		for (const id of brief.dependencyIntentIds) {
			expect(owned.has(id)).toBe(false);
		}
	});

	it("carries exactly the scenarios the slice claims", () => {
		expect(rootBrief().scenarios.map((s) => s.id)).toEqual([
			ids.scenarioRegister,
			ids.scenarioQueue,
		]);
		/* The visit slice claims none — its evidence lives on the root slice. */
		expect(visitBrief().scenarios).toEqual([]);
	});

	it("carries contract-level context and the whole constraint catalogue", () => {
		const brief = visitBrief();

		/* Decisions and assumptions are context, not closure members: an
		 * executor that cannot see the rejected option re-litigates it. */
		expect(brief.decisions.map((d) => d.id)).toEqual([ids.decision]);
		expect(brief.assumptions.map((a) => a.id)).toEqual([ids.assumption]);
		expect(brief.loweringConstraints.map((c) => c.code)).toEqual([
			...PLATFORM_CONSTRAINT_CODES,
		]);
	});

	it("binds the revision and plan identity", () => {
		const brief = rootBrief();
		expect(brief.schemaVersion).toBe(1);
		expect(brief.appName).toBe(makeContract().title);
		expect(brief.designRevisionId).toBe(REVISION.id);
		expect(brief.designRevisionDigest).toBe(REVISION.digest);
		expect(brief.buildPlanId).toBe(makeBuildPlan().id);
		expect(brief.buildPlanDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("takes the plan's artifact digest when the caller holds it", () => {
		const artifactDigest = "e".repeat(64);
		const bound = deriveSliceExecutionBrief({
			contract: makeContract(),
			revision: REVISION,
			plan: makeBuildPlan(),
			sliceId: ids.sliceRegister,
			planDigest: artifactDigest,
		});
		expect(bound.buildPlanDigest).toBe(artifactDigest);
		expect(briefDigest(bound)).not.toBe(briefDigest(rootBrief()));
	});

	it("refuses a slice the plan does not contain", () => {
		expect(() =>
			deriveSliceExecutionBrief({
				contract: makeContract(),
				revision: REVISION,
				plan: makeBuildPlan(),
				sliceId: ids.taskRegister,
			}),
		).toThrow(/holds no slice/);
	});
});

describe("briefDigest", () => {
	it("is stable across derivations of the same inputs", () => {
		expect(briefDigest(rootBrief())).toBe(briefDigest(rootBrief()));
	});

	it("differs between slices", () => {
		expect(briefDigest(rootBrief())).not.toBe(briefDigest(visitBrief()));
	});

	it("changes when any content changes", () => {
		const contract = makeContract();
		const before = briefDigest(
			deriveSliceExecutionBrief({
				contract,
				revision: REVISION,
				plan: makeBuildPlan(),
				sliceId: ids.sliceRegister,
			}),
		);
		const changed = makeContract();
		changed.objective = `${changed.objective} Also track referrals.`;
		const after = briefDigest(
			deriveSliceExecutionBrief({
				contract: changed,
				revision: REVISION,
				plan: makeBuildPlan(),
				sliceId: ids.sliceRegister,
			}),
		);
		expect(after).not.toBe(before);
	});

	it("changes when the revision digest changes", () => {
		const other = deriveSliceExecutionBrief({
			contract: makeContract(),
			revision: { id: REVISION.id, digest: "c".repeat(64) },
			plan: makeBuildPlan(),
			sliceId: ids.sliceRegister,
		});
		expect(briefDigest(other)).not.toBe(briefDigest(rootBrief()));
	});
});

describe("renderBriefMessage", () => {
	it("states the objective, the slice, and its collections", () => {
		const brief = rootBrief();
		const message = renderBriefMessage(brief);

		expect(message).toContain(brief.appName);
		expect(message).toContain(brief.appObjective);
		expect(message).toContain(brief.slice.name);
		expect(message).toContain(brief.slice.goal);
		expect(message).toContain("## Records");
		expect(message).toContain(
			"## Acceptance scenarios this slice must satisfy",
		);
		expect(message).toContain("SINGLE_DIRECT_CASE_WRITE_PER_FIELD");
		expect(message).toContain(ids.recPatient);
	});

	it("never renders an object as [object Object]", () => {
		expect(renderBriefMessage(rootBrief())).not.toContain("[object Object]");
		expect(renderBriefMessage(visitBrief())).not.toContain("[object Object]");
	});

	it("omits empty collections", () => {
		const message = renderBriefMessage(visitBrief());
		expect(message).toContain("## Rules");
		expect(message).not.toContain("## Access policies");
		expect(message).not.toContain("## Navigation");
		expect(message).not.toContain("## External actions bound to this slice");
	});
});
