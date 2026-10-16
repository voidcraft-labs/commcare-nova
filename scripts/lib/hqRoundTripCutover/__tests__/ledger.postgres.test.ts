/**
 * The cutover's ledger writes over real Postgres: the identity rows each
 * deployment's reads give, the gone marker and the folded failure for a
 * deployment whose HQ app the reads found deleted, and the notice rows the
 * plan names. The reads are CommCare HQ's retained answers
 * (`proof/hq-reads/cutover/`), handed to the plan as the Job's reader would
 * hand them; the identity rows are then read back the way a publish reads
 * them and emitted, so the ids the first publish after the cutover sends are
 * compared with the ids the lane showed HQ keeping under such an update
 * (`proof/hq-reads/cutover/<document>/kept-ids/`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import {
	derivedFormXmlns,
	derivedUniqueId,
	targetWireIdentity,
} from "@/lib/commcare/wireIdentity";
import {
	type AppStateTestDb,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import { readDeploymentIdentityOverrides } from "@/lib/deployment/store";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { asUuid } from "@/lib/domain";
import type { DeploymentReads } from "../hqRead";
import type { BuildPlanOptions } from "../plan";
import { runMigrate } from "../run";
import { LEGACY_DIRECTORY, migratedFixtureDocument } from "./fixtures/preStep";
import {
	retainedCutoverRead,
	retainedFormIds,
	retainedSource,
} from "./fixtures/retainedCutoverReads";
import { fixtureApp, seedFixtureApp } from "./fixtures/seed";

/** The ids a `kept-ids` file records HQ holding, in its forms' order. */
interface KeptIds {
	readonly modules: readonly string[];
	readonly forms: readonly string[];
	readonly xmlns: readonly string[];
}

let h: AppStateTestDb;
const harness = setupAppStateTestDb("hq_cutover_ledger_", {
	authSchema: "migrated",
});
beforeEach(() => {
	h = harness;
});

const OWNER = "owner-ledger";
const PROJECT = "project-ledger";
const DOMAIN = "field-ops";

