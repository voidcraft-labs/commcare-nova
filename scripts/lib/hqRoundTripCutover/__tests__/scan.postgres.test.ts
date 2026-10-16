/**
 * The advisory scan over a seeded pre-step database: its counts, its
 * blockers and holders, the deployments it can class without HQ, and that
 * it runs whole as a role that may only read.
 */

import { produce } from "immer";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { asUuid } from "@/lib/domain";
import { MODULE_BUILTIN_ICON_REFS } from "@/lib/domain/builtinIcons";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import type { ReportLine } from "../report";
import { runScan } from "../run";
import {
	carriersOf,
	migratedFixtureDocument,
	readFixtureCarriers,
	readFixtureSchemas,
} from "./fixtures/preStep";
import { fixtureApp, seedFixtureApp } from "./fixtures/seed";

const h = setupAppStateTestDb("hq_cutover_scan_", { authSchema: "migrated" });

const OWNER = "owner-scan";
const PROJECT = "project-scan";
const OTHER_PROJECT = "project-other";

function section(lines: readonly ReportLine[], name: string) {
	return lines.filter((line) => line.section === name);
}

/** navigation-base with a built-in menu icon and an uploaded form icon. */
function withIcons(assetId: string) {
	const doc = migratedFixtureDocument("navigation-base");
	const [menu] = doc.moduleOrder;
	const [form] = doc.formOrder[menu ?? asUuid("")] ?? [];
	const next = produce(doc, (draft) => {
		applyMutations(draft, [
			{
				kind: "setModuleMedia",
				uuid: menu,
				icon: MODULE_BUILTIN_ICON_REFS[0],
				audioLabel: null,
			},
			{
				kind: "setFormMedia",
				uuid: form,
				icon: asMediaAssetId(assetId),
				audioLabel: null,
			},
		] as never);
	});
	return carriersOf(toPersistableDoc(next));
}

async function seedImage(id: string, projectId: string): Promise<void> {
	await sql`
		INSERT INTO media_assets (id, project_id, owner, content_hash, mime_type, extension,
			size_bytes, dimensions, kind, gcs_object_key, original_filename, status)
		VALUES (${id}::uuid, ${projectId}, ${OWNER}, ${"a".repeat(64)}, 'image/png', '.png',
			68, '{"width":1,"height":1}'::jsonb, 'image', ${`projects/${projectId}/${id}.png`},
			'icon.png', 'ready')
	`.execute(h.db());
}

