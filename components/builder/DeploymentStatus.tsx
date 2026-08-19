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
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useCallback, useId, useState, useTransition } from "react";
import { Button } from "@/components/shadcn/button";
import type { SetupArtifactSection } from "@/lib/deployment";
import {
	DEPLOYMENT_PROGRESS_STATES,
	DEPLOYMENT_STATE_PRODUCING_PHASE,
	type DeploymentPhase,
	type DeploymentProgressState,
	type DeploymentResource,
	deploymentDisplaysAsReached,
	deploymentIsObservable,
} from "@/lib/deployment";
import {
	type DeploymentView,
	type RefreshedDeploymentView,
	refreshDeploymentAction,
} from "@/lib/deployment/actions";
import { activeRemoteApp } from "@/lib/deployment/resources";
import { useBuilderSessionApi } from "@/lib/session/provider";

/** What each rung means, in the author's words. */
const STATE_LABELS: Readonly<Record<DeploymentProgressState, string>> = {
	preflight: "Checked",
	resources: "Tables in place",
	uploaded: "On CommCare HQ",
	built: "Version made",
	released: "Released",
	runnable: "Ready for workers",
};

/**
 * How each resume point reads in a sentence.
 *
 * Separate from `STATE_LABELS` because those are column headings and these
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

export function DeploymentStatus({
	appId,
	view,
	canRefresh = true,
	onUpdated,
}: {
	appId: string;
	view: DeploymentView;
	/**
	 * Whether this viewer may ask CommCare HQ again. Checking WRITES what
	 * it observes, so a viewer cannot. Offering them a button that
	 * would be refused is worse than not offering it.
	 */
	canRefresh?: boolean;
	/** Lets the surrounding dialog keep the record it is holding current. */
	onUpdated: (next: RefreshedDeploymentView) => void;
}) {
	const record = view.deployment.deployment;
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
	const headingId = useId();

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
					onUpdated(result.data);
					return;
				}
				setRefreshError(result.message);
			} catch {
				setRefreshError(
					"Nova couldn't reach the server to check on this deployment. Try again in a moment.",
				);
			}
		});
	}, [appId, record.server, record.domain, onUpdated, sessionApi]);

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
	/* Check status only where checking can answer. A record refused before
	 * its app reached CommCare HQ has nothing there to ask about, and a
	 * record with no active mapping has nothing to name: offering the one
	 * button whose every press errors is worse than not offering it. */
	const observable =
		deploymentIsObservable(record) && activeRemoteApp(view.deployment) !== null;

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

			{/* The ladder. Each rung states its own condition, so nothing is
			    conveyed by fill alone. */}
			<ol className="mt-3 flex flex-col gap-1.5">
				{rungs.map((state) => {
					const reached = deploymentDisplaysAsReached(record, state);
					const outcome =
						record.phases[DEPLOYMENT_STATE_PRODUCING_PHASE[state]];
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
									className={
										reached ? "text-nova-text" : "text-nova-text-muted"
									}
								>
									{STATE_LABELS[state]}
								</span>
								<span className="sr-only">
									{reached ? ", done" : ", not yet"}
								</span>
								{note !== null && !reached ? (
									<span className="mt-0.5 block text-nova-text-secondary">
										{note}
									</span>
								) : null}
							</span>
						</li>
					);
				})}
			</ol>

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
					{failure.failure.details.length > 0 ? (
						<ul className="mt-2 flex list-disc flex-col gap-1 pl-9 text-nova-text-secondary">
							{failure.failure.details.map((detail) => (
								<li key={detail}>{detail}</li>
							))}
						</ul>
					) : null}
					{record.resumePhase !== null ? (
						<p className="mt-2 pl-9 text-nova-text-secondary">
							{failure.failure.code === "remote_app_missing"
								? "Publishing again creates a new app on CommCare HQ, because the one Nova made is gone."
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

			<SetupNotes sections={view.artifact.sections} />
		</section>
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
