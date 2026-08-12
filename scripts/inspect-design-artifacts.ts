/**
 * Read-only inspection of one design session's persisted artifacts: the
 * source package (references + claim counts), every contract revision with
 * its lifecycle, digests, and complexity, each independent review with its
 * findings and dispositions, and the build plans.
 *
 * Every artifact is read through the store's verified readers — envelope
 * digest recomputation plus the exact producer schemas — so this doubles as
 * an integrity probe for a session that behaved oddly: a tampered or
 * drifted row throws instead of printing as healthy.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally); `--prod` targets the production instance over its public IP
 * (see `./lib/prodDb.ts`). Never writes.
 *
 * `--reasoning` additionally prints each artifact's display-safe reasoning
 * summaries and payload-free executor outcomes from the run event log, joined
 * by the run that produced it: the WHY and stable interface result beside the
 * outcome, which is the record the design method's tuning reads.
 *
 * Usage:
 *   npx tsx scripts/inspect-design-artifacts.ts --session <designSessionId> [--reasoning] [--prod]
 */
import "dotenv/config";
import { sql } from "kysely";
import { readOrchestrationHead } from "@/lib/agent/build/orchestratorState";
import { readCommittedSliceReceiptsForPlan } from "@/lib/agent/change-set/commit";
import {
	readDesignReviews,
	readDesignRevisionsForSession,
	readDesignSourcePackage,
	readDispositions,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import {
	designArtifactWorkspaceOperationSchema,
	replayDesignWorkspace,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	appDesignContractSchema,
	designConstructionIssues,
} from "@/lib/agent/design/contract";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadDesignSession } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { getAppDb } from "@/lib/db/pg";
import { readEvents } from "@/lib/log/reader";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	collectDesignArtifactProducerRunIds,
	designArtifactDiagnosticRuns,
} from "./lib/designArtifactProducerRuns";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

function usage(): never {
	console.log(
		"Usage: npx tsx scripts/inspect-design-artifacts.ts --session <designSessionId> [--reasoning] [--prod]",
	);
	process.exit(1);
}

/** The session's event-log app key: pre-app events are written under the
 *  proposed app id, which becomes the real app id at materialization. */
async function eventLogAppId(sessionId: string): Promise<string | null> {
	const session = await loadDesignSession(sessionId);
	return session?.app_id ?? session?.proposed_app_id ?? null;
}

async function printRunDiagnostics(
	appId: string | null,
	runId: string,
	indent: string,
): Promise<void> {
	if (appId === null) return;
	const events = await readEvents(appId, runId);
	const summaries = events.flatMap((event) =>
		event.kind === "conversation" &&
		event.payload.type === "assistant-reasoning"
			? [event.payload.text]
			: [],
	);
	for (const summary of summaries) {
		const flattened = summary.replace(/\s+/g, " ").trim();
		console.log(
			`${indent}reasoning: ${flattened.slice(0, 300)}${flattened.length > 300 ? "…" : ""}`,
		);
	}
	for (const event of events) {
		if (event.kind !== "conversation") continue;
		if (event.payload.type === "design-tool-outcome") {
			const outcome = event.payload;
			console.log(
				`${indent}design ${outcome.outcome}: ${outcome.toolName} (${outcome.code})${outcome.validationStage === undefined ? "" : ` at ${outcome.validationStage}`}${outcome.issueCount === undefined ? "" : `, ${outcome.issueCount} issues`}`,
			);
			continue;
		}
		if (event.payload.type !== "executor-tool-outcome") continue;
		const outcome = event.payload;
		console.log(
			`${indent}executor ${outcome.outcome}: ${outcome.toolName}${outcome.operationIndex === undefined ? "" : `[${outcome.operationIndex}]`} (${outcome.code}) at workspace r${outcome.workspaceRevision}`,
		);
	}
}

