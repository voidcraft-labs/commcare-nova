import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("app_migration_notices_");
const CUTOVER = "hq-round-trip-emission";
const ENTRY = JSON.stringify([{ kind: "document" }]);

async function refusal(statement: Promise<unknown>, code: string) {
	return expect(statement).rejects.toMatchObject({ code });
}

async function seedNotice(appId: string): Promise<string> {
	const inserted = await sql<{ id: string }>`
		INSERT INTO app_migration_notices (app_id, cutover, entries)
		VALUES (${appId}, ${CUTOVER}, ${ENTRY}::jsonb) RETURNING id`.execute(
		h.db(),
	);
	const id = inserted.rows[0]?.id;
	if (id === undefined) throw new Error("No notice was inserted");
	return id;
}

describe("app migration notice tables", () => {
	it("holds one notice per app and cutover, never an empty one", async () => {
		const appId = await h.seedApp({ id: "noticed-app" });
		await refusal(
			sql`INSERT INTO app_migration_notices (app_id, cutover, entries)
				VALUES (${appId}, ${CUTOVER}, '[]'::jsonb)`.execute(h.db()),
			"23514",
		);
		await refusal(
			sql`INSERT INTO app_migration_notices (app_id, cutover, entries)
				VALUES (${appId}, ' ', ${ENTRY}::jsonb)`.execute(h.db()),
			"23514",
		);
		await seedNotice(appId);
		await refusal(seedNotice(appId), "23505");
	});

	it("keys a key reader by cutover, member and project space, with an ordered span", async () => {
		const reader = (first: string, last: string, server = "production") =>
			sql`INSERT INTO app_migration_notice_key_readers
				(cutover, user_id, server, domain, first_used_at, last_used_at)
				VALUES (${CUTOVER}, 'member', ${server}, 'field-ops',
					${first}::timestamptz, ${last}::timestamptz)`.execute(h.db());
		await refusal(
			reader("2026-10-15T02:00:00Z", "2026-10-15T01:00:00Z"),
			"23514",
		);
		await refusal(
			reader("2026-10-15T01:00:00Z", "2026-10-15T02:00:00Z", "staging"),
			"23514",
		);
		await reader("2026-10-15T01:00:00Z", "2026-10-15T02:00:00Z");
		await refusal(
			reader("2026-10-15T01:00:00Z", "2026-10-15T02:00:00Z"),
			"23505",
		);
	});

	it("records a dismissal of exactly one subject, once per member, and drops it with its app", async () => {
		const appId = await h.seedApp({ id: "dismissed-app" });
		const noticeId = await seedNotice(appId);
		const dismiss = (
			surface: string,
			notice: string | null,
			cutover: string | null,
		) =>
			sql`INSERT INTO app_migration_notice_dismissals
				(user_id, surface, notice_id, cutover)
				VALUES ('member', ${surface}, ${notice}::uuid, ${cutover})`.execute(
				h.db(),
			);
		await refusal(dismiss("app", noticeId, CUTOVER), "23514");
		await refusal(dismiss("app", null, null), "23514");
		await refusal(dismiss("key-reader", noticeId, null), "23514");
		await dismiss("app", noticeId, null);
		await dismiss("key-reader", null, CUTOVER);
		await refusal(dismiss("app", noticeId, null), "23505");
		await refusal(dismiss("key-reader", null, CUTOVER), "23505");

		await sql`DELETE FROM apps WHERE id = ${appId}`.execute(h.db());
		const remaining = await sql<{ surface: string }>`
			SELECT surface FROM app_migration_notice_dismissals`.execute(h.db());
		expect(remaining.rows).toEqual([{ surface: "key-reader" }]);
		const notices = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM app_migration_notices`.execute(h.db());
		expect(notices.rows).toEqual([{ count: 0 }]);
	});
});
