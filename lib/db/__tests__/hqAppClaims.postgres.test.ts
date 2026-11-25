/**
 * One CommCare HQ app, one Nova app, in real Postgres: a birth's claim, a
 * restore's settle, and how the two meet when they run at once. Concurrent
 * cases hold one transaction open with an explicit promise or a database gate
 * and release it by hand; the database's own lock table says when the other
 * transaction is waiting.
 */
import { gzipSync } from "node:zlib";
import type { Kysely, Transaction } from "kysely";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	checkSourceFacts,
	locationCaptureSourceFacts,
} from "@/scripts/lib/locationCaptureAdoption";
import { RestoreClaimsChangedError, restoreApp, softDeleteApp } from "../apps";
import {
	claimHqAppInTransaction,
	endDeploymentInTransaction,
	HqAppAlreadyClaimedError,
	type HqAppKey,
	lockReleasedClaimsInTransaction,
	NO_PHASE_OUTCOMES_JSON,
} from "../hqAppClaims";
import type { AppDatabase } from "../pg";
import { setupAppStateTestDb } from "./appStateTestDb";
import {
	changeUnderEachTry,
	holdAppRow,
	waitForBlockedLocks,
} from "./heldAppRow";
import { createPerTestAppDb } from "./perTestAppDb";

const h = setupAppStateTestDb("hq_app_claims_", {
	authSchema: "migrated",
	poolMax: 4,
});

const ACTOR = "claims-owner";
const PROJECT = "project-claims";
const ELSEWHERE = "project-elsewhere";
const ADOPTED_AT = "2026-11-10T09:00:00.000Z";
const K1: HqAppKey = {
	server: "production",
	domain: "acme",
	remoteAppId: "a".repeat(32),
};
const K2: HqAppKey = {
	server: "production",
	domain: "beta",
	remoteAppId: "b".repeat(32),
};

// ── Fixtures ────────────────────────────────────────────────────────

async function seedApp(
	id: string,
	options: { deleted?: boolean; projectId?: string } = {},
): Promise<string> {
	return h.seedApp({
		id,
		owner: ACTOR,
		project_id: options.projectId ?? PROJECT,
		...(options.deleted && {
			deleted_at: new Date("2026-11-01T00:00:00.000Z"),
			recoverable_until: new Date("2026-12-01T00:00:00.000Z"),
		}),
	});
}

async function seedDeployment(
	appId: string,
	key: HqAppKey,
	projectId = PROJECT,
): Promise<string> {
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
			content_generation: testUuid(`generation-${appId}-${key.domain}`),
			last_observed_at: new Date("2026-11-02T00:00:00.000Z"),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function insertMapping(
	db: Kysely<AppDatabase>,
	deploymentId: string,
	appId: string,
	key: HqAppKey,
	options: { adopted?: boolean; released?: boolean } = {},
): Promise<void> {
	await db
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: deploymentId,
			kind: "app",
			nova_resource_id: appId,
			remote_id: key.remoteAppId,
			ownership: options.adopted ? "adopted" : "nova-created",
			adopted_at: options.adopted ? ADOPTED_AT : null,
			adopted_by: options.adopted ? ACTOR : null,
			pushed_revision: 1,
			pushed_at: new Date("2026-11-02T00:00:00.000Z"),
			released_at: options.released
				? new Date("2026-11-03T00:00:00.000Z")
				: null,
		})
		.execute();
}

/** An app that publishes to `key`, with a deployment and its live mapping. */
async function seedPublishing(
	appId: string,
	key: HqAppKey,
	options: { deleted?: boolean; released?: boolean; projectId?: string } = {},
): Promise<string> {
	if ((await h.readAppRow(appId)) === undefined) await seedApp(appId, options);
	const deploymentId = await seedDeployment(appId, key, options.projectId);
	await insertMapping(h.db(), deploymentId, appId, key, {
		released: options.released,
	});
	return deploymentId;
}

