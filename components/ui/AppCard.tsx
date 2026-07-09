"use client";
import { Icon } from "@iconify/react/offline";
import tablerApps from "@iconify-icons/tabler/apps";
import tablerFolderSymlink from "@iconify-icons/tabler/folder-symlink";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { RelativeTime } from "@/components/ui/RelativeTime";
import type { AppSummary } from "@/lib/db/apps";
import type { MoveTarget } from "@/lib/projects/moveTargets";
import { showToast } from "@/lib/ui/toastStore";
import { STATUS_STYLES } from "@/lib/utils/format";
import { ConnectBadge } from "./ConnectBadge";

/**
 * Generic discriminated-union results the optional `onDelete` / `onMove`
 * callbacks return. Inlined here (rather than imported from the home-page
 * action module) to keep `components/ui` independent of `app/` — structural
 * typing lets a wider success shape flow in transparently.
 */
type DeleteResult = { success: true } | { success: false; error: string };
type MoveResult =
	| { success: true; warning?: string }
	| { success: false; error: string };

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
		| "logo"
	>;
	/** Animation stagger index. */
	index: number;
	/** If provided, the card links to this URL on click (idle/error states only). */
	href?: string;
	/**
	 * If provided, the card grows a trash control + per-card
	 * confirm/spinner state machine. The handler is the home-page
	 * `deleteApp` Server Action; admin uses of the card omit this so
	 * no delete affordance appears.
	 */
	onDelete?: (appId: string) => Promise<DeleteResult>;
	/**
	 * If provided AND `canMove` is true, the card grows a "Move to Project" menu.
	 * The handler is the home-page `moveApp` Server Action; on success its
	 * `revalidatePath("/")` re-renders the list and the card unmounts (the app
	 * left this Project's scope).
	 */
	onMove?: (appId: string, toProjectId: string) => Promise<MoveResult>;
	/**
	 * Whether the caller may move this app out (admin/owner of its Project). Drives
	 * whether the menu is shown at all — independent of whether any destinations
	 * exist, so a user with only their personal Project still sees the menu (with
	 * an empty-state hint) rather than no affordance at all.
	 */
	canMove?: boolean;
	/** Projects the app may move into. Empty renders the menu's empty-state hint. */
	moveTargets?: MoveTarget[];
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
	onDelete,
	onMove,
	canMove,
	moveTargets,
}: AppCardProps) {
	const [cardState, setCardState] = useState<CardState>({ type: "idle" });

	const style = STATUS_STYLES[app.status];
	const isFailed = app.status === "error";
	const updatedAt = new Date(app.updated_at);

	/* idle / error / pickingMove keep the card a <Link>; an in-flight action
	 * (deleting / moving) or the delete-confirm row downgrade it to a <div> so a
	 * stray click can't navigate mid-action. `pickingMove` stays a <Link>
	 * deliberately: the move menu is portaled, so swapping the wrapper element
	 * type on open would remount (and mis-anchor) the menu it just opened. */
	const interactive =
		cardState.type === "idle" ||
		cardState.type === "error" ||
		cardState.type === "pickingMove";
	const errorMessage = cardState.type === "error" ? cardState.message : null;
	/* Show the move menu whenever the caller can move the app out, even with no
	 * destinations yet — the menu then shows an empty-state hint, which is more
	 * discoverable than no affordance (and matches the personal-Project panel,
	 * which tells users to "use Move to Project"). */
	const showMove = Boolean(onMove && canMove);
	const hasMoveTargets = Boolean(moveTargets && moveTargets.length > 0);

	const handleConfirmDelete = async () => {
		if (!onDelete) return;
		setCardState({ type: "deleting" });
		try {
			const result = await onDelete(app.id);
			if (!result.success) {
				setCardState({ type: "error", message: result.error });
			}
			/* On success the parent RSC re-fetches via the Server Action's
			 * `revalidatePath` and the row drops out of the active list —
			 * this card unmounts, so we don't need to clear state here. */
		} catch {
			setCardState({
				type: "error",
				message: "Could not delete. Check your connection and try again.",
			});
		}
	};

	const handleMove = async (target: MoveTarget) => {
		if (!onMove) return;
		setCardState({ type: "moving", destName: target.name });
		try {
			const result = await onMove(app.id, target.id);
			if (!result.success) {
				setCardState({ type: "error", message: result.error });
				return;
			}
			/* On success `moveApp`'s `revalidatePath("/")` re-renders the home RSC;
			 * the app leaves this Project's list and this card unmounts. So both the
			 * confirmation AND any non-fatal warning (e.g. case-data sync failed) go
			 * through the global toast store, which survives the unmount — never
			 * inline card state, which would be discarded with the card. A warning is
			 * persistent so the user can act on it after the card is gone. */
			if (result.warning) {
				showToast("warning", "App moved", result.warning, {
					persistent: true,
				});
			} else {
				showToast(
					"info",
					"App moved",
					`"${app.app_name || "Untitled"}" is now in ${target.name}.`,
				);
			}
		} catch {
			setCardState({
				type: "error",
				message: "Could not move. Check your connection and try again.",
			});
		}
	};

	const content = (
		<div className="flex items-center justify-between gap-3">
			{app.logo ? (
				// The app's web-apps logo, denormalized onto the list summary.
				// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
				<img
					src={mediaSrc(app.logo)}
					alt=""
					className="size-9 rounded-md object-cover shrink-0"
				/>
			) : (
				// Same-size fallback so every title block starts at the same x —
				// logo or not, the column stays aligned.
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-nova-violet/10">
					<Icon icon={tablerApps} className="size-5 text-nova-violet-bright" />
				</div>
			)}
			<div className="min-w-0 flex-1">
				<h3
					className={`font-medium truncate ${isFailed ? "text-nova-text-muted" : href ? "group-hover:text-nova-text" : ""} transition-colors`}
				>
					{app.app_name || "Untitled"}
				</h3>
				<p className="text-sm text-nova-text-secondary mt-1 flex items-center gap-3">
					{isFailed ? (
						<span className="text-nova-rose">Generation failed</span>
					) : (
						<>
							<RelativeTime date={updatedAt} />
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
				{cardState.type === "confirmingDelete" ? (
					<>
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setCardState({ type: "idle" });
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
				) : cardState.type === "deleting" ? (
					<span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-nova-text-muted">
						<Icon
							icon={tablerLoader2}
							width="14"
							height="14"
							className="animate-spin"
						/>
						Deleting…
					</span>
				) : cardState.type === "moving" ? (
					<span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-nova-text-muted">
						<Icon
							icon={tablerLoader2}
							width="14"
							height="14"
							className="animate-spin"
						/>
						Moving to {cardState.destName}…
					</span>
				) : (
					<>
						<span
							className={`text-xs px-2 py-1 rounded-md ${style.bg} ${style.text}`}
						>
							{style.label}
						</span>
						{showMove && !isFailed && (
							<DropdownMenu
								open={cardState.type === "pickingMove"}
								onOpenChange={(open) =>
									setCardState((s) =>
										open
											? { type: "pickingMove" }
											: s.type === "pickingMove"
												? { type: "idle" }
												: s,
									)
								}
							>
								<SimpleTooltip content="Move to another Project">
									<DropdownMenuTrigger
										aria-label="Move to another Project"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
										}}
										className="p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-md hover:bg-nova-violet/10 cursor-pointer"
									>
										<Icon icon={tablerFolderSymlink} width="18" height="18" />
									</DropdownMenuTrigger>
								</SimpleTooltip>
								<DropdownMenuContent align="end">
									<DropdownMenuGroup>
										<DropdownMenuLabel>Move to Project</DropdownMenuLabel>
										{hasMoveTargets ? (
											moveTargets?.map((target) => (
												<DropdownMenuItem
													key={target.id}
													onClick={(e) => {
														e.preventDefault();
														e.stopPropagation();
														void handleMove(target);
													}}
												>
													{target.name}
												</DropdownMenuItem>
											))
										) : (
											<DropdownMenuItem disabled>
												No other Projects yet
											</DropdownMenuItem>
										)}
									</DropdownMenuGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{onDelete && (
							<SimpleTooltip content="Move to recently deleted">
								<button
									type="button"
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										setCardState({ type: "confirmingDelete" });
									}}
									className="p-1.5 text-nova-text-muted hover:text-nova-rose transition-colors rounded-md hover:bg-nova-rose/[0.08] cursor-pointer"
									aria-label="Delete app"
								>
									<Icon icon={tablerTrash} width="18" height="18" />
								</button>
							</SimpleTooltip>
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

/** One in-flight notion for the whole card — delete and move can't overlap, so
 *  they share a single state machine (idle ↔ a confirm/picker ↔ an in-flight
 *  action ↔ error). `pickingMove` and `moving` join the delete states in
 *  downgrading the card from <Link> to <div> via `interactive`. */
type CardState =
	| { type: "idle" }
	| { type: "confirmingDelete" }
	| { type: "deleting" }
	| { type: "pickingMove" }
	| { type: "moving"; destName: string }
	| { type: "error"; message: string };
