import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import { blueprintRevisionDigest } from "@/lib/preview/engine/caseDataBindingClient";
import { AppAccessError, resolveAppScopeInTransaction } from "./appAccess";
import { loadAppInTransaction } from "./apps";
import { type AppDatabase, withAppTx } from "./pg";

const RUNTIME_VERSION = 1;
const MAX_STEPS = 200;
const MAX_ACTIVE_TESTS = 8;
type JsonRecord = Record<string, unknown>;

export class AppTestUnavailableError extends Error {}

export interface AppTestScope {
	appId: string;
	actorUserId: string;
	projectId: string;
}

export interface AppTestStep {
	testId: string;
	step: number;
	observation: JsonRecord;
}

/** Reclaim expired namespaces while retaining their observations. App-first
 * authorization precedes this write, and all callers take the same app gate. */
async function disposeExpired(tx: Transaction<AppDatabase>, appId: string) {
	const expired = await tx
		.selectFrom("app_test_sessions")
		.select("id")
		.where("app_id", "=", appId)
		.where("disposed_at", "is", null)
		.where("expires_at", "<=", sql<Date>`now()`)
		.orderBy("id")
		.forUpdate()
		.execute();
	for (const row of expired) {
		await sql`SELECT public.nova_drop_app_test_namespace(${row.id}::uuid)`.execute(
			tx,
		);
		await tx
			.updateTable("app_test_sessions")
			.set({ disposed_at: sql<Date>`now()`, state: "{}" })
			.where("id", "=", row.id)
			.execute();
	}
}

async function authorize(tx: Transaction<AppDatabase>, scope: AppTestScope) {
	const access = await resolveAppScopeInTransaction(
		tx,
		scope.appId,
		scope.actorUserId,
		"view",
	);
	if (access.projectId !== scope.projectId)
		throw new AppAccessError("not_found");
	return access;
}

type StartReceiptScope = AppTestScope & {
	requestId: string;
	requestDigest: string;
};

async function startReceipt(
	tx: Transaction<AppDatabase>,
	args: StartReceiptScope,
): Promise<AppTestStep | undefined> {
	const prior = await tx
		.selectFrom("app_test_sessions")
		.selectAll()
		.where("app_id", "=", args.appId)
		.where("created_by", "=", args.actorUserId)
		.where("request_id", "=", args.requestId)
		.executeTakeFirst();
	if (prior) {
		if (prior.request_digest !== args.requestDigest)
			throw new AppTestUnavailableError(
				"This test request was already used with different inputs.",
			);
		const first = await tx
			.selectFrom("app_test_steps")
			.select("observation")
			.where("test_id", "=", prior.id)
			.where("step", "=", 0)
			.executeTakeFirstOrThrow();
		return { testId: prior.id, step: 0, observation: first.observation };
	}
}

/** Recovery reads the receipt before recapturing external inputs. Membership
 * is rechecked even when the original test has ended or the app has changed. */
export async function readAppTestStartReceipt(args: StartReceiptScope) {
	return withAppTx(async (tx) => {
		await authorize(tx, args);
		return startReceipt(tx, args);
	});
}

export async function createAppTestSession(
	args: AppTestScope & {
		requestId: string;
		requestDigest: string;
		expectedBlueprintSeq: number;
		initialize: (
			tx: Transaction<AppDatabase>,
			context: {
				testId: string;
				blueprint: PersistableDoc;
				blueprintSeq: number;
				role: string;
			},
		) => Promise<{
			snapshot: JsonRecord;
			state: JsonRecord;
			observation: JsonRecord;
		}>;
	},
): Promise<AppTestStep> {
	return withAppTx(async (tx) => {
		const scope = await authorize(tx, args);
		// Admission is serialized per app, including quotas and duplicate starts.
		await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app-tests:${args.appId}`}, 0))`.execute(
			tx,
		);
		await disposeExpired(tx, args.appId);
		const prior = await startReceipt(tx, args);
		if (prior) return prior;
		if (scope.baseSeq !== args.expectedBlueprintSeq)
			throw new AppTestUnavailableError(
				"The app changed. Read its current design before starting a test.",
			);
		const active = await tx
			.selectFrom("app_test_sessions")
			.select(({ fn }) => fn.countAll<string>().as("count"))
			.where("app_id", "=", args.appId)
			.where("disposed_at", "is", null)
			.executeTakeFirstOrThrow();
		if (Number(active.count) >= MAX_ACTIVE_TESTS)
			throw new AppTestUnavailableError(
				"This app has eight active tests. Finish a test before starting another.",
			);
		const app = await loadAppInTransaction(tx, args.appId);
		if (!app) throw new AppAccessError("not_found");
		const testId = randomUUID();
		await sql`SELECT public.nova_create_app_test_namespace(${testId}::uuid)`.execute(
			tx,
		);
		const initial = await args.initialize(tx, {
			testId,
			blueprint: app.blueprint,
			blueprintSeq: scope.baseSeq,
			role: scope.role,
		});
		await tx
			.insertInto("app_test_sessions")
			.values({
				id: testId,
				app_id: args.appId,
				project_id: scope.projectId,
				created_by: args.actorUserId,
				request_id: args.requestId,
				request_digest: args.requestDigest,
				blueprint_seq: scope.baseSeq,
				blueprint_digest: await blueprintRevisionDigest(
					hydratePersistedBlueprint(app.blueprint),
				),
				runtime_version: RUNTIME_VERSION,
				snapshot: JSON.stringify(initial.snapshot),
				state: JSON.stringify(initial.state),
			})
			.execute();
		await tx
			.insertInto("app_test_steps")
			.values({
				test_id: testId,
				step: 0,
				request_id: args.requestId,
				request_digest: args.requestDigest,
				action: JSON.stringify({ kind: "start" }),
				observation: JSON.stringify(initial.observation),
			})
			.execute();
		return { testId, step: 0, observation: initial.observation };
	});
}

