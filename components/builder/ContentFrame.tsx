/**
 * ContentFrame — the shared centered content frame for canvas surfaces
 * (breadcrumb strip, workspace tab strip, edit canvases, preview
 * screens), plus the mode-flip glide that keeps every frame moving in
 * lockstep with the sliding sidebars when Preview toggles.
 *
 * ## Why a coordinated glide instead of letting layout re-center
 *
 * Max-width-centered content cannot track a sliding sidebar edge
 * through layout alone: while the canvas column is wider than the
 * frame's max width, `mx-auto` pins the frame to the column's center,
 * and only once the column crosses under the max width does the frame
 * start to move — so during a width tween the frame sits still and then
 * does all its travel in the tail (the "knee"), visibly lagging the
 * sidebars. The structural fix: a mode flip commits the final layout in
 * ONE render (the sidebars leave/enter the flex flow instantly), and
 * everything that visually travels does so via transforms sharing
 * `SIDEBAR_TRANSITION` — the sidebars slide with `x`, and each frame
 * glides from its old position to its new one. Lockstep by
 * construction, not by hoping two animation systems agree.
 *
 * ## Why the glide is computed, not measured per frame
 *
 * The flip also SWAPS canvas content (workspace ↔ running app via
 * `<Activity>`), so an entering frame has no "before" box to FLIP from —
 * yet it must start exactly where the outgoing surface (and the
 * breadcrumb strip above it) sit, or left edges shear mid-glide. Frame
 * position is a closed-form function of the column box:
 * `left = columnCenter − min(columnWidth, maxWidth) / 2`, exact in both
 * the clipped and the centered regime. The provider publishes the
 * column geometry before/after the flip, and every frame derives its
 * own delta from its max width — entering, exiting, and persistent
 * frames all agree by construction.
 */
