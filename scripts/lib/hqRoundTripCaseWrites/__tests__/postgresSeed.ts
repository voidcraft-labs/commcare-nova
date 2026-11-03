/**
 * Seeds the case-writes cutover's Postgres tests at `main`'s migration
 * prefix (`caseStoreMigrationsBefore` the publish-placement migration) with
 * the rows a pre-step deployment of Nova left behind, written as raw SQL,
 * because no writer at the head can write a pre-step document: the head
 * schema refuses the field writes, the attachment mode and the structured
 * close condition every fixture holds (step 3's and step 4's helpers of the
 * same name are the template).
 *
 * An app is a pre-step fixture's carriers (`rawFixture.ts::
 * carriersOfPersistedDoc`, the `apps` root and one `blueprint_entities` row
 * per entity), its genesis marker and its fold baseline at sequence 1, the
 * baseline's snapshot the database's own `nova_current_app_change_fold_
 * snapshot` over those rows. The database's triggers are held for each
 * seeding transaction (`session_replication_role = replica`, the test
 * database's own superuser).
 *
 * A published deployment's baseline is CommCare HQ's read of the witness,
 * normalized and gzipped as a publish stores it
 * (`lib/deployment/hqSourceBaseline.ts::normalizeHqAppSource`).
 *
 * `databaseImage` reads every row the cutover could touch as text, and every
 * constraint and routine through `catalog.ts`, which names each relation by
 * schema, so the image holds the live objects and never an app-test
 * namespace's copies of them (part 09 §15.2 and §21.2's lesson).
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { type Kysely, sql, type Transaction } from "kysely";
import type { AppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { AppDatabase } from "@/lib/db/pg";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import {
	relationConstraints,
	routineDefinition,
	schemaRoutines,
} from "../catalog";
import { carriersOfPersistedDoc, readPreStepJson } from "./rawFixture";

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;
type JsonObject = Record<string, unknown>;

/** The fixture a published app is seeded from: its witness's HQ read is
 *  the baseline. */
export const PUBLISHED_FIXTURE = "targeted-migration-case-writes";

// ─── Apps ─────────────────────────────────────────────────────────────────

/** A pre-step fixture's stored document, optionally edited in place first. */
export function preStepDocument(
	fixtureId: string,
	edit?: (doc: JsonObject) => void,
): JsonObject {
	const doc = structuredClone(
		readPreStepJson(`${fixtureId}.json`),
	) as JsonObject;
	edit?.(doc);
	return doc;
}

/** An edit giving the document's first module an entry point, which the
 *  head schema reads as it is. */
export function withEntryPoint(doc: JsonObject): void {
	const order = doc.moduleOrder as string[];
	const modules = doc.modules as Record<string, JsonObject>;
	const first = order[0];
	if (first === undefined || modules[first] === undefined)
		throw new Error("The fixture holds no module to give an entry point.");
	modules[first].entryPoint = { uuid: randomUUID(), id: "first-menu" };
}

export interface SeedPreStepApp {
	readonly fixtureId: string;
	readonly appId: string;
	readonly projectId: string;
	readonly owner: string;
	readonly deletedAt?: Date;
	readonly edit?: (doc: JsonObject) => void;
}

