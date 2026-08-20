/**
 * Unified publish flow for direct HQ upload, HQ JSON, and mobile CCZ.
 *
 * All three destinations stay in one durable modal because publish results can
 * carry important prerequisite and follow-up information. One selector changes
 * the destination-specific fields and action while shared app requirements keep
 * one stable place before every action. Connected HQ domains are probed on open,
 * selection, refresh, and upload; exact post-publish results remain in the modal.
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
	useMemo,
	useRef,
	useState,
} from "react";
import {
	compactTargetRows,
	preseededDomainSelection,
	upsertDeploymentViews,
} from "@/components/builder/app-setup/publishingSectionModel";
import { DeploymentStatus } from "@/components/builder/DeploymentStatus";
import { useSetDeploymentProjectSpace } from "@/components/builder/DeploymentTargetProvider";
import { publishOutcome } from "@/components/builder/publishOutcome";
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
import { type CommCareServer, deploymentServerLabel } from "@/lib/deployment";
import {
	type DeploymentView,
	type RefreshedDeploymentView,
	readDeploymentsAction,
} from "@/lib/deployment/actions";
import { plannedInPlaceUpdate } from "@/lib/deployment/resources";
import type { DeploymentResourceConflict } from "@/lib/deployment/types";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import type { ExportAdvisory } from "@/lib/publish/exportAdvisories";
import type { HqFeatureFlagReport } from "@/lib/publish/hqFeatureFlags";
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
		description: "Download a JSON file to import into CommCare HQ",
		icon: tablerBrowser,
	},
	mobile: {
		label: "CommCare mobile app file",
		description: "Download a CCZ package for CommCare Android",
		icon: tablerDeviceMobile,
	},
} as const;

export type PublishDownloadOutcome =
	| {
			readonly ok: true;
			readonly featureFlagReport?: HqFeatureFlagReport;
			/** What the file could not carry. Empty on an ordinary download. */
			readonly advisories?: readonly ExportAdvisory[];
	  }
	| { readonly ok: false };

export type PublishFeatureFlagOutcome =
	| { readonly ok: true; readonly report: HqFeatureFlagReport }
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
	onLoadFeatureFlags: (
		domain: string | undefined,
		signal: AbortSignal,
	) => Promise<PublishFeatureFlagOutcome>;
	onDownloadJson: () => Promise<PublishDownloadOutcome>;
	onDownloadCcz: () => Promise<PublishDownloadOutcome>;
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
			featureFlagReport?: HqFeatureFlagReport;
			/** Null when the response carried no record to point at. */
			target: { server: string; domain: string } | null;
	  }
	| {
			/* This attempt was refused. The refusal is the attempt's own
			 * report; whatever durable record the target has renders once,
			 * in the shared deployments list, rather than a second copy
			 * here that would drift from it. */
			type: "refused";
			refusal: { detail: string; items: readonly string[] };
			/** What the publish would have written over and did not. */
			resourceConflicts: readonly DeploymentResourceConflict[];
			warnings: string[];
			featureFlagReport?: HqFeatureFlagReport;
	  }
	| {
			type: "download-success";
			target: "web" | "mobile";
			featureFlagReport?: HqFeatureFlagReport;
			advisories?: readonly ExportAdvisory[];
	  }
	| { type: "error"; message: string; status: number; details: string[] };