async function printPreRevisionDiagnostics(args: {
	readonly sessionId: string;
	readonly appId: string | null;
	readonly withReasoning: boolean;
}): Promise<void> {
	const session = await loadDesignSession(args.sessionId);
	if (session === null) {
		console.log(`No design session ${args.sessionId}.`);
		return;
	}
	const db = await getAppDb();
	const [workspaces, workspaceStepProducers, sourceProducers, summaries] =
		await Promise.all([
			db
				.selectFrom("design_artifact_workspaces")
				.select([
					"id",
					"artifact_kind",
					"revision",
					"status",
					"created_by_run_id",
					"updated_by_run_id",
				])
				.where("design_session_id", "=", args.sessionId)
				.orderBy("created_at", "asc")
				.execute(),
			db
				.selectFrom("design_artifact_workspace_steps")
				.innerJoin(
					"design_artifact_workspaces",
					"design_artifact_workspaces.id",
					"design_artifact_workspace_steps.workspace_id",
				)
				.select(
					"design_artifact_workspace_steps.created_by_run_id as createdByRunId",
				)
				.where(
					"design_artifact_workspaces.design_session_id",
					"=",
					args.sessionId,
				)
				.execute(),
			db
				.selectFrom("design_source_packages")
				.select("created_by_run_id as createdByRunId")
				.where("design_session_id", "=", args.sessionId)
				.execute(),
			db
				.selectFrom("run_summaries")
				.selectAll()
				.where("design_session_id", "=", args.sessionId)
				.orderBy("started_at", "asc")
				.execute(),
		]);
	console.log(
		`session ${args.sessionId} [${session.state}] · materialized ${session.app_id === null ? "no" : "yes"} · awaiting input ${session.awaiting_input ? "yes" : "no"} · last error ${session.last_error_type ?? "none"}`,
	);
	for (const workspace of workspaces) {
		const rows = await db
			.selectFrom("design_artifact_workspace_steps")
			.select("revision")
			.select(
				sql<string>`${sql.ref("design_artifact_workspace_steps.operation")}::text`.as(
					"operation_text",
				),
			)
			.where("workspace_id", "=", workspace.id)
			.orderBy("revision", "asc")
			.execute();
		const operations = rows.map((row, index) => {
			const revision = safePersistedSequence(
				row.revision,
				`design_artifact_workspace_steps.revision for ${workspace.id}`,
			);
			if (revision !== index + 1)
				throw new Error(
					`Design workspace ${workspace.id} has a non-contiguous operation ledger.`,
				);
			return designArtifactWorkspaceOperationSchema.parse(
				parsePersistedJsonText(
					row.operation_text,
					`design_artifact_workspace_steps.operation for ${workspace.id} revision ${revision}`,
				),
			);
		});
		const persistedRevision = safePersistedSequence(
			workspace.revision,
			`design_artifact_workspaces.revision for ${workspace.id}`,
		);
		if (persistedRevision !== operations.length)
			throw new Error(
				`Design workspace ${workspace.id} disagrees with its operation ledger.`,
			);
		let readiness = "readiness unavailable";
		if (workspace.artifact_kind === "contract") {
			const candidate = replayDesignWorkspace({
				kind: "contract",
				operations,
			});
			const parsed = appDesignContractSchema.safeParse(candidate);
			if (!parsed.success) {
				readiness = `schema-invalid (${parsed.error.issues.length} issues)`;
			} else {
				const constructionIssues = designConstructionIssues(parsed.data);
				readiness =
					constructionIssues.length === 0
						? "ready to finalize"
						: `construction-blocked (${constructionIssues.length} issues)`;
			}
		}
		console.log(
			`  ${workspace.artifact_kind} workspace ${workspace.id.slice(0, 8)}… [${workspace.status}] · r${persistedRevision} · ${readiness}`,
		);
	}
	if (workspaces.length === 0) console.log("  no design workspaces");

	const producerRunIds = collectDesignArtifactProducerRunIds(
		sourceProducers,
		workspaces.flatMap((workspace) => [
			{ createdByRunId: workspace.created_by_run_id },
			{ createdByRunId: workspace.updated_by_run_id },
		]),
		workspaceStepProducers,
	);
	const { runIds: diagnosticRunIds, missingSummaryCount } =
		designArtifactDiagnosticRuns(
			producerRunIds,
			summaries.map((summary) => summary.run_id),
		);
	const sum = (read: (row: (typeof summaries)[number]) => number): number =>
		summaries.reduce((total, row) => total + read(row), 0);
	const startedAt = summaries
		.map((summary) => summary.started_at)
		.sort((left, right) => Date.parse(left) - Date.parse(right))
		.at(0);
	const finishedAt = summaries
		.flatMap((summary) =>
			summary.finished_at === undefined ? [] : [summary.finished_at],
		)
		.sort((left, right) => Date.parse(right) - Date.parse(left))
		.at(0);
	const inputTokens = sum((row) => Number(row.input_tokens));
	const outputTokens = sum((row) => Number(row.output_tokens));
	const cacheReadTokens = sum((row) => Number(row.cache_read_tokens));
	const cacheWriteTokens = sum((row) => Number(row.cache_write_tokens));
	if (summaries.length === 0) {
		console.log(
			`  usage unknown · no flushed run summary${producerRunIds.length === 0 ? "" : ` for ${producerRunIds.length} artifact producer run${producerRunIds.length === 1 ? "" : "s"}`}`,
		);
	} else {
		console.log(
			`  usage ${sum((row) => row.step_count)} model steps · ${(inputTokens + outputTokens).toLocaleString()} tokens ` +
				`(${cacheReadTokens.toLocaleString()} cache read, ${cacheWriteTokens.toLocaleString()} cache write) · ` +
				`${startedAt === undefined || finishedAt === undefined ? "unknown" : `${Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))} ms`} · ` +
				`$${sum((row) => row.cost_estimate).toFixed(4)} estimated` +
				(missingSummaryCount === 0
					? ""
					: ` · ${missingSummaryCount} artifact producer run${missingSummaryCount === 1 ? "" : "s"} missing summaries`),
		);
	}
	if (args.withReasoning) {
		for (const runId of diagnosticRunIds)
			await printRunDiagnostics(args.appId, runId, "  ");
	}
	console.log("No immutable design revisions or build plan were accepted.");
}

