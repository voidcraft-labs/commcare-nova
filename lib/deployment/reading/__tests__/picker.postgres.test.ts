/**
 * The bring-in picker's list in real Postgres, over CommCare HQ's own answers
 * (`proof/hq-reads/reading/`) served at the HTTP peer.
 *
 * The settings read, the claims read and the HQ client all run as they do in
 * production; KMS is the one boundary replaced, so the request carries the
 * key the stored ciphertext decrypts to. A claim view that leaks another
 * Project, a key's limit worded as CommCare HQ's refusal, the API access
 * check run beside the list rather than after it, and a read that writes are
 * what these cases would catch.
 */

import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyJson,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { birthAdoptedApp } from "../../__tests__/adoptedBirth";
import { listHqAppsForPicker } from "../picker";
import type { HqAppPicker } from "../pickerTypes";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));

const h = setupAppStateTestDb("reading_picker_", {
	authSchema: "migrated",
	poolMax: 4,
});

const VIEWER = "picker-viewer";
const HOLDER = "other-project-holder";
const PROJECT_OPEN = "project-viewer-clinic";
const PROJECT_ELSEWHERE = "project-elsewhere";
const ELSEWHERE_PROJECT_NAME = "Northern district team";
const ELSEWHERE_APP_NAME = "District outreach visits";
const HOST = "https://india.commcarehq.org";
const USERNAME = "account@dimagi.com";
const KEY = "fixture-key";
const LIST = "/a/clinic/apps/api/list_apps/";
const PROBE = "/a/clinic/api/lookup_table/v1/?limit=1";
const TARGET = { server: "india" as const, domain: "clinic" };
const APP_PLACE = { kind: "app" } as const;

/** HQ's list as the lane retained it: each row's id and name, in HQ's order. */
const LISTED = (
	retainedBodyJson(retainedReadingRead("list-apps")).applications as {
		app_id: string;
		name: string;
	}[]
).map((row) => ({ remoteAppId: row.app_id, name: row.name }));

/**
 * What `list_apps` answers a key that is no member of the project space:
 * `domain/decorators.py::_login_or_challenge` returns `HttpResponseForbidden()`,
 * a 403 with no body, before the view runs. The retained answer of the API
 * access check's missing permission is that same bodyless 403.
 */
const NOT_A_MEMBER: RetainedHqAnswer = retainedReadingRead(
	"api-access-no-permission",
);

beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue(KEY);
});

