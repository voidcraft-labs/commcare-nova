/**
 * Read-only inspection of one design session's persisted artifacts: the
 * source package (references + claim counts), every contract revision with
 * its lifecycle, digests, and complexity, each independent review with its
 * findings and dispositions, and the build plans.
 *
 * Every row is re-verified on read (envelope digest recomputation + strict
 * schema, through the artifact store's own readers), so this doubles as an
 * integrity probe for a session that behaved oddly.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally); `--prod` targets the production instance over its public IP
 * (see `./lib/prodDb.ts`). Never writes.
 *
 * Usage:
 *   npx tsx scripts/inspect-design-artifacts.ts --session <designSessionId> [--prod]
 */
import "dotenv/config";
import {
	readDesignReviews,
	readDesignSourcePackage,
	readDispositions,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

function usage(): never {
	console.log(
		"Usage: npx tsx scripts/inspect-design-artifacts.ts --session <designSessionId> [--prod]",
	);
	process.exit(1);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) usage();
	if (argv.includes("--prod")) targetProdDb();
	const sessionFlag = argv.indexOf("--session");
	const sessionId = sessionFlag >= 0 ? argv[sessionFlag + 1] : undefined;
	if (!sessionId) usage();

	const db = await getAppDb();
	const revisions = await db
		.selectFrom("design_revisions")
		.select([
			"id",
			"revision",
			"lifecycle",
			"artifact_digest",
			"source_package_digest",
			"prompt_version",
			"created_at",
		])
		.where("design_session_id", "=", sessionId)
		.orderBy("revision", "asc")
		.execute();
	if (revisions.length === 0) {
		console.log(`No design revisions for session ${sessionId}.`);
		return;
	}

	const packages = new Set(revisions.map((row) => row.source_package_digest));
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

	for (const row of revisions) {
		console.log("");
		console.log(
			`revision ${row.revision} [${row.lifecycle}] ${row.id} (${row.prompt_version}, ${row.created_at.toISOString()})`,
		);
		console.log(`  artifact digest ${row.artifact_digest.slice(0, 16)}…`);
		const reviews = await readDesignReviews(row.id);
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
		if (row.lifecycle === "accepted") {
			const plan = await readLatestDesignBuildPlanForRevision(row.id);
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