"use client";
import { animate, motion, useMotionValue } from "motion/react";
import {
	createContext,
	type ReactNode,
	type Ref,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";

/** The one transition driving mode-flip choreography AND manual sidebar
 *  toggles — sidebar slides, the chat panel, and frame glides all share
 *  it so the pieces can never drift apart. */
export const SIDEBAR_TRANSITION = {
	duration: 0.2,
	ease: [0.4, 0, 0.2, 1],
} as const;

/** Frame width variants. Pixel values mirror the Tailwind max-w scale —
 *  the glide math needs the frame's max width as a number. */
const FRAME_WIDTHS = {
	"5xl": { className: "max-w-5xl", px: 1024 },
	"3xl": { className: "max-w-3xl", px: 768 },
	lg: { className: "max-w-lg", px: 512 },
	md: { className: "max-w-md", px: 448 },
} as const;

export type ContentFrameWidth = keyof typeof FRAME_WIDTHS;

interface FlipGlide {
	/** Increments once per preview-mode flip; 0 = no flip yet. */
	seq: number;
	/** Horizontal travel for a frame of the given max width: old layout
	 *  position minus new, in px. */
	deltaFor: (maxWidthPx: number) => number;
}

/** Default = inert: frames rendered outside the builder row (tests,
 *  dev pages) simply never glide. */
const ModeFlipGlideContext = createContext<FlipGlide>({
	seq: 0,
	deltaFor: () => 0,
});

interface ModeFlipGlideProviderProps {
	previewing: boolean;
	/** Layout width currently occupied left of the canvas column. */
	leftWidth: number;
	/** Layout width currently occupied right of the canvas column. */
	rightWidth: number;
	/** The flex row bounding the columns — its width feeds the geometry. */
	rowRef: RefObject<HTMLDivElement | null>;
	children: ReactNode;
}

export function ModeFlipGlideProvider({
	previewing,
	leftWidth,
	rightWidth,
	rowRef,
	children,
}: ModeFlipGlideProviderProps) {
	/* Last-committed flank widths — the "before" side of the flip math.
	 * Updated in an effect so the flip render still reads pre-flip values. */
	const prevLeftRef = useRef(leftWidth);
	const prevRightRef = useRef(rightWidth);
	useEffect(() => {
		prevLeftRef.current = leftWidth;
		prevRightRef.current = rightWidth;
	});

	/* Detect the flip during render so the new context value reaches the
	 * frames in the same commit as the layout change (their layout
	 * effects fire before paint — no flash of the un-glided position).
	 * Render-time ref writes are idempotent per committed value, the same
	 * pattern PreviewShell uses for its screen-identity refs. */
	const lastPreviewingRef = useRef(previewing);
	const seqRef = useRef(0);
	const geometryRef = useRef<{
		widthBefore: number;
		centerBefore: number;
		widthAfter: number;
		centerAfter: number;
	} | null>(null);
	if (previewing !== lastPreviewingRef.current) {
		lastPreviewingRef.current = previewing;
		/* The row's own width is unchanged by the flip, so reading the
		 * pre-flip DOM here is exact for the post-flip geometry too. */
		const rowWidth = rowRef.current?.clientWidth ?? 0;
		if (rowWidth > 0) {
			const widthBefore = rowWidth - prevLeftRef.current - prevRightRef.current;
			const widthAfter = rowWidth - leftWidth - rightWidth;
			geometryRef.current = {
				widthBefore,
				centerBefore: prevLeftRef.current + widthBefore / 2,
				widthAfter,
				centerAfter: leftWidth + widthAfter / 2,
			};
			seqRef.current += 1;
		}
	}

	const deltaFor = useCallback((maxWidthPx: number) => {
		const g = geometryRef.current;
		if (!g) return 0;
		const before = g.centerBefore - Math.min(g.widthBefore, maxWidthPx) / 2;
		const after = g.centerAfter - Math.min(g.widthAfter, maxWidthPx) / 2;
		return before - after;
	}, []);

	const seq = seqRef.current;
	const value = useMemo(() => ({ seq, deltaFor }), [seq, deltaFor]);
	return (
		<ModeFlipGlideContext.Provider value={value}>
			{children}
		</ModeFlipGlideContext.Provider>
	);
}

interface ContentFrameProps {
	width: ContentFrameWidth;
	className?: string;
	children?: ReactNode;
	ref?: Ref<HTMLDivElement>;
}

export function ContentFrame({
	width,
	className,
	children,
	ref,
}: ContentFrameProps) {
	const { seq, deltaFor } = useContext(ModeFlipGlideContext);
	const x = useMotionValue(0);
	const elRef = useRef<HTMLDivElement | null>(null);
	const lastSeqRef = useRef(seq);

	useLayoutEffect(() => {
		if (seq !== lastSeqRef.current) {
			lastSeqRef.current = seq;
			const el = elRef.current;
			/* Frames inside a hidden <Activity> re-render with the new seq
			 * too; skip the offset for them. Consuming seq while hidden means
			 * a later reveal (navigation) can never glide from stale
			 * geometry. */
			if (el && el.offsetParent !== null) {
				const delta = deltaFor(FRAME_WIDTHS[width].px);
				/* Accumulate onto the current value so a flip that interrupts
				 * an in-flight glide stays visually continuous instead of
				 * jumping. */
				if (Math.abs(delta) >= 0.5) x.set(x.get() + delta);
			}
		}
		/* Settle as a separate, idempotent step — `animate` retargets any
		 * running glide to the same destination, so re-invocation (dev
		 * StrictMode replay, Activity-reveal effect re-creation) is
		 * harmless. There is deliberately NO stop() cleanup: an effect
		 * cleanup fires between StrictMode's double invokes and on Activity
		 * hide, either of which would freeze the frame mid-glide; an
		 * orphaned value tween just settles to 0 within the transition. */
		if (x.get() !== 0) animate(x, 0, SIDEBAR_TRANSITION);
	}, [seq, deltaFor, width, x]);

	const setRefs = (node: HTMLDivElement | null) => {
		elRef.current = node;
		if (typeof ref === "function") ref(node);
		else if (ref) ref.current = node;
	};

	return (
		<motion.div
			ref={setRefs}
			style={{ x }}
			className={`mx-auto w-full ${FRAME_WIDTHS[width].className}${className ? ` ${className}` : ""}`}
		>
			{children}
		</motion.div>
	);
}
