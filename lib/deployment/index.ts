// lib/deployment/index.ts
//
// The public face of deployments. Client surfaces import types and pure
// helpers from here; only server modules reach the store, the preflight,
// and the service.

export { DeploymentError, type DeploymentErrorCode } from "./errors";
export type { PreflightCheck, PreflightCheckStatus } from "./preflight";
export {
	buildSetupArtifact,
	renderSetupArtifact,
	SETUP_ARTIFACT_SECTION_IDS,
	type SetupArtifact,
	type SetupArtifactSection,
	type SetupArtifactSectionId,
} from "./setupArtifact";
export {
	deploymentCanRunPhase,
	deploymentDisplaysAsReached,
	deploymentHasReached,
	deploymentProgressIndex,
	deploymentResumeState,
	endpointLinkIsDurable,
	nextDeploymentPhase,
} from "./stateMachine";
export {
	DEPLOYMENT_PHASE_ENTRY_STATE,
	DEPLOYMENT_PHASE_SUCCESS_STATE,
	DEPLOYMENT_PHASES,
	DEPLOYMENT_PROGRESS_STATES,
	DEPLOYMENT_STATES,
	type DeploymentFailure,
	type DeploymentPhase,
	type DeploymentPhaseOutcome,
	type DeploymentPhaseOutcomes,
	type DeploymentProgressState,
	type DeploymentRecord,
	type DeploymentResource,
	type DeploymentResourceOwnership,
	type DeploymentState,
	type DeploymentWithResources,
	hqAppIdSchema,
	isDeploymentServer,
} from "./types";
