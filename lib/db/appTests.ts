import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import {
	APP_TEST_EVIDENCE_BYTES,
	AppTestEvidenceInputError,
	type AppTestReadWindow,
	appTestReadWindowSchema,
	evidenceBytes,
	inspectAppTestEvidence,
} from "@/lib/preview/app-tests/evidence";
import { blueprintRevisionDigest } from "@/lib/preview/engine/caseDataBindingClient";
import { AppAccessError, resolveAppScopeInTransaction } from "./appAccess";
import { loadAppInTransaction } from "./apps";
import { type AppDatabase, withAppTx } from "./pg";

const RUNTIME_VERSION = 13;
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

export interface AppTestRequestResult extends AppTestStep {
	results?: AppTestStep[];
	stopped?: { index: number; reason: string };
}

type AdvanceSource = {
	snapshot: JsonRecord;
	state: JsonRecord;
	blueprintSeq: number;
	blueprintDigest: string;
	role: string;
};

export async function advanceAppTestSession(
	args: AppTestScope & {
		testId: string;
		/** May shorten, never extend, the 60-second whole-call database deadline. */
		deadlineAt?: number;
		requestId: string;
		requestDigest: string;
		/** Only pre-batch receipts used authoring-normalized UUIDs in the digest. */
		legacyRequestDigest?: (snapshot: JsonRecord) => Promise<string>;
		expectedStep: number;
		/** Legacy singular callers share this executor and receipt owner. */
		action?: JsonRecord;
		actions?: readonly {
			sessionId?: string;
			action: JsonRecord;
			expect?: JsonRecord;
		}[];
		advance: (
			tx: Transaction<AppDatabase>,
			context: AdvanceSource,
			item: { sessionId?: string; action: JsonRecord; expect?: JsonRecord },
		) => Promise<{
			state: JsonRecord;
			observation: JsonRecord;
			finished?: boolean;
			stopReason?: string;
		}>;
	},
): Promise<AppTestRequestResult> {
	const items =
		args.actions ??
		(args.action ? [{ sessionId: undefined, action: args.action }] : []);
	if (items.length < 1 || items.length > 8 || (args.action && args.actions))
		throw new AppTestUnavailableError(
			"Supply one action or one to eight ordered actions.",
		);
	const deadlineAt = Math.min(
		args.deadlineAt ?? Number.POSITIVE_INFINITY,
		Date.now() + 60_000,
	);
	return withAppTx(
		async (tx) => {
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
			if (!test)
				throw new AppTestUnavailableError(
					"This test is unavailable for this app and account. List this app's recent tests to find its full identity.",
				);
			// Reauthorization precedes replay; source, state and aliases follow it.
			const receipt = await tx
				.selectFrom("app_test_requests")
				.selectAll()
				.where("test_id", "=", test.id)
				.where("request_id", "=", args.requestId)
				.executeTakeFirst();
			if (receipt) {
				if (receipt.request_digest !== args.requestDigest)
					throw new AppTestUnavailableError(
						"This test request was already used with different inputs.",
					);
				return receipt.response as unknown as AppTestRequestResult;
			}
			const legacy = await tx
				.selectFrom("app_test_steps")
				.selectAll()
				.where("test_id", "=", test.id)
				.where("request_id", "=", args.requestId)
				.orderBy("step")
				.executeTakeFirst();
			if (legacy) {
				if (
					legacy.request_digest !== args.requestDigest &&
					legacy.request_digest !==
						(await args.legacyRequestDigest?.(test.snapshot))
				)
					throw new AppTestUnavailableError(
						"This test action was already used with different inputs.",
					);
				return {
					testId: test.id,
					step: legacy.step,
					observation: legacy.observation,
				};
			}
			const finishing = items[0].action.kind === "finish";
			if (!finishing) {
				if (
					test.disposed_at !== null ||
					test.expires_at.getTime() <= Date.now()
				)
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
						"This test reached its 200-step limit. Finish it or start a new test for the next journey.",
					);
			}
			let state = test.state;
			let step = test.step;
			let finished = test.disposed_at !== null;
			const results: AppTestStep[] = [];
			let stopped: AppTestRequestResult["stopped"];
			for (const [index, item] of items.entries()) {
				if (Date.now() >= deadlineAt)
					throw new Error("The app test transaction deadline expired.");
				if (step >= MAX_STEPS && item.action.kind !== "finish") {
					stopped = {
						index,
						reason:
							"This test reached its 200-step limit. Finish it or start a new test for the next journey.",
					};
					break;
				}
				const next =
					item.action.kind === "finish" && item.sessionId === undefined
						? {
								state: {},
								observation: { ended: true },
								finished: true,
								stopReason: undefined,
							}
						: await args.advance(
								tx,
								{
									snapshot: test.snapshot,
									state,
									blueprintSeq: Number(test.blueprint_seq),
									blueprintDigest: test.blueprint_digest,
									role: scope.role,
								},
								item,
							);
				if (next.finished && !finished)
					await sql`SELECT public.nova_drop_app_test_namespace(${test.id}::uuid)`.execute(
						tx,
					);
				if (!finished) {
					step += 1;
					await tx
						.insertInto("app_test_steps")
						.values({
							test_id: test.id,
							step,
							request_id: args.requestId,
							request_digest: args.requestDigest,
							action: JSON.stringify({
								...item.action,
								...(item.sessionId === undefined
									? {}
									: { sessionId: item.sessionId }),
							}),
							observation: JSON.stringify(next.observation),
						})
						.execute();
				}
				finished = next.finished === true;
				state = finished ? {} : next.state;
				results.push({ testId: test.id, step, observation: next.observation });
				if (next.stopReason || finished) {
					if (next.stopReason || index + 1 < items.length)
						stopped = {
							index,
							reason: next.stopReason ?? "The test has finished.",
						};
					break;
				}
			}
			await tx
				.updateTable("app_test_sessions")
				.set({
					step,
					state: JSON.stringify(state),
					...(finished
						? { disposed_at: sql<Date>`COALESCE(disposed_at, now())` }
						: {}),
				})
				.where("id", "=", test.id)
				.execute();
			const last = results.at(-1);
			if (!last)
				throw new Error("An admitted test request produced no observation.");
			const response: AppTestRequestResult = args.actions
				? { ...last, results, ...(stopped ? { stopped } : {}) }
				: last;
			const stored = await tx
				.insertInto("app_test_requests")
				.values({
					test_id: test.id,
					request_id: args.requestId,
					request_digest: args.requestDigest,
					response: JSON.stringify(response),
				})
				.returning("response")
				.executeTakeFirstOrThrow();
			// First delivery and replay use the same persisted JSON projection.
			return stored.response as unknown as AppTestRequestResult;
		},
		{ deadlineAt },
	);
}

