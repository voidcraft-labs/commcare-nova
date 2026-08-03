/**
 * What the shared header holds inside `/build/*`.
 *
 * The band is `AppHeader`'s, not this file's: the builder used to run its own
 * header 8px shorter with its mark 4px further left, and crossing between the
 * two made the brand hop. Everything here is a slot.
 *
 * Preview goes dead centre because reach matters more than corner convention:
 * the canvas is centre-aligned, so the toggle sits directly above the user's
 * work, one short travel away. Nothing can collide with it — breadcrumbs live
 * in the canvas column's own strip (`BreadcrumbStrip`), where the sidebars
 * bound their width.
 *
 * The mark hands the wordmark back the moment the app exists. Two reasons,
 * and they are the same reason: the app being built carries its own name in
 * the structure sidebar's app row, so a second name on the screen makes the
 * reader decide which one they are looking at; and the sphere is now the way
 * OUT, which is the job a logo has always had. `/build/new` is the exception,
 * and deliberately so: no app exists yet, so the whole lockup stands as
 * Nova's own presence, and starting a build draws the word into the sphere.
 *
 * Portal-opening header controls stay unmounted while app access is
 * unresolved, so the access mask never leaves a visible button whose popup is
 * intentionally quarantined. The mark is never one of them: it renders in
 * every phase.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import { BuilderAccessStatus } from "@/components/builder/AccessStatus";
import { PresenceRoster } from "@/components/builder/PresenceRoster";
import { PreviewIdentityMenu } from "@/components/builder/PreviewIdentityMenu";
import { PreviewToggle } from "@/components/builder/PreviewToggle";
import { PublishPanel } from "@/components/builder/PublishPanel";
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
import { AppHeader } from "@/components/ui/AppHeader";
import { ImpersonationBanner } from "@/components/ui/ImpersonationBanner";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useCanRedo, useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import { shortcutLabel } from "@/lib/platform";
import { useUndoRedo } from "@/lib/routing/builderActions";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	useAccessPhase,
	useBuilderIsReady,
	useBuilderPhase,
	useCanEdit,
} from "@/lib/session/hooks";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";

interface BuilderHeaderProps {
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** Every project space the key can upload to (drives the dialog picker). */
	commcareAvailableDomains: { name: string; displayName: string }[];
	/** Preview toggle handler: BuilderLayout's scroll-anchor-capturing
	 *  wrapper around the store's `setPreviewing`. */
	onSetPreviewing: (on: boolean) => void;
	/** Active impersonation info, or null when viewing as yourself:
	 *  resolved by the build page's RSC, mirroring the site header. */
	impersonating: { userName: string; userEmail: string } | null;
}

export function BuilderHeader({
	commcareConfigured,
	commcareAvailableDomains,
	onSetPreviewing,
	impersonating,
}: BuilderHeaderProps) {
	const phase = useBuilderPhase();
	const hasData = useDocHasData();
	const isReady = useBuilderIsReady();
	const canEdit = useCanEdit();
	const accessPhase = useAccessPhase();
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
	const showAccount = accessPhase === "authorized";

	/* Idle is `/build/new` with nothing sent: no app, so nothing else on screen
	 * is carrying the name. Every other phase means a blueprint exists (or is
	 * arriving), and the sphere takes over. */
	const beforeAnyApp = phase === BuilderPhase.Idle;

	const documentActions = showAccessStatus ? (
		<>
			{/* Who-else-is-here avatars: first in the cluster with their own
			 *  divider (the Google-Docs arrangement: people, then actions).
			 *  Shown for editors AND viewers (a viewer still sees who's
			 *  editing); renders nothing in a solo session. */}
			{showToolbar ? <PresenceRoster compact={compactHeader} /> : null}
			<BuilderAccessStatus compact={compactHeader} />
			{/* Keep the autosave owner mounted through reversible access
			 * transitions; only its visual output is conditional internally. */}
			<SaveIndicator compact={compactHeader} />
			{/* Edit affordances: hidden for a view-only member. Preview +
			 *  Publish stay (a viewer may preview and download the app);
			 *  HQ upload inside Publish stays gated server-side. */}
			{showToolbar && canEdit ? (
				compactHeader ? (
					<DropdownMenu>
						<SimpleTooltip content="Edit history" side="bottom">
							<DropdownMenuTrigger
								aria-label="Edit history"
								className="nova-focusable flex size-11 items-center justify-center rounded-xl text-nova-text-muted outline-none transition-colors hover:bg-white/5 hover:text-nova-text"
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
								<Icon icon={tablerArrowForwardUp} width="18" height="18" />
								<span className="flex-1">Redo</span>
								<span className="text-xs text-nova-text-muted">
									{shortcutLabel("mod", "shift", "Z")}
								</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					<>
						<SimpleTooltip content={`Undo (${shortcutLabel("mod", "Z")})`}>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={undo}
								disabled={!canUndo}
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
								size="icon"
								onClick={redo}
								disabled={!canRedo}
								aria-label="Redo"
							>
								<Icon icon={tablerArrowForwardUp} width="18" height="18" />
							</Button>
						</SimpleTooltip>
					</>
				)
			) : null}
			{showToolbar ? (
				<PublishPanel
					commcareConfigured={commcareConfigured}
					commcareAvailableDomains={commcareAvailableDomains}
				/>
			) : null}
		</>
	) : null;

	const banner = impersonating ? (
		<ImpersonationBanner
			userName={impersonating.userName}
			userEmail={impersonating.userEmail}
		/>
	) : null;

	return (
		<AppHeader
			homeLabel="Back to your apps"
			markOnly={!beforeAnyApp}
			start={banner}
			center={
				showToolbar ? (
					<div className="flex min-w-0 items-center gap-1">
						<PreviewToggle onSetPreviewing={onSetPreviewing} />
						{/* Sits beside the toggle because it answers the question the
						 *  toggle raises: the app is running, as whom? It renders
						 *  nothing outside Preview. */}
						<PreviewIdentityMenu />
					</div>
				) : null
			}
			actions={documentActions}
			account={showAccount ? <AccountMenu /> : null}
			/* Below 560px the band cannot hold the mark, Preview, the document
			 * tools, and the account control at their real sizes, and nothing here
			 * shrinks. Only ask for the extra rows when something would actually
			 * stand in them. */
			stacked={ultraCompactHeader && (showDocumentRow || banner !== null)}
		/>
	);
}
