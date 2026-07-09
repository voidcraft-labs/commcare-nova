/**
 * WRITER for the one-time Firestore→Postgres data cutover. Idempotent.
 *
 * Reads the OLD Firestore database over its REST API (no firebase SDK) and
 * INSERTs into the app-state Postgres tables via `getAppDb()` — so the
 * app-state migration
 * (`lib/case-store/migrations/20260708000000_app_state.ts`) must already have
 * run (`npm run db:migrate`). `--apply` writes; the default is a dry run that
 * prints what it WOULD write.
 *
 * Idempotency is by delete-then-insert / upsert, keyed on each table's natural
 * key, so a re-run converges (a full overwrite, not an append). Per app,
 * everything (the `apps` row, its `blueprint_entities`, `accepted_mutations`,
 * `events`, `threads`, `run_summaries`) is written in ONE transaction; the
 * `apps`-row delete cascades its FK children (see the app-state DDL), so a
 * re-run replaces an app cleanly. FK order is respected: the `apps` row lands
 * before its children, `media_assets` before `media_asset_refs`.
 *
 * After `--apply`, a verification pass re-reads Postgres: it re-runs the
 * blueprint round-trip (assemble from the written rows and compare to the
 * hydrated Firestore blueprint) and checks per-collection row-count parity,
 * exiting non-zero on any mismatch.
 *
 * `--project <gcp-project>` is required (prod: `commcare-nova`). `--app-id <id>`
 * migrates one app (+ its subcollections) only, for debugging — it skips the
 * root collections (usage / credits / user_settings / media).
 *
 * Deliberately DROPPED from the old schema (see the final report):
 *   - the `batchDedup` subcollection      → replaced by `UNIQUE (app_id, batch_id)`
 *   - the `presence` subcollection        → ephemeral live roster, TTL-swept
 *   - `reservation.expireAt` (legacy)     → the reservation marker carries no expiry
 *   - `acceptedMutations.expireAt`        → `accepted_mutations` is permanent, no TTL
 *
 * One-off: deleted in a follow-up commit once the production cutover has run,
 * alongside `scan-firestore-to-pg.ts` and `scripts/lib/firestoreRest.ts`.
 */
import "dotenv/config";
import { Command } from "commander";
import type { Insertable, Transaction } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	assembleBlueprint,
	blueprintScalars,
	decomposeBlueprint,
	type EntityRow,
} from "@/lib/db/blueprintRows";
import {
	type AcceptedMutationsTable,
	type AppDatabase,
	type AppsTable,
	type BlueprintEntitiesTable,
	type CreditGrantsTable,
	type CreditMonthsTable,
	type EventsTable,
	getAppDb,
	type MediaAssetRefsTable,
	type MediaAssetsTable,
	type RunSummariesTable,
	type ThreadsTable,
	type UsageMonthsTable,
	type UserSettingsTable,
	withAppTx,
} from "@/lib/db/pg";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import { asWalkableDoc, collectRealAssetRefs } from "@/lib/domain/mediaRefs";
import {
	batchesFromAcceptedMutations,
	type FoldOutcome,
	foldReproducesSnapshot,
} from "./lib/blueprintFold";
import {
	createFirestoreRest,
	decodeDocument,
	docIdFromName,
	type FirestoreDocument,
	type FirestoreRest,
	segmentsFromName,
	shortPath,
	stableStringify,
} from "./lib/firestoreRest";
import { printHeader, printSection, printTable } from "./lib/format";

// ── CLI ─────────────────────────────────────────────────────────────

const program = new Command();
program
	.name("migrate-firestore-to-pg")
	.description(
		"Migrate the Firestore app-state data into Postgres. Dry-run by default; pass --apply to write. Idempotent.",
	)
	.requiredOption(
		"--project <gcp-project>",
		"GCP project holding the source Firestore (prod: commcare-nova)",
	)
	.option("--apply", "actually write to Postgres (default: dry run)")
	.option(
		"--app-id <id>",
		"migrate only this app (+ its subcollections); skips root collections",
	)
	.option("--page-size <n>", "documents per REST page (default 300)", (v) =>
		Number.parseInt(v, 10),
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-firestore-to-pg.ts --project commcare-nova            # dry run\n" +
			"  $ npx tsx scripts/migrate-firestore-to-pg.ts --project commcare-nova --apply\n" +
			"  $ npx tsx scripts/migrate-firestore-to-pg.ts --project commcare-nova --app-id <id> --apply\n",
	);
program.parse();
const opts = program.opts<{
	project: string;
	apply?: boolean;
	appId?: string;
	pageSize?: number;
}>();

// ── Small decode/coerce helpers ─────────────────────────────────────

const UNTITLED_APP_NAME = "Untitled";
const INSERT_CHUNK = 500;
const SAMPLE_LIMIT = 5;

