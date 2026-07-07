/**
 * CommCare HQ integration settings — client component.
 *
 * Card-based UI for managing CommCare HQ API credentials. Verify, refresh,
 * and disconnect use Server Actions (`actions.ts`), each returning the fresh
 * `CommCareSettingsPublic` so the client swaps its state wholesale.
 *
 * Multi-space keys: an HQ API key can reach several project spaces. This card
 * is display-only about that — a single-space key shows a "Connected to X"
 * badge; a multi-space key shows how many spaces it reaches, with a popover
 * listing them. Choosing WHICH space an upload targets happens in the upload
 * dialog (per-upload), not here.
 *
 * API key field behavior:
 *   - Idle / error: plaintext text input, editable
 *   - Verifying / configured / deleting: masked, disabled
 *   - On success: stays masked (credentials saved server-side)
 *   - On error: reverts to plaintext with the original value intact
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerShieldLock from "@iconify-icons/tabler/shield-lock";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { CommCareDomain } from "@/lib/commcare/client";
import {
	COMMCARE_SERVER_IDS,
	COMMCARE_SERVERS,
	type CommCareServer,
} from "@/lib/commcare/servers";
import type { CommCareSettingsPublic } from "@/lib/db/settings";
import {
	deleteCredentials,
	refreshDomainsAction,
	verifyAndSaveCredentials,
} from "./actions";

// ── Types ──────────────────────────────────────────────────────────

interface CommCareSettingsProps {
	initial: CommCareSettingsPublic;
	/** Pre-fill the username field with the user's Google email when unconfigured. */
	userEmail: string;
}

/** State machine for the connect/disconnect lifecycle of the card. */
type FormStatus =
	| { type: "idle" }
	| { type: "verifying" }
	| { type: "configured" }
	| { type: "error"; message: string }
	| { type: "deleting" };

// ── Constants ──────────────────────────────────────────────────────

/** Placeholder shown in the masked API key field. The actual key never leaves the server. */
const API_KEY_MASK = "•".repeat(32);

/**
 * Server picker items — one per HQ deployment, labeled with the hostname the
 * user recognizes from their browser's address bar. The value is HQ's
 * environment name (what the connection stores).
 */
const SERVER_ITEMS = COMMCARE_SERVER_IDS.map((id) => ({
	label: `${COMMCARE_SERVERS[id].label} — ${COMMCARE_SERVERS[id].host}`,
	value: id,
}));

// ── Animation presets ──────────────────────────────────────────────

const STATUS_ENTER = { opacity: 0, y: -6 } as const;
const STATUS_VISIBLE = { opacity: 1, y: 0 } as const;
const STATUS_EXIT = { opacity: 0, y: 4 } as const;
const STATUS_TRANSITION = { duration: 0.2 } as const;

// ── Component ──────────────────────────────────────────────────────

