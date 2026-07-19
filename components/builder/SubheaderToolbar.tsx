"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import {
	Fragment,
	memo,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";

/** A breadcrumb segment with a label, stable identity key, and navigation callback. */
export interface BreadcrumbPart {
	/** Stable identity derived from the underlying PreviewScreen (e.g. "home", "module-0").
	 *  Labels aren't unique — "App > Intake > Intake" is valid — so we need a
	 *  semantic key from the navigation hierarchy. */
	key: string;
	label: string;
	onClick: () => void;
}

/** Chevron separator rendered between breadcrumb segments. */
/** Chevron at full `text-nova-text-muted` (~2.9:1 on dark backgrounds) instead of
 *  the previous /50 variant (1.5:1). The chevron is a supplementary visual separator —
 *  hierarchy is conveyed by the text labels themselves — so near-3:1 is acceptable. */
const Chevron = (
	<Icon
		icon={tablerChevronRight}
		width="14"
		height="14"
		className="text-nova-text-muted shrink-0"
	/>
);

/** Shared base styles for all segments. Both ancestor and current use font-medium
 *  so the rendered text width stays constant when a segment transitions between
 *  states — preventing content shift from font-weight changes.
 *  `min-h-[44px]` ensures WCAG 2.5.8 minimum target size compliance. */
const SEGMENT_BASE =
	"h-auto min-h-11 rounded-lg px-0 text-lg font-medium flex items-center";

/** Ancestor segment — muted text, clickable to navigate up. */
const ANCESTOR_CLASS = `${SEGMENT_BASE} shrink-0 whitespace-nowrap text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer`;

/** Current segment — bright text, non-interactive. It owns the flexible slot
 * and truncates before it can paint underneath contextual actions at the end
 * of the strip (Case data, presence, etc.). */
const CURRENT_CLASS = `${SEGMENT_BASE} min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-nova-text cursor-default`;

/** Current-location text is ordinarily inert. It becomes a keyboard-accessible
 * tooltip trigger only when the bar actually clips it; a static breadcrumb that
 * already fits should not add a mystery stop to the tab order. */