function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
/** An ISO-string (or already-`Date`) → `Date`, else null. */
function toDate(v: unknown): Date | null {
	if (v instanceof Date) return v;
	if (typeof v === "string" && v.length > 0) {
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Skip {
	n: number;
	samples: string[];
}
function newSkip(): Skip {
	return { n: 0, samples: [] };
}
function addSample(skip: Skip, value: string): void {
	if (skip.samples.length < SAMPLE_LIMIT) skip.samples.push(value);
}

// ── Migration context ───────────────────────────────────────────────

/** Every PG table the migration writes, in report order. */
const TABLES = [
	"apps",
	"blueprint_entities",
	"accepted_mutations",
	"events",
	"threads",
	"run_summaries",
	"usage_months",
	"credit_months",
	"credit_grants",
	"user_settings",
	"media_assets",
	"media_asset_refs",
] as const;
type TableName = (typeof TABLES)[number];

interface MigrateContext {
	apply: boolean;
	appIdFilter: string | null;
	/** assetId → app ids that reference it (built from real, non-built-in refs)
	 *  — supplies edges for media assets whose `referencingAppIds` is absent. */
	assetToApps: Map<string, Set<string>>;
	/** appId → stable-stringified expected blueprint, for PG verification. */
	expectedBlueprint: Map<string, string>;
	migratedAppIds: string[];
	/** Rows written (or that WOULD be written) per table. */
	counts: Record<TableName, number>;
	/** Undecodable / skipped docs per collection label. */
	skips: Record<string, Skip>;
	appFailures: Skip;
	/** fold(accepted_mutations) == entity-row snapshot outcomes, per app. */
	fold: { verified: number; incomplete: number; errors: Skip };
}

function newContext(): MigrateContext {
	const counts = Object.fromEntries(TABLES.map((t) => [t, 0])) as Record<
		TableName,
		number
	>;
	return {
		apply: opts.apply === true,
		appIdFilter: opts.appId ?? null,
		assetToApps: new Map(),
		expectedBlueprint: new Map(),
		migratedAppIds: [],
		counts,
		skips: {},
		appFailures: newSkip(),
		fold: { verified: 0, incomplete: 0, errors: newSkip() },
	};
}

/** Tally one app's fold outcome into the running fold stats. */
function recordFold(
	ctx: MigrateContext,
	appId: string,
	outcome: FoldOutcome,
): void {
	if (outcome.kind === "verified") ctx.fold.verified++;
	else if (outcome.kind === "incomplete") ctx.fold.incomplete++;
	else {
		ctx.fold.errors.n++;
		addSample(ctx.fold.errors, `${appId} (${outcome.message})`);
	}
}

function skipFor(ctx: MigrateContext, label: string): Skip {
	const existing = ctx.skips[label];
	if (existing) return existing;
	const skip = newSkip();
	ctx.skips[label] = skip;
	return skip;
}

// ── Insert helper ───────────────────────────────────────────────────

async function insertChunked<TB extends keyof AppDatabase>(
	tx: Transaction<AppDatabase>,
	table: TB,
	rows: Insertable<AppDatabase[TB]>[],
): Promise<void> {
	for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
		const chunk = rows.slice(i, i + INSERT_CHUNK);
		if (chunk.length > 0) await tx.insertInto(table).values(chunk).execute();
	}
}

/** Collect + decode every doc of a stream, counting undecodables into `skip`. */
async function collectDecoded(
	docs: AsyncGenerator<FirestoreDocument>,
	skip: Skip,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
	const out: Array<{ id: string; data: Record<string, unknown> }> = [];
	for await (const doc of docs) {
		try {
			out.push({ id: docIdFromName(doc.name), data: decodeDocument(doc) });
		} catch (err) {
			skip.n++;
			addSample(skip, `${shortPath(doc.name)} (${messageOf(err)})`);
		}
	}
	return out;
}

// ── Row builders (Firestore doc → PG row) ───────────────────────────

/** The `apps`-row scalar slice — mirrors `lib/db/apps.ts::denormalize`. */
function denormalize(doc: PersistableDoc) {
	const formCount = doc.moduleOrder.reduce(
		(sum, modUuid) => sum + (doc.formOrder[modUuid]?.length ?? 0),
		0,
	);
	return {
		app_name: doc.appName,
		app_name_lower: (doc.appName || UNTITLED_APP_NAME).toLowerCase(),
		connect_type: doc.connectType ?? null,
		case_types: doc.caseTypes === null ? null : JSON.stringify(doc.caseTypes),
		logo: doc.logo ?? null,
		module_count: doc.moduleOrder.length,
		form_count: formCount,
	};
}

function buildAppRow(
	appId: string,
	data: Record<string, unknown>,
	persistable: PersistableDoc,
): Insertable<AppsTable> {
	const reservation =
		data.reservation && typeof data.reservation === "object"
			? (data.reservation as Record<string, unknown>)
			: null;
	const runLock =
		data.run_lock && typeof data.run_lock === "object"
			? (data.run_lock as Record<string, unknown>)
			: null;
	return {
		id: appId,
		owner: str(data.owner) ?? "",
		project_id: str(data.project_id),
		...denormalize(persistable),
		mutation_seq: num(data.mutation_seq, 0),
		status: str(data.status) ?? "complete",
		awaiting_input: data.awaiting_input === true,
		error_type: str(data.error_type),
		deleted_at: toDate(data.deleted_at),
		recoverable_until: toDate(data.recoverable_until),
		run_id: str(data.run_id),
		// Reservation marker → res_* columns (legacy `expireAt` intentionally dropped).
		res_period: reservation ? str(reservation.period) : null,
		res_reserved: reservation ? num(reservation.reserved, 0) : null,
		res_settled: reservation ? reservation.settled === true : null,
		res_user_id: reservation ? str(reservation.userId) : null,
		res_run_id: reservation ? str(reservation.runId) : null,
		// Edit lease → lock_* columns.
		lock_run_id: runLock ? str(runLock.runId) : null,
		lock_actor_user_id: runLock ? str(runLock.actorUserId) : null,
		lock_expire_at: runLock ? toDate(runLock.expireAt) : null,
		created_at: toDate(data.created_at) ?? new Date(),
		updated_at: toDate(data.updated_at) ?? new Date(),
	};
}

function entityRowValues(
	appId: string,
	rows: EntityRow[],
): Insertable<BlueprintEntitiesTable>[] {
	return rows.map((r) => ({
		app_id: appId,
		uuid: r.uuid,
		kind: r.kind,
		parent_uuid: r.parent_uuid,
		ordinal: r.ordinal,
		data: JSON.stringify(r.data),
	}));
}

/** A non-empty string natural-key field, or a throw naming the doc — never
 *  coerced to "" (two coerced docs would collide on a PK/UNIQUE column and roll
 *  back the whole app under an opaque 23505). */
function requireKeyString(
	value: unknown,
	field: string,
	docPath: string,
): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${docPath}: missing/empty natural-key field "${field}"`);
	}
	return value;
}

/** A non-negative integer `seq`, or a throw — never coerced to 0. */
function requireKeySeq(value: unknown, docPath: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(
			`${docPath}: missing/invalid "seq" (need a non-negative integer)`,
		);
	}
	return value;
}

function acceptedMutationRow(
	appId: string,
	docId: string,
	data: Record<string, unknown>,
): Insertable<AcceptedMutationsTable> {
	const docPath = `apps/${appId}/acceptedMutations/${docId}`;
	return {
		app_id: appId,
		// seq (PK) + batch_id (UNIQUE) are natural keys — reject, never coerce.
		seq: requireKeySeq(data.seq, docPath),
		batch_id: requireKeyString(data.batchId, "batchId", docPath),
		run_id: str(data.runId), // nullable — absent for an autosave batch
		actor_id: str(data.actorId) ?? "",
		kind: str(data.kind) ?? "chat",
		mutations: JSON.stringify(
			Array.isArray(data.mutations) ? data.mutations : [],
		),
		ts: toDate(data.ts) ?? new Date(),
	};
}

function eventRow(
	appId: string,
	data: Record<string, unknown>,
): Insertable<EventsTable> {
	// The `id` identity column is server-assigned; the whole decoded doc rides
	// the `event` jsonb column, with the envelope fields projected out.
	return {
		app_id: appId,
		run_id: str(data.runId) ?? "",
		ts: num(data.ts, 0),
		seq: num(data.seq, 0),
		source: str(data.source) ?? "chat",
		kind: str(data.kind) ?? "",
		event: JSON.stringify(data),
	};
}

function threadRow(
	appId: string,
	threadId: string,
	data: Record<string, unknown>,
): Insertable<ThreadsTable> {
	return {
		app_id: appId,
		thread_id: threadId,
		created_at: str(data.created_at) ?? new Date().toISOString(),
		thread_type: str(data.thread_type) ?? "build",
		summary: str(data.summary) ?? "",
		run_id: str(data.run_id) ?? threadId,
		messages: JSON.stringify(Array.isArray(data.messages) ? data.messages : []),
	};
}

function runSummaryRow(
	appId: string,
	docId: string,
	data: Record<string, unknown>,
): Insertable<RunSummariesTable> {
	// run_id is part of the (app_id, run_id) PK — reject, never coerce to "".
	const runId = requireKeyString(
		data.runId,
		"runId",
		`apps/${appId}/runs/${docId}`,
	);
	return {
		app_id: appId,
		run_id: runId,
		started_at: str(data.startedAt) ?? "",
		finished_at: str(data.finishedAt) ?? "",
		prompt_mode: str(data.promptMode) ?? "build",
		fresh_edit: data.freshEdit === true,
		app_ready: data.appReady === true,
		cache_expired: data.cacheExpired === true,
		module_count: num(data.moduleCount, 0),
		step_count: num(data.stepCount, 0),
		model: str(data.model) ?? "",
		input_tokens: num(data.inputTokens, 0),
		output_tokens: num(data.outputTokens, 0),
		cache_read_tokens: num(data.cacheReadTokens, 0),
		cache_write_tokens: num(data.cacheWriteTokens, 0),
		cost_estimate: num(data.costEstimate, 0),
		tool_call_count: num(data.toolCallCount, 0),
	};
}

// ── App pass ────────────────────────────────────────────────────────

async function migrateApps(
	fs: FirestoreRest,
	ctx: MigrateContext,
): Promise<void> {
	printSection(
		"Apps (+ blueprint_entities, accepted_mutations, events, threads, run_summaries)",
	);
	if (ctx.appIdFilter) {
		const doc = await fs.getDocument(`apps/${ctx.appIdFilter}`);
		if (!doc) {
			throw new Error(`app ${ctx.appIdFilter} not found in Firestore`);
		}
		await migrateOneApp(fs, ctx, doc);
	} else {
		for await (const doc of fs.scanRootCollection("apps")) {
			await migrateOneApp(fs, ctx, doc);
		}
	}
	console.log(`  apps migrated: ${ctx.migratedAppIds.length}`);
}

async function migrateOneApp(
	fs: FirestoreRest,
	ctx: MigrateContext,
	doc: FirestoreDocument,
): Promise<void> {
	const appId = docIdFromName(doc.name);
	try {
		const data = decodeDocument(doc);
		const blueprintRaw = data.blueprint;
		if (!blueprintRaw || typeof blueprintRaw !== "object") {
			throw new Error("app document carries no blueprint");
		}
		const persistable = toPersistableDoc(
			hydratePersistedBlueprint(blueprintRaw as PersistableDoc),
		);
		const entityRows = decomposeBlueprint(persistable);
		const appRow = buildAppRow(appId, data, persistable);

		// Read all subcollections from Firestore before opening the PG txn.
		const parent = `apps/${appId}`;
		const acceptedMutations = await collectDecoded(
			fs.scanSubcollection(parent, "acceptedMutations"),
			skipFor(ctx, "accepted_mutations"),
		);
		const runs = await collectDecoded(
			fs.scanSubcollection(parent, "runs"),
			skipFor(ctx, "run_summaries"),
		);
		const threads = await collectDecoded(
			fs.scanSubcollection(parent, "threads"),
			skipFor(ctx, "threads"),
		);
		const events = await collectDecoded(
			fs.scanSubcollection(parent, "events"),
			skipFor(ctx, "events"),
		);

		if (ctx.apply) {
			await withAppTx(async (tx) => {
				// Delete-then-insert: the apps-row delete cascades its FK children
				// (blueprint_entities, accepted_mutations, threads, run_summaries);
				// events carry no FK, so clear them explicitly.
				await tx.deleteFrom("events").where("app_id", "=", appId).execute();
				await tx.deleteFrom("apps").where("id", "=", appId).execute();
				await tx.insertInto("apps").values(appRow).execute();
				await insertChunked(
					tx,
					"blueprint_entities",
					entityRowValues(appId, entityRows),
				);
				await insertChunked(
					tx,
					"accepted_mutations",
					acceptedMutations.map((d) =>
						acceptedMutationRow(appId, d.id, d.data),
					),
				);
				await insertChunked(
					tx,
					"events",
					events.map((d) => eventRow(appId, d.data)),
				);
				await insertChunked(
					tx,
					"threads",
					threads.map((d) => threadRow(appId, d.id, d.data)),
				);
				await insertChunked(
					tx,
					"run_summaries",
					runs.map((d) => runSummaryRow(appId, d.id, d.data)),
				);
			});
		}

		// Tally + record only after a successful write (or decode, in dry-run).
		ctx.counts.apps += 1;
		ctx.counts.blueprint_entities += entityRows.length;
		ctx.counts.accepted_mutations += acceptedMutations.length;
		ctx.counts.events += events.length;
		ctx.counts.threads += threads.length;
		ctx.counts.run_summaries += runs.length;
		ctx.migratedAppIds.push(appId);
		const expectedStable = stableStringify(
			assembleBlueprint(
				appId,
				blueprintScalars(persistable),
				decomposeBlueprint(persistable),
			),
		);
		ctx.expectedBlueprint.set(appId, expectedStable);
		// Fold tripwire: replay the retained accepted_mutations from empty genesis
		// and check they reproduce this app's entity-row snapshot (verified when
		// complete history from empty; tolerated when pruned/seeded).
		recordFold(
			ctx,
			appId,
			foldReproducesSnapshot(
				appId,
				batchesFromAcceptedMutations(acceptedMutations),
				expectedStable,
			),
		);
		for (const assetId of collectRealAssetRefs(asWalkableDoc(persistable))) {
			let set = ctx.assetToApps.get(assetId);
			if (!set) {
				set = new Set();
				ctx.assetToApps.set(assetId, set);
			}
			set.add(appId);
		}
	} catch (err) {
		ctx.appFailures.n++;
		addSample(ctx.appFailures, `${appId} (${messageOf(err)})`);
		console.error(`  ✗ app ${appId}: ${messageOf(err)}`);
	}
}

// ── Root-collection passes ──────────────────────────────────────────

/** usage/{u}/months + credits/{u}/months share the `months` subcollection id;
 *  one collection-group scan routes each doc by its root collection. */
async function migrateMonths(
	fs: FirestoreRest,
	ctx: MigrateContext,
): Promise<void> {
	printSection("usage_months + credit_months");
	const db = await getAppDb();
	for await (const doc of fs.scanCollectionGroup("months")) {
		const segments = segmentsFromName(doc.name);
		const root = segments[0];
		const userId = segments[1];
		const period = segments[3];
		if (!userId || !period) continue;
		let data: Record<string, unknown>;
		try {
			data = decodeDocument(doc);
		} catch (err) {
			const skip = skipFor(
				ctx,
				root === "usage" ? "usage_months" : "credit_months",
			);
			skip.n++;
			addSample(skip, `${shortPath(doc.name)} (${messageOf(err)})`);
			continue;
		}
		if (root === "usage") {
			ctx.counts.usage_months += 1;
			if (!ctx.apply) continue;
			const row: Insertable<UsageMonthsTable> = {
				user_id: userId,
				period,
				input_tokens: num(data.input_tokens, 0),
				output_tokens: num(data.output_tokens, 0),
				cost_estimate: num(data.cost_estimate, 0),
				request_count: num(data.request_count, 0),
				updated_at: toDate(data.updated_at) ?? new Date(),
			};
			await db
				.insertInto("usage_months")
				.values(row)
				.onConflict((oc) =>
					oc.columns(["user_id", "period"]).doUpdateSet((eb) => ({
						input_tokens: eb.ref("excluded.input_tokens"),
						output_tokens: eb.ref("excluded.output_tokens"),
						cost_estimate: eb.ref("excluded.cost_estimate"),
						request_count: eb.ref("excluded.request_count"),
						updated_at: eb.ref("excluded.updated_at"),
					})),
				)
				.execute();
		} else if (root === "credits") {
			ctx.counts.credit_months += 1;
			if (!ctx.apply) continue;
			const row: Insertable<CreditMonthsTable> = {
				user_id: userId,
				period,
				allowance: num(data.allowance, 0),
				consumed: num(data.consumed, 0),
				bonus: num(data.bonus, 0),
				updated_at: toDate(data.updated_at) ?? new Date(),
			};
			await db
				.insertInto("credit_months")
				.values(row)
				.onConflict((oc) =>
					oc.columns(["user_id", "period"]).doUpdateSet((eb) => ({
						allowance: eb.ref("excluded.allowance"),
						consumed: eb.ref("excluded.consumed"),
						bonus: eb.ref("excluded.bonus"),
						updated_at: eb.ref("excluded.updated_at"),
					})),
				)
				.execute();
		}
	}
}

/** credit_grants has an identity PK (no natural key), so idempotency is
 *  delete-then-insert per user: buffer each user's grants, then replace. */
async function migrateGrants(
	fs: FirestoreRest,
	ctx: MigrateContext,
): Promise<void> {
	printSection("credit_grants");
	const byUser = new Map<string, Array<Insertable<CreditGrantsTable>>>();
	for await (const doc of fs.scanCollectionGroup("grants")) {
		const userId = segmentsFromName(doc.name)[1];
		if (!userId) continue;
		let data: Record<string, unknown>;
		try {
			data = decodeDocument(doc);
		} catch (err) {
			const skip = skipFor(ctx, "credit_grants");
			skip.n++;
			addSample(skip, `${shortPath(doc.name)} (${messageOf(err)})`);
			continue;
		}
		const row: Insertable<CreditGrantsTable> = {
			user_id: userId,
			amount: num(data.amount, 0),
			type: str(data.type) === "grant" ? "grant" : "reset",
			actor: str(data.actor) ?? "",
			actor_email: str(data.actor_email) ?? "",
			reason: str(data.reason),
			period: str(data.period) ?? "",
			created_at: toDate(data.created_at) ?? new Date(),
		};
		const list = byUser.get(userId) ?? [];
		list.push(row);
		byUser.set(userId, list);
		ctx.counts.credit_grants += 1;
	}
	if (!ctx.apply) return;
	for (const [userId, rows] of byUser) {
		await withAppTx(async (tx) => {
			await tx
				.deleteFrom("credit_grants")
				.where("user_id", "=", userId)
				.execute();
			await insertChunked(tx, "credit_grants", rows);
		});
	}
}

async function migrateUserSettings(
	fs: FirestoreRest,
	ctx: MigrateContext,
): Promise<void> {
	printSection("user_settings");
	const db = await getAppDb();
	for await (const doc of fs.scanRootCollection("user_settings")) {
		const userId = docIdFromName(doc.name);
		let data: Record<string, unknown>;
		try {
			data = decodeDocument(doc);
		} catch (err) {
			const skip = skipFor(ctx, "user_settings");
			skip.n++;
			addSample(skip, `${shortPath(doc.name)} (${messageOf(err)})`);
			continue;
		}
		ctx.counts.user_settings += 1;
		if (!ctx.apply) continue;
		const row: Insertable<UserSettingsTable> = {
			user_id: userId,
			commcare_username: str(data.commcare_username) ?? "",
			commcare_api_key: str(data.commcare_api_key) ?? "",
			commcare_server: str(data.commcare_server),
			approved_domains: JSON.stringify(
				Array.isArray(data.approved_domains) ? data.approved_domains : [],
			),
			updated_at: toDate(data.updated_at) ?? new Date(),
		};
		await db
			.insertInto("user_settings")
			.values(row)
			.onConflict((oc) =>
				oc.column("user_id").doUpdateSet((eb) => ({
					commcare_username: eb.ref("excluded.commcare_username"),
					commcare_api_key: eb.ref("excluded.commcare_api_key"),
					commcare_server: eb.ref("excluded.commcare_server"),
					approved_domains: eb.ref("excluded.approved_domains"),
					updated_at: eb.ref("excluded.updated_at"),
				})),
			)
			.execute();
	}
}

/** Map the Firestore extract (extractedAt as a Timestamp/ISO string) to the PG
 *  jsonb shape (extractedAt as epoch ms). Returns `null` when `extractedAt` is
 *  absent or unparseable — the caller drops the extract entirely rather than
 *  write a fabricated or NaN→null timestamp that the read-time
 *  `mediaAssetExtractSchema.parse` would later throw on (breaking the whole
 *  project's library list). */
function mapExtract(
	extract: Record<string, unknown>,
): Record<string, unknown> | null {
	const { extractedAt, ...rest } = extract;
	let ms: number | null = null;
	if (typeof extractedAt === "string") {
		const parsed = new Date(extractedAt).getTime();
		if (!Number.isNaN(parsed)) ms = parsed;
	} else if (typeof extractedAt === "number" && Number.isFinite(extractedAt)) {
		ms = extractedAt;
	}
	if (ms === null) return null;
	return { ...rest, extractedAt: ms };
}

async function migrateMedia(
	fs: FirestoreRest,
	ctx: MigrateContext,
): Promise<void> {
	printSection("media_assets + media_asset_refs");
	for await (const doc of fs.scanRootCollection("mediaAssets")) {
		const assetId = docIdFromName(doc.name);
		let data: Record<string, unknown>;
		try {
			data = decodeDocument(doc);
		} catch (err) {
			const skip = skipFor(ctx, "media_assets");
			skip.n++;
			addSample(skip, `${shortPath(doc.name)} (${messageOf(err)})`);
			continue;
		}
		const projectId = str(data.project_id);
		if (!projectId) {
			const skip = skipFor(ctx, "media_assets");
			skip.n++;
			addSample(
				skip,
				`${assetId} (missing project_id — cannot satisfy NOT NULL)`,
			);
			continue;
		}

		// Edges: use the recorded candidate set when present (even []); compute
		// from the migrated apps' blueprints only when the field is ABSENT.
		// De-duplicated because `(asset_id, app_id)` is the join table's PK.
		const rawRefAppIds: string[] = Array.isArray(data.referencingAppIds)
			? (data.referencingAppIds as unknown[]).filter(
					(x): x is string => typeof x === "string",
				)
			: [...(ctx.assetToApps.get(assetId) ?? [])];
		const refAppIds = [...new Set(rawRefAppIds)];

		ctx.counts.media_assets += 1;
		ctx.counts.media_asset_refs += refAppIds.length;
		if (!ctx.apply) continue;

		let extract: Record<string, unknown> | null = null;
		if (data.extract && typeof data.extract === "object") {
			extract = mapExtract(data.extract as Record<string, unknown>);
			if (extract === null) {
				console.warn(
					`  ! media ${assetId}: dropping extract (missing/unparseable extractedAt)`,
				);
			}
		}
		const assetRow: Insertable<MediaAssetsTable> = {
			id: assetId,
			project_id: projectId,
			owner: str(data.owner) ?? "",
			content_hash: str(data.contentHash) ?? "",
			mime_type: str(data.mimeType) ?? "",
			extension: str(data.extension) ?? "",
			size_bytes: num(data.sizeBytes, 0),
			dimensions:
				data.dimensions && typeof data.dimensions === "object"
					? JSON.stringify(data.dimensions)
					: null,
			duration_ms: typeof data.durationMs === "number" ? data.durationMs : null,
			kind: str(data.kind) ?? "",
			gcs_object_key: str(data.gcsObjectKey) ?? "",
			original_filename: str(data.originalFilename) ?? "",
			display_name: str(data.displayName),
			status: str(data.status) ?? "",
			extract: extract ? JSON.stringify(extract) : null,
			created_at: toDate(data.created_at) ?? new Date(),
		};
		const refRows: Insertable<MediaAssetRefsTable>[] = refAppIds.map(
			(appId) => ({
				asset_id: assetId,
				app_id: appId,
			}),
		);
		await withAppTx(async (tx) => {
			await tx
				.insertInto("media_assets")
				.values(assetRow)
				.onConflict((oc) =>
					oc.column("id").doUpdateSet((eb) => ({
						project_id: eb.ref("excluded.project_id"),
						owner: eb.ref("excluded.owner"),
						content_hash: eb.ref("excluded.content_hash"),
						mime_type: eb.ref("excluded.mime_type"),
						extension: eb.ref("excluded.extension"),
						size_bytes: eb.ref("excluded.size_bytes"),
						dimensions: eb.ref("excluded.dimensions"),
						duration_ms: eb.ref("excluded.duration_ms"),
						kind: eb.ref("excluded.kind"),
						gcs_object_key: eb.ref("excluded.gcs_object_key"),
						original_filename: eb.ref("excluded.original_filename"),
						display_name: eb.ref("excluded.display_name"),
						status: eb.ref("excluded.status"),
						extract: eb.ref("excluded.extract"),
						created_at: eb.ref("excluded.created_at"),
					})),
				)
				.execute();
			// Rebuild this asset's edges (the join table must be complete).
			await tx
				.deleteFrom("media_asset_refs")
				.where("asset_id", "=", assetId)
				.execute();
			await insertChunked(tx, "media_asset_refs", refRows);
		});
	}
}

// ── Verification (after --apply) ────────────────────────────────────

async function countAll(table: TableName): Promise<number> {
	const db = await getAppDb();
	const row = await db
		.selectFrom(table)
		.select((eb) => eb.fn.countAll().as("c"))
		.executeTakeFirst();
	return Number((row as { c: string | number } | undefined)?.c ?? 0);
}

type AppScopedTable =
	| "blueprint_entities"
	| "accepted_mutations"
	| "events"
	| "threads"
	| "run_summaries";

async function countByApp(
	table: AppScopedTable,
	appId: string,
): Promise<number> {
	const db = await getAppDb();
	const row = await db
		.selectFrom(table)
		.select((eb) => eb.fn.countAll().as("c"))
		.where("app_id", "=", appId)
		.executeTakeFirst();
	return Number((row as { c: string | number } | undefined)?.c ?? 0);
}

/** Re-assemble each migrated app's blueprint from Postgres and compare it to
 *  the expected (hydrated-Firestore) blueprint. */
async function verifyBlueprints(ctx: MigrateContext): Promise<number> {
	const db = await getAppDb();
	let mismatches = 0;
	for (const appId of ctx.migratedAppIds) {
		const appRow = await db
			.selectFrom("apps")
			.select(["app_name", "connect_type", "case_types", "logo"])
			.where("id", "=", appId)
			.executeTakeFirst();
		if (!appRow) {
			mismatches++;
			console.error(`  ✗ ${appId}: apps row missing after write`);
			continue;
		}
		const rows = (await db
			.selectFrom("blueprint_entities")
			.select(["uuid", "kind", "parent_uuid", "ordinal", "data"])
			.where("app_id", "=", appId)
			.execute()) as EntityRow[];
		const assembled = assembleBlueprint(
			appId,
			{
				app_name: appRow.app_name,
				connect_type: appRow.connect_type,
				case_types: appRow.case_types,
				logo: appRow.logo,
			},
			rows,
		);
		if (stableStringify(assembled) !== ctx.expectedBlueprint.get(appId)) {
			mismatches++;
			console.error(`  ✗ ${appId}: PG blueprint differs from Firestore source`);
		}
	}
	return mismatches;
}

async function verify(ctx: MigrateContext): Promise<boolean> {
	printSection("Verification (Postgres)");
	const blueprintMismatches = await verifyBlueprints(ctx);
	console.log(
		blueprintMismatches === 0
			? `  ✓ blueprint round-trip: ${ctx.migratedAppIds.length} app(s) match`
			: `  ✗ blueprint round-trip: ${blueprintMismatches} mismatch(es)`,
	);

	// Row-count parity. Scope to the app in --app-id mode; global otherwise.
	const rows: string[][] = [];
	let countMismatch = false;
	const appScoped: AppScopedTable[] = [
		"blueprint_entities",
		"accepted_mutations",
		"events",
		"threads",
		"run_summaries",
	];
	const tablesToCheck: TableName[] = ctx.appIdFilter
		? ["apps", ...appScoped]
		: [...TABLES];
	for (const table of tablesToCheck) {
		const expected = ctx.counts[table];
		let actual: number;
		if (ctx.appIdFilter && table !== "apps") {
			actual = await countByApp(table as AppScopedTable, ctx.appIdFilter);
		} else if (ctx.appIdFilter && table === "apps") {
			actual = expected; // single app — trivially the one row
		} else {
			actual = await countAll(table);
		}
		const ok = actual === expected;
		if (!ok) countMismatch = true;
		rows.push([
			table,
			String(expected),
			String(actual),
			ok ? "✓" : "✗ MISMATCH",
		]);
	}
	printTable(
		[
			{ header: "Table" },
			{ header: "Firestore", align: "right" },
			{ header: "Postgres", align: "right" },
			{ header: "" },
		],
		rows,
	);
	return blueprintMismatches === 0 && !countMismatch;
}

// ── Report ──────────────────────────────────────────────────────────

function printSummary(ctx: MigrateContext): void {
	printSection(ctx.apply ? "Written" : "Would write (dry run)");
	printTable(
		[
			{ header: "Table" },
			{ header: "Rows", align: "right" },
			{ header: "Skipped (undecodable)", align: "right" },
		],
		TABLES.map((t) => [t, String(ctx.counts[t]), String(ctx.skips[t]?.n ?? 0)]),
	);
	for (const [label, skip] of Object.entries(ctx.skips)) {
		if (skip.samples.length > 0) {
			console.log(`\n  ${label} — skipped samples:`);
			for (const s of skip.samples) console.log(`    • ${s}`);
		}
	}
	if (ctx.appFailures.n > 0) {
		console.log(`\n  App failures (not migrated): ${ctx.appFailures.n}`);
		for (const s of ctx.appFailures.samples) console.log(`    • ${s}`);
	}

	printSection("Fold tripwire (accepted_mutations replay == entity snapshot)");
	console.log(
		`  verified (complete history from empty genesis): ${ctx.fold.verified}`,
	);
	console.log(
		`  incomplete (pruned ring or seeded genesis — tolerated): ${ctx.fold.incomplete}`,
	);
	console.log(
		`  errors (reducer threw — unreplayable stored mutations): ${ctx.fold.errors.n}`,
	);
	for (const s of ctx.fold.errors.samples) console.log(`    • ${s}`);

	printSection("Dropped from the old schema");
	console.log(
		"  • batchDedup subcollection      — replaced by UNIQUE(app_id, batch_id)",
	);
	console.log("  • presence subcollection        — ephemeral live roster");
	console.log("  • reservation.expireAt (legacy) — marker carries no expiry");
	console.log(
		"  • acceptedMutations.expireAt    — accepted_mutations is permanent",
	);
}

// ── Entry point ─────────────────────────────────────────────────────

async function preflight(): Promise<void> {
	const db = await getAppDb();
	try {
		await db.selectFrom("apps").select("id").limit(1).execute();
	} catch (err) {
		throw new Error(
			`Postgres app-state tables not reachable — run \`npm run db:migrate\` first. (${messageOf(err)})`,
		);
	}
}

