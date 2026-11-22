/**
 * Where an app stands on one CommCare HQ project space, and what is left
 * to do there.
 *
 * The whole component exists to keep one promise: never imply the app is
 * further along than it is. The progress states are drawn as a
 * ladder, the reached ones filled and the rest plainly not, and a state
 * Nova has not observed says what is missing rather than showing a
 * hopeful blank. `incomplete` is drawn as a refusal, not as a rung.
 *
 * Nova can put the tables and the app on a project space but cannot make
 * a version or release one, because CommCare HQ allows both only from a
 * signed-in browser session. So the last three rungs are things this
 * screen WATCHES, and the setup notes are how somebody makes them happen.
 *
 * A record of an app brought in from CommCare HQ says where it came from,
 * and until Nova's first publish there the "On CommCare HQ" rung says Nova
 * read the app and has not published to it. A deployment that stopped
 * (`deploymentEnding`, never the state) draws its ending in place of the
 * ladder, Check status and the kept list, with a link to the HQ app it
 * stopped at unless another Nova app publishes to that app now. A member who
 * may delete the Project's apps is offered Stop publishing here while the
 * deployment has a live app mapping.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import {
	type ReactNode,
	useCallback,
	useId,
	useState,
	useTransition,
} from "react";
import {
	broughtInOf,
	checkStatusOffered,
	DEPLOYMENT_STATE_LABELS,
	endedCardOf,
	liveConfirmationRows,
	readNotPublishedSince,
	stopPublishingOffered,
} from "@/components/builder/app-setup/publishingSectionModel";
import { useApplyPreviewDeploymentAnswer } from "@/components/builder/DeploymentTargetProvider";
import { HqChangesDialog } from "@/components/builder/HqChangesDialog";
import {
	cardDriftReference,
	keptRefreshOffersReview,
	sameHqChangedTarget,
} from "@/components/builder/hqChangesPanelModel";
import {
	KEPT_REFRESH_BUTTON,
	KEPT_REFRESH_BUTTON_PENDING,
	type KeptRefreshNotice,
	keptDateText,
	keptNoticeApplies,
	keptRefreshNotice,
	keptRefreshNotReached,
	refreshedViewToShow,
	type ShownRefreshedView,
} from "@/components/builder/keptListModel";
import { StopPublishingDialog } from "@/components/builder/StopPublishingDialog";
import { Button } from "@/components/shadcn/button";
import type {
	DeploymentProgressState,
	SetupArtifactSection,
} from "@/lib/deployment";
import {
	DEPLOYMENT_PROGRESS_STATES,
	DEPLOYMENT_STATE_PRODUCING_PHASE,
	type DeploymentPhase,
	type DeploymentResource,
	deploymentDisplaysAsReached,
	hqPlaceUrl,
} from "@/lib/deployment";
import {
	type DeploymentView,
	refreshDeploymentAction,
	refreshKeptValuesAction,
	type StoppedPublishingView,
	withdrawDeploymentConfirmationAction,
} from "@/lib/deployment/actions";
import {
	activeRemoteApp,
	remoteAppReportedGone,
} from "@/lib/deployment/resources";
import type {
	DeploymentConfirmationKey,
	DeploymentKept,
} from "@/lib/deployment/types";
import { useOrganizationLevels } from "@/lib/doc/hooks/useOrganizationCollections";
import {
	broughtInFromLine,
	notPublishedYetLine,
} from "@/lib/publish/bringInCopy";
import { viewerDriftDate } from "@/lib/publish/driftReference";
import {
	hqChangedFoundLine,
	SEE_WHAT_CHANGED_ACTION,
	sincePhrase,
} from "@/lib/publish/hqChangesCopy";
import {
	KEPT_FOLLOWS_LINE,
	KEPT_LABELS,
	keptLead,
} from "@/lib/publish/keptValues";
import {
	ENDED_HQ_APP_LINK,
	endedLine,
	GONE_APP_NEXT_PUBLISH,
	STOP_PUBLISHING_ACTION,
	STOP_PUBLISHING_HELPER,
} from "@/lib/publish/stopPublishing";
import {
	useClearHqChangedTarget,
	useHqChangedTargets,
	useNoteDeploymentRecordsChanged,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { PlaceWorkbookButton } from "./PlaceWorkbookButton";

/**
 * How each resume point reads in a sentence.
 *
 * Separate from `DEPLOYMENT_STATE_LABELS` because those are column headings and these
 * are mid-sentence clauses: lower-casing "On CommCare HQ" produced "carry
 * on from on commcare hq", and "Checked" produced "carry on from checked".
 */
