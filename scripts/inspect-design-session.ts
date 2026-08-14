/**
 * Start-here inspector for one reviewed-design run.
 *
 * The argument may be a design-session, proposed/materialized app, thread,
 * run, revision, review, plan, workspace, slice-attempt, change-set,
 * orchestration-event, or model-context id. The script resolves that id to
 * its owning design session and correlates the ledgers that otherwise require
 * several commands and hand-written SQL.
 *
 * Default output is payload-safe. Explicit detail flags expose customer
 * content from the event log, model contexts, or retained stream chunks.
 * Every path is read-only.
 *
 * Usage:
 *   npx tsx --conditions=react-server scripts/inspect-design-session.ts <id>
 */
import "dotenv/config";
import { Command, InvalidArgumentError } from "commander";
import { sql } from "kysely";
import {
	BLOCKER_RESOLUTION_ALLOWANCE,
	budgetForSlice,
} from "@/lib/agent/build/budgets";
import {
	buildOrchestratorStateSchema,
	readOrchestrationHead,
} from "@/lib/agent/build/orchestratorState";
import {
	readDesignBuildPlan,
	readDesignReviewsForRevisions,
	readDesignRevisionsForSession,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import { findingBlocksAcceptance } from "@/lib/agent/design/review";
import { rehydrateModelMessage } from "@/lib/agent/modelMessagePersistence";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadDesignSession } from "@/lib/db/designSessions";
import { getAppDb } from "@/lib/db/pg";
import { readEvents } from "@/lib/log/reader";
import type { Event } from "@/lib/log/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { designCompositionSummary } from "./lib/designCompositionSummary";
import {
	collectRunIds,
	designSessionSnapshotFingerprint,
	selectDesignSessionResolution,
	summarizeDesignEvent,
	summarizeModelMessage,
} from "./lib/designSessionInspection";
import {
	duration,
	printHeader,
	printKV,
	printSection,
	printTable,
	tok,
	truncate,
	tsToISO,
	usd,
} from "./lib/format";
import { requireArg, runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface InspectOptions {
	readonly prod?: boolean;
	readonly watch?: boolean;
	readonly interval: number;
	readonly untilTerminal?: boolean;
	readonly events?: boolean;
	readonly transcript?: boolean;
	readonly contexts?: boolean;
	readonly contextContent?: boolean;
	readonly stream?: boolean;
	readonly json?: boolean;
	readonly full?: boolean;
}

function parsePositiveSeconds(raw: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new InvalidArgumentError(
			`expected a positive number of seconds, got "${raw}"`,
		);
	}
	return value;
}

const program = new Command();
program
	.name("inspect-design-session")
	.description(
		"Resolve any reviewed-design id and correlate lifecycle, artifacts, slices, contexts, streams, events, and usage.",
	)
	.argument(
		"<id>",
		"design session, app, thread, run, artifact, workspace, attempt, change-set, event, or context id",
	)
	.option("--prod", "inspect production Cloud SQL")
	.option(
		"--watch",
		"poll and print a new compact snapshot only when state changes",
	)
	.option(
		"--interval <seconds>",
		"watch polling interval",
		parsePositiveSeconds,
		2,
	)
	.option(
		"--until-terminal",
		"with --watch, exit after the session is terminal and no stream is active",
	)
	.option("--events", "show one-line events for every related run")
	.option(
		"--transcript",
		"show full event payloads (implies --events; may expose customer content)",
	)
	.option("--contexts", "show every persisted model-context item, payload-safe")
	.option(
		"--context-content",
		"show full persisted model messages (implies --contexts; exposes customer content)",
	)
	.option(
		"--stream",
		"show retained resumable-stream chunk batches (exposes customer content)",
	)
	.option("--json", "emit the collected snapshot as JSON")
	.option(
		"--full",
		"enable events, transcript, contexts, context content, and stream detail",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx --conditions=react-server scripts/inspect-design-session.ts <session-or-run-id>\n" +
			"  $ npx tsx --conditions=react-server scripts/inspect-design-session.ts <id> --watch --until-terminal\n" +
			"  $ npx tsx --conditions=react-server scripts/inspect-design-session.ts <id> --events\n" +
			"  $ npx tsx --conditions=react-server scripts/inspect-design-session.ts <id> --contexts --context-content\n" +
			"  $ npx tsx --conditions=react-server scripts/inspect-design-session.ts <id> --full --json\n\n" +
			"Watch mode is compact by design; detail flags are rejected while polling.\n",
	);
program.parse();

const identifier = requireArg(program.args, 0, "id");
const options = program.opts<InspectOptions>();
if (options.prod === true) targetProdDb();

type SessionRow = NonNullable<Awaited<ReturnType<typeof loadDesignSession>>>;

interface ResolutionResult {
	readonly input: string;
	readonly reason: string;
	readonly alternatives: readonly {
		readonly sessionId: string;
		readonly reason: string;
		readonly updatedAt: string;
	}[];
	readonly session: SessionRow;
}