async function main(): Promise<number> {
	printHeader(`Firestore → Postgres cutover · ${opts.project}`);
	const ctx = newContext();
	console.log(
		ctx.apply
			? "  APPLY MODE — writing to Postgres."
			: "  DRY RUN — no writes (pass --apply to write).",
	);
	if (ctx.appIdFilter) console.log(`  Scoped to app: ${ctx.appIdFilter}\n`);
	else console.log("");

	await preflight();
	const fs = await createFirestoreRest(opts.project, opts.pageSize);

	await migrateApps(fs, ctx);
	if (!ctx.appIdFilter) {
		await migrateMonths(fs, ctx);
		await migrateGrants(fs, ctx);
		await migrateUserSettings(fs, ctx);
		await migrateMedia(fs, ctx);
	} else {
		console.log("\n  (root collections skipped in --app-id mode)");
	}

	printSummary(ctx);

	// A reducer THROW during fold means genuinely unreplayable stored mutations;
	// mismatches (pruned/seeded) are tolerated and never fail.
	const foldErrored = ctx.fold.errors.n > 0;

	if (ctx.apply) {
		const ok = await verify(ctx);
		printSection("Verdict");
		if (ok && ctx.appFailures.n === 0 && !foldErrored) {
			console.log(
				"  ✓ Migration verified — blueprints round-trip, counts match, fold clean.\n",
			);
			return 0;
		}
		console.log(
			"  ✗ Verification FAILED — see mismatches / fold errors above.\n",
		);
		return 1;
	}

	printSection("Verdict");
	if (foldErrored) {
		console.log(
			`  ✗ Dry run found ${ctx.fold.errors.n} fold error(s) — investigate before --apply.\n`,
		);
		return 1;
	}
	console.log("  Dry run complete. Re-run with --apply to write.\n");
	return ctx.appFailures.n === 0 ? 0 : 1;
}

/** Bounded pool teardown, mirroring `scripts/migrate.ts::finish` — never
 *  changes the exit code the migration already decided. */
const TEARDOWN_TIMEOUT_MS = 10_000;
async function finish(code: number): Promise<never> {
	try {
		await Promise.race([
			closeCaseStoreDatabase(),
			new Promise((resolve) => setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
		]);
	} catch (err) {
		console.error("[migrate] teardown error (ignored):", err);
	}
	process.exit(code);
}

main().then(
	(code) => finish(code),
	(err: unknown) => {
		console.error("Fatal:", err);
		return finish(1);
	},
);
