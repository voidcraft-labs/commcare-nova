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

import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPlugConnected from "@iconify-icons/tabler/plug-connected";
import tablerShieldLock from "@iconify-icons/tabler/shield-lock";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import type { AuthorizedClient } from "@/lib/db/oauth-consents";
import { deriveCapabilities } from "@/lib/oauth/capabilities";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { revokeClientAccess } from "./oauth-actions";

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
		<section className="rounded-xl border border-nova-border overflow-hidden">
			{/* ── Card header ───────────────────────────────────────── */}
			<div className="flex items-center gap-3 px-6 py-4 border-b border-nova-border/50 bg-nova-surface/20">
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
						Apps you&apos;ve granted access to Nova on your behalf
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
					className="mt-0.5 shrink-0 text-nova-violet/50"
				/>
				<p className="text-xs text-nova-text-muted/70 leading-relaxed">
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
				<p className="text-sm font-medium text-nova-text truncate">
					{clientName}
				</p>
				<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-nova-text-muted">
					<span>Authorized {formatAuthorizedAt(authorizedAt)}</span>
					<ScopesPopover scopes={scopes} clientName={clientName} />
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

			<div className="shrink-0">
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

// ── Scopes popover ─────────────────────────────────────────────────

interface ScopesPopoverProps {
	scopes: readonly string[];
	clientName: string;
}

/**
 * "Permissions" pill on each row's metadata line. Hover, focus, or
 * click opens a popover with the human-friendly capability list.
 * `openOnHover` keeps the click affordance for keyboard / touch.
 *
 * Suppressed entirely when `deriveCapabilities` returns nothing —
 * no hollow pill opening an empty popover. Glass styles live on the
 * positioner per the project-wide `backdrop-filter` + `will-change`
 * constraint (see `lib/styles.ts`).
 */
function ScopesPopover({ scopes, clientName }: ScopesPopoverProps) {
	const capabilities = deriveCapabilities(scopes);
	if (capabilities.length === 0) return null;

	return (
		<Popover.Root>
			<Popover.Trigger
				openOnHover
				delay={150}
				closeDelay={120}
				aria-label={`Permissions granted to ${clientName}`}
				className="inline-flex cursor-pointer items-center rounded-md border border-nova-violet/20 bg-nova-violet/[0.08] px-2 py-[2px] text-[11px] font-medium text-nova-violet-bright outline-none transition-all duration-150 hover:border-nova-violet/40 hover:bg-nova-violet/[0.14] focus-visible:border-nova-violet/40 focus-visible:bg-nova-violet/[0.14] focus-visible:ring-1 focus-visible:ring-nova-violet/40"
			>
				Permissions
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					side="top"
					align="start"
					sideOffset={8}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={`${POPOVER_POPUP_CLS} w-64`}>
						<div className="px-4 pt-3.5 pb-4">
							<p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-nova-text-muted/70">
								This app can
							</p>
							<ul className="space-y-2">
								{capabilities.map((c) => (
									<li key={c.key} className="flex items-start gap-2.5">
										<Icon
											icon={c.icon}
											width="14"
											height="14"
											className="mt-[3px] shrink-0 text-nova-text-muted"
											aria-hidden
										/>
										<span className="text-xs leading-snug text-nova-text">
											{c.label}
										</span>
									</li>
								))}
							</ul>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
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
				<button
					type="button"
					onClick={() => onCancelConfirm(consentId)}
					className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-nova-text-secondary transition-colors hover:bg-nova-border/30 hover:text-nova-text"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => onConfirmRevoke(consentId)}
					className="cursor-pointer rounded-md bg-nova-rose/10 px-3 py-1.5 text-sm font-medium text-nova-rose transition-colors hover:bg-nova-rose/15"
				>
					Confirm revoke
				</button>
			</div>
		);
	}

	/* `idle` and `error` share the same button — error message is
	 * shown above the actions, so the button returns to idle styling
	 * to make retry obvious. */
	return (
		<button
			type="button"
			onClick={() => onRequestConfirm(consentId)}
			className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-nova-text-secondary transition-colors hover:bg-nova-rose/[0.06] hover:text-nova-rose"
		>
			Revoke
		</button>
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
				className="text-nova-text-muted/40"
			/>
			<p className="text-sm text-nova-text">No connected applications</p>
			<p className="max-w-xs text-xs text-nova-text-muted/70 leading-relaxed">
				Apps appear here after you authorize them via OAuth — for example, when
				you connect a coding agent.
			</p>
		</div>
	);
}
