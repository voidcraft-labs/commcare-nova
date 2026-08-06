import "server-only";

import { log } from "@/lib/logger";
import {
	previewProjectSpace,
	resolvePreviewDeploymentTarget,
} from "./previewTarget";
import { type DeploymentScope, readDeploymentRecordsForApp } from "./store";

/**
 * The project space Preview may honestly name for an app.
 *
 * Its own module rather than a member of `service.ts`, because every
 * preview surface that resolves an identity calls it — the builder page,
 * the authorized action context, the form submission — and none of them
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
		const deployments = await readDeploymentRecordsForApp(scope);
		return previewProjectSpace(resolvePreviewDeploymentTarget(deployments));
	} catch (error) {
		log.warn("[deployment] preview project space unavailable", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