/** The identity, keyed-case-id and media-path rows an adoption writes. */
async function seedHeldRows(
	deploymentId: string,
	projectId = PROJECT,
): Promise<MediaAssetId> {
	const assetId = testMediaAssetId(`held-${deploymentId}`);
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: assetId,
			project_id: projectId,
			owner: ACTOR,
			content_hash: testUuid(`hash-${deploymentId}`)
				.replaceAll("-", "")
				.repeat(2),
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 256,
			dimensions: JSON.stringify({ width: 32, height: 32 }),
			duration_ms: null,
			kind: "image",
			gcs_object_key: `projects/${projectId}/${assetId}.png`,
			original_filename: "logo.png",
			display_name: "Logo",
			status: "ready",
			media_format: "png",
			extract: null,
		})
		.execute();
	await h
		.db()
		.insertInto("app_deployment_identities")
		.values({
			deployment_id: deploymentId,
			entity_kind: "module",
			nova_entity_uuid: testUuid(`menu-${deploymentId}`),
			unique_id: "f".repeat(32),
			xmlns: null,
		})
		.execute();
	await h
		.db()
		.insertInto("app_deployment_keyed_case_ids")
		.values({
			deployment_id: deploymentId,
			nova_operation_uuid: testUuid(`operation-${deploymentId}`),
			case_type: "household",
			case_id_prefix: `nova-case-v1:${testUuid(`prefix-${deploymentId}`)}:`,
		})
		.execute();
	await h
		.db()
		.insertInto("app_deployment_media_paths")
		.values({
			deployment_id: deploymentId,
			media_asset_id: assetId,
			wire_path: "commcare/image/logo.png",
		})
		.execute();
	return assetId;
}

async function heldRowCounts(deploymentId: string) {
	const count = async (
		table:
			| "app_deployment_identities"
			| "app_deployment_keyed_case_ids"
			| "app_deployment_media_paths",
	) =>
		Number(
			(
				await h
					.db()
					.selectFrom(table)
					.select(({ fn }) => fn.countAll().as("count"))
					.where("deployment_id", "=", deploymentId)
					.executeTakeFirstOrThrow()
			).count,
		);
	return {
		identities: await count("app_deployment_identities"),
		keyedCaseIds: await count("app_deployment_keyed_case_ids"),
		mediaPaths: await count("app_deployment_media_paths"),
	};
}

/** What a birth from CommCare HQ does to the claim: take it, then map the HQ app. */
async function birth(
	tx: Transaction<AppDatabase>,
	appId: string,
	deploymentId: string,
	key: HqAppKey,
): Promise<void> {
	await claimHqAppInTransaction(tx, key);
	await insertMapping(tx, deploymentId, appId, key, { adopted: true });
}

/** The apps whose live, unreleased `app` mapping names the HQ app. */
async function liveClaims(key: HqAppKey): Promise<string[]> {
	const rows = await h
		.db()
		.selectFrom("app_deployment_resources as mapping")
		.innerJoin(
			"app_deployments as deployment",
			"deployment.id",
			"mapping.deployment_id",
		)
		.select("deployment.app_id")
		.where("mapping.kind", "=", "app")
		.where("mapping.superseded_at", "is", null)
		.where("mapping.released_at", "is", null)
		.where("mapping.server", "=", key.server)
		.where("mapping.domain", "=", key.domain)
		.where("mapping.remote_id", "=", key.remoteAppId)
		.orderBy("deployment.app_id")
		.execute();
	return rows.map((row) => row.app_id);
}

async function appMappings(deploymentId: string) {
	return h
		.db()
		.selectFrom("app_deployment_resources")
		.select([
			"remote_id",
			"superseded_at",
			"released_at",
			"ended_by",
			"ended_reason",
		])
		.where("deployment_id", "=", deploymentId)
		.where("kind", "=", "app")
		.orderBy("created_at")
		.execute();
}

