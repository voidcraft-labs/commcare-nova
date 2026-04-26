"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPlayerPlay from "@iconify-icons/tabler/player-play";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { AppSummary } from "@/lib/db/apps";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { formatRelativeDate, STATUS_STYLES } from "@/lib/utils/format";
import { ConnectBadge } from "./ConnectBadge";

/**
 * Generic discriminated-union result the optional `onDelete` callback
 * must return. Inlined here (rather than imported from the home-page
 * action module) to keep `components/ui` independent of `app/` —
 * structural typing lets a wider success shape flow in transparently.
 */
type DeleteResult = { success: true } | { success: false; error: string };

interface AppCardProps {
	app: Pick<
		AppSummary,
		| "id"
		| "app_name"
		| "connect_type"
		| "module_count"
		| "form_count"
		| "status"
		| "updated_at"
	>;
	/** Animation stagger index. */
	index: number;
	/** If provided, the card links to this URL on click (idle/error states only). */
	href?: string;
	/** Show the admin-only replay control. */
	showReplay?: boolean;
	/**
	 * If provided, the card grows a trash control + per-card
	 * confirm/spinner state machine. The handler is the home-page
	 * `deleteApp` Server Action; admin uses of the card omit this so
	 * no delete affordance appears.
	 */
	onDelete?: (appId: string) => Promise<DeleteResult>;
}

/**
 * App card for live (non-deleted) rows. Used by the home active list
 * and the admin user-detail page. Each card owns its own delete state
 * (idle → confirming → deleting → unmount-on-success / error → idle)
 * — there is no parent-level orchestration. On a successful delete
 * the Server Action's `revalidatePath` re-runs the parent RSC and the
 * card naturally unmounts when the row drops off the active query.
 *
 * When `href` is provided AND no delete is in-flight (idle / error),
 * the card is a `<Link>`; while confirming or deleting it downgrades
 * to a `<div>` so a misplaced click on the confirm row never
 * navigates away mid-action.
 */
export function AppCard({
	app,
	index,
	href,
	showReplay,
	onDelete,
}: AppCardProps) {
	const navigate = useExternalNavigate();
	const [deleteState, setDeleteState] = useState<DeleteState>({ type: "idle" });

	const style = STATUS_STYLES[app.status];
	const isFailed = app.status === "error";
	const updatedAt = new Date(app.updated_at);

	const interactive =
		deleteState.type === "idle" || deleteState.type === "error";
	const errorMessage =
		deleteState.type === "error" ? deleteState.message : null;

	/* Replay navigation lives on the card so admin and home callers don't
	 * each have to wire a handler. The hook is cheap and unconditional —
	 * we just don't expose the affordance unless `showReplay` is true. */
	const handleReplay = () => navigate.push(`/build/replay/${app.id}`);

	const handleConfirmDelete = async () => {
		if (!onDelete) return;
		setDeleteState({ type: "deleting" });
		try {
			const result = await onDelete(app.id);
			if (!result.success) {
				setDeleteState({ type: "error", message: result.error });
			}
			/* On success the parent RSC re-fetches via the Server Action's
			 * `revalidatePath` and the row drops out of the active list —
			 * this card unmounts, so we don't need to clear state here. */
		} catch {
			setDeleteState({
				type: "error",
				message: "Could not delete. Check your connection and try again.",
			});
		}
	};

	const content = (
		<div className="flex items-center justify-between gap-3">
			<div className="min-w-0 flex-1">
				<h3
					className={`font-medium truncate ${isFailed ? "text-nova-text-muted" : href ? "group-hover:text-nova-text" : ""} transition-colors`}
				>
					{app.app_name || "Untitled"}
				</h3>
				<p className="text-sm text-nova-text-secondary mt-1 flex items-center gap-3">
					{isFailed ? (
						<span className="text-nova-rose/70">Generation failed</span>
					) : (
						<>
							<span>{formatRelativeDate(updatedAt)}</span>
							<span className="text-nova-text-muted">
								{app.module_count} module
								{app.module_count !== 1 ? "s" : ""}
								{" · "}
								{app.form_count} form{app.form_count !== 1 ? "s" : ""}
							</span>
							{app.connect_type && <ConnectBadge type={app.connect_type} />}
						</>
					)}
				</p>
				<AnimatePresence>
					{errorMessage && (
						<motion.p
							key="delete-error"
							initial={{ opacity: 0, y: -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -4 }}
							transition={{ duration: 0.18 }}
							className="mt-1 text-xs leading-relaxed text-nova-rose"
						>
							{errorMessage}
						</motion.p>
					)}
				</AnimatePresence>
			</div>
			<div className="shrink-0 flex items-center gap-2">
				{deleteState.type === "confirming" ? (
					<>
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setDeleteState({ type: "idle" });
							}}
							className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-nova-text-secondary transition-colors hover:bg-nova-border/30 hover:text-nova-text"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								void handleConfirmDelete();
							}}
							className="cursor-pointer rounded-md bg-nova-rose/10 px-3 py-1.5 text-sm font-medium text-nova-rose transition-colors hover:bg-nova-rose/15"
						>
							Confirm delete
						</button>
					</>
				) : deleteState.type === "deleting" ? (
					<span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-nova-text-muted">
						<Icon
							icon={tablerLoader2}
							width="14"
							height="14"
							className="animate-spin"
						/>
						Deleting…
					</span>
				) : (
					<>
						{showReplay && !isFailed && (
							<Tooltip content="Replay generation">
								<button
									type="button"
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										handleReplay();
									}}
									className="p-1.5 text-nova-text-muted hover:text-nova-violet transition-colors rounded-md hover:bg-nova-violet/10 cursor-pointer"
									aria-label="Replay generation"
								>
									<Icon icon={tablerPlayerPlay} width="18" height="18" />
								</button>
							</Tooltip>
						)}
						<span
							className={`text-xs px-2 py-1 rounded-md ${style.bg} ${style.text}`}
						>
							{style.label}
						</span>
						{onDelete && (
							<Tooltip content="Move to recently deleted">
								<button
									type="button"
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										setDeleteState({ type: "confirming" });
									}}
									className="p-1.5 text-nova-text-muted hover:text-nova-rose transition-colors rounded-md hover:bg-nova-rose/[0.08] cursor-pointer"
									aria-label="Delete app"
								>
									<Icon icon={tablerTrash} width="18" height="18" />
								</button>
							</Tooltip>
						)}
					</>
				)}
			</div>
		</div>
	);

	const cardClass =
		"block p-4 bg-nova-surface border border-nova-border rounded-lg";
	const linkClass = `${cardClass} hover:border-nova-border-bright transition-colors group`;
	const dimmedClass = `${cardClass} opacity-60`;

	return (
		<motion.div
			initial={{ opacity: 0, y: 10 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ delay: index * 0.03 }}
		>
			{isFailed || !href || !interactive ? (
				<div className={isFailed ? dimmedClass : cardClass}>{content}</div>
			) : (
				<Link href={href} className={linkClass}>
					{content}
				</Link>
			)}
		</motion.div>
	);
}

/** Internal — parallel to the OAuth revoke pattern. */
type DeleteState =
	| { type: "idle" }
	| { type: "confirming" }
	| { type: "deleting" }
	| { type: "error"; message: string };
