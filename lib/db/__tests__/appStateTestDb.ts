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
//      `accepted_mutations` / credit-ledger / media tables;
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

import { Kysely, PostgresDialect, type PostgresPool, sql } from "kysely";
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
import type { BlueprintDoc } from "@/lib/domain";

/** The reservation/run-lock column groups a test controls, in the same
 *  optional-object shape `runLeaseState` reads — mapped onto the flat
 *  `res_*` / `lock_*` columns by {@link seedApp}. */
export interface SeedAppOptions {
	id?: string;
	owner?: string;
	project_id?: string | null;
	app_name?: string;
	status?: "generating" | "complete" | "error" | "deleted";
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
	/** The injected `Kysely<AppDatabase>` for the current test. Throws outside a test body. */
	db(): Kysely<AppDatabase>;
	/** The per-test `pg.Pool` for raw queries. Throws outside a test body. */
	pool(): Pool;
	/** The per-test database URI (for a second connection in contention tests). */
	uri(): string;
	/** Insert an `apps` row at a controlled run/credit state; returns its id. */
	seedApp(opts?: SeedAppOptions): Promise<string>;
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
			projectId?: string | null;
		},
	): Promise<string>;
	/** Insert or replace a Project membership used by authoritative app writers. */
	seedProjectMember(
		userId: string,
		projectId: string,
		role?: "viewer" | "editor" | "admin" | "owner",
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

	async function seedApp(opts: SeedAppOptions = {}): Promise<string> {
		const id = opts.id ?? DEFAULT_APP_ID;
		const appName = opts.app_name ?? "";
		const reservation = opts.reservation ?? undefined;
		const lock = opts.run_lock ?? undefined;
		const owner = opts.owner ?? "owner-test";
		const projectId =
			opts.project_id === undefined ? "project-test" : opts.project_id;
		if (projectId !== null) {
			await seedProjectMember(owner, projectId, "owner");
		}
		await db()
			.transaction()
			.execute(async (tx) => {
				// Direct fixture writes deliberately bypass the app API. Declare the
				// nonce-aware reader in the same transaction so the production holder
				// trigger stamps rather than downgrades an active fixture to v0.
				const runtimeReaderVersion = opts.run_holder_nonce ? "1" : "0";
				await sql`SELECT set_config('nova.runtime_reader_version', ${runtimeReaderVersion}, true)`.execute(
					tx,
				);
				await tx
					.insertInto("apps")
					.values({
						id,
						owner,
						project_id: projectId,
						app_name: appName,
						app_name_lower: (appName || UNTITLED_APP_NAME).toLowerCase(),
						connect_type: opts.connect_type ?? null,
						case_types: null,
						logo: null,
						module_count: opts.module_count ?? 0,
						form_count: opts.form_count ?? 0,
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
			});
		return id;
	}

	async function seedAppWithBlueprint(
		doc: BlueprintDoc,
		opts: { id?: string; owner?: string; projectId?: string | null } = {},
	): Promise<string> {
		const persistable = toPersistableDoc(doc);
		const id = opts.id ?? crypto.randomUUID();
		const owner = opts.owner ?? "owner-test";
		const projectId =
			opts.projectId === undefined ? "project-test" : opts.projectId;
		if (projectId !== null) {
			await seedProjectMember(owner, projectId, "owner");
		}
		const formCount = persistable.moduleOrder.reduce(
			(sum, m) => sum + (persistable.formOrder[m]?.length ?? 0),
			0,
		);
		await db()
			.insertInto("apps")
			.values({
				id,
				owner,
				project_id: projectId,
				app_name: persistable.appName,
				app_name_lower: (
					persistable.appName || UNTITLED_APP_NAME
				).toLowerCase(),
				connect_type: persistable.connectType ?? null,
				case_types:
					persistable.caseTypes === null
						? null
						: JSON.stringify(persistable.caseTypes),
				logo: persistable.logo ?? null,
				module_count: persistable.moduleOrder.length,
				form_count: formCount,
				mutation_seq: 0,
				status: "complete",
				awaiting_input: false,
				error_type: null,
				deleted_at: null,
				recoverable_until: null,
				run_id: null,
			})
			.execute();
		const rows = decomposeBlueprint(persistable);
		if (rows.length > 0) {
			await db()
				.insertInto("blueprint_entities")
				.values(
					rows.map((r) => ({
						app_id: id,
						uuid: r.uuid,
						kind: r.kind,
						parent_uuid: r.parent_uuid,
						ordinal: r.ordinal,
						data: JSON.stringify(r.data),
					})),
				)
				.execute();
		}
		return id;
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
		db,
		pool: () => handle.pool,
		uri: () => handle.uri,
		seedApp,
		seedAppWithBlueprint,
		seedProjectMember,
		seedCreditMonth,
		readConsumed,
		readAppRow,
		readReservation,
		readRunLock,
	};
}
