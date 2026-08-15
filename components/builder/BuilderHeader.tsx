/**
 * What the shared header holds inside `/build/*`.
 *
 * This component renders no header. The band is mounted once, above both route
 * groups (`components/ui/AppChrome`), precisely so that crossing between the
 * app list and the builder cannot rebuild it — and these controls cannot go up
 * there with it, because Preview, undo/redo, the save indicator, and Publish
 * all read the doc and session stores that live under `BuilderProvider`. So
 * they stay in the builder's tree, where the stores reach them, and portal
 * into the band's own cells. What this file emits in place is nothing at all.
 *
 * It also CLAIMS the band, which is what makes the site's nav, Project
 * switcher, and Help step aside for as long as the builder is on screen.
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
 * intentionally quarantined. That now includes the account control, which the
 * band owns: the claim carries permission to show it. The mark is never one of
 * them — it renders in every phase.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BuilderAccessStatus } from "@/components/builder/AccessStatus";
import { LanguageSelector } from "@/components/builder/localization/LanguageSelector";
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
import {
	HEADER_HANDOFF_DELAY,
	HeaderCluster,
} from "@/components/ui/headerMotion";
import { useHeaderSlots } from "@/components/ui/headerSlots";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useCanRedo, useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import { shortcutLabel } from "@/lib/platform";
import { useUndoRedo } from "@/lib/routing/builderActions";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	useAccessPhase,
	useAppId,
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
}

export function BuilderHeader({
	commcareConfigured,
	commcareAvailableDomains,
	onSetPreviewing,
}: BuilderHeaderProps) {
	const slots = useHeaderSlots();
	const appId = useAppId();
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

	/* No app yet: `/build/new` with nothing sent. BOTH halves are load-bearing.
	 * `phase` keeps the band in lockstep with the chat's centred-to-docked
	 * morph, which is driven by the same value, so the two never desync. And
	 * `appId` excludes an EXISTING app whose blueprint happens to be empty — a
	 * build interrupted before its first module lands reads as Idle, and
	 * without this it would wear the site's menus inside a real build. */
	const beforeAnyApp = phase === BuilderPhase.Idle && appId === undefined;

	/* Whether this page was already a build when it mounted, captured once.
	 * A collapse is only a handoff when it is a build STARTING; a page that
	 * opened with an app never had the word to draw in. */
	const openedWithApp = useRef(!beforeAnyApp);

	/* Below 560px the band cannot hold the mark, Preview, the document tools,
	 * and the account control at their real sizes, and nothing here shrinks.
	 * Only ask for the extra row when something would actually stand in it. */
	const stacked = ultraCompactHeader && showDocumentRow;

	/* Take the band for as long as there is an app, and hand it back on the way
	 * out. The claim is compared by value up there, so rebuilding it every
	 * render costs nothing.
	 *
	 * `/build/new` before a send claims NOTHING, and that is the point: no app
	 * exists yet, so the screen is still the site with a composer on it, and
	 * the nav, the Project switcher, and Help all still belong. Taking them
	 * away the moment someone opens the page would make a screen they have not
	 * committed to anything on feel like somewhere they cannot leave. The
	 * handoff belongs to the app landing, where everything moves at once. */
	const claim = slots?.claim;
	useEffect(() => {
		if (beforeAnyApp) {
			claim?.(null);
			return;
		}
		claim?.({
			homeLabel: "Back to your apps",
			markOnly: true,
			stacked,
			showAccount: accessPhase === "authorized",
			/* `canManageFiles` is deliberately absent. `MediaPickerDialog`
			 * resolves `canWriteOverride ?? sessionCanEdit` and its own prop doc
			 * says to omit it inside the builder so the live session capability
			 * stays authoritative — an explicit `false` is not "unspecified",
			 * it is a hard read-only that takes upload and delete away from an
			 * editor who had them. */
			handoff: !openedWithApp.current,
		});
	}, [claim, beforeAnyApp, stacked, accessPhase]);
	useEffect(() => () => claim?.(null), [claim]);

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

	/* Both clusters ARRIVE rather than appear, waiting out the beat the site's
	 * menus take to leave. On `/build/new` there is nothing to show yet, so the
	 * arrival that matters is the one an app landing triggers: the same moment
	 * the wordmark is drawn into the sphere. Tools appearing in a single frame
	 * under an animating mark is what makes the mark look like the only thing
	 * that noticed.
	 *
	 * No `AnimatePresence`, so there is no exit. These go when app access stops
	 * being resolved, and a control mid-fade is still visible and still takes a
	 * click — which is the whole point of unmounting them. Leaving the builder
	 * unmounts this tree anyway, so there would be nothing left to animate. */
	const center = showToolbar ? (
		<HeaderCluster
			delay={HEADER_HANDOFF_DELAY}
			className="flex min-w-0 items-center gap-1"
		>
			<PreviewToggle onSetPreviewing={onSetPreviewing} />
			<LanguageSelector />
			{/* Sits beside the toggle because it answers the question the
			 *  toggle raises: the app is running, as whom? It renders
			 *  nothing outside Preview. */}
			<PreviewIdentityMenu />
		</HeaderCluster>
	) : null;

	/* One cluster element for the life of the builder once it appears: the save
	 * indicator inside it owns `useAutoSave`, so this must never be swapped for
	 * a sibling on a resize or an access transition. */
	const actions = documentActions ? (
		<HeaderCluster
			delay={HEADER_HANDOFF_DELAY}
			className="flex min-w-0 items-center gap-1"
		>
			{documentActions}
		</HeaderCluster>
	) : null;

	/* The elements live here, in the tree that can read the builder's stores;
	 * only their DOM lands in the band. Nothing renders in place. */
	return (
		<>
			{slots?.center ? createPortal(center, slots.center) : null}
			{slots?.actions ? createPortal(actions, slots.actions) : null}
		</>
	);
}
