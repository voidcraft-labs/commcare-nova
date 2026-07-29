/**
 * Frozen database cutover for canonical authored identity.
 *
 * This module intentionally depends only on the timestamped migration's frozen
 * inventory and pure transform. It does not import the live domain schemas,
 * reducer, or persistence assembler: a later product edit must not change what
 * this historical migration does when a fresh database replays the ledger.
 */

import { type Kysely, sql } from "kysely";
import {
	FROZEN_ENTITY_OCCURRENCES,
	FROZEN_OCCURRENCE_TABLES,
} from "./frozenOccurrenceManifest";
import {
	CANONICAL_IDENTITY_MIGRATION_VERSION,
	type CanonicalAppPlan,
	canonicalIdentityDigest,
	isCanonicalAuthoredUuid,
	type LegacyAppSnapshot,
	type LegacyEntityKind,
	type LegacyEntityRow,
	legacyOptionUuidV5,
	planCanonicalAppMigration,
	scanLookupIdentities,
} from "./frozenTransform";

const HORIZON_BATCH_ID = "migration:canonical-identity-foundation";
const HORIZON_ACTOR_ID = "system:canonical-identity-foundation";

/**
 * The production advisory scan is far below these limits. They are a hard stop,
 * not a sizing guess: a larger quiescent database must be rehearsed and these
 * reviewed bounds changed before a 1,020-second migration Job is allowed to
 * begin its rewrite.
 */
const MAX_APP_COUNT = 10_000;
const MAX_ENTITY_COUNT = 1_000_000;
const MAX_REWRITE_BYTES = 512 * 1024 * 1024;

const SQL_IDENTITY_COLUMNS = [
	["apps", "logo"],
	["blueprint_entities", "uuid"],
	["blueprint_entities", "parent_uuid"],
	["media_assets", "id"],
	["media_upload_aliases", "attempt_asset_id"],
	["media_upload_aliases", "canonical_asset_id"],
	["media_asset_refs", "asset_id"],
	["form_submission_intents", "form_uuid"],
	["form_attachments", "field_uuid"],
] as const;

interface StoredAppRow {
	id: string;
	app_name: string;
	connect_type: string | null;
	case_types: unknown;
	logo: string | null;
	mutation_seq: string | number;
	status: string;
	lock_run_id: string | null;
}

interface StoredEntityRow {
	app_id: string;
	uuid: string;
	kind: string;
	parent_uuid: string | null;
	ordinal: number;
	data: Record<string, unknown>;
}

interface StoredEventRow {
	id: string | number;
	app_id: string;
	run_id: string;
	ts: string | number;
	seq: number;
	source: string;
	kind: string;
	event: Record<string, unknown>;
	event_text: string;
}

