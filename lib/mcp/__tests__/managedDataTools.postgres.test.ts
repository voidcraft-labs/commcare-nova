/**
 * `refresh_managed_data` and `set_lookup_table_management` through the real
 * SDK client and server, over real Postgres and a peer standing in for
 * CommCare HQ.
 *
 * Contract: each answer says what the builder says for the same outcome; a
 * preview of a change of who manages a table is the confirmation's own lines
 * and writes nothing; only an admin may make that change; a target the
 * call names twice or not at all is refused before anything is read.
 *
 * Plausible failures: MCP and the table page saying different things; a
 * preview that hands the table over; an editor taking a table over from
 * MCP; a refresh that guesses which of two targets was meant.
 */

import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	connect,
	type ManagedCopy,
	makeManagedCopy,
	readerOf,
	type ServedTable,
	sent,
	serveRows,
	serveTableList,
	serveTransferEvidence,
} from "@/lib/deployment/__tests__/managedFixtures";
import { NO_MANAGED_PLACES } from "@/lib/deployment/managedData";
import { LOOKUP_DISCARD_NOTE } from "@/lib/deployment/remoteChanges";
import { getLookupManifest } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { REFRESH_MANAGED_DATA_TARGET_MESSAGE } from "@/lib/publish/bringInCopy";
import {
	appsThatReadIt,
	letHqManageBody,
	letHqManageTitle,
	MANAGED_TABLE_REFRESHED_ROWS,
	MANAGEMENT_NEEDS_ADMIN,
	MANAGEMENT_REVIEW_MOVED,
	managedInNovaBanner,
	manageInNovaBody,
	manageInNovaTitle,
} from "@/lib/publish/managedData";
import {
	registerRefreshManagedData,
	registerSetLookupTableManagement,
} from "../tools/managedData";
import { withMcpClient } from "./client";
import { resultContentText, resultText } from "./resultText";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

const h = setupAppStateTestDb("mcp_managed_data_", { authSchema: "migrated" });
const APP = "visits-app";
const PROJECT = "program";
const EDITOR = "publisher";
const ADMIN = "admin";
const DOMAIN = "clinic";
const TARGET = { server: "india", domain: DOMAIN } as const;
const EDITOR_LOOKUP: LookupScope = {
	projectId: PROJECT,
	actorId: EDITOR,
	role: "editor",
};

const facilities: ServedTable = {
	id: "a".repeat(32),
	tag: "facilities",
	fields: ["code", "name"],
	rows: [
		{ code: "001", name: "North" },
		{ code: "002", name: "South" },
	],
};

