// lib/db/__tests__/appStateTestDb.ts
//
// Shared per-test-database harness for the `lib/db` app-state suites (apps,
// credits, run lifecycle, commit gate, listings, settings, run summaries,
// media metadata). It wraps `setupPerTestDatabase` (a fresh Postgres database
// per test, the `db.transaction()`-safe path the guarded-commit + claim
// transactions need) with three extra jobs every app-state suite shares:
//
//   1. apply the case-store migrations (`runCaseStoreMigrations`) so the
//      per-test database carries the `apps` / `blueprint_entities` /
//      `app_changes` / credit-ledger / media tables;
//   2. point `getAppDb()` at the per-test handle via `__setAppDbForTests`
//      (cleared in `afterEach`, so no injected handle leaks across files —
//      the async-leak gate's contract);
//   3. hand the suite typed seed/read helpers for the two rows the run
//      lifecycle turns on — the `apps` row (with its nullable reservation +
//      run-lock column groups reassembled from the `AppReservation` /
//      `AppRunLock` shapes the tests speak) and the `credit_months` row.
//
// A suite calls `setupAppStateTestDb()` at module scope, then reads the live
// handle inside test bodies (`h.db()` / `h.pool()` throw outside a test, the
// same guard `setupPerTestDatabase` imposes).

import { produce } from "immer";
import {
	Kysely,
	PostgresDialect,
	type PostgresPool,
	sql,
	type Transaction,
} from "kysely";
import type { Pool } from "pg";
import { afterEach, beforeEach } from "vitest";
import { up as installAuthMemberSerialization } from "@/lib/auth/migrations/20260722070000_auth_member_serialization";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { UNTITLED_APP_NAME } from "@/lib/db/apps";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";
import type { AppReservation, AppRunLock } from "@/lib/db/types";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { canonicalAppGenesis } from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/domain";

/** The reservation/run-lock column groups a test controls, in the same
 *  optional-object shape `runLeaseState` reads — mapped onto the flat
 *  `res_*` / `lock_*` columns by {@link seedApp}. */
export interface SeedAppOptions {
	id?: string;
	owner?: string;
	project_id?: string;
	app_name?: string;
	status?: "generating" | "complete" | "error";
	awaiting_input?: boolean;
	error_type?: string | null;
	updated_at?: Date;
	created_at?: Date;
	run_id?: string | null;
	run_holder_nonce?: string | null;
	deleted_at?: Date | null;
	recoverable_until?: Date | null;
	module_count?: number;
	form_count?: number;
	connect_type?: "learn" | "deliver" | null;
	/** The credit-reservation marker, or null/omitted for none. */
	reservation?: AppReservation | null;
	/** The exclusive edit lease, or null/omitted for none. */
	run_lock?: AppRunLock | null;
}

