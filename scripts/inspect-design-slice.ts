/**
 * Export one exact, read-only slice replay fixture from durable design state.
 * The fixture starts at the accepted contract + plan + selected slice. When
 * `--change-set` is supplied it also includes the proven base document,
 * admitted step ledger, handle bindings, and reconstructed private candidate.
 * This lets a failing executor step be reproduced without rerunning design or
 * earlier slices, and never claims or mutates a run holder.
 *
 * Usage:
 *   npx tsx --conditions=react-server scripts/inspect-design-slice.ts \
 *     --plan <buildPlanId> --slice <sliceId> [--change-set <changeSetId>] [--prod]
 */
import "dotenv/config";
import { budgetForSlice } from "@/lib/agent/build/budgets";
import {
	briefDigest,
	deriveSliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import { rehydrateChangeSet } from "@/lib/agent/change-set/runtime";
import { loadChangeSet } from "@/lib/agent/change-set/store";
import {
	readDesignBuildPlan,
	readDesignRevision,
} from "@/lib/agent/design/artifactStore";
import { asDesignId } from "@/lib/agent/design/ids";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { designCompositionSummary } from "./lib/designCompositionSummary";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

function valueAfter(argv: readonly string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index < 0 ? undefined : argv[index + 1];
}

function usage(): never {
	console.log(
		"Usage: npx tsx --conditions=react-server scripts/inspect-design-slice.ts --plan <buildPlanId> --slice <sliceId> [--change-set <changeSetId>] [--prod]",
	);
	process.exit(1);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) usage();
	if (argv.includes("--prod")) targetProdDb();
	const planId = valueAfter(argv, "--plan");
	const sliceId = valueAfter(argv, "--slice");
	const changeSetId = valueAfter(argv, "--change-set");
	if (!planId || !sliceId) usage();

	const plan = await readDesignBuildPlan(planId);
	if (plan === null) throw new Error(`Build plan ${planId} does not exist.`);
	const revision = await readDesignRevision(plan.designRevisionId);
	if (revision === null || revision.lifecycle !== "accepted") {
		throw new Error(
			`Build plan ${planId} is not bound to a readable accepted revision.`,
		);
	}
	const slice = plan.envelope.payload.slices.find(
		(candidate) => candidate.id === sliceId,
	);
	if (slice === undefined) {
		throw new Error(`Slice ${sliceId} is not part of build plan ${planId}.`);
	}
	const brief = deriveSliceExecutionBrief({
		contract: revision.envelope.payload,
		revision: { id: revision.id, digest: revision.artifactDigest },
		plan: plan.envelope.payload,
		planDigest: plan.artifactDigest,
		sliceId: asDesignId(sliceId),
	});
	const db = await getAppDb();
	const attempts = await db
		.selectFrom("design_slice_attempts")
		.select(["id", "attempt", "status", "failure_code", "change_set_id"])
		.where("build_plan_id", "=", plan.id)
		.where("slice_id", "=", slice.id)
		.orderBy("attempt", "asc")
		.execute();
	const executorContexts = await db
		.selectFrom("design_model_contexts")
		.select(["id", "generation", "context_version", "revision"])
		.where("design_session_id", "=", plan.designSessionId)
		.where("context_kind", "=", "executor")
		.orderBy("generation", "asc")
		.execute();
	const executionAttempts = attempts.map((attempt) => {
		const context = executorContexts.find((candidate) =>
			candidate.context_version.endsWith(`:semantic-scope:${attempt.id}`),
		);
		return {
			id: attempt.id,
			attempt: attempt.attempt,
			status: attempt.status,
			failureCode: attempt.failure_code,
			changeSetId: attempt.change_set_id,
			executorContext:
				context === undefined
					? null
					: {
							id: context.id,
							generation: context.generation,
							revision: context.revision,
						},
		};
	});

	let candidate: unknown = null;
	if (changeSetId !== undefined) {
		const changeSet = await loadChangeSet(changeSetId);
		if (changeSet === undefined) {
			throw new Error(`Change set ${changeSetId} does not exist.`);
		}
		if (
			changeSet.designRevisionId !== revision.id ||
			changeSet.designRevisionDigest !== revision.artifactDigest ||
			changeSet.buildPlanId !== plan.id ||
			changeSet.buildPlanDigest !== plan.artifactDigest ||
			changeSet.sliceId !== slice.id
		) {
			throw new Error(
				`Change set ${changeSetId} does not share the selected revision, plan, and slice lineage.`,
			);
		}
		const replay = await rehydrateChangeSet(changeSet);
		candidate = {
			changeSet,
			baseDoc: replay.baseDoc,
			steps: replay.steps,
			handles: replay.handles,
			accumulatedReadSet: replay.accumulatedReadSet,
			externalContextDigest: replay.externalContextDigest,
			candidateDoc: replay.overlay.doc,
			candidateDigest: replay.overlay.candidateDigest,
		};
	}

	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				revision: {
					id: revision.id,
					digest: revision.artifactDigest,
					compositionSummary: designCompositionSummary(
						revision.envelope.payload,
					),
					contract: revision.envelope.payload,
				},
				plan: {
					id: plan.id,
					digest: plan.artifactDigest,
					payload: plan.envelope.payload,
				},
				slice: {
					id: slice.id,
					brief,
					briefDigest: briefDigest(brief),
					budget: budgetForSlice(slice),
				},
				executionAttempts,
				candidate,
			},
			null,
			2,
		),
	);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