describe("the advisory scan", () => {
	it("counts holders and blockers, classes deployments it cannot read, and reads nothing but rows", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await h.seedProjectMember(OWNER, OTHER_PROJECT, "owner");
		await seedFixtureApp(
			h.db(),
			fixtureApp("navigation-base", {
				appId: "app-a-clean",
				projectId: PROJECT,
				owner: OWNER,
			}),
		);
		const ownAsset = "018f0000-0000-7000-8000-0000000a0001";
		const foreignAsset = "018f0000-0000-7000-8000-0000000a0002";
		await seedImage(ownAsset, PROJECT);
		await seedImage(foreignAsset, OTHER_PROJECT);
		await seedFixtureApp(h.db(), {
			appId: "app-b-own-media",
			projectId: PROJECT,
			owner: OWNER,
			carriers: withIcons(ownAsset),
			schemas: readFixtureSchemas("navigation-base"),
		});
		await seedFixtureApp(h.db(), {
			appId: "app-c-foreign-media",
			projectId: PROJECT,
			owner: OWNER,
			carriers: withIcons(foreignAsset),
			schemas: readFixtureSchemas("navigation-base"),
		});
		const drifted = readFixtureSchemas("navigation-base");
		const [driftedType] = Object.keys(drifted);
		await seedFixtureApp(h.db(), {
			...fixtureApp("navigation-base", {
				appId: "app-d-drifted",
				projectId: PROJECT,
				owner: OWNER,
			}),
			schemas: {
				...drifted,
				[driftedType ?? ""]: {
					type: "object",
					properties: { name: { type: "integer" } },
				},
			},
		});
		await seedFixtureApp(
			h.db(),
			fixtureApp("navigation-base", {
				appId: "app-e-retired-type",
				projectId: PROJECT,
				owner: OWNER,
			}),
		);
		const { "commcare-user": _worker, ...withoutWorker } =
			readFixtureSchemas("navigation-base");
		await seedFixtureApp(h.db(), {
			...fixtureApp("navigation-base", {
				appId: "app-g-no-worker-row",
				projectId: PROJECT,
				owner: OWNER,
			}),
			schemas: withoutWorker,
		});
		await sql`
			INSERT INTO case_type_schemas (app_id, case_type, schema, synced_seq, retired_seq)
			VALUES ('app-e-retired-type', 'retired_type', '{"type":"object","properties":{}}'::jsonb, 1, 1)
		`.execute(h.db());
		await h.seedApp({
			id: "app-f-live",
			owner: OWNER,
			project_id: PROJECT,
			run_id: "run-live",
			run_holder_nonce: "6a0a35a4-1111-4222-8333-944445555777",
			run_lock: {
				runId: "run-live",
				actorUserId: OWNER,
				expireAt: new Date(Date.now() + 600_000),
			},
		});
		await sql`
			INSERT INTO user_settings (user_id, commcare_username, commcare_api_key, commcare_server, approved_domains)
			VALUES (${OWNER}, 'owner@example.org', 'ciphertext', 'production', '[{"name":"field-ops","displayName":"Field ops"}]'::jsonb)
		`.execute(h.db());
		const deployments: string[] = [];
		for (const domain of ["field-ops", "elsewhere"]) {
			const row = await sql<{ id: string }>`
				INSERT INTO app_deployments (app_id, project_id, server, domain, state, phases, created_by)
				VALUES ('app-a-clean', ${PROJECT}, 'production', ${domain}, 'uploaded', '{}'::jsonb, ${OWNER})
				RETURNING id::text AS id
			`.execute(h.db());
			const id = row.rows[0]?.id ?? "";
			deployments.push(id);
			await sql`
				INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id, ownership, pushed_revision, pushed_at)
				VALUES (${id}::uuid, 'app', 'app-a-clean', ${`hq-${domain}`}, 'nova-created', 1, now())
			`.execute(h.db());
		}
		await sql`
			INSERT INTO app_deployments (app_id, project_id, server, domain, state, phases, created_by)
			VALUES ('app-a-clean', ${PROJECT}, 'production', 'never-mapped', 'preflight', '{}'::jsonb, ${OWNER})
		`.execute(h.db());
		// A live app mapping with no pushed revision is a blocker; a lookup
		// table mapping holds none by design and is never counted.
		const unpushed = await sql<{ id: string }>`
			INSERT INTO app_deployments (app_id, project_id, server, domain, state, phases, created_by)
			VALUES ('app-b-own-media', ${PROJECT}, 'production', 'unpushed', 'uploaded', '{}'::jsonb, ${OWNER})
			RETURNING id::text AS id
		`.execute(h.db());
		await sql`
			INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id, ownership, pushed_revision, pushed_at)
			VALUES (${unpushed.rows[0]?.id ?? ""}::uuid, 'app', 'app-b-own-media', 'hq-unpushed', 'nova-created', NULL, NULL)
		`.execute(h.db());
		await sql`
			INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id, ownership, pushed_revision, pushed_at)
			VALUES (${deployments[0] ?? ""}::uuid, 'lookup-table', 'table-1', 'hq-table-1', 'nova-created', NULL, NULL)
		`.execute(h.db());

		await sql`CREATE ROLE cutover_scan_reader NOLOGIN`.execute(h.db());
		await sql`GRANT USAGE ON SCHEMA public TO cutover_scan_reader`.execute(
			h.db(),
		);
		await sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO cutover_scan_reader`.execute(
			h.db(),
		);
		const pool = new Pool({
			connectionString: h.uri(),
			options: "-c role=cutover_scan_reader",
			max: 1,
		});
		const reader = new Kysely<AppDatabase>({
			dialect: new PostgresDialect({ pool }),
		});
		try {
			const before = await sql<{ id: string; mutation_seq: string }>`
				SELECT id, mutation_seq::text AS mutation_seq FROM apps ORDER BY id
			`.execute(h.db());
			const result = await runScan(reader);
			const lines = result.report.all();
			expect(result.exitCode).toBe(1);
			expect(section(lines, "fleet")[0]).toMatchObject({
				apps: 7,
				appsDeleted: 0,
			});
			expect(section(lines, "holders")[0]).toMatchObject({
				live: 1,
				liveApps: ["app-f-live"],
			});
			const blockers = Object.fromEntries(
				section(lines, "blocker").map((line) => [line.code, line]),
			);
			// Only the retyped authored property differs. The retired type's
			// inactive row is no difference, and neither is a missing worker case
			// row (app-g, and the live app seeded with no schemas at all): that
			// row materializes lazily on first use.
			expect(blockers["case-schema-change"]).toMatchObject({
				count: 1,
				apps: ["app-d-drifted"],
			});
			expect(blockers["app-mapping-without-pushed-revision"]).toMatchObject({
				count: 1,
				apps: ["app-b-own-media"],
			});
			expect(blockers["target-export-readiness"]).toMatchObject({
				apps: ["app-c-foreign-media"],
				findingCodes: ["MEDIA_ASSET_NOT_FOUND"],
			});
			expect(section(lines, "deployments")[0]).toMatchObject({
				noAppMapping: 1,
				noCredential: [deployments[1], unpushed.rows[0]?.id],
				appMappingsWithoutPushedRevision: 1,
				publishedDocumentStored: 2,
			});
			expect(section(lines, "outcome")[0]).toMatchObject({
				outcome: "stopped",
				stoppedBy: ["blocker", "holder"],
			});
			const after = await sql<{ id: string; mutation_seq: string }>`
				SELECT id, mutation_seq::text AS mutation_seq FROM apps ORDER BY id
			`.execute(h.db());
			expect(after.rows).toEqual(before.rows);
		} finally {
			await reader.destroy();
		}
	}, 30_000);

	it("stops on a menu step hidden-from-menu takes off the menu while a form link opens it", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const id = "hand-hidden-menu-is-a-destination";
		const carriers = readFixtureCarriers(id);
		// The menu's condition is one step time-ordering would leave as never.
		const never = {
			...carriers,
			rows: carriers.rows.map((row) =>
				row.uuid === "00000000-0000-4000-8000-000000000c01"
					? {
							...row,
							data_text: JSON.stringify({
								...JSON.parse(row.data_text),
								displayCondition: { kind: "match-none" },
							}),
						}
					: row,
			),
		};
		await seedFixtureApp(h.db(), {
			appId: "app-hidden-destination",
			projectId: PROJECT,
			owner: OWNER,
			carriers: never,
			schemas: readFixtureSchemas(id),
		});
		const result = await runScan(h.db());
		const blockers = Object.fromEntries(
			section(result.report.all(), "blocker").map((line) => [line.code, line]),
		);
		expect(blockers["hidden-menu-is-a-destination"]).toMatchObject({
			count: 1,
			apps: ["app-hidden-destination"],
		});
		expect(blockers["target-gate"]).toMatchObject({
			apps: ["app-hidden-destination"],
			findingCodes: ["HIDDEN_MENU_NOT_A_DESTINATION"],
		});
		expect(result.exitCode).toBe(1);
	}, 30_000);
});