interface FrozenMigrationReport {
	readonly version: string;
	readonly alreadyApplied: boolean;
	readonly apps: number;
	readonly entities: number;
	readonly archivedMutationEvents: number;
	readonly rewriteBytes: number;
	readonly beforeDigest: string;
	readonly afterDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireInvariant(
	condition: unknown,
	message: string,
): asserts condition {
	if (!condition) {
		throw new Error(
			`Canonical identity migration blocked: ${message} [${CANONICAL_IDENTITY_MIGRATION_VERSION}]`,
		);
	}
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function eventEnvelopeIsExact(row: StoredEventRow): boolean {
	return (
		row.event.runId === row.run_id &&
		String(row.event.ts) === String(row.ts) &&
		row.event.seq === row.seq &&
		row.event.source === row.source &&
		row.event.kind === row.kind
	);
}

function walkPath(
	value: unknown,
	segments: readonly string[],
	visit: (value: unknown) => void,
): void {
	if (segments.length === 0) {
		visit(value);
		return;
	}
	const [head, ...tail] = segments;
	if (head === undefined) return;
	const array = head.endsWith("[]");
	const key = array ? head.slice(0, -2) : head;
	if (!isRecord(value)) return;
	const child = value[key];
	if (array) {
		if (!Array.isArray(child)) return;
		for (const entry of child) walkPath(entry, tail, visit);
		return;
	}
	walkPath(child, tail, visit);
}

function collectAuthoredIdentities(
	rows: readonly LegacyEntityRow[],
): Set<string> {
	const identities = new Set<string>();
	for (const row of rows) {
		if (isCanonicalAuthoredUuid(row.uuid)) identities.add(row.uuid);
		for (const occurrence of FROZEN_ENTITY_OCCURRENCES) {
			if (
				occurrence.entity !== row.kind ||
				occurrence.surface !== "identity" ||
				occurrence.path === "uuid"
			) {
				continue;
			}
			walkPath(row.data, occurrence.path.split("."), (value) => {
				if (isCanonicalAuthoredUuid(value)) identities.add(value);
			});
		}
	}
	return identities;
}

function legacyOptionTargets(rows: readonly LegacyEntityRow[]): string[] {
	const targets: string[] = [];
	for (const row of rows) {
		if (row.kind !== "field") continue;
		const source = isRecord(row.data.optionsSource)
			? row.data.optionsSource
			: undefined;
		const options =
			source?.kind === "inline" && Array.isArray(source.options)
				? source.options
				: Array.isArray(row.data.options)
					? row.data.options
					: [];
		for (const [index, value] of options.entries()) {
			if (!isRecord(value)) continue;
			const legacy = `${row.uuid}-opt-${index}`;
			if (value.uuid === legacy) targets.push(legacyOptionUuidV5(legacy));
		}
	}
	return targets;
}

function validateTypedAttachments(
	value: unknown,
	path: string,
	mediaIds: ReadonlySet<string>,
): void {
	if (Array.isArray(value)) {
		value.forEach((child, index) => {
			validateTypedAttachments(child, `${path}[${index}]`, mediaIds);
		});
		return;
	}
	if (!isRecord(value)) return;
	const metadata = value.metadata;
	if (isRecord(metadata) && Array.isArray(metadata.attachments)) {
		metadata.attachments.forEach((attachment, index) => {
			requireInvariant(
				isRecord(attachment) &&
					isCanonicalAuthoredUuid(attachment.assetId) &&
					mediaIds.has(attachment.assetId),
				`${path}.metadata.attachments[${index}].assetId is not one stored uploaded-media identity`,
			);
		});
	}
	for (const [key, child] of Object.entries(value)) {
		validateTypedAttachments(child, `${path}.${key}`, mediaIds);
	}
}

function assertCurrentEventAttachments(
	row: StoredEventRow,
	mediaIds: ReadonlySet<string>,
): void {
	if (row.kind !== "conversation") return;
	const payload = row.event.payload;
	if (!isRecord(payload) || payload.type !== "user-message") return;
	if (payload.attachments === undefined) return;
	requireInvariant(
		Array.isArray(payload.attachments),
		`events.${row.id}.event.payload.attachments is malformed`,
	);
	payload.attachments.forEach((attachment, index) => {
		requireInvariant(
			isRecord(attachment) &&
				isCanonicalAuthoredUuid(attachment.assetId) &&
				mediaIds.has(attachment.assetId),
			`events.${row.id}.event.payload.attachments[${index}].assetId is not one stored uploaded-media identity`,
		);
	});
}

function assertIntentOperations(
	result: unknown,
	path: string,
	operationIds: ReadonlySet<string>,
): void {
	if (result === null) return;
	requireInvariant(isRecord(result), `${path}.result is not an object`);
	if (result.operations === undefined) return;
	requireInvariant(
		Array.isArray(result.operations),
		`${path}.result.operations is not an array`,
	);
	result.operations.forEach((operation, index) => {
		requireInvariant(
			isRecord(operation) &&
				isCanonicalAuthoredUuid(operation.operationUuid) &&
				operationIds.has(operation.operationUuid),
			`${path}.result.operations[${index}].operationUuid is not a current operation in that app`,
		);
	});
}

async function sqlColumnTypes(
	db: Kysely<unknown>,
): Promise<Map<string, string>> {
	const rows = await sql<{
		table_name: string;
		column_name: string;
		data_type: string;
	}>`
		SELECT table_name, column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND (table_name, column_name) IN (
			  ${sql.join(
					SQL_IDENTITY_COLUMNS.map(
						([table, column]) => sql`(${table}, ${column})`,
					),
				)}
		  )
		ORDER BY table_name, column_name
	`.execute(db);
	return new Map(
		rows.rows.map((row) => [
			`${row.table_name}.${row.column_name}`,
			row.data_type,
		]),
	);
}

function assertSqlIdentitySchema(
	types: ReadonlyMap<string, string>,
	expected: "text" | "uuid",
): void {
	for (const [table, column] of SQL_IDENTITY_COLUMNS) {
		requireInvariant(
			types.get(`${table}.${column}`) === expected,
			`${table}.${column} must be ${expected} before this phase`,
		);
	}
}

async function convertSqlIdentityColumns(db: Kysely<unknown>): Promise<void> {
	// The three foreign keys couple media identity columns. Drop only those
	// named dependencies, convert every semantic column, then restore them.
	await sql`
		ALTER TABLE media_asset_refs
			DROP CONSTRAINT media_asset_refs_asset_id_fkey;
		ALTER TABLE media_upload_aliases
			DROP CONSTRAINT media_upload_aliases_canonical_asset_id_fkey;

		ALTER TABLE apps
			ALTER COLUMN logo TYPE uuid USING logo::uuid;
		ALTER TABLE blueprint_entities
			ALTER COLUMN uuid TYPE uuid USING uuid::uuid,
			ALTER COLUMN parent_uuid TYPE uuid USING parent_uuid::uuid;
		ALTER TABLE media_assets
			ALTER COLUMN id TYPE uuid USING id::uuid;
		ALTER TABLE media_upload_aliases
			ALTER COLUMN attempt_asset_id TYPE uuid USING attempt_asset_id::uuid,
			ALTER COLUMN canonical_asset_id TYPE uuid USING canonical_asset_id::uuid;
		ALTER TABLE media_asset_refs
			ALTER COLUMN asset_id TYPE uuid USING asset_id::uuid;
		ALTER TABLE form_submission_intents
			ALTER COLUMN form_uuid TYPE uuid USING form_uuid::uuid;
		ALTER TABLE form_attachments
			ALTER COLUMN field_uuid TYPE uuid USING field_uuid::uuid;

		ALTER TABLE media_asset_refs
			ADD CONSTRAINT media_asset_refs_asset_id_fkey
			FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE CASCADE;
		ALTER TABLE media_upload_aliases
			ADD CONSTRAINT media_upload_aliases_canonical_asset_id_fkey
			FOREIGN KEY (canonical_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
	`.execute(db);
}

async function appliedForEveryApp(db: Kysely<unknown>): Promise<boolean> {
	const row = await sql<{ apps: string; horizons: string }>`
		SELECT
			(SELECT count(*)::text FROM apps) AS apps,
			(
				SELECT count(*)::text
				FROM accepted_mutations
				WHERE batch_id = ${HORIZON_BATCH_ID}
			) AS horizons
	`.execute(db);
	const counts = row.rows[0];
	return counts !== undefined && counts.apps === counts.horizons;
}

function planDigest(plans: readonly CanonicalAppPlan[]): string {
	return canonicalIdentityDigest(
		plans.map((plan) => ({
			app: canonicalIdentityDigest(plan.appId),
			before: plan.beforeDigest,
			after: plan.afterDigest,
			rewrites: plan.rewrites,
		})),
	);
}

export async function runFrozenCanonicalIdentityMigration(
	db: Kysely<unknown>,
): Promise<FrozenMigrationReport> {
	// Kysely's Migrator invokes each `up` inside one transaction already.
	// Starting another transaction from that Transaction handle is forbidden;
	// the complete deterministic table lock below supplies the immutable
	// authoritative snapshot after Kysely has touched its migration ledger.
	const tx = db;
	// One deterministic lock statement, projected from the frozen
	// occurrence manifest. SHARE ROW EXCLUSIVE blocks every application
	// writer before the authoritative scan; later ALTERs promote their
	// own tables to ACCESS EXCLUSIVE within this same transaction.
	await sql`
				LOCK TABLE ${sql.join(
					FROZEN_OCCURRENCE_TABLES.map((table) => sql.table(table)),
				)} IN SHARE ROW EXCLUSIVE MODE
			`.execute(tx);

	const initialTypes = await sqlColumnTypes(tx);
	const typeSet = new Set(initialTypes.values());
	requireInvariant(
		typeSet.size === 1 && (typeSet.has("text") || typeSet.has("uuid")),
		"the authored-identity SQL columns are in a partial or unexpected schema state",
	);
	if (typeSet.has("uuid")) {
		assertSqlIdentitySchema(initialTypes, "uuid");
		requireInvariant(
			await appliedForEveryApp(tx),
			"UUID columns exist but one or more app horizons are absent",
		);
		return {
			version: CANONICAL_IDENTITY_MIGRATION_VERSION,
			alreadyApplied: true,
			apps: 0,
			entities: 0,
			archivedMutationEvents: 0,
			rewriteBytes: 0,
			beforeDigest: canonicalIdentityDigest("already-applied"),
			afterDigest: canonicalIdentityDigest("already-applied"),
		};
	}
	assertSqlIdentitySchema(initialTypes, "text");

	const active = await sql<{
		generating: string;
		active_streams: string;
	}>`
				SELECT
					(
						SELECT count(*)::text
						FROM apps
						WHERE status = 'generating'
						   OR lock_run_id IS NOT NULL
					) AS generating,
					(
						SELECT count(*)::text
						FROM threads
						WHERE active_stream_id IS NOT NULL
						   OR active_holder_nonce IS NOT NULL
					) AS active_streams
			`.execute(tx);
	requireInvariant(
		active.rows[0]?.generating === "0",
		"one or more app run holders remain live",
	);
	requireInvariant(
		active.rows[0]?.active_streams === "0",
		"one or more thread stream holders remain live",
	);

	const appResult = await sql<StoredAppRow>`
				SELECT id, app_name, connect_type, case_types, logo, mutation_seq,
				       status, lock_run_id
				FROM apps
				ORDER BY id
			`.execute(tx);
	const entityResult = await sql<StoredEntityRow>`
				SELECT app_id, uuid, kind, parent_uuid, ordinal, data
				FROM blueprint_entities
				ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid
			`.execute(tx);
	requireInvariant(
		appResult.rows.length <= MAX_APP_COUNT,
		`app count exceeds the reviewed capacity bound of ${MAX_APP_COUNT}`,
	);
	requireInvariant(
		entityResult.rows.length <= MAX_ENTITY_COUNT,
		`entity count exceeds the reviewed capacity bound of ${MAX_ENTITY_COUNT}`,
	);

	const rowsByApp = new Map<string, LegacyEntityRow[]>();
	for (const row of entityResult.rows) {
		const rows = rowsByApp.get(row.app_id) ?? [];
		rows.push({
			appId: row.app_id,
			uuid: row.uuid,
			kind: row.kind as LegacyEntityKind,
			parentUuid: row.parent_uuid,
			ordinal: row.ordinal,
			data: row.data,
		});
		rowsByApp.set(row.app_id, rows);
	}

	const plans: CanonicalAppPlan[] = [];
	for (const app of appResult.rows) {
		const snapshot: LegacyAppSnapshot = {
			appId: app.id,
			appName: app.app_name,
			connectType: app.connect_type,
			caseTypes: app.case_types,
			logo: app.logo,
			mutationSeq: app.mutation_seq,
			rows: rowsByApp.get(app.id) ?? [],
		};
		const plan = planCanonicalAppMigration(snapshot);
		requireInvariant(
			plan.findings.length === 0,
			`app ${canonicalIdentityDigest(app.id)} has ${plan.findings.length} blocking frozen-scan finding(s); first path ${plan.findings[0]?.path ?? "unknown"}`,
		);
		plans.push(plan);
	}

	const lookupTables = await sql<{
		project_id: string;
		id: string;
	}>`SELECT project_id, id FROM lookup_tables ORDER BY project_id, id`.execute(
		tx,
	);
	const lookupColumns = await sql<{
		project_id: string;
		table_id: string;
		id: string;
	}>`
				SELECT project_id, table_id, id
				FROM lookup_columns
				ORDER BY project_id, table_id, id
			`.execute(tx);
	const lookupRows = await sql<{
		project_id: string;
		table_id: string;
		id: string;
		values: Record<string, unknown>;
	}>`
				SELECT project_id, table_id, id, values
				FROM lookup_rows
				ORDER BY project_id, table_id, id
			`.execute(tx);
	const lookupFindings = scanLookupIdentities({
		tables: lookupTables.rows.map((row) => ({
			projectId: row.project_id,
			id: row.id,
		})),
		columns: lookupColumns.rows.map((row) => ({
			projectId: row.project_id,
			tableId: row.table_id,
			id: row.id,
		})),
		rows: lookupRows.rows.map((row) => ({
			projectId: row.project_id,
			tableId: row.table_id,
			id: row.id,
			values: row.values,
		})),
	});
	requireInvariant(
		lookupFindings.length === 0,
		`lookup identity scan has ${lookupFindings.length} blocking finding(s)`,
	);

	const mediaRows = await sql<{ id: string }>`
				SELECT id FROM media_assets ORDER BY id
			`.execute(tx);
	const mediaIds = new Set(mediaRows.rows.map((row) => row.id));
	for (const id of mediaIds) {
		requireInvariant(
			isCanonicalAuthoredUuid(id),
			`media asset ${canonicalIdentityDigest(id)} is not a canonical authored UUID`,
		);
	}

	// The UUIDv5 projection is globally injective for the exact legacy
	// names and may not land on any authored identity in any app, media
	// row, or lookup object.
	const existingIdentities = new Set<string>(mediaIds);
	for (const row of lookupTables.rows) existingIdentities.add(row.id);
	for (const row of lookupColumns.rows) existingIdentities.add(row.id);
	for (const row of lookupRows.rows) existingIdentities.add(row.id);
	for (const rows of rowsByApp.values()) {
		for (const id of collectAuthoredIdentities(rows)) {
			existingIdentities.add(id);
		}
	}
	const mappedTargets = plans.flatMap((plan) =>
		legacyOptionTargets(rowsByApp.get(plan.appId) ?? []),
	);
	requireInvariant(
		new Set(mappedTargets).size === mappedTargets.length,
		"two legacy option identities map to the same UUIDv5 target",
	);
	for (const target of mappedTargets) {
		requireInvariant(
			!existingIdentities.has(target),
			`legacy option UUIDv5 target ${canonicalIdentityDigest(target)} collides with an authored identity`,
		);
	}

	const formIdsByApp = new Map<string, Set<string>>();
	const fieldIdsByApp = new Map<string, Set<string>>();
	const operationIdsByApp = new Map<string, Set<string>>();
	for (const plan of plans) {
		const forms = new Set<string>();
		const fields = new Set<string>();
		const operations = new Set<string>();
		for (const row of plan.rows) {
			if (row.kind === "form") {
				forms.add(row.uuid);
				const values = Array.isArray(row.data.caseOperations)
					? row.data.caseOperations
					: [];
				for (const operation of values) {
					if (isRecord(operation) && isCanonicalAuthoredUuid(operation.uuid)) {
						operations.add(operation.uuid);
					}
				}
			}
			if (row.kind === "field") fields.add(row.uuid);
		}
		formIdsByApp.set(plan.appId, forms);
		fieldIdsByApp.set(plan.appId, fields);
		operationIdsByApp.set(plan.appId, operations);
	}

	const intentRows = await sql<{
		app_id: string;
		project_id: string;
		created_by: string;
		entry_key: string;
		form_uuid: string;
		result: unknown;
	}>`
				SELECT app_id, project_id, created_by, entry_key, form_uuid, result
				FROM form_submission_intents
				ORDER BY app_id, project_id, created_by, entry_key
			`.execute(tx);
	for (const row of intentRows.rows) {
		const path = `form_submission_intents.${canonicalIdentityDigest([
			row.app_id,
			row.project_id,
			row.created_by,
			row.entry_key,
		])}`;
		requireInvariant(
			isCanonicalAuthoredUuid(row.form_uuid) &&
				(formIdsByApp.get(row.app_id)?.has(row.form_uuid) ?? false),
			`${path}.form_uuid is not a current form in that app`,
		);
		assertIntentOperations(
			row.result,
			path,
			operationIdsByApp.get(row.app_id) ?? new Set(),
		);
	}

	const attachmentRows = await sql<{
		attachment_id: string;
		app_id: string;
		field_uuid: string;
	}>`
				SELECT attachment_id, app_id, field_uuid
				FROM form_attachments
				ORDER BY attachment_id
			`.execute(tx);
	for (const row of attachmentRows.rows) {
		requireInvariant(
			isCanonicalAuthoredUuid(row.field_uuid) &&
				(fieldIdsByApp.get(row.app_id)?.has(row.field_uuid) ?? false),
			`form_attachments.${canonicalIdentityDigest(row.attachment_id)}.field_uuid is not a current field in that app`,
		);
	}

	const threadRows = await sql<{
		app_id: string;
		thread_id: string;
		messages: unknown;
	}>`
				SELECT app_id, thread_id, messages
				FROM threads
				ORDER BY app_id, thread_id
			`.execute(tx);
	for (const row of threadRows.rows) {
		validateTypedAttachments(
			row.messages,
			`threads.${canonicalIdentityDigest([
				row.app_id,
				row.thread_id,
			])}.messages`,
			mediaIds,
		);
	}

	const eventRows = await sql<StoredEventRow>`
				SELECT id, app_id, run_id, ts, seq, source, kind, event,
				       event::text AS event_text
				FROM events
				ORDER BY id
			`.execute(tx);
	const archivedBefore = new Map<string, string>();
	for (const row of eventRows.rows) {
		requireInvariant(
			eventEnvelopeIsExact(row),
			`events.${row.id} columns disagree with its stored envelope`,
		);
		requireInvariant(
			row.kind === "mutation" ||
				row.kind === "conversation" ||
				row.kind === "archived-mutation",
			`events.${row.id} has an unsupported event family`,
		);
		assertCurrentEventAttachments(row, mediaIds);
		if (row.kind === "mutation") {
			archivedBefore.set(String(row.id), row.event_text);
		}
	}

	const rewriteBytes =
		appResult.rows.reduce(
			(total, row) => total + jsonBytes(row.case_types),
			0,
		) +
		entityResult.rows.reduce((total, row) => total + jsonBytes(row.data), 0) +
		[...archivedBefore.values()].reduce(
			(total, value) => total + Buffer.byteLength(value, "utf8"),
			0,
		) +
		lookupRows.rows.reduce((total, row) => total + jsonBytes(row.values), 0) +
		intentRows.rows.reduce((total, row) => total + jsonBytes(row.result), 0);
	requireInvariant(
		rewriteBytes <= MAX_REWRITE_BYTES,
		`planned rewrite bytes exceed the reviewed ${MAX_REWRITE_BYTES}-byte capacity bound`,
	);

	const acceptedBefore = await sql<{
		app_id: string;
		seq: string;
		row_text: string;
	}>`
				SELECT app_id, seq::text, to_jsonb(accepted_mutations)::text AS row_text
				FROM accepted_mutations
				ORDER BY app_id, seq
			`.execute(tx);
	const beforeDigest = canonicalIdentityDigest({
		plans: planDigest(plans),
		accepted: acceptedBefore.rows,
		events: eventRows.rows.map((row) => ({
			id: String(row.id),
			event: row.event_text,
		})),
		lookupRows: lookupRows.rows,
		threads: threadRows.rows.map((row) => [
			canonicalIdentityDigest([row.app_id, row.thread_id]),
			canonicalIdentityDigest(row.messages),
		]),
	});

	const appPayload = plans.map((plan) => ({
		id: plan.appId,
		case_types: plan.caseTypes,
	}));
	if (appPayload.length > 0) {
		await sql`
					WITH incoming AS (
						SELECT *
						FROM jsonb_to_recordset(${JSON.stringify(appPayload)}::jsonb)
							AS value(id text, case_types jsonb)
					)
					UPDATE apps
					SET case_types = incoming.case_types
					FROM incoming
					WHERE apps.id = incoming.id
				`.execute(tx);
	}

	const entityPayload = plans.flatMap((plan) =>
		plan.rows.map((row) => ({
			app_id: plan.appId,
			uuid: row.uuid,
			data: row.data,
		})),
	);
	if (entityPayload.length > 0) {
		await sql`
					WITH incoming AS (
						SELECT *
						FROM jsonb_to_recordset(${JSON.stringify(entityPayload)}::jsonb)
							AS value(app_id text, uuid text, data jsonb)
					)
					UPDATE blueprint_entities
					SET data = incoming.data
					FROM incoming
					WHERE blueprint_entities.app_id = incoming.app_id
					  AND blueprint_entities.uuid = incoming.uuid
				`.execute(tx);
	}

	await sql`
				UPDATE events
				SET
					kind = 'archived-mutation',
					event = jsonb_build_object(
						'kind', 'archived-mutation',
						'runId', event -> 'runId',
						'ts', event -> 'ts',
						'seq', event -> 'seq',
						'source', event -> 'source',
						'archived', event
					)
				WHERE kind = 'mutation'
			`.execute(tx);

	// Strictly parsed above. The identity-keyed object is already
	// canonical, so its only valid rewrite is itself.
	await sql`UPDATE lookup_rows SET values = values`.execute(tx);
	await sql`
				UPDATE threads
				SET active_stream_id = NULL, active_holder_nonce = NULL
				WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL;
				DELETE FROM chat_stream_chunks;
				DELETE FROM presence
			`.execute(tx);

	await sql`
				WITH appended AS (
					INSERT INTO accepted_mutations
						(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
					SELECT
						id,
						mutation_seq + 1,
						${HORIZON_BATCH_ID},
						NULL,
						${HORIZON_ACTOR_ID},
						'migration',
						'[]'::jsonb
					FROM apps
					ON CONFLICT (app_id, batch_id) DO NOTHING
					RETURNING app_id, seq
				)
				UPDATE apps
				SET mutation_seq = appended.seq
				FROM appended
				WHERE apps.id = appended.app_id
			`.execute(tx);

	await convertSqlIdentityColumns(tx);
	assertSqlIdentitySchema(await sqlColumnTypes(tx), "uuid");

	const archivedAfter = await sql<{
		id: string | number;
		archived_text: string;
	}>`
				SELECT id, (event -> 'archived')::text AS archived_text
				FROM events
				WHERE kind = 'archived-mutation'
				ORDER BY id
			`.execute(tx);
	requireInvariant(
		archivedAfter.rows.length === archivedBefore.size,
		"archived mutation-event cardinality changed",
	);
	for (const row of archivedAfter.rows) {
		requireInvariant(
			archivedBefore.get(String(row.id)) === row.archived_text,
			`events.${row.id} did not preserve its nested canonical jsonb::text`,
		);
	}

	const oldAcceptedAfter = await sql<{
		app_id: string;
		seq: string;
		row_text: string;
	}>`
				SELECT current.app_id, current.seq::text, to_jsonb(current)::text AS row_text
				FROM accepted_mutations current
				JOIN jsonb_to_recordset(${JSON.stringify(
					appResult.rows.map((row) => ({
						app_id: row.id,
						mutation_seq: String(row.mutation_seq),
					})),
				)}::jsonb)
					AS prior(app_id text, mutation_seq bigint)
				  ON prior.app_id = current.app_id
				 AND current.seq <= prior.mutation_seq
				ORDER BY current.app_id, current.seq
			`.execute(tx);
	requireInvariant(
		canonicalIdentityDigest(oldAcceptedAfter.rows) ===
			canonicalIdentityDigest(acceptedBefore.rows),
		"one or more pre-horizon accepted-mutation rows changed",
	);
	requireInvariant(
		await appliedForEveryApp(tx),
		"the canonical fold horizon was not appended exactly once per app",
	);

	const operational = await sql<{
		chunks: string;
		presence: string;
		active_streams: string;
	}>`
				SELECT
					(SELECT count(*)::text FROM chat_stream_chunks) AS chunks,
					(SELECT count(*)::text FROM presence) AS presence,
					(
						SELECT count(*)::text
						FROM threads
						WHERE active_stream_id IS NOT NULL
						   OR active_holder_nonce IS NOT NULL
					) AS active_streams
			`.execute(tx);
	requireInvariant(
		operational.rows[0]?.chunks === "0" &&
			operational.rows[0]?.presence === "0" &&
			operational.rows[0]?.active_streams === "0",
		"ephemeral stream or presence state survived the cutover",
	);

	const postApps = await sql<{
		id: string;
		case_types: unknown;
		mutation_seq: string;
	}>`
				SELECT id, case_types, mutation_seq::text
				FROM apps
				ORDER BY id
			`.execute(tx);
	const postEntities = await sql<{
		app_id: string;
		uuid: string;
		kind: string;
		parent_uuid: string | null;
		ordinal: number;
		data: Record<string, unknown>;
	}>`
				SELECT app_id, uuid::text AS uuid, kind, parent_uuid::text AS parent_uuid,
				       ordinal, data
				FROM blueprint_entities
				ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid
			`.execute(tx);
	const expectedPost = canonicalIdentityDigest({
		apps: plans.map((plan) => ({
			id: plan.appId,
			case_types: plan.caseTypes,
			mutation_seq: String(
				BigInt(
					appResult.rows.find((row) => row.id === plan.appId)?.mutation_seq ??
						0,
				) + BigInt(1),
			),
		})),
		entities: plans.flatMap((plan) =>
			plan.rows.map((row) => ({
				app_id: plan.appId,
				uuid: row.uuid,
				kind: row.kind,
				parent_uuid: row.parentUuid,
				ordinal: row.ordinal,
				data: row.data,
			})),
		),
	});
	const actualPost = canonicalIdentityDigest({
		apps: postApps.rows,
		entities: postEntities.rows,
	});
	requireInvariant(
		actualPost === expectedPost,
		"stored current snapshots or heads differ from the frozen migration plan",
	);

	const afterDigest = canonicalIdentityDigest({
		current: actualPost,
		archived: archivedAfter.rows.map((row) => [
			String(row.id),
			row.archived_text,
		]),
		oldAccepted: oldAcceptedAfter.rows,
		horizon: HORIZON_BATCH_ID,
	});

	return {
		version: CANONICAL_IDENTITY_MIGRATION_VERSION,
		alreadyApplied: false,
		apps: plans.length,
		entities: entityPayload.length,
		archivedMutationEvents: archivedBefore.size,
		rewriteBytes,
		beforeDigest,
		afterDigest,
	};
}
