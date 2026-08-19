// lib/deployment/index.ts
//
// The public face of deployments. Client surfaces import types and pure
// helpers from here; only server modules reach the store, the preflight,
// and the service.

export { DeploymentError, type DeploymentErrorCode } from "./errors";
export type { PreflightCheck, PreflightCheckStatus } from "./preflight";
export { leftBehindResources } from "./resources";
export {
	buildSetupArtifact,
	type SetupArtifact,
	type SetupArtifactLookupTable,
	type SetupArtifactSection,
	type SetupArtifactStep,
} from "./setupArtifact";
export {
	deploymentDisplaysAsReached,
	deploymentHasReached,
	deploymentIsObservable,
	deploymentProgressIndex,
	deploymentResumeState,
} from "./stateMachine";
export {
	DEPLOYMENT_PHASE_ENTRY_STATE,
	DEPLOYMENT_PHASE_SUCCESS_STATE,
	DEPLOYMENT_PHASES,
	DEPLOYMENT_PROGRESS_STATES,
	DEPLOYMENT_STATE_PRODUCING_PHASE,
	DEPLOYMENT_STATES,
	type DeploymentAttemptRefusal,
	type DeploymentFailure,
	type DeploymentPhase,
	type DeploymentPhaseOutcome,
	type DeploymentPhaseOutcomes,
	type DeploymentProgressState,
	type DeploymentRecord,
	type DeploymentResource,
	type DeploymentResourceConflict,
	type DeploymentResourceKind,
	type DeploymentResourceOwnership,
	type DeploymentState,
	type DeploymentWithResources,
	type DrivenDeploymentPhase,
	isDeploymentServer,
} from "./types";
