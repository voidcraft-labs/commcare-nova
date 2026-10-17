/** Migration notices: who reads them, who dismisses them, and what follows an
 * app. Rows are written the way the cutover writes them, as raw statements. */
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import { commitAppProjectMove, softDeleteApp } from "@/lib/db/apps";
import { withAppTx } from "@/lib/db/pg";
import { log } from "@/lib/logger";
import {
	dismissAppNotice,
	dismissKeyReaderNotices,
	readAppDeploymentNoticeEntriesInTransaction,
	readAppNoticesInTransaction,
	readKeyReaderNotices,
} from "../store";

const h = setupAppStateTestDb("app_notice_store_");
const CUTOVER = "hq-round-trip-emission";
const OWNER = "owner-user";
const MEMBER = "member-user";
const VIEWER = "viewer-user";
const OUTSIDER = "outsider-user";
const SOURCE = "source-project";
const DESTINATION = "destination-project";
const DEPLOYMENT_ID = "01992000-0000-7000-8000-000000000011";

const ENTRIES = [
	{
		kind: "deployment",
		reason: "deep-links-need-republish",
		deployment: {
			deploymentId: DEPLOYMENT_ID,
			server: "production",
			domain: "field-ops",
		},
	},
	{
		kind: "document",
		reason: "unsaved-assistant-work-discarded",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
	},
];

async function seedNotice(
	appId: string,
	cutover = CUTOVER,
	entries: readonly unknown[] = ENTRIES,
): Promise<string> {
	const inserted = await sql<{ id: string }>`
		INSERT INTO app_migration_notices (app_id, cutover, entries)
		VALUES (${appId}, ${cutover}, ${JSON.stringify(entries)}::jsonb)
		RETURNING id`.execute(h.db());
	const id = inserted.rows[0]?.id;
	if (id === undefined) throw new Error("No notice was inserted");
	return id;
}

async function seedKeyReader(args: {
	userId: string;
	domain: string;
	first: string;
	last: string;
}) {
	await sql`
		INSERT INTO app_migration_notice_key_readers
			(cutover, user_id, server, domain, first_used_at, last_used_at)
		VALUES (${CUTOVER}, ${args.userId}, 'production', ${args.domain},
			${args.first}::timestamptz, ${args.last}::timestamptz)`.execute(h.db());
}

/** What a builder or `get_app` reads: view resolved first, in one transaction. */
async function readAs(appId: string, userId: string) {
	return withAppTx(async (tx) => {
		await resolveAppScopeInTransaction(tx, appId, userId, "view");
		return readAppNoticesInTransaction(tx, { appId, userId });
	});
}

async function seedSharedApp(id: string): Promise<string> {
	const appId = await h.seedApp({ id, owner: OWNER, project_id: SOURCE });
	await h.seedProjectMember(MEMBER, SOURCE, "editor");
	await h.seedProjectMember(VIEWER, SOURCE, "viewer");
	return appId;
}

async function dismissalCount(): Promise<number> {
	const result = await sql<{ count: number }>`
		SELECT count(*)::int AS count FROM app_migration_notice_dismissals`.execute(
		h.db(),
	);
	return result.rows[0]?.count ?? 0;
}

