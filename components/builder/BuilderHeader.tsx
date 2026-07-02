/**
 * BuilderHeader — the builder's one chrome row, replacing the site's
 * AppHeader inside `/build/*` (see `(site)/layout.tsx` for the split).
 *
 * Three-column grid: logo (the exit back to the app list) on the left,
 * the Preview toggle dead center, document tools + account on the
 * right. Preview is centered because reach matters more than corner
 * convention — the canvas is center-aligned, so the toggle sits
 * directly above the user's work, one short travel away. Nothing can
 * collide with it: breadcrumbs live in the canvas column's own strip
 * (`BreadcrumbStrip`), where the sidebars bound their width.
 *
 * The logo + account render in every phase; the toolbar cluster and
 * the Preview toggle appear once a usable blueprint exists.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import Link from "next/link";
import { AppSettingsButton } from "@/components/builder/detail/appSettings/AppSettingsButton";
import { ExportPanel } from "@/components/builder/ExportPanel";
import { PresenceRoster } from "@/components/builder/PresenceRoster";
import { PreviewToggle } from "@/components/builder/PreviewToggle";
import { SaveIndicator } from "@/components/builder/SaveIndicator";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { ImpersonationBanner } from "@/components/ui/ImpersonationBanner";
import { Logo } from "@/components/ui/Logo";
import { Tooltip } from "@/components/ui/Tooltip";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useCanRedo, useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import { shortcutLabel } from "@/lib/platform";
import { useUndoRedo } from "@/lib/routing/builderActions";
import { useBuilderIsReady, useCanEdit } from "@/lib/session/hooks";

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

	/* Undo/redo from doc temporal. Availability folds into stable
	 * booleans so the header only re-renders when it actually flips. */
	const { undo, redo } = useUndoRedo();
	const canUndo = useCanUndo();
	const canRedo = useCanRedo();

	const showToolbar = isReady && hasData;

	return (
		<header className="grid grid-cols-[1fr_auto_1fr] items-center px-4 h-14 border-b border-nova-border shrink-0 bg-nova-void">
			<div className="flex items-center gap-4 min-w-0">
				<Link
					href="/"
					className="rounded-lg focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
				>
					<Logo size="sm" />
				</Link>
				{impersonating && (
					<ImpersonationBanner
						userName={impersonating.userName}
						userEmail={impersonating.userEmail}
					/>
				)}
			</div>
			<div className="justify-self-center">
				{showToolbar && <PreviewToggle onSetPreviewing={onSetPreviewing} />}
			</div>
			<div className="flex items-center gap-1 justify-self-end">
				{showToolbar && (
					<>
						{/* Edit affordances — hidden for a view-only member. Preview +
						 *  Export stay (a viewer may preview and download the app);
						 *  HQ upload inside Export stays gated server-side. */}
						{canEdit ? (
							<>
								<SaveIndicator />
								<AppSettingsButton />
								<Tooltip content={`Undo (${shortcutLabel("mod", "Z")})`}>
									<button
										type="button"
										onClick={undo}
										disabled={!canUndo}
										className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-40 disabled:cursor-default"
										aria-label="Undo"
									>
										<Icon icon={tablerArrowBackUp} width="18" height="18" />
									</button>
								</Tooltip>
								<Tooltip
									content={`Redo (${shortcutLabel("mod", "shift", "Z")})`}
								>
									<button
										type="button"
										onClick={redo}
										disabled={!canRedo}
										className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-40 disabled:cursor-default"
										aria-label="Redo"
									>
										<Icon icon={tablerArrowForwardUp} width="18" height="18" />
									</button>
								</Tooltip>
							</>
						) : (
							<span className="mr-1 inline-flex items-center rounded-md border border-nova-border px-2 py-1 text-xs font-medium text-nova-text-muted">
								View only
							</span>
						)}
						<ExportPanel
							commcareConfigured={commcareConfigured}
							commcareAvailableDomains={commcareAvailableDomains}
						/>
					</>
				)}
				{/* Who-else-is-here avatars — shown for editors AND viewers (a
				 *  viewer still sees who's editing), rendered only once a usable
				 *  blueprint exists. Renders nothing in a solo session. */}
				{showToolbar && (
					<div className="mx-1">
						<PresenceRoster />
					</div>
				)}
				<div className="ml-1">
					<AccountMenu />
				</div>
			</div>
		</header>
	);
}
