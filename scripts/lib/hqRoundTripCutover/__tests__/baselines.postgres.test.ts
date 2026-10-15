/**
 * The cutover's baselines over real Postgres (part 02 of step 2's plan, "The
 * cutover's baselines"): what the baseline step stores for each deployment's
 * app and for each table and place its live mappings name, whose key it
 * records as having read them, which drift lines the notice carries, and
 * that a read still transient stops the run with nothing written.
 *
 * The app's source is CommCare HQ's retained answer
 * (`proof/hq-reads/cutover/navigation-base/`), handed to the plan as the
 * Job's reader hands it. The table and place reads are handed in at the
 * reader's seam as outcomes: what HQ answers those reads is proven over its
 * own answers in `lib/deployment/__tests__/hqResourceBaseline.test.ts`, and
 * this file proves what the cutover stores from an answer.
 */

import { gunzipSync } from "node:zlib";
import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { HqLocation } from "@/lib/commcare/hq/locations";
import type {
	HqFixtureRow,
	HqLookupTable,
} from "@/lib/commcare/hq/lookupTables";
import { schemaPropertyDefault } from "@/lib/commcare/surface/schemaDefaults";
import {
	type AppStateTestDb,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import {
	canonicalLookupTable,
	canonicalPlace,
} from "@/lib/deployment/hqResourceBaseline";
import {
	diffHqAppSource,
	normalizeHqAppSource,
} from "@/lib/deployment/hqSourceBaseline";
import type { AppOwnership } from "@/lib/deployment/types";
import type { DeploymentReads, HqReadOutcome } from "../hqRead";
import type { BuildPlanOptions } from "../plan";
import { runMigrate } from "../run";
import {
	type ProjectSpaceReader,
	type ProjectSpaceReads,
	UNREAD_OBSERVER,
} from "../writer";
import {
	retainedCutoverRead,
	retainedFormIds,
	retainedSource,
} from "./fixtures/retainedCutoverReads";
import { fixtureApp, seedFixtureApp } from "./fixtures/seed";

let h: AppStateTestDb;
const harness = setupAppStateTestDb("hq_cutover_baselines_", {
	authSchema: "migrated",
});
beforeEach(() => {
	h = harness;
});

const OWNER = "owner-baselines";
const PROJECT = "project-baselines";
const DOMAIN = "field-ops";
const TABLE_UUID = "0199a000-0000-7000-8000-000000000001";
const PLACE_UUID = "0199a000-0000-7000-8000-000000000002";
const TABLE_ID = "hq-table-clinics";
const PLACE_ID = "hq-place-district-4";
const ANSWERED_AT = "2026-10-15T10:00:00.000Z";
const RESOURCES_AT = "2026-10-15T10:00:14.000Z";

interface Seeded {
	readonly appId: string;
	readonly deploymentId: string;
}

/** A navigation-base app with one deployment that maps its app, one table and one place. */
async function seed(appId: string): Promise<Seeded> {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	await seedFixtureApp(
		h.db(),
		fixtureApp("navigation-base", { appId, projectId: PROJECT, owner: OWNER }),
	);
	const seq = await sql<{ seq: string }>`
		SELECT mutation_seq::text AS seq FROM apps WHERE id = ${appId}
	`.execute(h.db());
	const deployment = await sql<{ id: string }>`
		INSERT INTO app_deployments (app_id, project_id, server, domain, state, phases, created_by)
		VALUES (${appId}, ${PROJECT}, 'production', ${DOMAIN}, 'released',
			'{"upload":{"status":"succeeded","at":"2026-10-01T00:00:00.000Z"}}'::jsonb, ${OWNER})
		RETURNING id::text AS id
	`.execute(h.db());
	const deploymentId = deployment.rows[0]?.id ?? "";
	await sql`
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id,
			ownership, pushed_identity, pushed_revision, pushed_at)
		VALUES
			(${deploymentId}::uuid, 'app', ${appId}, ${`hq-${appId}`}, 'nova-created', NULL,
				${Number(seq.rows[0]?.seq ?? "1")}, now()),
			(${deploymentId}::uuid, 'lookup-table', ${TABLE_UUID}, ${TABLE_ID}, 'nova-created',
				'clinics', NULL, now()),
			(${deploymentId}::uuid, 'location', ${PLACE_UUID}, ${PLACE_ID}, 'nova-created',
				'district-4', NULL, now())
	`.execute(h.db());
	await sql`
		INSERT INTO user_settings (user_id, commcare_username, commcare_api_key, commcare_server, approved_domains)
		VALUES (${OWNER}, 'owner@example.org', 'ciphertext', 'production',
			${JSON.stringify([{ name: DOMAIN, displayName: "Field ops" }])}::jsonb)
		ON CONFLICT (user_id) DO NOTHING
	`.execute(h.db());
	return { appId, deploymentId };
}

const USE = {
	userId: OWNER,
	firstUsedAt: ANSWERED_AT,
	lastUsedAt: "2026-10-15T10:00:07.000Z",
};

/** HQ's retained reads of the app as its first legacy publish left it. */
async function retainedReads(): Promise<DeploymentReads> {
	return {
		source: {
			kind: "ok",
			value: await retainedSource(
				retainedCutoverRead(
					"navigation-base",
					"after-create",
					"app-source.json",
				),
			),
		},
		formIds: {
			kind: "ok",
			value: await retainedFormIds(
				retainedCutoverRead(
					"navigation-base",
					"after-create",
					"application.json",
				),
			),
		},
		keyUses: [USE],
		sourceAnswer: { userId: OWNER, at: ANSWERED_AT },
	};
}

const TABLE: HqLookupTable = {
	id: TABLE_ID,
	tag: "clinics",
	isGlobal: true,
	fields: ["name", "code"],
	fieldProperties: { name: [], code: [] },
	itemAttributes: [],
};

const ROWS: readonly HqFixtureRow[] = [
	{ id: "row-1", fields: { name: "North", code: "n" } },
	{ id: "row-2", fields: { name: "South", code: "s" } },
];

const PLACE: HqLocation = {
	locationId: PLACE_ID,
	name: "District 4",
	siteCode: "district-4",
	locationTypeCode: "district",
	parentLocationId: null,
	latitude: "12.5000000000",
	longitude: null,
	values: { unmodeled: "kept by HQ" },
};

function answered<T>(outcome: HqReadOutcome<T>) {
	return {
		outcome,
		answer: outcome.kind === "ok" ? { userId: OWNER, at: RESOURCES_AT } : null,
	};
}

/** A project space reader that answers each read as given and records what it was asked. */
function spaceReader(
	answers: {
		readonly tables?: HqReadOutcome<readonly HqLookupTable[]>;
		readonly rows?: HqReadOutcome<{
			totalCount: number;
			rows: readonly HqFixtureRow[];
		}>;
		readonly places?: HqReadOutcome<readonly HqLocation[]>;
	},
	asked: Parameters<ProjectSpaceReader>[0][] = [],
): ProjectSpaceReader {
	return async (request) => {
		asked.push(request);
		const tables = answered(answers.tables ?? { kind: "ok", value: [TABLE] });
		const reads: ProjectSpaceReads = {
			tables: request.tableIds.length === 0 ? null : tables,
			rows:
				tables.outcome.kind === "ok"
					? new Map(
							request.tableIds.map((id) => [
								id,
								answered(
									answers.rows ?? {
										kind: "ok",
										value: { totalCount: ROWS.length, rows: ROWS },
									},
								),
							]),
						)
					: new Map(),
			places: request.places
				? answered(answers.places ?? { kind: "ok", value: [PLACE] })
				: null,
			keyUses: [
				{
					userId: OWNER,
					firstUsedAt: RESOURCES_AT,
					lastUsedAt: "2026-10-15T10:00:21.000Z",
				},
			],
		};
		return reads;
	};
}

/** Execute the cutover, after the dry run that prints its digest. */
async function execute(
	reads: () => Promise<DeploymentReads>,
	readProjectSpace: ProjectSpaceReader,
	options: { readonly transientAsUnreadable?: boolean } = {},
) {
	const plan: BuildPlanOptions = { readDeployment: reads };
	const dryRun = await runMigrate(h.db(), {
		mode: "dry-run",
		plan,
		readProjectSpace,
		...options,
	});
	const digest = dryRun.report.all().find((line) => line.section === "fleet")
		?.planDigest as string;
	return runMigrate(h.db(), {
		mode: "execute",
		expectPlanDigest: digest,
		plan,
		readProjectSpace,
		...options,
	});
}

async function appBaseline(deploymentId: string) {
	const rows = await sql<{
		remote_app_id: string;
		origin: string;
		source_gzip: Buffer | null;
		source_bytes: number | null;
		source_digest: string | null;
		ownership: AppOwnership | null;
		observed_at: Date;
		observed_by: string;
		discarded_digest: string | null;
	}>`
		SELECT remote_app_id, origin, source_gzip, source_bytes, source_digest,
			ownership, observed_at, observed_by, discarded_digest
		FROM app_deployment_baselines WHERE deployment_id = ${deploymentId}::uuid
	`.execute(h.db());
	return rows.rows;
}

async function resourceBaselines() {
	const rows = await sql<{
		project_id: string;
		server: string;
		domain: string;
		kind: string;
		remote_id: string;
		origin: string;
		canonical: unknown;
		digest: string | null;
		observed_at: Date;
		observed_by: string;
		observed_from_app_id: string;
	}>`
		SELECT project_id, server, domain, kind, remote_id, origin, canonical,
			digest, observed_at, observed_by, observed_from_app_id
		FROM project_space_resource_baselines ORDER BY kind, remote_id
	`.execute(h.db());
	return rows.rows.map((row) => ({
		...row,
		observed_at: row.observed_at.toISOString(),
	}));
}

async function deploymentNotices(appId: string) {
	const rows = await sql<{
		entries: {
			kind: string;
			reason: string;
			entities?: { type: string; uuid?: string; nameAtMigration: string }[];
		}[];
	}>`
		SELECT entries FROM app_migration_notices WHERE app_id = ${appId}
	`.execute(h.db());
	return (rows.rows[0]?.entries ?? []).filter(
		(entry) => entry.kind === "deployment",
	);
}

describe("the cutover's baselines", () => {
	it("stores HQ's source read as a cutover baseline that an unchanged app's next read equals, and the table and place HQ answered", async () => {
		const { appId, deploymentId } = await seed("app-baselines-read");
		const asked: Parameters<ProjectSpaceReader>[0][] = [];
		const executed = await execute(retainedReads, spaceReader({}, asked));
		expect(executed.outcome).toEqual({ outcome: "ok" });
		// One read of each kind for the project space, through the member's key.
		expect(asked).toEqual([
			{
				server: "production",
				domain: DOMAIN,
				credentials: [OWNER],
				tableIds: [TABLE_ID],
				places: true,
			},
			{
				server: "production",
				domain: DOMAIN,
				credentials: [OWNER],
				tableIds: [TABLE_ID],
				places: true,
			},
		]);

		const [app] = await appBaseline(deploymentId);
		expect(app).toMatchObject({
			remote_app_id: `hq-${appId}`,
			origin: "cutover",
			observed_by: OWNER,
			discarded_digest: null,
		});
		expect(app?.observed_at.toISOString()).toBe(ANSWERED_AT);
		// The stored text is the normalized read, and its digest verifies.
		const first = (await retainedReads()).source;
		if (first?.kind !== "ok") throw new Error("The retained read is not ok.");
		const normalized = normalizeHqAppSource(first.value.raw);
		if ("malformed" in normalized) throw new Error("The read is malformed.");
		const text = gunzipSync(app?.source_gzip ?? Buffer.alloc(0)).toString(
			"utf8",
		);
		expect(text).toBe(normalized.text);
		expect(app?.source_digest).toBe(normalized.digest);
		expect(app?.source_bytes).toBe(normalized.bytes);
		// The ownership is the body's over this read: the two form list
		// settings of the profile, and the add-ons the document needs, which
		// for this fixture are none.
		const ownership = app?.ownership as AppOwnership;
		expect(ownership.profileProperties).toEqual([
			"cc-show-saved",
			"cc-show-incomplete",
		]);
		expect(ownership.addOns).toEqual([]);

		// HQ's second read of the unchanged app compares equal to the stored
		// baseline, so the first publish after the cutover proceeds.
		const again = await retainedSource(
			retainedCutoverRead(
				"navigation-base",
				"after-create",
				"app-source-again.json",
			),
		);
		const current = normalizeHqAppSource(again.raw);
		if ("malformed" in current) throw new Error("The read is malformed.");
		expect(
			diffHqAppSource({
				baseline: JSON.parse(text),
				current: current.normalized,
				ownership,
				shell: false,
				schemaDefault: schemaPropertyDefault,
			}),
		).toEqual([]);

		const table = canonicalLookupTable(TABLE, ROWS);
		const place = canonicalPlace(PLACE, []);
		expect(await resourceBaselines()).toEqual([
			{
				project_id: PROJECT,
				server: "production",
				domain: DOMAIN,
				kind: "location",
				remote_id: PLACE_ID,
				origin: "cutover",
				canonical: place,
				digest: place.digest,
				observed_at: RESOURCES_AT,
				observed_by: OWNER,
				observed_from_app_id: appId,
			},
			{
				project_id: PROJECT,
				server: "production",
				domain: DOMAIN,
				kind: "lookup-table",
				remote_id: TABLE_ID,
				origin: "cutover",
				canonical: table,
				digest: table.digest,
				observed_at: RESOURCES_AT,
				observed_by: OWNER,
				observed_from_app_id: appId,
			},
		]);

		// The first publish there writes over HQ's earlier edits, and says so.
		expect(
			(await deploymentNotices(appId)).map((entry) => entry.reason),
		).toContain("next-publish-overwrites-hq-edits");
		expect(
			(await deploymentNotices(appId)).map((entry) => entry.reason),
		).not.toContain("next-publish-asks-before-overwriting");

		// The table and place reads' key use is recorded with the source read's.
		const readers = await sql<{ first_used_at: Date; last_used_at: Date }>`
			SELECT first_used_at, last_used_at FROM app_migration_notice_key_readers
			WHERE user_id = ${OWNER} AND domain = ${DOMAIN}
		`.execute(h.db());
		expect(readers.rows).toHaveLength(1);
		expect(readers.rows[0]?.last_used_at.toISOString()).toBe(
			"2026-10-15T10:00:21.000Z",
		);
	}, 60_000);

	it("stores an unread app baseline for a deployment no key could read, and says the next publish asks", async () => {
		const { appId, deploymentId } = await seed("app-baselines-unreadable");
		const executed = await execute(
			async () => ({
				source: { kind: "refused", status: 401 },
				formIds: null,
				keyUses: [USE],
				sourceAnswer: null,
			}),
			spaceReader({}),
		);
		expect(executed.outcome).toEqual({ outcome: "ok" });
		const [app] = await appBaseline(deploymentId);
		expect(app).toMatchObject({
			origin: "unread",
			source_gzip: null,
			source_digest: null,
			ownership: null,
			observed_by: UNREAD_OBSERVER,
		});
		const notices = await deploymentNotices(appId);
		expect(notices.map((entry) => entry.reason)).toEqual([
			"ids-change-once-unreadable",
			"next-publish-asks-before-overwriting",
			"settings-unknown-unreadable",
		]);
		// The app's own baseline is the one not read, so the line names no table or place.
		expect(notices[1]?.entities).toBeUndefined();
	}, 60_000);

	it("stores an unread baseline for a table whose rows HQ would not give, and names it", async () => {
		const { appId } = await seed("app-baselines-rows-unread");
		const executed = await execute(
			retainedReads,
			spaceReader({ rows: { kind: "unreadable", cause: "malformed" } }),
		);
		expect(executed.outcome).toEqual({ outcome: "ok" });
		const table = (await resourceBaselines()).find(
			(row) => row.kind === "lookup-table",
		);
		expect(table).toMatchObject({
			origin: "unread",
			canonical: null,
			digest: null,
			observed_by: UNREAD_OBSERVER,
		});
		const asks = (await deploymentNotices(appId)).find(
			(entry) => entry.reason === "next-publish-asks-before-overwriting",
		);
		// No Nova table of that id exists, so the line keeps the tag it was pushed under.
		expect(asks?.entities).toEqual([
			{ type: "lookupTable", uuid: TABLE_UUID, nameAtMigration: "clinics" },
		]);
	}, 60_000);

	it("stores no baseline for a table or place HQ no longer lists", async () => {
		await seed("app-baselines-gone");
		const executed = await execute(
			retainedReads,
			spaceReader({
				tables: { kind: "ok", value: [] },
				places: { kind: "ok", value: [] },
			}),
		);
		expect(executed.outcome).toEqual({ outcome: "ok" });
		expect(await resourceBaselines()).toEqual([]);
	}, 60_000);

	it("stops the run with nothing written on a table read still transient, and stores unread under --transient-as-unreadable", async () => {
		const { deploymentId } = await seed("app-baselines-transient");
		const reader = spaceReader({
			rows: { kind: "transient", cause: "5xx" },
		});
		const stopped = await execute(retainedReads, reader);
		expect(stopped.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["transient"],
		});
		expect(
			stopped.report
				.all()
				.filter((line) => line.section === "baseline-transient")
				.map(({ read, deploymentIds }) => ({ read, deploymentIds })),
		).toEqual([{ read: "lookup-table-rows", deploymentIds: [deploymentId] }]);
		expect(await appBaseline(deploymentId)).toEqual([]);
		expect(await resourceBaselines()).toEqual([]);

		const second = await execute(retainedReads, reader, {
			transientAsUnreadable: true,
		});
		expect(second.outcome).toEqual({ outcome: "ok" });
		expect(
			(await resourceBaselines()).map(({ kind, origin }) => ({
				kind,
				origin,
			})),
		).toEqual([
			{ kind: "location", origin: "cutover" },
			{ kind: "lookup-table", origin: "unread" },
		]);
	}, 60_000);

	it("stores an unread app baseline for a linked app and no drift line, and none for an app HQ deleted", async () => {
		const linked = await seed("app-baselines-linked");
		await execute(
			async () => ({
				source: { kind: "unsupported", docType: "LinkedApplication" },
				formIds: null,
				keyUses: [USE],
				sourceAnswer: { userId: OWNER, at: ANSWERED_AT },
			}),
			spaceReader({}),
		);
		expect(await appBaseline(linked.deploymentId)).toMatchObject([
			{ origin: "unread", observed_by: UNREAD_OBSERVER },
		]);
		expect(
			(await deploymentNotices(linked.appId)).map((entry) => entry.reason),
		).toEqual(["hq-app-not-nova-made"]);
	}, 60_000);

	it("stores no app baseline for an app HQ reports deleted", async () => {
		const { deploymentId } = await seed("app-baselines-deleted");
		await execute(
			async () => ({
				source: { kind: "gone" },
				formIds: null,
				keyUses: [USE],
				sourceAnswer: { userId: OWNER, at: ANSWERED_AT },
			}),
			spaceReader({}),
		);
		expect(await appBaseline(deploymentId)).toEqual([]);
	}, 60_000);
});