export interface AppStateTestDb {
	/** One transaction on the per-test handle, for suites that must write the
	 *  way an authoritative writer does rather than through a seed helper. */
	withTransaction<T>(
		body: (tx: Transaction<AppDatabase>) => Promise<T>,
	): Promise<T>;
	/** The injected `Kysely<AppDatabase>` for the current test. Throws outside a test body. */
	db(): Kysely<AppDatabase>;
	/** The per-test `pg.Pool` for raw queries. Throws outside a test body. */
	pool(): Pool;
	/** The per-test database URI (for a second connection in contention tests). */
	uri(): string;
	/** Insert an `apps` row at a controlled run/credit state; returns its id. */
	seedApp(opts?: SeedAppOptions): Promise<string>;
	/**
	 * Insert only the raw `apps` row, with no Blueprint entities. Reserved for
	 * tests whose subject is malformed persisted state; ordinary fixtures use
	 * {@link seedApp} and therefore start from canonical valid genesis.
	 */
	seedRawApp(opts?: SeedAppOptions): Promise<string>;
	/**
	 * Insert an `apps` row AND its `blueprint_entities` rows for a given
	 * `BlueprintDoc` (the guarded-commit path reads the assembled blueprint, so
	 * a bare row isn't enough). Scalars + entity rows land at `mutation_seq: 0`,
	 * `status: complete`. Returns its id.
	 */
	seedAppWithBlueprint(
		doc: BlueprintDoc,
		opts?: {
			id?: string;
			owner?: string;
			projectId?: string;
		},
	): Promise<string>;
	/** Insert or replace a Project membership used by authoritative app writers. */
	seedProjectMember(
		userId: string,
		projectId: string,
		role?: "viewer" | "editor" | "admin" | "owner",
	): Promise<void>;
	/**
	 * Move an app (and its case rows) to another Project the way the database
	 * requires. A bare `UPDATE apps SET project_id` is refused: the app-Project
	 * trigger demands an exact same-sequence `project-move` app change whose
	 * `from`/`to` match the transition. Tests that only need an app to have
	 * changed Projects call this instead of writing the flip by hand.
	 */
	moveAppToProject(
		appId: string,
		toProjectId: string,
		actorUserId: string,
	): Promise<void>;
	/** Insert (or replace) a `credit_months` row for a user's current/other period. */
	seedCreditMonth(
		userId: string,
		period: string,
		balance: { allowance: number; consumed: number; bonus: number },
	): Promise<void>;
	/** Read a `credit_months` row's `consumed`, or undefined when the row is absent. */
	readConsumed(userId: string, period: string): Promise<number | undefined>;
	/** Read the full `apps` row (raw columns). */
	readAppRow(appId: string): Promise<Record<string, unknown> | undefined>;
	/** Reassemble the reservation marker off an `apps` row's `res_*` columns. */
	readReservation(appId: string): Promise<AppReservation | undefined>;
	/** Reassemble the run-lock off an `apps` row's `lock_*` columns. */
	readRunLock(appId: string): Promise<AppRunLock | undefined>;
}

const DEFAULT_APP_ID = "app-under-test";