/** Insert one pre-step app's rows at sequence 1, with the triggers held. */
export async function seedPreStepApp(
	db: Kysely<AppDatabase>,
	app: SeedPreStepApp,
): Promise<void> {
	const { root, rows } = carriersOfPersistedDoc(
		preStepDocument(app.fixtureId, app.edit),
	);
	const modules = rows.filter((row) => row.kind === "module").length;
	const forms = rows.filter((row) => row.kind === "form").length;
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, connect_type,
				case_types, localization, app_settings, logo, module_count, form_count,
				mutation_seq, status, deleted_at, recoverable_until)
			VALUES (${app.appId}, ${app.owner}, ${app.projectId}, ${root.app_name},
				${root.app_name.toLowerCase()}, ${root.connect_type},
				${root.case_types_text}::jsonb, ${root.localization_text ?? null}::jsonb,
				${root.app_settings_text}::jsonb, ${root.logo}, ${modules}, ${forms}, 1,
				'complete', ${app.deletedAt ?? null}::timestamptz,
				${app.deletedAt === undefined ? null : new Date(app.deletedAt.getTime() + 30 * 86_400_000)}::timestamptz)
		`.execute(tx);
		for (const row of rows) {
			await sql`
				INSERT INTO blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
				VALUES (${app.appId}, ${row.uuid}, ${row.kind}, ${row.parent_uuid}, ${row.ordinal},
					${row.data_text}::jsonb)
			`.execute(tx);
		}
		await sql`
			INSERT INTO app_changes (app_id, seq, batch_id, run_id, actor_id, kind, mutations,
				from_project_id, to_project_id)
			VALUES (${app.appId}, 1, ${`genesis:${app.appId}`}, NULL, ${app.owner}, 'fold-baseline',
				'[]'::jsonb, NULL, NULL)
		`.execute(tx);
		await sql`
			INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
			SELECT app.id, 1, app.project_id, current.snapshot,
				nova_app_change_fold_snapshot_digest(current.snapshot)
			FROM apps AS app,
				LATERAL (SELECT nova_current_app_change_fold_snapshot(app.id) AS snapshot) AS current
			WHERE app.id = ${app.appId}
		`.execute(tx);
	});
}

/** The apps of a seeded fleet. */
export interface SeededFleet {
	/** Every app, in code-point order of id. */
	readonly appIds: readonly string[];
	/** One app per fixture, by fixture id. */
	readonly byFixture: ReadonlyMap<string, string>;
	readonly deletedAppId: string;
}

/**
 * One app per given fixture, ids `app-<nn>-<fixture>`, the published
 * fixture's app given an entry point, and one more of the first fixture,
 * deleted.
 */
export async function seedPreStepFleet(
	db: Kysely<AppDatabase>,
	args: {
		readonly fixtureIds: readonly string[];
		readonly projectId: string;
		readonly owner: string;
	},
): Promise<SeededFleet> {
	const byFixture = new Map<string, string>();
	for (const [index, fixtureId] of args.fixtureIds.entries()) {
		const appId = `app-${String(index).padStart(2, "0")}-${fixtureId}`;
		await seedPreStepApp(db, {
			fixtureId,
			appId,
			projectId: args.projectId,
			owner: args.owner,
			...(fixtureId === PUBLISHED_FIXTURE && { edit: withEntryPoint }),
		});
		byFixture.set(fixtureId, appId);
	}
	const first = args.fixtureIds[0];
	if (first === undefined)
		throw new Error("A seeded fleet needs at least one fixture.");
	const deletedAppId = "app-99-deleted";
	await seedPreStepApp(db, {
		fixtureId: first,
		appId: deletedAppId,
		projectId: args.projectId,
		owner: args.owner,
		deletedAt: new Date("2026-10-01T00:00:00Z"),
	});
	return {
		appIds: [...byFixture.values(), deletedAppId].sort(),
		byFixture,
		deletedAppId,
	};
}

// ─── Deployments ──────────────────────────────────────────────────────────

/** A baseline's stored bytes: the gzip of `text`, its size and the
 *  SHA-256 of `text` in hex, as `lib/deployment/service.ts` stores them. */
export interface BaselineBytes {
	readonly gzip: Buffer;
	readonly bytes: number;
	readonly digest: string;
}

function bytesOf(text: string): BaselineBytes {
	const buffer = Buffer.from(text, "utf8");
	return {
		gzip: gzipSync(buffer),
		bytes: buffer.length,
		digest: createHash("sha256").update(buffer).digest("hex"),
	};
}

/** CommCare HQ's read of a witness, normalized as a publish stores it. */
export function hqBaselineBytes(fixtureId: string): BaselineBytes {
	const response = JSON.parse(
		readFileSync(
			new URL(
				`../../../../proof/hq-reads/${fixtureId}/app-source.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as { body: string };
	const normalized = normalizeHqAppSource(JSON.parse(response.body));
	if ("malformed" in normalized)
		throw new Error(
			`The HQ read of ${fixtureId} is not an application (${normalized.malformed}), so it cannot stand for a baseline.`,
		);
	return bytesOf(normalized.text);
}

