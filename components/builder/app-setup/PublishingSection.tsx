/**
 * Publishing — where this app stands on every CommCare HQ project space it
 * has reached, and the durable home of everything a publish starts.
 *
 * The Publish dialog PUBLISHES; this section MANAGES. Each target the app
 * has reached gets its full record here: the progress ladder, a refusal
 * and the phase a retry resumes at, what an earlier publish left behind,
 * the Workers panel, and the set-up-by-hand notes. "Publish again" opens
 * the one Publish dialog preseeded to that target (through the session
 * store's one-shot request), so there is exactly one publish flow.
 *
 * The Workers panel lives HERE and nowhere else: it is the only place a
 * worker's password is ever shown, and a second panel would be a second
 * place a credential can be shown.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCommCareConnection } from "@/components/builder/CommCareConnectionContext";
import { DeploymentStatus } from "@/components/builder/DeploymentStatus";
import { useSetDeploymentProjectSpace } from "@/components/builder/DeploymentTargetProvider";
import { DeploymentWorkers } from "@/components/builder/DeploymentWorkers";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import {
	type DeploymentView,
	type RefreshedDeploymentView,
	readDeploymentsAction,
} from "@/lib/deployment/actions";
import {
	useAppId,
	useCanEdit,
	useDeploymentRecordsRevision,
	useRequestPublishDialog,
} from "@/lib/session/hooks";
import { DeploymentEntryPointLinks } from "./DeploymentEntryPointLinks";
import {
	applyRecordUpsert,
	beginRecordsLoad,
	deploymentViewKey,
	INITIAL_PUBLISHING_RECORDS,
	publishAgainDomain,
	resolveRecordsLoad,
} from "./publishingSectionModel";

const LOAD_FAILED_MESSAGE =
	"Nova couldn't load where this app has been published. Try again in a moment.";

export function PublishingSection() {
	// Absent only on a brand-new build before its app row exists, where
	// nothing has been published and there is no record to read.
	const appId = useAppId();
	const connection = useCommCareConnection();
	const canEdit = useCanEdit();
	const requestPublishDialog = useRequestPublishDialog();
	const setProjectSpace = useSetDeploymentProjectSpace();
	/* The dialog bumps this on every record it writes (a publish landing,
	 * a Check status made from its landed hero), so a publish made while
	 * this section is mounted reaches its held records. */
	const recordsRevision = useDeploymentRecordsRevision();

	const [records, setRecords] = useState(INITIAL_PUBLISHING_RECORDS);
	/* The stale-response guard's counter. A ref rather than state because it
	 * is bookkeeping for the async race, not something a render shows. */
	const generationRef = useRef(0);

	const load = useCallback(() => {
		if (appId === undefined) return;
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		setRecords((current) => beginRecordsLoad(current, generation));
		/* A rejected Server Action must land in this section's own error
		 * slot. Without the catch it is an unhandled rejection and the
		 * section sits on "loading" forever, which reads as "you have
		 * published nowhere". */
		void readDeploymentsAction(appId)
			.then((result) => {
				setRecords((current) =>
					resolveRecordsLoad(
						current,
						generation,
						result.success
							? { ok: true, views: result.data }
							: { ok: false, message: result.message },
					),
				);
			})
			.catch(() => {
				setRecords((current) =>
					resolveRecordsLoad(current, generation, {
						ok: false,
						message: LOAD_FAILED_MESSAGE,
					}),
				);
			});
	}, [appId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: recordsRevision is the reload trigger on PURPOSE — the dialog bumps it on every record write, and this effect is how those writes reach the section's held records.
	useEffect(() => {
		load();
	}, [load, recordsRevision]);

	/* Upserts supersede any load in flight (the answer they carry is newer
	 * than what it will return), so each takes a fresh generation of its
	 * own — the superseded load's resolve then mismatches and is ignored. */
	const upsert = useCallback((next: DeploymentView) => {
		generationRef.current += 1;
		const generation = generationRef.current;
		setRecords((current) => applyRecordUpsert(current, next, generation));
	}, []);
	/* Every refresh answers with the record AND what Preview may now name,
	 * because an observation can change both. */
	const handleRefreshed = useCallback(
		(next: RefreshedDeploymentView) => {
			upsert(next);
			setProjectSpace(next.previewProjectSpace);
		},
		[upsert, setProjectSpace],
	);
	/* Provisioning answers with the record alone: making accounts cannot
	 * change which project space Preview names. */
	const handleProvisioned = useCallback(
		(next: DeploymentView) => {
			upsert(next);
		},
		[upsert],
	);

	const views = records.views;
	const status =
		views === null && records.pending ? (
			<p className="flex items-center gap-2 rounded-lg border border-nova-border px-3 py-4 text-[13px] text-nova-text-muted">
				<Spinner className="size-4" />
				Loading where this app is published
			</p>
		) : views === null && records.failure !== null ? (
			<p
				role="alert"
				className="rounded-lg border border-nova-red/40 bg-nova-red/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text"
			>
				{records.failure}{" "}
				<Button type="button" variant="ghost-action" onClick={load}>
					Try again
				</Button>
			</p>
		) : undefined;

	return (
		<section aria-labelledby="app-setup-publishing-heading" className="pb-10">
			<h2 id="app-setup-publishing-heading" className="sr-only">
				Publishing
			</h2>
			<p className="mt-2 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
				Where this app is published on CommCare HQ: each project space it has
				reached, the mobile workers Nova can make there, and what you set up by
				hand. Publish from the Publish button in the header.
			</p>
			{!connection.configured ? (
				<aside
					aria-label="CommCare HQ connection"
					className="mt-4 max-w-prose rounded-lg border border-nova-violet/30 bg-nova-violet/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text-secondary"
				>
					Connect CommCare HQ to publish directly and check on a published app
					from here. You can add your API key in Settings.{" "}
					<Link
						href="/settings"
						target="_blank"
						rel="noopener noreferrer"
						className="nova-focusable inline-flex items-center gap-1 font-medium text-nova-violet-bright hover:underline"
					>
						Open Settings
						<Icon
							icon={tablerExternalLink}
							width="14"
							height="14"
							aria-hidden="true"
						/>
					</Link>
				</aside>
			) : null}
			<div className="mt-8 flex flex-col gap-6">
				{status ?? (
					<>
						{records.pending && views !== null ? (
							<p
								role="status"
								className="flex items-center gap-2 text-[13px] text-nova-text-muted"
							>
								<Spinner className="size-4" />
								Checking these records again
							</p>
						) : null}
						{records.failure !== null && views !== null ? (
							<p
								role="status"
								className="rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text"
							>
								The saved records could not be refreshed, so these may be out of
								date. {records.failure}{" "}
								<Button type="button" variant="ghost-action" onClick={load}>
									Try again
								</Button>
							</p>
						) : null}
						{views !== null && views.length === 0 ? (
							<p className="max-w-prose text-[13px] leading-relaxed text-nova-text-muted">
								{canEdit
									? "This app hasn't been published yet. Choose Publish in the header to put it on a CommCare HQ project space or download it as a file."
									: "This app hasn't been published yet. A Project editor can publish it from the header."}
							</p>
						) : null}
						{views?.map((view) => {
							const retryDomain = canEdit
								? publishAgainDomain(view, connection)
								: null;
							return (
								<article
									key={deploymentViewKey(view)}
									className="rounded-xl border border-nova-border bg-nova-well px-4 pb-4"
								>
									<DeploymentStatus
										appId={appId ?? ""}
										view={view}
										canRefresh={canEdit}
										onUpdated={handleRefreshed}
										workers={
											<DeploymentWorkers
												appId={appId ?? ""}
												deployment={view.deployment}
												canProvision={canEdit}
												onUpdated={handleProvisioned}
											/>
										}
									/>
									<DeploymentEntryPointLinks appId={appId ?? ""} view={view} />
									{retryDomain !== null ? (
										<div className="mt-3 border-t border-nova-border pt-2">
											<Button
												type="button"
												variant="ghost-action"
												onClick={() =>
													requestPublishDialog({ domain: retryDomain })
												}
											>
												<Icon
													icon={tablerCloudUpload}
													width="16"
													height="16"
													aria-hidden="true"
												/>
												Publish again
											</Button>
										</div>
									) : null}
								</article>
							);
						})}
					</>
				)}
			</div>
		</section>
	);
}
