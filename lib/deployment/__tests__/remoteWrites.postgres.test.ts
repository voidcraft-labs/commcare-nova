/**
 * Writes Nova lets out to CommCare HQ, in real Postgres: an admission is
 * recorded under the locks every transition that would let another Nova app
 * write there takes too, so the two commit in one order or the other and
 * each order is safe. Concurrent cases hold one transaction at a database
 * gate (a trigger waiting on a session advisory lock) and release it by hand;
 * the database's own lock table says when the other transaction is waiting.
 */

import { createHash } from "node:crypto";
import { sql } from "kysely";
import { Client } from "pg";
import { v7 } from "uuid";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { holdAppRow, waitForBlockedLocks } from "@/lib/db/__tests__/heldAppRow";
import {
	prepareAppProjectMove,
	restoreApp,
	softDeleteApp,
} from "@/lib/db/apps";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import {
	claimHqAppInTransaction,
	HqAppAlreadyClaimedError,
	type HqAppKey,
	HqAppWriteInFlightError,
} from "@/lib/db/hqAppClaims";
import { openRemoteWrite } from "@/lib/db/openRemoteWrite";
import { withAppTx } from "@/lib/db/pg";
import {
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { LookupError } from "@/lib/lookup/errors";
import {
	createManagedLookupTablesInTransaction,
	type ManagedLookupContent,
	type ManagedOriginWrite,
	readManagedTableReview,
	refreshManagedLookupTableInTransaction,
} from "@/lib/lookup/managed";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import { handBackWhilePublishing } from "@/lib/publish/managedData";
import { DeploymentEndedError } from "../errors";
import {
	activeRemoteApp,
	deploymentEnding,
	leftBehindResources,
} from "../resources";
import {
	type AdmittedRecord,
	admitAppCreate,
	admitAppWrite,
	admitPlacesWrite,
	admitWorkbookWrite,
	beginDeploymentContentWrite,
	type DeploymentScope,
	endDeployment,
	finishDeploymentContentWrite,
	markResourceBaselinesUnread,
	type RecordAnswer,
	type RecordRemoteResourceInput,
	readAppBaseline,
	readDeployment,
	readEntryPointEvidence,
	recordCreatedRemoteApp,
	recordDeploymentMediaFiles,
	recordOrphanedRemoteApp,
	recordPushedResources,
	recordRemoteResource,
	recordWorkerLevelConfirmations,
	settleReleasedClaims,
	settleRemoteWrites,
} from "../store";
import type { AppBaselineWrite } from "../types";
import {
	type AdoptedBirth,
	appMappingToken,
	birthAdoptedApp,
} from "./adoptedBirth";
import { readable } from "./readableRecord";

const h = setupAppStateTestDb("remote_writes_", {
	authSchema: "migrated",
	poolMax: 4,
});

const OWNER = "writes-owner";
const PROJECT = "project-writes";
const TARGET = { server: "production" as const, domain: "clinic" };
const HQ_APP = "d".repeat(32);
const KEY: HqAppKey = { ...TARGET, remoteAppId: HQ_APP };
const APP = testUuid("publishing-app");
const OTHER = testUuid("other-app");

async function born(appId = APP): Promise<AdoptedBirth> {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	return birthAdoptedApp(h, {
		appId,
		projectId: PROJECT,
		actorUserId: OWNER,
		target: TARGET,
		remoteAppId: HQ_APP,
	});
}

/** What a birth of another Nova app does first: take the HQ app's claim. */
function claim(): Promise<void> {
	return withAppTx((tx) => claimHqAppInTransaction(tx, KEY));
}

async function openWrites(): Promise<number> {
	const rows = await h
		.db()
		.selectFrom("hq_remote_writes")
		.select("id")
		.where(openRemoteWrite)
		.execute();
	return rows.length;
}

/** Make the gate's session hold `gateKey`, and every insert into or update of `table` wait for it. */
async function gate(
	client: Client,
	gateKey: number,
	table: "hq_remote_writes" | "app_deployment_resources",
	event: "INSERT" | "UPDATE",
): Promise<void> {
	await client.query("SELECT pg_advisory_lock($1)", [gateKey]);
	await client.query(`
		CREATE FUNCTION test_gate_${table}() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(${gateKey});
			RETURN NEW;
		END
		$$;
		CREATE TRIGGER test_gate_${table}_trigger
			BEFORE ${event} ON ${table}
			FOR EACH ROW EXECUTE FUNCTION test_gate_${table}();
	`);
}

// Attach both handlers before waiting on a database fence so an early failure
// stays observable without becoming an unhandled rejection.
function outcome<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value }) as { value: T; error?: undefined },
		(error: unknown) => ({ error }) as { value?: undefined; error: unknown },
	);
}

const fence = { expectedEndings: 0 } as const;

