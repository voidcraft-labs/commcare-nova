/**
 * Connected applications settings card. Lists every OAuth client the
 * user has authorized via Nova's AS and lets them revoke any one.
 *
 * Per-row state machine: `idle` → `confirming` (Cancel / Confirm) →
 * `revoking` (spinner) → row exits via AnimatePresence; `error`
 * reverts to idle with an inline message. On success, optimistic
 * removal drives the UX while the Server Action's `revalidatePath`
 * keeps a hard refresh in sync.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPlugConnected from "@iconify-icons/tabler/plug-connected";
import tablerShieldLock from "@iconify-icons/tabler/shield-lock";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { AuthorizedClient } from "@/lib/db/oauth-consents";
import { docsLink } from "@/lib/hostnames";
import { revokeClientAccess } from "./oauth-actions";
import { ScopesPopover } from "./scopes-popover";

// ── Types ──────────────────────────────────────────────────────────

interface ConnectedAppsProps {
	initial: AuthorizedClient[];
}

/** Per-row UI status. Each row owns its own copy. */
type RowStatus =
	| { type: "idle" }
	| { type: "confirming" }
	| { type: "revoking" }
	| { type: "error"; message: string };

/** Row data joined with its UI status — single source of truth in state. */
interface RowData extends AuthorizedClient {
	status: RowStatus;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Renders "12 Apr 2026". Locale pinned to `en-GB` for the day-first
 * order (en-US would emit "Apr 12, 2026") and so output is stable
 * across machines.
 */
const DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	year: "numeric",
});

function formatAuthorizedAt(iso: string): string {
	return DATE_FORMATTER.format(new Date(iso));
}

// ── Animation presets (match commcare-settings.tsx where possible) ──

const ROW_EXIT = { opacity: 0, height: 0, marginTop: 0 } as const;
const ROW_TRANSITION = { duration: 0.25 } as const;

// ── Component ──────────────────────────────────────────────────────