const RESUME_SENTENCE: Readonly<Record<DeploymentPhase, string>> = {
	preflight: "Try publishing again once it is sorted.",
	resources:
		"Try publishing again once it is sorted. The app itself has not been sent yet.",
	upload: "Try publishing again once it is sorted.",
	build:
		"Nothing before this needs doing again. Choose Check status once CommCare HQ has built it.",
	release:
		"Nothing before this needs doing again. Choose Check status once you have released it.",
	probe:
		"Nothing before this needs doing again. Choose Check status to try again.",
};

/**
 * A day as the card writes every date it shows, in the reader's own locale:
 * when a confirmation was given, when an app was brought in, when
 * publishing stopped.
 */
function cardDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

export function DeploymentStatus({
	appId,
	view,
	canRefresh = true,
	canStop = false,
	onUpdated,
	onWithdrawn,
	workers,
}: {
	appId: string;
	view: DeploymentView;
	/**
	 * Whether this viewer may ask CommCare HQ again. Checking WRITES what
	 * it observed, so a viewer may not. Offering a button that would be
	 * refused is worse than not offering it.
	 */
	canRefresh?: boolean;
	/**
	 * Whether this viewer may stop publishing here: a member whose role
	 * allows `delete`. The App setup section passes it; the card the Publish
	 * dialog draws passes none, so that card offers no stop.
	 */
	canStop?: boolean;
	/** Lets the surrounding surface keep the record it is holding current. */
	onUpdated: (next: ShownRefreshedView) => void;
	/**
	 * Takes the record a withdrawn confirmation answers with. Withdrawing
	 * changes what the next publish asks, never which project space Preview
	 * names, so it answers with the record alone. Absent where the surface
	 * holds no record to update, and then no Withdraw is offered.
	 */
	onWithdrawn?: (next: DeploymentView) => void;
	/**
	 * The Workers panel, when this record's surface owns one. A slot rather
	 * than a built-in render because a worker's password is shown in exactly
	 * one place — the App setup Publishing section composes `DeploymentWorkers`
	 * here, and every other surface (the Publish dialog) passes nothing, so
	 * a second credential surface cannot exist by accident.
	 */
	workers?: ReactNode;
}) {
	const record = view.deployment.deployment;
	/* The HQ app a stop from this card names: the one this record shows. */
	const stopHqAppId = activeRemoteApp(view.deployment)?.remoteId ?? null;
	/* An app with no lookup tables and no places has no data rung: drawing
	 * it would leave a step permanently unticked at preflight and then tick
	 * it on upload for work that never ran. The artifact is the honest
	 * signal because it regenerates from the document on every read, so the
	 * rung appears the moment a select starts reading a table or a place is
	 * added, and goes when the last one stops. */
	const pushesResources = view.artifact.sections.some(
		(section) => section.id === "lookup-tables" || section.id === "places",
	);
	const rungs = pushesResources
		? DEPLOYMENT_PROGRESS_STATES
		: DEPLOYMENT_PROGRESS_STATES.filter((state) => state !== "resources");
	const sessionApi = useBuilderSessionApi();
	const [pending, startTransition] = useTransition();
	const [refreshError, setRefreshError] = useState<string | null>(null);
	/* Refresh from CommCare HQ: its in-flight state and its sentence, held
	 * here beside Check status's own rather than in the kept block, which a
	 * superseded answer can take away with a record that holds no list. */
	const [keptPending, startKeptTransition] = useTransition();
	const [keptNotice, setKeptNotice] = useState<KeptRefreshNotice | null>(null);
	/* Whether the notice is Refresh's sentence that found the app changed in
	 * CommCare HQ (`keptChangedInHqLine`), which offers See what changed
	 * beside it. */
	const [keptOffersReview, setKeptOffersReview] = useState(false);
	const [changesOpen, setChangesOpen] = useState(false);
	/* The check when the builder opened found this project space changed:
	 * the card says so and offers See what changed without a Refresh, so
	 * the header's See what changed in CommCare HQ lands on a card that
	 * answers it. */
	const hqChangedTargets = useHqChangedTargets();
	const headingId = useId();
	const stopHelperId = useId();

	const handleRefresh = useCallback(() => {
		/* Checking WRITES what it saw, so it is a Project write and re-reads
		 * live capability rather than trusting the prop this rendered with.
		 * A role can change under an open dialog. */
		if (!sessionApi.getState().canEdit) return;
		setRefreshError(null);
		startTransition(async () => {
			/* A rejected async transition is re-thrown during render, which
			 * would take the whole builder page down over one failed check.
			 * The failure belongs in this component's own error slot. */
			try {
				const result = await refreshDeploymentAction({
					appId,
					server: record.server,
					domain: record.domain,
				});
				if (result.success) {
					/* A kept list or a first-publish list Check status could
					 * not read after its write landed keeps the one the card
					 * shows. */
					onUpdated(
						refreshedViewToShow(result.data, {
							kept: view.kept,
							firstPublish: view.firstPublish,
						}),
					);
					return;
				}
				setRefreshError(result.message);
			} catch {
				setRefreshError(
					"Nova couldn't reach the server to check on this deployment. Try again in a moment.",
				);
			}
		});
	}, [
		appId,
		record.server,
		record.domain,
		view.kept,
		view.firstPublish,
		onUpdated,
		sessionApi,
	]);

	const shownKept = view.kept;
	const handleKeptRefresh = useCallback(() => {
		/* Refreshing writes the baseline, so it re-reads live capability
		 * rather than trusting the prop this rendered with. */
		if (!sessionApi.getState().canEdit || shownKept === null) return;
		setKeptNotice(null);
		setKeptOffersReview(false);
		startKeptTransition(async () => {
			/* A rejected async transition is re-thrown during render, which
			 * would take the whole builder page down over one failed read. */
			try {
				const result = await refreshKeptValuesAction({
					appId,
					server: record.server,
					domain: record.domain,
				});
				const next = keptRefreshNotice(result, shownKept, {
					now: new Date(),
					space: record.domain,
					firstPublish: view.firstPublish,
				});
				if (next.view !== null) onUpdated(next.view);
				setKeptNotice(next);
				setKeptOffersReview(keptRefreshOffersReview(result));
			} catch {
				setKeptNotice(keptRefreshNotReached(shownKept));
			}
		});
	}, [
		appId,
		record.server,
		record.domain,
		shownKept,
		view.firstPublish,
		onUpdated,
		sessionApi,
	]);
	/* A sentence speaks of the list it was given for, and leaves once a
	 * publish or a reload moves the list. */
	const shownKeptNotice =
		keptNotice !== null && keptNoticeApplies(keptNotice, view.kept)
			? keptNotice
			: null;

	const endedCard = endedCardOf(view);
	const ended = endedCard?.ending ?? null;
	const broughtIn = broughtInOf(view);
	const readNotPublished = readNotPublishedSince(view);
	const [stopOpen, setStopOpen] = useState(false);
	const noteDeploymentRecordsChanged = useNoteDeploymentRecordsChanged();
	const clearHqChangedTarget = useClearHqChangedTarget();
	const applyPreviewAnswer = useApplyPreviewDeploymentAnswer();
	/* The stop answers with the ended record and what Preview names and plays
	 * now, both read on the server after the ending landed, so whichever of
	 * this answer and the stream's frames arrives last, Preview ends on the
	 * same values. The record goes to the surface as a Check status's does;
	 * one Nova could not read back is read again with the rest. A project
	 * space Nova no longer publishes to has nothing changed in CommCare HQ to
	 * offer, so the header's offer for it goes. */
	const handleStopped = useCallback(
		(next: StoppedPublishingView) => {
			if (next.view !== null) onUpdated({ ...next.view, preview: null });
			applyPreviewAnswer(next.preview);
			noteDeploymentRecordsChanged();
			clearHqChangedTarget({ server: record.server, domain: record.domain });
		},
		[
			onUpdated,
			applyPreviewAnswer,
			noteDeploymentRecordsChanged,
			clearHqChangedTarget,
			record.server,
			record.domain,
		],
	);

	const refused = record.state === "incomplete";
	/* The record carries a failure exactly when the deployment is refused:
	 * the phase a retry resumes at holds it. A refused ATTEMPT against a
	 * live deployment deliberately writes nothing durable here, and its
	 * failure reaches the screen through the publish response instead, so
	 * there is no stale failure to scan for. */
	const failure =
		refused &&
		record.resumePhase !== null &&
		record.phases[record.resumePhase]?.status === "failed"
			? record.phases[record.resumePhase]
			: null;
	/* Check status only where checking can answer (`checkStatusOffered`):
	 * offering the one button whose every press errors is worse than not
	 * offering it. An ended deployment has no live mapping, so it is never
	 * offered there. */
	const observable = checkStatusOffered(view);

	return (
		<section aria-labelledby={headingId} className="mt-5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					id={headingId}
					className="font-display text-[15px] font-semibold text-nova-text"
				>
					{record.domain}
				</h3>
				{canRefresh && observable ? (
					<Button
						variant="ghost"
						onClick={handleRefresh}
						disabled={pending}
						aria-describedby={headingId}
					>
						<Icon
							icon={pending ? tablerLoader2 : tablerRefresh}
							width="16"
							height="16"
							className={pending ? "animate-spin" : undefined}
							aria-hidden="true"
						/>
						{pending ? "Checking" : "Check status"}
					</Button>
				) : null}
			</div>

			{broughtIn !== null ? (
				<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-secondary">
					{broughtInFromLine(
						record.domain,
						cardDate(broughtIn.at),
						broughtIn.byName,
					)}
				</p>
			) : null}

			{ended !== null ? (
				<div className="mt-3 text-[13px] leading-relaxed" data-deployment-ended>
					<p className="text-nova-text">
						{endedLine(ended, cardDate(ended.at))}
					</p>
					{endedCard?.linksToHqApp === true ? (
						<EndedHqAppLink
							url={hqPlaceUrl(
								{
									server: record.server,
									domain: record.domain,
									remoteAppId: ended.hqAppId,
								},
								{ kind: "app" },
							)}
						/>
					) : null}
				</div>
			) : (
				<Ladder rungs={rungs} view={view} readNotPublished={readNotPublished} />
			)}

			{ended === null && view.kept !== null ? (
				<KeptValues
					kept={view.kept}
					canRefresh={canRefresh}
					pending={keptPending}
					onRefresh={handleKeptRefresh}
					notice={shownKeptNotice}
					onSeeWhatChanged={
						canRefresh && keptOffersReview
							? () => setChangesOpen(true)
							: undefined
					}
				/>
			) : ended === null && shownKeptNotice !== null ? (
				/* A refresh whose answer left a record with no list, such as
				 * a publish that landed during the read and could not read the
				 * app back, still says what happened. */
				<div className="mt-4 text-[13px] leading-relaxed">
					<KeptNotice notice={shownKeptNotice} />
				</div>
			) : null}

			{ended === null &&
			canRefresh &&
			!keptOffersReview &&
			hqChangedTargets.some((target) =>
				sameHqChangedTarget(target, {
					server: record.server,
					domain: record.domain,
				}),
			) ? (
				<div className="mt-4 flex flex-col items-start gap-1 text-[13px] leading-relaxed">
					<p className="text-nova-text">
						{hqChangedFoundLine(
							sincePhrase(
								cardDriftReference(view),
								record.domain,
								viewerDriftDate(),
							),
						)}
					</p>
					<Button variant="ghost" onClick={() => setChangesOpen(true)}>
						{SEE_WHAT_CHANGED_ACTION}
					</Button>
				</div>
			) : null}

			{failure?.status === "failed" ? (
				/* Amber, the same tone the refusal hero above it uses. A phase
				   that stopped is recoverable and says how; rose is reserved on
				   this screen for a request that failed outright. */
				<div
					role="alert"
					className="mt-3 rounded-lg border border-nova-amber/40 bg-nova-amber/10 p-3 text-[13px] leading-relaxed"
				>
					<p className="flex items-start gap-2 text-nova-text">
						<Icon
							icon={tablerAlertTriangle}
							width="16"
							height="16"
							className="mt-0.5 shrink-0 text-nova-amber"
							aria-hidden="true"
						/>
						<span>{failure.failure.message}</span>
					</p>
					{canRefresh && failure.failure.code === "hq_place_ids_need_setup" && (
						<PlaceWorkbookButton
							appId={appId}
							server={record.server}
							domain={record.domain}
						/>
					)}
					{failure.failure.details.length > 0 ? (
						<ul className="mt-2 flex list-disc flex-col gap-1 pl-9 text-nova-text-secondary">
							{failure.failure.details.map((detail) => (
								<li key={detail}>{detail}</li>
							))}
						</ul>
					) : null}
					{record.resumePhase !== null ? (
						<p className="mt-2 pl-9 text-nova-text-secondary">
							{remoteAppReportedGone(view.deployment)
								? GONE_APP_NEXT_PUBLISH
								: RESUME_SENTENCE[record.resumePhase]}
						</p>
					) : null}
				</div>
			) : null}

			{refreshError !== null ? (
				<p
					role="alert"
					className="mt-3 text-[13px] leading-relaxed text-nova-rose"
				>
					{refreshError}
				</p>
			) : null}

			<LeftBehindNotice resources={view.leftBehind} />

			<ConfirmationsOnRecord
				appId={appId}
				view={view}
				onWithdrawn={canRefresh ? onWithdrawn : undefined}
			/>

			{/* Drawn on an ended card too: there the panel makes no workers and
			    shows only the passwords this page still holds for the project
			    space, which the person was told stay until they leave it. */}
			{workers}

			<SetupNotes sections={view.artifact.sections} />

			{/* Mounted only while open: it reads the records the Publishing
			 *  section holds and asks CommCare HQ afresh each time. */}
			{changesOpen ? (
				<HqChangesDialog
					open
					onOpenChange={setChangesOpen}
					target={{ server: record.server, domain: record.domain }}
				/>
			) : null}

			{stopPublishingOffered(view, canStop) ? (
				<div className="mt-4 border-t border-nova-border pt-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => setStopOpen(true)}
						aria-describedby={stopHelperId}
					>
						{STOP_PUBLISHING_ACTION}
					</Button>
					<p
						id={stopHelperId}
						className="mt-0.5 text-[13px] leading-relaxed text-nova-text-secondary"
					>
						{STOP_PUBLISHING_HELPER}
					</p>
					{stopHqAppId !== null ? (
						<StopPublishingDialog
							open={stopOpen}
							onOpenChange={setStopOpen}
							target={{
								appId,
								server: record.server,
								domain: record.domain,
								hqAppId: stopHqAppId,
							}}
							onStopped={handleStopped}
							onRecordsStale={noteDeploymentRecordsChanged}
						/>
					) : null}
				</div>
			) : null}
		</section>
	);
}

