import { v7 } from "uuid";
import {
	retainedBodyText,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { withAppTx } from "@/lib/db/pg";
import { publishFromSession as publishAppToHq } from "@/lib/deployment/__tests__/publishWithGrant";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { getLookupTable } from "@/lib/lookup/service";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
/**
 * A lookup table's standing in a project space is the Project's: a publish
 * reads it from every app of the Project that holds a live mapping for the
 * table CommCare HQ has under the tag. Through `publishAppToHq`, over real
 * Postgres and a peer standing in for CommCare HQ, whose lookup answers are
 * written here in the shapes `lib/commcare/hq/lookupTables.ts` reads and
 * whose app sources are CommCare HQ's own, retained by the proof lane.
 */

import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { ProjectDataGrant } from "@/lib/auth/dataGrant";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { BlueprintDoc } from "@/lib/domain";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import type { PublishOutcome } from "../service";
import type { DeploymentConfirmationKey } from "../types";
import {
	acceptImport,
	connect,
	hqSaves,
	publishRequests,
	type ServedTable,
	serveRows,
	serveSource,
	serveTableList,
	takeWorkbook,
	withManagedPeer,
} from "./managedFixtures";
import { reloadHeadFor } from "./publishFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	hqSaves.reset();
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

const h = setupAppStateTestDb("project_lookup_standing_", {
	authSchema: "migrated",
});
const PROJECT = "program";
const FIRST = "first-editor";
const SECOND = "second-editor";
const DOMAIN = "clinic";
const TARGET = { server: "india", domain: DOMAIN } as const;

/** CommCare HQ's table once Nova's workbook made it: the tag, two fields, the one row Nova holds. */
const landed: ServedTable = {
	id: "hq-facilities",
	tag: "facilities",
	fields: ["code", "name"],
	rows: [{ code: "001", name: "Clinic" }],
};

const CONFIRM_ALL: readonly DeploymentConfirmationKey[] = [
	...PLAN_FEATURE_IDS.map((subject) => ({
		kind: "plan-feature" as const,
		subject,
	})),
	{ kind: "flat-location-fixture" },
	{ kind: "connect-forwarder" },
	{ kind: "form-entry-sync-off" },
];

/** A table of `projectId` tagged `facilities`, holding the one row CommCare HQ then serves. */
async function projectTable(
	projectId: string,
	actorId: string,
	identity = { name: "Facilities", tag: "facilities" },
) {
	const scope = { projectId, actorId, role: "editor" };
	const table = await createLookupTable(scope, {
		...identity,
		columns: [
			{ wireName: "code", label: "Code", dataType: "text" },
			{ wireName: "name", label: "Name", dataType: "text" },
		],
	});
	const [code, name] = table.columns;
	await replaceLookupRows(scope, {
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
		rows: [{ [code.id]: "001", [name.id]: "Clinic" }],
	});
	return table;
}

/** An app of `projectId` whose one question chooses from `table`. */
async function appReading(
	appId: string,
	projectId: string,
	owner: string,
	table: Awaited<ReturnType<typeof projectTable>>,
	additional?: Awaited<ReturnType<typeof projectTable>>,
): Promise<BlueprintDoc> {
	const doc = buildDoc({
		appName: `Visits ${appId}`,
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: (additional ? [table, additional] : [table]).map(
							(source, i) => ({
								id: i === 0 ? "facility" : "area",
								kind: "single_select",
								optionsSource: {
									kind: "lookup",
									tableId: source.id,
									valueColumnId: source.columns[0].id,
									labelColumnId: source.columns[1].id,
								},
							}),
						),
					},
				],
			},
		],
	});
	await h.seedAppWithBlueprint(doc, { id: appId, owner, projectId });
	return doc;
}

function publish(
	appId: string,
	projectId: string,
	actorUserId: string,
	doc: BlueprintDoc,
	adoptResourceIds: readonly string[] = [],
	dataGrant?: ProjectDataGrant,
): Promise<PublishOutcome> {
	return publishAppToHq({
		requireHqImport: null,
		dataGrant,
		scope: { appId, projectId, actorUserId, role: "editor" },
		...TARGET,
		doc,
		compiledAtSeq: 0,
		reloadHead: reloadHeadFor(appId, actorUserId),
		appName: doc.appName,
		confirm: CONFIRM_ALL,
		adoptResourceIds,
	});
}

/**
 * The answers to a first publish that pushes the table: the list preflight
 * reads (and the rows it compares, where a mapping accounts for the table),
 * the empty app, the workbook, the table read back, then the content.
 */
