/**
 * What a deployment answer reads beside the record once its write has
 * landed: a publish, a check, a refresh of the kept values, a stop, a
 * withdrawn confirmation or a bring-in of changes made in CommCare HQ.
 *
 * A fault in one of these reads answers less, never an error: an agent told
 * a landed write failed would make it again, over the one that landed. Each
 * fault is logged by its class and code alone, as
 * `service.ts::landedDeploymentKept` logs one, since a fault's message can
 * quote what it was reading.
 */

import {
	currentResourceIdentities,
	faultCode,
	setupArtifactFor,
} from "@/lib/deployment/service";
import type { SetupArtifact } from "@/lib/deployment/setupArtifact";
import {
	type DeploymentScope,
	readDeploymentNovaRevisions,
} from "@/lib/deployment/store";
import type { DeploymentWithResources } from "@/lib/deployment/types";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";

/** The write whose answer a read serves, as each logged line names it. */
export type LandedWrite =
	| "publish"
	| "check-status"
	| "kept-refresh"
	| "stop"
	| "withdraw"
	| "bring-in";

function logLandedFault(
	line: string,
	scope: DeploymentScope,
	domain: string,
	after: LandedWrite,
	error: unknown,
): void {
	log.error(line, undefined, {
		appId: scope.appId,
		domain,
		after,
		errorName: error instanceof Error ? error.name : typeof error,
		errorCode: faultCode(error),
	});
}

/**
 * The app's resource names for the left-behind list, or null where they
 * could not be read, which reports only superseded apps
 * (`deploymentProjection.ts::describeDeployment`).
 */
export async function landedResourceIdentities(
	scope: DeploymentScope,
	doc: BlueprintDoc,
	domain: string,
	after: LandedWrite,
): Promise<ReadonlyMap<string, string> | null> {
	try {
		return await currentResourceIdentities(scope, doc);
	} catch (error) {
		logLandedFault(
			"[deployment] resource names unavailable after a write landed",
			scope,
			domain,
			after,
			error,
		);
		return null;
	}
}

/**
 * The revisions CommCare HQ's copies were last known to match, or `unread`
 * where they could not be read, which leaves `nova_revision` out of the
 * answer rather than saying Nova holds no read to compare with.
 */
export async function landedNovaRevisions(
	scope: DeploymentScope,
	domain: string,
	after: LandedWrite,
): Promise<ReadonlyMap<string, number> | "unread"> {
	try {
		return await readDeploymentNovaRevisions(scope);
	} catch (error) {
		logLandedFault(
			"[deployment] matched revisions unavailable after a write landed",
			scope,
			domain,
			after,
			error,
		);
		return "unread";
	}
}

/**
 * The setup artifact for the record a landed write answers with, or null
 * where it could not be built, which the answer gives as `setup_artifact`
 * null, as a stop's does.
 */
export async function landedSetupArtifact(
	scope: DeploymentScope,
	deployment: DeploymentWithResources,
	doc: BlueprintDoc,
	after: LandedWrite,
): Promise<SetupArtifact | null> {
	try {
		return await setupArtifactFor(scope, deployment, doc);
	} catch (error) {
		logLandedFault(
			"[deployment] setup artifact unavailable after a write landed",
			scope,
			deployment.deployment.domain,
			after,
			error,
		);
		return null;
	}
}
