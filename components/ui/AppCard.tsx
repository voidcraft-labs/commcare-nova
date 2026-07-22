"use client";
import { Icon } from "@iconify/react/offline";
import tablerApps from "@iconify-icons/tabler/apps";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { mediaSrc } from "@/components/builder/media/mediaClient";
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
import { CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE } from "@/lib/projects/moveTargets";
import { STATUS_STYLES } from "@/lib/utils/format";
import { ConnectBadge } from "./ConnectBadge";

/**
 * Generic discriminated-union result the optional `onDelete` callback returns.
 * Inlined here (rather than imported from the home-page action module) to keep
 * `components/ui` independent of `app/`.
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
	/** Show the temporary Project-placement informational popover to admins/owners.
	 * The trigger stays enabled so pointer, keyboard, touch, and assistive-tech
	 * users can all discover why the app cannot move right now. */
	showProjectMoveInfo?: boolean;
}

/**
 * App card for live (non-deleted) rows. Used by the home active list
 * and the admin user-detail page. Each card owns its own delete state
 * (idle → confirming → deleting → unmount-on-success / error → idle)
 * — there is no parent-level orchestration. On a successful delete
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
	showProjectMoveInfo,
}: AppCardProps) {
	const [cardState, setCardState] = useState<CardState>({ type: "idle" });
	const moveInfoTriggerRef = useRef<HTMLButtonElement>(null);
	const moveInfoTitleRef = useRef<HTMLHeadingElement>(null);

	const style = STATUS_STYLES[app.status];
	const isFailed = app.status === "error";
	const updatedAt = new Date(app.updated_at);
	const displayName = app.app_name || "Untitled";
	const moveInfoLabel = `About moving ${displayName}`;

	/* Keep navigation available while the information popover is open. The card's
	 * DOM shape is stable because the primary Link is an overlay sibling rather
	 * than the surface wrapper. Confirm/delete states remove that overlay. */
	const interactive =
		cardState.type === "idle" ||
		cardState.type === "error" ||
		cardState.type === "showingMoveInfo";
	const errorMessage = cardState.type === "error" ? cardState.message : null;

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
					title={displayName}
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
			<div className="pointer-events-auto relative z-10 shrink-0 flex items-center gap-2">
				{cardState.type === "confirmingDelete" ? (
					<>
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setCardState({ type: "idle" });
							}}
							className="min-h-11 cursor-pointer rounded-md px-3 py-1.5 text-sm text-nova-text-secondary transition-colors hover:bg-nova-border/30 hover:text-nova-text"
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
							className="min-h-11 cursor-pointer rounded-md bg-nova-rose/10 px-3 py-1.5 text-sm font-medium text-nova-rose transition-colors hover:bg-nova-rose/15"
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
				) : (
					<>
						<span
							className={`text-xs px-2 py-1 rounded-md ${style.bg} ${style.text}`}
						>
							{style.label}
						</span>
						{showProjectMoveInfo && !isFailed && (
							<Popover
								open={cardState.type === "showingMoveInfo"}
								onOpenChange={(open) =>
									setCardState((s) =>
										open
											? { type: "showingMoveInfo" }
											: s.type === "showingMoveInfo"
												? { type: "idle" }
												: s,
									)
								}
							>
								<SimpleTooltip content="About moving this app">
									<PopoverTrigger
										ref={moveInfoTriggerRef}
										render={
											<Button type="button" variant="ghost" size="icon-lg" />
										}
										aria-label={moveInfoLabel}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
										}}
										className="size-12 text-nova-text-muted not-disabled:hover:bg-nova-violet/10 not-disabled:hover:text-nova-text"
									>
										<Icon icon={tablerInfoCircle} width="18" height="18" />
									</PopoverTrigger>
								</SimpleTooltip>
								<PopoverContent
									align="end"
									sideOffset={6}
									className="w-80"
									initialFocus={moveInfoTitleRef}
									finalFocus={moveInfoTriggerRef}
								>
									<PopoverHeader>
										<PopoverTitle
											ref={moveInfoTitleRef}
											tabIndex={-1}
											className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-nova-violet-bright/60 focus-visible:ring-offset-2 focus-visible:ring-offset-nova-surface"
										>
											Moving between Projects
										</PopoverTitle>
									</PopoverHeader>
									<PopoverDescription className="leading-relaxed text-nova-text-secondary">
										{CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE}
									</PopoverDescription>
								</PopoverContent>
							</Popover>
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
									className="inline-flex size-11 cursor-pointer items-center justify-center rounded-md text-nova-text-muted transition-colors hover:bg-nova-rose/[0.08] hover:text-nova-rose"
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
	const openHref = !isFailed && interactive ? href : undefined;
	const linkClass = `${cardClass} hover:border-nova-border-bright transition-colors group`;
	const dimmedClass = `${cardClass} opacity-60`;

	return (
		<motion.div
			initial={{ opacity: 0, y: 10 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ delay: index * 0.03 }}
		>
			<div
				className={isFailed ? dimmedClass : openHref ? linkClass : cardClass}
			>
				{openHref && (
					<Link
						href={openHref}
						aria-label={`Open ${displayName}`}
						className="absolute inset-0 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
	| { type: "showingMoveInfo" }
	| { type: "error"; message: string };