/** The empty app a first publish creates, as an origin `create` baseline. */
export function shellBaselineBytes(): BaselineBytes {
	return bytesOf(
		canonicalJsonText({
			_attachments: {},
			doc_type: "Application",
			modules: [],
		}),
	);
}

/** Bytes that gunzip and parse, stored with the digest of other bytes: a
 *  baseline that no longer verifies. */
export function digestFailingBaselineBytes(fixtureId: string): BaselineBytes {
	const bytes = hqBaselineBytes(fixtureId);
	return {
		...bytes,
		digest: createHash("sha256").update("other").digest("hex"),
	};
}

export interface SeedDeployment {
	readonly id: string;
	readonly appId: string;
	readonly projectId: string;
	readonly domain: string;
	/** Default `uploaded`. */
	readonly state?: "resources" | "uploaded" | "built" | "released" | "runnable";
	/** No baseline row where absent. */
	readonly baseline?:
		| {
				readonly origin: "push" | "cutover" | "create";
				readonly bytes: BaselineBytes;
		  }
		| { readonly origin: "unread" };
	readonly pushedRevision?: number;
	/** CommCare HQ reported the app gone. */
	readonly remoteMissing?: boolean;
	readonly overrides?: readonly {
		readonly entityKind: "module" | "form";
		readonly novaEntityUuid: string;
		readonly uniqueId: string | null;
		readonly xmlns: string | null;
	}[];
	/** A published entry-point manifest at the app's pre-step sequence. */
	readonly entryPointManifest?: boolean;
}

/** Insert one deployment with its live `app` mapping, its baseline and its
 *  identity overrides. */
export async function seedDeployment(
	db: Db,
	args: SeedDeployment,
): Promise<void> {
	const remoteAppId = `remote-${args.appId}`;
	await sql`
		INSERT INTO app_deployments (id, app_id, project_id, server, domain, state, phases,
			created_by, entry_point_manifest)
		VALUES (${args.id}::uuid, ${args.appId}, ${args.projectId}, 'production',
			${args.domain}, ${args.state ?? "uploaded"}, '{}'::jsonb, 'owner',
			${
				args.entryPointManifest === true
					? JSON.stringify({
							generation: randomUUID(),
							remoteAppId,
							sourceSequence: 1,
							entries: [],
							dependencies: [],
						})
					: null
			}::jsonb)
	`.execute(db);
	await sql`
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id,
			remote_id, ownership, pushed_at, pushed_revision, remote_missing_at)
		VALUES (${args.id}::uuid, 'app', ${args.appId}, ${remoteAppId}, 'nova-created',
			'2026-10-01T00:00:00Z', ${args.pushedRevision ?? 1},
			${args.remoteMissing === true ? "2026-10-02T00:00:00Z" : null}::timestamptz)
	`.execute(db);
	for (const override of args.overrides ?? []) {
		await sql`
			INSERT INTO app_deployment_identities (deployment_id, entity_kind, nova_entity_uuid,
				unique_id, xmlns)
			VALUES (${args.id}::uuid, ${override.entityKind}, ${override.novaEntityUuid}::uuid,
				${override.uniqueId}, ${override.xmlns})
		`.execute(db);
	}
	const baseline = args.baseline;
	if (baseline === undefined) return;
	if (baseline.origin === "unread") {
		await sql`
			INSERT INTO app_deployment_baselines (deployment_id, remote_app_id, origin,
				observed_at, observed_by)
			VALUES (${args.id}::uuid, ${remoteAppId}, 'unread', '2026-10-01T00:00:00Z', 'owner')
		`.execute(db);
		return;
	}
	await sql`
		INSERT INTO app_deployment_baselines (deployment_id, remote_app_id, origin,
			source_gzip, source_bytes, source_digest, ownership, observed_at, observed_by)
		VALUES (${args.id}::uuid, ${remoteAppId}, ${baseline.origin}, ${baseline.bytes.gzip},
			${baseline.bytes.bytes}, ${baseline.bytes.digest}, '{}'::jsonb,
			'2026-10-01T00:00:00Z', 'owner')
	`.execute(db);
}