/** Evidence is accessible to current app members, even after a test expires.
 * A viewer can inspect another author's test but cannot continue their session. */
export async function readAppTestSteps(
	args: AppTestScope & { testId: string } & AppTestReadWindow,
) {
	const window = appTestReadWindowSchema.parse({
		afterStep: args.afterStep,
		throughStep: args.throughStep,
		limit: args.limit,
		inspect: args.inspect,
	});
	return withAppTx(async (tx) => {
		const access = await authorize(tx, args);
		const test = await tx
			.selectFrom("app_test_sessions")
			.select([
				"id",
				"blueprint_seq",
				"runtime_version",
				"created_by",
				"expires_at",
				"disposed_at",
				"step",
			])
			.where("id", "=", args.testId)
			.where("app_id", "=", args.appId)
			.where("project_id", "=", args.projectId)
			.executeTakeFirst();
		if (!test)
			throw new AppTestUnavailableError(
				"This test is unavailable for this app and account. List this app's recent tests to find its full identity.",
			);
		const throughStep = window.throughStep ?? test.step;
		if (throughStep > test.step)
			throw new AppTestUnavailableError(
				"The requested evidence window is ahead of this test.",
			);
		const initial = await tx
			.selectFrom("app_test_steps")
			.select("observation")
			.where("test_id", "=", test.id)
			.where("step", "=", 0)
			.executeTakeFirstOrThrow();
		const start = Object.fromEntries(
			[
				"purpose",
				"suppliedRecords",
				"lookupRevision",
				"organizationRevision",
				"testPlaces",
				"testAssignments",
				"boundary",
				"primarySessionId",
				"sessions",
				"recordSources",
			]
				.filter((key) => initial.observation[key] !== undefined)
				.map((key) => [key, initial.observation[key]]),
		);
		const provenance =
			evidenceBytes(start) <= 8 * 1024
				? { kind: "complete" as const, value: start }
				: { kind: "inspect" as const, step: 0, path: ["observation"] };
		const base = {
			...test,
			blueprint_seq: Number(test.blueprint_seq),
			currentBlueprintSeq: access.baseSeq,
			expires_at: test.expires_at.toISOString(),
			disposed_at: test.disposed_at?.toISOString() ?? null,
			throughStep,
			provenance,
		};
		type EvidenceStep = {
			step: number;
			action: JsonRecord | null;
			observation: JsonRecord | null;
			created_at: string;
			inspection?: { step: number; path: string[]; bytes: number };
		};
		const steps: EvidenceStep[] = [];
		if (window.inspect) {
			if (window.inspect.step > throughStep)
				throw new AppTestUnavailableError(
					"That step is outside this evidence window.",
				);
			const step = await tx
				.selectFrom("app_test_steps")
				.select(["step", "action", "observation", "created_at"])
				.where("test_id", "=", test.id)
				.where("step", "=", window.inspect.step)
				.executeTakeFirst();
			if (!step)
				throw new AppTestUnavailableError("That recorded step is unavailable.");
			const projection = (() => {
				try {
					return inspectAppTestEvidence(
						{ ...step, created_at: step.created_at.toISOString() },
						window.inspect?.path,
						window.inspect?.offset,
					);
				} catch (error) {
					if (error instanceof AppTestEvidenceInputError)
						throw new AppTestUnavailableError(error.message);
					throw error;
				}
			})();
			const response = {
				...base,
				steps,
				nextCursor: null,
				inspection: { step: step.step, ...projection },
			};
			if (evidenceBytes(response) > APP_TEST_EVIDENCE_BYTES)
				throw new AppTestUnavailableError(
					"This evidence projection is too large. Open one of its fields directly.",
				);
			return response;
		}
		const rows = await tx
			.selectFrom("app_test_steps")
			.select(["step", "action", "observation", "created_at"])
			.where("test_id", "=", test.id)
			.where("step", ">", window.afterStep ?? -1)
			.where("step", "<=", throughStep)
			.orderBy("step")
			.limit(window.limit ?? 10)
			.execute();
		for (const row of rows) {
			const full = { ...row, created_at: row.created_at.toISOString() };
			if (
				evidenceBytes({ ...base, steps: [...steps, full] }) >
				APP_TEST_EVIDENCE_BYTES - 1024
			) {
				if (steps.length) break;
				steps.push({
					step: row.step,
					action: null,
					observation: null,
					created_at: full.created_at,
					inspection: { step: row.step, path: [], bytes: evidenceBytes(full) },
				});
			} else steps.push(full);
		}
		const lastStep = steps.at(-1)?.step;
		return {
			...base,
			steps,
			nextCursor:
				lastStep !== undefined && lastStep < throughStep
					? { afterStep: lastStep, throughStep }
					: null,
			inspection: undefined,
		};
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
		return {
			currentBlueprintSeq: access.baseSeq,
			tests: tests.map((test) => ({
				...test,
				blueprint_seq: Number(test.blueprint_seq),
				created_at: test.created_at.toISOString(),
				expires_at: test.expires_at.toISOString(),
				disposed_at: test.disposed_at?.toISOString() ?? null,
			})),
		};
	});
}