/** Build the exact smallest export-ready document production app genesis uses. */
export function canonicalTestBlueprint(
	appId: string,
	requestedName?: string,
): BlueprintDoc {
	const empty: BlueprintDoc = {
		appId,
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
	const genesis = canonicalAppGenesis(empty, requestedName);
	return produce(empty, (draft) => {
		applyMutations(draft, genesis.mutations);
	});
}

/**
 * Wire the per-test Postgres database + migrations + the `getAppDb` injection
 * for an app-state suite. Registers its own `beforeEach`/`afterEach`; the
 * returned helpers are only valid inside a test body.
 */
export function setupAppStateTestDb(prefix = "app_state_"): AppStateTestDb {
	const handle = setupPerTestDatabase({ databaseNamePrefix: prefix });
	let injected: Kysely<AppDatabase> | null = null;

	beforeEach(async () => {
		await runCaseStoreMigrations(handle.db);
		await handle.pool.query(`
			CREATE TABLE auth_member (
				id text PRIMARY KEY,
				"userId" text NOT NULL,
				"organizationId" text NOT NULL,
				role text NOT NULL,
				UNIQUE ("organizationId", "userId")
			)
		`);
		injected = new Kysely<AppDatabase>({
			dialect: new PostgresDialect({
				pool: handle.pool as unknown as PostgresPool,
			}),
		});
		__setAppDbForTests(injected);
		await installAuthMemberSerialization(
			injected as unknown as Kysely<unknown>,
		);
	});

	afterEach(async () => {
		__setAppDbForTests(null);
		// The wrapper Kysely rides the per-test pool `setupPerTestDatabase`
		// destroys in its own afterEach; destroying it here would double-close.
		injected = null;
	});

	const db = (): Kysely<AppDatabase> => {
		if (injected === null) {
			throw new Error("appStateTestDb.db() read outside a test body");
		}
		return injected;
	};

	async function insertAppFixture(
		opts: SeedAppOptions,
		doc: BlueprintDoc | null,
	): Promise<string> {
		const id = opts.id ?? DEFAULT_APP_ID;
		const appName = opts.app_name ?? "";
		const reservation = opts.reservation ?? undefined;
		const lock = opts.run_lock ?? undefined;
		const owner = opts.owner ?? "owner-test";
		const projectId = opts.project_id ?? "project-test";
		const persistable = doc === null ? null : toPersistableDoc(doc);
		const formCount =
			persistable?.moduleOrder.reduce(
				(sum, moduleUuid) =>
					sum + (persistable.formOrder[moduleUuid]?.length ?? 0),
				0,
			) ?? 0;
		await seedProjectMember(owner, projectId, "owner");
		await db()
			.transaction()
			.execute(async (tx) => {
				await tx
					.insertInto("apps")
					.values({
						id,
						owner,
						project_id: projectId,
						app_name: appName,
						app_name_lower: (appName || UNTITLED_APP_NAME).toLowerCase(),
						connect_type: opts.connect_type ?? persistable?.connectType ?? null,
						case_types:
							persistable?.caseTypes == null
								? null
								: JSON.stringify(persistable.caseTypes),
						logo: persistable?.logo ?? null,
						module_count:
							opts.module_count ?? persistable?.moduleOrder.length ?? 0,
						form_count: opts.form_count ?? formCount,
						mutation_seq: 0,
						status: opts.status ?? "complete",
						awaiting_input: opts.awaiting_input ?? false,
						error_type: opts.error_type ?? null,
						deleted_at: opts.deleted_at ?? null,
						recoverable_until: opts.recoverable_until ?? null,
						run_id: opts.run_id ?? null,
						run_holder_nonce: opts.run_holder_nonce ?? null,
						res_period: reservation?.period ?? null,
						res_reserved: reservation?.reserved ?? null,
						res_settled: reservation ? reservation.settled : null,
						res_user_id: reservation?.userId ?? null,
						res_run_id: reservation?.runId ?? null,
						lock_run_id: lock?.runId ?? null,
						lock_actor_user_id: lock?.actorUserId ?? null,
						lock_expire_at: lock?.expireAt ?? null,
						...(opts.updated_at && { updated_at: opts.updated_at }),
						...(opts.created_at && { created_at: opts.created_at }),
					})
					.execute();
				if (persistable !== null) {
					const rows = decomposeBlueprint(persistable);
					if (rows.length > 0) {
						await tx
							.insertInto("blueprint_entities")
							.values(
								rows.map((row) => ({
									app_id: id,
									uuid: row.uuid,
									kind: row.kind,
									parent_uuid: row.parent_uuid,
									ordinal: row.ordinal,
									data: JSON.stringify(row.data),
								})),
							)
							.execute();
					}
				}
			});
		return id;
	}

	async function seedApp(opts: SeedAppOptions = {}): Promise<string> {
		const id = opts.id ?? DEFAULT_APP_ID;
		const doc = canonicalTestBlueprint(id, opts.app_name);
		return insertAppFixture(
			{
				...opts,
				id,
				app_name: doc.appName,
			},
			doc,
		);
	}

	async function seedRawApp(opts: SeedAppOptions = {}): Promise<string> {
		return insertAppFixture(opts, null);
	}

	async function seedAppWithBlueprint(
		doc: BlueprintDoc,
		opts: { id?: string; owner?: string; projectId?: string } = {},
	): Promise<string> {
		const id = opts.id ?? crypto.randomUUID();
		return insertAppFixture(
			{
				id,
				app_name: doc.appName,
				...(opts.owner !== undefined && { owner: opts.owner }),
				...(opts.projectId !== undefined && { project_id: opts.projectId }),
			},
			{ ...doc, appId: id },
		);
	}

	async function seedProjectMember(
		userId: string,
		projectId: string,
		role: "viewer" | "editor" | "admin" | "owner" = "editor",
	): Promise<void> {
		await sql`
			INSERT INTO auth_member (id, "userId", "organizationId", role)
			VALUES (${crypto.randomUUID()}, ${userId}, ${projectId}, ${role})
			ON CONFLICT ("organizationId", "userId")
			DO UPDATE SET role = EXCLUDED.role
		`.execute(db());
	}

	async function moveAppToProject(
		appId: string,
		toProjectId: string,
		actorUserId: string,
	): Promise<void> {
		await db()
			.transaction()
			.execute(async (tx) => {
				const app = await tx
					.selectFrom("apps")
					.select(["project_id", "mutation_seq"])
					.where("id", "=", appId)
					.forUpdate()
					.executeTakeFirstOrThrow();
				const seq = Number(app.mutation_seq) + 1;
				// The change row must exist before the app row moves: the trigger
				// looks for it at exactly `NEW.mutation_seq`.
				await tx
					.insertInto("app_changes")
					.values({
						app_id: appId,
						seq,
						batch_id: crypto.randomUUID(),
						run_id: null,
						actor_id: actorUserId,
						kind: "project-move",
						mutations: "[]",
						from_project_id: app.project_id,
						to_project_id: toProjectId,
					})
					.execute();
				await tx
					.updateTable("apps")
					.set({ project_id: toProjectId, mutation_seq: seq })
					.where("id", "=", appId)
					.execute();
				await sql`
					UPDATE cases SET project_id = ${toProjectId} WHERE app_id = ${appId}
				`.execute(tx);
			});
	}

	async function seedCreditMonth(
		userId: string,
		period: string,
		balance: { allowance: number; consumed: number; bonus: number },
	): Promise<void> {
		await db()
			.insertInto("credit_months")
			.values({ user_id: userId, period, ...balance, updated_at: new Date() })
			.onConflict((oc) =>
				oc.columns(["user_id", "period"]).doUpdateSet({
					allowance: balance.allowance,
					consumed: balance.consumed,
					bonus: balance.bonus,
					updated_at: new Date(),
				}),
			)
			.execute();
	}

	async function readConsumed(
		userId: string,
		period: string,
	): Promise<number | undefined> {
		const row = await db()
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", userId)
			.where("period", "=", period)
			.executeTakeFirst();
		return row?.consumed;
	}

	async function readAppRow(
		appId: string,
	): Promise<Record<string, unknown> | undefined> {
		return (await db()
			.selectFrom("apps")
			.selectAll()
			.where("id", "=", appId)
			.executeTakeFirst()) as Record<string, unknown> | undefined;
	}

	async function readReservation(
		appId: string,
	): Promise<AppReservation | undefined> {
		const row = await db()
			.selectFrom("apps")
			.select([
				"res_period",
				"res_reserved",
				"res_settled",
				"res_user_id",
				"res_run_id",
			])
			.where("id", "=", appId)
			.executeTakeFirst();
		if (!row || row.res_period === null) return undefined;
		return {
			period: row.res_period,
			reserved: row.res_reserved ?? 0,
			settled: !!row.res_settled,
			...(row.res_user_id !== null && { userId: row.res_user_id }),
			...(row.res_run_id !== null && { runId: row.res_run_id }),
		};
	}

	async function readRunLock(appId: string): Promise<AppRunLock | undefined> {
		const row = await db()
			.selectFrom("apps")
			.select(["lock_run_id", "lock_actor_user_id", "lock_expire_at"])
			.where("id", "=", appId)
			.executeTakeFirst();
		if (!row || row.lock_run_id === null) return undefined;
		return {
			runId: row.lock_run_id,
			actorUserId: row.lock_actor_user_id ?? "",
			expireAt: row.lock_expire_at ?? new Date(0),
		};
	}

	return {
		withTransaction: <T>(
			body: (tx: Transaction<AppDatabase>) => Promise<T>,
		): Promise<T> => db().transaction().execute(body),
		db,
		pool: () => handle.pool,
		uri: () => handle.uri,
		seedApp,
		seedRawApp,
		seedAppWithBlueprint,
		seedProjectMember,
		moveAppToProject,
		seedCreditMonth,
		readConsumed,
		readAppRow,
		readReservation,
		readRunLock,
	};
}
