"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { DeletedAppSummary } from "@/lib/db/apps";
import { formatRelativeDate, STATUS_STYLES } from "@/lib/utils/format";
import { ConnectBadge } from "./ConnectBadge";

/** Inline result shape; see the matching note in `AppCard.tsx`. */
type RestoreResult = { success: true } | { success: false; error: string };

interface DeletedAppCardProps {
	app: DeletedAppSummary;
	/** Animation stagger index. */
	index: number;
	onRestore: (appId: string) => Promise<RestoreResult>;
}

/**
 * Card for a soft-deleted app. Same outer frame as `AppCard` so a user
 * toggling tabs reads continuity, but the body is two stacked metadata
 * rows — when it was deleted, then how long is left to restore it.
 * One fact per line keeps each unambiguous and avoids the right column
 * collisions a single right-aligned countdown produced. The countdown
 * line shifts to rose inside the final week so the row reads as "act
 * now" rather than something the user can leave open in another tab.
 *
 * Other deliberate differences from `AppCard`:
 *
 *   - The right-side action is a single-click Restore button, no
 *     confirmation, since restore is non-destructive (it only clears
 *     the soft-delete marker; nothing is overwritten or lost).
 *   - The card is never a `<Link>` — deleted apps aren't navigable.
 *     Opening one would bypass the recovery affordance and land the
 *     user in a builder for an app the system considers gone.
 *
 * Each card owns its own restore state (idle → restoring → unmount-on-
 * success / error → idle) — the parent RSC re-fetches via
 * `revalidatePath` and the row drops out of the deleted list on
 * success.
 */
export function DeletedAppCard({ app, index, onRestore }: DeletedAppCardProps) {
	const [state, setState] = useState<RestoreState>({ type: "idle" });

	const style = STATUS_STYLES[app.status];
	const deletedAt = new Date(app.deleted_at);
	const recoverableUntil = new Date(app.recoverable_until);
	const errorMessage = state.type === "error" ? state.message : null;

	/* Recovery-window urgency cue — when the deadline is inside a
	 * week, the countdown line shifts to rose so the row reads as
	 * "act now" rather than something the user can leave open in
	 * another tab. */
	const isUrgent = recoverableUntil.getTime() - Date.now() <= 7 * 86_400_000;

	const handleRestore = async () => {
		setState({ type: "restoring" });
		try {
			const result = await onRestore(app.id);
			if (!result.success) {
				setState({ type: "error", message: result.error });
			}
			/* On success, parent RSC re-renders without this row and the
			 * card unmounts naturally — no idle reset needed. */
		} catch {
			setState({
				type: "error",
				message: "Could not restore. Check your connection and try again.",
			});
		}
	};

	return (
		<motion.div
			initial={{ opacity: 0, y: 10 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ delay: index * 0.03 }}
		>
			<div className="block p-4 bg-nova-surface border border-nova-border rounded-lg">
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0 flex-1">
						<h3 className="font-medium truncate text-nova-text-secondary">
							{app.app_name || "Untitled"}
						</h3>

						{/*
						 * Two stacked metadata lines — one fact per row. Keeps
						 * each piece of context unambiguous (no separator-or-no-
						 * separator dilemma between sentence-length phrases) and
						 * leaves the right column clear of stray text.
						 */}
						<div className="mt-1 space-y-0.5 text-xs">
							<p className="flex items-center gap-2 text-nova-text-muted">
								<span className="truncate">
									Deleted {formatRelativeDate(deletedAt)}
								</span>
								{app.connect_type && <ConnectBadge type={app.connect_type} />}
							</p>
							<p
								className={
									isUrgent
										? "font-medium text-nova-rose"
										: "text-nova-text-muted"
								}
							>
								{formatCountdown(recoverableUntil)}
							</p>
						</div>

						<AnimatePresence>
							{errorMessage && (
								<motion.p
									key="restore-error"
									initial={{ opacity: 0, y: -4 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -4 }}
									transition={{ duration: 0.18 }}
									className="mt-2 text-xs leading-relaxed text-nova-rose"
								>
									{errorMessage}
								</motion.p>
							)}
						</AnimatePresence>
					</div>
					<div className="shrink-0 flex items-center gap-2">
						<span
							className={`text-xs px-2 py-1 rounded-md ${style.bg} ${style.text}`}
						>
							{style.label}
						</span>
						{state.type === "restoring" ? (
							<span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-nova-text-muted">
								<Icon
									icon={tablerLoader2}
									width="14"
									height="14"
									className="animate-spin"
								/>
								Restoring…
							</span>
						) : (
							<button
								type="button"
								onClick={() => void handleRestore()}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-nova-text-secondary transition-colors hover:bg-nova-violet/[0.08] hover:text-nova-violet-bright"
							>
								<Icon icon={tablerArrowBackUp} width="14" height="14" />
								Restore
							</button>
						)}
					</div>
				</div>
			</div>
		</motion.div>
	);
}

/**
 * Standalone countdown line. Phrased as a complete fact ("X days to
 * restore") because it sits on its own line with no surrounding prose
 * to lean on.
 *
 * `listDeletedApps` filters past-window rows before they reach the
 * UI, so "No longer recoverable" is only seen by a user holding the
 * page open across the moment the deadline ticks past. The branch
 * exists for that edge case and as a defense against any future
 * caller that bypasses the filter.
 */
function formatCountdown(recoverableUntil: Date): string {
	const msRemaining = recoverableUntil.getTime() - Date.now();
	if (msRemaining <= 0) return "No longer recoverable";
	const daysRemaining = Math.floor(msRemaining / 86_400_000);
	if (daysRemaining === 0) return "Last day to restore";
	if (daysRemaining === 1) return "1 day to restore";
	return `${daysRemaining} days to restore`;
}

type RestoreState =
	| { type: "idle" }
	| { type: "restoring" }
	| { type: "error"; message: string };
