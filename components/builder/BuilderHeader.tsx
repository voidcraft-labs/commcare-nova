/**
 * BuilderHeader — the builder's one chrome row, replacing the site's
 * AppHeader inside `/build/*` (see `(site)/layout.tsx` for the split).
 *
 * Three-column grid: logo (the exit back to the app list) on the left,
 * the Preview toggle dead center, document tools + account on the
 * right. The header is site + document-action chrome only — the app's
 * own identity and settings live in the structure sidebar's app row.
 * Preview is centered because reach matters more than corner
 * convention — the canvas is center-aligned, so the toggle sits
 * directly above the user's work, one short travel away. Nothing can
 * collide with it: breadcrumbs live in the canvas column's own strip
 * (`BreadcrumbStrip`), where the sidebars bound their width.
 *
 * The logo renders in every phase. Portal-opening header controls stay
 * unmounted while app access is unresolved, so the access mask never leaves
 * a visible button whose popup is intentionally quarantined.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import Link from "next/link";
import { BuilderAccessStatus } from "@/components/builder/AccessStatus";
import { ExportPanel } from "@/components/builder/ExportPanel";
import { PresenceRoster } from "@/components/builder/PresenceRoster";
import { PreviewToggle } from "@/components/builder/PreviewToggle";
import { SaveIndicator } from "@/components/builder/SaveIndicator";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { ImpersonationBanner } from "@/components/ui/ImpersonationBanner";
import { Logo } from "@/components/ui/Logo";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useCanRedo, useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import { shortcutLabel } from "@/lib/platform";
import { useUndoRedo } from "@/lib/routing/builderActions";
import {
	useAccessPhase,
	useBuilderIsReady,
	useCanEdit,
} from "@/lib/session/hooks";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";

interface BuilderHeaderProps {
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** Every project space the key can upload to (drives the dialog picker). */
	commcareAvailableDomains: { name: string; displayName: string }[];
	/** Preview toggle handler — BuilderLayout's scroll-anchor-capturing
	 *  wrapper around the store's `setPreviewing`. */
	onSetPreviewing: (on: boolean) => void;
	/** Active impersonation info, or null when viewing as yourself —
	 *  resolved by the build page's RSC, mirroring the site header. */
	impersonating: { userName: string; userEmail: string } | null;
}