async function printBuildAggregate(args: {
	readonly sessionId: string;
	readonly appId: string | null;
	readonly plan: NonNullable<
		Awaited<ReturnType<typeof readLatestDesignBuildPlanForRevision>>
	>;
	readonly acceptedWorkflowCount: number;
	readonly artifactRunIds: readonly string[];
}): Promise<void> {
	const db = await getAppDb();
	const attempts = await db
		.selectFrom("design_slice_attempts")
		.leftJoin(
			"design_change_sets",
			"design_change_sets.id",
			"design_slice_attempts.change_set_id",
		)
		.select([
			"design_slice_attempts.id",
			"design_slice_attempts.slice_id",
			"design_slice_attempts.attempt",
			"design_slice_attempts.status",
			"design_slice_attempts.failure_code",
			"design_slice_attempts.execution_run_ids",
			"design_slice_attempts.wire_invalid_count",
			"design_slice_attempts.stage_rejected_count",
			"design_slice_attempts.validator_repair_count",
			"design_slice_attempts.outcome_evidence_state",
			"design_change_sets.owner_run_id as run_id",
		])
		.where("design_slice_attempts.design_session_id", "=", args.sessionId)
		.where("design_slice_attempts.build_plan_id", "=", args.plan.id)
		.orderBy("design_slice_attempts.slice_id", "asc")
		.orderBy("design_slice_attempts.attempt", "asc")
		.execute();
	const receipts = await readCommittedSliceReceiptsForPlan(args.plan.id);
	const receiptBySlice = new Map(
		receipts.map((receipt) => [receipt.sliceId as string, receipt]),
	);
	const runIds = new Set(
		attempts.flatMap((attempt) => [
			...attempt.execution_run_ids,
			...(attempt.run_id === null ? [] : [attempt.run_id]),
		]),
	);
	for (const runId of args.artifactRunIds) runIds.add(runId);
	const orchestrationRuns = await db
		.selectFrom("design_orchestration_events")
		.select("run_id")
		.where("design_session_id", "=", args.sessionId)
		.execute();
	for (const event of orchestrationRuns) runIds.add(event.run_id);
	/* Cost is session-wide, not just the accepted revision's final producer:
	 * design questions and superseded reviewed revisions still spent calls in
	 * this same rerun and count against its release ceiling. */
	const summaries = await db
		.selectFrom("run_summaries")
		.selectAll()
		.where("design_session_id", "=", args.sessionId)
		.execute();
	for (const summary of summaries) runIds.add(summary.run_id);
	const wireInvalid = attempts.reduce(
		(total, attempt) => total + attempt.wire_invalid_count,
		0,
	);
	const stageRejected = attempts.reduce(
		(total, attempt) => total + attempt.stage_rejected_count,
		0,
	);
	const validatorRepair = attempts.reduce(
		(total, attempt) => total + attempt.validator_repair_count,
		0,
	);
	const outcomeEvidenceComplete =
		attempts.length > 0 &&
		attempts.every((attempt) => attempt.outcome_evidence_state === "complete");
	const startedAtMs = summaries.reduce<number | null>(
		(earliest, summary) =>
			earliest === null || Date.parse(summary.started_at) < earliest
				? Date.parse(summary.started_at)
				: earliest,
		null,
	);
	const finishedAtMs = summaries.reduce<number | null>(
		(latest, summary) =>
			latest === null || Date.parse(summary.finished_at) > latest
				? Date.parse(summary.finished_at)
				: latest,
		null,
	);
	const sum = (read: (row: (typeof summaries)[number]) => number): number =>
		summaries.reduce((total, row) => total + read(row), 0);
	console.log(
		`  release gate ${receipts.length}/${args.acceptedWorkflowCount} workflows committed · ` +
			`wire-invalid ${wireInvalid} · stage-rejected ${stageRejected} · validator-repair ${validatorRepair} · ` +
			`outcome evidence ${outcomeEvidenceComplete ? "complete" : "missing"}`,
	);
	for (const [
		sliceIndex,
		slice,
	] of args.plan.envelope.payload.slices.entries()) {
		const sliceAttempts = attempts.filter(
			(attempt) => attempt.slice_id === slice.id,
		);
		console.log(
			`    slice ${sliceIndex + 1} ${slice.id.slice(0, 8)}: ${
				sliceAttempts
					.map(
						(attempt) =>
							`attempt ${attempt.attempt} ${attempt.status}${attempt.failure_code === null ? "" : ` (${attempt.failure_code})`}`,
					)
					.join(", ") || "no attempt"
			}; commit ${receiptBySlice.has(slice.id as string) ? "yes" : "no"}`,
		);
	}
	const inputTokens = sum((row) => Number(row.input_tokens));
	const outputTokens = sum((row) => Number(row.output_tokens));
	const cacheReadTokens = sum((row) => Number(row.cache_read_tokens));
	const cacheWriteTokens = sum((row) => Number(row.cache_write_tokens));
	const estimatedCost = sum((row) => row.cost_estimate);
	const summaryRunIds = new Set(summaries.map((summary) => summary.run_id));
	const missingSummaryRunIds = [...runIds].filter(
		(runId) => !summaryRunIds.has(runId),
	);
	const usageEvidenceComplete =
		summaries.length > 0 && missingSummaryRunIds.length === 0;
	const usageGap =
		summaries.length === 0
			? "no run summaries"
			: `${missingSummaryRunIds.length} known run${missingSummaryRunIds.length === 1 ? "" : "s"} missing a summary`;
	const head = await readOrchestrationHead(args.sessionId);
	const committedAttemptsMatch = args.plan.envelope.payload.slices.every(
		(slice) => {
			const sliceAttempts = attempts.filter(
				(attempt) => attempt.slice_id === slice.id,
			);
			const receipt = receiptBySlice.get(slice.id as string);
			return sliceAttempts.some(
				(attempt) =>
					attempt.id === receipt?.attemptId && attempt.status === "committed",
			);
		},
	);
	const mechanicalGatePassed =
		receipts.length === args.acceptedWorkflowCount &&
		committedAttemptsMatch &&
		outcomeEvidenceComplete &&
		wireInvalid === 0 &&
		stageRejected === 0 &&
		head?.state.kind === "finished" &&
		usageEvidenceComplete &&
		estimatedCost < 15;
	console.log(
		`  mechanical release gate ${mechanicalGatePassed ? "PASS" : "FAIL"} · ` +
			`finished ${head?.state.kind === "finished" ? "yes" : "no"} · ` +
			`outcome evidence ${outcomeEvidenceComplete ? "complete" : "missing"} · ` +
			`usage evidence ${usageEvidenceComplete ? "complete" : "missing"} · ` +
			`cost<15 ${usageEvidenceComplete ? (estimatedCost < 15 ? "yes" : "no") : "unknown"}`,
	);
	if (mechanicalGatePassed) {
		console.log(
			"  usability and material completeness still require review before the rerun is declared GREEN",
		);
	}
	console.log(
		`  usage ${sum((row) => row.step_count)} model steps · ` +
			`${(inputTokens + outputTokens).toLocaleString()} tokens ` +
			`(${cacheReadTokens.toLocaleString()} cache read, ${cacheWriteTokens.toLocaleString()} cache write) · ` +
			`${startedAtMs === null || finishedAtMs === null ? "unknown" : `${Math.max(0, finishedAtMs - startedAtMs)} ms`} · ` +
			(usageEvidenceComplete
				? `$${estimatedCost.toFixed(4)} estimated`
				: `cost unknown (${usageGap})`),
	);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) usage();
	if (argv.includes("--prod")) targetProdDb();
	const sessionFlag = argv.indexOf("--session");
	const sessionId = sessionFlag >= 0 ? argv[sessionFlag + 1] : undefined;
	if (!sessionId) usage();
	const withReasoning = argv.includes("--reasoning");
	const appId = await eventLogAppId(sessionId);

	const revisions = await readDesignRevisionsForSession(sessionId);
	if (revisions.length === 0) {
		await printPreRevisionDiagnostics({ sessionId, appId, withReasoning });
		return;
	}
	const reviewEntries = await Promise.all(
		revisions.map(
			async (revision) =>
				[revision.id, await readDesignReviews(revision.id)] as const,
		),
	);
	const reviewsByRevision = new Map(reviewEntries);
	const db = await getAppDb();
	const [
		sourceProducers,
		planProducers,
		workspaceProducers,
		workspaceStepProducers,
	] = await Promise.all([
		db
			.selectFrom("design_source_packages")
			.select("created_by_run_id as createdByRunId")
			.where("design_session_id", "=", sessionId)
			.execute(),
		db
			.selectFrom("design_build_plans")
			.select("created_by_run_id as createdByRunId")
			.where("design_session_id", "=", sessionId)
			.execute(),
		db
			.selectFrom("design_artifact_workspaces")
			.select(["created_by_run_id", "updated_by_run_id"])
			.where("design_session_id", "=", sessionId)
			.execute(),
		db
			.selectFrom("design_artifact_workspace_steps")
			.innerJoin(
				"design_artifact_workspaces",
				"design_artifact_workspaces.id",
				"design_artifact_workspace_steps.workspace_id",
			)
			.select(
				"design_artifact_workspace_steps.created_by_run_id as createdByRunId",
			)
			.where("design_artifact_workspaces.design_session_id", "=", sessionId)
			.execute(),
	]);
	const artifactRunIds = collectDesignArtifactProducerRunIds(
		revisions,
		reviewEntries.flatMap(([, reviews]) => reviews),
		sourceProducers,
		planProducers,
		workspaceProducers.flatMap((workspace) => [
			{ createdByRunId: workspace.created_by_run_id },
			{ createdByRunId: workspace.updated_by_run_id },
		]),
		workspaceStepProducers,
	);

	const packages = new Set(
		revisions.map((revision) => revision.sourcePackageDigest),
	);
	for (const digest of packages) {
		const pkg = await readDesignSourcePackage(sessionId, digest);
		if (!pkg) continue;
		console.log(`source package ${digest.slice(0, 16)}…`);
		console.log(
			`  project ${pkg.projectId} · ${pkg.payload.requestBlockCount} request blocks · ` +
				`${pkg.payload.attachmentCount} documents · ${pkg.payload.imageCount} images · ` +
				`${pkg.payload.claims.length} seeded claims · ${pkg.payload.projectedBytes.toLocaleString()} projected bytes`,
		);
	}

	for (const revision of revisions) {
		console.log("");
		console.log(
			`revision ${revision.revision} [${revision.lifecycle}] ${revision.id} ` +
				`(${revision.envelope.promptVersion}, ${revision.createdAt.toISOString()})`,
		);
		console.log(`  artifact digest ${revision.artifactDigest.slice(0, 16)}…`);
		const complexity = revision.envelope.complexity;
		if (complexity) {
			console.log(
				`  complexity ${complexity.score} → ${complexity.depth} (algorithm v${complexity.algorithmVersion})`,
			);
		}
		if (withReasoning) {
			await printRunDiagnostics(appId, revision.createdByRunId, "  ");
		}
		const reviews = reviewsByRevision.get(revision.id) ?? [];
		for (const review of reviews) {
			const findings = review.envelope.payload.findings;
			console.log(
				`  review #${review.reviewOrdinal} ${review.id}: ${findings.length} findings ` +
					`(${findings.filter((f) => f.severity === "critical").length} critical, ` +
					`${findings.filter((f) => f.severity === "important").length} important)`,
			);
			for (const disposition of await readDispositions(review.id)) {
				console.log(
					`    disposition ${disposition.findingId.slice(0, 8)}… → ${disposition.disposition.status} (revision ${disposition.resultingRevisionId.slice(0, 8)}…)`,
				);
			}
		}
		if (revision.lifecycle === "accepted") {
			const plan = await readLatestDesignBuildPlanForRevision(revision.id);
			if (plan) {
				console.log(
					`  build plan ${plan.id}: ${plan.envelope.payload.slices.length} slices, ` +
						`plan digest ${plan.planDigest.slice(0, 16)}…`,
				);
				await printBuildAggregate({
					sessionId,
					appId,
					plan,
					acceptedWorkflowCount: revision.envelope.payload.workflows.length,
					artifactRunIds,
				});
			}
		}
	}
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