function firstPublishPushing(
	peer: MockAgent,
	hqApp: string,
	before: {
		readonly listed: readonly ServedTable[];
		readonly compared: boolean;
	},
): void {
	serveTableList(peer, DOMAIN, before.listed);
	if (before.compared) serveRows(peer, DOMAIN, before.listed[0] ?? landed);
	acceptImport(peer, DOMAIN, 201, { appId: hqApp });
	serveSource(peer, DOMAIN, "source-shell", hqApp);
	takeWorkbook(peer, DOMAIN);
	serveTableList(peer, DOMAIN, [landed]);
	serveRows(peer, DOMAIN, landed);
	serveSource(peer, DOMAIN, "source-shell", hqApp);
	acceptImport(peer, DOMAIN, 200, { appId: hqApp });
	serveSource(peer, DOMAIN, "source-after-create-then-update", hqApp);
}

async function mappingOf(appId: string) {
	return h
		.db()
		.selectFrom("app_deployment_resources as r")
		.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
		.select(["r.remote_id", "r.ownership", "r.adopted_at", "r.adopted_by"])
		.where("d.app_id", "=", appId)
		.where("r.kind", "=", "lookup-table")
		.where("r.superseded_at", "is", null)
		.executeTakeFirst();
}

function refusal(outcome: PublishOutcome) {
	if (outcome.landed) throw new Error("Expected the publish to stop");
	return outcome.refusal;
}

/** Two apps of one Project reading its table, the first published there. */
async function firstPublished(adopted: boolean) {
	await h.seedProjectMember(FIRST, PROJECT, "editor");
	await h.seedProjectMember(SECOND, PROJECT, "editor");
	await connect(h, FIRST, "india", [DOMAIN]);
	await connect(h, SECOND, "india", [DOMAIN]);
	const table = await projectTable(PROJECT, FIRST);
	const first = await appReading("app-a", PROJECT, FIRST, table);
	const second = await appReading("app-b", PROJECT, SECOND, table);
	await withManagedPeer(async (peer) => {
		firstPublishPushing(peer, "hq-app-a", {
			listed: adopted ? [landed] : [],
			compared: false,
		});
		const outcome = await publish(
			"app-a",
			PROJECT,
			FIRST,
			first,
			adopted ? [table.id] : [],
		);
		expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
	});
	return { table, second };
}

describe("a second app of the Project publishing the Project's table", () => {
	it("pushes it, unasked, and records its own mapping as Nova's", async () => {
		const { second } = await firstPublished(false);
		await withManagedPeer(async (peer) => {
			firstPublishPushing(peer, "hq-app-b", {
				listed: [landed],
				compared: true,
			});
			const outcome = await publish("app-b", PROJECT, SECOND, second);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
			expect(publishRequests(peer).slice(0, 2)).toEqual([
				`GET /a/${DOMAIN}/api/lookup_table/v1/?limit=1000`,
				`GET /a/${DOMAIN}/api/fixture/v1/?fixture_type_id=hq-facilities`,
			]);
		});
		expect(await mappingOf("app-b")).toEqual({
			remote_id: "hq-facilities",
			ownership: "nova-created",
			adopted_at: null,
			adopted_by: null,
		});
	});

	it("inherits the first app's adoption, attributed to the person who adopted it", async () => {
		const { second } = await firstPublished(true);
		const first = await mappingOf("app-a");
		expect(first).toMatchObject({ ownership: "adopted", adopted_by: FIRST });
		await withManagedPeer(async (peer) => {
			firstPublishPushing(peer, "hq-app-b", {
				listed: [landed],
				compared: true,
			});
			const outcome = await publish("app-b", PROJECT, SECOND, second);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
		});
		expect(await mappingOf("app-b")).toEqual({
			remote_id: "hq-facilities",
			ownership: "adopted",
			adopted_at: first?.adopted_at,
			adopted_by: FIRST,
		});
	});

	it("still counts the first app while it is in recently deleted", async () => {
		const { second } = await firstPublished(false);
		await h
			.db()
			.updateTable("apps")
			.set({
				deleted_at: new Date(),
				recoverable_until: new Date(Date.now() + 86_400_000),
			})
			.where("id", "=", "app-a")
			.execute();
		await withManagedPeer(async (peer) => {
			firstPublishPushing(peer, "hq-app-b", {
				listed: [landed],
				compared: true,
			});
			const outcome = await publish("app-b", PROJECT, SECOND, second);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
		});
	});

	it("asks, as for a stranger's table, once the first app is deleted for good", async () => {
		const { second, table } = await firstPublished(false);
		await sql`DELETE FROM apps WHERE id = ${"app-a"}`.execute(h.db());
		await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [landed]);
			expect(
				refusal(await publish("app-b", PROJECT, SECOND, second)),
			).toMatchObject({
				failure: { code: "hq_resource_conflict" },
				resourceConflicts: [{ kind: "lookup-table", novaResourceId: table.id }],
			});
		});
	});

	it("stops on a change made in CommCare HQ since the first app's push, read from the baseline that push wrote", async () => {
		const { second, table } = await firstPublished(false);
		const changed = {
			...landed,
			rows: [{ code: "001", name: "Clinic (renamed in HQ)" }],
		};
		await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [changed]);
			serveRows(peer, DOMAIN, changed);
			const stopped = refusal(await publish("app-b", PROJECT, SECOND, second));
			expect(stopped.failure.code).toBe("hq_changed");
			expect(stopped.remoteChanges).toEqual([
				expect.objectContaining({
					kind: "lookup-table",
					novaResourceId: table.id,
					baselineKnown: true,
				}),
			]);
		});
	});
});

