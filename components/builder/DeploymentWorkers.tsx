/**
 * Making CommCare mobile-worker accounts for this app's personas, on one
 * project space.
 *
 * It sits inside the deployment's own card rather than beside the publish
 * button, because an account belongs to a project space: the same persona
 * can hold a different username on each, and the ownership ledger keys it
 * that way. This screen is the only place that shows a password, and it
 * shows each one exactly once — Nova stores none of them, so what is on
 * screen is the only copy until somebody copies it.
 *
 * The panel is deliberately quiet until the app is actually there. A
 * worker account exists to run an app, and the places a persona stands in
 * only exist on the project space once a publish has put them there, so
 * before that the honest thing to show is the sentence saying so.
 *
 * (The App setup workspace will one day hold the Deployment section this
 * lives under. When it does it INHERITS this panel and relocates it; it
 * does not build a second one.)
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCopy from "@iconify-icons/tabler/copy";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerUserPlus from "@iconify-icons/tabler/user-plus";
import { useCallback, useId, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { Input } from "@/components/shadcn/input";
import type {
	DeploymentView,
	ProvisionWorkersView,
} from "@/lib/deployment/actions";
import { provisionWorkersAction } from "@/lib/deployment/actions";
import { activeRemoteApp } from "@/lib/deployment/resources";
import type { DeploymentWithResources } from "@/lib/deployment/types";
import { defaultWorkerUsername } from "@/lib/deployment/workerProvisionPlan";
import { usePersonas } from "@/lib/doc/hooks/useUserCollections";
import { useBuilderSessionApi } from "@/lib/session/provider";

/** One row: a persona, the name it will sign in with, and where it stands. */
interface WorkerRow {
	readonly personaUuid: string;
	readonly personaName: string;
	/** The complete username the ledger holds, when there is an account. */
	readonly provisionedAs: string | null;
	readonly adopted: boolean;
}

