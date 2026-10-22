/**
 * The plan's digest is what makes `--execute --expect-plan-digest` write
 * exactly the plan the operator read in the dry run (part 09 §3). The
 * plausible failures: a digest that moves between two builds of one plan
 * (key order, an unordered collection), so a quiescent window refuses its
 * own dry run; and a digest blind to a field the writer acts on, so a plan
 * that moved after the dry run is written anyway. The observation is the
 * digest of one plan rebuilt, and of that plan with each field moved.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type AppPlan,
	appDeploymentChanges,
	type ExpressionsCutoverPlan,
	expressionsPlanDigest,
	fleetSeqDigestOf,
	PLAN_FORMAT,
	planHasBlockers,
} from "../plan";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function app(overrides: Partial<AppPlan> = {}): AppPlan {
	return {
		appId: "app-1",
		projectId: "project-1",
		baseSeq: 7,
		baseDigest: DIGEST_A,
		targetDigest: DIGEST_B,
		changes: [
			{
				reason: "expressions-respelled",
				entity: { type: "app", nameAtMigration: "Clinic" },
				detail: { count: "3" },
			},
		],
		blockers: [],
		schemaChanges: [
			{
				caseType: "visit",
				property: "next_due",
				from: "text",
				to: "date",
				source: "inferred",
			},
		],
		discardsPrivateWork: false,
		deployments: [
			{
				deploymentId: "01992000-0000-7000-8000-000000000011",
				server: "production",
				domain: "clinic",
				hasEntryPoints: false,
			},
		],
		...overrides,
	};
}

function digest(apps: readonly AppPlan[]): string {
	return expressionsPlanDigest({ format: PLAN_FORMAT, apps });
}

describe("the plan digest", () => {
	it("is the same for one plan built twice, whatever its objects' key order", () => {
		const plan = app();
		const reordered = Object.fromEntries(
			Object.entries(structuredClone(plan)).reverse(),
		) as unknown as AppPlan;
		expect(digest([plan])).toBe(digest([app()]));
		expect(digest([reordered])).toBe(digest([plan]));
		expect(digest([plan])).toMatch(/^[0-9a-f]{64}$/);
	});

	it.each<[string, Partial<AppPlan>]>([
		["a base sequence", { baseSeq: 8 }],
		["a base digest", { baseDigest: DIGEST_B }],
		["a target", { targetDigest: DIGEST_A }],
		[
			"a change",
			{
				changes: [
					{
						reason: "expressions-respelled",
						entity: { type: "app", nameAtMigration: "Clinic" },
						detail: { count: "4" },
					},
				],
			},
		],
		[
			"a blocker",
			{
				blockers: [{ code: "target-gate", count: 1, findingCodes: ["CYCLE"] }],
			},
		],
		[
			"a schema change",
			{
				schemaChanges: [
					{
						caseType: "visit",
						property: "next_due",
						from: "text",
						to: "datetime",
						source: "inferred",
					},
				],
			},
		],
		[
			"a deployment's entry points",
			{
				deployments: [
					{
						deploymentId: "01992000-0000-7000-8000-000000000011",
						server: "production",
						domain: "clinic",
						hasEntryPoints: true,
					},
				],
			},
		],
		["discarded private work", { discardsPrivateWork: true }],
		["the Project", { projectId: "project-2" }],
	])("moves with %s", (_name, overrides) => {
		expect(digest([app(overrides)])).not.toBe(digest([app()]));
	});

	it("moves with the set of apps and their order", () => {
		const second = app({ appId: "app-2" });
		expect(digest([app(), second])).not.toBe(digest([app()]));
		expect(digest([second, app()])).not.toBe(digest([app(), second]));
	});
});

describe("the plan's facts", () => {
	it("holds a blocker when any app does", () => {
		const plan = (apps: AppPlan[]): ExpressionsCutoverPlan => ({
			format: PLAN_FORMAT,
			apps,
			digest: digest(apps),
		});
		expect(planHasBlockers(plan([app()]))).toBe(false);
		expect(
			planHasBlockers(
				plan([
					app(),
					app({
						appId: "app-2",
						blockers: [
							{
								code: "expression-parse-refused",
								count: 2,
								findingCodes: ["case-query-untyped"],
							},
						],
					}),
				]),
			),
		).toBe(true);
	});

	it("derives each deployment's lines from the plan alone", () => {
		expect(appDeploymentChanges(app())).toEqual([
			{
				deploymentId: "01992000-0000-7000-8000-000000000011",
				reason: "expressions-sent-at-next-publish",
			},
		]);
		expect(appDeploymentChanges(app({ changes: [] }))).toEqual([]);
	});

	it("digests the fleet's sequences in id order, as the base emitter does", () => {
		const fleet = [
			{ id: "b", seq: 2 },
			{ id: "a", seq: 1 },
		];
		/* scripts/emit-hq-round-trip-expressions-base.ts's framing, byte for byte. */
		expect(fleetSeqDigestOf(fleet)).toBe(
			createHash("sha256").update('[["a",1],["b",2]]').digest("hex"),
		);
		expect(fleetSeqDigestOf(fleet)).toBe(
			fleetSeqDigestOf([...fleet].reverse()),
		);
		expect(fleetSeqDigestOf(fleet)).not.toBe(
			fleetSeqDigestOf([
				{ id: "a", seq: 1 },
				{ id: "b", seq: 3 },
			]),
		);
	});
});
