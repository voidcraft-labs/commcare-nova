// lib/deployment/index.ts
//
// The public face of deployments. Client surfaces import types and pure
// helpers from here; only server modules reach the store, the preflight,
// the service and what an adoption records (`adoption.ts`, whose functions
// build the app's import body and compress its source). A bring-in's
// server surface is `reading/index.ts`; its client-safe values (the
// schemas, the stages, the stream's reader) are imported from
// `reading/types.ts` and `reading/stream.ts` themselves.

export type { AdoptedAppReceipt } from "@/lib/db/appGenesis";
export type {
	AdoptedIdentityRows,
	AdoptedKeyedCaseId,
	AdoptedMediaFile,
	MediaPathAssignment,
	MediaPathRederivedReason,
} from "./adoption";
export { DeploymentError, type DeploymentErrorCode } from "./errors";
export { hqPlaceUrl } from "./hqPlaceUrl";
export type { PreflightCheck, PreflightCheckStatus } from "./preflight";
export { type AccountAnswer, accountOfOne } from "./reading/answers";
export type { HqAppPicker, HqAppPickerRow } from "./reading/pickerTypes";
export type {
	LookupTableChoice,
	OwnerRuleChoice,
	ReviewOwnerRule,
} from "./reading/projectData/reviewTypes";
export type {
	BringInInput,
	CreateAnswer,
	ReadingAnswer,
	ReadingDeclarationChoice,
	ReadingEvent,
	ReadingKey,
	ReadingRefusal,
	ReadingReview,
	ReadingStage,
	ReviewPlaces,
	ReviewTable,
} from "./reading/types";
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