export function DeploymentWorkers({
	appId,
	deployment,
	canProvision,
	onUpdated,
}: {
	appId: string;
	deployment: DeploymentWithResources;
	/**
	 * Whether this viewer may make accounts. It writes to CommCare HQ and
	 * to Nova's ledger, so a viewer cannot; offering a button whose every
	 * press is refused is worse than not offering it.
	 */
	canProvision: boolean;
	/** Keeps the record the surrounding dialog holds current. */
	onUpdated: (next: DeploymentView) => void;
}) {
	const personas = usePersonas();
	const record = deployment.deployment;
	const headingId = useId();
	const sessionApi = useBuilderSessionApi();

	const rows: readonly WorkerRow[] = useMemo(
		() =>
			personas.map((persona) => {
				const mapping = deployment.active.find(
					(resource) =>
						resource.kind === "worker" &&
						resource.novaResourceId === persona.uuid,
				);
				return {
					personaUuid: persona.uuid,
					personaName: persona.name,
					provisionedAs: mapping?.pushedIdentity ?? null,
					adopted: mapping?.ownership === "adopted",
				};
			}),
		[personas, deployment.active],
	);

	/* Nova's suggestion per persona, which a person may edit before the
	 * call. Seeded lazily so a persona renamed while this is open does not
	 * quietly rewrite a name somebody has already typed. */
	const [names, setNames] = useState<Readonly<Record<string, string>>>({});
	const [chosen, setChosen] = useState<readonly string[]>([]);
	const [adopting, setAdopting] = useState<readonly string[]>([]);
	const [result, setResult] = useState<ProvisionWorkersView | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const usernameFor = useCallback(
		(row: WorkerRow): string =>
			names[row.personaUuid] ??
			bareUsername(row.provisionedAs) ??
			defaultWorkerUsername(row.personaName),
		[names],
	);

	const provision = useCallback(() => {
		/* Re-read live capability rather than trusting the prop this
		 * rendered with: a role can change under an open dialog. */
		if (!sessionApi.getState().canEdit) return;
		const asked = rows.filter((row) => chosen.includes(row.personaUuid));
		if (asked.length === 0) return;
		setRequestError(null);
		startTransition(async () => {
			try {
				const response = await provisionWorkersAction({
					appId,
					server: record.server,
					domain: record.domain,
					workers: asked.map((row) => ({
						personaUuid: row.personaUuid,
						username: usernameFor(row),
					})),
					...(adopting.length > 0 && { adoptPersonaUuids: adopting }),
				});
				if (!response.success) {
					setRequestError(response.message);
					return;
				}
				setResult(response.data);
				/* Only the personas that still need a decision stay ticked, so
				 * pressing the button again does the remaining work rather
				 * than repeating what already landed. */
				const done = new Set(
					response.data.workers.map((worker) => worker.personaUuid),
				);
				setChosen((current) => current.filter((uuid) => !done.has(uuid)));
				/* An adoption is recorded in the ledger from here on, so the
				 * ticks that answered THIS refusal must not ride along into
				 * the next call and take over an account nobody asked about. */
				setAdopting((current) => current.filter((uuid) => !done.has(uuid)));
				if (response.data.view !== null) onUpdated(response.data.view);
			} catch {
				setRequestError(
					"Nova couldn't reach the server to make these workers. Try again in a moment.",
				);
			}
		});
	}, [
		appId,
		record.server,
		record.domain,
		rows,
		chosen,
		adopting,
		usernameFor,
		onUpdated,
		sessionApi,
	]);

	if (personas.length === 0) return null;

	/* The app has to be on the project space first. Its places are what a
	 * persona's assignment points at, and an account that can sign in to an
	 * app that is not there has nothing to do. The predicate is the mapping
	 * rather than the state — exactly what the server refuses on — because
	 * `incomplete` covers both a deployment that never got there and one
	 * that got there and then stumbled. */
	const published = activeRemoteApp(deployment) !== null;

	return (
		<section aria-labelledby={headingId} className="mt-4">
			<h4 id={headingId} className="text-[13px] font-medium text-nova-text">
				Workers
			</h4>
			{!published ? (
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-secondary">
					Publish this app to {record.domain} first, and then Nova can make a
					CommCare account for each persona here.
				</p>
			) : (
				<>
					<p className="mt-1 text-[13px] leading-relaxed text-nova-text-secondary">
						Nova can make a CommCare mobile worker for each persona, carrying
						the worker information and places that persona holds. A new account
						comes with a password shown once, here.
					</p>

					<ul className="mt-2.5 flex flex-col gap-1">
						{rows.map((row) => (
							<WorkerChoice
								key={row.personaUuid}
								row={row}
								username={usernameFor(row)}
								chosen={chosen.includes(row.personaUuid)}
								disabled={!canProvision || pending}
								onChosenChange={(next) =>
									setChosen((current) =>
										next
											? [...current, row.personaUuid]
											: current.filter((uuid) => uuid !== row.personaUuid),
									)
								}
								onUsernameChange={(next) =>
									setNames((current) => ({
										...current,
										[row.personaUuid]: next,
									}))
								}
							/>
						))}
					</ul>

					{result?.refusal?.conflicts !== undefined &&
					result.refusal.conflicts.length > 0 ? (
						<WorkerAdoptionChoice
							conflicts={result.refusal.conflicts}
							domain={record.domain}
							adopting={adopting}
							onAdoptChange={(personaUuid, adopt) =>
								setAdopting((current) =>
									adopt
										? [...current, personaUuid]
										: current.filter((uuid) => uuid !== personaUuid),
								)
							}
						/>
					) : null}

					{canProvision ? (
						<Button
							variant="secondary"
							className="mt-3"
							onClick={provision}
							disabled={pending || chosen.length === 0}
						>
							<Icon
								icon={pending ? tablerLoader2 : tablerUserPlus}
								width="16"
								height="16"
								className={pending ? "animate-spin" : undefined}
								aria-hidden="true"
							/>
							{pending ? "Working" : buttonLabel(rows, chosen)}
						</Button>
					) : null}

					{/* The passwords come FIRST, above any refusal. A call that
					    stopped halfway still made real accounts, and this screen
					    holds the only copy of their passwords. */}
					{result !== null && result.workers.length > 0 ? (
						<ProvisionedWorkers workers={result.workers} />
					) : null}

					{result?.refusal != null ? (
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
								<span>{result.refusal.message}</span>
							</p>
							{result.refusal.details.length > 0 ? (
								<ul className="mt-2 flex list-disc flex-col gap-1 pl-9 text-nova-text-secondary">
									{result.refusal.details.map((detail) => (
										<li key={detail}>{detail}</li>
									))}
								</ul>
							) : null}
						</div>
					) : null}

					{requestError !== null ? (
						<p
							role="alert"
							className="mt-3 text-[13px] leading-relaxed text-nova-rose"
						>
							{requestError}
						</p>
					) : null}
				</>
			)}
		</section>
	);
}

function WorkerChoice({
	row,
	username,
	chosen,
	disabled,
	onChosenChange,
	onUsernameChange,
}: {
	row: WorkerRow;
	username: string;
	chosen: boolean;
	disabled: boolean;
	onChosenChange: (next: boolean) => void;
	onUsernameChange: (next: string) => void;
}) {
	const checkboxId = useId();
	const inputId = useId();
	return (
		<li className="flex flex-wrap items-center gap-2.5">
			<label
				htmlFor={checkboxId}
				className="flex min-h-11 flex-1 cursor-pointer items-center gap-2.5 text-[13px] text-nova-text"
			>
				<Checkbox
					id={checkboxId}
					checked={chosen}
					disabled={disabled}
					onCheckedChange={(next) => onChosenChange(next === true)}
				/>
				<span className="min-w-0">
					{row.personaName}
					{row.provisionedAs !== null ? (
						<span className="block text-[12px] text-nova-text-secondary">
							{row.adopted ? "Taken over: " : "Has an account: "}
							{row.provisionedAs}
						</span>
					) : null}
				</span>
			</label>
			<span className="flex items-center gap-1.5">
				<label htmlFor={inputId} className="sr-only">
					Username for {row.personaName}
				</label>
				<Input
					id={inputId}
					value={username}
					disabled={disabled || row.provisionedAs !== null}
					onChange={(event) => onUsernameChange(event.target.value)}
					className="w-40"
				/>
			</span>
		</li>
	);
}