describe("an admitted write and an ending", () => {
	it("lets a write admitted before the ending go, and grants the HQ app to no other Nova app until it settles", async () => {
		const birth = await born();
		const client = new Client({ connectionString: h.uri() });
		let admission:
			| ReturnType<typeof outcome<Awaited<ReturnType<typeof admitAppWrite>>>>
			| undefined;
		let ending: ReturnType<typeof outcome<unknown>> | undefined;
		try {
			await client.connect();
			await gate(client, 9_301_001, "hq_remote_writes", "INSERT");
			admission = outcome(
				admitAppWrite(birth.scope, TARGET, {
					compiledIdentity: birth.targetIdentity,
					observedPushToken: appMappingToken(birth.deployment),
					...fence,
					remoteAppId: HQ_APP,
					writeKind: "import",
					compiledAtSeq: 1,
				}),
			);
			// The admission holds the deployment row and waits at its insert.
			await waitForBlockedLocks(client, 1);
			ending = outcome(endDeployment(birth.scope, TARGET, HQ_APP));
			// The ending waits for the deployment row the admission holds.
			await waitForBlockedLocks(client, 2);
			await client.query("SELECT pg_advisory_unlock($1)", [9_301_001]);
			const admitted = await admission;
			expect(admitted.value).toMatchObject({ kind: "admitted" });
			expect((await ending).error).toBeUndefined();
		} finally {
			await client.end();
			await Promise.allSettled([admission, ending]);
		}

		/* The ending landed after the admission: the write may still change
		 * the HQ app, so no other Nova app is granted it. */
		const refused = await outcome(claim());
		expect(refused.error).toBeInstanceOf(HqAppWriteInFlightError);
		expect(await openWrites()).toBe(1);

		const admitted = (await admission)?.value;
		if (admitted?.kind !== "admitted") throw new Error("Expected an admission");
		await settleRemoteWrites([admitted.writeId], { kind: "settled" });
		await claim();
	}, 15_000);

	it("refuses a write the ending committed before, recording nothing, and the HQ app is free at once", async () => {
		const birth = await born();
		const client = new Client({ connectionString: h.uri() });
		let ending: ReturnType<typeof outcome<unknown>> | undefined;
		let admission:
			| ReturnType<typeof outcome<Awaited<ReturnType<typeof admitAppWrite>>>>
			| undefined;
		try {
			await client.connect();
			await gate(client, 9_301_002, "app_deployment_resources", "UPDATE");
			ending = outcome(endDeployment(birth.scope, TARGET, HQ_APP));
			// The ending holds the deployment row and waits at its supersede.
			await waitForBlockedLocks(client, 1);
			admission = outcome(
				admitAppWrite(birth.scope, TARGET, {
					compiledIdentity: birth.targetIdentity,
					observedPushToken: appMappingToken(birth.deployment),
					...fence,
					remoteAppId: HQ_APP,
					writeKind: "import",
					compiledAtSeq: 1,
				}),
			);
			// The admission waits for the deployment row the ending holds.
			await waitForBlockedLocks(client, 2);
			await client.query("SELECT pg_advisory_unlock($1)", [9_301_002]);
			expect((await ending).error).toBeUndefined();
			expect((await admission).error).toBeInstanceOf(DeploymentEndedError);
		} finally {
			await client.end();
			await Promise.allSettled([ending, admission]);
		}
		expect(await openWrites()).toBe(0);
		await claim();
	}, 15_000);

	it("makes a claim of the HQ app wait for an admission in progress, and then meet the mapping it admitted under", async () => {
		const birth = await born();
		const client = new Client({ connectionString: h.uri() });
		let admission: ReturnType<typeof outcome<unknown>> | undefined;
		let taking: ReturnType<typeof outcome<void>> | undefined;
		try {
			await client.connect();
			await gate(client, 9_301_003, "hq_remote_writes", "INSERT");
			admission = outcome(
				admitAppWrite(birth.scope, TARGET, {
					compiledIdentity: birth.targetIdentity,
					observedPushToken: appMappingToken(birth.deployment),
					...fence,
					remoteAppId: HQ_APP,
					writeKind: "media",
				}),
			);
			await waitForBlockedLocks(client, 1);
			taking = outcome(claim());
			// The claim waits on the HQ app's advisory lock the admission holds.
			await waitForBlockedLocks(client, 2);
			await client.query("SELECT pg_advisory_unlock($1)", [9_301_003]);
			expect((await admission).error).toBeUndefined();
			expect((await taking).error).toBeInstanceOf(HqAppAlreadyClaimedError);
		} finally {
			await client.end();
			await Promise.allSettled([admission, taking]);
		}
	}, 15_000);
});

describe("an admitted write and a claim taken from an app in recently deleted", () => {
	it("leaves a deleted holder's mapping to it while its write is open, and releases it once the write settles", async () => {
		const birth = await born();
		const admitted = await admitAppWrite(birth.scope, TARGET, {
			compiledIdentity: birth.targetIdentity,
			observedPushToken: appMappingToken(birth.deployment),
			...fence,
			remoteAppId: HQ_APP,
			writeKind: "import",
			compiledAtSeq: 1,
		});
		if (admitted.kind !== "admitted") throw new Error("Expected an admission");
		await softDeleteApp(APP, OWNER);

		expect((await outcome(claim())).error).toBeInstanceOf(
			HqAppWriteInFlightError,
		);
		const mapping = await h
			.db()
			.selectFrom("app_deployment_resources")
			.select("released_at")
			.where("kind", "=", "app")
			.executeTakeFirstOrThrow();
		expect(mapping.released_at).toBeNull();

		await settleRemoteWrites([admitted.writeId], { kind: "settled" });
		await claim();
	});

	it("admits nothing for an app in recently deleted, so a claim taken first is never written over", async () => {
		const birth = await born();
		await softDeleteApp(APP, OWNER);
		await claim();
		await expect(
			admitAppWrite(birth.scope, TARGET, {
				compiledIdentity: birth.targetIdentity,
				observedPushToken: appMappingToken(birth.deployment),
				...fence,
				remoteAppId: HQ_APP,
				writeKind: "import",
				compiledAtSeq: 1,
			}),
		).rejects.toMatchObject({ name: "DeploymentError", code: "not_found" });
		expect(await openWrites()).toBe(0);
	});

	it("keeps a restored app's claim released while the app that took it has a write open, and admits none of its own", async () => {
		const birth = await born();
		await softDeleteApp(APP, OWNER);
		const taker = await birthAdoptedApp(h, {
			appId: OTHER,
			projectId: PROJECT,
			actorUserId: OWNER,
			target: { server: "production", domain: "clinic" },
			remoteAppId: HQ_APP,
		});
		const takerWrite = await admitAppWrite(taker.scope, TARGET, {
			compiledIdentity: taker.targetIdentity,
			observedPushToken: appMappingToken(taker.deployment),
			...fence,
			remoteAppId: HQ_APP,
			writeKind: "media",
		});
		if (takerWrite.kind !== "admitted")
			throw new Error("Expected an admission");
		await softDeleteApp(OTHER, OWNER);

		/* The restore cannot take the HQ app back yet: it stays released. */
		await expect(restoreApp(APP, OWNER)).resolves.toEqual({
			stoppedPublishing: [],
		});
		const restored = await readDeployment(birth.scope, TARGET);
		expect(activeRemoteApp(restored ?? fail())?.releasedAt).not.toBeNull();
		expect(await settleReleasedClaims(birth.scope)).toEqual({
			settled: true,
			stoppedPublishing: [],
			waiting: [{ server: "production", domain: "clinic" }],
		});
		/* A write of the restored app to the HQ app it gave up is no write. */
		expect(
			await admitAppWrite(birth.scope, TARGET, {
				compiledIdentity: birth.targetIdentity,
				observedPushToken: appMappingToken(birth.deployment),
				...fence,
				remoteAppId: HQ_APP,
				writeKind: "import",
				compiledAtSeq: 1,
			}),
		).toEqual({ kind: "mapping-moved" });

		await settleRemoteWrites([takerWrite.writeId], { kind: "settled" });
		expect(await settleReleasedClaims(birth.scope)).toEqual({
			settled: true,
			stoppedPublishing: [],
			waiting: [],
		});
		const back = await readDeployment(birth.scope, TARGET);
		expect(activeRemoteApp(back ?? fail())?.releasedAt).toBeNull();
	});
});