type FeatureFlagState =
	| { type: "loading" }
	| { type: "ready"; report: HqFeatureFlagReport }
	| { type: "error"; message: string };

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
	onLoadFeatureFlags,
	onDownloadJson,
	onDownloadCcz,
}: PublishDialogProps) {
	const accessPhase = useAccessPhase();
	const canEdit = useCanEdit();
	const session = useBuilderSessionApi();
	const setProjectSpace = useSetDeploymentProjectSpace();
	const reconciler = useReconcilerContext();
	const uploadControllerRef = useRef<AbortController | null>(null);
	const featureFlagControllerRef = useRef<AbortController | null>(null);
	const operationGenerationRef = useRef(0);
	const storeAppName = useAppName();
	const [target, setTarget] = useState<PublishTarget>(
		canUploadToHq ? "hq" : "web",
	);
	const [status, setStatus] = useState<PublishStatus>({ type: "idle" });
	const [appName, setAppName] = useState(storeAppName);
	const [selectedDomain, setSelectedDomain] = useState("");
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
	const [featureFlagState, setFeatureFlagState] = useState<FeatureFlagState>({
		type: "loading",
	});
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
	useEffect(() => {
		const justOpened = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!justOpened) return;
		operationGenerationRef.current += 1;
		setStatus({ type: "idle" });
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
	 * (`plannedInPlaceUpdate`), read off the records this dialog already
	 * loads, so the form's blurb promises exactly what the request that
	 * follows will do — and "unknown" while the records are loading, when
	 * the read failed, or before a domain is picked, because a claim made
	 * in those windows would be a guess the upload could contradict. */
	const publishPlan: "update" | "create" | "unknown" =
		existing.type !== "ready" || selectedDomain === ""
			? "unknown"
			: existing.views.some(
						(view) =>
							/* The server half matters: a record for a same-named
							 * space on another CommCare HQ installation says nothing
							 * about what this upload will do. */
							view.deployment.deployment.server === connectionServer &&
							view.deployment.deployment.domain === selectedDomain &&
							plannedInPlaceUpdate(view.deployment) !== null,
					)
				? "update"
				: "create";

	const featureFlagDomain =
		target === "hq"
			? selectedDomain ||
				(availableDomains.length === 1 ? availableDomains[0].name : undefined)
			: undefined;
	const loadFeatureFlagReport = useCallback(() => {
		featureFlagControllerRef.current?.abort();
		const controller = new AbortController();
		featureFlagControllerRef.current = controller;
		setFeatureFlagState({ type: "loading" });
		void onLoadFeatureFlags(featureFlagDomain, controller.signal).then(
			(outcome) => {
				if (featureFlagControllerRef.current !== controller) return;
				featureFlagControllerRef.current = null;
				setFeatureFlagState(
					outcome.ok
						? { type: "ready", report: outcome.report }
						: { type: "error", message: outcome.message },
				);
			},
		);
	}, [featureFlagDomain, onLoadFeatureFlags]);
	const shouldLoadFeatureFlags = target !== "hq" || Boolean(featureFlagDomain);
	useEffect(() => {
		if (!open || !shouldLoadFeatureFlags) {
			featureFlagControllerRef.current?.abort();
			featureFlagControllerRef.current = null;
			return;
		}
		loadFeatureFlagReport();
		return () => {
			featureFlagControllerRef.current?.abort();
			featureFlagControllerRef.current = null;
		};
	}, [open, loadFeatureFlagReport, shouldLoadFeatureFlags]);

	const invalidateFeatureFlagReport = useCallback(() => {
		const controller = featureFlagControllerRef.current;
		featureFlagControllerRef.current = null;
		controller?.abort();
		setFeatureFlagState({ type: "loading" });
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
			if (nextDomain !== featureFlagDomain) invalidateFeatureFlagReport();
			operationGenerationRef.current += 1;
			setTarget(next);
			setStatus({ type: "idle" });
		},
		[
			availableDomains,
			featureFlagDomain,
			invalidateFeatureFlagReport,
			selectedDomain,
		],
	);
	const handleSelectedDomainChange = useCallback(
		(next: string) => {
			if (next !== featureFlagDomain) invalidateFeatureFlagReport();
			operationGenerationRef.current += 1;
			setSelectedDomain(next);
			setStatus({ type: "idle" });
			/* A choice about acme's tables says nothing about beta's. */
			setAdoptResourceIds([]);
		},
		[featureFlagDomain, invalidateFeatureFlagReport],
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
	const handleRefreshFeatureFlags = useCallback(() => {
		loadFeatureFlagReport();
	}, [loadFeatureFlagReport]);

	const handleUpload = useCallback(async () => {
		if (!selectedDomain || !appName.trim()) return;
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
		setStatus({ type: "uploading" });

		try {
			const response = await fetch("/api/commcare/upload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					domain: selectedDomain,
					appName: appName.trim(),
					appId: getAppId(),
					adopt_resources: adoptResourceIds,
				}),
				signal: controller.signal,
			});
			if (!isCurrent()) {
				void response.body?.cancel();
				return;
			}
			const data = (await response.json()) as Parameters<
				typeof publishOutcome
			>[1] & { feature_flag_requirements?: HqFeatureFlagReport };
			if (!isCurrent()) return;

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
				/* Taking a table over happened; the ledger remembers it now, so
				 * the next publish must not re-assert a choice nobody made
				 * again. */
				setAdoptResourceIds([]);
				const record = outcome.deployment?.deployment.deployment;
				setStatus({
					type: "landed",
					hqAppAction: outcome.hqAppAction,
					appUrl: outcome.appUrl,
					warnings: outcome.warnings,
					featureFlagReport: data.feature_flag_requirements,
					target:
						record === undefined
							? null
							: { server: record.server, domain: record.domain },
				});
				return;
			}
			if (outcome.deployment !== null) upsertView(outcome.deployment);
			setStatus({
				type: "refused",
				refusal: {
					detail: outcome.refusal.message,
					items: outcome.refusal.items,
				},
				resourceConflicts: outcome.resourceConflicts,
				warnings: outcome.warnings,
				featureFlagReport: data.feature_flag_requirements,
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
		selectedDomain,
		appName,
		getAppId,
		session,
		setProjectSpace,
		upsertView,
	]);

	const handleDownload = useCallback(
		async (downloadTarget: "web" | "mobile") => {
			const generation = ++operationGenerationRef.current;
			setStatus({ type: "downloading", target: downloadTarget });
			const outcome = await (downloadTarget === "web"
				? onDownloadJson()
				: onDownloadCcz());
			if (operationGenerationRef.current !== generation) return;
			if (!outcome.ok) {
				setStatus({ type: "idle" });
				return;
			}
			setStatus({
				type: "download-success",
				target: downloadTarget,
				featureFlagReport: outcome.featureFlagReport,
				advisories: outcome.advisories,
			});
		},
		[onDownloadCcz, onDownloadJson],
	);

	const isWorking =
		status.type === "uploading" || status.type === "downloading";
	const hasFeatureFlagPreflight = featureFlagState.type === "ready";
	const canUpload =
		canEdit &&
		canUploadToHq &&
		!notConfigured &&
		!!selectedDomain &&
		!isWorking &&
		hasFeatureFlagPreflight &&
		appName.trim().length > 0;
	const downloadTarget = target === "mobile" ? "mobile" : "web";
	const downloadComplete =
		status.type === "download-success" && status.target === downloadTarget;
	const showFeatureFlagPreflight =
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
										featureFlagReport={status.featureFlagReport}
										mode="upload"
									>
										{/* The app is THERE, which is not the same as ready
										    for workers. The record says which, so the
										    celebration never outruns the facts. */}
										{landedView !== null ? (
											<DeploymentStatus
												appId={getAppId()}
												view={landedView}
												canRefresh={canEdit}
												onUpdated={handleRefreshed}
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
												blocked={status.refusal}
												warnings={status.warnings}
												featureFlagReport={status.featureFlagReport}
												mode="upload"
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
									</>
								)
							) : downloadComplete && status.type === "download-success" ? (
								<PublishSuccess
									title={
										target === "web"
											? "CommCare HQ app file downloaded"
											: "Mobile app file downloaded"
									}
									featureFlagReport={status.featureFlagReport}
									advisories={status.advisories}
									mode="download"
								/>
							) : null}

							{showFeatureFlagPreflight && (
								<FeatureFlagPreflight
									state={featureFlagState}
									domainChecked={target === "hq"}
									onRefresh={
										target === "hq" || featureFlagState.type === "error"
											? handleRefreshFeatureFlags
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
					) : (
						<>
							<DialogClose render={<Button variant="outline" />}>
								Cancel
							</DialogClose>
							<Button
								type="button"
								onClick={() => handleDownload(downloadTarget)}
								disabled={isWorking || !hasFeatureFlagPreflight}
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
										{downloadTarget === "web"
											? "Download JSON"
											: "Download CCZ"}
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
							) : !row.updatesInPlace && !row.stopped ? (
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
	publishPlan: "update" | "create" | "unknown";
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
					{publishPlan === "update"
						? "Uploading updates the app an earlier publish put on this project space, keeping the same app there. This window checks its feature flags now and again after upload."
						: publishPlan === "create"
							? "Uploading creates a new app in the selected project space. This window checks its feature flags now and again after upload."
							: "This window checks the selected project space's feature flags now and again after upload."}
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

function FeatureFlagPreflight({
	state,
	domainChecked = false,
	onRefresh,
}: {
	state: FeatureFlagState;
	domainChecked?: boolean;
	onRefresh?: () => void;
}) {
	if (state.type === "loading") {
		return (
			<div className="mt-3 flex items-center gap-2 rounded-lg border border-white/[0.04] bg-white/[0.03] px-3 py-2.5">
				<Icon
					icon={tablerLoader2}
					className="size-4 shrink-0 animate-spin text-nova-violet-bright"
				/>
				<p className="text-xs text-nova-text-secondary">
					{domainChecked
						? "Checking feature flags for this project space"
						: "Checking which feature flags this app needs"}
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
	const refreshLabel = "Check again";
	if (report.required_flags.length === 0) {
		return (
			<div className="mt-3">
				<div
					role="status"
					className="flex items-start gap-2 rounded-lg border border-nova-emerald/15 bg-nova-emerald/[0.04] px-3 py-2.5"
				>
					<Icon
						icon={tablerCircleCheck}
						className="mt-0.5 size-4 shrink-0 text-nova-emerald"
					/>
					<p className="text-xs leading-relaxed text-nova-text-secondary">
						This app doesn't need any CommCare HQ feature flags
					</p>
				</div>
				{onRefresh && (
					<div className="flex justify-end">
						<Button type="button" variant="ghost" onClick={onRefresh}>
							<Icon icon={tablerRefresh} className="size-4" />
							{refreshLabel}
						</Button>
					</div>
				)}
			</div>
		);
	}

	return (
		<div>
			<FeatureFlagNotice
				report={report}
				mode={report.target_domain ? "domain-check" : "prepublish"}
			/>
			{onRefresh && (
				<div className="flex justify-end">
					<Button type="button" variant="ghost" onClick={onRefresh}>
						<Icon icon={tablerRefresh} className="size-4" />
						{refreshLabel}
					</Button>
				</div>
			)}
		</div>
	);
}

function PublishSuccess({
	title,
	warnings = [],
	featureFlagReport,
	advisories = [],
	mode,
	tone = "done",
	blocked,
	children,
}: {
	title: string;
	warnings?: string[];
	featureFlagReport?: HqFeatureFlagReport;
	/** Only a download has these: a publish always knows its own target. */
	advisories?: readonly ExportAdvisory[];
	mode: "upload" | "download";
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

			{featureFlagReport && (
				<FeatureFlagNotice report={featureFlagReport} mode={mode} />
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

function FeatureFlagNotice({
	report,
	mode,
}: {
	report: HqFeatureFlagReport;
	mode: "upload" | "download" | "prepublish" | "domain-check";
}) {
	if (report.required_flags.length === 0) return null;
	const isDomainResult = mode === "upload" || mode === "domain-check";
	if (
		isDomainResult &&
		report.missing_flags.length > 0 &&
		report.unverified_flags.length > 0
	) {
		const missingReport: HqFeatureFlagReport = {
			...report,
			verification: "verified",
			required_flags: report.missing_flags,
			unverified_flags: [],
		};
		const unverifiedReport: HqFeatureFlagReport = {
			...report,
			verification: "unavailable",
			required_flags: report.unverified_flags,
			missing_flags: [],
		};
		return (
			<div>
				<FeatureFlagNotice report={missingReport} mode={mode} />
				<FeatureFlagNotice report={unverifiedReport} mode={mode} />
			</div>
		);
	}
	const needsAttention =
		mode === "download" ||
		mode === "prepublish" ||
		report.missing_flags.length > 0 ||
		report.unverified_flags.length > 0;
	if (!needsAttention) {
		const flagLabels = report.required_flags
			.map((flag) => flag.label)
			.join(", ");
		return (
			<div
				role="status"
				className="mt-3 flex items-start gap-2 rounded-lg border border-nova-emerald/15 bg-nova-emerald/[0.04] px-3 py-2.5"
			>
				<Icon
					icon={tablerCircleCheck}
					className="mt-0.5 size-4 shrink-0 text-nova-emerald"
				/>
				<div>
					<p className="text-xs font-medium text-nova-text">
						Feature flags are ready
					</p>
					<p className="mt-0.5 text-xs leading-relaxed text-nova-text-muted">
						{flagLabels} {report.required_flags.length === 1 ? "is" : "are"}{" "}
						enabled for this project space
					</p>
				</div>
			</div>
		);
	}

	const flags =
		mode === "download" || mode === "prepublish"
			? report.required_flags
			: [
					...report.missing_flags,
					...report.unverified_flags.filter(
						(flag) =>
							!report.missing_flags.some((missing) => missing.id === flag.id),
					),
				];
	const confirmedMissing = isDomainResult && report.missing_flags.length > 0;
	const noticeMessage = featureFlagNoticeMessage(report, mode);
	return (
		<div
			role={confirmedMissing ? "alert" : "status"}
			className={`mt-3 rounded-lg border px-3 py-3 ${
				confirmedMissing
					? "border-nova-amber/25 bg-nova-amber/[0.06]"
					: "border-nova-violet/25 bg-nova-violet/[0.05]"
			}`}
		>
			<div className="flex items-start gap-2">
				<Icon
					icon={confirmedMissing ? tablerAlertCircle : tablerInfoCircle}
					className={`mt-0.5 size-4 shrink-0 ${
						confirmedMissing ? "text-nova-amber" : "text-nova-violet-bright"
					}`}
				/>
				<div className="min-w-0">
					<p className="text-xs font-semibold text-nova-text">
						{featureFlagNoticeTitle(report, mode)}
					</p>
					<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
						{noticeMessage}
					</p>
				</div>
			</div>
			<ul className="mt-2 space-y-2 pl-6">
				{flags.map((flag) => (
					<li key={flag.id} className="text-xs leading-relaxed">
						<div className="flex flex-wrap items-baseline gap-x-1.5">
							<span className="font-medium text-nova-text">{flag.label}</span>
							<a
								href={flag.docs_url}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-nova-violet-bright hover:underline"
							>
								Learn more
								<Icon icon={tablerExternalLink} className="size-3" />
								<span className="sr-only"> about {flag.label}</span>
							</a>
						</div>
						<p className="text-nova-text-muted">{flag.description}</p>
					</li>
				))}
			</ul>
			<p className="mt-2 pl-6 text-xs text-nova-text-secondary">
				{confirmedMissing ? (
					<>
						To have {flags.length === 1 ? "this flag" : "these flags"} enabled,
						contact{" "}
					</>
				) : (
					<>
						If {flags.length === 1 ? "this flag needs" : "any flags need"} to be
						enabled, contact{" "}
					</>
				)}
				<a
					href={`mailto:${report.support_email}`}
					className="text-nova-violet-bright hover:underline"
				>
					{report.support_email}
				</a>{" "}
				and include{" "}
				{report.target_domain ? (
					<>the “{report.target_domain}” project space</>
				) : (
					"the destination project space"
				)}
			</p>
		</div>
	);
}

function featureFlagNoticeMessage(
	report: HqFeatureFlagReport,
	mode: "upload" | "download" | "prepublish" | "domain-check",
): string {
	if (mode === "download" || mode === "prepublish") {
		return "The destination project space hasn't been checked. It needs the feature flags below before workers use the app. If they aren't enabled, workers might not see these features or might get an error.";
	}

	const target = report.target_domain
		? `the “${report.target_domain}” project space`
		: "this project space";
	const hasMissing = report.missing_flags.length > 0;
	const hasUnverified = report.unverified_flags.length > 0;
	if (hasMissing && hasUnverified) {
		const message = `Some feature flags below aren't enabled for ${target}, and CommCare HQ couldn't check the others. If any aren't enabled, workers might not see those features or might get an error.`;
		return mode === "upload" ? `Your app was uploaded. ${message}` : message;
	}
	if (hasMissing) {
		const subject =
			report.missing_flags.length === 1
				? "The feature flag below isn't"
				: "The feature flags below aren't";
		const message = `${subject} enabled for ${target}`;
		const consequence =
			report.missing_flags.length === 1
				? "Workers might not see this feature or might get an error until it's enabled."
				: "Workers might not see these features or might get an error until they're enabled.";
		return mode === "upload"
			? `Your app was uploaded, but ${message.toLowerCase()}. ${consequence}`
			: `${message}. ${consequence}`;
	}
	const message = `CommCare HQ couldn't confirm whether the feature flags below are enabled for ${target}. If they aren't enabled, workers might not see those features or might get an error.`;
	return mode === "upload" ? `Your app was uploaded. ${message}` : message;
}

function featureFlagNoticeTitle(
	report: HqFeatureFlagReport,
	mode: "upload" | "download" | "prepublish" | "domain-check",
): string {
	if (mode === "download" || mode === "prepublish") {
		return "This app uses CommCare HQ feature flags";
	}
	if (report.missing_flags.length > 0) {
		return report.unverified_flags.length > 0
			? "Some feature flags need attention"
			: "Feature flags aren't enabled";
	}
	return "Feature flag check incomplete";
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