export function BuilderHeader({
	commcareConfigured,
	commcareAvailableDomains,
	onSetPreviewing,
	impersonating,
}: BuilderHeaderProps) {
	const hasData = useDocHasData();
	const isReady = useBuilderIsReady();
	const canEdit = useCanEdit();
	const accessPhase = useAccessPhase();
	const compactHeight = useIsBreakpoint("max", 360, "height");
	const compactHeader = useIsBreakpoint("max", 1100);
	/* Five-peer presence plus the compact document actions overlap the centered
	 * Preview control until the canvas is comfortably wider than 533px. Keep
	 * the two-row composition through 560px so visible controls never compete
	 * for the same hit-test area at the breakpoint seam. */
	const ultraCompactHeader = useIsBreakpoint("max", 560);

	/* Undo/redo from doc temporal. Availability folds into stable
	 * booleans so the header only re-renders when it actually flips. */
	const { undo, redo } = useUndoRedo();
	const canUndo = useCanUndo();
	const canRedo = useCanRedo();

	const showAccessStatus = isReady && hasData;
	const showToolbar = showAccessStatus && accessPhase === "authorized";
	const showDocumentRow = showToolbar || showAccessStatus;

	return (
		<header
			data-header-layout={ultraCompactHeader ? "ultra-compact" : "standard"}
			className={
				ultraCompactHeader
					? "grid shrink-0 grid-cols-[44px_1fr_44px] grid-rows-[60px_auto] items-center border-b border-nova-border bg-nova-void px-2"
					: `grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-nova-border bg-nova-void px-4 ${
							compactHeight ? "h-[60px]" : "h-14"
						}`
			}
		>
			<div
				className={
					ultraCompactHeader
						? "col-start-1 row-start-1 flex min-w-0 items-center"
						: "flex min-w-0 items-center gap-4"
				}
			>
				<Link
					href="/"
					aria-label="Back to applications"
					className={`${ultraCompactHeader ? "justify-center" : "-ml-2 px-2"} inline-flex min-h-11 min-w-11 items-center rounded-lg focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none`}
				>
					<Logo size="sm" markOnly={ultraCompactHeader} />
				</Link>
				{impersonating && !ultraCompactHeader && (
					<ImpersonationBanner
						userName={impersonating.userName}
						userEmail={impersonating.userEmail}
					/>
				)}
			</div>
			<div
				className={
					ultraCompactHeader
						? "col-start-2 row-start-1 justify-self-center"
						: "justify-self-center"
				}
			>
				{showToolbar && <PreviewToggle onSetPreviewing={onSetPreviewing} />}
			</div>
			<div
				data-header-document-actions
				className={
					ultraCompactHeader
						? showDocumentRow
							? "col-span-3 row-start-2 flex min-h-12 min-w-0 items-center justify-center gap-1 border-t border-nova-border"
							: "hidden"
						: "flex min-w-0 items-center gap-1 justify-self-end"
				}
			>
				{showAccessStatus && (
					<>
						{/* Who-else-is-here avatars — first in the cluster with their own
						 *  divider (the Google-Docs arrangement: people, then actions).
						 *  Shown for editors AND viewers (a viewer still sees who's
						 *  editing); renders nothing in a solo session. */}
						{showToolbar ? <PresenceRoster compact={compactHeader} /> : null}
						<BuilderAccessStatus compact={compactHeader} />
						{/* Keep the autosave owner mounted through reversible access
						 * transitions; only its visual output is conditional internally. */}
						<SaveIndicator compact={compactHeader} />
						{/* Edit affordances — hidden for a view-only member. Preview +
						 *  Export stay (a viewer may preview and download the app);
						 *  HQ upload inside Export stays gated server-side. */}
						{showToolbar && canEdit ? (
							compactHeader ? (
								<DropdownMenu>
									<SimpleTooltip content="Edit history" side="bottom">
										<DropdownMenuTrigger
											aria-label="Edit history"
											className="flex size-11 items-center justify-center rounded-lg text-nova-text-muted outline-none transition-colors hover:bg-white/5 hover:text-nova-text focus-visible:ring-3 focus-visible:ring-ring/50"
										>
											<Icon icon={tablerDotsVertical} width="18" height="18" />
										</DropdownMenuTrigger>
									</SimpleTooltip>
									<DropdownMenuContent align="end" sideOffset={6}>
										<DropdownMenuItem onClick={undo} disabled={!canUndo}>
											<Icon icon={tablerArrowBackUp} width="18" height="18" />
											<span className="flex-1">Undo</span>
											<span className="text-xs text-nova-text-muted">
												{shortcutLabel("mod", "Z")}
											</span>
										</DropdownMenuItem>
										<DropdownMenuItem onClick={redo} disabled={!canRedo}>
											<Icon
												icon={tablerArrowForwardUp}
												width="18"
												height="18"
											/>
											<span className="flex-1">Redo</span>
											<span className="text-xs text-nova-text-muted">
												{shortcutLabel("mod", "shift", "Z")}
											</span>
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							) : (
								<>
									<SimpleTooltip
										content={`Undo (${shortcutLabel("mod", "Z")})`}
									>
										<Button
											type="button"
											variant="ghost"
											size="icon-lg"
											onClick={undo}
											disabled={!canUndo}
											className="size-11 text-nova-text-muted not-disabled:hover:bg-white/5 not-disabled:hover:text-nova-text"
											aria-label="Undo"
										>
											<Icon icon={tablerArrowBackUp} width="18" height="18" />
										</Button>
									</SimpleTooltip>
									<SimpleTooltip
										content={`Redo (${shortcutLabel("mod", "shift", "Z")})`}
									>
										<Button
											type="button"
											variant="ghost"
											size="icon-lg"
											onClick={redo}
											disabled={!canRedo}
											className="size-11 text-nova-text-muted not-disabled:hover:bg-white/5 not-disabled:hover:text-nova-text"
											aria-label="Redo"
										>
											<Icon
												icon={tablerArrowForwardUp}
												width="18"
												height="18"
											/>
										</Button>
									</SimpleTooltip>
								</>
							)
						) : null}
						{showToolbar ? (
							<ExportPanel
								commcareConfigured={commcareConfigured}
								commcareAvailableDomains={commcareAvailableDomains}
							/>
						) : null}
					</>
				)}
				{accessPhase === "authorized" && !ultraCompactHeader && (
					<div className="ml-1">
						<AccountMenu />
					</div>
				)}
			</div>
			{accessPhase === "authorized" && ultraCompactHeader && (
				<div className="col-start-3 row-start-1 justify-self-end">
					<AccountMenu />
				</div>
			)}
			{ultraCompactHeader && impersonating && (
				<div className="col-span-3 row-start-3 min-w-0 border-t border-nova-border py-2">
					<ImpersonationBanner
						userName={impersonating.userName}
						userEmail={impersonating.userEmail}
					/>
				</div>
			)}
		</header>
	);
}
