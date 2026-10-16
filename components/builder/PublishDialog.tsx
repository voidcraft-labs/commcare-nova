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
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ConfirmationRequest,
	compactTargetRows,
	confirmationRequests,
	everyConfirmationGiven,
	preseededDomainSelection,
	sameConfirmationKey,
	upsertDeploymentViews,
	withLandedConfirmations,
} from "@/components/builder/app-setup/publishingSectionModel";
import { DeploymentStatus } from "@/components/builder/DeploymentStatus";
import { useSetDeploymentProjectSpace } from "@/components/builder/DeploymentTargetProvider";
import {
	landedWebAppsLine,
	type PublishLogoStepBody,
	publishOutcome,
} from "@/components/builder/publishOutcome";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogTitle,
} from "@/components/shadcn/dialog";
import {
	Field,
	FieldDescription,
	FieldLabel,
	FieldTitle,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useReconcilerContext } from "@/lib/collab/context";
import {
	BASELINE_UNKNOWN_SENTENCE,
	type CommCareServer,
	deploymentServerLabel,
	LOOKUP_ADOPTION_NOTE,
} from "@/lib/deployment";
import {
	type DeploymentView,
	type DownloadTargetsView,
	type RefreshedDeploymentView,
	readDeploymentsAction,
	readDownloadTargetsAction,
} from "@/lib/deployment/actions";
import type { ProjectSpaceConfirmationChecks } from "@/lib/deployment/confirmations";
import {
	type NextPublishAction,
	nextPublishAction,
} from "@/lib/deployment/resources";
import {
	NEEDS_PUBLISHED_PROJECT_SPACE,
	projectSpaceLabel,
	SELECTION_HELD_FROM_HQ,
} from "@/lib/deployment/runtimeTarget";
import type {
	DeploymentConfirmationKey,
	DeploymentConfirmationNeeded,
	DeploymentFailureCode,
	DeploymentRemoteChange,
	DeploymentResourceConflict,
	RemoteChangeDiscard,
} from "@/lib/deployment/types";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import type { ExportAdvisory } from "@/lib/publish/exportAdvisories";
import type { ManualImportStep } from "@/lib/publish/manualImportGuide";
import {
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	LOGO_UPLOAD_STEP_TEXT,
	PLAN_FEATURE_CONFIRM_LABEL,
} from "@/lib/publish/planFeatures";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import {
	useAccessPhase,
	useCanEdit,
	useNoteDeploymentRecordsChanged,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { describeApiFailure } from "@/lib/ui/apiFailure";

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

interface PublishDialogProps {
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
	/** Navigate to App setup's Publishing section, the durable home of the
	 *  records this dialog summarizes. Owned by PublishPanel (a plain
	 *  History-API push) so this dialog carries no location subscription. */
	onOpenPublishing: () => void;
	isRefreshingHqConnection: boolean;
	onRefreshHqConnection: () => void;
	onLoadProjectSpaceCompatibility: (
		domain: string | undefined,
		signal: AbortSignal,
	) => Promise<PublishProjectSpaceCompatibilityOutcome>;
	onDownloadJson: (server?: CommCareServer) => Promise<PublishDownloadOutcome>;
	/** A CCZ is made for one project space this app is published to. */
	onDownloadCcz: (target: {
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
			/** What the dialog says where Web Apps does not offer the app
			 *  on the space published to; null otherwise. */
			webAppsLine: string | null;
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

/** What publishing to the selected project space will do, or "unknown" before Nova can say. */
type PublishPlan = NextPublishAction | "unknown";

/** The project spaces a CCZ can be made for, loaded when the dialog opens. */
type DownloadTargets =
	| { type: "loading" }
	| { type: "ready"; view: DownloadTargetsView }
	| { type: "error"; message: string };

/** A select value for one project space: the server and the name together. */
function downloadTargetKey(target: {
	readonly server: CommCareServer;
	readonly domain: string;
}): string {
	return `${target.server}:${target.domain}`;
}

/** The deployments this app already has, loaded when the dialog opens. */
type ExistingDeployments =
	| { type: "idle" }
	| { type: "loading" }
	| { type: "ready"; views: readonly DeploymentView[] }
	| { type: "error"; message: string };

export function PublishDialog({
	open,
	onClose,
	getAppId,
	availableDomains,
	connectionServer,
	canUploadToHq,
	requestedDomain,
	onOpenPublishing,
	isRefreshingHqConnection,
	onRefreshHqConnection,
	onLoadProjectSpaceCompatibility,
	onDownloadJson,
	onDownloadCcz,
}: PublishDialogProps) {
	const accessPhase = useAccessPhase();
	const canEdit = useCanEdit();
	const session = useBuilderSessionApi();
	const setProjectSpace = useSetDeploymentProjectSpace();
	const reconciler = useReconcilerContext();
	const uploadControllerRef = useRef<AbortController | null>(null);
	const compatibilityControllerRef = useRef<AbortController | null>(null);
	const operationGenerationRef = useRef(0);
	const storeAppName = useAppName();
	const [target, setTarget] = useState<PublishTarget>(
		canUploadToHq ? "hq" : "web",
	);
	const [status, setStatus] = useState<PublishStatus>({ type: "idle" });
	const [appName, setAppName] = useState(storeAppName);
	const [selectedDomain, setSelectedDomain] = useState("");
	const [downloadServer, setDownloadServer] = useState<CommCareServer | "">("");
	const [downloadTargets, setDownloadTargets] = useState<DownloadTargets>({
		type: "loading",
	});
	/** The CCZ's project space, as `downloadTargetKey` spells it; "" for none chosen. */
	const [cczTargetKey, setCczTargetKey] = useState("");
	/** Counts the publishes that landed while this is open, so the CCZ's project spaces are read again after each. */
	const [landedPublishes, setLandedPublishes] = useState(0);
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
	const [compatibilityState, setCompatibilityState] =
		useState<ProjectSpaceCompatibilityState>({
			type: "loading",
		});
	const consentServerRef = useRef(connectionServer);
	useLayoutEffect(() => {
		if (consentServerRef.current === connectionServer) return;
		consentServerRef.current = connectionServer;
		setAdoptResourceIds([]);
		setDiscardRemoteChanges([]);
		setConfirmations([]);
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

	useEffect(
		() =>
			reconciler?.subscribeProjectScopeReset(() => {
				setStatus({ type: "idle" });
				handleClose();
			}),
		[handleClose, reconciler],
	);
	useEffect(() => {
		if (open) return;
		uploadControllerRef.current?.abort();
		uploadControllerRef.current = null;
	}, [open]);
	useEffect(
		() => () => {
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
	useLayoutEffect(() => {
		const justOpened = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!justOpened) return;
		setAdoptResourceIds([]);
		setDiscardRemoteChanges([]);
		setConfirmations([]);
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
	}, [open, storeAppName, availableDomains, canUploadToHq, requestedDomain]);
	useEffect(() => {
		if (!open || availableDomains.length === 0) return;
		setSelectedDomain((current) => {
			if (availableDomains.some((domain) => domain.name === current)) {
				return current;
			}
			return availableDomains.length === 1 ? availableDomains[0].name : "";
		});
	}, [open, availableDomains]);

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
	/* Which project spaces a CCZ can be made for: the same ledger read and
	 * the same lines the download itself answers from, so the dialog never
	 * offers a space the download would refuse. It is read when this opens
	 * and again after each publish that lands, since that publish can be
	 * what puts the app on a space. A pick that is still offered stays; one
	 * target is chosen for the person; several wait for their pick. */
	useEffect(() => {
		if (!open) return;
		void landedPublishes;
		let live = true;
		void readDownloadTargetsAction(getAppId())
			.then((result) => {
				if (!live) return;
				if (!result.success) {
					setDownloadTargets({ type: "error", message: result.message });
					return;
				}
				setDownloadTargets({ type: "ready", view: result.data });
				const keys = result.data.targets.map(downloadTargetKey);
				setCczTargetKey((current) =>
					keys.includes(current) ? current : keys.length === 1 ? keys[0] : "",
				);
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
	}, [open, getAppId, landedPublishes]);
	const cczTarget =
		downloadTargets.type === "ready"
			? (downloadTargets.view.targets.find(
					(candidate) => downloadTargetKey(candidate) === cczTargetKey,
				) ?? null)
			: null;

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
	/* Every refresh answers with the record AND what Preview may now name,
	 * because an observation can change both. */
	const handleRefreshed = useCallback(
		(next: RefreshedDeploymentView) => {
			upsertView(next);
			setProjectSpace(next.previewProjectSpace);
		},
		[upsertView, setProjectSpace],
	);

	/* What publishing to the selected project space will do. The SAME
	 * predicate the publish lifecycle applies server-side
	 * (`nextPublishAction`), read off the records this dialog already
	 * loads, so the form's blurb promises exactly what the request that
	 * follows will do — and "unknown" while the records are loading, when
	 * the read failed, or before a domain is picked, because a claim made
	 * in those windows would be a guess the upload could contradict. */
	const publishPlan: PublishPlan =
		existing.type !== "ready" || selectedDomain === ""
			? "unknown"
			: nextPublishAction(
					existing.views.find(
						(view) =>
							/* The server half matters: a record for a same-named
							 * space on another CommCare HQ installation says nothing
							 * about what this upload will do. */
							view.deployment.deployment.server === connectionServer &&
							view.deployment.deployment.domain === selectedDomain,
					)?.deployment ?? null,
				);

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
		target !== "hq" || Boolean(compatibilityDomain);
	useEffect(() => {
		if (!open || !shouldLoadCompatibility) {
			compatibilityControllerRef.current?.abort();
			compatibilityControllerRef.current = null;
			return;
		}
		loadProjectSpaceCompatibility();
		return () => {
			compatibilityControllerRef.current?.abort();
			compatibilityControllerRef.current = null;
		};
	}, [open, loadProjectSpaceCompatibility, shouldLoadCompatibility]);

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
			setTarget(next);
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
			setStatus({ type: "idle" });
			/* A choice about acme's tables says nothing about beta's. */
			setAdoptResourceIds([]);
			setDiscardRemoteChanges([]);
			setConfirmations([]);
		},
		[compatibilityDomain, invalidateCompatibilityReport],
	);
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
	const handleConfirmChange = useCallback(
		(key: DeploymentConfirmationKey, confirmed: boolean) => {
			setConfirmations((current) => {
				const rest = current.filter(
					(entry) => !sameConfirmationKey(entry, key),
				);
				return confirmed ? [...rest, key] : rest;
			});
		},
		[],
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
		setStatus({ type: "uploading" });

		try {
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
			setProjectSpace(outcome.previewProjectSpace);
			if (outcome.kind === "landed") {
				if (outcome.deployment !== null) upsertView(outcome.deployment);
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
				setLandedPublishes((count) => count + 1);
				const record = outcome.deployment?.deployment.deployment;
				setStatus({
					type: "landed",
					hqAppAction: outcome.hqAppAction,
					appUrl: outcome.appUrl,
					warnings: outcome.warnings,
					appPreviewNote: outcome.appPreviewNote,
					webAppsLine: landedWebAppsLine(
						outcome.webAppsEnabled,
						publishedDomain,
					),
					logoStep: outcome.logoStep,
					projectSpaceCompatibility: serverCompatibility,
					target:
						record === undefined
							? null
							: { server: record.server, domain: record.domain },
				});
				return;
			}
			if (outcome.deployment !== null) upsertView(outcome.deployment);
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
		compatibilityState,
		selectedDomain,
		appName,
		getAppId,
		session,
		setProjectSpace,
		upsertView,
	]);

	const handleDownload = useCallback(
		async (downloadTarget: "web" | "mobile") => {
			/* A CCZ is made for one project space; the button stays off until
			 * one is chosen, so there is nothing to send without it. */
			if (downloadTarget === "mobile" && cczTarget === null) return;
			const generation = ++operationGenerationRef.current;
			setStatus({ type: "downloading", target: downloadTarget });
			const outcome = await (cczTarget !== null && downloadTarget === "mobile"
				? onDownloadCcz(cczTarget)
				: onDownloadJson(downloadServer || undefined));
			if (operationGenerationRef.current !== generation) return;
			if (!outcome.ok) {
				setStatus({ type: "idle" });
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
		[onDownloadCcz, onDownloadJson, downloadServer, cczTarget],
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
	const allRemoteChangesConfirmed = remoteChangesToConfirm.every((change) =>
		discardRemoteChanges.some((entry) => sameRemoteChange(entry, change)),
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
	const allConfirmationsGiven = everyConfirmationGiven(
		requestedConfirmations,
		confirmations,
	);
	const canUpload =
		canEdit &&
		canUploadToHq &&
		!notConfigured &&
		!!selectedDomain &&
		!isWorking &&
		compatibilityAllowsUpload &&
		allRemoteChangesConfirmed &&
		allConfirmationsGiven &&
		appName.trim().length > 0;
	const downloadTarget = target === "mobile" ? "mobile" : "web";
	const downloadComplete =
		status.type === "download-success" && status.target === downloadTarget;
	const showCompatibilityPreflight =
		status.type !== "landed" &&
		status.type !== "refused" &&
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
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
			<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
				<div className="shrink-0 border-b border-nova-border px-5 pb-3 pt-5">
					<DialogTitle className="font-display tracking-tighter">
						Publish app
					</DialogTitle>
					<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
						Choose where to publish or which file to download
					</p>
				</div>

				<DialogBody className="mx-0 px-0">
					<div className="px-5 py-4">
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
									value={downloadServer}
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
									disabled={isWorking}
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
						<div className="mt-5 border-t border-nova-border pt-5">
							{target === "hq" ? (
								/* Only a publish that LANDED replaces the form. A refusal
								   keeps it mounted, because what has to change to make the
								   retry different is in it: the project space and the app
								   name. Swapping to a result screen and offering "Try
								   again" would re-send the exact request that just failed. */
								status.type === "landed" ? (
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
										{/* Said, never asked: CommCare HQ decided it from the
										    plan when it made the app, and Nova writes nothing
										    to it. */}
										{status.webAppsLine !== null ? (
											<p className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-2.5 text-left text-xs leading-relaxed text-nova-text-secondary">
												{status.webAppsLine}
											</p>
										) : null}
										{status.logoStep?.changed ? (
											<LogoStep
												step={status.logoStep}
												hqAppUrl={status.appUrl}
											/>
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
								) : notConfigured ? (
									<NotConfigured
										isRefreshing={isRefreshingHqConnection}
										onRefresh={onRefreshHqConnection}
									/>
								) : (
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
												projectSpaceCompatibility={
													status.projectSpaceCompatibility
												}
												projectSpaceName={compatibilityTargetDisplayName(
													status.projectSpaceCompatibility,
													availableDomains,
												)}
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
													/>
												) : null}
												{status.refusal.code === "hq_app_version_below_floor" &&
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
												{status.projectSpaceCompatibility?.status ===
												"blocked" ? (
													<div className="mt-2 flex justify-end">
														<Button
															type="button"
															variant="ghost"
															onClick={handleCheckCompatibilityAgain}
														>
															<Icon icon={tablerRefresh} className="size-4" />
															Check again
														</Button>
													</div>
												) : null}
											</PublishSuccess>
										) : null}
										{/* Before the form, in brief: where the app already is,
										    so the form below reads as "publish again" where it
										    is one. The full records — ladder, Check status,
										    workers, retry — live in the Publishing section,
										    which is one link away; a second full copy here
										    would be a second surface to keep honest. */}
										{existing.type === "ready" && existing.views.length > 0 ? (
											<ExistingTargetRows
												views={existing.views}
												connectionServer={connectionServer}
												onOpenPublishing={openPublishing}
											/>
										) : null}
										{existing.type === "error" ? (
											<p className="text-[13px] leading-relaxed text-nova-text-secondary">
												{existing.message}
											</p>
										) : null}
										{existing.type === "ready" && existing.views.length > 0 ? (
											<h3 className="mt-6 font-display text-[15px] font-semibold text-nova-text">
												Publish again
											</h3>
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
											publishPlan={publishPlan}
										/>
										{requestedConfirmations.length > 0 && canEdit ? (
											<ConfirmationChoice
												requests={requestedConfirmations}
												domain={selectedDomain}
												given={confirmations}
												onConfirmChange={handleConfirmChange}
												disabled={isWorking}
											/>
										) : null}
									</>
								)
							) : downloadComplete && status.type === "download-success" ? (
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
						</div>
					</div>
				</DialogBody>

				<DialogFooter
					className={`border-t border-nova-border px-5 py-4 ${
						target === "hq" && status.type === "landed" ? "justify-between" : ""
					}`}
				>
					{target === "hq" ? (
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
								<DialogClose render={<Button variant="outline" />}>
									Cancel
								</DialogClose>
								<Button
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
									) : remoteChangesToConfirm.length > 0 ? (
										"Publish over these changes"
									) : (
										"Upload"
									)}
								</Button>
							</>
						)
					) : downloadComplete ? (
						<Button type="button" variant="outline" onClick={handleClose}>
							Done
						</Button>
					) : target === "mobile" &&
						downloadTargets.type !== "loading" &&
						(downloadTargets.type === "error" ||
							downloadTargets.view.targets.length === 0) ? (
						<DialogClose render={<Button variant="outline" />}>
							Close
						</DialogClose>
					) : (
						<>
							<DialogClose render={<Button variant="outline" />}>
								Cancel
							</DialogClose>
							<Button
								type="button"
								onClick={() => handleDownload(downloadTarget)}
								disabled={
									isWorking ||
									(downloadTarget === "mobile" && cczTarget === null)
								}
							>
								{status.type === "downloading" ? (
									<>
										<Icon
											icon={tablerLoader2}
											className="size-4 animate-spin"
										/>
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
			</DialogContent>
		</Dialog>
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
							{!row.reachable ? (
								<span className="block text-[12px] font-normal text-nova-text-muted">
									On CommCare HQ's {deploymentServerLabel(row.server)} server,
									which this connection doesn't reach
								</span>
							) : row.nextPublish === "creates" && !row.stopped ? (
								<span className="block text-[12px] font-normal text-nova-text-muted">
									Publishing again creates a fresh app here
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
 * it stands, one (chosen for the person), or several (theirs to pick).
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
	const { targets, heldFromHq } = state.view;
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
	const items = targets.map((target) => ({
		value: downloadTargetKey(target),
		label: projectSpaceLabel(target),
	}));
	return (
		<Field className="mt-4 gap-1.5">
			<FieldLabel htmlFor="ccz-project-space">Project space</FieldLabel>
			<Select
				items={items}
				value={selectedKey}
				onValueChange={(value) => onSelectedKeyChange(value ?? "")}
				disabled={disabled}
			>
				<SelectTrigger id="ccz-project-space" className="w-full">
					<SelectValue placeholder="Choose a project space" />
				</SelectTrigger>
				<SelectContent>
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<FieldDescription>
				The CCZ signs workers in to this project space and uses its app and form
				ids, so its forms land with the ones already collected there.
			</FieldDescription>
		</Field>
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
					<li key={step.kind} className="text-xs leading-relaxed">
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
	publishPlan,
}: {
	availableDomains: Domain[];
	domainItems: { label: string; value: string }[];
	isMultiSpace: boolean;
	selectedDomain: string;
	onSelectedDomainChange: (value: string) => void;
	appName: string;
	onAppNameChange: (value: string) => void;
	status: PublishStatus;
	/** What publishing will do to the selected project space's app. */
	publishPlan: PublishPlan;
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
						<div className="flex items-center gap-3 rounded-lg border border-nova-emerald/15 bg-nova-emerald/[0.04] px-3.5 py-2.5">
							<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-nova-emerald/10">
								<Icon
									icon={tablerCircleCheck}
									className="size-4 text-nova-emerald"
								/>
							</div>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium leading-snug text-nova-text">
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
					{publishPlan === "updates"
						? "Uploading updates the app an earlier publish put on this project space, keeping the same app there. Nova checks that the project space can run this version before anything is sent."
						: publishPlan === "creates"
							? "Uploading creates a new app in the selected project space. Nova checks that the project space can run it before anything is sent."
							: publishPlan === "fills-shell"
								? "Nova made an empty app here on an earlier try. Uploading fills it in."
								: "Nova checks that the selected project space can run this app before anything is sent."}
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
		<section
			aria-labelledby="publish-confirmations-heading"
			className="mt-5 rounded-lg border border-nova-border bg-nova-elevated px-3 py-3"
		>
			<h4
				id="publish-confirmations-heading"
				className="text-[13px] font-semibold text-nova-text"
			>
				What this project space needs
			</h4>
			<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
				Nova can't read these from CommCare HQ. You can tick each one {space}{" "}
				has, and Nova keeps your answer for the next publish there. Nova can't
				see a later change to the plan either, so you can withdraw an answer in
				App setup.
			</p>
			<ul className="mt-2.5 flex flex-col gap-2">
				{requests.map((request) => {
					const id = `confirm-${request.kind}-${request.key.kind === "plan-feature" ? request.key.subject : request.kind}`;
					const setting =
						request.kind === "flat-location-fixture"
							? FLAT_LOCATION_FIXTURE
							: request.kind === "connect-forwarder"
								? CONNECT_FORWARDER
								: null;
					return (
						<li
							key={id}
							className="rounded-lg border border-nova-border bg-nova-well px-3 py-2.5 text-xs leading-relaxed"
						>
							<p className="text-[13px] font-medium text-nova-text">
								{request.label}
							</p>
							{setting !== null ? (
								<p className="mt-1 text-nova-text">{setting.question(space)}</p>
							) : request.plans !== "" ? (
								<p className="mt-0.5 text-nova-text-muted">
									Included in the {request.plans} plans.
								</p>
							) : null}
							{request.reasons.length > 0 ? (
								<ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-4 text-nova-text-secondary">
									{request.reasons.map((reason, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: two forms of the same name give the same sentence, so the text is no key.
										<li key={index}>{reason}</li>
									))}
								</ul>
							) : null}
							<p className="mt-1.5 text-nova-text-secondary">
								{request.consequence}
							</p>
							<label
								htmlFor={id}
								className="mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-nova-text"
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
							{setting !== null ? (
								<p className="text-nova-text-muted">{setting.whereMissing}</p>
							) : null}
						</li>
					);
				})}
			</ul>
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
 * What changed in CommCare HQ since Nova last published there, and the
 * only thing that lets the publish write over it.
 *
 * Each change is ticked on its own and starts unticked, like a name clash:
 * publishing over one replaces what a person made in CommCare HQ with this
 * app's version, so nobody does it by default. A tick is bound to the state
 * the refusal showed, which is what the resend names back.
 */
function RemoteChangeChoice({
	changes,
	discarded,
	onDiscardChange,
}: {
	changes: readonly DeploymentRemoteChange[];
	discarded: readonly RemoteChangeDiscard[];
	onDiscardChange: (change: DeploymentRemoteChange, discard: boolean) => void;
}) {
	return (
		<ul className="mt-3 flex flex-col gap-2">
			{changes.map((change) => {
				const id = `discard-${change.kind}-${change.novaResourceId}`;
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
						{change.baselineKnown ? (
							<ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-nova-text-secondary">
								{change.parts.map((part, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: two parts can name forms of the same name, so the text is no key.
									<li key={index}>{part}</li>
								))}
							</ul>
						) : (
							<p className="mt-1.5 text-xs leading-relaxed text-nova-text-secondary">
								{BASELINE_UNKNOWN_SENTENCE}
							</p>
						)}
						{change.note !== null ? (
							<p className="mt-1.5 text-xs leading-relaxed text-nova-text-secondary">
								{change.note}
							</p>
						) : null}
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
					</li>
				);
			})}
		</ul>
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

function NotConfigured({
	isRefreshing,
	onRefresh,
}: {
	isRefreshing: boolean;
	onRefresh: () => void;
}) {
	return (
		<div className="rounded-xl border border-nova-amber/20 bg-nova-amber/[0.06] p-4">
			<div className="flex items-start gap-3">
				<Icon
					icon={tablerInfoCircle}
					className="mt-0.5 size-5 shrink-0 text-nova-amber"
				/>
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-nova-text">
						Connect CommCare HQ to upload
					</h3>
					<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
						You can add your CommCare HQ API key in Settings to upload directly
						from commcare nova
					</p>
					<p className="mt-2 text-xs leading-relaxed text-nova-text-muted">
						You can still choose a CommCare HQ app file or mobile app file above
					</p>
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2 pl-8">
				<Link
					href="/settings"
					target="_blank"
					rel="noopener noreferrer"
					className="nova-focusable inline-flex h-11 items-center gap-1 px-2 text-[15px] font-medium text-nova-violet-bright hover:underline"
				>
					Open Settings
					<Icon icon={tablerExternalLink} className="size-4" />
				</Link>
				<Button
					type="button"
					variant="outline"
					onClick={onRefresh}
					disabled={isRefreshing}
				>
					<Icon
						icon={tablerRefresh}
						className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
					/>
					{isRefreshing ? "Checking connection" : "Check connection"}
				</Button>
			</div>
		</div>
	);
}