it("refuses an app of another Project whose table shares the tag", async () => {
	await firstPublished(false);
	const OTHER = "other-program";
	const stranger = "stranger";
	await h.seedProjectMember(stranger, OTHER, "editor");
	await connect(h, stranger, "india", [DOMAIN]);
	const theirs = await projectTable(OTHER, stranger);
	const doc = await appReading("app-c", OTHER, stranger, theirs);
	await withManagedPeer(async (peer) => {
		serveTableList(peer, DOMAIN, [landed]);
		expect(refusal(await publish("app-c", OTHER, stranger, doc))).toMatchObject(
			{
				failure: { code: "hq_resource_conflict" },
				resourceConflicts: [
					{ kind: "lookup-table", novaResourceId: theirs.id },
				],
			},
		);
	});
});

it.each([
	[false, false],
	[true, false],
	[false, true],
	[true, true],
])(
	"does not acquire a different table on an unverifiable read-back (previous mapping %s, verified sibling %s)",
	async (mapped, hasSibling) => {
		await h.seedProjectMember(FIRST, PROJECT, "editor");
		await connect(h, FIRST, "india", [DOMAIN]);
		const table = await projectTable(PROJECT, FIRST);
		const appId = "lookup-owner",
			hqApp = "target-lookup-owner";
		const siblingTable = hasSibling
			? await projectTable(PROJECT, FIRST, { name: "Areas", tag: "areas" })
			: undefined;
		const siblings: ServedTable[] = hasSibling
			? [{ ...landed, id: "hq-areas", tag: "areas" }]
			: [];
		const doc = await appReading(appId, PROJECT, FIRST, table, siblingTable);
		const run = () => publish(appId, PROJECT, FIRST, doc);
		const unexpected = {
			...landed,
			id: "unrelated-table",
			rows: [{ code: "002", name: "A different clinic" }],
		};
		await withManagedPeer(async (peer) => {
			if (mapped) {
				serveTableList(peer, DOMAIN, []);
				acceptImport(peer, DOMAIN, 201, { appId: hqApp });
				serveSource(peer, DOMAIN, "source-shell", hqApp);
				takeWorkbook(peer, DOMAIN);
				serveTableList(peer, DOMAIN, [landed, ...siblings]);
				for (const item of [landed, ...siblings]) serveRows(peer, DOMAIN, item);
				serveSource(peer, DOMAIN, "source-shell", hqApp);
				acceptImport(peer, DOMAIN, 200, { appId: hqApp });
				serveSource(peer, DOMAIN, "source-after-create-then-update", hqApp);
				expect((await run()).landed).toBe(true);
				serveTableList(peer, DOMAIN, [landed, ...siblings]);
				for (const item of [landed, ...siblings]) serveRows(peer, DOMAIN, item);
				serveSource(peer, DOMAIN, "source-after-create-then-update", hqApp);
			} else {
				serveTableList(peer, DOMAIN, []);
				acceptImport(peer, DOMAIN, 201, { appId: hqApp });
				serveSource(peer, DOMAIN, "source-shell", hqApp);
			}
			takeWorkbook(peer, DOMAIN);
			serveTableList(peer, DOMAIN, [unexpected, ...siblings]);
			for (const item of [unexpected, ...siblings])
				serveRows(peer, DOMAIN, item);
			expect(refusal(await run())).toMatchObject({
				phase: "resources",
				failure: { code: "hq_resource_state_unknown" },
			});
			const owned = await h
				.db()
				.selectFrom("app_deployment_resources")
				.select("remote_id")
				.where("kind", "=", "lookup-table")
				.where("superseded_at", "is", null)
				.orderBy("remote_id")
				.execute();
			expect(owned.map((row) => row.remote_id)).toEqual(
				[...(mapped ? [landed.id] : []), ...siblings.map((t) => t.id)].sort(),
			);

			const writes = publishRequests(peer).filter((request) =>
				request.startsWith("POST "),
			);
			serveTableList(peer, DOMAIN, [unexpected, ...siblings]);
			expect(refusal(await run())).toMatchObject({
				failure: { code: "hq_resource_conflict" },
				resourceConflicts: [
					{ novaResourceId: table.id, remoteId: unexpected.id },
				],
			});
			expect(
				publishRequests(peer).filter((request) => request.startsWith("POST ")),
			).toEqual(writes);
		});
	},
);