async function resolveDesignSession(id: string): Promise<ResolutionResult> {
	const db = await getAppDb();
	const [
		sessions,
		threads,
		summaries,
		revisions,
		reviews,
		plans,
		workspaces,
		attempts,
		changeSets,
		events,
		contexts,
	] = await Promise.all([
		db
			.selectFrom("design_sessions")
			.select(["id", "updated_at"])
			.where((eb) =>
				eb.or([
					eb("id", "=", id),
					eb("proposed_app_id", "=", id),
					eb("app_id", "=", id),
					eb("run_id", "=", id),
				]),
			)
			.execute(),
		db
			.selectFrom("threads")
			.select("design_session_id")
			.where("design_session_id", "is not", null)
			.where((eb) =>
				eb.or([
					eb("thread_id", "=", id),
					eb("run_id", "=", id),
					eb("app_id", "=", id),
				]),
			)
			.execute(),
		db
			.selectFrom("run_summaries")
			.select("design_session_id")
			.where("design_session_id", "is not", null)
			.where("run_id", "=", id)
			.execute(),
		db
			.selectFrom("design_revisions")
			.select("design_session_id")
			.where("id", "=", id)
			.execute(),
		db
			.selectFrom("design_reviews")
			.select("design_session_id")
			.where("id", "=", id)
			.execute(),
		db
			.selectFrom("design_build_plans")
			.select("design_session_id")
			.where("id", "=", id)
			.execute(),
		db
			.selectFrom("design_artifact_workspaces")
			.select("design_session_id")
			.where("id", "=", id)
			.execute(),
		db
			.selectFrom("design_slice_attempts")
			.select("design_session_id")
			.where((eb) => eb.or([eb("id", "=", id), eb("build_plan_id", "=", id)]))
			.execute(),
		db
			.selectFrom("design_change_sets")
			.select("design_session_id")
			.where((eb) => eb.or([eb("id", "=", id), eb("attempt_id", "=", id)]))
			.execute(),
		db
			.selectFrom("design_orchestration_events")
			.select("design_session_id")
			.where((eb) => eb.or([eb("event_id", "=", id), eb("run_id", "=", id)]))
			.execute(),
		db
			.selectFrom("design_model_contexts")
			.select("design_session_id")
			.where("id", "=", id)
			.execute(),
	]);

	const directReason = sessions.map((row) => ({
		sessionId: row.id,
		reason:
			row.id === id ? "design session id" : "session app or active run id",
	}));
	const refs = [
		...directReason,
		...threads.flatMap((row) =>
			row.design_session_id === null
				? []
				: [
						{
							sessionId: row.design_session_id,
							reason: "thread id or run id",
						},
					],
		),
		...summaries.flatMap((row) =>
			row.design_session_id === null
				? []
				: [
						{
							sessionId: row.design_session_id,
							reason: "run summary id",
						},
					],
		),
		...revisions.map((row) => ({
			sessionId: row.design_session_id,
			reason: "design revision id",
		})),
		...reviews.map((row) => ({
			sessionId: row.design_session_id,
			reason: "design review id",
		})),
		...plans.map((row) => ({
			sessionId: row.design_session_id,
			reason: "build plan id",
		})),
		...workspaces.map((row) => ({
			sessionId: row.design_session_id,
			reason: "artifact workspace id",
		})),
		...attempts.map((row) => ({
			sessionId: row.design_session_id,
			reason: "slice attempt or build plan id",
		})),
		...changeSets.map((row) => ({
			sessionId: row.design_session_id,
			reason: "change-set or attempt id",
		})),
		...events.map((row) => ({
			sessionId: row.design_session_id,
			reason: "orchestration event or run id",
		})),
		...contexts.map((row) => ({
			sessionId: row.design_session_id,
			reason: "model context id",
		})),
	];
	const sessionIds = [...new Set(refs.map((ref) => ref.sessionId))];
	if (sessionIds.length === 0) {
		throw new Error(
			`No design session is related to ${id}. ${options.prod === true ? "Searched production; drop --prod for local data." : "Searched local dev; add --prod for production data."}`,
		);
	}
	const metadata = await db
		.selectFrom("design_sessions")
		.select(["id", "updated_at"])
		.where("id", "in", sessionIds)
		.execute();
	const metadataById = new Map(metadata.map((row) => [row.id, row]));
	const reasonById = new Map(refs.map((ref) => [ref.sessionId, ref.reason]));
	const resolution = selectDesignSessionResolution(
		sessionIds.flatMap((sessionId) => {
			const row = metadataById.get(sessionId);
			return row === undefined
				? []
				: [
						{
							sessionId,
							reason: reasonById.get(sessionId) ?? "related id",
							updatedAt: row.updated_at,
						},
					];
		}),
	);
	if (resolution === null)
		throw new Error(`Related design session for ${id} no longer exists.`);
	const session = await loadDesignSession(resolution.selected.sessionId);
	if (session === null)
		throw new Error(
			`Design session ${resolution.selected.sessionId} disappeared during inspection.`,
		);
	return {
		input: id,
		reason: resolution.selected.reason,
		alternatives: resolution.alternatives.map((match) => ({
			sessionId: match.sessionId,
			reason: match.reason,
			updatedAt: tsToISO(match.updatedAt),
		})),
		session,
	};
}

interface EventDetail {
	readonly runId: string;
	readonly events: readonly Event[];
}

interface ContextItemDetail {
	readonly contextId: string;
	readonly ordinal: number;
	readonly appendKey: string;
	readonly digestValid: boolean;
	readonly createdByRunId: string;
	readonly createdAt: string;
	readonly summary: string;
	readonly message?: unknown;
}

interface StreamDetail {
	readonly streamId: string;
	readonly firstIndex: number;
	readonly runId: string;
	readonly terminal: boolean;
	readonly terminalOutcome: string | null;
	readonly createdAt: string;
	readonly chunks: readonly Record<string, unknown>[];
}