/**
 * The accounts this call made or brought into step, with the passwords.
 *
 * The copy button copies every new one at once, because the person doing
 * this is about to hand them out and copying six passwords one at a time
 * is how one gets missed.
 */
function ProvisionedWorkers({
	workers,
}: {
	workers: ProvisionWorkersView["workers"];
}) {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const withPasswords = workers.filter((worker) => worker.password !== null);
	const text = withPasswords
		.map((worker) => `${worker.username}\t${worker.password}`)
		.join("\n");
	return (
		<div className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<p className="text-[13px] leading-relaxed text-nova-text">
					{withPasswords.length > 0
						? "Copy these now. Nova doesn't keep passwords, so this is the only time it can show them."
						: "These accounts are now in step with the app. Their passwords are unchanged."}
				</p>
				{withPasswords.length > 0 ? (
					<Button
						variant="ghost-action"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(text);
								setCopied(true);
								setCopyError(false);
							} catch {
								setCopyError(true);
							}
						}}
					>
						<Icon icon={tablerCopy} aria-hidden="true" />
						{copied ? "Copied" : "Copy all"}
					</Button>
				) : null}
			</div>
			{copyError ? (
				<p role="alert" className="mt-2 text-[12px] text-nova-rose">
					Couldn't copy them. Select the lines below instead.
				</p>
			) : null}
			<ul className="mt-2.5 flex flex-col gap-1.5 text-[13px]">
				{workers.map((worker) => (
					<li key={worker.personaUuid} className="break-words">
						<span className="text-nova-text">{worker.personaName}</span>
						<span className="block font-mono text-[12px] text-nova-text-secondary">
							{worker.username}
							{worker.password !== null ? `  ${worker.password}` : ""}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * A username that already belongs to somebody.
 *
 * The same shape the publish dialog uses for a table or a place, and for
 * the same reason: a shared name is never evidence of ownership, so
 * taking one over is a decision a person makes about that exact account.
 */
function WorkerAdoptionChoice({
	conflicts,
	domain,
	adopting,
	onAdoptChange,
}: {
	conflicts: NonNullable<ProvisionWorkersView["refusal"]>["conflicts"];
	domain: string;
	adopting: readonly string[];
	onAdoptChange: (personaUuid: string, adopt: boolean) => void;
}) {
	return (
		<div className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-3">
			<p className="text-[13px] leading-relaxed text-nova-text">
				Pick any of these accounts that already belong to this app. Nova will
				keep them in step with their persona and leave the rest alone.
			</p>
			<ul className="mt-2.5 flex flex-col gap-1">
				{conflicts.map((conflict) => (
					<li key={conflict.personaUuid}>
						<label
							htmlFor={`adopt-worker-${conflict.personaUuid}`}
							className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-nova-text"
						>
							<Checkbox
								id={`adopt-worker-${conflict.personaUuid}`}
								checked={adopting.includes(conflict.personaUuid)}
								onCheckedChange={(next) =>
									onAdoptChange(conflict.personaUuid, next === true)
								}
							/>
							<span>
								{conflict.personaName}
								<span className="text-nova-text-secondary">
									{" "}
									({conflict.username})
								</span>
							</span>
						</label>
					</li>
				))}
			</ul>
			<p className="mt-1 text-[12px] leading-relaxed text-nova-text-secondary">
				Leave one unticked and that account stays untouched on{" "}
				{domain || "the project space"}. Give the persona a username nobody has
				yet to make one of your own instead.
			</p>
		</div>
	);
}

/**
 * What the button will actually do, said plainly.
 *
 * A persona with no account gets one made; a persona with one gets it
 * brought into step with what the app says now. Both are worth doing and
 * they are not the same act, so a batch of both says so rather than
 * calling an update a creation.
 */
function buttonLabel(
	rows: readonly WorkerRow[],
	chosen: readonly string[],
): string {
	const asked = rows.filter((row) => chosen.includes(row.personaUuid));
	if (asked.length === 0) return "Make workers";
	const making = asked.filter((row) => row.provisionedAs === null).length;
	const updating = asked.length - making;
	const counted = (count: number) =>
		count === 1 ? "1 worker" : `${count} workers`;
	if (updating === 0) return `Make ${counted(making)}`;
	if (making === 0) return `Update ${counted(updating)}`;
	return `Make and update ${counted(asked.length)}`;
}

/**
 * The bare name out of a complete one, so a provisioned worker's box shows
 * what somebody typed rather than the whole address.
 */
function bareUsername(complete: string | null): string | null {
	if (complete === null) return null;
	const at = complete.indexOf("@");
	return at === -1 ? complete : complete.slice(0, at);
}
