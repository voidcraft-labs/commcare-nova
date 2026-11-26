/**
 * Unified publish flow for direct HQ upload, HQ JSON, and mobile CCZ.
 *
 * All three destinations stay in one durable modal because publish results can
 * carry important prerequisite and follow-up information. One selector changes
 * the destination-specific fields and action while shared app requirements keep
 * one stable place before every action. Connected project spaces are checked on
 * open, selection, an explicit retry, and again by the server immediately before
 * an upload; exact post-publish results remain in the modal.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerBrowser from "@iconify-icons/tabler/browser";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerDeviceMobile from "@iconify-icons/tabler/device-mobile";
import tablerDownload from "@iconify-icons/tabler/download";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { motion } from "motion/react";
import Link from "next/link";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FirstPublishLines } from "@/components/bring-in/FirstPublishLines";
import {
	broughtInElsewhere,
	type ConfirmationRequest,
	cardKind,
	compactTargetRows,
	confirmationRequests,
	everyConfirmationGiven,
	preseededDomainSelection,
	sameConfirmationKey,
	upsertDeploymentViews,
	withLandedConfirmations,
} from "@/components/builder/app-setup/publishingSectionModel";
import {
	type CczTargetRow,
	cczHasNoChoice,
	cczPickAfterRead,
	cczTargetRows,
	chosenCczTarget,
	type DownloadTargets,
} from "@/components/builder/cczTargetsModel";
import { DeploymentStatus } from "@/components/builder/DeploymentStatus";
import { useApplyPreviewDeploymentAnswer } from "@/components/builder/DeploymentTargetProvider";
import {
	HqChangesPanel,
	type HqChangesPanelProps,
} from "@/components/builder/HqChangesPanel";
import { HqNotConnected } from "@/components/builder/HqNotConnected";
import type { HqChangesSettled } from "@/components/builder/hqChangesPanelModel";
import type { ShownRefreshedView } from "@/components/builder/keptListModel";
import {
	acceptsOffer,
	confirmationsStillAsked,
	type PublishedDeploymentView,
	type PublishLogoStepBody,
	type PublishPlan,
	placementOfferCopy,
	publishedViewToHold,
	publishOutcome,
	publishPlanCopy,
	refusalOpensHqApp,
	withAcceptedMoves,
	withConfirmation,
} from "@/components/builder/publishOutcome";
import {
	StopPublishingDialog,
	type StopPublishingTarget,
} from "@/components/builder/StopPublishingDialog";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	DialogBody,
	DialogClose,
	DialogFooter,
} from "@/components/shadcn/dialog";
import {
	Field,
	FieldDescription,
	FieldLabel,
	FieldLegend,
	FieldSet,
	FieldTitle,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useReconcilerContext } from "@/lib/collab/context";
import {
	baselineUnknownSentence,
	type CommCareServer,
	deploymentServerLabel,
	LOOKUP_ADOPTION_NOTE,
} from "@/lib/deployment";
import {
	type DeploymentView,
	readDeploymentsAction,
	readDownloadTargetsAction,
	type StoppedPublishingView,
} from "@/lib/deployment/actions";
import type { ProjectSpaceConfirmationChecks } from "@/lib/deployment/confirmations";
import { activeRemoteApp, nextPublishAction } from "@/lib/deployment/resources";
import {
	NEEDS_PUBLISHED_PROJECT_SPACE,
	projectSpaceLabel,
	SELECTION_HELD_FROM_HQ,
	WEB_APPS_ONLY_HAS_NO_CCZ,
} from "@/lib/deployment/runtimeTarget";
import type {
	DeploymentConfirmationKey,
	DeploymentConfirmationNeeded,
	DeploymentFailure,
	DeploymentFailureCode,
	DeploymentRemoteChange,
	DeploymentResourceConflict,
	RemoteChangeDiscard,
} from "@/lib/deployment/types";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import {
	CONNECTION_CHECK_FAILED,
	DRIFT_STOP_EDITOR_LINE,
	DRIFT_STOP_LEAVE_HEADING,
	stoppedPublishingLine,
} from "@/lib/publish/bringInCopy";
import { viewerDriftDate } from "@/lib/publish/driftReference";
import type { ExportAdvisory } from "@/lib/publish/exportAdvisories";
import {
	broughtInLine,
	hqChangesUnavailableLine,
	nextPublishChangesLine,
	nothingNewToPublishLine,
	PUBLISH_OVER_CHOSEN_LINE,
} from "@/lib/publish/hqChangesCopy";
import {
	type ManualImportStep,
	manualImportStepKey,
} from "@/lib/publish/manualImportGuide";
import {
	ACCEPT_PLACEMENT_MOVES_LABEL,
	type AcceptPlacementMoves,
	type PlacementMoveOfferView,
} from "@/lib/publish/placementMoves";
import {
	LOGO_UPLOAD_STEP_TEXT,
	PLAN_FEATURE_CONFIRM_LABEL,
	PROJECT_SPACE_SETTINGS,
} from "@/lib/publish/planFeatures";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import {
	STOP_PUBLISHING_ACTION,
	STOP_PUBLISHING_HELPER,
} from "@/lib/publish/stopPublishing";
import {
	WEB_APPS_CHANGE_HEADING,
	type WebAppsChange,
	webAppsChangeConfirmLabel,
} from "@/lib/publish/webApps";
import {
	type HqChangesBroughtIn,
	useAccessPhase,
	useCanDelete,
	useCanEdit,
	useClearHqChangedTarget,
	useNoteDeploymentRecordsChanged,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { describeApiFailure } from "@/lib/ui/apiFailure";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";
import { useInstallationChoiceLabels } from "./localization/useInstallationChoiceLabels";

type Domain = { name: string; displayName: string };
type PublishTarget = "hq" | "web" | "mobile";

const PUBLISH_TARGET_ORDER: readonly PublishTarget[] = ["hq", "web", "mobile"];
const PUBLISH_TARGET_OPTIONS = {
	hq: {
		label: "CommCare HQ",
		description: "Upload directly to a connected project space",
		icon: tablerCloudUpload,
	},
	web: {
		label: "CommCare HQ app file",
		description: "Download a ZIP to import into CommCare HQ",
		icon: tablerBrowser,
	},
	mobile: {
		label: "CommCare mobile app file",
		description:
			"Download a CCZ for CommCare Android, made for a project space this app is published to",
		icon: tablerDeviceMobile,
	},
} as const;

export type PublishDownloadOutcome =
	| {
			readonly ok: true;
			readonly projectSpaceCompatibility?: ProjectSpaceCompatibilityReport;
			/** What the file could not carry. Empty on an ordinary download. */
			readonly advisories?: readonly ExportAdvisory[];
			/** The import file's manual steps, as its README holds them. */
			readonly manualImportGuide?: readonly ManualImportStep[];
	  }
	| { readonly ok: false };

export type PublishProjectSpaceCompatibilityOutcome =
	| {
			readonly ok: true;
			readonly report: ProjectSpaceCompatibilityReport;
			/** What a publish there will ask the person to confirm. */
			readonly confirmations: ProjectSpaceConfirmationChecks;
	  }
	| { readonly ok: false; readonly message: string };

export interface PublishDialogProps {
	open: boolean;
	onClose: () => void;
	getAppId: () => string;
	availableDomains: Domain[];
	/** Which CommCare HQ installation the connected key reaches, or null
	 *  when none is configured. Matching a record to this dialog compares
	 *  the server before the domain name — US, India, and EU can hold
	 *  unrelated project spaces of the same name. */
	connectionServer: CommCareServer | null;
	canUploadToHq: boolean;
	/** A project space to open the form on — the Publishing section's
	 *  "Publish again" names its target this way. Undefined for an
	 *  ordinary open, which keeps the single-space/placeholder defaults. */
	requestedDomain?: string;
	/** The change in CommCare HQ the person chose to publish over from the
	 *  Publishing card's panel, under the digest that panel read. The dialog
	 *  opens with it in the discards it sends, so the same choice is not
	 *  asked twice. Undefined for every other open. */
	requestedDiscard?: RemoteChangeDiscard;
	/** This tab's bring-in of changes made in CommCare HQ, sent from this
	 *  dialog, that landed: the reload its commit forced closed the dialog,
	 *  which opens again on its destination step saying the changes are in.
	 *  Undefined for every other open. */
	requestedBroughtIn?: HqChangesBroughtIn;
	/** Navigate to App setup's Publishing section, the durable home of the
	 *  records this dialog summarizes. Owned by PublishPanel (a plain
	 *  History-API push) so this dialog carries no location subscription. */
	onOpenPublishing: () => void;
	isRefreshingHqConnection: boolean;
	/** True where the last Check connection could not be read. */
	hqConnectionRefreshFailed: boolean;
	onRefreshHqConnection: () => void;
	onLoadProjectSpaceCompatibility: (
		domain: string | undefined,
		signal: AbortSignal,
	) => Promise<PublishProjectSpaceCompatibilityOutcome>;
	onDownloadJson: (
		server?: CommCareServer,
		privateDomain?: string,
	) => Promise<PublishDownloadOutcome>;
	/** A CCZ is made for one project space this app is published to. */
	onDownloadCcz: (target: {
		readonly installationProfileUuid?: string;
		readonly server: CommCareServer;
		readonly domain: string;
	}) => Promise<PublishDownloadOutcome>;
}

type PublishStatus =
	| { type: "idle" }
	| { type: "uploading" }
	| { type: "downloading"; target: "web" | "mobile" }
	| {
			/* The app reached the project space on this call. The durable
			 * record itself lives in the shared deployments list, so this
			 * carries only which target to celebrate; the record keeps
			 * updating through Check status either way. */
			type: "landed";
			/** Updated in place, or created fresh; null when unanswered. */
			hqAppAction: "created" | "updated" | null;
			appUrl: string;
			warnings: string[];
			/** The App Preview line, after a publish that wrote over the app
			 *  without knowing it unchanged; null otherwise. */
			appPreviewNote: string | null;
			/** The logo the publish offers to add in CommCare HQ; null without one. */
			logoStep: PublishLogoStepBody | null;
			projectSpaceCompatibility?: ProjectSpaceCompatibilityReport;
			/** Null when the response carried no record to point at. */
			target: { server: string; domain: string } | null;
	  }
	| {
			/* This attempt was refused. The refusal is the attempt's own
			 * report; whatever durable record the target has renders once,
			 * in the shared deployments list, rather than a second copy
			 * here that would drift from it. */
			type: "refused";
			refusal: {
				code: DeploymentFailureCode;
				detail: string;
				items: readonly string[];
			};
			/** The HQ app, where the publish found it there; null otherwise. */
			hqAppUrl: string | null;
			/** What the person has to confirm about the project space. */
			confirmationsNeeded: readonly DeploymentConfirmationNeeded[];
			/** What the publish would have written over and did not. */
			resourceConflicts: readonly DeploymentResourceConflict[];
			/** What changed in CommCare HQ since Nova last published there. */
			remoteChanges: readonly DeploymentRemoteChange[];
			/** The Web Apps question, for `hq_web_apps_change`; null otherwise. */
			webAppsChange: WebAppsChange | null;
			/** The case changes Nova offers to move; null where it offers none. */
			placementMoves: PlacementMoveOfferView | null;
			installationProfileConfirmation?: string;
			installationProfileChoices?: DeploymentFailure["installationProfileChoices"];
			installationProfileReviewUrl?: string;
			warnings: string[];
			projectSpaceCompatibility?: ProjectSpaceCompatibilityReport;
	  }
	| {
			type: "download-success";
			target: "web" | "mobile";
			projectSpaceCompatibility?: ProjectSpaceCompatibilityReport;
			advisories?: readonly ExportAdvisory[];
			manualImportGuide?: readonly ManualImportStep[];
	  }
	| { type: "error"; message: string; status: number; details: string[] };

type ProjectSpaceCompatibilityState =
	| { type: "loading" }
	| {
			type: "ready";
			report: ProjectSpaceCompatibilityReport;
			/** Absent where the report came from a publish, which lists none. */
			confirmations?: ProjectSpaceConfirmationChecks;
	  }
	| { type: "error"; message: string };

function compatibilityAllowsDirectUpload(
	state: ProjectSpaceCompatibilityState,
	domain: string,
): boolean {
	return (
		state.type === "ready" &&
		state.report.target_domain === domain &&
		(state.report.status === "ready" || state.report.status === "not_needed")
	);
}

function compatibilityTargetDisplayName(
	report: ProjectSpaceCompatibilityReport | undefined,
	domains: readonly Domain[],
): string | undefined {
	const targetDomain = report?.target_domain;
	if (!targetDomain) return undefined;
	return (
		domains.find((domain) => domain.name === targetDomain)?.displayName ??
		targetDomain
	);
}

/** The deployments this app already has, loaded when the dialog opens. */
type ExistingDeployments =
	| { type: "idle" }
	| { type: "loading" }
	| { type: "ready"; views: readonly DeploymentView[] }
	| { type: "error"; message: string };