async function seedApp(document: string, appId: string): Promise<string> {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	await seedFixtureApp(
		h.db(),
		fixtureApp(document, { appId, projectId: PROJECT, owner: OWNER }),
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
	const id = deployment.rows[0]?.id ?? "";
	await sql`
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id,
			ownership, pushed_revision, pushed_at)
		VALUES (${id}::uuid, 'app', ${appId}, ${`hq-${appId}`}, 'nova-created',
			${Number(seq.rows[0]?.seq ?? "1")}, now())
	`.execute(h.db());
	await sql`
		INSERT INTO user_settings (user_id, commcare_username, commcare_api_key, commcare_server, approved_domains)
		VALUES (${OWNER}, 'owner@example.org', 'ciphertext', 'production',
			${JSON.stringify([{ name: DOMAIN, displayName: "Field ops" }])}::jsonb)
		ON CONFLICT (user_id) DO NOTHING
	`.execute(h.db());
	return id;
}

const USE = {
	userId: OWNER,
	firstUsedAt: "2026-10-15T10:00:00.000Z",
	lastUsedAt: "2026-10-15T10:00:07.000Z",
};
const ANSWER = { userId: OWNER, at: "2026-10-15T10:00:00.000Z" };

/** Execute the cutover with the given reads, after the dry run that prints its digest. */
async function execute(reads: () => Promise<DeploymentReads>) {
	const plan: BuildPlanOptions = { readDeployment: reads };
	const dryRun = await runMigrate(h.db(), { mode: "dry-run", plan });
	const digest = dryRun.report.all().find((line) => line.section === "fleet")
		?.planDigest as string;
	const executed = await runMigrate(h.db(), {
		mode: "execute",
		expectPlanDigest: digest,
		plan,
	});
	expect(executed.outcome).toEqual({ outcome: "ok" });
	return executed;
}

async function noticeReasons(appId: string): Promise<string[]> {
	const rows = await sql<{ entries: { reason: string }[] }>`
		SELECT entries FROM app_migration_notices WHERE app_id = ${appId}
	`.execute(h.db());
	return (rows.rows[0]?.entries ?? []).map((entry) => entry.reason);
}

describe("the ledger writes", () => {
	it("marks a deployment whose app HQ reports deleted gone, folds remote_app_missing, writes no identity row and says so", async () => {
		const appId = "app-deleted-remote";
		const deployment = await seedApp("navigation-base", appId);
		await execute(async () => ({
			source: { kind: "gone" },
			formIds: null,
			keyUses: [USE],
			sourceAnswer: null,
		}));
		const mapping = await sql<{ missing: boolean }>`
			SELECT remote_missing_at IS NOT NULL AS missing FROM app_deployment_resources
			WHERE deployment_id = ${deployment}::uuid AND kind = 'app'
		`.execute(h.db());
		expect(mapping.rows).toEqual([{ missing: true }]);
		const record = await sql<{
			state: string;
			resume_phase: string | null;
			phases: Record<
				string,
				{ status: string; failure?: { code: string } } | null
			>;
		}>`
			SELECT state, resume_phase, phases FROM app_deployments WHERE id = ${deployment}::uuid
		`.execute(h.db());
		expect(record.rows[0]?.state).toBe("incomplete");
		expect(record.rows[0]?.resume_phase).toBe("upload");
		expect(record.rows[0]?.phases.upload?.failure?.code).toBe(
			"remote_app_missing",
		);
		const identities = await sql`
			SELECT 1 FROM app_deployment_identities WHERE deployment_id = ${deployment}::uuid
		`.execute(h.db());
		expect(identities.rows).toEqual([]);
		// Its only deployment no longer holds the app, so a CCZ needs a publish.
		expect(await noticeReasons(appId)).toEqual([
			"hq-app-deleted",
			"local-archive-changes",
			"case-name-now-checked",
			"ccz-needs-project-space",
		]);
	}, 60_000);

	it("records nothing for a linked app and tells its members it is not Nova's", async () => {
		const appId = "app-linked-remote";
		const deployment = await seedApp("navigation-base", appId);
		await execute(async () => ({
			source: { kind: "unsupported", docType: "LinkedApplication" },
			formIds: null,
			keyUses: [USE],
			sourceAnswer: null,
		}));
		const identities = await sql`
			SELECT 1 FROM app_deployment_identities WHERE deployment_id = ${deployment}::uuid
		`.execute(h.db());
		expect(identities.rows).toEqual([]);
		expect(await noticeReasons(appId)).toEqual([
			"hq-app-not-nova-made",
			"local-archive-changes",
			"case-name-now-checked",
		]);
	}, 60_000);

	/** The ids the first publish after the cutover sends: the rows read the way a publish reads them, emitted. */
	async function firstPublishIds(appId: string) {
		const overrides = await readDeploymentIdentityOverrides(
			{ appId, projectId: PROJECT, role: "owner", actorUserId: OWNER },
			{ server: "production", domain: DOMAIN },
		);
		const loaded = await h
			.db()
			.transaction()
			.execute((tx) => loadAppInTransaction(tx, appId));
		if (loaded === null) throw new Error("The app no longer loads.");
		const doc = hydratePersistedBlueprint(loaded.blueprint);
		const emitted = expandDoc(doc, {
			identity: targetWireIdentity(overrides),
		});
		const forms = emitted.modules.flatMap((module) => module.forms);
		return {
			doc,
			overrides,
			ids: {
				modules: emitted.modules.map((module) => module.unique_id),
				forms: forms.map((form) => form.unique_id),
				xmlns: forms.map((form) => form.xmlns),
			},
		};
	}

	it.each(
		[
			"navigation-base",
			"targeted-form-links-hidden-and-fallback",
			"case-operation-query",
			"no-matches-parent",
		].flatMap((document) =>
			(["after-create", "after-republish"] as const).map(
				(state) => [document, state] as const,
			),
		),
	)(
		"records %s's ids from HQ's reads %s, and the first publish after the cutover sends exactly the ids HQ keeps",
		async (document, state) => {
			const appId = `app-kept-${document}-${state}`;
			await seedApp(document, appId);
			const source = await retainedSource(
				retainedCutoverRead(document, state, "app-source.json"),
			);
			const formIds = await retainedFormIds(
				retainedCutoverRead(document, state, "application.json"),
			);
			await execute(async () => ({
				source: { kind: "ok", value: source },
				formIds: { kind: "ok", value: formIds },
				keyUses: [USE],
				sourceAnswer: ANSWER,
			}));
			const { overrides, ids } = await firstPublishIds(appId);
			// A row holds only what differs from Nova's derivation.
			for (const row of overrides) {
				const uuid = asUuid(row.novaEntityUuid);
				expect(row.uniqueId).not.toBe(derivedUniqueId(uuid));
				expect(row.xmlns).not.toBe(derivedFormXmlns(uuid));
			}
			/* What the lane showed HQ keeping when an update names these ids:
			 * the same before and after each of its two updates. */
			const kept = JSON.parse(
				readFileSync(
					join(LEGACY_DIRECTORY, document, "kept-ids", `${state}.json`),
					"utf8",
				),
			) as { before: KeptIds; after: KeptIds[] };
			for (const held of [kept.before, ...kept.after])
				expect(ids).toEqual(held);
		},
		60_000,
	);

	it("writes no row for a menu whose HQ id is another entity's derived id, and names that menu", async () => {
		const appId = "app-id-collision";
		const deployment = await seedApp("navigation-base", appId);
		const doc = migratedFixtureDocument("navigation-base");
		const menu = doc.moduleOrder[0];
		const taken = derivedUniqueId(doc.formOrder[menu][0]);
		const source = await retainedSource(
			retainedCutoverRead(
				"navigation-base",
				"after-republish",
				"app-source.json",
			),
		);
		const formIds = await retainedFormIds(
			retainedCutoverRead(
				"navigation-base",
				"after-republish",
				"application.json",
			),
		);
		const held = source.modules[0].uniqueId;
		await execute(async () => ({
			source: {
				kind: "ok",
				value: {
					...source,
					modules: source.modules.map((module, index) =>
						index === 0 ? { ...module, uniqueId: taken } : module,
					),
				},
			},
			formIds: {
				kind: "ok",
				value: formIds.map((module) =>
					module.kind === "module" && module.uniqueId === held
						? { ...module, uniqueId: taken }
						: module,
				),
			},
			keyUses: [USE],
			sourceAnswer: ANSWER,
		}));
		const modules = await sql`
			SELECT 1 FROM app_deployment_identities
			WHERE deployment_id = ${deployment}::uuid AND entity_kind = 'module'
		`.execute(h.db());
		expect(modules.rows).toEqual([]);
		expect(await noticeReasons(appId)).toContain("menu-id-changes-once");
		const { ids } = await firstPublishIds(appId);
		expect(ids.modules).toEqual([derivedUniqueId(menu)]);
	}, 60_000);
});
