import "server-only";

import { log } from "@/lib/logger";
import {
	previewProjectSpace,
	resolvePreviewDeploymentTarget,
	resolvePreviewFactsTarget,
} from "./previewTarget";
import {
	type DeploymentScope,
	readDeploymentPreviewRecords,
	readTargetFacts,
} from "./store";
import type { PreviewDeploymentAnswer } from "./types";

/**
 * The project space Preview may honestly name for an app.
 *
 * Its own module rather than a member of `service.ts`, because every
 * preview surface that resolves an identity calls it (the builder page,
 * the authorized action context, the form submission), and none of them
 * should drag the publish lifecycle's expander, media bundler, and HQ
 * client into their import graph to ask one question of one table.
 *
 * Best effort by design: a deployment read that faults must not take a
 * preview action down with it. Failing to `null` degrades to the existing,
 * always-honest behavior of leaving `commcare_project` absent.
 */
export async function previewProjectSpaceFor(
	scope: DeploymentScope,
): Promise<string | null> {
	try {
		const deployments = await readDeploymentPreviewRecords(scope);
		return previewProjectSpace(resolvePreviewDeploymentTarget(deployments));
	} catch (error) {
		log.warn("[deployment] preview project space unavailable", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * What Preview may name and play of where an app is published
 * (`PreviewDeploymentAnswer`), from one read of the deployment records.
 *
 * A fault reading the records or the facts throws: a failed read is no
 * answer, and `null` is one (Preview names nothing, and plays Nova's own
 * values). The stream's deployment lane calls this, so a fault is retried
 * and never announced.
 */
export async function readPreviewDeploymentAnswer(
	scope: DeploymentScope,
): Promise<PreviewDeploymentAnswer> {
	const deployments = await readDeploymentPreviewRecords(scope);
	const projectSpace = previewProjectSpace(
		resolvePreviewDeploymentTarget(deployments),
	);
	const target = resolvePreviewFactsTarget(deployments);
	if (target === null) return { projectSpace, targetFacts: null };
	const facts = await readTargetFacts(scope, target);
	return {
		projectSpace,
		targetFacts:
			facts === null
				? null
				: {
						fuzzyListSearch:
							facts.profileProperties["cc-fuzzy-search-enabled"] === "yes",
						markRequiredQuestions:
							facts.profileProperties[
								"cc-label-required-questions-with-asterisk"
							] === "yes",
					},
	};
}

/**
 * `readPreviewDeploymentAnswer` for an answer that must not fail with it: the
 * builder page's first render, and the answer to a publish or a refresh whose
 * write has already landed. A fault is logged once and gives `null`, which is
 * no answer: the page seeds Nova's own values until the stream's
 * connect-time read announces the real ones, and a tab handed `null` keeps
 * what it holds until the stream's deployment lane, which the write poked,
 * brings the new answer.
 */
export async function previewDeploymentAnswerFor(
	scope: DeploymentScope,
): Promise<PreviewDeploymentAnswer | null> {
	try {
		return await readPreviewDeploymentAnswer(scope);
	} catch (error) {
		log.warn("[deployment] preview deployment answer unavailable", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
