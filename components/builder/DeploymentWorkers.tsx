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
 * The App setup Publishing section is this panel's one mount: it fills
 * DeploymentStatus's `workers` slot there, and no other surface does.
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
import type { UnconfirmedWorker } from "@/lib/deployment/workerProvisionPlan";
import {
	defaultWorkerUsername,
	unconfirmedWorkerKey,
} from "@/lib/deployment/workerProvisionPlan";
import { usePersonas } from "@/lib/doc/hooks/useUserCollections";
import {
	useDismissUnconfirmedWorker,
	useRecordProvisioningOutcome,
	useUnconfirmedWorkers,
} from "@/lib/session/hooks";
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
	/* Held in the builder session, not here. The refusal that produces one
	 * asks the person to go and look at their project space, and doing that
	 * closes this dialog — which would unmount dialog-local state and take
	 * the only copy of a live account's password with it. */
	const heldUnconfirmed = useUnconfirmedWorkers();
	const recordOutcome = useRecordProvisioningOutcome();
	const dismissUnconfirmed = useDismissUnconfirmedWorker();
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
				recordOutcome(response.data);
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
		recordOutcome,
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
					{(result !== null && result.workers.length > 0) ||
					heldUnconfirmed.length > 0 ? (
						<WorkerCredentials
							workers={result?.workers ?? []}
							unconfirmed={heldUnconfirmed}
							onDismiss={dismissUnconfirmed}
						/>
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
 * Every password this call produced, whether or not its account is
 * certain.
 *
 * One block and ONE copy button for both kinds, deliberately. The person
 * doing this is about to hand these out, and copying six passwords one at
 * a time is how one gets missed; splitting the unconfirmed ones into a
 * second block with a second button would make missing them the default.
 * They are marked in place instead, so what is uncertain is the account
 * rather than whether the credential is worth keeping.
 */
function WorkerCredentials({
	workers,
	unconfirmed,
	onDismiss,
}: {
	workers: ProvisionWorkersView["workers"];
	unconfirmed: readonly (readonly [string, UnconfirmedWorker])[];
	onDismiss: (key: string) => void;
}) {
	/* What was copied, not whether something was. The block now stays
	 * mounted across calls, so a latched boolean would still read "Copied"
	 * after a later answer added a password the clipboard has never held —
	 * telling somebody they have a credential they do not. */
	const [copiedText, setCopiedText] = useState<string | null>(null);
	const [copyError, setCopyError] = useState(false);
	/* One row per ACCOUNT, addressed by persona AND username, because a
	 * persona can hold a doubtful account under one name and a real one
	 * under another. Merging on the persona alone would collide those
	 * under one React key and badge a confirmed account as doubtful. */
	const held = new Map(unconfirmed);
	const rows = [
		...workers.map((worker) => {
			const key = unconfirmedWorkerKey(worker.personaUuid, worker.username);
			return {
				key,
				personaName: worker.personaName,
				username: worker.username,
				/* An adopted account has no password of Nova's — CommCare HQ
				 * never told it one — but if this IS the account that was in
				 * doubt, the generated password held in the session is the one
				 * it was made with, and the only copy anywhere. */
				password: worker.password ?? held.get(key)?.password ?? null,
				certain: true,
			};
		}),
		...unconfirmed
			.filter(([key]) => !workers.some((worker) => sameAccount(worker, key)))
			.map(([key, worker]) => ({
				key,
				personaName: worker.personaName,
				username: worker.username,
				password: worker.password as string | null,
				certain: false,
			})),
	];
	const withPasswords = rows.filter((row) => row.password !== null);
	const text = withPasswords
		.map((row) => `${row.username}\t${row.password}`)
		.join("\n");
	const doubtful = rows.filter((row) => !row.certain);
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
								setCopiedText(text);
								setCopyError(false);
							} catch {
								setCopyError(true);
							}
						}}
					>
						<Icon icon={tablerCopy} aria-hidden="true" />
						{copiedText === text ? "Copied" : "Copy all"}
					</Button>
				) : null}
			</div>
			{copyError ? (
				<p role="alert" className="mt-2 text-[12px] text-nova-rose">
					Couldn't copy them. Select the lines below instead.
				</p>
			) : null}
			{doubtful.length > 0 ? (
				<p className="mt-2 text-[12px] leading-relaxed text-nova-text-secondary">
					{doubtful.length === 1
						? "The one marked below may not be an account at all. Nova keeps it here until you say you have it, because if it is there this is the only copy."
						: "The ones marked below may not be accounts at all. Nova keeps them here until you say you have them, because if they are there these are the only copies."}
				</p>
			) : null}
			<ul className="mt-2.5 flex flex-col gap-1.5 text-[13px]">
				{rows.map((row) => (
					<li key={row.key} className="break-words">
						<span className="text-nova-text">{row.personaName}</span>
						{row.certain ? null : (
							<>
								<span className="ml-1.5 rounded border border-nova-amber/40 bg-nova-amber/10 px-1.5 py-0.5 text-[11px] text-nova-text-secondary">
									May not exist
								</span>
								<Button
									variant="ghost-action"
									className="ml-1.5 h-auto px-1.5 py-0.5 text-[11px]"
									onClick={() => onDismiss(row.key)}
								>
									I have this
								</Button>
							</>
						)}
						<span className="block font-mono text-[12px] text-nova-text-secondary">
							{row.username}
							{row.password !== null ? `  ${row.password}` : ""}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Whether a landed account is the one a held credential belongs to. */
function sameAccount(
	worker: ProvisionWorkersView["workers"][number],
	key: string,
): boolean {
	return unconfirmedWorkerKey(worker.personaUuid, worker.username) === key;
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