describe("how a write settles", () => {
	it("holds an unanswered write open for its grace, and a media job HQ accepted with its id, and settles an answered one at once", async () => {
		const birth = await born();
		const ids: string[] = [];
		for (const writeKind of ["import", "media", "import"] as const) {
			const admitted = await admitAppWrite(birth.scope, TARGET, {
				compiledIdentity: birth.targetIdentity,
				observedPushToken: appMappingToken(birth.deployment),
				...fence,
				remoteAppId: HQ_APP,
				compiledAtSeq: 1,
				writeKind,
			});
			if (admitted.kind !== "admitted")
				throw new Error("Expected an admission");
			ids.push(admitted.writeId);
		}
		const [unanswered, media, answered] = ids;
		if (
			unanswered === undefined ||
			media === undefined ||
			answered === undefined
		)
			throw new Error("Expected three writes");
		await settleRemoteWrites([unanswered], { kind: "unanswered" });
		await settleRemoteWrites([media], { kind: "media-job", jobId: "job-1" });
		await settleRemoteWrites([answered], { kind: "settled" });

		const rows = await h
			.db()
			.selectFrom("hq_remote_writes")
			.select([
				"id",
				"settled_at",
				"hq_job_id",
				sql<number>`(extract(epoch from held_until - now()) / 60)::float8`.as(
					"minutes_held",
				),
			])
			.execute();
		const byId = new Map(rows.map((row) => [row.id, row]));
		const row = (id: string) => byId.get(id) ?? fail();
		expect(row(unanswered).settled_at).toBeNull();
		expect(row(unanswered).minutes_held).toBeGreaterThan(4);
		expect(row(unanswered).minutes_held).toBeLessThanOrEqual(5);
		expect(row(media).settled_at).toBeNull();
		expect(row(media).minutes_held).toBeGreaterThan(59);
		expect(row(media).hq_job_id).toBe("job-1");
		expect(row(answered).settled_at).not.toBeNull();
		expect(await openWrites()).toBe(2);
	});
});

describe("a Project move during a publish", () => {
	it("waits while the app has a write open, and goes on once it settles", async () => {
		const birth = await born();
		const admitted = await admitAppWrite(birth.scope, TARGET, {
			compiledIdentity: birth.targetIdentity,
			observedPushToken: appMappingToken(birth.deployment),
			...fence,
			remoteAppId: HQ_APP,
			writeKind: "import",
			compiledAtSeq: 1,
		});
		if (admitted.kind !== "admitted") throw new Error("Expected an admission");
		const move = {
			appId: APP,
			toProjectId: "project-elsewhere",
			expectedFromProjectId: PROJECT,
			actorUserId: OWNER,
		};
		const refused = await outcome(prepareAppProjectMove(move));
		expect(refused.error).toBeInstanceOf(BlueprintCommitRejectedError);
		expect((refused.error as Error).message).toBe(
			"Nova is publishing this app or making its workers in CommCare HQ right now, so it can't move to another Project yet. You can try again in a few minutes.",
		);

		await settleRemoteWrites([admitted.writeId], { kind: "settled" });
		const after = await outcome(prepareAppProjectMove(move));
		expect((after.error as Error | undefined)?.message).not.toBe(
			(refused.error as Error).message,
		);
	});

	it("goes on once the write settled, though its transaction began before the settle", async () => {
		const birth = await born();
		const admitted = await admitAppWrite(birth.scope, TARGET, {
			compiledIdentity: birth.targetIdentity,
			observedPushToken: appMappingToken(birth.deployment),
			...fence,
			remoteAppId: HQ_APP,
			writeKind: "import",
			compiledAtSeq: 1,
		});
		if (admitted.kind !== "admitted") throw new Error("Expected an admission");
		const held = await holdAppRow(h.uri(), APP);
		const observer = new Client({ connectionString: h.uri() });
		let moving: ReturnType<typeof outcome<unknown>> | undefined;
		try {
			await held.acquired();
			await observer.connect();
			moving = outcome(
				prepareAppProjectMove({
					appId: APP,
					toProjectId: "project-elsewhere",
					expectedFromProjectId: PROJECT,
					actorUserId: OWNER,
				}),
			);
			/* The move's transaction has begun, and its clock with it: it waits
			 * for the app row while the write settles. */
			await waitForBlockedLocks(observer, 1);
			await settleRemoteWrites([admitted.writeId], { kind: "settled" });
			await held.release();
			const moved = await moving;
			expect((moved.error as Error | undefined)?.message).not.toBe(
				"Nova is publishing this app or making its workers in CommCare HQ right now, so it can't move to another Project yet. You can try again in a few minutes.",
			);
		} finally {
			await observer.end();
			await held.end();
			await Promise.allSettled([moving]);
		}
	}, 15_000);

	it("holds an unanswered create of a new HQ app as a write of the app", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET, HQ_APP);
		await admitAppCreate(birth.scope, TARGET, { expectedEndings: 1 });
		const refused = await outcome(
			prepareAppProjectMove({
				appId: APP,
				toProjectId: "project-elsewhere",
				expectedFromProjectId: PROJECT,
				actorUserId: OWNER,
			}),
		);
		expect(refused.error).toBeInstanceOf(BlueprintCommitRejectedError);
	});
});