async function deploymentRow(deploymentId: string) {
	return h
		.db()
		.selectFrom("app_deployments")
		.select([
			"state",
			"resume_phase",
			"phases",
			"endings",
			"content_generation",
			"entry_point_manifest",
			"last_observed_at",
		])
		.where("id", "=", deploymentId)
		.executeTakeFirstOrThrow();
}

// Attach both handlers before waiting on a database fence so an early failure
// stays observable without becoming an unhandled rejection.
function outcome<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value }) as { value: T; error?: undefined },
		(error: unknown) => ({ error }) as { value?: undefined; error: unknown },
	);
}

/** A promise the test resolves by hand, to hold a transaction open. */
function hold() {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	return { release, released, enter, entered };
}

/** Make every `apps` update wait on a session advisory lock the gate holds. */
async function gateAppUpdates(gate: Client, gateKey: number): Promise<void> {
	await gate.query("SELECT pg_advisory_lock($1)", [gateKey]);
	await gate.query(`
		CREATE FUNCTION test_gate_app_updates() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(${gateKey});
			RETURN NEW;
		END
		$$;
		CREATE TRIGGER test_gate_app_updates_trigger
			BEFORE UPDATE ON apps
			FOR EACH ROW EXECUTE FUNCTION test_gate_app_updates();
	`);
}

// ── Taking a claim ─────────────────────────────────────────────────

