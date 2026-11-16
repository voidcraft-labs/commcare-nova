// lib/deployment/index.ts
//
// The public face of deployments. Client surfaces import types and pure
// helpers from here; only server modules reach the store, the preflight,
// the service and what an adoption records (`adoption.ts`, whose functions
// build the app's import body and compress its source).

export type {
	AdoptedIdentityRows,
	AdoptedKeyedCaseId,
	AdoptedMediaFile,
	MediaPathAssignment,
	MediaPathRederivedReason,
} from "./adoption";
export { DeploymentError, type DeploymentErrorCode } from "./errors";
export type { PreflightCheck, PreflightCheckStatus } from "./preflight";
export {
	APP_PREVIEW_NOTE,
	BASELINE_UNKNOWN_SENTENCE,
	baselineUnknownSentence,
	driftReferenceOf,
	HQ_CHANGED_DURING_PUSH_MESSAGE,
	hqChangedMessage,
	hqChangesConfirmedDetail,
	hqChangesNoneDetail,
	LOOKUP_ADOPTION_NOTE,
} from "./remoteChanges";
export {
	type DeploymentEnding,
	deploymentEnding,
	type FirstPublishState,
	firstPublishOf,
	leftBehindResources,
	type NextPublishAction,
	nextPublishAction,
	publishedRemoteApp,
	remoteAppHoldsContent,
	remoteAppReportedGone,
} from "./resources";
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
export type { AdoptedDeploymentWrite, HqAppClaimView } from "./store";
export {
	type CommCareServer,
	DEPLOYMENT_END_REASONS,
	DEPLOYMENT_PHASE_ENTRY_STATE,
	DEPLOYMENT_PHASE_SUCCESS_STATE,
	DEPLOYMENT_PHASES,
	DEPLOYMENT_PROGRESS_STATES,
	DEPLOYMENT_STATE_PRODUCING_PHASE,
	DEPLOYMENT_STATES,
	type DeploymentAttemptRefusal,
	type DeploymentEndReason,
	type DeploymentFailure,
	type DeploymentIdentityOverride,
	type DeploymentPhase,
	type DeploymentPhaseOutcome,
	type DeploymentPhaseOutcomes,
	type DeploymentProgressState,
	type DeploymentRecord,
	type DeploymentRemoteChange,
	type DeploymentResource,
	type DeploymentResourceConflict,
	type DeploymentResourceKind,
	type DeploymentResourceOwnership,
	type DeploymentState,
	type DeploymentWithResources,
	type DrivenDeploymentPhase,
	deploymentServerLabel,
	isDeploymentServer,
	type RemoteChangeDiscard,
} from "./types";