export async function advanceAppTestSession(
	args: AppTestScope & {
		testId: string;
		requestId: string;
		requestDigest: string;
		expectedStep: number;
		action: JsonRecord;
		advance: (
			tx: Transaction<AppDatabase>,
			context: {
				snapshot: JsonRecord;
				state: JsonRecord;
				blueprintSeq: number;
				blueprintDigest: string;
				role: string;
			},
		) => Promise<{
			state: JsonRecord;
			observation: JsonRecord;
			finished?: boolean;
		}>;
	},
): Promise<AppTestStep> {
	return withAppTx(async (tx) => {
		const scope = await authorize(tx, args);
		const test = await tx
			.selectFrom("app_test_sessions")
			.selectAll()
			.where("id", "=", args.testId)
			.where("app_id", "=", args.appId)
			.where("project_id", "=", scope.projectId)
			.where("created_by", "=", args.actorUserId)
			.forUpdate()
			.executeTakeFirst();
		if (!test) throw new AppAccessError("not_found");
		const prior = await tx
			.selectFrom("app_test_steps")
			.selectAll()
			.where("test_id", "=", test.id)
			.where("request_id", "=", args.requestId)
			.executeTakeFirst();
		if (prior) {
			if (prior.request_digest !== args.requestDigest)
				throw new AppTestUnavailableError(
					"This test action was already used with different inputs.",
				);
			return {
				testId: test.id,
				step: prior.step,
				observation: prior.observation,
			};
		}
		const finishing = args.action.kind === "finish";
		if (finishing && test.disposed_at !== null)
			return { testId: test.id, step: test.step, observation: { ended: true } };
		if (!finishing) {
			if (test.disposed_at !== null || test.expires_at.getTime() <= Date.now())
				throw new AppTestUnavailableError(
					"This test has ended or expired. Start a new test.",
				);
			if (test.runtime_version !== RUNTIME_VERSION)
				throw new AppTestUnavailableError(
					"Nova's test runtime changed. Start a new test.",
				);
			if (Number(test.blueprint_seq) !== scope.baseSeq)
				throw new AppTestUnavailableError(
					"The app changed since this test began. Start a new test of the saved app.",
				);
			if (test.step !== args.expectedStep)
				throw new AppTestUnavailableError(
					"Another action advanced this test. Read the latest step before continuing.",
				);
			if (test.step >= MAX_STEPS)
				throw new AppTestUnavailableError(
					"This test reached its 200-step limit. Start a new test for the next journey.",
				);
		}
		const next = finishing
			? { state: {}, observation: { ended: true }, finished: true }
			: await args.advance(tx, {
					snapshot: test.snapshot,
					state: test.state,
					blueprintSeq: scope.baseSeq,
					blueprintDigest: test.blueprint_digest,
					role: scope.role,
				});
		if (next.finished)
			await sql`SELECT public.nova_drop_app_test_namespace(${test.id}::uuid)`.execute(
				tx,
			);
		const step = test.step + 1;
		await tx
			.updateTable("app_test_sessions")
			.set({
				step,
				state: JSON.stringify(next.finished ? {} : next.state),
				...(next.finished ? { disposed_at: sql<Date>`now()` } : {}),
			})
			.where("id", "=", test.id)
			.execute();
		await tx
			.insertInto("app_test_steps")
			.values({
				test_id: test.id,
				step,
				request_id: args.requestId,
				request_digest: args.requestDigest,
				action: JSON.stringify(args.action),
				observation: JSON.stringify(next.observation),
			})
			.execute();
		return { testId: test.id, step, observation: next.observation };
	});
}

/** Evidence is accessible to current app members, even after a test expires.
 * A viewer can inspect another author's test but cannot continue their session. */
export async function readAppTestSteps(
	args: AppTestScope & { testId: string },
) {
	return withAppTx(async (tx) => {
		const access = await authorize(tx, args);
		const test = await tx
			.selectFrom("app_test_sessions")
			.select([
				"id",
				"blueprint_seq",
				"created_by",
				"expires_at",
				"disposed_at",
				"step",
			])
			.where("id", "=", args.testId)
			.where("app_id", "=", args.appId)
			.where("project_id", "=", args.projectId)
			.executeTakeFirst();
		if (!test) throw new AppAccessError("not_found");
		const steps = await tx
			.selectFrom("app_test_steps")
			.select(["step", "action", "observation", "created_at"])
			.where("test_id", "=", test.id)
			.orderBy("step")
			.execute();
		return { ...test, currentBlueprintSeq: access.baseSeq, steps };
	});
}

export async function listAppTests(scope: AppTestScope) {
	return withAppTx(async (tx) => {
		const access = await authorize(tx, scope);
		const tests = await tx
			.selectFrom("app_test_sessions")
			.select([
				"id",
				"blueprint_seq",
				"created_at",
				"expires_at",
				"disposed_at",
				"step",
				sql<string>`snapshot->>'purpose'`.as("purpose"),
			])
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.orderBy("created_at", "desc")
			.limit(30)
			.execute();
		return { currentBlueprintSeq: access.baseSeq, tests };
	});
}