/** The Project, its editor and admin (both connected on `india`), and an app reading a copy CommCare HQ manages. */
async function seed(): Promise<ManagedCopy> {
	await h.seedProjectMember(EDITOR, PROJECT, "editor");
	await h.seedProjectMember(ADMIN, PROJECT, "admin");
	await connect(h, EDITOR, "india", [DOMAIN]);
	await connect(h, ADMIN, "india", [DOMAIN]);
	const copy = await makeManagedCopy(h, EDITOR_LOOKUP, facilities, TARGET);
	await h.seedAppWithBlueprint(readerOf([copy]), {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h
		.db()
		.insertInto("lookup_table_references")
		.values({ project_id: PROJECT, table_id: copy.tableId, app_id: APP })
		.execute();
	return copy;
}

function asUser<T>(userId: string, run: (client: Client) => Promise<T>) {
	return withMcpClient((server) => {
		const ctx = {
			userId,
			scopes: [
				"nova.read",
				"nova.write",
				"nova.hq.read",
				"nova.hq.write",
				"nova.hq.import",
			],
			authKind: "oauth" as const,
		};
		registerRefreshManagedData(server, ctx);
		registerSetLookupTableManagement(server, ctx);
	}, run);
}

async function answer(
	client: Client,
	name: string,
	args: Record<string, unknown>,
) {
	return JSON.parse(
		resultText(await client.callTool({ name, arguments: args })),
	);
}

async function refusal(
	client: Client,
	name: string,
	args: Record<string, unknown>,
) {
	const result = await client.callTool({ name, arguments: args });
	expect(result.isError).toBe(true);
	return JSON.parse(resultContentText(result));
}

/** Who manages the copy now, as the Project's manifest says. */
async function managedBy(copy: ManagedCopy) {
	const manifest = await getLookupManifest(EDITOR_LOOKUP);
	return manifest.tables.find((table) => table.id === copy.tableId)?.hq
		?.managedBy;
}

it("refreshes a table CommCare HQ manages and says what changed in the table page's words", async () => {
	const copy = await seed();
	const grown = {
		...facilities,
		rows: [...facilities.rows, { code: "003", name: "East" }],
	};
	const body = await withHttpPeer(async (peer) => {
		serveTableList(peer, DOMAIN, [grown]);
		serveRows(peer, DOMAIN, grown);
		return asUser(EDITOR, (client) =>
			answer(client, "refresh_managed_data", {
				project_id: PROJECT,
				table_id: copy.tableId,
			}),
		);
	});
	expect(body).toEqual({
		project_id: PROJECT,
		table_id: copy.tableId,
		ok: true,
		reason: null,
		managed_by: "commcare-hq",
		message: MANAGED_TABLE_REFRESHED_ROWS,
	});
});

it("refuses a refresh that names both a table and an app, or neither, before reading anything", async () => {
	const copy = await seed();
	await withHttpPeer(async (peer) => {
		await asUser(EDITOR, async (client) => {
			for (const args of [
				{ project_id: PROJECT, table_id: copy.tableId, app_id: APP },
				{ project_id: PROJECT },
			]) {
				expect(await refusal(client, "refresh_managed_data", args)).toEqual({
					error_type: "invalid_input",
					message: REFRESH_MANAGED_DATA_TARGET_MESSAGE,
					project_id: PROJECT,
					...("app_id" in args && { app_id: APP }),
				});
			}
		});
		expect(sent(peer)).toEqual([]);
	});
});

it("answers a refresh of an app's places that came from nowhere with the organization's own sentence, and an app of another Project as not found", async () => {
	await seed();
	await h.seedAppWithBlueprint(readerOf([]), {
		id: "elsewhere-app",
		owner: EDITOR,
		projectId: "elsewhere",
	});
	await asUser(EDITOR, async (client) => {
		expect(
			await answer(client, "refresh_managed_data", {
				project_id: PROJECT,
				app_id: APP,
			}),
		).toEqual({
			project_id: PROJECT,
			app_id: APP,
			ok: false,
			reason: "not-found",
			message: NO_MANAGED_PLACES,
		});
		expect(
			await refusal(client, "refresh_managed_data", {
				project_id: PROJECT,
				app_id: "elsewhere-app",
			}),
		).toMatchObject({ error_type: "not_found", message: "App not found." });
	});
});

it("previews a change of who manages a table in its confirmation's words, with the apps that read it, and changes nothing", async () => {
	const copy = await seed();
	const readers = [{ appName: "Facility visits", deleted: false }];
	await withHttpPeer(async (peer) => {
		await asUser(ADMIN, async (client) => {
			expect(
				await answer(client, "set_lookup_table_management", {
					project_id: PROJECT,
					table_id: copy.tableId,
					managed_by: "nova",
				}),
			).toEqual({
				project_id: PROJECT,
				table_id: copy.tableId,
				ok: true,
				reason: null,
				managed_by: "commcare-hq",
				title: manageInNovaTitle("facilities"),
				lines: [
					...manageInNovaBody(DOMAIN),
					LOOKUP_DISCARD_NOTE,
					appsThatReadIt(readers),
				],
				apps: [{ app_id: APP, app_name: "Facility visits", deleted: false }],
				review_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			/* Handing back a table CommCare HQ already manages changes nothing. */
			expect(
				await answer(client, "set_lookup_table_management", {
					project_id: PROJECT,
					table_id: copy.tableId,
					managed_by: "commcare-hq",
				}),
			).toMatchObject({ title: null, lines: [] });
		});
		expect(sent(peer)).toEqual([]);
	});
	expect(await managedBy(copy)).toBe("commcare-hq");
});

it("lets only an admin hand a table to Nova, and previews the hand-back once Nova manages it", async () => {
	const copy = await seed();
	const args = {
		project_id: PROJECT,
		table_id: copy.tableId,
		managed_by: "nova",
	};
	await asUser(EDITOR, async (client) => {
		for (const digest of [{}, { review_digest: "a".repeat(64) }]) {
			expect(
				await answer(client, "set_lookup_table_management", {
					...args,
					...digest,
				}),
			).toEqual({
				project_id: PROJECT,
				table_id: copy.tableId,
				ok: false,
				reason: "not-permitted",
				message: MANAGEMENT_NEEDS_ADMIN,
			});
		}
	});
	expect(await managedBy(copy)).toBe("commcare-hq");

	await asUser(ADMIN, async (client) => {
		const preview = await answer(client, "set_lookup_table_management", args);
		expect(
			await withHttpPeer(async (peer) => {
				serveTransferEvidence(peer, DOMAIN, facilities);
				return answer(client, "set_lookup_table_management", {
					...args,
					review_digest: preview.review_digest,
				});
			}),
		).toEqual({
			project_id: PROJECT,
			table_id: copy.tableId,
			ok: true,
			reason: null,
			managed_by: "nova",
			message: managedInNovaBanner(DOMAIN),
		});
		/* Every column is text already, so no line says columns become text. */
		expect(
			await answer(client, "set_lookup_table_management", {
				...args,
				managed_by: "commcare-hq",
			}),
		).toMatchObject({
			managed_by: "nova",
			title: letHqManageTitle("facilities"),
			lines: [
				letHqManageBody(DOMAIN),
				appsThatReadIt([{ appName: "Facility visits", deleted: false }]),
			],
		});
	});
	expect(await managedBy(copy)).toBe("nova");
});

it("changes nothing over a preview another app's reading has moved, and answers the change as it stands now", async () => {
	const copy = await seed();
	const args = {
		project_id: PROJECT,
		table_id: copy.tableId,
		managed_by: "nova",
	};
	await asUser(ADMIN, async (client) => {
		const preview = await answer(client, "set_lookup_table_management", args);
		/* Another app starts reading the table after the user read the preview. */
		const second = await h.seedApp({
			id: "second-app",
			project_id: PROJECT,
			app_name: "Stock counts",
		});
		await h
			.db()
			.insertInto("lookup_table_references")
			.values({ project_id: PROJECT, table_id: copy.tableId, app_id: second })
			.execute();
		const moved = await answer(client, "set_lookup_table_management", {
			...args,
			review_digest: preview.review_digest,
		});
		expect(moved).toMatchObject({
			ok: false,
			reason: "review-moved",
			message: MANAGEMENT_REVIEW_MOVED,
			managed_by: "commcare-hq",
			apps: [
				{ app_id: APP, app_name: "Facility visits", deleted: false },
				{ app_id: second, app_name: "Stock counts", deleted: false },
			],
		});
		expect(moved.review_digest).not.toBe(preview.review_digest);
		expect(await managedBy(copy)).toBe("commcare-hq");
		/* The answer's own digest is the one the change is then made under. */
		expect(
			await withHttpPeer(async (peer) => {
				serveTransferEvidence(peer, DOMAIN, facilities);
				return answer(client, "set_lookup_table_management", {
					...args,
					review_digest: moved.review_digest,
				});
			}),
		).toMatchObject({ ok: true, managed_by: "nova" });
	});
	expect(await managedBy(copy)).toBe("nova");
});

it("finds no Project the caller is not a member of", async () => {
	const copy = await seed();
	await h.seedProjectMember("stranger", "another-project", "owner");
	await asUser("stranger", async (client) => {
		expect(
			await refusal(client, "set_lookup_table_management", {
				project_id: PROJECT,
				table_id: copy.tableId,
				managed_by: "nova",
			}),
		).toEqual({
			error_type: "not_found",
			message: "Project not found.",
			project_id: PROJECT,
		});
	});
	expect(await managedBy(copy)).toBe("commcare-hq");
});