describe("claimHqAppInTransaction", () => {
	it("makes a second birth of one HQ app wait for the first and refuse it, having written nothing", async () => {
		await seedApp("app-b");
		await seedApp("app-c", { projectId: ELSEWHERE });
		const deploymentB = await seedDeployment("app-b", K1);
		const deploymentC = await seedDeployment("app-c", K1, ELSEWHERE);
		const first = createPerTestAppDb(h.uri());
		const second = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		const firstHold = hold();
		let firstRun: ReturnType<typeof outcome<void>> | undefined;
		let secondRun: ReturnType<typeof outcome<void>> | undefined;
		try {
			await observer.connect();
			firstRun = outcome(
				first.appDb.transaction().execute(async (tx) => {
					await birth(tx, "app-b", deploymentB, K1);
					firstHold.enter();
					await firstHold.released;
				}),
			);
			await Promise.race([
				firstHold.entered,
				firstRun.then((result) => {
					throw new Error("The first birth ended before it held", {
						cause: result,
					});
				}),
			]);
			secondRun = outcome(
				second.appDb.transaction().execute(async (tx) => {
					await birth(tx, "app-c", deploymentC, K1);
				}),
			);
			// The second birth waits on the HQ app's advisory lock.
			await waitForBlockedLocks(observer, 1);
			firstHold.release();
			expect(await firstRun).toEqual({ value: undefined });
			const refused = await secondRun;
			expect(refused.error).toBeInstanceOf(HqAppAlreadyClaimedError);
			expect((refused.error as HqAppAlreadyClaimedError).holder).toEqual({
				appId: "app-b",
				projectId: PROJECT,
				ownership: "adopted",
				byUserId: ACTOR,
				at: ADOPTED_AT,
			});
		} finally {
			firstHold.release();
			await Promise.allSettled([firstRun, secondRun]);
			await observer.end();
			await first.destroy();
			await second.destroy();
		}
		expect(await liveClaims(K1)).toEqual(["app-b"]);
		expect(await appMappings(deploymentC)).toEqual([]);
	}, 15_000);

	it("releases a holder in recently deleted and leaves a live holder's claim to refuse", async () => {
		const deploymentA = await seedPublishing("app-a", K1, { deleted: true });
		await seedApp("app-b");
		await seedApp("app-c");
		const deploymentB = await seedDeployment("app-b", K1);
		const deploymentC = await seedDeployment("app-c", K1);

		await h.withTransaction((tx) => birth(tx, "app-b", deploymentB, K1));

		const [released] = await appMappings(deploymentA);
		expect(released?.superseded_at).toBeNull();
		expect(released?.released_at).toBeInstanceOf(Date);
		expect(await liveClaims(K1)).toEqual(["app-b"]);
		const refused = await outcome(
			h.withTransaction((tx) => birth(tx, "app-c", deploymentC, K1)),
		);
		expect(refused.error).toBeInstanceOf(HqAppAlreadyClaimedError);
		expect((refused.error as HqAppAlreadyClaimedError).holder?.appId).toBe(
			"app-b",
		);
		expect(await appMappings(deploymentC)).toEqual([]);
	});

	it("ends with one live claim when a birth takes the HQ app before a restore of its deleted holder", async () => {
		const deploymentA = await seedPublishing("app-a", K1, { deleted: true });
		await seedHeldRows(deploymentA);
		await seedApp("app-b");
		const deploymentB = await seedDeployment("app-b", K1);
		const births = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		const birthHold = hold();
		let birthRun: ReturnType<typeof outcome<void>> | undefined;
		let restoreRun:
			| ReturnType<typeof outcome<Awaited<ReturnType<typeof restoreApp>>>>
			| undefined;
		try {
			await observer.connect();
			birthRun = outcome(
				births.appDb.transaction().execute(async (tx) => {
					await birth(tx, "app-b", deploymentB, K1);
					birthHold.enter();
					await birthHold.released;
				}),
			);
			await Promise.race([
				birthHold.entered,
				birthRun.then((result) => {
					throw new Error("The birth ended before it held", { cause: result });
				}),
			]);
			restoreRun = outcome(restoreApp("app-a", ACTOR));
			// The restore waits on the deleted holder's row the birth locked.
			await waitForBlockedLocks(observer, 1);
			birthHold.release();
			expect(await birthRun).toEqual({ value: undefined });
			expect(await restoreRun).toEqual({
				value: {
					stoppedPublishing: [{ server: "production", domain: "acme" }],
				},
			});
		} finally {
			birthHold.release();
			await Promise.allSettled([birthRun, restoreRun]);
			await observer.end();
			await births.destroy();
		}
		expect(await liveClaims(K1)).toEqual(["app-b"]);
		expect((await deploymentRow(deploymentA)).state).toBe("ended");
		expect((await h.readAppRow("app-a"))?.deleted_at).toBeNull();
	}, 15_000);

	it("ends with one live claim when a restore of the deleted holder commits before a birth takes the HQ app", async () => {
		await seedPublishing("app-a", K1, { deleted: true });
		await seedApp("app-b");
		const deploymentB = await seedDeployment("app-b", K1);
		const births = createPerTestAppDb(h.uri());
		const gate = new Client({ connectionString: h.uri() });
		const gateKey = 9_101_201;
		let restoreRun:
			| ReturnType<typeof outcome<Awaited<ReturnType<typeof restoreApp>>>>
			| undefined;
		let birthRun: ReturnType<typeof outcome<void>> | undefined;
		try {
			await gate.connect();
			await gateAppUpdates(gate, gateKey);
			restoreRun = outcome(restoreApp("app-a", ACTOR));
			// The restore holds the app's row and waits at its update.
			await waitForBlockedLocks(gate, 1);
			birthRun = outcome(
				births.appDb
					.transaction()
					.execute((tx) => birth(tx, "app-b", deploymentB, K1)),
			);
			// The birth read a deleted holder and waits on its row.
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			expect(await restoreRun).toEqual({ value: { stoppedPublishing: [] } });
			const refused = await birthRun;
			expect(refused.error).toBeInstanceOf(HqAppAlreadyClaimedError);
			expect((refused.error as HqAppAlreadyClaimedError).holder?.appId).toBe(
				"app-a",
			);
		} finally {
			// Closing the session releases its advisory lock even after a failure.
			await gate.end();
			await Promise.allSettled([restoreRun, birthRun]);
			await births.destroy();
		}
		expect(await liveClaims(K1)).toEqual(["app-a"]);
		expect(await appMappings(deploymentB)).toEqual([]);
	}, 15_000);
});