describe("two publishes of one HQ app", () => {
	function unread(remoteAppId: string): AppBaselineWrite {
		return {
			origin: "unread",
			remoteAppId,
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: "2026-11-12T00:00:00.000Z",
			discard: null,
			novaRevision: null,
			mediaFiles: { kind: "keep" },
			firstPublish: { kind: "set", list: null },
		};
	}

	function pushed(
		scope: DeploymentScope,
		pushedRevision: number,
		remoteRevision: number | null,
		writeId: string,
	) {
		return recordRemoteResource(
			scope,
			TARGET,
			{
				...fence,
				kind: "app",
				novaResourceId: scope.appId,
				remoteId: HQ_APP,
				ownership: "adopted",
				adoptedBy: OWNER,
				pushedRevision,
				remoteRevision,
				uploadedAt: "2026-11-12T00:00:00.000Z",
				baseline: unread(HQ_APP),
			},
			{
				writeIds: [writeId],
				settle: [{ writeIds: [writeId], how: { kind: "settled" } }],
			},
		).then(readable);
	}

	it("retires completed links and refuses a resumed manifest or direct record across a reclaim", async () => {
		const birth = await born();
		const write = await admitAppWrite(birth.scope, TARGET, {
			compiledIdentity: birth.targetIdentity,
			...fence,
			remoteAppId: HQ_APP,
			observedPushToken: appMappingToken(birth.deployment),
			writeKind: "import",
			compiledAtSeq: 3,
		});
		if (write.kind !== "admitted")
			throw new Error("Expected a live import admission.");
		const generation = await beginDeploymentContentWrite(
			birth.scope,
			TARGET,
			fence,
		);
		await pushed(birth.scope, 3, 43, write.writeId);
		const manifest = {
			generation,
			remoteAppId: HQ_APP,
			sourceSequence: 3,
			entries: [],
			dependencies: [],
		};
		const admitted = { writeIds: [write.writeId], settle: [] };
		expect(
			await finishDeploymentContentWrite(
				birth.scope,
				TARGET,
				generation,
				manifest,
				fence,
				admitted,
			),
		).toBe(true);
		await softDeleteApp(APP, OWNER);
		await born(OTHER);
		await softDeleteApp(OTHER, OWNER);
		await restoreApp(APP, OWNER);
		const evidence = await readEntryPointEvidence(birth.scope, TARGET);
		expect(evidence.manifest).toBeNull();
		expect(evidence.generation).not.toBe(generation);
		expect(
			await finishDeploymentContentWrite(
				birth.scope,
				TARGET,
				generation,
				manifest,
				fence,
				admitted,
			),
		).toBe(false);
		// Even the current content generation is insufficient evidence for
		// the previous claim's admission or a direct writer without one.
		for (const record of [admitted, undefined]) {
			const current = await readEntryPointEvidence(birth.scope, TARGET);
			if (!current.generation)
				throw new Error(
					"The claim transition must retain a content generation.",
				);
			expect(
				await finishDeploymentContentWrite(
					birth.scope,
					TARGET,
					current.generation,
					{ ...manifest, generation: current.generation },
					fence,
					record,
				),
			).toBe(false);
			expect(
				(await readEntryPointEvidence(birth.scope, TARGET)).manifest,
			).toBeNull();
			const result = await recordRemoteResource(
				birth.scope,
				TARGET,
				{
					...fence,
					kind: "app",
					novaResourceId: APP,
					remoteId: HQ_APP,
					ownership: "adopted",
					adoptedBy: OWNER,
					pushedRevision: 5,
					remoteRevision: 45,
					uploadedAt: new Date().toISOString(),
					baseline: unread(HQ_APP),
				},
				record,
			);
			expect(result).toMatchObject({ obsoleteClaim: true, pushToken: null });
		}
		expect(
			activeRemoteApp((await readDeployment(birth.scope, TARGET)) ?? fail())
				?.remoteRevision,
		).toBe(43);
	});
	it("records them in CommCare HQ's save order, whichever commits last", async () => {
		const birth = await born();
		const observed = appMappingToken(await readDeployment(birth.scope, TARGET));
		const admit = async () => {
			const admission = await admitAppWrite(birth.scope, TARGET, {
				compiledIdentity: birth.targetIdentity,
				...fence,
				remoteAppId: HQ_APP,
				observedPushToken: observed,
				writeKind: "import",
				compiledAtSeq: 3,
			});
			if (admission.kind !== "admitted")
				throw new Error("Expected both imports to hold this claim.");
			return admission.writeId;
		};
		const first = await admit(),
			second = await admit(),
			third = await admit();
		/* The second publish's import acknowledged 43 and recorded first; the
		 * first's acknowledged 42 and records after it. */
		await pushed(birth.scope, 3, 43, second);
		const afterLater = await readDeployment(birth.scope, TARGET);
		const recorded = await pushed(birth.scope, 2, 42, first);
		expect(recorded).toEqual(afterLater);
		expect(activeRemoteApp(recorded)).toMatchObject({
			pushedRevision: 3,
			remoteRevision: 43,
		});
		const row = await h
			.db()
			.selectFrom("app_deployment_resources")
			.select(["pushed_revision", "pushed_remote_revision"])
			.where("kind", "=", "app")
			.where("superseded_at", "is", null)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ pushed_revision: "3", pushed_remote_revision: "43" });

		/* A later save of HQ's records over it. */
		await pushed(birth.scope, 4, 44, third);
		expect(
			activeRemoteApp((await readDeployment(birth.scope, TARGET)) ?? fail()),
		).toMatchObject({
			pushedRevision: 4,
		});
	});
});

