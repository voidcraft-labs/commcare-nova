"use client";
import { Icon } from "@iconify/react/offline";
import tablerApps from "@iconify-icons/tabler/apps";
import tablerBuildingCommunity from "@iconify-icons/tabler/building-community";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { RelativeTime } from "@/components/ui/RelativeTime";
import type { AppSummary } from "@/lib/db/apps";
import { CROSS_PROJECT_MOVE_DISCLOSURE } from "@/lib/projects/moveTargets";
import { STATUS_STYLES } from "@/lib/utils/format";
import { ConnectBadge } from "./ConnectBadge";

/**
 * Generic discriminated-union results the optional callbacks return. Inlined
 * here (rather than imported from the home-page action module) to keep
 * `components/ui` independent of `app/`.
 */
type DeleteResult = { success: true } | { success: false; error: string };
type MoveResult = { success: true } | { success: false; error: string };

/** A Project this member may move the app into. */
export interface AppProjectMoveTarget {
	id: string;
	name: string;
}

/**
 * The Project-placement affordance, shown only to members who govern it.
 */
export type AppProjectMoveAffordance = {
	/** Other Projects where this member also holds the capability. */
	targets: readonly AppProjectMoveTarget[];
	onMove: (appId: string, toProjectId: string) => Promise<MoveResult>;
};

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
	/** If provided, the card links to this URL whenever no delete is in flight. */
	href?: string;
	/**
	 * If provided, the card grows a trash control + per-card
	 * confirm/spinner state machine. The handler is the home-page
	 * `deleteApp` Server Action; admin uses of the card omit this so
	 * no delete affordance appears.
	 */
	onDelete?: (appId: string) => Promise<DeleteResult>;
	/** If provided, the card grows the Project-placement control. Supplied only
	 *  to members who govern placement in this Project; an empty target list
	 *  still shows the control, explaining what a destination requires rather
	 *  than hiding the operation. */
	projectMove?: AppProjectMoveAffordance;
}

/**
 * App card for live (non-deleted) rows. Used by the home active list
 * and the admin user-detail page. Each card owns its own delete state
 * (idle → confirming → deleting → unmount-on-success / error → idle):
 * there is no parent-level orchestration. On a successful delete
 * the Server Action's `revalidatePath` re-runs the parent RSC and the
 * card naturally unmounts when the row drops off the active query.
 *
 * When `href` is provided and no delete is in flight, an absolute primary link
 * sits behind the card content. Action controls are siblings above it, never
 * nested inside it. Confirming or deleting removes the primary link so a stray
 * click cannot navigate away mid-action.
 */