describe("app notices", () => {
	it("are read by every member, and a non-member's resolution fails before the store", async () => {
		const appId = await seedSharedApp("noticed-app");
		const noticeId = await seedNotice(appId);
		for (const userId of [OWNER, MEMBER, VIEWER]) {
			const notices = await readAs(appId, userId);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({
				id: noticeId,
				cutover: CUTOVER,
				entries: ENTRIES,
			});
		}
		await expect(readAs(appId, OUTSIDER)).rejects.toBeInstanceOf(
			AppAccessError,
		);
	});

	it("are dismissed for that member alone, once, and never through another app", async () => {
		const appId = await seedSharedApp("dismissed-app");
		const otherAppId = await h.seedApp({
			id: "other-app",
			owner: OWNER,
			project_id: SOURCE,
		});
		const noticeId = await seedNotice(appId);
		const otherNoticeId = await seedNotice(otherAppId);

		await expect(
			dismissAppNotice({ appId, noticeId, userId: VIEWER }),
		).resolves.toBe(true);
		expect(await readAs(appId, VIEWER)).toEqual([]);
		expect(await readAs(appId, MEMBER)).toHaveLength(1);

		await expect(
			dismissAppNotice({ appId, noticeId, userId: VIEWER }),
		).resolves.toBe(true);
		expect(await dismissalCount()).toBe(1);

		await expect(
			dismissAppNotice({ appId, noticeId: otherNoticeId, userId: MEMBER }),
		).resolves.toBe(false);
		await expect(
			dismissAppNotice({
				appId,
				noticeId: "01992000-0000-7000-8000-0000000000ff",
				userId: MEMBER,
			}),
		).resolves.toBe(false);
		await expect(
			dismissAppNotice({ appId, noticeId: "not-a-notice", userId: MEMBER }),
		).resolves.toBe(false);
		expect(await dismissalCount()).toBe(1);
		expect(await readAs(otherAppId, MEMBER)).toHaveLength(1);
	});

	it("keep a dismissed notice's deployment entries for the Publishing card", async () => {
		const appId = await seedSharedApp("card-app");
		const noticeId = await seedNotice(appId);
		await dismissAppNotice({ appId, noticeId, userId: MEMBER });
		const entries = await withAppTx((tx) =>
			readAppDeploymentNoticeEntriesInTransaction(tx, { appId }),
		);
		expect(entries).toEqual([
			{
				noticeId,
				createdAt: expect.any(String),
				entry: ENTRIES[0],
			},
		]);
	});

	it("leave out only what this build can't read, with a warning", async () => {
		const appId = await seedSharedApp("newer-app");
		const LATER_ENTRY = {
			kind: "document",
			reason: "a-reason-a-later-build-adds",
			entity: { type: "app", nameAtMigration: "Clinic visits" },
		};
		const mixedId = await seedNotice(appId, CUTOVER, [
			ENTRIES[0],
			LATER_ENTRY,
			ENTRIES[1],
		]);
		await seedNotice(appId, "a-later-cutover");
		const unreadableAppId = await h.seedApp({
			id: "unreadable-app",
			owner: OWNER,
			project_id: SOURCE,
		});
		await seedNotice(unreadableAppId, CUTOVER, [LATER_ENTRY]);
		expect(await readAs(unreadableAppId, MEMBER)).toEqual([]);

		const notices = await readAs(appId, MEMBER);
		expect(notices).toEqual([
			{
				id: mixedId,
				cutover: CUTOVER,
				createdAt: expect.any(String),
				entries: ENTRIES,
			},
		]);
		const cardEntries = await withAppTx((tx) =>
			readAppDeploymentNoticeEntriesInTransaction(tx, { appId }),
		);
		expect(cardEntries.map((entry) => entry.entry)).toEqual([
			ENTRIES[0],
			ENTRIES[0],
		]);
		expect(log.warn).toHaveBeenCalledWith(
			"[notices] skipped a migration notice entry this build can't read",
			{ noticeId: mixedId, index: 1 },
		);
		expect(log.warn).toHaveBeenCalledWith(
			"[notices] skipped a migration notice of an unknown cutover",
			expect.objectContaining({ noticeId: expect.any(String) }),
		);
		expect(log.error).not.toHaveBeenCalled();
	});

	it("follow the app across a Project move, to the destination's members", async () => {
		const appId = await seedSharedApp("moved-app");
		await h.seedProjectMember(OWNER, DESTINATION, "owner");
		await h.seedProjectMember(OUTSIDER, DESTINATION, "viewer");
		const noticeId = await seedNotice(appId);
		await commitAppProjectMove(appId, {
			toProjectId: DESTINATION,
			expectedFromProjectId: SOURCE,
			actorUserId: OWNER,
			assetIdMap: new Map(),
		});
		expect((await readAs(appId, OUTSIDER)).map((n) => n.id)).toEqual([
			noticeId,
		]);
		await expect(readAs(appId, MEMBER)).rejects.toBeInstanceOf(AppAccessError);
	});

	it("go with their app and their dismissals", async () => {
		const appId = await seedSharedApp("deleted-app");
		const noticeId = await seedNotice(appId);
		await dismissAppNotice({ appId, noticeId, userId: MEMBER });
		await softDeleteApp(appId, OWNER);
		await expect(readAs(appId, MEMBER)).rejects.toBeInstanceOf(AppAccessError);
		await sql`DELETE FROM apps WHERE id = ${appId}`.execute(h.db());
		const left = await sql<{ notices: number; dismissals: number }>`
			SELECT
				(SELECT count(*)::int FROM app_migration_notices) AS notices,
				(SELECT count(*)::int FROM app_migration_notice_dismissals) AS dismissals
		`.execute(h.db());
		expect(left.rows[0]).toEqual({ notices: 0, dismissals: 0 });
	});
});

describe("the home line", () => {
	it("shows a key reader with no notice at all, spanning its rows' least first and greatest last use", async () => {
		await seedKeyReader({
			userId: MEMBER,
			domain: "field-ops",
			first: "2026-10-06T22:00:00Z",
			last: "2026-10-06T23:00:00Z",
		});
		await seedKeyReader({
			userId: MEMBER,
			domain: "district",
			first: "2026-10-06T21:00:00Z",
			last: "2026-10-07T01:00:00Z",
		});
		await seedKeyReader({
			userId: OUTSIDER,
			domain: "elsewhere",
			first: "2026-10-06T21:00:00Z",
			last: "2026-10-06T21:00:00Z",
		});
		const rows = await readKeyReaderNotices(MEMBER);
		expect(rows.map((row) => row.domain)).toEqual(["district", "field-ops"]);
		expect(rows[0]).toEqual({
			cutover: CUTOVER,
			server: "production",
			domain: "district",
			firstUsedAt: "2026-10-06T21:00:00.000Z",
			lastUsedAt: "2026-10-07T01:00:00.000Z",
		});
	});

	it("dismisses apart from the app's notice, in both directions", async () => {
		const appId = await seedSharedApp("both-app");
		const noticeId = await seedNotice(appId);
		await seedKeyReader({
			userId: MEMBER,
			domain: "field-ops",
			first: "2026-10-06T22:00:00Z",
			last: "2026-10-06T23:00:00Z",
		});

		await dismissAppNotice({ appId, noticeId, userId: MEMBER });
		expect(await readKeyReaderNotices(MEMBER)).toHaveLength(1);

		await dismissKeyReaderNotices({ userId: MEMBER });
		await dismissKeyReaderNotices({ userId: MEMBER });
		expect(await readKeyReaderNotices(MEMBER)).toEqual([]);
		expect(await readAs(appId, VIEWER)).toHaveLength(1);

		await dismissKeyReaderNotices({ userId: VIEWER });
		expect(await readAs(appId, VIEWER)).toHaveLength(1);
		expect(await dismissalCount()).toBe(2);
	});
});