describe("the empty app a create made as the deployment was ended", () => {
	it("is named as left behind, beside the ending that still stands", async () => {
		const birth = await born();
		const startedAt = new Date();
		await endDeployment(birth.scope, TARGET, HQ_APP);
		const shell = "e".repeat(32);
		await recordOrphanedRemoteApp(birth.scope, TARGET, {
			remoteId: shell,
			publishStartedAt: startedAt,
		});
		const view = (await readDeployment(birth.scope, TARGET)) ?? fail();
		expect(deploymentEnding(view)).toMatchObject({
			reason: "stopped",
			hqAppId: HQ_APP,
		});
		expect(leftBehindResources(view, new Map())).toEqual([
			expect.objectContaining({ kind: "app", remoteId: shell }),
		]);
		/* Recorded once. */
		await recordOrphanedRemoteApp(birth.scope, TARGET, {
			remoteId: shell,
			publishStartedAt: startedAt,
		});
		expect(
			((await readDeployment(birth.scope, TARGET)) ?? fail()).superseded,
		).toHaveLength(2);
	});
});

/* The lookup table every workbook case writes, and its hand-back. */
const CONTENT: ManagedLookupContent = {
	fields: ["name", "code"],
	rows: [{ name: "Alpha", code: "001" }],
};
const ORIGIN: ManagedOriginWrite = (() => {
	const content = {
		fields: CONTENT.fields.map((name) => ({ name, properties: [] })),
		rowCount: CONTENT.rows.length,
		rows: CONTENT.rows,
	};
	return {
		server: TARGET.server,
		domain: TARGET.domain,
		remoteId: "hq-table-1",
		canonical: {
			remoteId: "hq-table-1",
			...content,
			digest: createHash("sha256")
				.update(JSON.stringify(content))
				.digest("hex"),
		},
	};
})();
const AT = new Date("2026-11-01T09:30:00.000Z");
const LATER = new Date("2026-11-02T10:00:00.000Z");
const writer = { projectId: PROJECT, actorId: OWNER };

/** A table brought in from the target, then managed in Nova. */
async function managedInNova(): Promise<LookupTableId> {
	const tableId = lookupTableIdSchema.parse(v7());
	await withAppTx(async (tx) =>
		createManagedLookupTablesInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, writer, "edit"),
			[
				{
					binding: {
						tag: "districts",
						tableId,
						columns: Object.fromEntries(
							CONTENT.fields.map((field) => [
								field,
								lookupColumnIdSchema.parse(v7()),
							]),
						),
					},
					name: "Districts",
					content: CONTENT,
					origin: ORIGIN,
				},
			],
			AT,
		),
	);
	await h
		.db()
		.updateTable("lookup_tables")
		.set({ hq_taken_over_at: AT, hq_taken_over_by: OWNER })
		.where("id", "=", tableId)
		.execute();
	return tableId;
}

/** The hand-back, over the table as it stands when it is asked for. */
async function handBack(tableId: LookupTableId) {
	const reviewed = await readManagedTableReview(PROJECT, tableId);
	if (reviewed === null) throw new Error("Expected a managed table");
	return withAppTx(async (tx) =>
		refreshManagedLookupTableInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, writer, "delete"),
			{
				tableId,
				content: CONTENT,
				origin: ORIGIN,
				at: LATER,
				mode: "adopt",
				reviewed,
				olderReadYields: true,
			},
		),
	);
}

describe("a workbook and the hand-back of a table it carries", () => {
	it("refuses a hand-back while an admitted workbook carrying the table is open, leaving the table as it was", async () => {
		const birth = await born();
		const tableId = await managedInNova();
		const admitted = await admitWorkbookWrite(birth.scope, TARGET, {
			...fence,
			tableIds: [tableId],
		});
		if (admitted.kind !== "admitted") throw new Error("Expected an admission");

		const refused = await outcome(handBack(tableId));
		expect(refused.error).toBeInstanceOf(LookupError);
		expect(refused.error).toMatchObject({
			code: "conflict",
			message: handBackWhilePublishing("clinic"),
		});
		const table = await h
			.db()
			.selectFrom("lookup_tables")
			.select("hq_taken_over_at")
			.where("id", "=", tableId)
			.executeTakeFirstOrThrow();
		expect(table.hq_taken_over_at).toEqual(AT);

		await settleRemoteWrites(admitted.writeIds, { kind: "settled" });
		await handBack(tableId);
	});

	it("refuses the workbook of a table handed back first, recording nothing", async () => {
		const birth = await born();
		const tableId = await managedInNova();
		await handBack(tableId);
		expect(
			await admitWorkbookWrite(birth.scope, TARGET, {
				...fence,
				tableIds: [tableId],
			}),
		).toEqual({ kind: "handed-back", tags: ["districts"] });
		expect(await openWrites()).toBe(0);
	});
});

/* Between a write's admission and its record the write lands on CommCare HQ.
 * An app deleted, or a publisher who lost edit or left the Project, in that
 * time must still have what the write made recorded, or the next publish
 * meets Nova's own app, table or place as a stranger's; a restored app holds
 * the record. The record answers its caller only what they may read then:
 * what their write made, and the deployment only to a caller who may still
 * view it. */