function CurrentBreadcrumbSegment({ label }: { label: string }) {
	const [clipped, setClipped] = useState(false);
	const elementRef = useRef<HTMLSpanElement | null>(null);

	const measure = useCallback(() => {
		const element = elementRef.current;
		if (element === null) return;
		const hasLayout = element.clientWidth > 0 || element.scrollWidth > 0;
		setClipped(hasLayout && element.scrollWidth > element.clientWidth + 1);
	}, []);

	const setElementRef = useCallback(
		(element: HTMLSpanElement | null) => {
			elementRef.current = element;
			if (element === null) return;
			const observer = new ResizeObserver(measure);
			observer.observe(element);
			measure();
			return () => observer.disconnect();
		},
		[measure],
	);

	// A label edit can change scrollWidth without changing the element's border
	// box, which ResizeObserver does not promise to report. Measure after every
	// render; identical results are ignored by React's state setter.
	useLayoutEffect(() => {
		measure();
	});

	return (
		<Tooltip disabled={!clipped}>
			<TooltipTrigger
				disabled={!clipped}
				render={
					<span
						ref={setElementRef}
						aria-current="location"
						className={CURRENT_CLASS}
						// When clipped, focus opens the same full-text disclosure
						// available on pointer hover. When it fits, the current
						// location remains inert.
						tabIndex={clipped ? 0 : undefined}
					/>
				}
			>
				{label}
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Deep equality check for BreadcrumbPart arrays. Compares labels by value
 * and onClick by reference, so the component only re-renders when the visible
 * breadcrumb text changes (e.g. inline title edit) or the navigation structure
 * changes (different handler references from a new breadcrumbPath).
 */
interface CollapsibleBreadcrumbProps {
	readonly parts: BreadcrumbPart[];
	/** The handset case-workspace already names the active screen in its fixed
	 * tab strip. Preserve ancestor navigation in one touch-safe path menu there,
	 * but do not spend the remaining header width repeating and clipping the
	 * active tab label beside Case data. */
	readonly compactWorkspace?: boolean;
}

function breadcrumbPartsEqual(
	prev: CollapsibleBreadcrumbProps,
	next: CollapsibleBreadcrumbProps,
): boolean {
	if (prev.compactWorkspace !== next.compactWorkspace) return false;
	const a = prev.parts,
		b = next.parts;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (
			a[i].key !== b[i].key ||
			a[i].label !== b[i].label ||
			a[i].onClick !== b[i].onClick
		)
			return false;
	}
	return true;
}

function BreadcrumbPathMenu({
	parts,
	open,
	onOpenChange,
}: {
	readonly parts: readonly BreadcrumbPart[];
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger
				render={<Button variant="ghost" size="icon-lg" />}
				aria-label="Show breadcrumb path"
				className="size-11 shrink-0 text-nova-text-muted hover:text-nova-text"
			>
				&hellip;
			</PopoverTrigger>
			<PopoverContent
				side="bottom"
				align="start"
				sideOffset={4}
				className="w-auto min-w-[180px] max-w-[280px] gap-0 overflow-hidden p-1"
			>
				{parts.map((part) => (
					<Button
						key={part.key}
						type="button"
						variant="ghost"
						onClick={() => {
							part.onClick();
							onOpenChange(false);
						}}
						className="h-auto min-h-11 w-full justify-start rounded-lg px-3 py-2 text-left text-sm text-nova-text-muted hover:text-nova-text"
					>
						<span className="min-w-0 flex-1 break-words whitespace-normal">
							{part.label}
						</span>
					</Button>
				))}
			</PopoverContent>
		</Popover>
	);
}

/**
 * Navigable breadcrumb trail for the builder subheader.
 *
 * Uses a single, stable DOM structure via `.map()` over all parts. Ancestors are
 * navigation buttons; the current location is an inert `span` with
 * `aria-current`, so keyboard users never land on a control that cannot act.
 * Adding a new depth level only appends elements; existing elements update in
 * place.
 *
 * **Collapse is overflow-driven, not a fixed depth.** The trail expands to use
 * all the room its bar gives it and folds ancestors behind an ellipsis ONLY
 * when the full trail can't physically fit — so a short trail on a wide bar
 * always shows in full (the prior `depth > 3` rule folded eagerly once the
 * strip moved to its own full-width bar). Overflow is measured against an inert
 * mirror that always renders every segment, so the reading is independent of
 * the current collapsed state and the fold can't oscillate. When space is
 * scarce, the current location keeps priority; Home and intermediate segments
 * move into one labelled path menu instead of squeezing the current label away.
 *
 * Wrapped in `memo` with deep part comparison to skip re-renders from unrelated
 * BuilderLayout state changes (chat messages, selection, etc.).
 */
export const CollapsibleBreadcrumb = memo(function CollapsibleBreadcrumb({
	parts,
	compactWorkspace = false,
}: CollapsibleBreadcrumbProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const mirrorRef = useRef<HTMLDivElement | null>(null);

	/* Compare the natural (fully-expanded) trail width — read off the inert
	 * mirror, which always renders every segment — against the width actually
	 * available. Reading the mirror, not the live trail, is what keeps the fold
	 * from oscillating: collapsing shrinks the live trail, which would otherwise
	 * read as "fits" and immediately re-expand. */
	const measure = useCallback(() => {
		const avail = wrapperRef.current?.clientWidth ?? 0;
		const natural = mirrorRef.current?.scrollWidth ?? 0;
		/* Meaningful only once laid out (both > 0 — happy-dom/SSR report 0 and
		 * stay expanded); a 1px tolerance absorbs sub-pixel rounding so a trail
		 * that exactly fits doesn't fold. */
		setCollapsed(natural > 0 && avail > 0 && natural > avail + 1);
	}, []);

	/* Observer setup lives in the ref callback (React 19 ref cleanup), per the
	 * components convention — not a useEffect. */
	const setWrapperRef = useCallback(
		(el: HTMLDivElement | null) => {
			wrapperRef.current = el;
			if (!el) return;
			const ro = new ResizeObserver(() => measure());
			ro.observe(el);
			measure();
			return () => ro.disconnect();
		},
		[measure],
	);

	/* Re-measure when the trail's text/structure changes — the ResizeObserver
	 * fires on bar-width changes, not on a relabel (e.g. an inline title edit)
	 * that shifts the natural width while the bar stays the same size. */
	const sig = JSON.stringify(parts.map(({ key, label }) => [key, label]));
	// biome-ignore lint/correctness/useExhaustiveDependencies: `sig` is the intended re-measure trigger; `measure` is stable.
	useLayoutEffect(() => {
		measure();
	}, [sig]);

	if (parts.length === 0) return null;

	/* On genuine overflow, keep the current location visible and move every
	 * ancestor into one compact path menu. */
	const needsCollapse = collapsed && parts.length > 1;
	const collapsedAncestors = needsCollapse ? parts.slice(0, -1) : [];
	const compactAncestors = compactWorkspace ? parts.slice(0, -1) : [];

	/* Search, Results, and Details are already the fixed workspace tabs at this
	 * width. Repeating the current tab in this 60–64px bar produced hard-clipped
	 * words beside the intentionally stable Case data action. Keep the hierarchy
	 * available through one 44px path menu, and let the tabs own current-location
	 * semantics. Other builder screens retain their full current breadcrumb. */
	if (compactWorkspace) {
		return compactAncestors.length > 0 ? (
			<div className="relative min-w-0 flex-1">
				<div
					data-breadcrumb-trail
					data-compact-workspace-breadcrumb
					className="flex min-w-0 items-center"
				>
					<BreadcrumbPathMenu
						parts={compactAncestors}
						open={menuOpen}
						onOpenChange={setMenuOpen}
					/>
				</div>
			</div>
		) : null;
	}

	return (
		<div ref={setWrapperRef} className="relative min-w-0 flex-1">
			<div
				data-breadcrumb-trail
				className="flex items-center gap-1 text-lg min-w-0 overflow-hidden"
			>
				{parts.map((part, i) => {
					const isLast = i === parts.length - 1;

					/* ── Collapsed ancestors: one path menu, then the current item ── */
					if (needsCollapse && !isLast) {
						if (i !== 0) return null;
						return (
							<Fragment key="collapse">
								<BreadcrumbPathMenu
									parts={collapsedAncestors}
									open={menuOpen}
									onOpenChange={setMenuOpen}
								/>
							</Fragment>
						);
					}

					/* ── Standard segment: chevron + ancestor control/current text ── */
					return (
						<Fragment key={part.key}>
							{i > 0 && Chevron}
							{isLast ? (
								<CurrentBreadcrumbSegment label={part.label} />
							) : (
								<Button
									type="button"
									variant="ghost"
									onClick={part.onClick}
									className={ANCESTOR_CLASS}
								>
									{part.label}
								</Button>
							)}
						</Fragment>
					);
				})}
			</div>
			{/* Inert width probe: the full trail, laid out but invisible and
			 *  un-clickable, so `measure` always reads the natural (uncollapsed)
			 *  width regardless of what the live trail above is showing. aria-hidden
			 *  keeps it out of the a11y tree (the live group above is labelled). */}
			<div
				ref={mirrorRef}
				aria-hidden="true"
				className="absolute left-0 top-0 flex items-center gap-1 text-lg whitespace-nowrap invisible pointer-events-none"
			>
				{parts.map((part, i) => (
					<Fragment key={part.key}>
						{i > 0 && Chevron}
						<span className="font-medium whitespace-nowrap">{part.label}</span>
					</Fragment>
				))}
			</div>
		</div>
	);
}, breadcrumbPartsEqual);
