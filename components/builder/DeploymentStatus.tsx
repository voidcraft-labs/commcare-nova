/**
 * Where an app stands on one CommCare HQ project space, and what is left
 * to do there.
 *
 * The whole component exists to keep one promise: never imply the app is
 * further along than it is. The five progress states are drawn as a
 * ladder, the reached ones filled and the rest plainly not, and a state
 * Nova has not observed says what is missing rather than showing a
 * hopeful blank. `incomplete` is drawn as a refusal, not as a rung.
 *
 * Nova can put the app on a project space but cannot make a version or
 * release one, because CommCare HQ allows both only from a signed-in
 * browser session. So the last three rungs are things this screen WATCHES,
 * and the setup notes are how somebody makes them happen.
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
	type DeploymentPhase,
	type DeploymentProgressState,
	deploymentDisplaysAsReached,
	deploymentResumeState,
} from "@/lib/deployment";
import {
	type DeploymentView,
	refreshDeploymentAction,
} from "@/lib/deployment/actions";

/** What each rung means, in the author's words. */
const STATE_LABELS: Readonly<Record<DeploymentProgressState, string>> = {
	preflight: "Checked",
	uploaded: "On CommCare HQ",
	built: "Version made",
	released: "Released",
	runnable: "Ready for workers",
};

/** Which phase's report explains a rung that has not been reached. */
const PHASE_FOR_STATE: Readonly<
	Record<DeploymentProgressState, DeploymentPhase>
> = {
	preflight: "preflight",
	uploaded: "upload",
	built: "build",
	released: "release",
	runnable: "probe",
};

export function DeploymentStatus({
	appId,
	view,
	onUpdated,
}: {
	appId: string;
	view: DeploymentView;
	/** Lets the surrounding dialog keep the record it is holding current. */
	onUpdated: (next: DeploymentView) => void;
}) {
	const record = view.deployment.deployment;
	const [pending, startTransition] = useTransition();
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const headingId = useId();

	const handleRefresh = useCallback(() => {
		setRefreshError(null);
		startTransition(async () => {
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
		});
	}, [appId, record.server, record.domain, onUpdated]);

	const refused = record.state === "incomplete";
	const resumeState = deploymentResumeState(record);
	const failure =
		record.resumePhase === null
			? null
			: record.phases[record.resumePhase]?.status === "failed"
				? record.phases[record.resumePhase]
				: null;

	return (
		<section aria-labelledby={headingId} className="mt-5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					id={headingId}
					className="font-display text-[15px] font-semibold text-nova-text"
				>
					{record.domain}
				</h3>
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
			</div>

			{/* The ladder. Each rung states its own condition, so nothing is
			    conveyed by fill alone. */}
			<ol className="mt-3 flex flex-col gap-1.5">
				{DEPLOYMENT_PROGRESS_STATES.map((state) => {
					const reached = deploymentDisplaysAsReached(record, state);
					const outcome = record.phases[PHASE_FOR_STATE[state]];
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
									{reached ? " — done" : " — not yet"}
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

			{refused && failure?.status === "failed" ? (
				<div
					role="alert"
					className="mt-3 rounded-lg border border-nova-rose/40 bg-nova-rose/10 p-3 text-[13px] leading-relaxed"
				>
					<p className="flex items-start gap-2 text-nova-text">
						<Icon
							icon={tablerAlertTriangle}
							width="16"
							height="16"
							className="mt-0.5 shrink-0 text-nova-rose"
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
					{resumeState !== null ? (
						<p className="mt-2 pl-9 text-nova-text-secondary">
							Nothing before this needs doing again. Fix the above, then carry
							on from {STATE_LABELS[resumeState].toLowerCase()}.
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

			{view.deployment.superseded.length > 0 ? (
				<p className="mt-3 text-[13px] leading-relaxed text-nova-text-secondary">
					Publishing again created a new app rather than replacing the old one,
					because CommCare HQ has no way to update an app in place.{" "}
					{view.deployment.superseded.length === 1
						? "One earlier app is"
						: `${view.deployment.superseded.length} earlier apps are`}{" "}
					still on this project space:{" "}
					{view.deployment.superseded
						.map((resource) => resource.remoteId)
						.join(", ")}
					. You can delete{" "}
					{view.deployment.superseded.length === 1 ? "it" : "them"} on CommCare
					HQ when you no longer need{" "}
					{view.deployment.superseded.length === 1 ? "it" : "them"}.
				</p>
			) : null}

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
						<ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-nova-text">
							{section.steps.map((step) => (
								<li key={step} className="whitespace-pre-wrap">
									{step}
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