/** The published app's three deployments: a `push` baseline holding HQ's
 *  read of its witness, a `create` one and an `unread` one. */
export const PUBLISHED_DEPLOYMENTS = {
	push: "0b6c6a5e-2222-4a5e-9c1e-000000000001",
	create: "0b6c6a5e-2222-4a5e-9c1e-000000000002",
	unread: "0b6c6a5e-2222-4a5e-9c1e-000000000003",
} as const;

/**
 * Publish the app seeded from `PUBLISHED_FIXTURE` to three project spaces:
 * one whose baseline is HQ's read of the witness (origin `push`, with an
 * entry-point manifest), one holding the empty app a first publish made
 * (`create`) and one Nova never read (`unread`). `digestFails` stores the
 * push baseline with the digest of other bytes, which the plan refuses
 * with `baseline-unreadable`.
 */
export async function seedPublishedDeployments(
	db: Db,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly digestFails?: boolean;
	},
): Promise<void> {
	await seedDeployment(db, {
		id: PUBLISHED_DEPLOYMENTS.push,
		appId: args.appId,
		projectId: args.projectId,
		domain: "case-writes-push",
		baseline: {
			origin: "push",
			bytes:
				args.digestFails === true
					? digestFailingBaselineBytes(PUBLISHED_FIXTURE)
					: hqBaselineBytes(PUBLISHED_FIXTURE),
		},
		entryPointManifest: true,
	});
	await seedDeployment(db, {
		id: PUBLISHED_DEPLOYMENTS.create,
		appId: args.appId,
		projectId: args.projectId,
		domain: "case-writes-create",
		baseline: { origin: "create", bytes: shellBaselineBytes() },
	});
	await seedDeployment(db, {
		id: PUBLISHED_DEPLOYMENTS.unread,
		appId: args.appId,
		projectId: args.projectId,
		domain: "case-writes-unread",
		baseline: { origin: "unread" },
	});
}

// ─── Private work and history ─────────────────────────────────────────────

export interface SeededPrivateWork {
	/** The MCP work session holding an unsaved candidate of the app. */
	readonly workId: string;
	readonly candidateId: string;
	/** The pre-app build session holding an open genesis change set. */
	readonly preAppSessionId: string;
	readonly changeSetId: string;
}

/**
 * Open private work: an MCP work session on `appId` holding one unsaved
 * staged edit (its open candidate, based at the app's pre-step sequence,
 * and the session's pointer to it), and a pre-app build session holding an
 * open genesis change set, which the cutover ends.
 */