export function ConnectedApps({ initial }: ConnectedAppsProps) {
	const [rows, setRows] = useState<RowData[]>(() =>
		initial.map((r) => ({ ...r, status: { type: "idle" } as RowStatus })),
	);

	/**
	 * Imperative status updater. State setter form so concurrent revokes
	 * on different rows don't clobber each other (each call sees the
	 * latest snapshot of `rows`).
	 */
	const setRowStatus = useCallback((consentId: string, status: RowStatus) => {
		setRows((prev) =>
			prev.map((r) => (r.consentId === consentId ? { ...r, status } : r)),
		);
	}, []);

	const handleRequestConfirm = useCallback(
		(consentId: string) => setRowStatus(consentId, { type: "confirming" }),
		[setRowStatus],
	);

	const handleCancelConfirm = useCallback(
		(consentId: string) => setRowStatus(consentId, { type: "idle" }),
		[setRowStatus],
	);

	const handleConfirmRevoke = useCallback(
		async (consentId: string) => {
			setRowStatus(consentId, { type: "revoking" });
			try {
				const result = await revokeClientAccess(consentId);
				if (result.success) {
					setRows((prev) => prev.filter((r) => r.consentId !== consentId));
				} else {
					setRowStatus(consentId, { type: "error", message: result.error });
				}
			} catch {
				/* The Server Action handles its own errors; this catch is for
				 * the RSC POST itself rejecting (offline, abort). Without it
				 * the row would stay stuck on the spinner forever. */
				setRowStatus(consentId, {
					type: "error",
					message: "Could not revoke. Check your connection and try again.",
				});
			}
		},
		[setRowStatus],
	);

	return (
		<section className="rounded-xl border border-nova-border bg-nova-surface overflow-hidden">
			{/* ── Card header ───────────────────────────────────────── */}
			<div className="flex items-center gap-3 px-6 py-4 border-b border-nova-border/50">
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nova-violet/10">
					<Icon
						icon={tablerPlugConnected}
						width="18"
						height="18"
						className="text-nova-violet-bright"
					/>
				</div>
				<div className="min-w-0">
					<h2 className="text-base font-display font-semibold text-nova-text">
						Connected applications
					</h2>
					<p className="text-xs text-nova-text-muted">
						Apps you&apos;ve granted access to Nova on your behalf ·{" "}
						<a
							href={docsLink("/mcp/access")}
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Learn more about connected apps"
							className="inline-flex items-center gap-0.5 text-nova-violet-bright transition-colors hover:text-nova-violet-bright underline-offset-2 hover:underline"
						>
							Learn more
							<Icon icon={tablerExternalLink} width="11" height="11" />
						</a>
					</p>
				</div>
			</div>

			{/* ── Card body ─────────────────────────────────────────── */}
			{/*
			 *  The `<ul>` stays mounted unconditionally and the empty
			 *  state renders as a sibling — gating the whole list on
			 *  `rows.length === 0` would unmount AnimatePresence the
			 *  same render the last row needs to play its exit, killing
			 *  the collapse animation. Two AnimatePresences in parallel:
			 *  inner drives per-row exits, outer fades the empty state
			 *  in as `rows.length` crosses zero — both happening at
			 *  the same time so it reads as one transition.
			 */}
			<div className="p-6">
				<ul className="divide-y divide-nova-border/30">
					<AnimatePresence initial={false}>
						{rows.map((row) => (
							<motion.li
								key={row.consentId}
								layout
								exit={ROW_EXIT}
								transition={ROW_TRANSITION}
								className="overflow-hidden"
							>
								<Row
									row={row}
									onRequestConfirm={handleRequestConfirm}
									onCancelConfirm={handleCancelConfirm}
									onConfirmRevoke={handleConfirmRevoke}
								/>
							</motion.li>
						))}
					</AnimatePresence>
				</ul>
				<AnimatePresence>
					{rows.length === 0 && (
						<motion.div
							key="empty"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
						>
							<EmptyState />
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* ── Footer / assurance strip ──────────────────────────── */}
			<div className="flex items-start gap-2 border-t border-nova-border/30 px-6 py-3">
				<Icon
					icon={tablerShieldLock}
					width="14"
					height="14"
					className="mt-0.5 shrink-0 text-nova-violet-bright"
				/>
				<p className="text-xs text-nova-text-muted leading-relaxed">
					Revoking access takes effect immediately. The app will be signed out
					the next time it tries to act on your behalf.
				</p>
			</div>
		</section>
	);
}

// ── Row ────────────────────────────────────────────────────────────

interface RowProps {
	row: RowData;
	onRequestConfirm: (consentId: string) => void;
	onCancelConfirm: (consentId: string) => void;
	onConfirmRevoke: (consentId: string) => void;
}

function Row({
	row,
	onRequestConfirm,
	onCancelConfirm,
	onConfirmRevoke,
}: RowProps) {
	const { consentId, clientName, authorizedAt, scopes, status } = row;

	return (
		<div className="flex items-center gap-4 py-3.5">
			<div className="min-w-0 flex-1">
				{/* Identity line: client name + permissions chip. The
				 *   chip sits next to the name so it reads as part of
				 *   the connected app's identity rather than as a
				 *   metadata sibling of the authorized-date timestamp
				 *   below. Mirrors the api-keys card so both rows on
				 *   the settings page have identical structure. */}
				<div className="flex items-center gap-2 min-w-0">
					<p className="text-sm font-medium text-nova-text truncate">
						{clientName}
					</p>
					<ScopesPopover
						scopes={scopes}
						credentialLabel="OAuth app"
						subjectName={clientName}
					/>
				</div>
				<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-nova-text-muted">
					<span>Authorized {formatAuthorizedAt(authorizedAt)}</span>
				</div>
				{/* Inline error sits under the name so it's visually
				 *   associated with the failed action. */}
				<AnimatePresence>
					{status.type === "error" && (
						<motion.p
							key="error"
							initial={{ opacity: 0, y: -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -4 }}
							transition={{ duration: 0.2 }}
							className="mt-1 text-xs leading-relaxed text-nova-rose"
						>
							{status.message}
						</motion.p>
					)}
				</AnimatePresence>
			</div>

			{/* Reserved-width action column. The "Revoke" idle button
			 *  (~80px) and the `Cancel + Confirm revoke` confirming pair
			 *  (~190px) have very different widths; without pinning the
			 *  column to the widest state, the meta line above would
			 *  reflow on transition. Mirrors the api-keys card's
			 *  `min-w-[12rem]` reservation so both rows on the settings
			 *  page stay visually stable across every state. */}
			<div className="flex shrink-0 justify-end min-w-[12rem]">
				<RowActions
					consentId={consentId}
					status={status}
					onRequestConfirm={onRequestConfirm}
					onCancelConfirm={onCancelConfirm}
					onConfirmRevoke={onConfirmRevoke}
				/>
			</div>
		</div>
	);
}

// ── Row actions ────────────────────────────────────────────────────

interface RowActionsProps {
	consentId: string;
	status: RowStatus;
	onRequestConfirm: (consentId: string) => void;
	onCancelConfirm: (consentId: string) => void;
	onConfirmRevoke: (consentId: string) => void;
}

/**
 * Inline confirm-in-place control. `idle` / `error` show "Revoke";
 * `confirming` swaps to [Cancel] / [Confirm revoke]; `revoking`
 * shows a spinner.
 */
function RowActions({
	consentId,
	status,
	onRequestConfirm,
	onCancelConfirm,
	onConfirmRevoke,
}: RowActionsProps) {
	if (status.type === "revoking") {
		return (
			<span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-nova-text-muted">
				<Icon
					icon={tablerLoader2}
					width="14"
					height="14"
					className="animate-spin"
				/>
				Revoking…
			</span>
		);
	}

	if (status.type === "confirming") {
		return (
			<div className="flex items-center gap-1.5">
				<Button
					type="button"
					variant="link"
					onClick={() => onCancelConfirm(consentId)}
				>
					Cancel
				</Button>
				<Button
					type="button"
					variant="destructive"
					onClick={() => onConfirmRevoke(consentId)}
				>
					Confirm revoke
				</Button>
			</div>
		);
	}

	/* `idle` and `error` share the same Revoke button — the error
	 * message is shown above the actions, so re-showing the plain
	 * Revoke button makes retry obvious. */
	return (
		<Button
			type="button"
			variant="destructive"
			onClick={() => onRequestConfirm(consentId)}
		>
			Revoke
		</Button>
	);
}

// ── Empty state ────────────────────────────────────────────────────

function EmptyState() {
	return (
		<div className="flex flex-col items-center gap-2 py-6 text-center">
			<Icon
				icon={tablerPlugConnected}
				width="28"
				height="28"
				className="text-nova-text-muted"
			/>
			<p className="text-sm text-nova-text">No connected applications</p>
			<p className="max-w-xs text-xs text-nova-text-muted leading-relaxed">
				Apps appear here after you authorize them via OAuth — for example, when
				you connect a coding agent.
			</p>
		</div>
	);
}