export function PublishDialogBody({
	open,
	onClose,
	getAppId,
	availableDomains,
	connectionServer,
	canUploadToHq,
	requestedDomain,
	requestedDiscard,
	requestedBroughtIn,
	onOpenPublishing,
	isRefreshingHqConnection,
	hqConnectionRefreshFailed,
	onRefreshHqConnection,
	onLoadProjectSpaceCompatibility,
	onDownloadJson,
	onDownloadCcz,
}: PublishDialogProps) {
	const accessPhase = useAccessPhase();
	const canEdit = useCanEdit();
	/* Stopping publishing is the Project's `delete`; an editor is told who
	 * can. */
	const canStop = useCanDelete();
	const session = useBuilderSessionApi();
	const applyPreviewAnswer = useApplyPreviewDeploymentAnswer();
	const reconciler = useReconcilerContext();
	const uploadControllerRef = useRef<AbortController | null>(null);
	const compatibilityControllerRef = useRef<AbortController | null>(null);
	const operationGenerationRef = useRef(0);
	const storeAppName = useAppName();
	const [reviewing, setReviewing] = useState(false);
	const bodyRef = useRef<HTMLDivElement>(null);
	const stepHeadingRef = useRef<HTMLHeadingElement>(null);
	const pendingStepFocus = useRef(false);
	const changeStep = (next: boolean) => {
		pendingStepFocus.current = true;
		if (next) setCompatibilityState({ type: "loading" });
		setReviewing(next);
	};
	// The heading exists in both steps. Focus it in this commit, before the
	// dialog recovers focus from the removed Back/Continue button on its own.
	useLayoutEffect(() => {
		if (!pendingStepFocus.current) return;
		pendingStepFocus.current = false;
		bodyRef.current?.scrollTo({ top: 0 });
		stepHeadingRef.current?.focus({ preventScroll: true });
	});
	const [target, setTarget] = useState<PublishTarget>(
		canUploadToHq ? "hq" : "web",
	);
	const [status, setStatus] = useState<PublishStatus>({ type: "idle" });
	const [appName, setAppName] = useState(storeAppName);
	const [selectedDomain, setSelectedDomain] = useState("");
	const [privateDomain, setPrivateDomain] = useState("");
	const [downloadServer, setDownloadServer] = useState<CommCareServer | "">("");
	const [downloadTargets, setDownloadTargets] = useState<DownloadTargets>({
		type: "loading",
	});
	/** The CCZ's project space, as `downloadTargetKey` spells it; "" for none chosen. */
	const [cczTargetKey, setCczTargetKey] = useState("");
	const appSettings = useAppSettings();
	const profiles = useMemo(
		() => Object.values(appSettings.installationProfiles ?? {}),
		[appSettings.installationProfiles],
	);
	const profileLabels = useInstallationChoiceLabels(profiles);

	const [selectedProfileUuid, setSelectedProfileUuid] = useState("");
	const selectedProfile = profiles.find(
		(profile) => profile.uuid === selectedProfileUuid,
	);
	/**
	 * Counts what changed where a CCZ can be made while this is open, a
	 * publish that landed, a stop and a CCZ download that was refused, so
	 * the CCZ's project spaces are read again after each.
	 */
	const [targetChanges, setTargetChanges] = useState(0);
	/**
	 * Which of the tables already on the selected project space this person
	 * has said Nova may take over.
	 *
	 * Per attempt, never remembered. Nova refuses a name clash rather than
	 * inheriting the table, and the ONLY thing that changes the answer is
	 * somebody looking at the specific table and saying yes — so the set is
	 * cleared whenever the target changes or a publish lands, and an
	 * unchanged one is never re-applied to a later publish.
	 */
	const [adoptResourceIds, setAdoptResourceIds] = useState<readonly string[]>(
		[],
	);
	/**
	 * The changes in CommCare HQ the person has said to publish over, each
	 * with the state they were shown it in.
	 *
	 * Per attempt, like the adoption list, and cleared on the same events:
	 * a tick says "write over what I saw", so it is never carried to another
	 * target, another opening of the dialog, or past the publish it was for.
	 */
	const [discardRemoteChanges, setDiscardRemoteChanges] = useState<
		readonly RemoteChangeDiscard[]
	>([]);
	/**
	 * What this person has said the selected project space has: plan
	 * features and settings no API key reads.
	 *
	 * Kept across a refused publish, because a refusal stores none of them
	 * and the next try has to send them again; cleared whenever the target
	 * changes, so an answer about acme is never sent for beta, and once a
	 * publish lands, since the deployment then holds them.
	 */
	const [confirmations, setConfirmations] = useState<
		readonly DeploymentConfirmationKey[]
	>([]);
	/**
	 * The person's answer to the Web Apps question: the value they agreed to
	 * write, or null until they tick it. Cleared wherever `confirmations` is,
	 * so an answer never outlives the question it answered.
	 */
	const [confirmInstallationProfiles, setConfirmInstallationProfiles] =
		useState<string | null>(null);
	const [confirmWebApps, setConfirmWebApps] = useState<boolean | null>(null);
	/**
	 * The move offer the person accepted, named back by its reason and the
	 * digest of the moves they were shown, or null. Cleared wherever
	 * `confirmations` is and after every response: a landed publish or a
	 * refusal that moved them recorded the moves, and any other refusal is
	 * answered afresh.
	 */
	const [acceptMoves, setAcceptMoves] = useState<AcceptPlacementMoves | null>(
		null,
	);
	/**
	 * The project space this dialog just stopped publishing to, whose line
	 * the destination step shows until the person picks anything else.
	 */
	const [stoppedDomain, setStoppedDomain] = useState<string | null>(null);
	/**
	 * The project space whose changes made in CommCare HQ this dialog just
	 * brought in, the record that answered and whether that removed changes
	 * made in Nova: the destination step says so until the person picks
	 * anything else.
	 */
	const [broughtIn, setBroughtIn] = useState<{
		readonly server: CommCareServer;
		readonly domain: string;
		readonly deployment: DeploymentView | null;
		readonly discarded: boolean;
	} | null>(null);
	const broughtInRef = useRef(broughtIn);
	broughtInRef.current = broughtIn;
	const clearHqChangedTarget = useClearHqChangedTarget();
	const uploadButtonRef = useRef<HTMLButtonElement>(null);
	const focusLater = useDeferredFocus();
	const [compatibilityState, setCompatibilityState] =
		useState<ProjectSpaceCompatibilityState>({
			type: "loading",
		});
	const consentServerRef = useRef(connectionServer);
	useLayoutEffect(() => {
		if (consentServerRef.current === connectionServer) return;
		consentServerRef.current = connectionServer;
		operationGenerationRef.current += 1;
		uploadControllerRef.current?.abort();
		compatibilityControllerRef.current?.abort();
		compatibilityControllerRef.current = null;
		setCompatibilityState({ type: "loading" });
		setStatus({ type: "idle" });
		setReviewing(false);
		setAdoptResourceIds([]);
		setDiscardRemoteChanges([]);
		setConfirmations([]);
		setConfirmInstallationProfiles(null);
		setConfirmWebApps(null);
		setAcceptMoves(null);
		setStoppedDomain(null);
		setBroughtIn(null);
	}, [connectionServer]);
	const handleClose = useCallback(() => {
		operationGenerationRef.current += 1;
		uploadControllerRef.current?.abort();
		uploadControllerRef.current = null;
		onClose();
	}, [onClose]);
	/* The durable home for everything a publish starts: full ladders, Check
	 * status, workers, and retry live in App setup's Publishing section. The
	 * dialog closes first so the section isn't opened under a modal. */
	const openPublishing = useCallback(() => {
		handleClose();
		onOpenPublishing();
	}, [handleClose, onOpenPublishing]);

	/* A reload closes the dialog. Where it shows that the changes made in
	 * CommCare HQ are in (the reload that bring-in's own commit forced, most
	 * often), the session holds that, and `PublishPanel` opens the dialog on
	 * it again once the reload lands. */
	useEffect(
		() =>
			reconciler?.subscribeProjectScopeReset(() => {
				const shown = broughtInRef.current;
				const { projectId } = session.getState();
				if (shown !== null && projectId !== undefined) {
					session.getState().holdHqChangesBroughtIn({
						home: "publish",
						server: shown.server,
						domain: shown.domain,
						projectId,
						deployment: shown.deployment,
						discarded: shown.discarded,
					});
				}
				setStatus({ type: "idle" });
				handleClose();
			}),
		[handleClose, reconciler, session],
	);
	useLayoutEffect(() => {
		if (open) return;
		operationGenerationRef.current += 1;
		compatibilityControllerRef.current?.abort();
		compatibilityControllerRef.current = null;
		uploadControllerRef.current?.abort();
		uploadControllerRef.current = null;
	}, [open]);
	useEffect(
		() => () => {
			operationGenerationRef.current += 1;
			uploadControllerRef.current?.abort();
			uploadControllerRef.current = null;
		},
		[],
	);

	const notConfigured = availableDomains.length === 0;
	const isMultiSpace = availableDomains.length > 1;
	const domainItems = useMemo(
		() =>
			availableDomains.map((domain) => ({
				label: domain.displayName,
				value: domain.name,
			})),
		[availableDomains],
	);
	const publishTargetItems = useMemo(
		() =>
			PUBLISH_TARGET_ORDER.filter(
				(candidate) => candidate !== "hq" || canUploadToHq,
			).map((candidate) => ({
				label: PUBLISH_TARGET_OPTIONS[candidate].label,
				value: candidate,
			})),
		[canUploadToHq],
	);
	const targetOption = PUBLISH_TARGET_OPTIONS[target];

	const wasOpenRef = useRef(false);
	const seenDiscardRef = useRef<RemoteChangeDiscard | undefined>(undefined);
	const seenBroughtInRef = useRef<HqChangesBroughtIn | undefined>(undefined);
	useLayoutEffect(() => {
		/* A publish over chosen on the Publishing card while this is already
		 * open (its card's dialog stands over it), or a bring-in of this tab's
		 * that landed while it is open, opens it afresh, as a closed dialog
		 * would open. */
		const newDiscard =
			requestedDiscard !== undefined &&
			requestedDiscard !== seenDiscardRef.current;
		seenDiscardRef.current = requestedDiscard;
		const newBroughtIn =
			requestedBroughtIn !== undefined &&
			requestedBroughtIn !== seenBroughtInRef.current;
		seenBroughtInRef.current = requestedBroughtIn;
		const justOpened =
			open && (!wasOpenRef.current || newDiscard || newBroughtIn);
		wasOpenRef.current = open;
		if (!justOpened) return;
		setReviewing(false);
		setAdoptResourceIds([]);
		/* A publish over a change chosen on the Publishing card is made here,
		 * under the digest of the source its panel read. */
		setDiscardRemoteChanges(
			requestedDiscard !== undefined ? [requestedDiscard] : [],
		);
		setConfirmations([]);
		setConfirmInstallationProfiles(null);
		setConfirmWebApps(null);
		setAcceptMoves(null);
		setStoppedDomain(null);
		setBroughtIn(
			requestedBroughtIn !== undefined
				? {
						server: requestedBroughtIn.server,
						domain: requestedBroughtIn.domain,
						deployment: requestedBroughtIn.deployment,
						discarded: requestedBroughtIn.discarded,
					}
				: null,
		);
		operationGenerationRef.current += 1;
		setStatus({ type: "idle" });
		setDownloadTargets({ type: "loading" });
		setCczTargetKey("");
		setCompatibilityState({ type: "loading" });
		setTarget(canUploadToHq ? "hq" : "web");
		setAppName(storeAppName);
		setSelectedDomain(
			preseededDomainSelection(requestedDomain, availableDomains),
		);
	}, [
		open,
		storeAppName,
		availableDomains,
		canUploadToHq,
		requestedDomain,
		requestedDiscard,
		requestedBroughtIn,
	]);

	/* Where the app already stands, loaded whenever this opens. The record
	 * outlives the publish that created it: somebody who published, made
	 * the build on CommCare HQ, and came back tomorrow needs Check status,
	 * and without this the only way to reach it would be publishing the
	 * app all over again just to see where things stand. These records are
	 * also what tells the form below whether the selected project space
	 * gets an in-place update or a fresh app. */
	const [existing, setExisting] = useState<ExistingDeployments>({
		type: "idle",
	});
	useEffect(() => {
		if (!open || !canUploadToHq) return;
		let live = true;
		setExisting({ type: "loading" });
		/* A rejected Server Action must land in this dialog's own error slot.
		 * Without the catch it is an unhandled rejection and the panel sits
		 * on "loading" forever, which reads as "you have published nowhere". */
		void readDeploymentsAction(getAppId())
			.then((result) => {
				if (!live) return;
				setExisting(
					result.success
						? { type: "ready", views: result.data }
						: { type: "error", message: result.message },
				);
			})
			.catch(() => {
				if (!live) return;
				setExisting({
					type: "error",
					message:
						"Nova couldn't load where this app has been published. Close and reopen to try again.",
				});
			});
		return () => {
			live = false;
		};
	}, [open, canUploadToHq, getAppId]);
	/* Which project spaces a CCZ can be made for: the same ledger read, the
	 * same lines and the same standing of each space the download itself
	 * answers from, so the dialog never offers a space the download would
	 * refuse, and says why a space has no CCZ before anyone chooses it. It is
	 * read when this opens and again after each publish that lands, since
	 * that publish can be what puts the app on a space, and after each stop,
	 * which takes one away (`cczTargetsModel.ts::cczPickAfterRead`). */
	useEffect(() => {
		if (!open) return;
		void targetChanges;
		let live = true;
		void readDownloadTargetsAction(getAppId())
			.then((result) => {
				if (!live) return;
				if (!result.success) {
					setDownloadTargets({ type: "error", message: result.message });
					return;
				}
				setDownloadTargets({ type: "ready", view: result.data });
				setCczTargetKey((current) => cczPickAfterRead(result.data, current));
			})
			.catch(() => {
				if (!live) return;
				setDownloadTargets({
					type: "error",
					message:
						"Nova couldn't load where this app is published. Close and reopen to try again.",
				});
			});
		return () => {
			live = false;
		};
	}, [open, getAppId, targetChanges]);
	const cczTarget = chosenCczTarget(downloadTargets, cczTargetKey);

	/* ONE store for the records, keyed by target. The open-time read seeds
	 * it, a publish response upserts into it, and Check status upserts into
	 * it, so a record can never render twice with disagreeing contents,
	 * and a fresh deployment survives every status reset (switching the
	 * destination select and back must not make a landed publish vanish;
	 * the author would have to publish again just to see it). The fold is
	 * the shared `upsertDeploymentViews`, the same one the Publishing
	 * section applies, so the two surfaces cannot disagree about identity.
	 * Each write also bumps the session's records revision, which is what
	 * tells a mounted Publishing section to reload. */
	const noteDeploymentRecordsChanged = useNoteDeploymentRecordsChanged();
	const upsertView = useCallback(
		(next: DeploymentView) => {
			setExisting((current) => ({
				type: "ready",
				views: upsertDeploymentViews(
					current.type === "ready" ? current.views : [],
					next,
				),
			}));
			noteDeploymentRecordsChanged();
		},
		[noteDeploymentRecordsChanged],
	);
	/* A publish response's record, each list it left out unread kept as the
	 * held record shows it (`publishedViewToHold`). */
	const upsertPublishedView = useCallback(
		(next: PublishedDeploymentView) => {
			setExisting((current) => {
				const views = current.type === "ready" ? current.views : [];
				return {
					type: "ready",
					views: upsertDeploymentViews(views, publishedViewToHold(views, next)),
				};
			});
			noteDeploymentRecordsChanged();
		},
		[noteDeploymentRecordsChanged],
	);
	/* Every refresh answers with the record AND what Preview may now name,
	 * with what that project space keeps of the settings Preview plays,
	 * because an observation can change all three. */
	const handleRefreshed = useCallback(
		(next: ShownRefreshedView) => {
			upsertView(next);
			applyPreviewAnswer(next.preview);
		},
		[upsertView, applyPreviewAnswer],
	);
	/* Stopping publishing at a change made in CommCare HQ answers the
	 * refusal another way: the refusal and every tick go, the dialog returns
	 * to its destination step saying so, the plan line there reads off the
	 * ended record (`creates-beside`), and the CCZ's project spaces are read
	 * again, since the stopped one is no longer among them. A project space
	 * Nova no longer publishes to has nothing changed in CommCare HQ to
	 * offer, so the header's offer for it goes. */
	const settleStopped = useCallback(
		(target: { readonly server: CommCareServer; readonly domain: string }) => {
			operationGenerationRef.current += 1;
			setStatus({ type: "idle" });
			setAdoptResourceIds([]);
			setDiscardRemoteChanges([]);
			setConfirmations([]);
			setConfirmInstallationProfiles(null);
			setConfirmWebApps(null);
			setAcceptMoves(null);
			setStoppedDomain(target.domain);
			setBroughtIn(null);
			setTargetChanges((count) => count + 1);
			clearHqChangedTarget(target);
			pendingStepFocus.current = true;
			setReviewing(false);
		},
		[clearHqChangedTarget],
	);
	/* Where the app stands, read again after a stop that answered no record,
	 * or no stop at all: an answer lost on the way may follow a stop that
	 * landed. A record that now shows the deployment ended settles the stop
	 * as its answer would have, unless the person has moved on since. */
	const readRecordsAfterStop = useCallback(
		(
			target: { readonly server: CommCareServer; readonly domain: string },
			settleIfEnded: boolean,
		) => {
			const generation = operationGenerationRef.current;
			void readDeploymentsAction(getAppId())
				.then((result) => {
					if (!result.success) return;
					setExisting({ type: "ready", views: result.data });
					noteDeploymentRecordsChanged();
					const view = result.data.find(
						(candidate) =>
							candidate.deployment.deployment.server === target.server &&
							candidate.deployment.deployment.domain === target.domain,
					);
					if (
						settleIfEnded &&
						operationGenerationRef.current === generation &&
						view !== undefined &&
						cardKind(view) === "ended"
					) {
						settleStopped(target);
					}
				})
				/* The records on screen stay; the next opening reads them. */
				.catch(() => {});
		},
		[getAppId, noteDeploymentRecordsChanged, settleStopped],
	);
	/* The stop's answer was read on the server after the ending landed, the
	 * Preview answer included, so it is applied as it came, whichever of it
	 * and the stream's frames arrives last. */
	const handleStopped = useCallback(
		(
			next: StoppedPublishingView,
			target: { readonly server: CommCareServer; readonly domain: string },
		) => {
			if (next.view !== null) upsertView(next.view);
			applyPreviewAnswer(next.preview);
			settleStopped(target);
			if (next.view === null) readRecordsAfterStop(target, false);
		},
		[upsertView, applyPreviewAnswer, settleStopped, readRecordsAfterStop],
	);
	const handleStopUnanswered = useCallback(
		(target: { readonly server: CommCareServer; readonly domain: string }) =>
			readRecordsAfterStop(target, true),
		[readRecordsAfterStop],
	);
	/* The same two answers from the changes made in CommCare HQ panel's own
	 * Stop publishing here, on the project space the refusal names. */
	const handlePanelStopped = useCallback(
		(next: StoppedPublishingView) => {
			if (connectionServer === null) return;
			handleStopped(next, { server: connectionServer, domain: selectedDomain });
		},
		[connectionServer, selectedDomain, handleStopped],
	);
	const handlePanelStopUnanswered = useCallback(() => {
		if (connectionServer === null) return;
		handleStopUnanswered({ server: connectionServer, domain: selectedDomain });
	}, [connectionServer, selectedDomain, handleStopUnanswered]);

	/* What publishing to the selected project space will do. The SAME
	 * predicate the publish lifecycle applies server-side
	 * (`nextPublishAction`), read off the records this dialog already
	 * loads, so the form's blurb promises exactly what the request that
	 * follows will do — and "unknown" while the records are loading, when
	 * the read failed, or before a domain is picked, because a claim made
	 * in those windows would be a guess the upload could contradict. */
	const selectedView =
		existing.type !== "ready" || selectedDomain === ""
			? null
			: (existing.views.find(
					(view) =>
						/* The server half matters: a record for a same-named
						 * space on another CommCare HQ installation says nothing
						 * about what this upload will do. */
						view.deployment.deployment.server === connectionServer &&
						view.deployment.deployment.domain === selectedDomain,
				) ?? null);
	const publishPlan: PublishPlan =
		existing.type !== "ready" || selectedDomain === ""
			? "unknown"
			: nextPublishAction(selectedView?.deployment ?? null);
	/* A new app here is a second copy where the app was brought in from
	 * another project space, which the plan line says. */
	const publishPlanContext = {
		broughtInElsewhere:
			existing.type === "ready" &&
			connectionServer !== null &&
			selectedDomain !== "" &&
			broughtInElsewhere(existing.views, {
				server: connectionServer,
				domain: selectedDomain,
			}),
	};

	const compatibilityDomain =
		target === "hq"
			? selectedDomain ||
				(availableDomains.length === 1 ? availableDomains[0].name : undefined)
			: undefined;
	const loadProjectSpaceCompatibility = useCallback(() => {
		compatibilityControllerRef.current?.abort();
		const controller = new AbortController();
		compatibilityControllerRef.current = controller;
		setCompatibilityState({ type: "loading" });
		void onLoadProjectSpaceCompatibility(
			compatibilityDomain,
			controller.signal,
		).then((outcome) => {
			if (compatibilityControllerRef.current !== controller) return;
			compatibilityControllerRef.current = null;
			setCompatibilityState(
				outcome.ok
					? {
							type: "ready",
							report: outcome.report,
							confirmations: outcome.confirmations,
						}
					: { type: "error", message: outcome.message },
			);
		});
	}, [compatibilityDomain, onLoadProjectSpaceCompatibility]);
	const shouldLoadCompatibility =
		reviewing && (target !== "hq" || Boolean(compatibilityDomain));
	useEffect(() => {
		if (!open || !shouldLoadCompatibility) {
			compatibilityControllerRef.current?.abort();
			compatibilityControllerRef.current = null;
			return;
		}
		// A same-named space on a different HQ server is a different target.
		void connectionServer;
		loadProjectSpaceCompatibility();
		return () => {
			compatibilityControllerRef.current?.abort();
			compatibilityControllerRef.current = null;
		};
	}, [
		open,
		connectionServer,
		loadProjectSpaceCompatibility,
		shouldLoadCompatibility,
	]);

	const invalidateCompatibilityReport = useCallback(() => {
		const controller = compatibilityControllerRef.current;
		compatibilityControllerRef.current = null;
		controller?.abort();
		setCompatibilityState({ type: "loading" });
	}, []);
	const handleTargetChange = useCallback(
		(next: PublishTarget) => {
			const nextDomain =
				next === "hq"
					? selectedDomain ||
						(availableDomains.length === 1
							? availableDomains[0].name
							: undefined)
					: undefined;
			if (nextDomain !== compatibilityDomain) invalidateCompatibilityReport();
			operationGenerationRef.current += 1;
			setAdoptResourceIds([]);
			setDiscardRemoteChanges([]);
			setConfirmations([]);
			setConfirmInstallationProfiles(null);
			setConfirmWebApps(null);
			setAcceptMoves(null);
			setStoppedDomain(null);
			setBroughtIn(null);
			setTarget(next);
			setReviewing(false);
			setStatus({ type: "idle" });
		},
		[
			availableDomains,
			compatibilityDomain,
			invalidateCompatibilityReport,
			selectedDomain,
		],
	);
	const handleSelectedDomainChange = useCallback(
		(next: string) => {
			if (next !== compatibilityDomain) invalidateCompatibilityReport();
			operationGenerationRef.current += 1;
			setSelectedDomain(next);
			setReviewing(false);
			setStatus({ type: "idle" });
			/* A choice about acme's tables says nothing about beta's. */
			setAdoptResourceIds([]);
			setDiscardRemoteChanges([]);
			setConfirmations([]);
			setConfirmInstallationProfiles(null);
			setConfirmWebApps(null);
			setAcceptMoves(null);
			setStoppedDomain(null);
			setBroughtIn(null);
		},
		[compatibilityDomain, invalidateCompatibilityReport],
	);
	// A refreshed connection can remove the selected space without a user
	// changing the select. Retire its report and consent through the same path.
	useLayoutEffect(() => {
		if (
			!open ||
			availableDomains.some((domain) => domain.name === selectedDomain)
		)
			return;
		const next = availableDomains.length === 1 ? availableDomains[0].name : "";
		if (next === selectedDomain) return;
		if (selectedDomain === "") {
			/* Nothing was chosen, so no choice of another project space is
			 * left to retire: this only takes the one space there is. It runs
			 * in the commit that opens the dialog too, whose seed (a publish
			 * over chosen on a card, a bring-in that landed) it must keep. */
			if (next !== compatibilityDomain) invalidateCompatibilityReport();
			setSelectedDomain(next);
			return;
		}
		handleSelectedDomainChange(next);
	}, [
		open,
		availableDomains,
		selectedDomain,
		handleSelectedDomainChange,
		compatibilityDomain,
		invalidateCompatibilityReport,
	]);

	const handleAdoptChange = useCallback(
		(novaResourceId: string, adopt: boolean) => {
			setAdoptResourceIds((current) =>
				adopt
					? current.includes(novaResourceId)
						? current
						: [...current, novaResourceId]
					: current.filter((id) => id !== novaResourceId),
			);
		},
		[],
	);
	const handleDiscardChange = useCallback(
		(change: DeploymentRemoteChange, discard: boolean) => {
			setDiscardRemoteChanges((current) => {
				const rest = current.filter(
					(entry) => !sameRemoteChange(entry, change),
				);
				return discard
					? [
							...rest,
							{
								kind: change.kind,
								novaResourceId: change.novaResourceId,
								observedDigest: change.observedDigest,
							},
						]
					: rest;
			});
		},
		[],
	);
	/* A Save to Case move and "This project space has it" for Save to Case
	 * answer one question, so ticking one unticks the other. */
	const handleConfirmChange = useCallback(
		(key: DeploymentConfirmationKey, confirmed: boolean) => {
			const next = withConfirmation(
				{ confirmations, acceptMoves },
				key,
				confirmed,
			);
			setConfirmations(next.confirmations);
			setAcceptMoves(next.acceptMoves);
		},
		[confirmations, acceptMoves],
	);
	const handleAcceptMovesChange = useCallback(
		(offer: PlacementMoveOfferView, accepted: boolean) => {
			const next = withAcceptedMoves(
				{ confirmations, acceptMoves },
				offer,
				accepted,
			);
			setConfirmations(next.confirmations);
			setAcceptMoves(next.acceptMoves);
		},
		[confirmations, acceptMoves],
	);
	const handleCheckCompatibilityAgain = useCallback(() => {
		setStatus((current) =>
			current.type === "refused" &&
			current.projectSpaceCompatibility?.status === "blocked"
				? { type: "idle" }
				: current,
		);
		loadProjectSpaceCompatibility();
	}, [loadProjectSpaceCompatibility]);

	const handleUpload = useCallback(async () => {
		if (
			!selectedDomain ||
			!appName.trim() ||
			!compatibilityAllowsDirectUpload(compatibilityState, selectedDomain)
		)
			return;
		const generation = ++operationGenerationRef.current;
		const start = session.getState();
		if (start.accessPhase !== "authorized" || !start.canEdit) return;
		const uploadScopeEpoch = start.scopeEpoch;
		const isCurrent = () => {
			const current = session.getState();
			return (
				operationGenerationRef.current === generation &&
				current.accessPhase === "authorized" &&
				current.canEdit &&
				current.scopeEpoch === uploadScopeEpoch
			);
		};
		uploadControllerRef.current?.abort();
		const controller = new AbortController();
		uploadControllerRef.current = controller;
		/* The space this request publishes to, whatever is selected by the
		 * time it answers. */
		const publishedDomain = selectedDomain;
		const publishedServer = connectionServer;
		setStatus({ type: "uploading" });
		setStoppedDomain(null);
		setBroughtIn(null);

		try {
			const saved = await reconciler?.reconciler.waitForHumanSaveBarrier();
			if (!isCurrent() || controller.signal.aborted) return;
			if (saved?.kind !== "saved") {
				setStatus({
					type: "error",
					message:
						"Nova hasn't finished saving your latest changes. You can try again once they're saved.",
					details: [],
					status: 409,
				});
				return;
			}
			const response = await fetch("/api/commcare/upload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					domain: publishedDomain,
					appName: appName.trim(),
					appId: getAppId(),
					adopt_resources: adoptResourceIds,
					discard_remote_changes: discardRemoteChanges,
					confirm: confirmations,
					...(confirmWebApps !== null && { confirmWebApps }),
					...(confirmInstallationProfiles && { confirmInstallationProfiles }),
					...(acceptMoves !== null && { acceptPlacementMoves: acceptMoves }),
					/* The reader's own day for a sentence that names when the app
					 * was brought in, the same values this dialog's own sentences
					 * use. */
					viewer: viewerDriftDate(),
				}),
				signal: controller.signal,
			});
			if (!isCurrent()) {
				void response.body?.cancel();
				return;
			}
			const data = (await response.json()) as Parameters<
				typeof publishOutcome
			>[1] & {
				project_space_compatibility?: ProjectSpaceCompatibilityReport | null;
			};
			if (!isCurrent()) return;
			const serverCompatibility = data.project_space_compatibility ?? undefined;
			/* The publish-time probe is newer authority than the disclosure check
			 * that enabled the button. Keep its exact answer as the browser gate so
			 * a target that changed between those requests cannot be submitted again
			 * until a person explicitly checks it again. A null report means an
			 * earlier preflight refused the attempt before compatibility was checked,
			 * so the earlier answer remains the gate for a corrected retry. */
			if (serverCompatibility !== undefined) {
				setCompatibilityState((current) => ({
					type: "ready",
					report: serverCompatibility,
					/* A publish lists no confirmations; what the check listed
					 * still stands for the same project space. */
					confirmations:
						current.type === "ready" &&
						current.report.target_domain === serverCompatibility.target_domain
							? current.confirmations
							: undefined,
				}));
			}

			/* One pure decision, kept out of here because getting it wrong is
			 * invisible in a screenshot: a refused publish must show its
			 * refusal and record, not a generic failure box. */
			const outcome = publishOutcome(response.ok, data);
			/* An accepted move answers the offer one publish made: a landed
			 * publish, or a refusal that moved them, recorded the moves, and
			 * any other answer is asked afresh. */
			setAcceptMoves(null);
			if (outcome.kind === "failure") {
				const failure = describeApiFailure(
					data,
					`Upload failed (HTTP ${response.status})`,
				);
				setStatus({
					type: "error",
					message: outcome.blockedDetail ?? failure.message,
					status: response.status,
					details: failure.details,
				});
				return;
			}

			/* Preview names whatever the SERVER says it may. Only the server
			 * can see whether this app is now live on more than one project
			 * space, which is when `commcare_project` has two real answers
			 * and Nova must name neither; a client asserting the space it
			 * just used would make a condition pass here and fail for half
			 * the workers until the next reload withdrew it. A refusal's
			 * answer applies too: this call is the freshest word either way. */
			applyPreviewAnswer(outcome.preview);
			if (outcome.kind === "landed") {
				if (outcome.deployment !== null)
					upsertPublishedView(outcome.deployment);
				/* The publish landed there, so the header's offer for it goes,
				 * whether or not the record could be read back. */
				if (publishedServer !== null) {
					clearHqChangedTarget({
						server: publishedServer,
						domain: publishedDomain,
					});
				}
				/* The check's rows were read before this publish stored what
				 * was ticked; read them as the deployment holds them now, so
				 * publishing again from here asks only what is unanswered. */
				const landedRecord = outcome.deployment?.deployment;
				if (landedRecord !== undefined) {
					setCompatibilityState((current) =>
						current.type === "ready" &&
						current.confirmations !== undefined &&
						current.report.target_domain === landedRecord.deployment.domain
							? {
									...current,
									confirmations: withLandedConfirmations(
										current.confirmations,
										landedRecord.confirmations,
									),
								}
							: current,
					);
				}
				/* Taking a table over happened; the ledger remembers it now, so
				 * the next publish must not re-assert a choice nobody made
				 * again. */
				setAdoptResourceIds([]);
				setDiscardRemoteChanges([]);
				/* The deployment holds what was confirmed from now on. */
				setConfirmations([]);
				setConfirmInstallationProfiles(null);
				setConfirmWebApps(null);
				setTargetChanges((count) => count + 1);
				const record = outcome.deployment?.deployment.deployment;
				setStatus({
					type: "landed",
					hqAppAction: outcome.hqAppAction,
					appUrl: outcome.appUrl,
					warnings: outcome.warnings,
					appPreviewNote: outcome.appPreviewNote,
					logoStep: outcome.logoStep,
					projectSpaceCompatibility: serverCompatibility,
					target:
						record === undefined
							? null
							: { server: record.server, domain: record.domain },
				});
				return;
			}
			if (outcome.deployment !== null) upsertPublishedView(outcome.deployment);
			/* A tick confirms one state of one resource. A refusal that lists
			 * a resource again with another state asks afresh, so only ticks
			 * still naming a listed change in the state shown now survive. */
			setDiscardRemoteChanges((current) =>
				current.filter((entry) =>
					outcome.remoteChanges.some((change) =>
						sameRemoteChange(entry, change),
					),
				),
			);
			/* An answer to the Web Apps question answers that question alone:
			 * kept only where the refusal asks the same thing again. */
			setConfirmWebApps((current) =>
				outcome.webAppsChange !== null && current === outcome.webAppsChange.to
					? current
					: null,
			);
			/* HQ's create answered the plan question from the plan, so the
			 * person's `web-apps` answer is withdrawn: untick it, and read the
			 * pre-publish check again so its row comes back unticked beside
			 * the refusal. */
			if (outcome.refusal.code === "hq_plan_lacks_web_apps") {
				setConfirmations((current) =>
					current.filter(
						(entry) =>
							!sameConfirmationKey(entry, {
								kind: "plan-feature",
								subject: "web-apps",
							}),
					),
				);
				loadProjectSpaceCompatibility();
			}
			setStatus({
				type: "refused",
				refusal: {
					code: outcome.refusal.code,
					detail: outcome.refusal.message,
					items: outcome.refusal.items,
				},
				hqAppUrl: outcome.hqAppUrl,
				confirmationsNeeded: outcome.confirmationsNeeded,
				resourceConflicts: outcome.resourceConflicts,
				remoteChanges: outcome.remoteChanges,
				webAppsChange: outcome.webAppsChange,
				placementMoves: outcome.placementMoves,
				installationProfileChoices: outcome.installationProfileChoices,
				installationProfileConfirmation:
					outcome.installationProfileConfirmation,
				installationProfileReviewUrl: outcome.installationProfileReviewUrl,
				warnings: outcome.warnings,
				projectSpaceCompatibility: serverCompatibility,
			});
		} catch (error) {
			if (
				controller.signal.aborted ||
				!isCurrent() ||
				(error instanceof DOMException && error.name === "AbortError")
			)
				return;
			setStatus({
				type: "error",
				message:
					"The upload didn't finish. Check your connection and try again",
				status: 0,
				details: [],
			});
		} finally {
			if (uploadControllerRef.current === controller) {
				uploadControllerRef.current = null;
			}
		}
	}, [
		adoptResourceIds,
		discardRemoteChanges,
		confirmations,
		confirmInstallationProfiles,
		confirmWebApps,
		acceptMoves,
		compatibilityState,
		loadProjectSpaceCompatibility,
		selectedDomain,
		appName,
		getAppId,
		session,
		applyPreviewAnswer,
		upsertPublishedView,
		clearHqChangedTarget,
		reconciler,
		connectionServer,
	]);

	/* The panel's answers reach the latest publish, whatever render made them. */
	const handleUploadRef = useRef(handleUpload);
	handleUploadRef.current = handleUpload;

	/* What the changes made in CommCare HQ panel settling means here. */
	const handleHqChangesSettled = useCallback(
		(settled: HqChangesSettled) => {
			/* The refusal clears and the destination step says the changes are
			 * in. The bring-in's commit reloads the app in this tab too, which
			 * closes the dialog; it opens again on this once the reload lands. */
			if (connectionServer !== null) {
				clearHqChangedTarget({
					server: connectionServer,
					domain: selectedDomain,
				});
			}
			if (settled.kind === "brought-in") {
				if (settled.deployment !== null) upsertView(settled.deployment);
				operationGenerationRef.current += 1;
				setStatus({ type: "idle" });
				setDiscardRemoteChanges([]);
				if (connectionServer !== null) {
					setBroughtIn({
						server: connectionServer,
						domain: selectedDomain,
						deployment: settled.deployment,
						discarded: settled.discarded,
					});
				}
				pendingStepFocus.current = true;
				setReviewing(false);
				return;
			}
			if (settled.deployment !== null) upsertView(settled.deployment);
			if (settled.publishChanges.length === 0) {
				/* Nothing to bring in and nothing the next publish changes: the
				 * publish goes ahead by itself, with no tick and no discard. */
				void handleUploadRef.current();
				return;
			}
			/* The review step shows what this publish changes; the person
			 * presses Publish. */
			operationGenerationRef.current += 1;
			setStatus({ type: "idle" });
		},
		[connectionServer, selectedDomain, clearHqChangedTarget, upsertView],
	);
	/* The panel's Publish over CommCare HQ's changes: the item's tick, and
	 * focus on the footer button that publishes over them. */
	const handleHqChangesPublishOver = useCallback(
		(discard: RemoteChangeDiscard) => {
			setDiscardRemoteChanges((current) => [
				...current.filter((entry) => !sameRemoteResource(entry, discard)),
				discard,
			]);
			focusLater(() => uploadButtonRef.current?.focus());
		},
		[focusLater],
	);

	const handleDownload = useCallback(
		async (downloadTarget: "web" | "mobile") => {
			/* A CCZ is made for one project space; the button stays off until
			 * one is chosen, so there is nothing to send without it. */
			if (downloadTarget === "mobile" && cczTarget === null) return;
			const generation = ++operationGenerationRef.current;
			setStatus({ type: "downloading", target: downloadTarget });
			const outcome = await (cczTarget !== null && downloadTarget === "mobile"
				? onDownloadCcz({
						...cczTarget,
						...(selectedProfile && {
							installationProfileUuid: selectedProfile.uuid,
						}),
					})
				: onDownloadJson(
						privateDomain
							? (connectionServer ?? undefined)
							: downloadServer || undefined,
						privateDomain || undefined,
					));
			if (operationGenerationRef.current !== generation) return;
			if (!outcome.ok) {
				setStatus({ type: "idle" });
				/* A CCZ the download refused may be one the project space's
				 * facts stopped allowing since the list was read, so the list
				 * is read again and the person meets the project spaces once
				 * more, each as the download found it. */
				if (downloadTarget === "mobile") {
					setTargetChanges((n) => n + 1);
					pendingStepFocus.current = true;
					setReviewing(false);
				}
				return;
			}
			setStatus({
				type: "download-success",
				target: downloadTarget,
				projectSpaceCompatibility: outcome.projectSpaceCompatibility,
				advisories: outcome.advisories,
				manualImportGuide: outcome.manualImportGuide,
			});
		},
		[
			onDownloadCcz,
			onDownloadJson,
			downloadServer,
			cczTarget,
			selectedProfile,
			privateDomain,
			connectionServer,
		],
	);

	const isWorking =
		status.type === "uploading" || status.type === "downloading";
	const compatibilityAllowsUpload = compatibilityAllowsDirectUpload(
		compatibilityState,
		selectedDomain,
	);
	/* Every change a refusal listed has to be ticked before publishing over
	 * them can work: one left unconfirmed stops the whole publish again. */
	const remoteChangesToConfirm =
		status.type === "refused" ? status.remoteChanges : [];
	/* Opened from the Publishing card with its publish over still held. */
	const publishOverChosen =
		requestedDiscard !== undefined &&
		status.type !== "refused" &&
		discardRemoteChanges.some((entry) =>
			sameRemoteChange(entry, requestedDiscard),
		);
	const allRemoteChangesConfirmed = remoteChangesToConfirm.every((change) =>
		discardRemoteChanges.some((entry) => confirmsRemoteChange(entry, change)),
	);
	/* What the person has to confirm about the selected project space: the
	 * rows the check listed before the first press, and any a refusal named
	 * since. Publish stays unavailable until each is ticked. */
	const requestedConfirmations =
		target === "hq" && status.type !== "landed"
			? confirmationRequests(
					compatibilityState.type === "ready" &&
						compatibilityState.report.target_domain === selectedDomain
						? (compatibilityState.confirmations ?? null)
						: null,
					status.type === "refused" ? status.confirmationsNeeded : [],
				)
			: [];
	/* An accepted Save to Case move is the other answer to the Save to Case
	 * row, so that row no longer holds Upload. */
	const allConfirmationsGiven = everyConfirmationGiven(
		confirmationsStillAsked(requestedConfirmations, acceptMoves),
		confirmations,
	);
	/* A Web Apps question holds Upload until it is ticked, as an unticked
	 * confirmation row does. */
	const webAppsAnswered =
		status.type !== "refused" ||
		status.webAppsChange === null ||
		confirmWebApps === status.webAppsChange.to;
	const canUpload =
		canEdit &&
		canUploadToHq &&
		!notConfigured &&
		!!selectedDomain &&
		!isWorking &&
		compatibilityAllowsUpload &&
		allRemoteChangesConfirmed &&
		allConfirmationsGiven &&
		webAppsAnswered &&
		appName.trim().length > 0;
	const downloadTarget = target === "mobile" ? "mobile" : "web";
	const downloadComplete =
		status.type === "download-success" && status.target === downloadTarget;
	const complete = status.type === "landed" || downloadComplete;
	const chooseAnotherDestination = () => {
		setStatus({ type: "idle" });
		changeStep(false);
	};
	const mobileUnavailable =
		target === "mobile" && cczHasNoChoice(downloadTargets);
	const canReview =
		target === "hq"
			? !notConfigured && Boolean(selectedDomain) && appName.trim().length > 0
			: target !== "mobile" || cczTarget !== null;
	const showCompatibilityPreflight =
		status.type !== "landed" &&
		!downloadComplete &&
		(target !== "hq" || (!notConfigured && Boolean(selectedDomain)));
	/* The landed hero celebrates ONE target; its record renders from the
	 * shared store so Check status keeps updating the same copy everyone
	 * else sees. */
	const landedTarget = status.type === "landed" ? status.target : null;
	const landedView =
		landedTarget !== null && existing.type === "ready"
			? (existing.views.find(
					(view) =>
						view.deployment.deployment.server === landedTarget.server &&
						view.deployment.deployment.domain === landedTarget.domain,
				) ?? null)
			: null;

	if (accessPhase !== "authorized") return null;

	return (
		<>
			<DialogBody ref={bodyRef} className="mx-0 px-5 py-4">
				<h3
					ref={stepHeadingRef}
					tabIndex={-1}
					className="mb-4 text-sm font-semibold outline-none"
				>
					{complete
						? "Next steps"
						: reviewing
							? "Review and publish"
							: "Choose a destination"}
				</h3>
				{!reviewing && !complete ? (
					<div className="space-y-5">
						<Field className="gap-1.5">
							<FieldLabel id="publish-target-label" htmlFor="publish-target">
								Publish option
							</FieldLabel>
							<Select
								items={publishTargetItems}
								value={target}
								onValueChange={(value) =>
									value && handleTargetChange(value as PublishTarget)
								}
								disabled={isWorking}
							>
								<SelectTrigger
									id="publish-target"
									className="w-full"
									aria-labelledby="publish-target-label"
									aria-describedby="publish-target-description"
								>
									<SelectValue className="min-w-0">
										<span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
											<Icon icon={targetOption.icon} className="size-4" />
											<span className="truncate">{targetOption.label}</span>
										</span>
									</SelectValue>
								</SelectTrigger>
								<SelectContent align="start">
									{PUBLISH_TARGET_ORDER.map((candidate) => {
										if (candidate === "hq" && !canUploadToHq) return null;
										const option = PUBLISH_TARGET_OPTIONS[candidate];
										return (
											<SelectItem
												key={candidate}
												value={candidate}
												aria-labelledby={`publish-target-${candidate}-label`}
												aria-describedby={`publish-target-${candidate}-description`}
												wrap
											>
												<Icon icon={option.icon} className="mt-0.5 size-4" />
												<span className="min-w-0">
													<span
														id={`publish-target-${candidate}-label`}
														className="block text-sm font-medium text-nova-text"
													>
														{option.label}
													</span>
													<span
														id={`publish-target-${candidate}-description`}
														className="mt-0.5 block text-xs leading-snug text-nova-text-muted"
													>
														{option.description}
													</span>
												</span>
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
							<FieldDescription id="publish-target-description">
								{targetOption.description}
							</FieldDescription>
						</Field>

						{target === "web" && (
							<Field className="mt-4 gap-1.5">
								<FieldLabel htmlFor="download-server">
									CommCare HQ server
								</FieldLabel>
								<Select
									value={
										privateDomain ? (connectionServer ?? "") : downloadServer
									}
									items={[
										{ value: "", label: "Use published destination" },
										...(["production", "india", "eu"] as const).map(
											(value) => ({
												value,
												label: deploymentServerLabel(value),
											}),
										),
									]}
									onValueChange={(value) => {
										setDownloadServer((value ?? "") as CommCareServer | "");
										setStatus({ type: "idle" });
									}}
									disabled={isWorking || Boolean(privateDomain)}
								>
									<SelectTrigger id="download-server">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="">Use published destination</SelectItem>
										{(["production", "india", "eu"] as const).map((value) => (
											<SelectItem key={value} value={value}>
												{deploymentServerLabel(value)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FieldDescription>
									The file works in any project space. Links to captured files
									point at the project space this app is published to on the
									server you choose, and a single published destination supplies
									it for you.
								</FieldDescription>
							</Field>
						)}
						{target === "web" &&
							canEdit &&
							connectionServer &&
							availableDomains.length > 0 && (
								<Field className="mt-4 gap-1.5">
									<FieldLabel htmlFor="download-private-data">
										Worker assignments
									</FieldLabel>
									<Select
										value={privateDomain}
										items={[
											{ value: "", label: "Connect data after importing" },
											...availableDomains.map((d) => ({
												value: d.name,
												label: d.name,
											})),
										]}
										onValueChange={(val) => {
											setPrivateDomain(val ?? "");
											setStatus({ type: "idle" });
										}}
										disabled={isWorking}
									>
										<SelectTrigger id="download-private-data">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="">
												Connect data after importing
											</SelectItem>
											{availableDomains.map((d) => (
												<SelectItem key={d.name} value={d.name}>
													{d.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FieldDescription>
										Choose a project space to include its verified worker
										assignments in a private download.
									</FieldDescription>
								</Field>
							)}
						{target === "mobile" &&
							appSettings.runsOnlyOn !== "web-apps" &&
							cczTarget !== null &&
							!downloadComplete &&
							profiles.length > 0 && (
								<Field>
									<FieldLabel htmlFor="install-profile">
										Installation profile
									</FieldLabel>
									<Select
										disabled={isWorking}
										value={selectedProfile?.uuid ?? ""}
										onValueChange={(value) => {
											setSelectedProfileUuid(value ?? "");
											setStatus({ type: "idle" });
										}}
									>
										<SelectTrigger id="install-profile">
											<SelectValue>
												{selectedProfile
													? profileLabels.get(selectedProfile.uuid)
													: "All app languages"}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="">All app languages</SelectItem>
											{profiles.map((profile) => (
												<SelectItem key={profile.uuid} value={profile.uuid}>
													{profileLabels.get(profile.uuid)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{selectedProfile?.requiresPracticeWorker && (
										<FieldDescription>
											This profile needs a practice worker from{" "}
											{cczTarget.domain}. Publish to that project space to check
											which version can supply its installation.
										</FieldDescription>
									)}
								</Field>
							)}
						{target === "mobile" && !downloadComplete && (
							<CczTargetField
								state={downloadTargets}
								selectedKey={cczTargetKey}
								onSelectedKeyChange={(key) => {
									setCczTargetKey(key);
									setStatus({ type: "idle" });
								}}
								disabled={isWorking}
								onPublish={
									canUploadToHq ? () => handleTargetChange("hq") : undefined
								}
							/>
						)}
						{target === "hq" ? (
							notConfigured ? (
								<HqNotConnected
									title="Connect CommCare HQ to upload"
									body="You can add your CommCare HQ API key in Settings to upload directly from commcare nova"
									note="You can still choose a CommCare HQ app file or mobile app file above"
									error={
										hqConnectionRefreshFailed
											? CONNECTION_CHECK_FAILED
											: undefined
									}
									isRefreshing={isRefreshingHqConnection}
									onRefresh={onRefreshHqConnection}
								/>
							) : (
								<>
									{stoppedDomain !== null &&
									stoppedDomain === selectedDomain ? (
										<p
											role="status"
											className="rounded-lg border border-nova-border bg-nova-well px-3 py-2.5 text-[13px] leading-relaxed text-nova-text"
										>
											{stoppedPublishingLine(stoppedDomain)}
										</p>
									) : null}
									<UploadForm
										availableDomains={availableDomains}
										domainItems={domainItems}
										isMultiSpace={isMultiSpace}
										selectedDomain={selectedDomain}
										onSelectedDomainChange={handleSelectedDomainChange}
										appName={appName}
										onAppNameChange={setAppName}
										status={status}
										publishPlanLine={publishPlanCopy(
											publishPlan,
											publishPlanContext,
										)}
									/>
									{publishOverChosen ? (
										<p className="text-[13px] leading-relaxed text-nova-text-secondary">
											{PUBLISH_OVER_CHOSEN_LINE}
										</p>
									) : null}
									{broughtIn !== null &&
									broughtIn.server === connectionServer &&
									broughtIn.domain === selectedDomain ? (
										<div
											role="status"
											className="rounded-lg border border-nova-border bg-nova-well px-3 py-2.5 text-[13px] leading-relaxed text-nova-text"
										>
											<p>{broughtInLine(broughtIn.discarded)}</p>
											{/* Where the next publish there still changes
											 *  something Nova writes its own way, the review
											 *  step lists it, so this says so instead. A
											 *  record Nova could not read says neither. */}
											{broughtIn.deployment === null ? null : (
												<p className="mt-1 text-nova-text-secondary">
													{broughtIn.deployment.firstPublish === null
														? nothingNewToPublishLine(broughtIn.domain)
														: nextPublishChangesLine(broughtIn.domain)}
												</p>
											)}
										</div>
									) : null}
									{existing.type === "ready" && existing.views.length > 0 ? (
										<Collapsible>
											<CollapsibleTrigger
												render={<Button variant="ghost" />}
												className="w-full justify-between"
											>
												Published destinations ({existing.views.length})
												<Icon icon={tablerChevronDown} className="size-4" />
											</CollapsibleTrigger>
											<CollapsibleContent>
												<ExistingTargetRows
													views={existing.views}
													connectionServer={connectionServer}
													onOpenPublishing={openPublishing}
												/>
											</CollapsibleContent>
										</Collapsible>
									) : null}
									{existing.type === "error" ? (
										<p
											role="status"
											className="text-sm text-nova-text-secondary"
										>
											{existing.message}
										</p>
									) : null}
								</>
							)
						) : null}
					</div>
				) : (
					<>
						{!complete ? (
							<div className="mb-4 rounded-lg border border-nova-border bg-nova-well p-3">
								<p className="break-words font-medium">
									{target === "hq" ? appName : targetOption.label}
								</p>
								<p className="mt-1 break-words text-sm text-nova-text-secondary">
									{target === "hq"
										? `${availableDomains.find((domain) => domain.name === selectedDomain)?.displayName ?? selectedDomain} · ${connectionServer ? deploymentServerLabel(connectionServer) : "CommCare HQ"}`
										: target === "mobile" && cczTarget
											? projectSpaceLabel(cczTarget)
											: "Import into CommCare HQ"}
								</p>
								{target === "mobile" && selectedProfile && (
									<p className="mt-2 text-sm text-nova-text-secondary">
										Installation profile:{" "}
										{profileLabels.get(selectedProfile.uuid)}
									</p>
								)}
								{target === "hq" ? (
									<>
										<p className="mt-2 text-sm text-nova-text-secondary">
											{publishPlanCopy(publishPlan, publishPlanContext)}
										</p>
										{publishOverChosen ? (
											<p className="mt-1 text-sm text-nova-text-secondary">
												{PUBLISH_OVER_CHOSEN_LINE}
											</p>
										) : null}
									</>
								) : null}
							</div>
						) : null}
						{target === "hq" && status.type === "landed" ? (
							<PublishSuccess
								title={
									status.hqAppAction === "updated"
										? "Your app is updated on CommCare HQ"
										: "Your app is on CommCare HQ"
								}
								tone="done"
								warnings={status.warnings}
								projectSpaceCompatibility={status.projectSpaceCompatibility}
								projectSpaceName={compatibilityTargetDisplayName(
									status.projectSpaceCompatibility,
									availableDomains,
								)}
							>
								{status.appPreviewNote !== null ? (
									<p className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-2.5 text-left text-xs leading-relaxed text-nova-text-secondary">
										{status.appPreviewNote}
									</p>
								) : null}
								{status.logoStep?.changed ? (
									<LogoStep step={status.logoStep} hqAppUrl={status.appUrl} />
								) : null}
								{/* The app is THERE, which is not the same as ready
										    for workers. The record says which, so the
										    celebration never outruns the facts. */}
								{landedView !== null ? (
									<DeploymentStatus
										appId={getAppId()}
										view={landedView}
										canRefresh={canEdit}
										onUpdated={handleRefreshed}
										onWithdrawn={upsertView}
									/>
								) : null}
								{/* Workers are made in exactly one place — the
										    Publishing section — so a password can only ever
										    be shown there. */}
								<div className="mt-2 text-left">
									<Button
										type="button"
										variant="ghost-action"
										onClick={openPublishing}
									>
										Make workers in App setup
									</Button>
								</div>
							</PublishSuccess>
						) : null}
						{target === "hq" && !complete ? (
							<>
								{status.type === "refused" ? (
									<PublishSuccess
										title="Nova couldn't finish publishing"
										tone="refused"
										blocked={
											status.projectSpaceCompatibility?.status === "blocked"
												? undefined
												: status.refusal
										}
										warnings={status.warnings}
									>
										{/* The one refusal a person can answer from here.
												    Everything else needs a fix elsewhere; this needs
												    them to recognize a table. */}
										{status.resourceConflicts.length > 0 && canEdit ? (
											<ResourceConflictChoice
												conflicts={status.resourceConflicts}
												domain={selectedDomain}
												adopted={adoptResourceIds}
												onAdoptChange={handleAdoptChange}
											/>
										) : null}
										{/* The other refusal a person answers here: what
												    changed in CommCare HQ since Nova last published,
												    each ticked to publish over it. */}
										{status.remoteChanges.length > 0 && canEdit ? (
											<RemoteChangeChoice
												changes={status.remoteChanges}
												discarded={discardRemoteChanges}
												onDiscardChange={handleDiscardChange}
												domain={selectedDomain}
												panel={
													connectionServer === null
														? null
														: {
																target: {
																	appId: getAppId(),
																	server: connectionServer,
																	domain: selectedDomain,
																},
																deploymentId:
																	selectedView?.deployment.deployment.id ??
																	null,
																remoteAppId:
																	selectedView === null
																		? null
																		: (activeRemoteApp(selectedView.deployment)
																				?.remoteId ?? null),
																canStop,
																onSettled: handleHqChangesSettled,
																onPublishOver: handleHqChangesPublishOver,
																onStopped: handlePanelStopped,
																onRecordsStale: handlePanelStopUnanswered,
															}
												}
												stop={
													connectionServer === null
														? null
														: {
																canStop,
																target: {
																	appId: getAppId(),
																	server: connectionServer,
																	domain: selectedDomain,
																},
																onStopped: handleStopped,
																onRecordsStale: handleStopUnanswered,
															}
												}
											/>
										) : null}
										{/* The Web Apps question: the app's Web App setting
												    on CommCare HQ differs from where it runs, and
												    the next publish changes it once ticked. */}
										{status.installationProfileReviewUrl ? (
											<a
												className="underline"
												href={status.installationProfileReviewUrl}
												target="_blank"
												rel="noreferrer"
											>
												Open application profiles in CommCare HQ
											</a>
										) : null}
										{canEdit && status.installationProfileChoices && (
											<RadioGroup<string>
												aria-label="Installation choices"
												value={confirmInstallationProfiles ?? ""}
												disabled={isWorking}
												onValueChange={(value) =>
													setConfirmInstallationProfiles(value)
												}
											>
												{status.installationProfileChoices.map((choice) => (
													<RadioGroupItem<string>
														key={choice.confirmation}
														value={choice.confirmation}
													>
														{choice.label}
													</RadioGroupItem>
												))}
											</RadioGroup>
										)}
										{status.installationProfileConfirmation && canEdit ? (
											<label
												htmlFor="installation-worker-confirmation"
												className="flex items-center gap-2"
											>
												<Checkbox
													id="installation-worker-confirmation"
													checked={
														confirmInstallationProfiles ===
														status.installationProfileConfirmation
													}
													onCheckedChange={(checked) =>
														setConfirmInstallationProfiles(
															checked === true
																? (status.installationProfileConfirmation ??
																		null)
																: null,
														)
													}
													disabled={isWorking}
												/>
												Use these practice workers in this project space
											</label>
										) : null}
										{status.webAppsChange !== null && canEdit ? (
											<WebAppsChangeChoice
												change={status.webAppsChange}
												message={status.refusal.detail}
												confirmed={confirmWebApps === status.webAppsChange.to}
												onConfirmedChange={(confirmed) =>
													setConfirmWebApps(
														confirmed && status.webAppsChange !== null
															? status.webAppsChange.to
															: null,
													)
												}
											/>
										) : null}
										{/* The case changes Nova can move so this project
												    space can take the app, accepted by one tick. */}
										{status.placementMoves !== null && canEdit ? (
											<PlacementMoveChoice
												offer={status.placementMoves}
												report={status.projectSpaceCompatibility}
												accepted={acceptsOffer(
													acceptMoves,
													status.placementMoves,
												)}
												onAcceptedChange={handleAcceptMovesChange}
												disabled={isWorking}
											/>
										) : null}
										{refusalOpensHqApp(status.refusal.code) &&
										status.hqAppUrl !== null ? (
											<div className="mt-2 text-left">
												<a
													href={status.hqAppUrl}
													target="_blank"
													rel="noopener noreferrer"
													className="nova-focusable inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-nova-violet-bright hover:underline"
												>
													Open the app in CommCare HQ
													<Icon
														icon={tablerExternalLink}
														className="size-3.5"
													/>
												</a>
											</div>
										) : null}
									</PublishSuccess>
								) : null}
								{status.type === "error" ? (
									<div role="alert" className="my-3 text-sm text-nova-rose">
										<p>{status.message}</p>
										{status.details.map((line) => (
											<p key={line}>{line}</p>
										))}
									</div>
								) : null}
							</>
						) : null}
						{downloadComplete && status.type === "download-success" ? (
							<PublishSuccess
								title={
									target === "web"
										? "CommCare HQ app file downloaded"
										: "Mobile app file downloaded"
								}
								projectSpaceCompatibility={status.projectSpaceCompatibility}
								advisories={status.advisories}
							>
								{target === "web" &&
								status.manualImportGuide !== undefined &&
								status.manualImportGuide.length > 0 ? (
									<ManualImportGuide steps={status.manualImportGuide} />
								) : null}
							</PublishSuccess>
						) : null}
						{showCompatibilityPreflight && (
							<CompatibilityPreflight
								state={compatibilityState}
								domainChecked={target === "hq"}
								projectSpaceName={compatibilityTargetDisplayName(
									compatibilityState.type === "ready"
										? compatibilityState.report
										: undefined,
									availableDomains,
								)}
								onRefresh={
									target === "hq" || compatibilityState.type === "error"
										? handleCheckCompatibilityAgain
										: undefined
								}
							/>
						)}
						{target === "hq" && !complete ? (
							<>
								{/* What the first publish over an app brought in
								    changes: a consequence, so it stays visible and
								    holds no control. */}
								{selectedView !== null && selectedView.firstPublish !== null ? (
									<FirstPublishLines
										view={selectedView.firstPublish}
										surface="publish"
									/>
								) : null}
								{requestedConfirmations.length > 0 && canEdit ? (
									<ConfirmationChoice
										requests={requestedConfirmations}
										domain={selectedDomain}
										given={confirmations}
										onConfirmChange={handleConfirmChange}
										disabled={isWorking}
									/>
								) : null}
								{status.type !== "refused" &&
								compatibilityState.type === "ready" &&
								compatibilityState.confirmations?.placement_moves &&
								canEdit ? (
									<PlacementMoveChoice
										offer={compatibilityState.confirmations.placement_moves}
										report={compatibilityState.report}
										accepted={acceptsOffer(
											acceptMoves,
											compatibilityState.confirmations.placement_moves,
										)}
										onAcceptedChange={handleAcceptMovesChange}
										disabled={isWorking}
									/>
								) : null}
							</>
						) : null}
					</>
				)}
			</DialogBody>
			<DialogFooter
				className={`border-t border-nova-border px-5 py-4 ${
					target === "hq" && status.type === "landed" ? "justify-between" : ""
				}`}
			>
				{!reviewing &&
				!complete &&
				!mobileUnavailable &&
				!(target === "hq" && notConfigured) ? (
					<>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button onClick={() => changeStep(true)} disabled={!canReview}>
							Continue
						</Button>
					</>
				) : target === "hq" ? (
					status.type === "landed" ? (
						<>
							{status.appUrl ? (
								<a
									href={status.appUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-sm text-nova-violet-bright hover:underline"
								>
									Open in CommCare HQ
									<Icon icon={tablerExternalLink} className="size-3.5" />
								</a>
							) : (
								<span />
							)}
							<Button variant="outline" onClick={chooseAnotherDestination}>
								Another destination
							</Button>
							<Button type="button" variant="outline" onClick={handleClose}>
								Done
							</Button>
						</>
					) : notConfigured ? (
						<DialogClose render={<Button variant="outline" />}>
							Close
						</DialogClose>
					) : (
						<>
							<Button
								variant="outline"
								onClick={() => changeStep(false)}
								disabled={isWorking}
							>
								Back
							</Button>
							<Button
								ref={uploadButtonRef}
								type="button"
								onClick={handleUpload}
								disabled={!canUpload}
							>
								{status.type === "uploading" ? (
									<>
										<Icon
											icon={tablerLoader2}
											className="size-4 animate-spin"
										/>
										Uploading
									</>
								) : remoteChangesToConfirm.length > 0 || publishOverChosen ? (
									"Publish over these changes"
								) : (
									"Upload"
								)}
							</Button>
						</>
					)
				) : downloadComplete ? (
					<>
						<Button variant="outline" onClick={chooseAnotherDestination}>
							Another destination
						</Button>
						<Button type="button" variant="outline" onClick={handleClose}>
							Done
						</Button>
					</>
				) : mobileUnavailable ? (
					<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
				) : (
					<>
						<Button
							variant="outline"
							onClick={() => changeStep(false)}
							disabled={isWorking}
						>
							Back
						</Button>
						<Button
							type="button"
							onClick={() => handleDownload(downloadTarget)}
							disabled={
								isWorking ||
								(downloadTarget === "mobile" &&
									(cczTarget === null ||
										selectedProfile?.requiresPracticeWorker === true))
							}
						>
							{status.type === "downloading" ? (
								<>
									<Icon icon={tablerLoader2} className="size-4 animate-spin" />
									Preparing
								</>
							) : (
								<>
									<Icon icon={tablerDownload} className="size-4" />
									{downloadTarget === "web" ? "Download ZIP" : "Download CCZ"}
								</>
							)}
						</Button>
					</>
				)}
			</DialogFooter>
		</>
	);
}

/**
 * The targets this app has already reached, one line each. Deliberately
 * compact: the record's full story (the ladder, the refusal, workers, what
 * was left behind) lives in the Publishing section this links to, and a
 * second full rendering here would be a second copy to keep honest.
 */
function ExistingTargetRows({
	views,
	connectionServer,
	onOpenPublishing,
}: {
	views: readonly DeploymentView[];
	connectionServer: CommCareServer | null;
	onOpenPublishing: () => void;
}) {
	const rows = compactTargetRows(views, connectionServer);
	return (
		<div className="rounded-lg border border-nova-border bg-nova-well px-3 py-1">
			<ul className="flex flex-col">
				{rows.map((row) => (
					<li
						key={row.key}
						className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-nova-border py-2 text-[13px] leading-relaxed last:border-b-0"
					>
						<span className="min-w-0 break-words font-medium text-nova-text">
							{row.domain}
							{/* What publishing again does is only worth claiming for
							    a target this connection can publish to. A record on
							    another CommCare HQ installation instead says where it
							    is, so nobody wonders why the select doesn't offer it. */}
							{row.line !== null ? (
								<span className="block text-[12px] font-normal text-nova-text-muted">
									{row.line}
								</span>
							) : null}
						</span>
						<span
							className={
								row.stopped ? "text-nova-amber" : "text-nova-text-secondary"
							}
						>
							{row.statusLabel}
						</span>
					</li>
				))}
			</ul>
			<div className="flex items-center justify-between gap-3 py-1">
				<p className="text-[12px] leading-relaxed text-nova-text-muted">
					Check status, workers, and setup notes live in App setup
				</p>
				<Button type="button" variant="ghost-action" onClick={onOpenPublishing}>
					Open Publishing
				</Button>
			</div>
		</div>
	);
}

/**
 * Which project space the CCZ is for, in four exclusive states: none and
 * nothing holding the app back, none because CommCare HQ cannot take it as
 * it stands, or the project spaces it is published to, each one a CCZ can
 * be made for a choice (the only such one chosen for the person) and each
 * one it can't shown with why, never chosen.
 */
function CczTargetField({
	state,
	selectedKey,
	onSelectedKeyChange,
	disabled,
	onPublish,
}: {
	state: DownloadTargets;
	selectedKey: string;
	onSelectedKeyChange: (key: string) => void;
	disabled: boolean;
	/** Switch the dialog to publishing; absent where this person cannot publish. */
	onPublish?: () => void;
}) {
	const legendId = useId();
	if (state.type === "loading") {
		return (
			<div
				role="status"
				className="mt-4 flex items-center gap-2 text-xs text-nova-text-secondary"
			>
				<Icon
					icon={tablerLoader2}
					className="size-4 animate-spin text-nova-violet-bright"
				/>
				Finding the project spaces this app is published to
			</div>
		);
	}
	if (state.type === "error") {
		return (
			<p
				role="alert"
				className="mt-4 text-[13px] leading-relaxed text-nova-text-secondary"
			>
				{state.message}
			</p>
		);
	}
	const { targets, heldFromHq, webAppsOnly } = state.view;
	/* The option stays offered: choosing it says why there is no CCZ. */
	if (webAppsOnly) {
		return (
			<div className="mt-4 rounded-lg border border-nova-border bg-nova-well px-3 py-3">
				<p className="text-[13px] leading-relaxed text-nova-text">
					{WEB_APPS_ONLY_HAS_NO_CCZ}
				</p>
			</div>
		);
	}
	if (targets.length === 0) {
		return (
			<div className="mt-4 rounded-lg border border-nova-border bg-nova-well px-3 py-3">
				<p className="text-[13px] leading-relaxed text-nova-text">
					{heldFromHq.length > 0
						? SELECTION_HELD_FROM_HQ
						: NEEDS_PUBLISHED_PROJECT_SPACE}
				</p>
				{heldFromHq.length > 0 ? (
					<ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-nova-text-secondary">
						{heldFromHq.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				) : onPublish ? (
					<div className="mt-2">
						<Button type="button" variant="outline" onClick={onPublish}>
							<Icon icon={tablerCloudUpload} className="size-4" />
							Publish to CommCare HQ
						</Button>
					</div>
				) : null}
			</div>
		);
	}
	const rows = cczTargetRows(state.view);
	const anyAvailable = rows.some((row) => row.unavailableLine === null);
	return (
		<FieldSet className="mt-4 gap-1.5" data-ccz-project-space>
			<FieldLegend id={legendId} variant="label" className="mb-0">
				Project space
			</FieldLegend>
			<RadioGroup<string>
				aria-labelledby={legendId}
				value={selectedKey}
				onValueChange={(value) => {
					if (typeof value === "string") onSelectedKeyChange(value);
				}}
				disabled={disabled}
			>
				{rows.map((row) => (
					<CczTargetChoice key={row.key} row={row} />
				))}
			</RadioGroup>
			<FieldDescription>
				{anyAvailable
					? "The CCZ signs workers in to this project space and uses its app and form ids, so its forms land with the ones already collected there."
					: "None of the project spaces this app is published to can have a CCZ from Nova right now."}
			</FieldDescription>
		</FieldSet>
	);
}

function CczTargetChoice({ row }: { row: CczTargetRow }) {
	return (
		<RadioGroupItem<string>
			value={row.key}
			unavailableReason={row.unavailableLine ?? undefined}
		>
			{row.label}
		</RadioGroupItem>
	);
}

/** The import file's manual steps, as its README holds them, once it has arrived. */
function ManualImportGuide({ steps }: { steps: readonly ManualImportStep[] }) {
	return (
		<div className="mt-3 rounded-lg border border-nova-border bg-nova-well px-3 py-3 text-left">
			<h4 className="text-xs font-semibold text-nova-text">
				Import it into CommCare HQ
			</h4>
			<ol className="mt-2 flex list-decimal flex-col gap-3 pl-4">
				{steps.map((step) => (
					<li
						key={manualImportStepKey(step)}
						className="text-xs leading-relaxed"
					>
						<p className="font-medium text-nova-text">{step.title}</p>
						<p className="mt-1 whitespace-pre-wrap break-words text-nova-text-secondary">
							{step.lines.join("\n")}
						</p>
					</li>
				))}
			</ol>
		</div>
	);
}

function UploadForm({
	availableDomains,
	domainItems,
	isMultiSpace,
	selectedDomain,
	onSelectedDomainChange,
	appName,
	onAppNameChange,
	status,
	publishPlanLine,
}: {
	availableDomains: Domain[];
	domainItems: { label: string; value: string }[];
	isMultiSpace: boolean;
	selectedDomain: string;
	onSelectedDomainChange: (value: string) => void;
	appName: string;
	onAppNameChange: (value: string) => void;
	status: PublishStatus;
	/** What publishing will do to the selected project space's app (`publishPlanCopy`). */
	publishPlanLine: string;
}) {
	const uploading = status.type === "uploading";
	return (
		<>
			<div className="space-y-4">
				<Field className="gap-1.5">
					<FieldTitle>Project space</FieldTitle>
					{isMultiSpace ? (
						<>
							<Select
								items={domainItems}
								value={selectedDomain}
								onValueChange={(next) => onSelectedDomainChange(next ?? "")}
								disabled={uploading}
							>
								<SelectTrigger
									id="hq-project-space"
									className="w-full"
									aria-label="Project space"
								>
									<SelectValue placeholder="Choose a project space" />
								</SelectTrigger>
								<SelectContent>
									{availableDomains.map((domain) => (
										<SelectItem key={domain.name} value={domain.name}>
											{domain.displayName}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{selectedDomain && (
								<FieldDescription className="text-xs">
									Uploads to {selectedDomain}
								</FieldDescription>
							)}
						</>
					) : (
						<div className="flex items-center gap-3 rounded-lg border border-nova-border bg-nova-well px-3.5 py-2.5">
							<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-nova-elevated">
								<Icon
									icon={tablerCloudUpload}
									className="size-4 text-nova-text-secondary"
								/>
							</div>
							<div className="min-w-0">
								<p className="break-words text-sm font-medium leading-snug text-nova-text">
									{availableDomains[0].displayName}
								</p>
								<p className="text-[11px] leading-snug text-nova-text-muted">
									{availableDomains[0].name}
								</p>
							</div>
						</div>
					)}
				</Field>

				<Field className="gap-1.5">
					<FieldLabel htmlFor="hq-upload-app-name">App name</FieldLabel>
					<Input
						id="hq-upload-app-name"
						type="text"
						value={appName}
						onChange={(event) => onAppNameChange(event.target.value)}
						disabled={uploading}
						autoComplete="off"
						data-1p-ignore
					/>
				</Field>

				<p className="text-xs leading-relaxed text-nova-text-muted">
					{publishPlanLine}
				</p>
			</div>

			{status.type === "error" && (
				<div
					role="alert"
					className="mt-3 rounded-lg border border-nova-rose/20 bg-nova-rose/[0.06] px-3 py-3"
				>
					<div className="flex items-start gap-2">
						<Icon
							icon={tablerAlertCircle}
							className="mt-0.5 size-4 shrink-0 text-nova-rose"
						/>
						<div className="min-w-0">
							<p className="text-sm font-medium text-nova-text">
								{status.message}
							</p>
							{status.details.length > 0 && (
								<ul className="mt-1.5 list-disc space-y-1 pl-4">
									{status.details.map((line) => (
										<li
											key={line}
											className="text-xs leading-snug text-nova-text-secondary"
										>
											{line}
										</li>
									))}
								</ul>
							)}
							{status.status === 401 && (
								<Link
									href="/settings"
									target="_blank"
									rel="noopener noreferrer"
									className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-nova-violet-bright hover:underline"
								>
									Open Settings
									<Icon icon={tablerExternalLink} className="size-3" />
								</Link>
							)}
						</div>
					</div>
				</div>
			)}
		</>
	);
}

function CompatibilityPreflight({
	state,
	domainChecked = false,
	projectSpaceName,
	onRefresh,
}: {
	state: ProjectSpaceCompatibilityState;
	domainChecked?: boolean;
	projectSpaceName?: string;
	onRefresh?: () => void;
}) {
	if (state.type === "loading") {
		return (
			<div
				role="status"
				className="mt-3 flex items-center gap-2 rounded-lg border border-white/[0.04] bg-white/[0.03] px-3 py-2.5"
			>
				<Icon
					icon={tablerLoader2}
					className="size-4 shrink-0 animate-spin text-nova-violet-bright"
				/>
				<p className="text-xs text-nova-text-secondary">
					{domainChecked
						? "Checking whether this project space can run the app"
						: "Checking what the app needs from a project space"}
				</p>
			</div>
		);
	}

	if (state.type === "error") {
		return (
			<div
				role="alert"
				className="mt-3 rounded-lg border border-nova-amber/20 bg-nova-amber/[0.06] px-3 py-2.5"
			>
				<p className="text-xs leading-relaxed text-nova-text-secondary">
					{state.message}
				</p>
				{onRefresh && (
					<Button
						type="button"
						variant="ghost"
						onClick={onRefresh}
						className="mt-1"
					>
						<Icon icon={tablerRefresh} className="size-4" />
						Try again
					</Button>
				)}
			</div>
		);
	}

	const report = state.report;
	return (
		<div>
			<ProjectSpaceCompatibilityNotice
				report={report}
				projectSpaceName={projectSpaceName}
			/>
			{onRefresh && (
				<div className="flex justify-end">
					<Button type="button" variant="ghost" onClick={onRefresh}>
						<Icon icon={tablerRefresh} className="size-4" />
						Check again
					</Button>
				</div>
			)}
		</div>
	);
}

function PublishSuccess({
	title,
	warnings = [],
	projectSpaceCompatibility,
	projectSpaceName,
	advisories = [],
	tone = "done",
	blocked,
	children,
}: {
	title: string;
	warnings?: string[];
	projectSpaceCompatibility?: ProjectSpaceCompatibilityReport;
	/** Human-facing name resolved from the report's authoritative target. */
	projectSpaceName?: string;
	/** Only a download has these: a publish always knows its own target. */
	advisories?: readonly ExportAdvisory[];
	/** A refused publish reaches this screen too, and must not be
	 *  celebrated: it shows the same record, without the tick. */
	tone?: "done" | "refused";
	/** What stopped it, when the record itself cannot say. */
	blocked?: { detail: string; items: readonly string[] };
	children?: ReactNode;
}) {
	return (
		<div className="py-1">
			<div role="status" className="text-center">
				<motion.div
					initial={{ scale: 0 }}
					animate={{ scale: 1 }}
					transition={{ type: "spring", stiffness: 300, damping: 20 }}
					className={`mx-auto mb-3 flex size-12 items-center justify-center rounded-full ${
						tone === "done" ? "bg-nova-emerald/15" : "bg-nova-amber/15"
					}`}
				>
					<Icon
						icon={tone === "done" ? tablerCheck : tablerAlertCircle}
						className={`size-6 ${tone === "done" ? "text-nova-emerald" : "text-nova-amber"}`}
					/>
				</motion.div>
				<h3 className="text-sm font-semibold text-nova-text">{title}</h3>
			</div>

			{blocked && (
				/* The record is not always able to explain a refusal: a publish
				   blocked against an app that is already live leaves it
				   untouched and green. */
				<div
					role="alert"
					className="mt-3 rounded-lg border border-nova-amber/40 bg-nova-amber/10 px-3 py-2.5 text-xs leading-relaxed"
				>
					<p className="text-nova-text">{blocked.detail}</p>
					{blocked.items.length > 0 && (
						<ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-nova-text-secondary">
							{blocked.items.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					)}
				</div>
			)}

			{warnings.length > 0 && (
				<div className="mt-3 space-y-1 rounded-lg border border-nova-amber/20 bg-nova-amber/[0.06] px-3 py-2.5">
					{warnings.map((warning) => (
						<p
							key={warning}
							className="text-xs leading-relaxed text-nova-amber"
						>
							{warning}
						</p>
					))}
				</div>
			)}

			{advisories.length > 0 && (
				<div className="mt-3 space-y-2 rounded-lg border border-nova-amber/20 bg-nova-amber/[0.06] px-3 py-2.5">
					{advisories.map((advisory) => (
						<div key={advisory.id}>
							<p className="text-xs font-medium text-nova-text">
								{advisory.title}
							</p>
							<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
								{advisory.message}
							</p>
						</div>
					))}
				</div>
			)}

			{projectSpaceCompatibility && (
				<ProjectSpaceCompatibilityNotice
					report={projectSpaceCompatibility}
					projectSpaceName={projectSpaceName}
				/>
			)}

			{children}
		</div>
	);
}

/**
 * The name clash, and the only thing that resolves it.
 *
 * CommCare HQ addresses a lookup table by its tag and a place by its site
 * code, so pushing over one Nova did not create would silently replace
 * somebody else's data. Nova refuses instead, and this is where a person
 * says which of those are in fact theirs.
 *
 * Deliberately one at a time and deliberately unticked: a "use everything
 * already there" shortcut would be one click away from overwriting work
 * that happens to share a name, which is the whole failure this refusal
 * exists to prevent. The other way out differs by kind and is spelled out
 * below, which is why the name CommCare HQ shows is printed beside the
 * name Nova shows.
 */
function ResourceConflictChoice({
	conflicts,
	domain,
	adopted,
	onAdoptChange,
}: {
	conflicts: readonly DeploymentResourceConflict[];
	domain: string;
	adopted: readonly string[];
	onAdoptChange: (novaResourceId: string, adopt: boolean) => void;
}) {
	const kinds = new Set(conflicts.map((conflict) => conflict.kind));
	return (
		<div className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-3">
			<p className="text-[13px] leading-relaxed text-nova-text">
				Pick any of these that are already yours. Nova will keep them in step
				with this app every time you publish, and leave the rest alone.
			</p>
			<ul className="mt-2.5 flex flex-col gap-1">
				{conflicts.map((conflict) => (
					<li key={conflict.novaResourceId}>
						<label
							htmlFor={`adopt-${conflict.novaResourceId}`}
							className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-nova-text"
						>
							<Checkbox
								id={`adopt-${conflict.novaResourceId}`}
								checked={adopted.includes(conflict.novaResourceId)}
								onCheckedChange={(next) =>
									onAdoptChange(conflict.novaResourceId, next === true)
								}
							/>
							<span>
								{conflict.name}
								<span className="text-nova-text-secondary">
									{" "}
									({conflict.identity})
								</span>
							</span>
						</label>
					</li>
				))}
			</ul>
			{kinds.has("lookup-table") && (
				<p className="mt-1 text-[12px] leading-relaxed text-nova-text-secondary">
					{LOOKUP_ADOPTION_NOTE}
				</p>
			)}
			<p className="mt-1 text-[12px] leading-relaxed text-nova-text-secondary">
				Leave one unticked and it stays untouched on{" "}
				{domain || "the project space"}.
				{kinds.has("lookup-table") &&
					" Rename that table in Project data and publish again to send yours alongside it."}
				{kinds.has("location") &&
					" A site code is set once, so to send a place of your own beside it, remove the place in Organization and add it again with a code that is free."}
			</p>
		</div>
	);
}

/**
 * What the selected project space needs that Nova can't read from it, and
 * the one thing that lets the publish go ahead: a person saying it has it.
 *
 * Each row starts unticked and is ticked on its own, like a name clash:
 * no API key reads a project space's plan or these settings, so the answer
 * is the person's, and it stays on the deployment until someone withdraws
 * it. Every row says why this app needs it and what happens without it, so
 * nobody ticks a row they didn't expect without seeing why it is there.
 */
function ConfirmationChoice({
	requests,
	domain,
	given,
	onConfirmChange,
	disabled,
}: {
	requests: readonly ConfirmationRequest[];
	domain: string;
	given: readonly DeploymentConfirmationKey[];
	onConfirmChange: (key: DeploymentConfirmationKey, confirmed: boolean) => void;
	disabled: boolean;
}) {
	const space = domain || "the project space";
	return (
		<section aria-labelledby="publish-confirmations-heading" className="mt-5">
			<h4 id="publish-confirmations-heading" className="text-sm font-semibold">
				Confirm for this project space
			</h4>
			<p className="mt-1 text-sm text-nova-text-secondary">
				Nova can't check these settings. Your answers are kept for {space}; you
				can change them later in App setup.
			</p>
			<ul className="mt-3 divide-y divide-nova-border">
				{requests.map((request) => {
					const id = `confirm-${request.kind}-${request.key.kind === "plan-feature" ? request.key.subject : request.kind}`;
					const setting =
						request.kind === "plan-feature"
							? null
							: PROJECT_SPACE_SETTINGS[request.kind];
					return (
						<li key={id} className="py-3 first:pt-0">
							<p className="text-sm font-medium">{request.label}</p>
							{setting ? (
								<p className="mt-1 text-sm text-nova-text-secondary">
									{setting.question(space)}
								</p>
							) : null}
							<label
								htmlFor={id}
								className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"
							>
								<Checkbox
									id={id}
									checked={given.some((key) =>
										sameConfirmationKey(key, request.key),
									)}
									disabled={disabled}
									onCheckedChange={(next) =>
										onConfirmChange(request.key, next === true)
									}
								/>
								<span>
									{setting?.confirmLabel ?? PLAN_FEATURE_CONFIRM_LABEL}
									<span className="sr-only"> {request.label}</span>
								</span>
							</label>
							<p className="text-sm text-nova-text-secondary">
								{request.consequence}
							</p>
							<Collapsible>
								<CollapsibleTrigger
									render={<Button variant="ghost" />}
									className="justify-between gap-2"
									aria-label={`Details about ${request.label}`}
								>
									Details
									<Icon icon={tablerChevronDown} className="size-4" />
								</CollapsibleTrigger>
								<CollapsibleContent className="space-y-2 pb-2 text-sm text-nova-text-secondary">
									{request.plans !== "" ? (
										<p>Included in the {request.plans} plans.</p>
									) : null}
									{request.reasons.length > 0 ? (
										<ul className="list-disc space-y-1 pl-5">
											{request.reasons.map((reason, index) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: distinct forms can produce the same sentence.
												<li key={index}>{reason}</li>
											))}
										</ul>
									) : null}
									{request.whereMissing !== null ? (
										<p>{request.whereMissing}</p>
									) : null}
								</CollapsibleContent>
							</Collapsible>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * The case changes a publish offers to move so the project space can take
 * the app as it is: the offer's heading and body, one row per move, and the
 * one box that accepts them all. It starts unticked, because a move changes
 * where CommCare HQ keeps those answers in every project space the app is
 * published to. An offer `placementOfferCopy` has no true words for is not
 * offered.
 */
function PlacementMoveChoice({
	offer,
	report,
	accepted,
	onAcceptedChange,
	disabled,
}: {
	offer: PlacementMoveOfferView;
	/** The refusal's compatibility report, which the same-type offer's body reads. */
	report: ProjectSpaceCompatibilityReport | undefined;
	accepted: boolean;
	onAcceptedChange: (offer: PlacementMoveOfferView, accepted: boolean) => void;
	disabled: boolean;
}) {
	const copy = placementOfferCopy(offer, report);
	if (copy === null) return null;
	return (
		<section
			aria-labelledby="publish-placement-moves-heading"
			className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-3 text-left"
		>
			<h4
				id="publish-placement-moves-heading"
				className="text-[13px] font-semibold text-nova-text"
			>
				{copy.heading}
			</h4>
			<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
				{copy.body}
			</p>
			<ul className="mt-2.5 flex flex-col gap-1.5">
				{offer.moves.map((move, index) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: two changes of one form can read the same sentence, so the text is no key.
						key={index}
						className="rounded-lg border border-nova-border bg-nova-well px-3 py-2 text-xs leading-relaxed text-nova-text"
					>
						{move.sentence}
					</li>
				))}
			</ul>
			<label
				htmlFor="publish-placement-moves"
				className="mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-nova-text"
			>
				<Checkbox
					id="publish-placement-moves"
					checked={accepted}
					disabled={disabled}
					onCheckedChange={(next) => onAcceptedChange(offer, next === true)}
				/>
				<span>{ACCEPT_PLACEMENT_MOVES_LABEL}</span>
			</label>
		</section>
	);
}

/**
 * The logo a publish never sends, offered for the person to add in
 * CommCare HQ: the sentence every surface reads, the file to download, and
 * the app to add it to. Shown only when this is not the logo the
 * deployment already offered.
 */
function LogoStep({
	step,
	hqAppUrl,
}: {
	step: PublishLogoStepBody;
	hqAppUrl: string;
}) {
	return (
		<div className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-2.5 text-left text-xs leading-relaxed">
			<p className="text-nova-text-secondary">{LOGO_UPLOAD_STEP_TEXT}</p>
			<div className="mt-1 flex flex-wrap items-center gap-x-4">
				<a
					href={`/api/media/${encodeURIComponent(step.assetId)}`}
					download={step.fileName}
					className="nova-focusable inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-nova-violet-bright hover:underline"
				>
					<Icon icon={tablerDownload} className="size-3.5" />
					Download {step.fileName}
				</a>
				{hqAppUrl ? (
					<a
						href={hqAppUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="nova-focusable inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-nova-violet-bright hover:underline"
					>
						Open the app in CommCare HQ
						<Icon icon={tablerExternalLink} className="size-3.5" />
					</a>
				) : null}
			</div>
		</div>
	);
}

/**
 * The Web Apps question: the app's Web App setting on CommCare HQ differs
 * from where the app runs, whoever moved it. One tick agrees to write the
 * declaration's value for this publish alone; it starts unticked, because
 * changing it decides whether workers there can open the app in Web Apps.
 */
function WebAppsChangeChoice({
	change,
	message,
	confirmed,
	onConfirmedChange,
}: {
	change: WebAppsChange;
	message: string;
	confirmed: boolean;
	onConfirmedChange: (confirmed: boolean) => void;
}) {
	return (
		<section
			aria-labelledby="publish-web-apps-heading"
			className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-3 text-left"
		>
			<h4
				id="publish-web-apps-heading"
				className="text-[13px] font-semibold text-nova-text"
			>
				{WEB_APPS_CHANGE_HEADING}
			</h4>
			<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
				{message}
			</p>
			<label
				htmlFor="publish-web-apps-change"
				className="mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-nova-text"
			>
				<Checkbox
					id="publish-web-apps-change"
					checked={confirmed}
					onCheckedChange={(next) => onConfirmedChange(next === true)}
				/>
				<span>{webAppsChangeConfirmLabel(change)}</span>
			</label>
		</section>
	);
}

/** Whether two discards name one resource, whatever state each was shown in. */
function sameRemoteResource(
	a: RemoteChangeDiscard,
	b: RemoteChangeDiscard,
): boolean {
	return a.kind === b.kind && a.novaResourceId === b.novaResourceId;
}

/**
 * Whether a discard answers a change the refusal listed. A tick names the
 * change in the state the refusal showed. The changes made in CommCare HQ
 * panel's publish over names the app under the digest its own review read,
 * which is newer than the refusal's where CommCare HQ was saved again in
 * between: it answers the app's change too, since the person chose it over
 * what the panel showed, and the publish stops again if CommCare HQ moved
 * past that.
 */
function confirmsRemoteChange(
	discard: RemoteChangeDiscard,
	change: DeploymentRemoteChange,
): boolean {
	if (sameRemoteChange(discard, change)) return !change.requiresReview;
	// Only a completed review offers its own receipt here. The short
	// preview and the receipt for all disclosed files have distinct digests.
	return (
		change.kind === "app" &&
		change.canBringIn &&
		sameRemoteResource(discard, change)
	);
}

/** Whether a discard names this change in the state it was shown in. */
function sameRemoteChange(
	discard: RemoteChangeDiscard,
	change: RemoteChangeDiscard,
): boolean {
	return (
		discard.kind === change.kind &&
		discard.novaResourceId === change.novaResourceId &&
		discard.observedDigest === change.observedDigest
	);
}

/**
 * What changed in CommCare HQ since Nova last published there, brought the
 * app in or brought changes in, and what lets the publish write over it.
 * Where the app's own change is listed, Stop publishing here stands under
 * its parts for an admin or owner, and an editor is told who can.
 *
 * Each change is ticked on its own and starts unticked, like a name clash:
 * publishing over one replaces what a person made in CommCare HQ with this
 * app's version, so nobody does it by default. A tick is bound to the state
 * the refusal showed, which is what the resend names back.
 *
 * Where the app's change can be brought in, the changes made in CommCare HQ
 * panel takes the item's place: its choices are the item's controls, so the
 * item's parts, its tick and the stop block are drawn only where the panel
 * offers no choice of its own. Where it cannot, the item says why under its
 * parts.
 */
function RemoteChangeChoice({
	changes,
	discarded,
	onDiscardChange,
	domain,
	panel,
	stop,
}: {
	changes: readonly DeploymentRemoteChange[];
	discarded: readonly RemoteChangeDiscard[];
	onDiscardChange: (change: DeploymentRemoteChange, discard: boolean) => void;
	/** The project space the publish was refused on. */
	domain: string;
	/** What the panel reads and answers into; null with no connection to name the target. */
	panel: Omit<HqChangesPanelProps, "home" | "item" | "since"> | null;
	/**
	 * The way to leave CommCare HQ's version as it is; null with no connection
	 * to name the target. The HQ app it stops is the one the refusal's app
	 * change names, the app the person is deciding over.
	 */
	stop: {
		readonly canStop: boolean;
		readonly target: Omit<StopPublishingTarget, "hqAppId">;
		readonly onStopped: (
			next: StoppedPublishingView,
			target: { readonly server: CommCareServer; readonly domain: string },
		) => void;
		readonly onRecordsStale: (target: {
			readonly server: CommCareServer;
			readonly domain: string;
		}) => void;
	} | null;
}) {
	return (
		<ul className="mt-3 flex flex-col gap-2">
			{changes.map((change) => {
				const id = `discard-${change.kind}-${change.novaResourceId}`;
				const item = (
					<>
						{change.parts.length > 0 && (
							<ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-nova-text-secondary">
								{change.parts.map((part, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: two parts can name forms of the same name, so the text is no key.
									<li key={index}>{part}</li>
								))}
							</ul>
						)}
						{!change.baselineKnown && (
							<p className="mt-1.5 text-xs leading-relaxed text-nova-text-secondary">
								{baselineUnknownSentence(change.since, viewerDriftDate())}
							</p>
						)}
						{change.kind === "app" &&
						!change.canBringIn &&
						!change.requiresReview ? (
							<p className="mt-1.5 text-xs leading-relaxed text-nova-text-secondary">
								{hqChangesUnavailableLine("no-reference", {
									domain,
									since: change.since,
									options: viewerDriftDate(),
								})}
							</p>
						) : null}
						{change.note !== null ? (
							<p className="mt-1.5 text-xs leading-relaxed text-nova-text-secondary">
								{change.note}
							</p>
						) : null}
						{!change.requiresReview && (
							<label
								htmlFor={id}
								className="mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-nova-text"
							>
								<Checkbox
									id={id}
									checked={discarded.some((entry) =>
										sameRemoteChange(entry, change),
									)}
									onCheckedChange={(next) =>
										onDiscardChange(change, next === true)
									}
								/>
								<span>
									Publish over this
									<span className="sr-only"> {change.name}</span>
								</span>
							</label>
						)}
						{change.kind === "app" && stop !== null ? (
							<DriftStop
								canStop={stop.canStop}
								target={{ ...stop.target, hqAppId: change.identity }}
								onStopped={stop.onStopped}
								onRecordsStale={stop.onRecordsStale}
							/>
						) : null}
					</>
				);
				return (
					<li
						key={`${change.kind}:${change.novaResourceId}`}
						className="rounded-lg border border-nova-border bg-nova-elevated px-3 py-3"
					>
						<p className="text-[13px] text-nova-text">
							{change.name}
							<span className="text-nova-text-secondary">
								{" "}
								({change.identity})
							</span>
						</p>
						{/* Menu layouts CommCare HQ holds that this publish replaces
						 * are no change since the reading the panel compares, so its
						 * review cannot show them; the item lists them with their
						 * tick, and the person matches them in Nova or publishes
						 * over them. */}
						{change.kind === "app" &&
						change.canBringIn &&
						!change.replacesMenuLayouts &&
						panel !== null ? (
							/* A new refusal is a new review: keyed by the state it read. */
							<HqChangesPanel
								key={change.observedDigest}
								{...panel}
								home="publish"
								since={change.since}
								item={item}
							/>
						) : (
							item
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The third way on from a change made in CommCare HQ to the app itself:
 * stop publishing here, which leaves CommCare HQ's version as it is. Offered
 * to a member who may delete the Project's apps, with the one confirmation
 * the Publishing card uses; an editor reads who can.
 */
function DriftStop({
	canStop,
	target,
	onStopped,
	onRecordsStale,
}: {
	canStop: boolean;
	target: StopPublishingTarget;
	onStopped: (
		next: StoppedPublishingView,
		target: { readonly server: CommCareServer; readonly domain: string },
	) => void;
	onRecordsStale: (target: {
		readonly server: CommCareServer;
		readonly domain: string;
	}) => void;
}) {
	const [open, setOpen] = useState(false);
	const helperId = useId();
	const { server, domain } = target;
	const handleStopped = useCallback(
		(next: StoppedPublishingView) => onStopped(next, { server, domain }),
		[onStopped, server, domain],
	);
	const handleRecordsStale = useCallback(
		() => onRecordsStale({ server, domain }),
		[onRecordsStale, server, domain],
	);
	if (!canStop) {
		return (
			<p className="mt-2 border-t border-nova-border pt-2 text-xs leading-relaxed text-nova-text-secondary">
				{DRIFT_STOP_EDITOR_LINE}
			</p>
		);
	}
	return (
		<div className="mt-2 border-t border-nova-border pt-2">
			<h4 className="text-[13px] font-medium text-nova-text">
				{DRIFT_STOP_LEAVE_HEADING}
			</h4>
			<Button
				type="button"
				variant="ghost"
				onClick={() => setOpen(true)}
				aria-describedby={helperId}
			>
				{STOP_PUBLISHING_ACTION}
			</Button>
			<p
				id={helperId}
				className="mt-0.5 text-xs leading-relaxed text-nova-text-secondary"
			>
				{STOP_PUBLISHING_HELPER}
			</p>
			<StopPublishingDialog
				open={open}
				onOpenChange={setOpen}
				target={target}
				onStopped={handleStopped}
				onRecordsStale={handleRecordsStale}
			/>
		</div>
	);
}

function ProjectSpaceCompatibilityNotice({
	report,
	projectSpaceName,
}: {
	report: ProjectSpaceCompatibilityReport;
	projectSpaceName?: string;
}) {
	const blocked = report.status === "blocked";
	const notChecked = report.status === "not_checked";
	const targetSubject = projectSpaceName
		? `“${projectSpaceName}”`
		: "This project space";
	const targetObject = projectSpaceName
		? `“${projectSpaceName}”`
		: "this project space";
	const notAMember = report.issue === "not-a-member";
	const title = notAMember
		? `Nova couldn't check ${targetObject}`
		: report.status === "not_needed"
			? "This app doesn't need additional project-space support"
			: report.status === "ready"
				? "This project space can run the app"
				: blocked
					? report.blockers.some(
							(capability) => capability.state === "unverified",
						)
						? `Nova couldn't confirm that ${targetObject} can run the app`
						: `${targetSubject} needs more support to run the app`
					: "Choose a project space that can run this app";
	const capabilities = notAMember
		? []
		: blocked
			? report.blockers
			: notChecked
				? report.required_capabilities
				: [];
	const missingCapabilities = report.blockers.filter(
		(capability) => capability.state === "missing",
	);
	const visibleAdvisories = report.advisories.filter(
		(advisory) => advisory.state !== "available",
	);
	/* Where the connected account has left the project space, nothing about
	 * it can be checked, so the report's own sentence says what to do. */
	const summary =
		blocked && !notAMember
			? `Nothing has been sent to ${targetObject}. Review what it needs below, then check again.`
			: report.message;

	return (
		<div className="mt-3 space-y-2">
			<div
				role={blocked ? "alert" : "status"}
				className={`rounded-lg border px-3 py-3 ${
					blocked
						? "border-nova-amber/25 bg-nova-amber/[0.06]"
						: report.status === "ready" || report.status === "not_needed"
							? "border-nova-emerald/15 bg-nova-emerald/[0.04]"
							: "border-nova-violet/25 bg-nova-violet/[0.05]"
				}`}
			>
				<div className="flex items-start gap-2">
					<Icon
						icon={
							blocked
								? tablerAlertCircle
								: report.status === "ready" || report.status === "not_needed"
									? tablerCircleCheck
									: tablerInfoCircle
						}
						className={`mt-0.5 size-4 shrink-0 ${
							blocked
								? "text-nova-amber"
								: report.status === "ready" || report.status === "not_needed"
									? "text-nova-emerald"
									: "text-nova-violet-bright"
						}`}
					/>
					<div className="min-w-0">
						<p className="text-xs font-semibold text-nova-text">{title}</p>
						<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
							{summary}
						</p>
					</div>
				</div>

				{capabilities.length > 0 ? (
					<ul className="mt-2 space-y-2 pl-6">
						{capabilities.map((capability) => (
							<li key={capability.id} className="text-xs leading-relaxed">
								<p className="font-medium text-nova-text">{capability.label}</p>
								<p className="text-nova-text-muted">{capability.description}</p>
								{blocked ? (
									<p className="text-nova-text-secondary">
										{capability.state === "missing"
											? `${targetSubject} doesn't support ${capability.label}.`
											: capability.issue === "connected-account-permission"
												? `The CommCare HQ account connected to Nova needs Mobile App Access before Nova can check ${capability.label} for ${targetObject}. Ask a project-space administrator to add that permission, then check again.`
												: `Nova couldn't confirm whether ${targetObject} supports ${capability.label}. Check your CommCare HQ connection, then try again.`}
									</p>
								) : null}
							</li>
						))}
					</ul>
				) : null}

				{missingCapabilities.length > 0 ? (
					<p className="mt-2 pl-6 text-xs leading-relaxed text-nova-text-secondary">
						Ask a project-space administrator or{" "}
						<a
							href={`mailto:${report.support_email}`}
							className="text-nova-violet-bright hover:underline"
						>
							Dimagi Support
						</a>{" "}
						to make {missingCapabilities.length === 1 ? "it" : "them"}{" "}
						available, then check again
					</p>
				) : null}
				{blocked || notChecked ? (
					<a
						href={report.docs_url}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-2 inline-flex items-center gap-1 pl-6 text-xs font-medium text-nova-violet-bright hover:underline"
					>
						Learn about project-space compatibility
						<Icon icon={tablerExternalLink} className="size-3" />
					</a>
				) : null}
			</div>

			{visibleAdvisories.map((advisory) => (
				<div
					key={advisory.id}
					role="status"
					className="rounded-lg border border-nova-amber/20 bg-nova-amber/[0.06] px-3 py-2.5"
				>
					<div className="flex items-start gap-2">
						<Icon
							icon={tablerInfoCircle}
							className="mt-0.5 size-4 shrink-0 text-nova-amber"
						/>
						<div>
							<p className="text-xs font-medium text-nova-text">
								{advisory.title}
							</p>
							<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
								{advisory.message}
							</p>
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