async function collectSnapshot(resolution: ResolutionResult) {
	const db = await getAppDb();
	const sessionId = resolution.session.id;
	const [
		threads,
		orchestrationRows,
		orchestrationHead,
		workspaces,
		workspaceSteps,
		sourcePackages,
		revisions,
		attemptRows,
		contexts,
		contextStats,
		modelSteps,
		runSummaries,
		streamStats,
	] = await Promise.all([
		db
			.selectFrom("threads")
			.select([
				"thread_id",
				"thread_type",
				"summary",
				"run_id",
				"active_stream_id",
				"created_at",
				"updated_at",
			])
			.select(sql<number>`jsonb_array_length(messages)`.as("message_count"))
			.where("design_session_id", "=", sessionId)
			.orderBy("updated_at", "asc")
			.execute(),
		db
			.selectFrom("design_orchestration_events")
			.select([
				"revision",
				"event_id",
				"run_id",
				"kind",
				"payload",
				"created_at",
			])
			.where("design_session_id", "=", sessionId)
			.orderBy("revision", "asc")
			.execute(),
		readOrchestrationHead(sessionId),
		db
			.selectFrom("design_artifact_workspaces")
			.selectAll()
			.where("design_session_id", "=", sessionId)
			.orderBy("created_at", "asc")
			.execute(),
		db
			.selectFrom("design_artifact_workspace_steps as step")
			.innerJoin(
				"design_artifact_workspaces as workspace",
				"workspace.id",
				"step.workspace_id",
			)
			.select([
				"step.workspace_id",
				"step.revision",
				"step.created_by_run_id",
				"step.created_at",
			])
			.select(
				sql<string>`${sql.ref("step.operation")}::text`.as("operation_text"),
			)
			.where("workspace.design_session_id", "=", sessionId)
			.orderBy("step.workspace_id")
			.orderBy("step.revision")
			.execute(),
		db
			.selectFrom("design_source_packages")
			.select(["id", "package_digest", "created_by_run_id", "created_at"])
			.where("design_session_id", "=", sessionId)
			.orderBy("created_at", "asc")
			.execute(),
		readDesignRevisionsForSession(sessionId),
		db
			.selectFrom("design_slice_attempts as attempt")
			.leftJoin(
				"design_change_sets as change_set",
				"change_set.id",
				"attempt.change_set_id",
			)
			.select([
				"attempt.id",
				"attempt.build_plan_id",
				"attempt.slice_id",
				"attempt.attempt",
				"attempt.status",
				"attempt.failure_code",
				"attempt.change_set_id",
				"attempt.executor_model",
				"attempt.model_steps_used",
				"attempt.staged_requests_used",
				"attempt.commit_attempts_used",
				"attempt.blocker_reports_used",
				"attempt.validation_requested",
				"attempt.finalization_eligible",
				"attempt.execution_run_ids",
				"attempt.wire_invalid_count",
				"attempt.stage_rejected_count",
				"attempt.validator_repair_count",
				"attempt.outcome_evidence_state",
				"attempt.wall_clock_ms_used",
				"attempt.created_at",
				"attempt.updated_at",
				"change_set.status as change_set_status",
				"change_set.revision as change_set_revision",
				"change_set.owner_run_id as change_set_run_id",
				"change_set.finalization_model_step",
				"change_set.committed_seq",
			])
			.where("attempt.design_session_id", "=", sessionId)
			.orderBy("attempt.created_at", "asc")
			.execute(),
		db
			.selectFrom("design_model_contexts")
			.selectAll()
			.where("design_session_id", "=", sessionId)
			.orderBy("context_kind")
			.orderBy("generation")
			.execute(),
		db
			.selectFrom("design_model_context_items as item")
			.innerJoin(
				"design_model_contexts as context",
				"context.id",
				"item.context_id",
			)
			.select("item.context_id")
			.select(({ fn }) => fn.countAll<string>().as("item_count"))
			.select(
				sql<string>`coalesce(sum(octet_length(${sql.ref("item.message")}::text)), 0)`.as(
					"message_bytes",
				),
			)
			.select(
				sql<string>`coalesce(max(${sql.ref("item.ordinal")}), 0)`.as(
					"max_ordinal",
				),
			)
			.select(
				sql<string>`count(distinct case
					when ${sql.ref("item.append_key")} like 'compaction-state:%'
						then split_part(${sql.ref("item.append_key")}, ':', 2)
					when ${sql.ref("item.append_key")} like 'compaction-reseed:%'
						then split_part(${sql.ref("item.append_key")}, ':', 3)
					else null
				end)`.as("compaction_count"),
			)
			.select(
				sql<string>`count(*) filter (where ${sql.ref("item.append_key")} like 'compaction-state:%' or ${sql.ref("item.append_key")} like 'compaction-reseed:%')`.as(
					"checkpoint_count",
				),
			)
			.where("context.design_session_id", "=", sessionId)
			.groupBy("item.context_id")
			.execute(),
		db
			.selectFrom("design_model_steps as step")
			.innerJoin(
				"design_model_contexts as context",
				"context.id",
				"step.context_id",
			)
			.select([
				"step.context_id",
				"step.step_key",
				"step.event_kind",
				"step.created_by_run_id",
				"step.created_at",
			])
			.where("context.design_session_id", "=", sessionId)
			.orderBy("step.created_at", "asc")
			.execute(),
		db
			.selectFrom("run_summaries")
			.selectAll()
			.where("design_session_id", "=", sessionId)
			.orderBy("started_at", "asc")
			.execute(),
		db
			.selectFrom("chat_stream_chunks")
			.select(["stream_id", "run_id"])
			.select(({ fn }) => fn.countAll<string>().as("batch_count"))
			.select(sql<string>`sum(jsonb_array_length(chunks))`.as("chunk_count"))
			.select(sql<boolean>`bool_or(terminal)`.as("terminal"))
			.select(sql<string | null>`max(terminal_outcome)`.as("terminal_outcome"))
			.select(sql<Date>`max(created_at)`.as("last_created_at"))
			.where("design_session_id", "=", sessionId)
			.groupBy(["stream_id", "run_id"])
			.orderBy("last_created_at", "asc")
			.execute(),
	]);

	const acceptedRevision =
		revisions.find(
			(revision) =>
				revision.id === resolution.session.active_design_revision_id,
		) ??
		[...revisions]
			.reverse()
			.find((revision) => revision.lifecycle === "accepted") ??
		null;
	const reviewsByRevision = await readDesignReviewsForRevisions(
		revisions.map((revision) => revision.id),
	);
	const plan =
		resolution.session.active_build_plan_id === null
			? acceptedRevision === null
				? null
				: await readLatestDesignBuildPlanForRevision(acceptedRevision.id)
			: await readDesignBuildPlan(resolution.session.active_build_plan_id);

	const changeSetIds = attemptRows.flatMap((attempt) =>
		attempt.change_set_id === null ? [] : [attempt.change_set_id],
	);
	const [requests, admittedSteps, committedSlices] = await Promise.all([
		changeSetIds.length === 0
			? Promise.resolve([])
			: db
					.selectFrom("design_change_set_requests")
					.select([
						"change_set_id",
						"request_id",
						"tool_name",
						"status",
						"rejection_code",
						"created_at",
					])
					.where("change_set_id", "in", changeSetIds)
					.orderBy("created_at", "asc")
					.execute(),
		changeSetIds.length === 0
			? Promise.resolve([])
			: db
					.selectFrom("design_change_set_steps")
					.select(["change_set_id", "ordinal", "tool_name", "created_at"])
					.where("change_set_id", "in", changeSetIds)
					.orderBy("created_at", "asc")
					.execute(),
		db
			.selectFrom("design_committed_slices")
			.select([
				"slice_id",
				"slice_attempt_id",
				"change_set_id",
				"seq",
				"mutation_count",
				"committed_at",
			])
			.where("design_session_id", "=", sessionId)
			.orderBy("committed_at", "asc")
			.execute(),
	]);

	const contextStatById = new Map(
		contextStats.map((row) => [row.context_id, row]),
	);
	const modelStepsByContext = new Map<string, typeof modelSteps>();
	for (const step of modelSteps) {
		const rows = modelStepsByContext.get(step.context_id) ?? [];
		rows.push(step);
		modelStepsByContext.set(step.context_id, rows);
	}
	const workspaceStepsById = new Map<string, typeof workspaceSteps>();
	for (const step of workspaceSteps) {
		const rows = workspaceStepsById.get(step.workspace_id) ?? [];
		rows.push(step);
		workspaceStepsById.set(step.workspace_id, rows);
	}
	const requestsByChangeSet = new Map<string, typeof requests>();
	for (const request of requests) {
		const rows = requestsByChangeSet.get(request.change_set_id) ?? [];
		rows.push(request);
		requestsByChangeSet.set(request.change_set_id, rows);
	}
	const admittedByChangeSet = new Map<string, typeof admittedSteps>();
	for (const step of admittedSteps) {
		const rows = admittedByChangeSet.get(step.change_set_id) ?? [];
		rows.push(step);
		admittedByChangeSet.set(step.change_set_id, rows);
	}
	const receiptByAttempt = new Map(
		committedSlices.map((row) => [row.slice_attempt_id, row]),
	);
	const sliceById = new Map<
		string,
		NonNullable<typeof plan>["envelope"]["payload"]["slices"][number]
	>(plan?.envelope.payload.slices.map((slice) => [slice.id, slice]) ?? []);

	const artifactRunIds = collectRunIds(
		workspaces.flatMap((workspace) => [
			workspace.created_by_run_id,
			workspace.updated_by_run_id,
		]),
		workspaceSteps.map((step) => step.created_by_run_id),
		sourcePackages.map((source) => source.created_by_run_id),
		revisions.map((revision) => revision.createdByRunId),
		[...reviewsByRevision.values()]
			.flat()
			.map((review) => review.createdByRunId),
	);
	const runIds = collectRunIds(
		[resolution.session.run_id],
		threads.map((thread) => thread.run_id),
		orchestrationRows.map((event) => event.run_id),
		artifactRunIds,
		attemptRows.flatMap((attempt) => [
			...attempt.execution_run_ids,
			attempt.change_set_run_id,
		]),
		modelSteps.map((step) => step.created_by_run_id),
		runSummaries.map((summary) => summary.run_id),
		streamStats.map((stream) => stream.run_id),
	);
	const eventAppId =
		resolution.session.app_id ?? resolution.session.proposed_app_id;
	const eventCounts =
		eventAppId === null || runIds.length === 0
			? []
			: await db
					.selectFrom("events")
					.select("run_id")
					.select(({ fn }) => fn.countAll<string>().as("event_count"))
					.select(sql<string>`max(ts)`.as("last_ts"))
					.select(
						sql<string>`count(*) filter (where event->>'kind' = 'conversation' and event#>>'{payload,type}' = 'error')`.as(
							"error_count",
						),
					)
					.select(
						sql<string>`count(*) filter (where event->>'kind' = 'conversation' and event#>>'{payload,type}' in ('design-tool-outcome', 'executor-tool-outcome') and event#>>'{payload,outcome}' not in ('accepted', 'committed'))`.as(
							"nonaccepted_outcome_count",
						),
					)
					.where("app_id", "=", eventAppId)
					.where("run_id", "in", runIds)
					.groupBy("run_id")
					.execute();

	const orchestration = orchestrationRows.map((row) => ({
		revision: safePersistedSequence(
			row.revision,
			`orchestration revision ${row.event_id}`,
		),
		eventId: row.event_id,
		runId: row.run_id,
		kind: row.kind,
		state: buildOrchestratorStateSchema.parse(row.payload),
		createdAt: tsToISO(row.created_at),
	}));
	const snapshot = {
		lookup: {
			input: resolution.input,
			resolvedBy: resolution.reason,
			alternatives: resolution.alternatives,
		},
		session: {
			id: resolution.session.id,
			mode: resolution.session.mode,
			state: resolution.session.state,
			projectId: resolution.session.project_id,
			proposedAppId: resolution.session.proposed_app_id,
			appId: resolution.session.app_id,
			awaitingInput: resolution.session.awaiting_input,
			activeRunId: resolution.session.run_id,
			leaseExpiresAt: tsToISO(resolution.session.run_lease_expires_at),
			lastErrorType: resolution.session.last_error_type,
			activeDesignRevisionId: resolution.session.active_design_revision_id,
			activeBuildPlanId: resolution.session.active_build_plan_id,
			createdAt: tsToISO(resolution.session.created_at),
			updatedAt: tsToISO(resolution.session.updated_at),
		},
		threads: threads.map((thread) => ({
			threadId: thread.thread_id,
			type: thread.thread_type,
			summary: thread.summary,
			runId: thread.run_id,
			activeStreamId: thread.active_stream_id,
			messageCount: Number(thread.message_count),
			createdAt: thread.created_at,
			updatedAt: thread.updated_at,
		})),
		streams: streamStats.map((stream) => ({
			streamId: stream.stream_id,
			runId: stream.run_id,
			batches: Number(stream.batch_count),
			chunks: Number(stream.chunk_count),
			terminal: stream.terminal,
			terminalOutcome: stream.terminal_outcome,
			lastCreatedAt: tsToISO(stream.last_created_at),
		})),
		orchestration: {
			head:
				orchestrationHead === null
					? null
					: {
							revision: orchestrationHead.revision,
							eventId: orchestrationHead.eventId,
							kind: orchestrationHead.state.kind,
							state: orchestrationHead.state,
						},
			timeline: orchestration,
		},
		workspaces: workspaces.map((workspace) => {
			const steps = workspaceStepsById.get(workspace.id) ?? [];
			const last = steps.at(-1);
			return {
				id: workspace.id,
				kind: workspace.artifact_kind,
				status: workspace.status,
				revision: Number(workspace.revision),
				stepCount: steps.length,
				lastOperation:
					last === undefined ? null : JSON.parse(last.operation_text),
				updatedByRunId: workspace.updated_by_run_id,
				updatedAt: tsToISO(workspace.updated_at),
			};
		}),
		artifacts: {
			sourcePackages: sourcePackages.map((source) => ({
				id: source.id,
				digest: source.package_digest,
				createdByRunId: source.created_by_run_id,
				createdAt: tsToISO(source.created_at),
			})),
			revisions: revisions.map((revision) => {
				const reviews = reviewsByRevision.get(revision.id) ?? [];
				return {
					id: revision.id,
					revision: revision.revision,
					lifecycle: revision.lifecycle,
					createdByRunId: revision.createdByRunId,
					createdAt: tsToISO(revision.createdAt),
					workflowCount: revision.envelope.payload.workflows.length,
					composition: designCompositionSummary(revision.envelope.payload),
					reviews: reviews.map((review) => ({
						id: review.id,
						ordinal: review.reviewOrdinal,
						findingCount: review.envelope.payload.findings.length,
						blockingCount: review.envelope.payload.findings.filter(
							findingBlocksAcceptance,
						).length,
						createdByRunId: review.createdByRunId,
						createdAt: tsToISO(review.createdAt),
					})),
				};
			}),
			plan:
				plan === null
					? null
					: {
							id: plan.id,
							designRevisionId: plan.designRevisionId,
							createdAt: tsToISO(plan.createdAt),
							slices: plan.envelope.payload.slices.map((slice) => ({
								id: slice.id,
								name: slice.name,
								role: slice.role,
								risk: slice.risk,
								constructionGroups: slice.constructionGroups.length,
								budget: budgetForSlice(slice),
							})),
						},
		},
		attempts: attemptRows.map((attempt) => {
			const changeSetRequests =
				attempt.change_set_id === null
					? []
					: (requestsByChangeSet.get(attempt.change_set_id) ?? []);
			const staged =
				attempt.change_set_id === null
					? []
					: (admittedByChangeSet.get(attempt.change_set_id) ?? []);
			const lastRequest = changeSetRequests.at(-1);
			const receipt = receiptByAttempt.get(attempt.id);
			const slice = sliceById.get(attempt.slice_id);
			const baseBudget = slice === undefined ? null : budgetForSlice(slice);
			return {
				id: attempt.id,
				planId: attempt.build_plan_id,
				sliceId: attempt.slice_id,
				sliceName: slice?.name ?? "(unknown slice)",
				attempt: attempt.attempt,
				status: attempt.status,
				failureCode: attempt.failure_code,
				executorModel: attempt.executor_model,
				budget:
					baseBudget === null
						? null
						: {
								...baseBudget,
								effectiveMaxModelSteps:
									baseBudget.maxModelSteps +
									attempt.blocker_reports_used *
										BLOCKER_RESOLUTION_ALLOWANCE.modelSteps,
								effectiveMaxStagedRequests:
									baseBudget.maxStagedRequests +
									attempt.blocker_reports_used *
										BLOCKER_RESOLUTION_ALLOWANCE.stagedRequests,
								effectiveMaxWallClockMs:
									baseBudget.maxWallClockMs +
									attempt.blocker_reports_used *
										BLOCKER_RESOLUTION_ALLOWANCE.ms,
							},
				spent: {
					modelSteps: attempt.model_steps_used,
					stagedRequests: attempt.staged_requests_used,
					commitAttempts: attempt.commit_attempts_used,
					blockerReports: attempt.blocker_reports_used,
					wallClockMs: Number(attempt.wall_clock_ms_used),
				},
				outcomes: {
					wireInvalid: attempt.wire_invalid_count,
					stageRejected: attempt.stage_rejected_count,
					validatorRepair: attempt.validator_repair_count,
					evidence: attempt.outcome_evidence_state,
				},
				validationRequested: attempt.validation_requested,
				finalizationEligible: attempt.finalization_eligible,
				executionRunIds: attempt.execution_run_ids,
				changeSet:
					attempt.change_set_id === null
						? null
						: {
								id: attempt.change_set_id,
								status: attempt.change_set_status,
								revision:
									attempt.change_set_revision === null
										? null
										: Number(attempt.change_set_revision),
								ownerRunId: attempt.change_set_run_id,
								finalizationModelStep: attempt.finalization_model_step,
								committedSeq:
									attempt.committed_seq === null
										? null
										: Number(attempt.committed_seq),
								requestCount: changeSetRequests.length,
								admittedStepCount: staged.length,
								lastRequest:
									lastRequest === undefined
										? null
										: {
												tool: lastRequest.tool_name,
												status: lastRequest.status,
												rejectionCode: lastRequest.rejection_code,
											},
							},
				commit:
					receipt === undefined
						? null
						: {
								seq: Number(receipt.seq),
								mutationCount: receipt.mutation_count,
								committedAt: tsToISO(receipt.committed_at),
							},
				createdAt: tsToISO(attempt.created_at),
				updatedAt: tsToISO(attempt.updated_at),
			};
		}),
		contexts: contexts.map((context) => {
			const stats = contextStatById.get(context.id);
			const steps = modelStepsByContext.get(context.id) ?? [];
			const started = steps.filter((step) => step.event_kind === "started");
			const completed = new Set(
				steps
					.filter((step) => step.event_kind === "completed")
					.map((step) => step.step_key),
			);
			return {
				id: context.id,
				kind: context.context_kind,
				generation: context.generation,
				supersedesContextId: context.supersedes_context_id,
				modelId: context.model_id,
				promptVersion: context.prompt_version,
				contextVersion: context.context_version,
				revision: Number(context.revision),
				itemCount: Number(stats?.item_count ?? 0),
				messageBytes: Number(stats?.message_bytes ?? 0),
				maxOrdinal: Number(stats?.max_ordinal ?? 0),
				compactionCount: Number(stats?.compaction_count ?? 0),
				checkpointCount: Number(stats?.checkpoint_count ?? 0),
				startedSteps: started.length,
				completedSteps: completed.size,
				openStepKeys: started
					.map((step) => step.step_key)
					.filter((key) => !completed.has(key)),
				createdAt: tsToISO(context.created_at),
				updatedAt: tsToISO(context.updated_at),
			};
		}),
		usage: runSummaries.map((summary) => ({
			runId: summary.run_id,
			model: summary.model,
			promptMode: summary.prompt_mode,
			steps: summary.step_count,
			tools: summary.tool_call_count,
			inputTokens: Number(summary.input_tokens),
			outputTokens: Number(summary.output_tokens),
			cacheReadTokens: Number(summary.cache_read_tokens),
			cacheWriteTokens: Number(summary.cache_write_tokens),
			costEstimate: summary.cost_estimate,
			startedAt: summary.started_at,
			finishedAt: summary.finished_at,
		})),
		eventCoverage: runIds.map((runId) => {
			const row = eventCounts.find((candidate) => candidate.run_id === runId);
			return {
				runId,
				eventCount: Number(row?.event_count ?? 0),
				errorCount: Number(row?.error_count ?? 0),
				nonacceptedOutcomeCount: Number(row?.nonaccepted_outcome_count ?? 0),
				lastEventAt:
					row === undefined
						? null
						: new Date(Number(row.last_ts)).toISOString(),
				hasSummary: runSummaries.some((summary) => summary.run_id === runId),
			};
		}),
	};

	const wantsEvents =
		options.full === true ||
		options.events === true ||
		options.transcript === true;
	const wantsContexts =
		options.full === true ||
		options.contexts === true ||
		options.contextContent === true;
	const wantsContextContent =
		options.full === true || options.contextContent === true;
	const wantsStream = options.full === true || options.stream === true;
	const [eventDetails, contextItems, streamDetails] = await Promise.all([
		!wantsEvents || eventAppId === null
			? Promise.resolve([] as EventDetail[])
			: Promise.all(
					runIds.map(async (runId) => ({
						runId,
						events: await readEvents(eventAppId, runId),
					})),
				),
		!wantsContexts
			? Promise.resolve([] as ContextItemDetail[])
			: db
					.selectFrom("design_model_context_items as item")
					.innerJoin(
						"design_model_contexts as context",
						"context.id",
						"item.context_id",
					)
					.select([
						"item.context_id",
						"item.ordinal",
						"item.append_key",
						"item.item_digest",
						"item.message",
						"item.created_by_run_id",
						"item.created_at",
					])
					.where("context.design_session_id", "=", sessionId)
					.orderBy("context.generation")
					.orderBy("item.ordinal")
					.execute()
					.then((rows) =>
						rows.map((row) => {
							const message = rehydrateModelMessage(row.message);
							return {
								contextId: row.context_id,
								ordinal: Number(row.ordinal),
								appendKey: row.append_key,
								digestValid:
									canonicalJsonDigest(row.message) === row.item_digest,
								createdByRunId: row.created_by_run_id,
								createdAt: tsToISO(row.created_at),
								summary: summarizeModelMessage(message),
								...(wantsContextContent ? { message } : {}),
							};
						}),
					),
		!wantsStream
			? Promise.resolve([] as StreamDetail[])
			: db
					.selectFrom("chat_stream_chunks")
					.selectAll()
					.where("design_session_id", "=", sessionId)
					.orderBy("created_at")
					.orderBy("first_index")
					.execute()
					.then((rows) =>
						rows.map((row) => ({
							streamId: row.stream_id,
							firstIndex: row.first_index,
							runId: row.run_id,
							terminal: row.terminal,
							terminalOutcome: row.terminal_outcome,
							createdAt: tsToISO(row.created_at),
							chunks: row.chunks,
						})),
					),
	]);
	return { snapshot, eventDetails, contextItems, streamDetails };
}