export function AppCard({
	app,
	index,
	href,
	onDelete,
	projectMove,
}: AppCardProps) {
	const [cardState, setCardState] = useState<CardState>({ type: "idle" });
	const [moveTargetId, setMoveTargetId] = useState<string | null>(null);
	const moveTriggerRef = useRef<HTMLButtonElement>(null);
	const moveTitleRef = useRef<HTMLHeadingElement>(null);
	const deleteTriggerRef = useRef<HTMLButtonElement>(null);
	const confirmDeleteRef = useRef<HTMLButtonElement>(null);
	/* Armed when the confirmation takes focus, consumed when it gives it back.
	 * The trash control is UNMOUNTED while the confirmation is up, so focusing
	 * it has to wait for the render that brings it back rather than happening
	 * in the handler that asked for it. */
	const restoreDeleteFocusRef = useRef(false);

	/* Backing out of the delete confirmation. `returnFocus` is true when the
	 * person dismissed it deliberately (Cancel, Escape) and false when they
	 * simply clicked somewhere else, where pulling focus back to the trash
	 * would fight whatever they just reached for. */
	const cancelConfirmDelete = useCallback((returnFocus: boolean) => {
		if (!returnFocus) restoreDeleteFocusRef.current = false;
		setCardState((s) => (s.type === "confirmingDelete" ? { type: "idle" } : s));
	}, []);

	const confirmingDelete = cardState.type === "confirmingDelete";
	useEffect(() => {
		if (confirmingDelete || !restoreDeleteFocusRef.current) return;
		restoreDeleteFocusRef.current = false;
		deleteTriggerRef.current?.focus();
	}, [confirmingDelete]);

	/* The confirmation replaces the trash control in place rather than opening
	 * a dialog, so it has to grow the affordances a dialog owns for free:
	 * focus lands on the confirm instead of falling to the document body, and
	 * both Escape and a click anywhere outside back out. Without them the only
	 * way out of a destructive question is one specific 44px target. */
	const confirmDeleteClusterRef = useCallback(
		(node: HTMLSpanElement | null) => {
			if (!node) return;
			confirmDeleteRef.current?.focus();
			const onPointerDown = (event: PointerEvent) => {
				if (!node.contains(event.target as Node)) cancelConfirmDelete(false);
			};
			const onKeyDown = (event: KeyboardEvent) => {
				if (event.key === "Escape") cancelConfirmDelete(true);
			};
			document.addEventListener("pointerdown", onPointerDown, true);
			document.addEventListener("keydown", onKeyDown);
			return () => {
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("keydown", onKeyDown);
			};
		},
		[cancelConfirmDelete],
	);

	const style = STATUS_STYLES[app.status];
	const isFailed = app.status === "error";
	const updatedAt = new Date(app.updated_at);
	const displayName = app.app_name || "Untitled";
	const moveLabel = `Move ${displayName} to another Project`;

	/* Keep navigation available while the placement popover is open. The card's
	 * DOM shape is stable because the primary Link is an overlay sibling rather
	 * than the surface wrapper. Confirm/delete/move states remove that overlay. */
	const interactive =
		cardState.type === "idle" ||
		cardState.type === "error" ||
		cardState.type === "choosingMoveTarget";
	const errorMessage = cardState.type === "error" ? cardState.message : null;

	const handleMove = async () => {
		if (!projectMove || !moveTargetId) return;
		setCardState({ type: "movingApp" });
		try {
			const result = await projectMove.onMove(app.id, moveTargetId);
			if (!result.success) {
				setCardState({ type: "error", message: result.error });
				return;
			}
			/* The action revalidates the home page; the app leaves this Project's
			 * list and this card unmounts, so there is no success state to hold. */
		} catch {
			setCardState({
				type: "error",
				message:
					"Could not move this app. Check your connection and try again.",
			});
		}
	};

	const handleConfirmDelete = async () => {
		if (!onDelete) return;
		setCardState({ type: "deleting" });
		try {
			const result = await onDelete(app.id);
			if (!result.success) {
				setCardState({ type: "error", message: result.error });
			}
			/* On success the parent RSC re-fetches via the Server Action's
			 * `revalidatePath` and the row drops out of the active list:
			 * this card unmounts, so we don't need to clear state here. */
		} catch {
			setCardState({
				type: "error",
				message: "Could not delete. Check your connection and try again.",
			});
		}
	};

	const content = (
		/* Below 480px the status badge and the action controls take more room
		 * than the name has to give (they squeezed an 8-character title down to
		 * "Mod…"), so they drop to their own row and the name gets the width
		 * back. Wider than that the card stays the single row it reads best as. */
		<div className="flex flex-wrap items-center justify-between gap-3">
			{app.logo ? (
				// The app's web-apps logo, denormalized onto the list summary.
				// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
				<img
					src={mediaSrc(app.logo)}
					alt=""
					className="size-9 rounded-md object-cover shrink-0"
				/>
			) : (
				// Same-size fallback so every title block starts at the same x:
				// logo or not, the column stays aligned.
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-nova-violet/10">
					<Icon icon={tablerApps} className="size-5 text-nova-violet-bright" />
				</div>
			)}
			<div className="min-w-0 flex-1">
				<h3
					title={displayName}
					className={`font-medium truncate ${isFailed ? "text-nova-text-muted" : href ? "group-hover:text-nova-text" : ""} transition-colors`}
				>
					{app.app_name || "Untitled"}
				</h3>
				{/* Each fragment is one phrase, so the row wraps BETWEEN them rather
				 * than breaking "24m ago" or "2 modules · 2 forms" across lines.
				 * On a handset there isn't room for both beside the status badge,
				 * and a metadata line broken mid-phrase reads as damage. */}
				<p className="text-sm text-nova-text-secondary mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
					{isFailed ? (
						<span className="text-nova-rose">Generation failed</span>
					) : (
						<>
							<RelativeTime
								date={updatedAt}
								className="whitespace-nowrap first-letter:uppercase"
							/>
							<span className="whitespace-nowrap text-nova-text-muted">
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
			<div className="pointer-events-auto relative z-10 flex w-full shrink-0 items-center justify-end gap-2 min-[480px]:w-auto">
				{cardState.type === "confirmingDelete" ? (
					<span
						ref={confirmDeleteClusterRef}
						className="flex items-center gap-2"
					>
						<Button
							type="button"
							variant="ghost"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								cancelConfirmDelete(true);
							}}
						>
							Cancel
						</Button>
						<Button
							ref={confirmDeleteRef}
							type="button"
							variant="destructive"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								void handleConfirmDelete();
							}}
						>
							Confirm delete
						</Button>
					</span>
				) : cardState.type === "deleting" || cardState.type === "movingApp" ? (
					<span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-nova-text-muted">
						<Icon
							icon={tablerLoader2}
							width="14"
							height="14"
							className="animate-spin"
						/>
						{cardState.type === "deleting" ? "Deleting…" : "Moving…"}
					</span>
				) : (
					<>
						<Badge variant={style.variant}>{style.label}</Badge>
						{projectMove && !isFailed && (
							<Popover
								open={cardState.type === "choosingMoveTarget"}
								onOpenChange={(open) => {
									/* Closing abandons the choice. Keeping it would leave the
									 * next open pre-armed, so a single click on a popover the
									 * user only meant to read would move the app and all of its
									 * data: there is no confirmation step after this. */
									if (!open) setMoveTargetId(null);
									setCardState((s) =>
										open
											? { type: "choosingMoveTarget" }
											: s.type === "choosingMoveTarget"
												? { type: "idle" }
												: s,
									);
								}}
							>
								<SimpleTooltip content="Move to another Project">
									<PopoverTrigger
										ref={moveTriggerRef}
										render={
											<Button type="button" variant="ghost" size="icon" />
										}
										aria-label={moveLabel}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
										}}
										className="size-11 text-nova-text-muted not-disabled:hover:bg-nova-violet/10 not-disabled:hover:text-nova-text"
									>
										<Icon
											icon={tablerBuildingCommunity}
											width="18"
											height="18"
										/>
									</PopoverTrigger>
								</SimpleTooltip>
								<PopoverContent
									align="end"
									sideOffset={6}
									className="w-80"
									initialFocus={moveTitleRef}
									finalFocus={moveTriggerRef}
								>
									<PopoverHeader>
										<PopoverTitle
											ref={moveTitleRef}
											tabIndex={-1}
											className="nova-focusable rounded-sm outline-none"
										>
											Moving between Projects
										</PopoverTitle>
									</PopoverHeader>
									{projectMove.targets.length === 0 ? (
										<PopoverDescription className="leading-relaxed text-nova-text-secondary">
											There's nowhere to move this app yet. A destination has to
											be a Project where you're an admin or owner too.
										</PopoverDescription>
									) : (
										<>
											<PopoverDescription className="leading-relaxed text-nova-text-secondary">
												{CROSS_PROJECT_MOVE_DISCLOSURE}
											</PopoverDescription>
											{/* An inline list, not a Select: a second floating
											    surface opened from inside this popover would render
											    beneath it, and the destination set is small enough
											    to show in full. */}
											<fieldset className="mt-3 flex max-h-52 flex-col overflow-y-auto">
												<legend className="sr-only">Destination Project</legend>
												{projectMove.targets.map((target) => (
													<label
														key={target.id}
														className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-nova-text transition-colors hover:bg-white/[0.06] has-checked:bg-nova-violet/10 has-focus-visible:shadow-(--focus-ring)"
													>
														<input
															type="radio"
															name={`move-destination-${app.id}`}
															value={target.id}
															checked={target.id === moveTargetId}
															onChange={() => setMoveTargetId(target.id)}
															autoComplete="off"
															data-1p-ignore
															className="size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-nova-border transition-all checked:border-[5px] checked:border-nova-violet-bright nova-focusable"
														/>
														<span className="flex-1 truncate font-medium">
															{target.name}
														</span>
													</label>
												))}
											</fieldset>
											<Button
												type="button"
												className="mt-2 w-full"
												disabled={!moveTargetId}
												onClick={() => void handleMove()}
											>
												Move app
											</Button>
										</>
									)}
								</PopoverContent>
							</Popover>
						)}
						{onDelete && (
							<SimpleTooltip content="Move to recently deleted">
								<button
									ref={deleteTriggerRef}
									type="button"
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										/* The confirmation is about to take focus, so whichever
										 * way it leaves (Cancel, Escape, a refused delete) hands
										 * focus back here rather than to the document. */
										restoreDeleteFocusRef.current = true;
										setCardState({ type: "confirmingDelete" });
									}}
									className="nova-focusable inline-flex size-11 cursor-pointer items-center justify-center rounded-xl text-nova-text-muted transition-colors hover:bg-nova-rose/[0.08] hover:text-nova-rose"
									aria-label={`Move ${displayName} to recently deleted`}
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
		"relative p-4 bg-nova-surface border border-nova-border rounded-lg";
	/* A materialized design remains a valid, resumable app when a later slice
	 * fails. Its error status changes the card treatment, not its reachability. */
	const openHref = interactive ? href : undefined;
	const linkClass = `${cardClass} hover:border-nova-border-bright transition-colors group`;
	const dimmedClass = `${cardClass} opacity-60`;

	return (
		<motion.div
			initial={{ opacity: 0, y: 10 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ delay: index * 0.03 }}
		>
			<div
				className={
					isFailed
						? openHref
							? `${linkClass} opacity-60`
							: dimmedClass
						: openHref
							? linkClass
							: cardClass
				}
			>
				{openHref && (
					<Link
						href={openHref}
						aria-label={`Open ${displayName}`}
						className="nova-focusable absolute inset-0 rounded-lg outline-none"
					/>
				)}
				<div className="pointer-events-none relative z-10">{content}</div>
			</div>
		</motion.div>
	);
}

/** Delete owns the only in-flight state. `showingMoveInfo` keeps navigation
 * available while the portaled informational popover is open. */
type CardState =
	| { type: "idle" }
	| { type: "confirmingDelete" }
	| { type: "deleting" }
	| { type: "choosingMoveTarget" }
	| { type: "movingApp" }
	| { type: "error"; message: string };