// ── Restoring ──────────────────────────────────────────────────────

it("converts held location choices of a deleted app, keeps two targets distinct, and detects a lost claim", async () => {
	const north = await seedPublishing("app-a", K1, { deleted: true });
	const south = await seedPublishing("app-a", K2, { deleted: true });
	for (const [deployment, remoteId, previous] of [
		[north, K1.remoteAppId, true],
		[south, K2.remoteAppId, false],
	] as const) {
		const raw = retainedBodyJson(retainedPublishRead("source-live"));
		raw.auto_gps_capture = previous;
		const normalized = normalizeHqAppSource(raw);
		if ("malformed" in normalized) throw new Error(normalized.malformed);
		await h
			.db()
			.insertInto("app_deployment_baselines")
			.values({
				deployment_id: deployment,
				remote_app_id: remoteId,
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
				observed_at: ADOPTED_AT,
				observed_by: ACTOR,
				discarded_digest: null,
				discarded_by: null,
			})
			.execute();
	}
	await seedApp("app-b", { projectId: ELSEWHERE });
	const other = await seedDeployment("app-b", K2, ELSEWHERE);
	const scan = () => h.db().transaction().execute(locationCaptureSourceFacts);
	const held = await scan();
	const app = held.decisions.find((d) => d.appId === "app-a");
	expect(app).toMatchObject({
		standing: "disagreement",
		captureLocation: false,
	});
	expect(app?.targets).toEqual(
		expect.arrayContaining([
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
	);
	await restoreApp("app-a", ACTOR);
	await h
		.db()
		.transaction()
		.execute((tx) => checkSourceFacts(tx, held));
	await softDeleteApp("app-a", ACTOR);
	await h
		.db()
		.transaction()
		.execute((tx) => birth(tx, "app-b", other, K2));
	const after = await scan();
	expect(after.decisions.find((d) => d.appId === "app-a")).toMatchObject({
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
		h
			.db()
			.transaction()
			.execute((tx) => checkSourceFacts(tx, held)),
	).rejects.toThrow("source facts changed");
});

describe("restoreApp settles what the app gave up", () => {
	it("changes no deployment row where nobody took an HQ app", async () => {
		const deploymentA = await seedPublishing("app-a", K1, { deleted: true });
		await seedHeldRows(deploymentA);
		const snapshot = async () => ({
			deployments: await h
				.db()
				.selectFrom("app_deployments")
				.selectAll()
				.execute(),
			mappings: await h
				.db()
				.selectFrom("app_deployment_resources")
				.selectAll()
				.execute(),
			held: await heldRowCounts(deploymentA),
		});
		const before = await snapshot();

		await expect(restoreApp("app-a", ACTOR)).resolves.toEqual({
			stoppedPublishing: [],
		});

		expect(await snapshot()).toEqual(before);
		expect((await h.readAppRow("app-a"))?.deleted_at).toBeNull();
	});

	it("ends the deployment where a live app took the HQ app, and names the project space", async () => {
		const deploymentA = await seedPublishing("app-a", K1, { deleted: true });
		await seedHeldRows(deploymentA);
		await seedApp("app-b", { projectId: ELSEWHERE });
		const deploymentB = await seedDeployment("app-b", K1, ELSEWHERE);
		await h.withTransaction((tx) => birth(tx, "app-b", deploymentB, K1));

		await expect(restoreApp("app-a", ACTOR)).resolves.toEqual({
			stoppedPublishing: [{ server: "production", domain: "acme" }],
		});

		expect(await appMappings(deploymentA)).toEqual([
			{
				remote_id: K1.remoteAppId,
				superseded_at: expect.any(Date),
				released_at: null,
				ended_by: ACTOR,
				ended_reason: "claimed-elsewhere",
			},
		]);
		expect(await deploymentRow(deploymentA)).toEqual({
			state: "ended",
			resume_phase: null,
			phases: JSON.parse(NO_PHASE_OUTCOMES_JSON),
			endings: 1,
			content_generation: expect.any(String),
			entry_point_manifest: null,
			last_observed_at: null,
		});
		expect((await deploymentRow(deploymentA)).content_generation).not.toBe(
			testUuid("generation-app-a-acme"),
		);
		expect(await heldRowCounts(deploymentA)).toEqual({
			identities: 0,
			keyedCaseIds: 0,
			mediaPaths: 0,
		});
		expect(await liveClaims(K1)).toEqual(["app-b"]);
	});

	it("takes the HQ app back where the app that took it was ended since", async () => {
		const deploymentA = await seedPublishing("app-a", K1, { deleted: true });
		await seedHeldRows(deploymentA);
		await seedApp("app-b");
		const deploymentB = await seedDeployment("app-b", K1);
		await h.withTransaction((tx) => birth(tx, "app-b", deploymentB, K1));
		await h.withTransaction((tx) =>
			endDeploymentInTransaction(tx, {
				deploymentId: deploymentB,
				appId: "app-b",
				remoteAppId: K1.remoteAppId,
				byUserId: ACTOR,
				reason: "stopped",
				at: new Date("2026-11-12T00:00:00.000Z"),
			}),
		);

		await expect(restoreApp("app-a", ACTOR)).resolves.toEqual({
			stoppedPublishing: [],
		});

		expect(await liveClaims(K1)).toEqual(["app-a"]);
		expect(await heldRowCounts(deploymentA)).toEqual({
			identities: 1,
			keyedCaseIds: 1,
			mediaPaths: 1,
		});
		expect((await deploymentRow(deploymentA)).state).toBe("uploaded");
	});

	it("takes the HQ app back from a taker in recently deleted, which a restore of the taker then settles", async () => {
		const deploymentA = await seedPublishing("app-a", K1, { deleted: true });
		await seedHeldRows(deploymentA);
		await seedApp("app-b");
		const deploymentB = await seedDeployment("app-b", K1);
		await h.withTransaction((tx) => birth(tx, "app-b", deploymentB, K1));
		await softDeleteApp("app-b", ACTOR);

		await expect(restoreApp("app-a", ACTOR)).resolves.toEqual({
			stoppedPublishing: [],
		});

		expect(await liveClaims(K1)).toEqual(["app-a"]);
		expect(await heldRowCounts(deploymentA)).toEqual({
			identities: 1,
			keyedCaseIds: 1,
			mediaPaths: 1,
		});
		const [takersMapping] = await appMappings(deploymentB);
		expect(takersMapping?.superseded_at).toBeNull();
		expect(takersMapping?.released_at).toBeInstanceOf(Date);

		await expect(restoreApp("app-b", ACTOR)).resolves.toEqual({
			stoppedPublishing: [{ server: "production", domain: "acme" }],
		});
		expect((await deploymentRow(deploymentB)).state).toBe("ended");
		expect(await appMappings(deploymentB)).toEqual([
			expect.objectContaining({
				ended_reason: "claimed-elsewhere",
				released_at: null,
			}),
		]);
		expect(await liveClaims(K1)).toEqual(["app-a"]);
	});

	it("restores two deleted apps that each hold what the other gave up, at once, leaving each HQ app one live claim", async () => {
		// app-a holds K1 and gave K2 up; app-b holds K2 and gave K1 up.
		await seedPublishing("app-a", K1, { deleted: true });
		await seedPublishing("app-a", K2, { deleted: true, released: true });
		await seedPublishing("app-b", K2, { deleted: true });
		await seedPublishing("app-b", K1, { deleted: true, released: true });
		const gate = new Client({ connectionString: h.uri() });
		const gateKey = 9_101_202;
		let restores:
			| ReturnType<typeof outcome<Awaited<ReturnType<typeof restoreApp>>>>[]
			| undefined;
		try {
			await gate.connect();
			await gateAppUpdates(gate, gateKey);
			restores = [
				outcome(restoreApp("app-a", ACTOR)),
				outcome(restoreApp("app-b", ACTOR)),
			];
			// One restore holds both rows at its update; the other waits on a row.
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			const results = await Promise.all(restores);
			for (const result of results) expect(result.error).toBeUndefined();
			expect(
				results.map((result) => result.value?.stoppedPublishing.length).sort(),
			).toEqual([0, 2]);
		} finally {
			await gate.end();
			await Promise.allSettled(restores ?? []);
		}
		const first = await liveClaims(K1);
		expect(first).toHaveLength(1);
		expect(await liveClaims(K2)).toEqual(first);
	}, 15_000);

	it("locks the app rows of two settles that each need the other's row in one order, so neither meets a deadlock", async () => {
		// app-a holds K1 and gave K2 up; app-b holds K2 and gave K1 up. Each
		// settle takes a different advisory lock, so only the row order keeps
		// them from a cycle. These transactions do not start again on a
		// deadlock, as `withAppTx` does, so one would surface here.
		await seedPublishing("app-a", K1, { deleted: true });
		await seedPublishing("app-a", K2, { deleted: true, released: true });
		await seedPublishing("app-b", K2, { deleted: true });
		await seedPublishing("app-b", K1, { deleted: true, released: true });
		const first = createPerTestAppDb(h.uri());
		const second = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		const settle = (db: Kysely<AppDatabase>, appId: string) =>
			outcome(
				db
					.transaction()
					.execute((tx) => lockReleasedClaimsInTransaction(tx, appId)),
			);
		let held: Awaited<ReturnType<typeof holdAppRow>> | undefined;
		let runs: ReturnType<typeof settle>[] = [];
		try {
			await observer.connect();
			held = await holdAppRow(h.uri(), "app-a");
			await held.acquired();
			// Each settle waits for app-a's row first. Locking its own row first
			// instead, app-b's settle would hold app-b's row while it waits, and
			// app-a's settle would then wait for it holding app-a's.
			runs = [settle(first.appDb, "app-a")];
			await waitForBlockedLocks(observer, 1);
			runs.push(settle(second.appDb, "app-b"));
			await waitForBlockedLocks(observer, 2);
			await held.release();
			const [settledA, settledB] = await Promise.all(runs);
			expect(settledA?.error).toBeUndefined();
			expect(settledB?.error).toBeUndefined();
			expect(settledA?.value?.released).toEqual([
				expect.objectContaining({
					key: K2,
					holder: expect.objectContaining({ appId: "app-b", appDeleted: true }),
				}),
			]);
			expect(settledB?.value?.released).toEqual([
				expect.objectContaining({
					key: K1,
					holder: expect.objectContaining({ appId: "app-a", appDeleted: true }),
				}),
			]);
		} finally {
			await held?.end();
			await Promise.allSettled(runs);
			await observer.end();
			await first.destroy();
			await second.destroy();
		}
	}, 15_000);

	it("throws, having restored nothing, when its claims change under each of its three tries", async () => {
		// app-a gave K1 up to app-b, which is live, deleted, then live again.
		const deploymentA = await seedPublishing("app-a", K1, {
			deleted: true,
			released: true,
		});
		const deploymentB = await seedPublishing("app-b", K1);
		const before = {
			a: await appMappings(deploymentA),
			b: await appMappings(deploymentB),
		};

		await expect(
			changeUnderEachTry({
				uri: h.uri(),
				appId: "app-a",
				run: () => restoreApp("app-a", ACTOR),
				changes: [
					() => softDeleteApp("app-b", ACTOR),
					() => restoreApp("app-b", ACTOR),
					() => softDeleteApp("app-b", ACTOR),
				],
			}),
		).rejects.toBeInstanceOf(RestoreClaimsChangedError);

		expect((await h.readAppRow("app-a"))?.deleted_at).toBeInstanceOf(Date);
		expect({
			a: await appMappings(deploymentA),
			b: await appMappings(deploymentB),
		}).toEqual(before);
		expect((await deploymentRow(deploymentA)).state).toBe("uploaded");
	}, 15_000);

	it("starts again when a birth takes another of its HQ apps between its first read and its locks", async () => {
		// app-a gave K1 up to app-b, deleted too; it still holds K2.
		await seedPublishing("app-a", K1, { deleted: true, released: true });
		await seedPublishing("app-b", K1, { deleted: true });
		const deploymentA2 = await seedPublishing("app-a", K2, { deleted: true });
		await seedApp("app-c");
		const deploymentC = await seedDeployment("app-c", K2);
		const births = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		const birthHold = hold();
		let birthRun: ReturnType<typeof outcome<void>> | undefined;
		let restoreRun:
			| ReturnType<typeof outcome<Awaited<ReturnType<typeof restoreApp>>>>
			| undefined;
		try {
			await observer.connect();
			birthRun = outcome(
				births.appDb.transaction().execute(async (tx) => {
					await birth(tx, "app-c", deploymentC, K2);
					birthHold.enter();
					await birthHold.released;
				}),
			);
			await Promise.race([
				birthHold.entered,
				birthRun.then((result) => {
					throw new Error("The birth ended before it held", { cause: result });
				}),
			]);
			// The restore read only K1, took its lock, and waits on app-a's row.
			restoreRun = outcome(restoreApp("app-a", ACTOR));
			await waitForBlockedLocks(observer, 1);
			birthHold.release();
			expect(await birthRun).toEqual({ value: undefined });
			expect(await restoreRun).toEqual({
				value: {
					stoppedPublishing: [{ server: "production", domain: "beta" }],
				},
			});
		} finally {
			birthHold.release();
			await Promise.allSettled([birthRun, restoreRun]);
			await observer.end();
			await births.destroy();
		}
		expect(await liveClaims(K1)).toEqual(["app-a"]);
		expect(await liveClaims(K2)).toEqual(["app-c"]);
		expect((await deploymentRow(deploymentA2)).state).toBe("ended");
	}, 15_000);

	it("answers null from its locks when what it read before them changed under them", async () => {
		await seedPublishing("app-a", K1, { deleted: true, released: true });
		await seedPublishing("app-b", K1, { deleted: true });
		await seedPublishing("app-a", K2, { deleted: true });
		await seedApp("app-c");
		const deploymentC = await seedDeployment("app-c", K2);
		const births = createPerTestAppDb(h.uri());
		const locks = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		const birthHold = hold();
		let birthRun: ReturnType<typeof outcome<void>> | undefined;
		let lockRun:
			| ReturnType<
					typeof outcome<
						Awaited<ReturnType<typeof lockReleasedClaimsInTransaction>>
					>
			  >
			| undefined;
		try {
			await observer.connect();
			birthRun = outcome(
				births.appDb.transaction().execute(async (tx) => {
					await birth(tx, "app-c", deploymentC, K2);
					birthHold.enter();
					await birthHold.released;
				}),
			);
			await Promise.race([
				birthHold.entered,
				birthRun.then((result) => {
					throw new Error("The birth ended before it held", { cause: result });
				}),
			]);
			lockRun = outcome(
				locks.appDb
					.transaction()
					.execute((tx) => lockReleasedClaimsInTransaction(tx, "app-a")),
			);
			await waitForBlockedLocks(observer, 1);
			birthHold.release();
			expect(await birthRun).toEqual({ value: undefined });
			expect(await lockRun).toEqual({ value: null });
		} finally {
			birthHold.release();
			await Promise.allSettled([birthRun, lockRun]);
			await observer.end();
			await births.destroy();
			await locks.destroy();
		}
	}, 15_000);
});
