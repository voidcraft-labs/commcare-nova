/**
 * The confirmation ledger against real Postgres: what a person confirmed
 * about a project space, recorded by the fold of a passed preflight and
 * withdrawn, never deleted.
 *
 * What this proves that a pure test cannot: the partial unique index keeps
 * one live confirmation per subject when two publishes confirm it at once,
 * the per-kind CHECKs refuse a subject the kind does not have, and the rows
 * stay reachable through the deployment when the app moves Project, since
 * a confirmation is about the project space.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitAppProjectMoveInTransaction } from "@/lib/db/apps";
import {
	type DeploymentScope,
	foldDeploymentAttempt,
	readDeployment,
	withdrawDeploymentConfirmation,
} from "../store";
import type { DeploymentConfirmationKey } from "../types";

const h = setupAppStateTestDb("deployment_confirmations_", {
	authSchema: "migrated",
	poolMax: 4,
});

const SOURCE = "project-source";
const DESTINATION = "project-destination";
const ACTOR = "owner-1";
const TARGET = { server: "production" as const, domain: "acme" };
const AT = "2026-10-16T00:00:00.000Z";
const LOOKUP: DeploymentConfirmationKey = {
	kind: "plan-feature",
	subject: "lookup-tables",
};

async function seed(): Promise<DeploymentScope> {
	await h.seedAppWithBlueprint(
		buildDoc({
			appName: "Visits",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		}),
		{ id: "app-1", owner: ACTOR, projectId: SOURCE },
	);
	return {
		appId: "app-1",
		projectId: SOURCE,
		role: "owner",
		actorUserId: ACTOR,
	};
}

function confirm(
	scope: DeploymentScope,
	confirmations: readonly DeploymentConfirmationKey[],
) {
	return foldDeploymentAttempt(
		scope,
		TARGET,
		"preflight",
		{ status: "succeeded", at: AT },
		{ ensure: true, confirmations },
	);
}

function rows() {
	return h
		.db()
		.selectFrom("app_deployment_confirmations")
		.select(["kind", "subject", "confirmed_by", "withdrawn_by", "withdrawn_at"])
		.orderBy("confirmed_at")
		.orderBy("id")
		.execute();
}

describe("confirmations", () => {
	it("are recorded with who confirmed them and when, by the confirming member's name", async () => {
		const scope = await seed();
		const view = await confirm(scope, [
			LOOKUP,
			{ kind: "flat-location-fixture" },
		]);
		expect(view.confirmations).toEqual([
			expect.objectContaining({
				kind: "plan-feature",
				subject: "lookup-tables",
				confirmedByName: ACTOR,
			}),
			expect.objectContaining({
				kind: "flat-location-fixture",
				subject: "flat-location-fixture",
				confirmedByName: ACTOR,
			}),
		]);
		for (const confirmation of view.confirmations) {
			expect(Number.isNaN(Date.parse(confirmation.confirmedAt))).toBe(false);
		}
	});

	it("keep one live row per subject when two publishes confirm it at once", async () => {
		const scope = await seed();
		await confirm(scope, []);
		await Promise.all([confirm(scope, [LOOKUP]), confirm(scope, [LOOKUP])]);
		expect(await rows()).toEqual([
			expect.objectContaining({ subject: "lookup-tables", withdrawn_at: null }),
		]);
	});

	it("are never stored by a fold that is not a passed preflight", async () => {
		const scope = await seed();
		await confirm(scope, []);
		await expect(
			foldDeploymentAttempt(
				scope,
				TARGET,
				"preflight",
				{
					status: "failed",
					at: AT,
					failure: { code: "hq_changed", message: "Changed.", details: [] },
				},
				{ confirmations: [LOOKUP] },
			),
		).rejects.toThrow(/preflight that passed/);
		expect(await rows()).toEqual([]);
	});

	it("stop answering once withdrawn, and a fresh confirmation makes a second row", async () => {
		const scope = await seed();
		await confirm(scope, [LOOKUP]);
		const withdrawn = await withdrawDeploymentConfirmation(
			scope,
			TARGET,
			LOOKUP,
		);
		expect(withdrawn.confirmations).toEqual([]);
		/* Withdrawing what is not in force changes nothing. */
		await withdrawDeploymentConfirmation(scope, TARGET, LOOKUP);

		const again = await confirm(scope, [LOOKUP]);
		expect(again.confirmations.map((item) => item.subject)).toEqual([
			"lookup-tables",
		]);
		const stored = await rows();
		expect(stored).toHaveLength(2);
		expect(stored[0]).toMatchObject({ withdrawn_by: ACTOR });
		expect(stored[0]?.withdrawn_at).not.toBeNull();
		expect(stored[1]).toMatchObject({ withdrawn_by: null, withdrawn_at: null });
	});

	it("refuse a flat location list or Connect forwarder confirmation under another subject", async () => {
		const scope = await seed();
		const view = await confirm(scope, []);
		for (const kind of ["flat-location-fixture", "connect-forwarder"]) {
			await expect(
				h
					.db()
					.insertInto("app_deployment_confirmations")
					.values({
						deployment_id: view.deployment.id,
						kind,
						subject: "lookup-tables",
						confirmed_by: ACTOR,
					})
					.execute(),
			).rejects.toThrow(
				/app_deployment_confirmations_(fixture|forwarder)_subject/,
			);
		}
	});

	it("stay reachable through the deployment when the app moves Project", async () => {
		const scope = await seed();
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await confirm(scope, [LOOKUP, { kind: "connect-forwarder" }]);
		await h
			.db()
			.transaction()
			.execute((tx) =>
				commitAppProjectMoveInTransaction(
					tx,
					{
						appId: scope.appId,
						expectedFromProjectId: SOURCE,
						toProjectId: DESTINATION,
						actorUserId: ACTOR,
						assetIdMap: new Map(),
					},
					{ batchId: crypto.randomUUID() },
				),
			);
		const moved = await readDeployment(
			{ ...scope, projectId: DESTINATION },
			TARGET,
		);
		expect(moved?.confirmations.map((item) => item.subject)).toEqual([
			"lookup-tables",
			"connect-forwarder",
		]);
	});
});