export async function seedPrivateWork(
	h: AppStateTestDb,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly owner: string;
	},
): Promise<SeededPrivateWork> {
	const db = h.db();
	const workId = randomUUID();
	const candidateId = randomUUID();
	await sql`
		INSERT INTO authoring_sessions (id, actor_user_id, project_id, origin, app_id, app_name,
			begin_request_id, begin_input_digest)
		VALUES (${workId}::uuid, ${args.owner}, ${args.projectId}, 'mcp', ${args.appId},
			'Work in progress', ${`begin-${args.appId}`}, repeat('a', 64))
	`.execute(db);
	await sql`
		INSERT INTO authoring_workspaces (id, authoring_session_id, design_session_id, plan_revision,
			kind, app_id, proposed_app_id, base_seq, base_project_id, base_snapshot_digest,
			next_ordinal, exclusive_kind, owner_user_id, owner_run_id, status)
		VALUES (${candidateId}::uuid, ${workId}::uuid, NULL, NULL, 'app-edit', ${args.appId}, NULL, 1,
			${args.projectId}, repeat('b', 64), 1, NULL, ${args.owner}, NULL, 'open')
	`.execute(db);
	await sql`
		UPDATE authoring_sessions SET active_candidate_id = ${candidateId}::uuid
		WHERE id = ${workId}::uuid
	`.execute(db);

	const preAppSessionId = await h.seedDesignSession({
		owner_user_id: args.owner,
		project_id: args.projectId,
	});
	const lineage = await h.seedDesignLineage({
		existingSessionId: preAppSessionId,
	});
	const changeSetId = randomUUID();
	await db
		.insertInto("design_change_sets")
		.values({
			id: changeSetId,
			design_session_id: preAppSessionId,
			design_revision_id: lineage.designRevisionId,
			design_revision_digest: lineage.designRevisionDigest,
			build_plan_id: lineage.buildPlanId,
			build_plan_digest: lineage.buildPlanDigest,
			slice_id: lineage.sliceId,
			attempt_id: lineage.attemptId,
			kind: "genesis",
			app_id: null,
			proposed_app_id: randomUUID(),
			base_seq: null,
			base_project_id: args.projectId,
			base_snapshot_digest: "d".repeat(64),
			revision: 0,
			next_ordinal: 0,
			exclusive_kind: null,
			owner_user_id: args.owner,
			owner_run_id: "run-pre-app",
			status: "open",
			committed_seq: null,
			committed_batch_id: null,
			committed_snapshot_digest: null,
		})
		.execute();
	return { workId, candidateId, preAppSessionId, changeSetId };
}

/** Two `events` rows of kind `mutation` for an app, in the old dialect
 *  `lib/log/types.ts::mutationEventSchema` no longer reads. */
export async function seedMutationEvents(db: Db, appId: string): Promise<void> {
	for (const seq of [1, 2]) {
		await sql`
			INSERT INTO events (app_id, run_id, ts, seq, source, kind, event)
			VALUES (${appId}, 'run-history', ${1_700_000_000_000 + seq}, ${seq}, 'chat', 'mutation',
				${JSON.stringify({
					kind: "mutation",
					runId: "run-history",
					ts: 1_700_000_000_000 + seq,
					seq,
					source: "chat",
					actor: "agent",
					mutation: { kind: "retired-vocabulary" },
				})}::jsonb)
		`.execute(db);
	}
}

// ─── The app-test namespace decoy (part 09 §15.2) ─────────────────────────

const DECOY_ROUTINES = [
	"nova_admit_app_change_insert",
	"nova_admit_app_change_fold_baseline_insert",
	"nova_require_app_change_fold_baseline",
] as const;

/**
 * A real app-test namespace (`public.nova_create_app_test_namespace`, which
 * copies the app-test tables with their constraints as production's do),
 * holding a copy of `app_deployment_confirmations` with its constraints and
 * the three routines the window's migrations replace, with their bodies as
 * `public` holds them now (read through `catalog.ts::routineDefinition` and
 * re-targeted at the namespace). Returns the namespace.
 */