/** The ended card's link to the HQ app the deployment stopped at. */
function EndedHqAppLink({ url }: { url: string | null }) {
	if (url === null) return null;
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="nova-focusable mt-1 inline-flex min-h-11 items-center gap-1.5 font-medium text-nova-violet-bright hover:underline"
		>
			{ENDED_HQ_APP_LINK}
			<Icon
				icon={tablerExternalLink}
				width="14"
				height="14"
				aria-hidden="true"
			/>
			<span className="sr-only">, opens in a new tab</span>
		</a>
	);
}

/**
 * The ladder. Each rung states its own condition, so nothing is conveyed by
 * fill alone. The "On CommCare HQ" rung of an app brought in and not yet
 * published to says so, with the day Nova read it (`readNotPublished`).
 */
function Ladder({
	rungs,
	view,
	readNotPublished,
}: {
	rungs: readonly DeploymentProgressState[];
	view: DeploymentView;
	readNotPublished: string | null;
}) {
	const record = view.deployment.deployment;
	return (
		<ol className="mt-3 flex flex-col gap-1.5">
			{rungs.map((state) => {
				const reached = deploymentDisplaysAsReached(record, state);
				const outcome = record.phases[DEPLOYMENT_STATE_PRODUCING_PHASE[state]];
				const note = outcome?.status === "pending" ? outcome.reason : null;
				return (
					<li
						key={state}
						className="flex items-start gap-2.5 text-[13px] leading-relaxed"
					>
						<span
							aria-hidden="true"
							className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border ${
								reached
									? "border-transparent bg-nova-emerald/20 text-nova-emerald"
									: "border-nova-border text-nova-text-muted"
							}`}
						>
							{reached ? (
								<Icon icon={tablerCheck} width="12" height="12" />
							) : null}
						</span>
						<span className="min-w-0">
							<span
								className={reached ? "text-nova-text" : "text-nova-text-muted"}
							>
								{DEPLOYMENT_STATE_LABELS[state]}
							</span>
							<span className="sr-only">
								{reached ? ", done" : ", not yet"}
							</span>
							{note !== null && !reached ? (
								<span className="mt-0.5 block text-nova-text-secondary">
									{note}
								</span>
							) : null}
							{state === "uploaded" && readNotPublished !== null ? (
								<span className="mt-0.5 block text-nova-text-secondary">
									{notPublishedYetLine(cardDate(readNotPublished))}
								</span>
							) : null}
						</span>
					</li>
				);
			})}
		</ol>
	);
}

/**
 * The settings this project space keeps in CommCare HQ at another value
 * than a new app's, with the date Nova read them, and a way to read them
 * again.
 *
 * Drawn with an empty list too: that is where a person asks Nova to look
 * again after changing a setting in CommCare HQ, and a project space that
 * held every default at the last publish would otherwise have no way to tell
 * Preview that fuzzy search is now on. The refresh's in-flight state and its
 * sentence belong to `DeploymentStatus`, as Check status's do.
 */
function KeptValues({
	kept,
	canRefresh,
	pending,
	onRefresh,
	notice,
	onSeeWhatChanged,
}: {
	kept: DeploymentKept;
	canRefresh: boolean;
	pending: boolean;
	onRefresh: () => void;
	notice: KeptRefreshNotice | null;
	/** See what changed beside the notice, where Refresh found the app changed in CommCare HQ. */
	onSeeWhatChanged?: () => void;
}) {
	const leadId = useId();
	const date = keptDateText(kept.observedAt, new Date());
	const hasLabels = kept.labels.length > 0;

	return (
		<div className="mt-4 text-[13px] leading-relaxed" data-kept-values>
			<p id={leadId} className="text-nova-text">
				{keptLead(date, hasLabels)}
			</p>
			{hasLabels ? (
				<ul
					aria-labelledby={leadId}
					className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-nova-text-secondary"
				>
					{kept.labels.map((label) => (
						<li key={label}>{KEPT_LABELS[label]}</li>
					))}
				</ul>
			) : null}
			<p className="mt-1.5 text-nova-text-secondary">{KEPT_FOLLOWS_LINE}</p>
			{canRefresh ? (
				<Button
					variant="ghost"
					className="mt-1"
					onClick={onRefresh}
					disabled={pending}
				>
					<Icon
						icon={pending ? tablerLoader2 : tablerRefresh}
						width="16"
						height="16"
						className={pending ? "animate-spin" : undefined}
						aria-hidden="true"
					/>
					{pending ? KEPT_REFRESH_BUTTON_PENDING : KEPT_REFRESH_BUTTON}
				</Button>
			) : null}
			{notice !== null ? <KeptNotice notice={notice} /> : null}
			{notice !== null && onSeeWhatChanged !== undefined ? (
				<Button variant="ghost" className="mt-1" onClick={onSeeWhatChanged}>
					{SEE_WHAT_CHANGED_ACTION}
				</Button>
			) : null}
		</div>
	);
}

/** What one press of Refresh from CommCare HQ amounted to. */
function KeptNotice({ notice }: { notice: KeptRefreshNotice }) {
	return (
		<p
			role={notice.failed ? "alert" : "status"}
			className={`mt-1 ${notice.failed ? "text-nova-rose" : "text-nova-text-secondary"}`}
		>
			{notice.sentence}
		</p>
	);
}

/**
 * What somebody still has to set up on the project space.
 *
 * Collapsed by default because it is reference material rather than
 * something to read every time, and each section states its own scope so
 * a closed one is still self-describing.
 */
/**
 * What an earlier publish left on the project space.
 *
 * Two things this deliberately does NOT do. It does not read
 * `deployment.superseded`, because a table deleted on CommCare HQ and
 * recreated by the next push supersedes its mapping while leaving nothing
 * there, and sending somebody to tidy up a table that does not exist costs
 * them a trip for nothing. And it does not call everything an app: a
 * renamed lookup table and an archived place are the common cases now, so
 * each resource says what it is and is named by the thing a person will
 * actually recognize on CommCare HQ, which for a table is its tag and for
 * a place its site code rather than either one's id.
 */
function LeftBehindNotice({
	resources,
}: {
	resources: readonly DeploymentResource[];
}) {
	if (resources.length === 0) return null;
	const named = resources.map((resource) => {
		switch (resource.kind) {
			case "lookup-table":
				return `the lookup table ${resource.pushedIdentity ?? resource.remoteId}`;
			case "location":
				return `the place ${resource.pushedIdentity ?? resource.remoteId}`;
			default:
				return `the app ${resource.remoteId}`;
		}
	});
	const one = resources.length === 1;
	return (
		<p className="mt-3 text-[13px] leading-relaxed text-nova-text-secondary">
			{one
				? "An earlier publish left something behind"
				: `Earlier publishes left ${resources.length} things behind`}{" "}
			on this project space: {formatList(named)}. Nova does not delete anything
			on CommCare HQ, so {one ? "it is" : "they are"} still there until you
			remove {one ? "it" : "them"} yourself.
		</p>
	);
}

/**
 * What a person confirmed when publishing or making workers in this project space,
 * with who and when, and a Withdraw for each where this viewer may edit.
 *
 * No API key reads a project space's plan or these settings, so a publish
 * goes by what someone said here, and Nova cannot see the plan change
 * later. Withdrawing is how somebody takes an answer back: the row is kept
 * with who withdrew it, and the next operation that needs it asks again.
 */
function ConfirmationsOnRecord({
	appId,
	view,
	onWithdrawn,
}: {
	appId: string;
	view: DeploymentView;
	/** Absent for a viewer, who sees the rows and no control. */
	onWithdrawn?: (next: DeploymentView) => void;
}) {
	const record = view.deployment.deployment;
	/* A worker-level confirmation stores CommCare HQ's code for the level; the
	 * app's levels give the name the Workers panel asked by. */
	const levels = useOrganizationLevels();
	const rows = liveConfirmationRows(view.deployment.confirmations, levels);
	const sessionApi = useBuilderSessionApi();
	const [pending, startTransition] = useTransition();
	const [withdrawError, setWithdrawError] = useState<string | null>(null);
	const headingId = useId();

	const handleWithdraw = useCallback(
		(key: DeploymentConfirmationKey) => {
			/* A withdrawal is a Project write, so it re-reads live capability
			 * rather than trusting the prop this rendered with. */
			if (onWithdrawn === undefined || !sessionApi.getState().canEdit) return;
			setWithdrawError(null);
			startTransition(async () => {
				try {
					const result = await withdrawDeploymentConfirmationAction({
						appId,
						server: record.server,
						domain: record.domain,
						confirmation: key,
					});
					if (result.success) {
						onWithdrawn(result.data);
						return;
					}
					setWithdrawError(result.message);
				} catch {
					setWithdrawError(
						"Nova couldn't reach the server to withdraw that. Try again in a moment.",
					);
				}
			});
		},
		[appId, record.server, record.domain, onWithdrawn, sessionApi],
	);

	if (rows.length === 0) return null;
	return (
		<div className="mt-4">
			<h4 id={headingId} className="text-[13px] font-medium text-nova-text">
				What this project space has, as confirmed here
			</h4>
			<p className="mt-1 text-[13px] leading-relaxed text-nova-text-secondary">
				Nova can’t read these settings from CommCare HQ. If one changes, you can
				withdraw its confirmation here. Nova asks about a worker level again
				when you make workers there, and about other settings when you publish
				an app that needs them.
			</p>
			<ul aria-labelledby={headingId} className="mt-2 flex flex-col gap-1.5">
				{rows.map((row) => (
					<li
						key={
							row.key.kind === "plan-feature" || row.key.kind === "worker-level"
								? `${row.key.kind}:${row.key.subject}`
								: row.key.kind
						}
						className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-lg border border-nova-border bg-nova-well px-3 py-1.5 text-[13px] leading-relaxed"
					>
						<span className="min-w-0">
							<span className="block text-nova-text">{row.label}</span>
							<span className="block text-[12px] text-nova-text-muted">
								Confirmed by {row.confirmedBy} on {cardDate(row.confirmedAt)}
							</span>
						</span>
						{onWithdrawn !== undefined ? (
							<Button
								type="button"
								variant="ghost"
								onClick={() => handleWithdraw(row.key)}
								disabled={pending}
							>
								Withdraw
								<span className="sr-only"> {row.label}</span>
							</Button>
						) : null}
					</li>
				))}
			</ul>
			{withdrawError !== null ? (
				<p
					role="alert"
					className="mt-2 text-[13px] leading-relaxed text-nova-rose"
				>
					{withdrawError}
				</p>
			) : null}
		</div>
	);
}

/** "a", "a and b", "a, b, and c". */
function formatList(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function SetupNotes({
	sections,
}: {
	sections: readonly SetupArtifactSection[];
}) {
	if (sections.length === 0) return null;
	return (
		<div className="mt-4">
			<h4 className="text-[13px] font-medium text-nova-text">
				Set up by hand on CommCare HQ
			</h4>
			<p className="mt-1 text-[13px] leading-relaxed text-nova-text-secondary">
				CommCare HQ has no way for Nova to do these for you, so they are yours
				to do there.
			</p>
			<div className="mt-2 flex flex-col gap-1.5">
				{sections.map((section) => (
					<SetupNote key={section.id} section={section} />
				))}
			</div>
		</div>
	);
}

function SetupNote({ section }: { section: SetupArtifactSection }) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	return (
		<div className="rounded-lg border border-nova-border bg-nova-well">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				aria-expanded={open}
				aria-controls={panelId}
				className="nova-focusable-inset flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-[13px] text-nova-text hover:bg-white/[0.03]"
			>
				<span>{section.title}</span>
				<Icon
					icon={tablerChevronDown}
					width="16"
					height="16"
					className={`shrink-0 text-nova-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
					aria-hidden="true"
				/>
			</button>
			{open ? (
				<div
					id={panelId}
					className="border-nova-border border-t px-3 py-3 text-[13px] leading-relaxed"
				>
					<p className="text-nova-text-secondary">{section.summary}</p>
					{section.url !== null ? (
						<a
							href={section.url}
							target="_blank"
							rel="noopener noreferrer"
							className="nova-focusable mt-2 inline-flex min-h-[44px] items-center gap-1.5 text-nova-violet-bright hover:underline"
						>
							Open on CommCare HQ
							<Icon
								icon={tablerExternalLink}
								width="14"
								height="14"
								aria-hidden="true"
							/>
						</a>
					) : null}
					{section.steps.length > 0 ? (
						/* Sub-steps belong to the step above them, so they are a
						   nested list rather than numbered siblings: two levels
						   sharing a setting would otherwise read as two more
						   instructions. */
						<ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-nova-text">
							{section.steps.map((entry) => (
								<li key={entry.id}>
									{entry.text}
									{entry.detail.length > 0 ? (
										<ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-nova-text-secondary">
											{entry.detail.map((line) => (
												<li key={`${entry.id}:${line}`}>{line}</li>
											))}
										</ul>
									) : null}
								</li>
							))}
						</ol>
					) : null}
					{section.caveats.length > 0 ? (
						<>
							<p className="mt-3 font-medium text-nova-text">Before you save</p>
							<ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-nova-text-secondary">
								{section.caveats.map((caveat) => (
									<li key={caveat}>{caveat}</li>
								))}
							</ul>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}
