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
import {
	readDesignReviews,
	readDesignRevisionsForSession,
	readDesignSourcePackage,
	readDispositions,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadDesignSession } from "@/lib/db/designSessions";
import { readEvents } from "@/lib/log/reader";
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
		if (
			event.kind !== "conversation" ||
			event.payload.type !== "executor-tool-outcome"
		) {
			continue;
		}
		const outcome = event.payload;
		console.log(
			`${indent}executor ${outcome.outcome}: ${outcome.toolName}${outcome.operationIndex === undefined ? "" : `[${outcome.operationIndex}]`} (${outcome.code}) at workspace r${outcome.workspaceRevision}`,
		);
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) usage();
	if (argv.includes("--prod")) targetProdDb();
	const sessionFlag = argv.indexOf("--session");
	const sessionId = sessionFlag >= 0 ? argv[sessionFlag + 1] : undefined;
	if (!sessionId) usage();
	const withReasoning = argv.includes("--reasoning");
	const appId = withReasoning ? await eventLogAppId(sessionId) : null;

	const revisions = await readDesignRevisionsForSession(sessionId);
	if (revisions.length === 0) {
		console.log(`No design revisions for session ${sessionId}.`);
		return;
	}

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
		const reviews = await readDesignReviews(revision.id);
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
