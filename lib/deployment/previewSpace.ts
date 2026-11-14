import "server-only";

import type { PreviewTargetFacts } from "@/lib/collab/previewTargetFactsFrame";
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
 * What the one reached project space holds of the two kept settings Preview
 * plays: fuzzy search in a case list, and the asterisk on a required
 * question.
 *
 * `null` where Preview holds no facts (no reached project space, several, or
 * a baseline Nova never read), and Preview plays Nova's own value of each,
 * which is what a new project space gives. Best effort as
 * `previewProjectSpaceFor` is: a fault degrades to `null`.
 */
export async function previewTargetFactsFor(
	scope: DeploymentScope,
): Promise<PreviewTargetFacts | null> {
	try {
		const target = resolvePreviewFactsTarget(
			await readDeploymentPreviewRecords(scope),
		);
		if (target === null) return null;
		const facts = await readTargetFacts(scope, target);
		if (facts === null) return null;
		return {
			fuzzyListSearch:
				facts.profileProperties["cc-fuzzy-search-enabled"] === "yes",
			markRequiredQuestions:
				facts.profileProperties["cc-label-required-questions-with-asterisk"] ===
				"yes",
		};
	} catch (error) {
		log.warn("[deployment] preview target facts unavailable", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