export async function seedDecoyNamespace(db: Db): Promise<string> {
	const created = await sql<{ namespace: string }>`
		SELECT public.nova_create_app_test_namespace(gen_random_uuid()) AS namespace
	`.execute(db);
	const namespace = created.rows[0]?.namespace;
	if (namespace === undefined)
		throw new Error(
			"nova_create_app_test_namespace answered no namespace, so the decoy could not be seeded.",
		);
	await sql`
		CREATE TABLE ${sql.id(namespace, "app_deployment_confirmations")}
			(LIKE public.app_deployment_confirmations INCLUDING CONSTRAINTS)
	`.execute(db);
	for (const routine of DECOY_ROUTINES) {
		const definition = await routineDefinition(db, "public", `${routine}()`);
		const header = `CREATE OR REPLACE FUNCTION public.${routine}()`;
		if (!definition.startsWith(header))
			throw new Error(
				`pg_get_functiondef printed public.${routine} without its schema-qualified header, so the decoy cannot be re-targeted at the namespace.`,
			);
		await sql
			.raw(
				`CREATE OR REPLACE FUNCTION ${namespace}.${routine}()${definition.slice(header.length)}`,
			)
			.execute(db);
	}
	return namespace;
}

// ─── The image ────────────────────────────────────────────────────────────

/** Every `public` relation the cutover could touch. */
const IMAGE_TABLES = [
	"apps",
	"blueprint_entities",
	"app_changes",
	"app_change_fold_baselines",
	"case_type_schemas",
	"events",
	"threads",
	"chat_stream_chunks",
	"presence",
	"authoring_sessions",
	"authoring_workspaces",
	"design_change_sets",
	"design_sessions",
	"design_slice_attempts",
	"design_artifact_workspaces",
	"app_migration_notices",
	"media_assets",
	"media_asset_refs",
	"lookup_table_references",
	"lookup_column_references",
	"app_location_references",
	"app_deployments",
	"app_deployment_resources",
	"app_deployment_identities",
	"app_deployment_confirmations",
	"app_deployment_baselines",
	"credit_months",
	"kysely_migration",
] as const;

/** The case store's relations, read where `nova_create_app_test_namespace`
 *  resolves them: `nova_case_runtime` where it holds them, else `public`. */
const CASE_TABLES = ["cases", "parked_case_values", "case_indices"] as const;

/** Every row of `schema.table` as text, in code-point order of that text, so
 *  the order needs no knowledge of the relation's keys. */
async function rowsAsText(
	db: Db,
	schema: string,
	table: string,
): Promise<string> {
	const rows = await sql<{ row: string }>`
		SELECT t::text AS row FROM ${sql.table(`${schema}.${table}`)} AS t
		ORDER BY t::text COLLATE "C"
	`.execute(db);
	return rows.rows.map((row) => row.row).join("\n");
}

/**
 * Every row the cutover could touch as text, every constraint of those
 * relations and every routine of `public` through `catalog.ts`, so two
 * images compare byte for byte and a write, a DDL statement or a ledger
 * row the cutover should not have left shows as a difference.
 */
export async function databaseImage(db: Db): Promise<string> {
	const parts: string[] = [];
	for (const table of IMAGE_TABLES) {
		parts.push(`${table}:${await rowsAsText(db, "public", table)}`);
		const constraints = await relationConstraints(db, "public", table);
		parts.push(
			`${table} constraints:${[...constraints].map(([name, definition]) => `${name} ${definition}`).join("\n")}`,
		);
	}
	for (const table of CASE_TABLES) {
		const located = await sql<{ schema: string | null }>`
			SELECT CASE
				WHEN pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'nova_case_runtime', ${table}::text)) IS NOT NULL
					THEN 'nova_case_runtime'
				WHEN pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'public', ${table}::text)) IS NOT NULL
					THEN 'public'
			END AS schema
		`.execute(db);
		const schema = located.rows[0]?.schema ?? null;
		parts.push(
			`${table}:${schema === null ? "(absent)" : await rowsAsText(db, schema, table)}`,
		);
	}
	const routines = await schemaRoutines(db, "public");
	parts.push(
		`routines:${[...routines].map(([signature, definition]) => `${signature}\n${definition}`).join("\n")}`,
	);
	return parts.join("\n\n");
}