type Collected = Awaited<ReturnType<typeof collectSnapshot>>;

function shortId(id: string | null): string {
	return id === null ? "—" : id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

function renderSnapshot(collected: Collected): void {
	const { snapshot } = collected;
	printHeader(`Reviewed design session ${snapshot.session.id}`);
	printKV([
		[
			"Resolved from",
			`${snapshot.lookup.input} (${snapshot.lookup.resolvedBy})`,
		],
		["Mode / state", `${snapshot.session.mode} / ${snapshot.session.state}`],
		[
			"Proposed / app",
			`${snapshot.session.proposedAppId ?? "—"} / ${snapshot.session.appId ?? "—"}`,
		],
		["Awaiting input", snapshot.session.awaitingInput ? "yes" : "no"],
		["Active run", snapshot.session.activeRunId ?? "—"],
		["Lease expires", snapshot.session.leaseExpiresAt],
		["Last error", snapshot.session.lastErrorType ?? "—"],
		["Updated", snapshot.session.updatedAt],
	]);
	if (snapshot.lookup.alternatives.length > 0) {
		console.log(
			`\n  Note: the identifier also matched ${snapshot.lookup.alternatives.length} older session(s):`,
		);
		for (const alternative of snapshot.lookup.alternatives)
			console.log(
				`    ${alternative.sessionId} · ${alternative.updatedAt} · ${alternative.reason}`,
			);
	}

	printSection("Thread and resumable stream");
	if (snapshot.threads.length === 0) console.log("  No design-session thread.");
	else
		printTable(
			[
				{ header: "Thread" },
				{ header: "Run" },
				{ header: "Messages", align: "right" },
				{ header: "Active stream" },
				{ header: "Updated" },
			],
			snapshot.threads.map((thread) => [
				shortId(thread.threadId),
				shortId(thread.runId),
				String(thread.messageCount),
				shortId(thread.activeStreamId),
				thread.updatedAt,
			]),
		);
	if (snapshot.streams.length > 0) {
		console.log("");
		printTable(
			[
				{ header: "Stream" },
				{ header: "Batches", align: "right" },
				{ header: "Chunks", align: "right" },
				{ header: "Terminal" },
				{ header: "Outcome" },
			],
			snapshot.streams.map((stream) => [
				shortId(stream.streamId),
				String(stream.batches),
				String(stream.chunks),
				stream.terminal ? "yes" : "no",
				stream.terminalOutcome ?? "—",
			]),
		);
	}

	printSection("Verified orchestration");
	if (snapshot.orchestration.head === null)
		console.log("  No orchestration events yet.");
	else {
		console.log(
			`  head r${snapshot.orchestration.head.revision}: ${snapshot.orchestration.head.kind} ${truncate(JSON.stringify(snapshot.orchestration.head.state), 220)}`,
		);
		for (const event of snapshot.orchestration.timeline)
			console.log(
				`  r${event.revision} ${event.createdAt} ${event.kind} · run ${shortId(event.runId)}`,
			);
	}

	printSection("Design artifacts");
	if (snapshot.artifacts.sourcePackages.length === 0)
		console.log("  No source package yet.");
	else
		for (const source of snapshot.artifacts.sourcePackages)
			console.log(
				`  source package ${shortId(source.id)} · digest ${source.digest.slice(0, 12)}… · run ${shortId(source.createdByRunId)}`,
			);
	if (snapshot.workspaces.length === 0)
		console.log("  No mutable artifact workspaces.");
	else
		for (const workspace of snapshot.workspaces) {
			const op = workspace.lastOperation as Record<string, unknown> | null;
			console.log(
				`  ${workspace.kind} workspace ${shortId(workspace.id)} [${workspace.status}] r${workspace.revision} · ${workspace.stepCount} step(s) · last ${op === null ? "—" : String(op.kind ?? op.type ?? "operation")}`,
			);
		}
	if (snapshot.artifacts.revisions.length === 0)
		console.log("  No immutable revision yet.");
	else
		for (const revision of snapshot.artifacts.revisions) {
			console.log(
				`  revision ${revision.revision} [${revision.lifecycle}] ${shortId(revision.id)} · ${revision.reviews.length} review(s) · ${revision.workflowCount} workflows / ${revision.composition.forms} forms / ${revision.composition.sections} sections`,
			);
			for (const review of revision.reviews)
				console.log(
					`    review ${review.ordinal}: ${review.findingCount} findings (${review.blockingCount} blocking) · ${shortId(review.id)}`,
				);
		}
	if (snapshot.artifacts.plan === null)
		console.log("  No verified build plan yet.");
	else
		console.log(
			`  plan ${snapshot.artifacts.plan.id} · ${snapshot.artifacts.plan.slices.length} workflow slice(s)`,
		);

	printSection("Workflow slices and attempts");
	if (snapshot.artifacts.plan !== null) {
		for (const slice of snapshot.artifacts.plan.slices) {
			const attempts = snapshot.attempts.filter(
				(attempt) => attempt.sliceId === slice.id,
			);
			const latest = attempts.at(-1);
			console.log(
				`  ${slice.role === "materialization-root" ? "ROOT" : "    "} ${slice.name} (${shortId(slice.id)}) · ${slice.constructionGroups} group(s) · budget ${slice.budget.maxModelSteps} turns / ${slice.budget.maxStagedRequests} requests`,
			);
			if (latest === undefined) console.log("       not started");
			else {
				const lastRequest = latest.changeSet?.lastRequest;
				const baseTurns = latest.budget?.maxModelSteps;
				const effectiveTurns = latest.budget?.effectiveMaxModelSteps;
				const baseRequests = latest.budget?.maxStagedRequests;
				const effectiveRequests = latest.budget?.effectiveMaxStagedRequests;
				console.log(
					`       attempt ${latest.attempt} [${latest.status}] · ${latest.spent.modelSteps}/${effectiveTurns ?? "?"} turns${effectiveTurns !== baseTurns ? ` (base ${baseTurns} + blocker allowance)` : ""} · ${latest.spent.stagedRequests}/${effectiveRequests ?? "?"} requests${effectiveRequests !== baseRequests ? ` (base ${baseRequests} + allowance)` : ""} · ${duration(latest.spent.wallClockMs)} active${latest.failureCode === null ? "" : ` · failure ${latest.failureCode}`}`,
				);
				console.log(
					`       change set ${shortId(latest.changeSet?.id ?? null)} r${latest.changeSet?.revision ?? 0} [${latest.changeSet?.status ?? "none"}] · ${latest.changeSet?.admittedStepCount ?? 0} admitted step(s)${lastRequest === null || lastRequest === undefined ? "" : ` · last ${lastRequest.tool} ${lastRequest.status}${lastRequest.rejectionCode === null ? "" : ` (${lastRequest.rejectionCode})`}`}`,
				);
				if (
					latest.outcomes.wireInvalid > 0 ||
					latest.outcomes.stageRejected > 0 ||
					latest.outcomes.validatorRepair > 0 ||
					latest.spent.blockerReports > 0
				)
					console.log(
						`       friction ${latest.outcomes.wireInvalid} wire-invalid / ${latest.outcomes.stageRejected} stage-rejected / ${latest.outcomes.validatorRepair} validator-repair / ${latest.spent.blockerReports} blocker report(s)`,
					);
			}
		}
	} else if (snapshot.attempts.length === 0)
		console.log("  No slice attempts.");

	printSection("Model context generations");
	if (snapshot.contexts.length === 0)
		console.log("  No persisted model contexts.");
	else
		printTable(
			[
				{ header: "Kind" },
				{ header: "Gen", align: "right" },
				{ header: "Context" },
				{ header: "Items", align: "right" },
				{ header: "Bytes", align: "right" },
				{ header: "Compacts", align: "right" },
				{ header: "Seeds", align: "right" },
				{ header: "Steps", align: "right" },
				{ header: "Open" },
				{ header: "Model" },
			],
			snapshot.contexts.map((context) => [
				context.kind,
				String(context.generation),
				shortId(context.id),
				String(context.itemCount),
				tok(context.messageBytes),
				String(context.compactionCount),
				String(context.checkpointCount),
				`${context.completedSteps}/${context.startedSteps}`,
				context.openStepKeys.length === 0
					? "—"
					: context.openStepKeys.join(","),
				context.modelId,
			]),
		);

	printSection("Usage and evidence coverage");
	if (snapshot.usage.length === 0)
		console.log("  No finalized run summaries yet.");
	else {
		const sum = (pick: (row: (typeof snapshot.usage)[number]) => number) =>
			snapshot.usage.reduce((total, row) => total + pick(row), 0);
		console.log(
			`  ${sum((row) => row.steps)} turns · ${tok(sum((row) => row.inputTokens))} input / ${tok(sum((row) => row.outputTokens))} output · ${tok(sum((row) => row.cacheReadTokens))} cache read / ${tok(sum((row) => row.cacheWriteTokens))} cache write · ${usd(sum((row) => row.costEstimate))}`,
		);
	}
	const missing = snapshot.eventCoverage.filter(
		(coverage) => !coverage.hasSummary,
	);
	const eventSum = (
		pick: (row: (typeof snapshot.eventCoverage)[number]) => number,
	) => snapshot.eventCoverage.reduce((total, row) => total + pick(row), 0);
	console.log(
		`  ${snapshot.eventCoverage.length} related run id(s) · ${sumEvents(snapshot.eventCoverage)} events · ${missing.length} run(s) missing a finalized usage summary`,
	);
	console.log(
		`  ${snapshot.usage.reduce((total, row) => total + row.tools, 0)} summarized tool calls · ${eventSum((row) => row.errorCount)} logged errors · ${eventSum((row) => row.nonacceptedOutcomeCount)} non-accepted design/executor outcomes`,
	);

	printSection("Next commands");
	const prod = options.prod === true ? " --prod" : "";
	console.log(
		`  live:       npx tsx --conditions=react-server scripts/inspect-design-session.ts ${snapshot.session.id} --watch --until-terminal${prod}`,
	);
	console.log(
		`  events:     npx tsx --conditions=react-server scripts/inspect-design-session.ts ${snapshot.session.id} --events${prod}`,
	);
	console.log(
		`  contexts:   npx tsx --conditions=react-server scripts/inspect-design-session.ts ${snapshot.session.id} --contexts${prod}`,
	);
	const latest = snapshot.attempts.at(-1);
	if (latest !== undefined)
		console.log(
			`  replay:     npx tsx --conditions=react-server scripts/inspect-design-slice.ts --plan ${latest.planId} --slice ${latest.sliceId}${latest.changeSet === null ? "" : ` --change-set ${latest.changeSet.id}`}${prod}`,
		);
}

function sumEvents(rows: readonly { eventCount: number }[]): number {
	return rows.reduce((total, row) => total + row.eventCount, 0);
}

function renderDetails(collected: Collected): void {
	if (collected.eventDetails.length > 0) {
		printSection(
			options.transcript === true || options.full === true
				? "Full event transcript"
				: "Related-run events",
		);
		for (const detail of collected.eventDetails) {
			console.log(`  run ${detail.runId} (${detail.events.length} events)`);
			for (const event of detail.events) {
				if (options.transcript === true || options.full === true) {
					console.log(JSON.stringify(event, null, 2));
				} else {
					console.log(
						`    ${new Date(event.ts).toISOString()} ${summarizeDesignEvent(event)}`,
					);
				}
			}
		}
	}
	if (collected.contextItems.length > 0) {
		printSection(
			options.contextContent === true || options.full === true
				? "Persisted model context content"
				: "Persisted model context ledger",
		);
		for (const item of collected.contextItems) {
			console.log(
				`  ${shortId(item.contextId)} #${item.ordinal} ${item.appendKey} · ${item.summary} · digest ${item.digestValid ? "ok" : "INVALID"} · run ${shortId(item.createdByRunId)}`,
			);
			if (item.message !== undefined)
				console.log(JSON.stringify(item.message, null, 2));
		}
	}
	if (collected.streamDetails.length > 0) {
		printSection("Retained stream chunks");
		for (const batch of collected.streamDetails) {
			console.log(
				`  ${batch.streamId} @${batch.firstIndex} · ${batch.chunks.length} chunks · ${batch.createdAt} · terminal ${batch.terminal}${batch.terminalOutcome === null ? "" : ` (${batch.terminalOutcome})`}`,
			);
			console.log(JSON.stringify(batch.chunks, null, 2));
		}
	}
}

function isTerminal(collected: Collected): boolean {
	const orchestrationKind = collected.snapshot.orchestration.head?.kind;
	return (
		(collected.snapshot.session.state !== "active" ||
			orchestrationKind === "finished" ||
			orchestrationKind === "accepted-partial" ||
			orchestrationKind === "failed") &&
		collected.snapshot.threads.every((thread) => thread.activeStreamId === null)
	);
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const detailsRequested =
		options.full === true ||
		options.events === true ||
		options.transcript === true ||
		options.contexts === true ||
		options.contextContent === true ||
		options.stream === true ||
		options.json === true;
	if (options.untilTerminal === true && options.watch !== true)
		throw new Error("--until-terminal requires --watch.");
	if (options.watch === true && detailsRequested)
		throw new Error(
			"--watch is compact; run detail or JSON flags as a separate one-shot command.",
		);

	let stopped = false;
	const stop = () => {
		stopped = true;
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		let lastFingerprint: string | null = null;
		do {
			const resolution = await resolveDesignSession(identifier);
			const collected = await collectSnapshot(resolution);
			const fingerprint = designSessionSnapshotFingerprint(collected.snapshot);
			if (fingerprint !== lastFingerprint) {
				if (lastFingerprint !== null)
					console.log(`\n\nState changed at ${new Date().toISOString()}\n`);
				if (options.json === true)
					console.log(JSON.stringify(collected, null, 2));
				else {
					renderSnapshot(collected);
					renderDetails(collected);
				}
				lastFingerprint = fingerprint;
			}
			if (
				options.watch !== true ||
				(options.untilTerminal === true && isTerminal(collected))
			)
				break;
			await sleep(options.interval * 1000);
		} while (!stopped);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
