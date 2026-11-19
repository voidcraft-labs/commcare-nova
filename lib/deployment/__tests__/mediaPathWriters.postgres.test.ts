/**
 * Two writers of one deployment's media path rows, in real Postgres.
 *
 * Contract: a bring-in of changes reads the deployment's target-identity
 * record, media path rows among it, and writes the difference to the record it
 * resolved (`store.ts::writeTargetIdentityInTransaction`, through
 * `recordHqChangesTaken`) under the app row and the deployment row `FOR UPDATE`,
 * never a lock on the path rows themselves, whose runtime privilege is insert
 * and delete alone. A second writer of the same deployment waits for the first
 * to commit, then reads what the first wrote: where it resolved over that
 * record it writes its own difference over those rows, and where it was planned
 * over the baseline the first replaced the baseline fence refuses it.
 *
 * Plausible failures: the second writer reading the rows as they stood before
 * the first committed, then inserting a row at a path the first now holds (the
 * path's unique key refuses it, so the bring-in fails) or deleting a row the
 * first never had, leaving the first writer's file at a path the reading moved;
 * a lock on the path rows themselves, which PostgreSQL refuses to the runtime
 * role for want of UPDATE.
 *
 * Each case orders the writers deterministically: the first holds its
 * transaction open after writing, the second starts and is seen waiting on a
 * lock in `pg_stat_activity`, and only then does the first commit.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	HqChangesBaselineMovedError,
	type HqChangesTaken,
	recordHqChangesTaken,
} from "../store";
import type { TargetIdentity } from "../targetIdentity";
import {
	type AdoptedBirth,
	birthAdoptedApp,
	HELD_FILE_ID,
	HELD_PATH,
	OWNERSHIP,
	SOURCE,
	seedAsset,
} from "./adoptedBirth";

const h = setupAppStateTestDb("media_path_writers_", {
	authSchema: "migrated",
	poolMax: 4,
});

const ACTOR = "bringer";
const PROJECT = "project-clinic";
const TARGET = { server: "production" as const, domain: "clinic" };
const HQ_APP = "c".repeat(32);
const APP = testUuid("media-path-writers-app");

/** The sequence the first writer's commit takes. */
const FIRST_SEQ = 2;