async function storeConnection(userId = VIEWER): Promise<void> {
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: userId,
			commcare_username: USERNAME,
			commcare_api_key: "stored-ciphertext",
			commcare_server: "india",
			approved_domains: JSON.stringify([
				{ name: "clinic", displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.execute();
}

function serve(peer: MockAgent, path: string, answer: RetainedHqAnswer): void {
	replyRetained(
		peer.get(HOST).intercept({
			path,
			method: "GET",
			headers: { authorization: `ApiKey ${USERNAME}:${KEY}` },
		}),
		answer,
	);
}

/** Every request that reached the peer, in the order it was sent. */
function requested(peer: MockAgent): string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map((call) => {
				const url = new URL(call.fullUrl);
				return url.pathname + url.search;
			}) ?? []
	);
}

/** Every base table's row count, so a read that writes anything is seen. */
async function everyRowCount(): Promise<Record<string, number>> {
	const { rows } = await sql<{ table_schema: string; table_name: string }>`
		SELECT table_schema, table_name FROM information_schema.tables
		WHERE table_type = 'BASE TABLE'
			AND table_schema NOT IN ('pg_catalog', 'information_schema')
		ORDER BY table_schema, table_name
	`.execute(h.db());
	const counts: Record<string, number> = {};
	for (const table of rows) {
		const counted = await sql<{ n: string }>`
			SELECT count(*)::text AS n FROM ${sql.table(`${table.table_schema}.${table.table_name}`)}
		`.execute(h.db());
		counts[`${table.table_schema}.${table.table_name}`] = Number(
			counted.rows[0]?.n,
		);
	}
	return counts;
}

function stopOf(code: Parameters<typeof circumstanceFinding>[0]): HqAppPicker {
	return {
		kind: "stop",
		finding: circumstanceFinding(code, APP_PLACE, {}),
	};
}

describe("listHqAppsForPicker", () => {
	it("lists every app HQ lists, in its order, free where no Nova app holds it", async () => {
		await storeConnection();
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retainedReadingRead("list-apps"));
			serve(peer, PROBE, retainedReadingRead("api-access"));
			expect(
				await listHqAppsForPicker({ userId: VIEWER }, { domain: "clinic" }),
			).toEqual({
				kind: "apps",
				server: "india",
				domain: "clinic",
				apps: LISTED.map((row) => ({ ...row, claim: null })),
			});
			/* The API access check follows the list's answer; it is never sent beside it. */
			expect(requested(peer)).toEqual([LIST, PROBE]);
		});
	});

	it("marks an app a Project of the viewer's holds as open, and writes nothing", async () => {
		await storeConnection();
		await h.seedProjectMember(VIEWER, PROJECT_OPEN, "editor");
		const openApp = testUuid("open-app");
		await birthAdoptedApp(h, {
			appId: openApp,
			projectId: PROJECT_OPEN,
			actorUserId: VIEWER,
			target: TARGET,
			remoteAppId: LISTED[0].remoteAppId,
		});
		const appName = (await h.readAppRow(openApp))?.app_name;
		const before = await everyRowCount();
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retainedReadingRead("list-apps"));
			serve(peer, PROBE, retainedReadingRead("api-access"));
			const picker = await listHqAppsForPicker(
				{ userId: VIEWER },
				{ domain: "clinic" },
			);
			expect(picker).toEqual({
				kind: "apps",
				server: "india",
				domain: "clinic",
				apps: [
					{
						...LISTED[0],
						claim: { kind: "open", appId: openApp, appName },
					},
					...LISTED.slice(1).map((row) => ({ ...row, claim: null })),
				],
			});
		});
		expect(await everyRowCount()).toEqual(before);
	});

	it("marks an app a Project the viewer is not part of holds as elsewhere, naming neither that Project nor its app", async () => {
		await storeConnection();
		await h.seedProjectMember(VIEWER, PROJECT_OPEN, "owner");
		await h.seedProjectMember(HOLDER, PROJECT_ELSEWHERE, "owner");
		const heldApp = testUuid("held-elsewhere");
		await birthAdoptedApp(h, {
			appId: heldApp,
			projectId: PROJECT_ELSEWHERE,
			actorUserId: HOLDER,
			target: TARGET,
			remoteAppId: LISTED[1].remoteAppId,
		});
		await h
			.db()
			.updateTable("apps")
			.set({
				app_name: ELSEWHERE_APP_NAME,
				app_name_lower: ELSEWHERE_APP_NAME.toLowerCase(),
			})
			.where("id", "=", heldApp)
			.execute();
		await sql`
			UPDATE auth_organization SET name = ${ELSEWHERE_PROJECT_NAME}
			WHERE id = ${PROJECT_ELSEWHERE}
		`.execute(h.db());
		const began = await h
			.db()
			.selectFrom("app_deployment_resources")
			.select("adopted_at")
			.where("remote_id", "=", LISTED[1].remoteAppId)
			.executeTakeFirstOrThrow();
		const before = await everyRowCount();
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retainedReadingRead("list-apps"));
			serve(peer, PROBE, retainedReadingRead("api-access"));
			const picker = await listHqAppsForPicker(
				{ userId: VIEWER },
				{ domain: "clinic" },
			);
			expect(picker).toEqual({
				kind: "apps",
				server: "india",
				domain: "clinic",
				apps: [
					{ ...LISTED[0], claim: null },
					{
						...LISTED[1],
						claim: {
							kind: "elsewhere",
							at: began.adopted_at?.toISOString(),
							contact: { role: "person", names: [HOLDER] },
						},
					},
					{ ...LISTED[2], claim: null },
				],
			});
			const wire = JSON.stringify(picker);
			for (const hidden of [
				ELSEWHERE_PROJECT_NAME,
				PROJECT_ELSEWHERE,
				ELSEWHERE_APP_NAME,
				heldApp,
			]) {
				expect(wire).not.toContain(hidden);
			}
		});
		expect(await everyRowCount()).toEqual(before);
	});

	it("answers not-connected where the person has no connection, asking HQ nothing", async () => {
		await withHttpPeer(async (peer) => {
			expect(
				await listHqAppsForPicker({ userId: VIEWER }, { domain: "clinic" }),
			).toEqual({ kind: "not-connected" });
			expect(requested(peer)).toEqual([]);
		});
		expect(decrypt).not.toHaveBeenCalled();
	});

	it("answers key-cannot-reach-space for a project space the stored key does not list, asking HQ nothing", async () => {
		await storeConnection();
		const before = await everyRowCount();
		await withHttpPeer(async (peer) => {
			expect(
				await listHqAppsForPicker({ userId: VIEWER }, { domain: "training" }),
			).toEqual(stopOf("key-cannot-reach-space"));
			expect(requested(peer)).toEqual([]);
		});
		expect(decrypt).not.toHaveBeenCalled();
		expect(await everyRowCount()).toEqual(before);
	});

	it("answers not-a-member where CommCare HQ refuses the membership, and sends no API access check", async () => {
		await storeConnection();
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, NOT_A_MEMBER);
			expect(
				await listHqAppsForPicker({ userId: VIEWER }, { domain: "clinic" }),
			).toEqual(stopOf("not-a-member"));
			expect(requested(peer)).toEqual([LIST]);
		});
	});

	it("answers plan-lacks-api-access where the plan has no API access", async () => {
		await storeConnection();
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retainedReadingRead("list-apps"));
			serve(peer, PROBE, retainedReadingRead("api-access-no-plan"));
			expect(
				await listHqAppsForPicker({ userId: VIEWER }, { domain: "clinic" }),
			).toEqual(stopOf("plan-lacks-api-access"));
			expect(requested(peer)).toEqual([LIST, PROBE]);
		});
	});

	it("answers cannot-access-apis where the account lacks Access APIs", async () => {
		await storeConnection();
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retainedReadingRead("list-apps"));
			serve(peer, PROBE, retainedReadingRead("api-access-no-permission"));
			expect(
				await listHqAppsForPicker({ userId: VIEWER }, { domain: "clinic" }),
			).toEqual(stopOf("cannot-access-apis"));
			expect(requested(peer)).toEqual([LIST, PROBE]);
		});
	});
});