it.each(["an unrelated table", "the observed table’s audience"] as const)(
	"resumes a mixed workbook publish against the actual file when %s changes",
	async (changed) => {
		await h.seedProjectMember(FIRST, PROJECT, "editor");
		await connect(h, FIRST, "india", [DOMAIN]);
		const grant = { kind: "session", sessionId: "workbook-session" } as const;
		await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES(${grant.sessionId},'workbook-test',${FIRST},now()+interval '1 hour',now(),now())`.execute(
			h.db(),
		);
		const small = await projectTable(PROJECT, FIRST);
		const scope = { actorId: FIRST, projectId: PROJECT, role: "editor" };
		const large = await createLookupTable(scope, {
			name: "Areas",
			tag: "areas",
			columns: [
				{ wireName: "code", label: "Code", dataType: "text" },
				{ wireName: "name", label: "Name", dataType: "text" },
			],
		});
		const fields = Array.from({ length: 1001 }, (_, i) => ({
			code: "r" + i,
			name: "Area " + i,
		}));
		await replaceLookupRows(scope, {
			tableId: large.id,
			expectedTableRevision: large.tableRevision,
			rows: fields.map((row) => ({
				[large.columns[0].id]: row.code,
				[large.columns[1].id]: row.name,
			})),
		});
		const doc = await appReading("mixed-books", PROJECT, FIRST, small, large);
		const target = "hq-mixed";
		const run = () => publish("mixed-books", PROJECT, FIRST, doc, [], grant);
		await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, []);
			acceptImport(peer, DOMAIN, 201, { appId: target });
			serveSource(peer, DOMAIN, "source-shell", target);
			takeWorkbook(peer, DOMAIN);
			serveTableList(peer, DOMAIN, [landed]);
			serveRows(peer, DOMAIN, landed);
			const refuse = () =>
				peer
					.get("https://india.commcarehq.org")
					.intercept({ method: "POST", path: "/a/clinic/fixtures/fixapi/" })
					.reply(403, "Denied");
			refuse();
			const first = await run();
			expect(first.landed, JSON.stringify(first)).toBe(false);
			const uploads = () =>
				publishRequests(peer).filter(
					(r) => r === "POST /a/clinic/fixtures/fixapi/",
				).length;
			expect(uploads()).toBe(2);
			serveTableList(peer, DOMAIN, [landed]);
			serveRows(peer, DOMAIN, landed);
			const afterShellRead = (edit: () => Promise<void>) => {
				const shell = retainedPublishRead("source-shell");
				peer
					.get("https://india.commcarehq.org")
					.intercept({
						method: "GET",
						path: `/a/${DOMAIN}/apps/source/${target}/`,
					})
					.reply(async () => {
						await edit();
						return {
							statusCode: shell.status,
							data: retainedBodyText(shell),
							responseOptions: { headers: { ...shell.headers } },
						};
					});
			};
			const before = publishRequests(peer).filter((r) => r.startsWith("POST"));
			if (changed === "an unrelated table") {
				afterShellRead(async () => {
					await createLookupTable(scope, {
						name: "Unrelated",
						tag: "unrelated",
						columns: [{ label: "Name", wireName: "name", dataType: "text" }],
					});
				});
				refuse();
				const retry = await run();
				expect(retry.landed, JSON.stringify(retry)).toBe(false);
				expect(uploads()).toBe(3);
			} else {
				afterShellRead(async () => {
					const current = await getLookupTable(scope, small.id);
					await withAppTx(async (tx) =>
						applyLookupAuthoringBatchInTransaction(
							tx,
							await authorizeLookupWriteInTransaction(tx, scope, "edit"),
							{
								operationId: v7(),
								updateTables: [
									{
										tableId: small.id,
										expectedTableRevision: current.tableRevision,
										workerAccess: "assigned",
									},
								],
							},
						),
					);
				});
				const held = await run();
				expect(held).toMatchObject({
					landed: false,
					refusal: { phase: "resources", failure: { code: "app_not_ready" } },
				});
				expect(
					publishRequests(peer).filter((r) => r.startsWith("POST")),
				).toEqual(before);
			}
			const maps = await h
				.db()
				.selectFrom("app_deployment_resources")
				.select("remote_id")
				.where("kind", "=", "lookup-table")
				.where("superseded_at", "is", null)
				.execute();
			expect(maps).toEqual([{ remote_id: landed.id }]);
		});
	},
	20_000,
);