function digestOf(source: object): string {
	return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function stored(source: object, observedAt: string) {
	const text = JSON.stringify(source);
	return {
		sourceGzip: gzipSync(Buffer.from(text, "utf8")),
		sourceBytes: Buffer.byteLength(text, "utf8"),
		sourceDigest: digestOf(source),
		observedAt,
	};
}

const FIRST_SOURCE = { ...SOURCE, name: "Clinic visits, logo replaced in HQ" };
const SECOND_SOURCE = { ...SOURCE, name: "Clinic visits, logo replaced again" };

/** The record with `assetId` alone at the held path, as a reading that took it resolves. */
function fileAtHeldPath(
	record: TargetIdentity,
	assetId: MediaAssetId,
): TargetIdentity {
	return { ...record, mediaPaths: [{ assetId, wirePath: HELD_PATH }] };
}

/** A take of `source` planned over the baseline `read` names. */
function taken(
	birth: AdoptedBirth,
	read: HqChangesTaken["read"],
	source: object,
	observedAt: string,
	targetIdentity: HqChangesTaken["targetIdentity"],
): HqChangesTaken {
	return {
		scope: birth.scope,
		target: TARGET,
		expectedEndings: 0,
		remoteAppId: HQ_APP,
		read,
		source: stored(source, observedAt),
		ownership: OWNERSHIP,
		mediaFiles: { [HELD_PATH]: HELD_FILE_ID },
		targetIdentity,
		firstPublish: {
			accepted: {
				ids: ["forms-and-settings-rewritten"],
				touchesWorkers: false,
				of: "first-publish",
			},
			publishChanges: [],
			webAppsOnInHq: true,
		},
	};
}

async function mediaPathRows() {
	return h
		.db()
		.selectFrom("app_deployment_media_paths")
		.select(["media_asset_id", "wire_path"])
		.orderBy("media_asset_id")
		.execute();
}

async function someoneWaitsOnALock(): Promise<void> {
	await vi.waitFor(async () => {
		const waiting = await sql<{ count: number }>`
			SELECT count(*)::integer AS count FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'
		`.execute(h.db());
		expect(waiting.rows[0]?.count).toBeGreaterThan(0);
	});
}

/**
 * The first writer's take, in a commit's transaction held open after it
 * wrote until `release` is called; `wrote` settles once its rows are written.
 */
function holdFirstWriter(first: HqChangesTaken) {
	let release: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let markWritten: () => void = () => undefined;
	const wrote = new Promise<void>((resolve) => {
		markWritten = resolve;
	});
	const committed = h
		.db()
		.transaction()
		.execute(async (tx) => {
			await recordHqChangesTaken({ kind: "commit", tx, seq: FIRST_SEQ }, first);
			markWritten();
			await released;
		});
	return { wrote, committed, release };
}

describe("two writers of one deployment's media paths", () => {
	it("makes the second wait for the first and write its difference over the rows the first wrote", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const birth = await birthAdoptedApp(h, {
			appId: APP,
			projectId: PROJECT,
			actorUserId: ACTOR,
			target: TARGET,
			remoteAppId: HQ_APP,
		});
		const firstFile = await seedAsset(h, PROJECT, ACTOR, "first");
		const secondFile = await seedAsset(h, PROJECT, ACTOR, "second");
		const afterFirst = fileAtHeldPath(birth.targetIdentity, firstFile);
		const first = holdFirstWriter(
			taken(
				birth,
				{ sourceDigest: digestOf(SOURCE), novaRevision: 1 },
				FIRST_SOURCE,
				"2026-11-14T08:00:00.000Z",
				{ read: birth.targetIdentity, next: afterFirst },
			),
		);
		let second: Promise<unknown> | undefined;
		try {
			await first.wrote;
			/* Planned over the baseline the first writer leaves. */
			second = recordHqChangesTaken(
				{ kind: "own", headSeq: FIRST_SEQ },
				taken(
					birth,
					{ sourceDigest: digestOf(FIRST_SOURCE), novaRevision: FIRST_SEQ },
					SECOND_SOURCE,
					"2026-11-14T09:00:00.000Z",
					{
						read: afterFirst,
						next: fileAtHeldPath(afterFirst, secondFile),
					},
				),
			);
			await someoneWaitsOnALock();
			first.release();
			await first.committed;
			await second;
		} finally {
			first.release();
			await first.committed.catch(() => undefined);
			await second?.catch(() => undefined);
		}
		/* The first moved the born file off the path; the second moved the
		 * first's file off it in turn, reading the row the first wrote. */
		expect(await mediaPathRows()).toEqual([
			{ media_asset_id: secondFile, wire_path: HELD_PATH },
		]);
	});

	it("refuses the second where it was planned over the baseline the first replaced, and keeps the first's rows", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const birth = await birthAdoptedApp(h, {
			appId: APP,
			projectId: PROJECT,
			actorUserId: ACTOR,
			target: TARGET,
			remoteAppId: HQ_APP,
		});
		const firstFile = await seedAsset(h, PROJECT, ACTOR, "first");
		const secondFile = await seedAsset(h, PROJECT, ACTOR, "second");
		const bornBaseline = { sourceDigest: digestOf(SOURCE), novaRevision: 1 };
		const first = holdFirstWriter(
			taken(birth, bornBaseline, FIRST_SOURCE, "2026-11-14T08:00:00.000Z", {
				read: birth.targetIdentity,
				next: fileAtHeldPath(birth.targetIdentity, firstFile),
			}),
		);
		let second: Promise<unknown> | undefined;
		try {
			await first.wrote;
			second = recordHqChangesTaken(
				{ kind: "own", headSeq: 1 },
				taken(birth, bornBaseline, SECOND_SOURCE, "2026-11-14T09:00:00.000Z", {
					read: birth.targetIdentity,
					next: fileAtHeldPath(birth.targetIdentity, secondFile),
				}),
			);
			await someoneWaitsOnALock();
			first.release();
			await first.committed;
			await expect(second).rejects.toBeInstanceOf(HqChangesBaselineMovedError);
		} finally {
			first.release();
			await first.committed.catch(() => undefined);
			await second?.catch(() => undefined);
		}
		expect(await mediaPathRows()).toEqual([
			{ media_asset_id: firstFile, wire_path: HELD_PATH },
		]);
	});
});