describe("what a publish's admitted writes made, recorded on their admissions", () => {
	const SHELL = "f".repeat(32);
	const PLACE = testUuid("pushed-place");
	const EARLIER_PLACE = testUuid("earlier-place");

	type Loss = "deleted" | "demoted" | "removed";
	const LOSS_WORDS: Record<Loss, string> = {
		deleted: "the app was deleted",
		demoted: "the publisher could only view the Project",
		removed: "the publisher was removed from the Project",
	};
	async function lose(loss: Loss): Promise<void> {
		if (loss === "deleted") await softDeleteApp(APP, OWNER);
		else if (loss === "demoted")
			await h.seedProjectMember(OWNER, PROJECT, "viewer");
		else await h.removeProjectMember(OWNER, PROJECT);
	}

	/** Another member, whose name the deployment's record holds. */
	const COLLEAGUE = "writes-colleague";
	async function colleagueConfirms(
		birth: AdoptedBirth,
	): Promise<DeploymentScope> {
		await h.seedProjectMember(COLLEAGUE, PROJECT, "editor");
		const scope = { ...birth.scope, actorUserId: COLLEAGUE, role: "editor" };
		await recordWorkerLevelConfirmations(scope, TARGET, ["district"], fence);
		return scope;
	}
	async function regain(loss: Loss): Promise<void> {
		if (loss === "deleted") await restoreApp(APP, OWNER);
		else await h.seedProjectMember(OWNER, PROJECT, "owner");
	}

	function unreadBaseline(remoteAppId: string): AppBaselineWrite {
		return {
			origin: "unread",
			remoteAppId,
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: "2026-11-12T00:00:00.000Z",
			discard: null,
			novaRevision: null,
			mediaFiles: { kind: "keep" },
			firstPublish: { kind: "set", list: null },
		};
	}

	/** The record of `writeIds`, settling them as CommCare HQ answered them. */
	function settling(
		writeIds: readonly string[],
		resourceId?: string,
	): AdmittedRecord {
		return {
			writeIds,
			settle: [
				{
					writeIds,
					how: {
						kind: "settled",
						...(resourceId !== undefined && { resourceId }),
					},
				},
			],
		};
	}

	function place(
		locationUuid: string,
		remoteId: string,
	): RecordRemoteResourceInput {
		return {
			kind: "location",
			novaResourceId: locationUuid,
			remoteId,
			ownership: "nova-created",
			pushedIdentity: `site-${remoteId}`,
			pushedRevision: null,
			remoteRevision: null,
		};
	}

	/** The live mapping of one Nova resource, as the ledger holds it. */
	function liveMapping(kind: string, novaResourceId: string) {
		return h
			.db()
			.selectFrom("app_deployment_resources")
			.select(["remote_id", "released_at", "pushed_revision", "push_token"])
			.where("kind", "=", kind)
			.where("nova_resource_id", "=", novaResourceId)
			.where("superseded_at", "is", null)
			.executeTakeFirst();
	}

	/** One write a publish let out, admitted, and the record its publish makes of it. */
	interface AdmittedPush {
		readonly writeIds: readonly string[];
		readonly kind: string;
		readonly novaResourceId: string;
		readonly remoteId: string;
		readonly record: (admitted?: AdmittedRecord) => Promise<unknown>;
	}

	const WRITES: Record<string, (birth: AdoptedBirth) => Promise<AdmittedPush>> =
		{
			"the empty app a create made": async (birth) => {
				await endDeployment(birth.scope, TARGET, HQ_APP);
				const write = await admitAppCreate(birth.scope, TARGET, {
					expectedEndings: 1,
				});
				return {
					writeIds: [write],
					kind: "app",
					novaResourceId: APP,
					remoteId: SHELL,
					record: (admitted) =>
						recordCreatedRemoteApp(
							birth.scope,
							TARGET,
							{
								remoteId: SHELL,
								baseline: unreadBaseline(SHELL),
								expectedEndings: 1,
							},
							admitted,
						),
				};
			},
			"a pushed table": async (birth) => {
				const tableId = await managedInNova();
				const admitted = await admitWorkbookWrite(birth.scope, TARGET, {
					...fence,
					tableIds: [tableId],
				});
				if (admitted.kind !== "admitted")
					throw new Error("Expected an admission");
				return {
					writeIds: admitted.writeIds,
					kind: "lookup-table",
					novaResourceId: tableId,
					remoteId: "hq-table-1",
					record: (record) =>
						recordPushedResources(
							birth.scope,
							TARGET,
							[
								{
									kind: "lookup-table",
									novaResourceId: tableId,
									remoteId: "hq-table-1",
									ownership: "nova-created",
									pushedIdentity: "districts",
									pushedRevision: null,
									remoteRevision: null,
								},
							],
							{
								status: "complete",
								kinds: ["lookup-table"],
								pushedAt: "2026-11-12T00:00:00.000Z",
							},
							{ ...fence, ...(record !== undefined && { admitted: record }) },
						),
				};
			},
			"a pushed place": async (birth) => {
				const writeIds = await admitPlacesWrite(birth.scope, TARGET, {
					...fence,
					locationUuids: [PLACE],
				});
				return {
					writeIds,
					kind: "location",
					novaResourceId: PLACE,
					remoteId: "hq-place-1",
					record: (record) =>
						recordPushedResources(
							birth.scope,
							TARGET,
							[place(PLACE, "hq-place-1")],
							{
								status: "complete",
								kinds: ["location"],
								pushedAt: "2026-11-12T00:00:00.000Z",
							},
							{ ...fence, ...(record !== undefined && { admitted: record }) },
						),
				};
			},
			"the import": async (birth) => {
				const admitted = await admitAppWrite(birth.scope, TARGET, {
					compiledIdentity: birth.targetIdentity,
					observedPushToken: appMappingToken(birth.deployment),
					...fence,
					remoteAppId: HQ_APP,
					writeKind: "import",
					compiledAtSeq: 1,
				});
				if (admitted.kind !== "admitted")
					throw new Error("Expected an admission");
				return {
					writeIds: [admitted.writeId],
					kind: "app",
					novaResourceId: APP,
					remoteId: HQ_APP,
					record: (record) =>
						recordRemoteResource(
							birth.scope,
							TARGET,
							{
								...fence,
								kind: "app",
								novaResourceId: APP,
								remoteId: HQ_APP,
								ownership: "adopted",
								adoptedBy: OWNER,
								pushedRevision: 7,
								/* The save after the birth's, which acknowledged 41. */
								remoteRevision: 42,
								uploadedAt: "2026-11-12T00:00:00.000Z",
								baseline: unreadBaseline(HQ_APP),
							},
							record,
						),
				};
			},
		};

	/** The record of `push` on its admission, naming the HQ app a create made. */
	function recordOf(push: AdmittedPush) {
		return push.record(
			settling(push.writeIds, push.remoteId === SHELL ? SHELL : undefined),
		);
	}

	async function expectRecorded(push: AdmittedPush): Promise<void> {
		const mapping = await liveMapping(push.kind, push.novaResourceId);
		expect(mapping).toMatchObject({
			remote_id: push.remoteId,
			released_at: null,
		});
		if (push.remoteId === HQ_APP) expect(mapping?.pushed_revision).toBe("7");
		expect(await openWrites()).toBe(0);
	}

	const CASES = Object.keys(WRITES).flatMap((write) =>
		(["deleted", "demoted", "removed"] as const).map(
			(loss) => [write, LOSS_WORDS[loss], loss] as const,
		),
	);

	it.each(CASES)(
		"records %s on its admission though, between the two, %s, and answers only what the publisher may read then",
		async (write, _words, loss) => {
			const birth = await born();
			const colleague = await colleagueConfirms(birth);
			const push = await (WRITES[write] ?? fail())(birth);
			await lose(loss);

			const answer = (await recordOf(push)) as RecordAnswer;
			await expectRecorded(push);

			const made = expect.objectContaining({
				kind: push.kind,
				novaResourceId: push.novaResourceId,
				remoteId: push.remoteId,
			});
			expect(answer.landed).toEqual([made]);
			if (loss === "demoted") {
				/* A viewer reads the deployment, so the record is theirs whole. */
				expect(answer.deployment?.active).toContainEqual(made);
				expect(answer.deployment?.confirmations).toContainEqual(
					expect.objectContaining({ confirmedByName: COLLEAGUE }),
				);
			} else {
				expect(answer.deployment).toBeNull();
				expect(JSON.stringify(answer)).not.toContain(COLLEAGUE);
			}
			/* Whoever may read the deployment reads it whole. */
			if (loss !== "deleted") {
				const theirs = (await readDeployment(colleague, TARGET)) ?? fail();
				expect(theirs.active).toContainEqual(made);
				expect(theirs.confirmations).toContainEqual(
					expect.objectContaining({ confirmedByName: COLLEAGUE }),
				);
			}

			await regain(loss);
			const view = (await readDeployment(birth.scope, TARGET)) ?? fail();
			expect(view.active).toContainEqual(
				expect.objectContaining({
					kind: push.kind,
					novaResourceId: push.novaResourceId,
					remoteId: push.remoteId,
				}),
			);
		},
	);

	it.each(Object.keys(WRITES))(
		"keeps %s recorded through a deletion after its record and a restore",
		async (write) => {
			const birth = await born();
			const push = await (WRITES[write] ?? fail())(birth);
			await recordOf(push);
			await softDeleteApp(APP, OWNER);
			await restoreApp(APP, OWNER);

			await expectRecorded(push);
			const view = (await readDeployment(birth.scope, TARGET)) ?? fail();
			expect(view.active).toContainEqual(
				expect.objectContaining({
					kind: push.kind,
					novaResourceId: push.novaResourceId,
					remoteId: push.remoteId,
				}),
			);
		},
	);

	it.each(Object.keys(WRITES))(
		"refuses a record of %s with no admission behind it once the app was deleted, writing nothing",
		async (write) => {
			const birth = await born();
			const push = await (WRITES[write] ?? fail())(birth);
			const before = await liveMapping(push.kind, push.novaResourceId);
			await softDeleteApp(APP, OWNER);

			await expect(push.record()).rejects.toMatchObject({
				code: "not_found",
			});
			expect(await liveMapping(push.kind, push.novaResourceId)).toEqual(before);
			expect(await openWrites()).toBe(push.writeIds.length);
		},
	);

	it("refuses a record on another member's admission once the app was deleted, leaving their write open", async () => {
		const birth = await born();
		await h.seedProjectMember("writes-editor", PROJECT, "editor");
		const theirs = await admitAppWrite(
			{ ...birth.scope, actorUserId: "writes-editor", role: "editor" },
			TARGET,
			{
				...fence,
				compiledIdentity: birth.targetIdentity,
				observedPushToken: appMappingToken(birth.deployment),
				remoteAppId: HQ_APP,
				writeKind: "import",
				compiledAtSeq: 1,
			},
		);
		if (theirs.kind !== "admitted") throw new Error("Expected an admission");
		await softDeleteApp(APP, OWNER);

		await expect(
			recordRemoteResource(
				birth.scope,
				TARGET,
				{
					...fence,
					kind: "app",
					novaResourceId: APP,
					remoteId: HQ_APP,
					ownership: "adopted",
					adoptedBy: OWNER,
					pushedRevision: 7,
					remoteRevision: 42,
					uploadedAt: "2026-11-12T00:00:00.000Z",
					baseline: unreadBaseline(HQ_APP),
				},
				settling([theirs.writeId]),
			),
		).rejects.toMatchObject({ code: "not_found" });
		expect((await liveMapping("app", APP))?.pushed_revision).not.toBe("7");
		expect(await openWrites()).toBe(1);
	});

	it("grants no HQ app on the project space to another Nova app while a create there names none, and leaves a deleted app holding the one its record names", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET, HQ_APP);
		const create = await admitAppCreate(birth.scope, TARGET, {
			expectedEndings: 1,
		});
		const shell: HqAppKey = { ...TARGET, remoteAppId: SHELL };
		const taking = () => withAppTx((tx) => claimHqAppInTransaction(tx, shell));

		/* CommCare HQ may have made this very app: until the create's record
		 * names it, no other Nova app takes it. */
		expect((await outcome(taking())).error).toBeInstanceOf(
			HqAppWriteInFlightError,
		);
		await softDeleteApp(APP, OWNER);
		await recordCreatedRemoteApp(
			birth.scope,
			TARGET,
			{ remoteId: SHELL, baseline: unreadBaseline(SHELL), expectedEndings: 1 },
			settling([create], SHELL),
		);
		const recorded = await h
			.db()
			.selectFrom("hq_remote_writes")
			.select(["resource_id", "settled_at"])
			.where("id", "=", create)
			.executeTakeFirstOrThrow();
		expect(recorded.resource_id).toBe(SHELL);
		expect(recorded.settled_at).not.toBeNull();
		expect(await openWrites()).toBe(0);

		/* The deleted app holds it as it holds every HQ app it published to:
		 * another app's claim releases it, and the restore takes it back. */
		expect(await liveMapping("app", APP)).toMatchObject({
			remote_id: SHELL,
			released_at: null,
		});
		await taking();
		expect((await liveMapping("app", APP))?.released_at).not.toBeNull();
		await restoreApp(APP, OWNER);
		expect((await liveMapping("app", APP))?.released_at).toBeNull();
	});

	it("records what a push made after an ending as a push that stopped, superseding nothing and folding no rung", async () => {
		const birth = await born();
		await recordPushedResources(
			birth.scope,
			TARGET,
			[place(EARLIER_PLACE, "hq-place-0")],
			{ status: "partial" },
			fence,
		);
		const writeIds = await admitPlacesWrite(birth.scope, TARGET, {
			...fence,
			locationUuids: [PLACE],
		});
		await endDeployment(birth.scope, TARGET, HQ_APP);
		const complete = {
			status: "complete",
			kinds: ["location"],
			pushedAt: "2026-11-12T00:00:00.000Z",
		} as const;

		/* With no admission behind it, the ending refuses it. */
		await expect(
			recordPushedResources(
				birth.scope,
				TARGET,
				[place(PLACE, "hq-place-1")],
				complete,
				fence,
			),
		).rejects.toBeInstanceOf(DeploymentEndedError);

		const view = await recordPushedResources(
			birth.scope,
			TARGET,
			[place(PLACE, "hq-place-1")],
			complete,
			{ ...fence, admitted: settling(writeIds) },
		).then(readable);
		expect(view.deployment.state).toBe("ended");
		expect(
			view.active
				.filter((resource) => resource.kind === "location")
				.map((resource) => resource.remoteId)
				.sort(),
		).toEqual(["hq-place-0", "hq-place-1"]);
		expect(await openWrites()).toBe(0);
	});

	it("holds a batch whose answer never came open for its grace, though its record landed", async () => {
		const birth = await born();
		const writeIds = await admitPlacesWrite(birth.scope, TARGET, {
			...fence,
			locationUuids: [PLACE],
		});
		await recordPushedResources(
			birth.scope,
			TARGET,
			[],
			{ status: "partial" },
			{
				...fence,
				admitted: {
					writeIds,
					settle: [{ writeIds, how: { kind: "unanswered" } }],
				},
			},
		);
		const row = await h
			.db()
			.selectFrom("hq_remote_writes")
			.select([
				"settled_at",
				sql<number>`(extract(epoch from held_until - now()) / 60)::float8`.as(
					"minutes_held",
				),
			])
			.where("id", "in", [...writeIds])
			.executeTakeFirstOrThrow();
		expect(row.settled_at).toBeNull();
		expect(row.minutes_held).toBeGreaterThan(4);
	});

	it("marks a push's tables unread, records the files an import left and closes its entry-point evidence on their admissions once the app was deleted", async () => {
		const birth = await born();
		const generation = await beginDeploymentContentWrite(
			birth.scope,
			TARGET,
			fence,
		);
		const table = await (WRITES["a pushed table"] ?? fail())(birth);
		const imported = await (WRITES["the import"] ?? fail())(birth);
		await recordOf(imported);
		const observed = await readAppBaseline(birth.scope, TARGET);
		if (!observed) throw new Error("Missing imported app baseline.");
		await softDeleteApp(APP, OWNER);

		await markResourceBaselinesUnread(
			birth.scope,
			TARGET,
			[{ kind: "lookup-table", remoteId: "hq-table-1" }],
			fence,
			settling(table.writeIds),
		);
		const files = { "commcare/picture.png": "doc-1" };
		const asTheImport = { writeIds: imported.writeIds, settle: [] };
		await recordDeploymentMediaFiles(birth.scope, TARGET, {
			...fence,
			remoteAppId: HQ_APP,
			pushToken: (await liveMapping("app", APP))?.push_token ?? fail(),
			sourceDigest: null,
			novaRevision: observed.novaRevision,
			files: { read: observed.mediaFiles, next: files },
			admitted: asTheImport,
		});
		await expect(
			finishDeploymentContentWrite(
				birth.scope,
				TARGET,
				generation,
				null,
				fence,
				asTheImport,
			),
		).resolves.toBe(false);
		await expect(
			finishDeploymentContentWrite(
				birth.scope,
				TARGET,
				generation,
				null,
				fence,
			),
		).rejects.toMatchObject({ code: "not_found" });

		const tableBaseline = await h
			.db()
			.selectFrom("project_space_resource_baselines")
			.select("origin")
			.where("remote_id", "=", "hq-table-1")
			.executeTakeFirstOrThrow();
		expect(tableBaseline.origin).toBe("unread");
		const appBaseline = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select("media_files")
			.executeTakeFirstOrThrow();
		expect(appBaseline.media_files).toEqual(files);
		expect(await openWrites()).toBe(0);
	});
});

function fail(): never {
	throw new Error("Expected a value");
}