export function CommCareSettings({
	initial,
	userEmail,
}: CommCareSettingsProps) {
	/* ── Form values ─────────────────────────────────────────────── */
	/* `initial` is a discriminated union — narrow on `configured` before
	 * reading the saved username/domains, falling back to email/empty when
	 * unconfigured. */
	const [username, setUsername] = useState(
		initial.configured ? initial.username : userEmail,
	);
	const [apiKey, setApiKey] = useState("");
	/* Which HQ deployment the credentials live on. US/India/EU are separate
	 * deployments with separate accounts, so the key is only meaningful
	 * together with this choice. */
	const [server, setServer] = useState<CommCareServer>(
		initial.configured ? initial.server : "production",
	);

	/* ── Domains + status ────────────────────────────────────────── */
	/* The full set of project spaces the key can reach. Display-only here;
	 * the upload dialog is where a target is chosen. */
	const [availableDomains, setAvailableDomains] = useState<CommCareDomain[]>(
		initial.configured ? initial.availableDomains : [],
	);
	const [status, setStatus] = useState<FormStatus>(
		initial.configured ? { type: "configured" } : { type: "idle" },
	);
	/* Refresh runs independently of the connect lifecycle, so it gets its own
	 * busy + error state rather than crowding `status`. */
	const [domainBusy, setDomainBusy] = useState(false);
	const [domainError, setDomainError] = useState<string | null>(null);

	/* ── Derived states ──────────────────────────────────────────── */
	const isConfigured = status.type === "configured";
	const isVerifying = status.type === "verifying";
	const fieldsLocked =
		isVerifying || isConfigured || status.type === "deleting";
	const canSave =
		username.trim().length > 0 && apiKey.trim().length > 0 && !fieldsLocked;

	/* Show save button in idle/error/verifying, disconnect in configured/deleting. */
	const showSaveArea = !isConfigured && status.type !== "deleting";
	const showDisconnectArea = isConfigured || status.type === "deleting";

	/* ── Apply a settings snapshot from any action's result ───────── */
	const applySettings = useCallback((settings: CommCareSettingsPublic) => {
		if (settings.configured) {
			setUsername(settings.username);
			setServer(settings.server);
			setAvailableDomains(settings.availableDomains);
			setStatus({ type: "configured" });
		} else {
			setAvailableDomains([]);
			setStatus({ type: "idle" });
		}
	}, []);

	/* ── Save handler ────────────────────────────────────────────── */
	const handleSave = useCallback(async () => {
		if (!username.trim() || !apiKey.trim()) return;
		setStatus({ type: "verifying" });
		setDomainError(null);

		const result = await verifyAndSaveCredentials(
			username.trim(),
			apiKey.trim(),
			server,
		);

		if (result.success) {
			applySettings(result.settings);
		} else {
			setStatus({ type: "error", message: result.error });
		}
	}, [username, apiKey, server, applySettings]);

	/* ── Refresh the reachable set ────────────────────────────────── */
	/* Re-reads which spaces the key can reach — picks up project memberships
	 * added since the key was first saved. */
	const handleRefresh = useCallback(async () => {
		setDomainBusy(true);
		setDomainError(null);

		const result = await refreshDomainsAction();
		setDomainBusy(false);
		if (result.success) applySettings(result.settings);
		else setDomainError(result.error);
	}, [applySettings]);

	/* ── Disconnect handler ──────────────────────────────────────── */
	const handleDisconnect = useCallback(async () => {
		setStatus({ type: "deleting" });
		setDomainError(null);

		const result = await deleteCredentials();

		if (result.success) {
			setAvailableDomains([]);
			setUsername(userEmail);
			setApiKey("");
			setStatus({ type: "idle" });
		} else {
			setStatus({ type: "error", message: result.error });
		}
	}, [userEmail]);

	/* ── Render ──────────────────────────────────────────────────── */
	return (
		<section className="rounded-xl border border-nova-border bg-nova-surface overflow-hidden">
			{/* ── Card header ───────────────────────────────────────── */}
			<div className="flex items-center gap-3 px-6 py-4 border-b border-nova-border/50">
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nova-violet/10">
					<Icon
						icon={tablerCloudUpload}
						width="18"
						height="18"
						className="text-nova-violet-bright"
					/>
				</div>
				<div className="min-w-0">
					<h2 className="text-base font-display font-semibold text-nova-text">
						CommCare HQ
					</h2>
					<p className="text-xs text-nova-text-muted">
						Upload apps directly from Nova
					</p>
				</div>

				{/* Connected pill — appears in the header corner once configured. */}
				<AnimatePresence>
					{isConfigured && (
						<motion.div
							initial={{ opacity: 0, scale: 0.9 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.9 }}
							transition={{ duration: 0.2 }}
							className="ml-auto flex items-center gap-1.5 rounded-full border border-nova-emerald/20 bg-nova-emerald/10 px-2.5 py-1"
						>
							<div className="h-1.5 w-1.5 rounded-full bg-nova-emerald" />
							<span className="text-xs font-medium text-nova-emerald">
								Connected
							</span>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* ── Card body ─────────────────────────────────────────── */}
			<div className="p-6">
				{/* Project-space area — badge (single) or count + popover (multi) */}
				<AnimatePresence>
					{isConfigured && (
						<motion.div
							initial={{ opacity: 0, height: 0, marginBottom: 0 }}
							animate={{ opacity: 1, height: "auto", marginBottom: 20 }}
							exit={{ opacity: 0, height: 0, marginBottom: 0 }}
							transition={{ duration: 0.25 }}
						>
							<DomainSection
								availableDomains={availableDomains}
								busy={domainBusy}
								error={domainError}
								onRefresh={handleRefresh}
							/>
						</motion.div>
					)}
				</AnimatePresence>

				{/* ── Form fields ────────────────────────────────────── */}
				<div className="space-y-4">
					{/* Server — US/India/EU are separate deployments with separate
					 * accounts, so this choice decides which one the key is
					 * verified against (and later uploaded to). */}
					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium text-nova-text-secondary">
							Server
						</span>
						<Select
							items={SERVER_ITEMS}
							value={server}
							onValueChange={(next) => {
								if (next) setServer(next);
							}}
							disabled={fieldsLocked}
						>
							<SelectTrigger className="w-full" aria-label="CommCare HQ server">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{SERVER_ITEMS.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{!fieldsLocked && (
							<span className="text-xs text-nova-text-muted">
								Pick where your CommCare account lives — an API key only works
								on the server that issued it.
							</span>
						)}
					</div>

					{/* Username */}
					<label htmlFor="commcare-username" className="flex flex-col gap-1.5">
						<span className="text-sm font-medium text-nova-text-secondary">
							Username
						</span>
						<Input
							id="commcare-username"
							type="email"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							placeholder="you@example.com"
							disabled={fieldsLocked}
							autoComplete="off"
							data-1p-ignore
						/>
					</label>

					{/* API Key — masked when locked, plaintext when editable */}
					<label htmlFor="commcare-api-key" className="flex flex-col gap-1.5">
						<span className="text-sm font-medium text-nova-text-secondary">
							API Key
						</span>
						{fieldsLocked ? (
							<Input
								id="commcare-api-key"
								type="text"
								value={API_KEY_MASK}
								disabled
								tabIndex={-1}
								autoComplete="off"
								data-1p-ignore
								className="tracking-wider"
							/>
						) : (
							<Input
								id="commcare-api-key"
								type="text"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder="Paste your API key"
								autoComplete="off"
								data-1p-ignore
							/>
						)}

						{/* Help link — only when the input is editable; follows the
						 * selected server so the user lands on the deployment that
						 * can actually issue a working key. */}
						{!fieldsLocked && (
							<span className="text-xs text-nova-text-muted">
								Generate one at{" "}
								<a
									href={`https://${COMMCARE_SERVERS[server].host}/account/api_keys/`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-0.5 text-nova-violet-bright hover:underline"
								>
									{COMMCARE_SERVERS[server].host}/account/api_keys
									<Icon icon={tablerExternalLink} width="12" height="12" />
								</a>
							</span>
						)}
					</label>
				</div>

				{/* ── Status feedback area ───────────────────────────── */}
				<div aria-live="polite">
					<AnimatePresence mode="wait">
						{status.type === "error" && (
							<motion.div
								key="error"
								initial={STATUS_ENTER}
								animate={STATUS_VISIBLE}
								exit={STATUS_EXIT}
								transition={STATUS_TRANSITION}
								className="mt-5 text-sm leading-relaxed text-nova-rose"
							>
								{status.message}
							</motion.div>
						)}
					</AnimatePresence>
				</div>

				{/* ── Actions ────────────────────────────────────────── */}
				<div className="mt-5 flex items-center gap-3">
					{showSaveArea && (
						<Button
							type="button"
							onClick={handleSave}
							disabled={!canSave || isVerifying}
						>
							{isVerifying ? (
								<>
									<Icon icon={tablerLoader2} className="animate-spin" />
									Verifying...
								</>
							) : (
								"Test & Save"
							)}
						</Button>
					)}

					{showDisconnectArea && (
						<Button
							type="button"
							variant="destructive"
							onClick={handleDisconnect}
							disabled={status.type === "deleting"}
						>
							{status.type === "deleting" ? (
								<>
									<Icon icon={tablerLoader2} className="animate-spin" />
									Removing...
								</>
							) : (
								<>
									<Icon icon={tablerTrash} />
									Disconnect
								</>
							)}
						</Button>
					)}
				</div>
			</div>

			{/* ── Encryption assurance footer ────────────────────── */}
			<div className="flex items-center gap-2 border-t border-nova-border/30 px-6 py-3">
				<Icon
					icon={tablerShieldLock}
					width="14"
					height="14"
					className="shrink-0 text-nova-violet-bright"
				/>
				<p className="text-xs text-nova-text-muted">
					Your credentials are encrypted in transit and at rest, stored
					server-side.
				</p>
			</div>
		</section>
	);
}

// ── Project-space sub-view ─────────────────────────────────────────

interface DomainSectionProps {
	availableDomains: CommCareDomain[];
	busy: boolean;
	error: string | null;
	onRefresh: () => void;
}

/**
 * The connected-state project-space surface — display-only.
 *
 * A single-space key shows a verified "Connected to X" badge. A multi-space
 * key shows the count with a popover listing every reachable space (the user
 * picks the actual upload target in the upload dialog, not here). Both carry a
 * "Refresh" affordance because a key's reachable set grows when its owner
 * joins a new project.
 */
function DomainSection({
	availableDomains,
	busy,
	error,
	onRefresh,
}: DomainSectionProps) {
	const isMultiSpace = availableDomains.length > 1;

	return (
		<div className="flex flex-col gap-2.5">
			{/* Status badge + Refresh form one left-aligned cluster. `justify-between`
			 * here pinned Refresh to the far edge of the card, leaving a wide dead
			 * gap; the connection state and its refresh action read as one unit. */}
			<div className="flex flex-wrap items-center gap-2">
				{isMultiSpace ? (
					<Popover>
						<PopoverTrigger className="inline-flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-nova-emerald/10 bg-nova-emerald/[0.04] px-3.5 py-2.5 text-sm text-nova-text transition-colors hover:border-nova-emerald/25">
							<Icon
								icon={tablerCheck}
								width="15"
								height="15"
								className="shrink-0 text-nova-emerald"
							/>
							<span className="truncate">
								Connected to{" "}
								<span className="font-semibold text-nova-emerald">
									{availableDomains.length} project spaces
								</span>
							</span>
							<Icon
								icon={tablerChevronDown}
								width="14"
								height="14"
								className="shrink-0 text-nova-text-muted"
							/>
						</PopoverTrigger>
						<PopoverContent
							align="start"
							className="max-h-72 w-80 overflow-y-auto"
						>
							<p className="px-1 pb-1 text-xs text-nova-text-muted">
								This API key can upload to:
							</p>
							<ul className="flex flex-col gap-0.5">
								{availableDomains.map((d) => (
									<li key={d.name} className="flex flex-col px-1 py-1.5">
										<span className="text-sm text-nova-text">
											{d.displayName}
										</span>
										<span className="text-xs text-nova-text-muted">
											{d.name}
										</span>
									</li>
								))}
							</ul>
						</PopoverContent>
					</Popover>
				) : (
					<div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-nova-emerald/10 bg-nova-emerald/[0.04] px-3.5 py-2.5">
						<Icon
							icon={tablerCheck}
							width="15"
							height="15"
							className="shrink-0 text-nova-emerald"
						/>
						<span className="truncate text-sm text-nova-text">
							Connected to{" "}
							<span className="font-semibold text-nova-emerald">
								{availableDomains[0]?.displayName}
							</span>
						</span>
					</div>
				)}
				<RefreshButton busy={busy} onRefresh={onRefresh} />
			</div>

			{error && <p className="text-sm text-nova-rose">{error}</p>}
		</div>
	);
}

/** Compact "re-read the reachable spaces" control with a spinner. */
function RefreshButton({
	busy,
	onRefresh,
}: {
	busy: boolean;
	onRefresh: () => void;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="xs"
			onClick={onRefresh}
			disabled={busy}
		>
			<Icon
				icon={busy ? tablerLoader2 : tablerRefresh}
				className={busy ? "animate-spin" : undefined}
			/>
			Refresh
		</Button>
	);
}
