import { gzipSync } from "node:zlib";
import type { Transaction } from "kysely";
import { expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { restoreApp, softDeleteApp } from "@/lib/db/apps";
import { claimHqAppInTransaction, type HqAppKey } from "@/lib/db/hqAppClaims";
import type { AppDatabase } from "@/lib/db/pg";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import {
	checkSourceFacts,
	locationCaptureSourceFacts,
	scanLocationCaptureAdoptions,
} from "../lib/locationCaptureAdoption";

// The scan freezes its facts before the completion migration drops connect_type.
const h = setupAppStateTestDb("location_capture_adoption_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: "20261209000000_hq_round_trip_complete",
});
const ACTOR = "claims-owner";
const PROJECT = "project-claims";
const ELSEWHERE = "project-elsewhere";
const OBSERVED_AT = "2026-11-10T09:00:00.000Z";
const NORTH: HqAppKey = {
	server: "production",
	domain: "acme",
	remoteAppId: "a".repeat(32),
};
const SOUTH: HqAppKey = {
	server: "production",
	domain: "beta",
	remoteAppId: "b".repeat(32),
};

async function seedDeployment(appId: string, projectId: string, key: HqAppKey) {
	const row = await h
		.db()
		.insertInto("app_deployments")
		.values({
			app_id: appId,
			project_id: projectId,
			server: key.server,
			domain: key.domain,
			state: "uploaded",
			phases: JSON.stringify({ upload: { status: "succeeded" } }),
			created_by: ACTOR,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function mapTarget(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	appId: string,
	key: HqAppKey,
	ownership: "nova-created" | "adopted",
) {
	await tx
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: deploymentId,
			kind: "app",
			nova_resource_id: appId,
			remote_id: key.remoteAppId,
			ownership,
			adopted_at: ownership === "adopted" ? OBSERVED_AT : null,
			adopted_by: ownership === "adopted" ? ACTOR : null,
			pushed_revision: 1,
			pushed_at: OBSERVED_AT,
		})
		.execute();
}

it("freezes held location choices independently and rejects the freeze after a target claim is lost", async () => {
	await h.seedApp({
		id: "app-a",
		owner: ACTOR,
		project_id: PROJECT,
		deleted_at: new Date("2026-11-01T00:00:00.000Z"),
		recoverable_until: new Date("2026-12-01T00:00:00.000Z"),
	});
	await h.seedApp({ id: "app-b", owner: ACTOR, project_id: ELSEWHERE });
	const north = await seedDeployment("app-a", PROJECT, NORTH);
	const south = await seedDeployment("app-a", PROJECT, SOUTH);
	const other = await seedDeployment("app-b", ELSEWHERE, SOUTH);

	for (const [deployment, key, previous] of [
		[north, NORTH, true],
		[south, SOUTH, false],
	] as const) {
		const raw = retainedBodyJson(retainedPublishRead("source-live"));
		raw.auto_gps_capture = previous;
		const normalized = normalizeHqAppSource(raw);
		if ("malformed" in normalized) throw new Error(normalized.malformed);
		await h.withTransaction(async (tx) => {
			await mapTarget(tx, deployment, "app-a", key, "nova-created");
			await tx
				.insertInto("app_deployment_baselines")
				.values({
					deployment_id: deployment,
					remote_app_id: key.remoteAppId,
					origin: "cutover",
					source_gzip: gzipSync(normalized.text),
					source_bytes: normalized.bytes,
					source_digest: normalized.digest,
					ownership: JSON.stringify({
						autoGpsCapture: false,
						addOns: [],
						profileProperties: [],
						profileCustomProperties: [],
					}),
					observed_at: OBSERVED_AT,
					observed_by: ACTOR,
				})
				.execute();
		});
	}

	const held = await scanLocationCaptureAdoptions();
	const decision = (facts: typeof held) =>
		facts.decisions.find(({ appId }) => appId === "app-a");
	expect(decision(held)).toMatchObject({
		standing: "disagreement",
		captureLocation: false,
		targets: expect.arrayContaining([
			expect.objectContaining({
				deploymentId: north,
				claim: "held",
				previous: true,
			}),
			expect.objectContaining({
				deploymentId: south,
				claim: "held",
				previous: false,
			}),
		]),
	});

	await restoreApp("app-a", ACTOR);
	await h.withTransaction((tx) => checkSourceFacts(tx, held));
	await softDeleteApp("app-a", ACTOR);

	const released = await h.withTransaction(async (tx) => {
		await claimHqAppInTransaction(tx, SOUTH);
		const beforeMapping = await locationCaptureSourceFacts(tx);
		await mapTarget(tx, other, "app-b", SOUTH, "adopted");
		return beforeMapping;
	});
	expect(decision(released)).toMatchObject({
		standing: "agreed-on",
		captureLocation: true,
		targets: expect.arrayContaining([
			expect.objectContaining({
				deploymentId: south,
				claim: "released",
				retainedChoice: false,
				previous: null,
			}),
		]),
	});

	expect(decision(await scanLocationCaptureAdoptions())).toMatchObject({
		standing: "agreed-on",
		captureLocation: true,
		targets: expect.arrayContaining([
			expect.objectContaining({
				deploymentId: south,
				claim: "claimed-elsewhere",
				retainedChoice: false,
				previous: null,
			}),
		]),
	});
	await expect(
		h.withTransaction((tx) => checkSourceFacts(tx, held)),
	).rejects.toThrow("source facts changed");
});
