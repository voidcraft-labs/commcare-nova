/**
 * General-purpose FloatingUI tooltip for the Nova design system.
 *
 * Replaces all native `title` attributes with a styled, themed tooltip that
 * renders via portal, positions automatically with flip/shift middleware, and
 * matches the dark violet monochrome palette.
 *
 * Uses `cloneElement` + `useMergeRefs` to attach the FloatingUI reference ref
 * and interaction event handlers directly onto the child element — no wrapper
 * `<span>`, no layout interference. This is critical: a wrapper element breaks
 * flex layouts (e.g. `w-full` buttons inside DropdownMenu) and can collapse to
 * zero dimensions in certain contexts, causing FloatingUI to position at (0,0).
 *
 * The child must be a single React element that accepts a `ref`. Primitive
 * children (strings, numbers) are wrapped in an `inline-flex` `<span>` as a
 * fallback, but all current call sites pass elements.
 *
 * ```tsx
 * <Tooltip content="Undo (⌘Z)">
 *   <button aria-label="Undo">...</button>
 * </Tooltip>
 * ```
 *
 * Renders nothing extra when `content` is falsy — the child passes through
 * with no modification, so conditional tooltips don't need ternaries at the
 * call site.
 */

"use client";

import {
	autoUpdate,
	FloatingPortal,
	flip,
	offset,
	type Placement,
	shift,
	useDismiss,
	useFloating,
	useFocus,
	useHover,
	useInteractions,
	useMergeRefs,
	useRole,
	useTransitionStyles,
} from "@floating-ui/react";
import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
	type Ref,
	useState,
} from "react";

/* Static middleware — hoisted to module scope so 100+ tooltip instances
 * share the same array reference instead of allocating per render. */
const MIDDLEWARE = [
	offset(6),
	flip({ fallbackAxisSideDirection: "start", padding: 8 }),
	shift({ padding: 8 }),
];

interface TooltipProps {
	/** Tooltip text or rich content. When falsy, the child renders unmodified. */
	content: ReactNode;
	/** FloatingUI placement — defaults to `"top"`. */
	placement?: Placement;
	/** Hover delay in ms before the tooltip appears. 400ms balances
	 *  discoverability with not triggering on casual mouse traversal. */
	delay?: number;
	/** Tooltip trigger content. Must be a single React element that accepts a
	 *  ref (DOM element, forwardRef component, or React 19 component with ref
	 *  prop). Refs and interaction handlers are merged non-destructively via
	 *  `cloneElement` + `useMergeRefs`. */
	children: ReactNode;
}

/**
 * Themed floating tooltip — dark frosted surface with Nova typography.
 *
 * Positioning uses `offset(6)` for comfortable visual separation, `flip` to
 * avoid viewport clipping, and `shift` with 8px padding for edge safety.
 * The entrance animation is a subtle 100ms scale-up + fade matching the
 * app's popover motion language.
 */
export function Tooltip({
	content,
	placement = "top",
	delay = 400,
	children,
}: TooltipProps) {
	/* Passthrough when there's nothing to show — child renders unmodified,
	 * no hooks allocated. Callers can always render <Tooltip content={maybeFalsy}>
	 * without branching. */
	if (!content) return children;

	return (
		<TooltipInner content={content} placement={placement} delay={delay}>
			{children}
		</TooltipInner>
	);
}

/**
 * Inner implementation extracted so the early-return passthrough in the
 * outer `Tooltip` doesn't violate rules of hooks (hooks can't be called
 * conditionally). All FloatingUI hooks live here, called unconditionally.
 */
function TooltipInner({
	content,
	placement,
	delay,
	children,
}: Required<Pick<TooltipProps, "content" | "placement" | "delay">> &
	Pick<TooltipProps, "children">) {
	const [open, setOpen] = useState(false);

	const { refs, floatingStyles, context } = useFloating({
		placement,
		open,
		onOpenChange: setOpen,
		whileElementsMounted: autoUpdate,
		/* Disable transform-based positioning so `floatingStyles` uses `top`/`left`
		 * instead of `transform: translate()`. This prevents a CSS property collision
		 * with `useTransitionStyles`, which sets `transform: scale()` for the entrance
		 * animation — a second `transform` value would overwrite the positioning. */
		transform: false,
		middleware: MIDDLEWARE,
	});

	const hover = useHover(context, {
		move: false,
		delay: { open: delay, close: 0 },
	});
	const focus = useFocus(context);
	const dismiss = useDismiss(context);
	const role = useRole(context, { role: "tooltip" });

	const { getReferenceProps, getFloatingProps } = useInteractions([
		hover,
		focus,
		dismiss,
		role,
	]);

	/* Subtle scale-up + fade entrance matching the app's popover motion. */
	const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
		duration: 100,
		initial: { opacity: 0, transform: "scale(0.96)" },
		open: { opacity: 1, transform: "scale(1)" },
	});

	/* Merge FloatingUI's reference ref with the child's existing ref so both
	 * the tooltip positioning system and any parent ref (e.g. a forwardRef
	 * component that also needs the DOM node) receive the element. In React 19,
	 * refs are regular props accessed via `children.props.ref`. */
	const childRef: Ref<HTMLElement> | undefined = isValidElement(children)
		? (children as ReactElement<{ ref?: Ref<HTMLElement> }>).props.ref
		: undefined;
	const mergedRef = useMergeRefs([refs.setReference, childRef]);

	/* Build the trigger element. For React elements (the normal case), we
	 * clone the child and merge in the FloatingUI ref + interaction handlers.
	 * This avoids a wrapper element that would break flex layouts and distort
	 * FloatingUI's reference measurements.
	 *
	 * For primitive children (string, number — not used in practice), fall back
	 * to a minimal inline-flex span wrapper. */
	const trigger = isValidElement(children) ? (
		cloneElement(
			children as ReactElement<Record<string, unknown>>,
			getReferenceProps({
				/* Spread child props first so getReferenceProps can merge its
				 * interaction handlers (onMouseEnter, onFocus, etc.) with any
				 * handlers the child already has.
				 *
				 * `ref: mergedRef` MUST come after the spread — in React 19 `ref`
				 * is a regular prop on `element.props`, so the spread would
				 * overwrite our merged ref with the child's original ref. */
				...(children.props as Record<string, unknown>),
				ref: mergedRef,
			}),
		)
	) : (
		<span
			ref={refs.setReference}
			{...getReferenceProps()}
			className="inline-flex"
		>
			{children}
		</span>
	);

	return (
		<>
			{trigger}
			{isMounted && (
				<FloatingPortal>
					<div
						ref={refs.setFloating}
						style={{ ...floatingStyles, ...transitionStyles }}
						{...getFloatingProps()}
						className="z-tooltip max-w-xs px-2.5 py-1.5 rounded-lg bg-[rgba(20,20,44,0.95)] border border-white/[0.08] shadow-[0_4px_12px_rgba(0,0,0,0.4)] text-xs font-medium text-nova-text leading-snug pointer-events-none select-none"
					>
						{content}
					</div>
				</FloatingPortal>
			)}
		</>
	);
}
