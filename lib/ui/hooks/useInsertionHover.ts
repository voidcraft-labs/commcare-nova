// lib/ui/hooks/useInsertionHover.ts
//
// The shared "open only after the cursor slows" reveal logic for insertion
// points — ONE implementation behind both the form canvas
// (components/preview/form/InsertionPoint) and the app tree
// (components/builder/appTree/insertion/*). Two pieces:
//
//   - useCursorSpeed(): one document-level pointer-velocity tracker (EMA over
//     mousemove + wheel). A surface mounts it once and shares the refs.
//   - useInsertionHover(): per-affordance gating — on mouse-enter it reveals
//     immediately if the cursor is already slow, otherwise polls until the EMA
//     drops below the threshold, so traversing PAST a gap doesn't pop it open.
//
// The two surfaces deliver the cursor refs differently (the form threads them
// as props from `useDragIntent`; the tree shares them via `CursorSpeedContext`),
// but the velocity algorithm and the reveal gating are identical here.

"use client";
import {
	createContext,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

/** Speed threshold in px/ms. Above this the cursor is traversing — don't open. */
const SPEED_THRESHOLD = 0.01;
/** How often (ms) to re-check speed while waiting for the cursor to slow. */
const POLL_INTERVAL = 16;
/** Per-tick decay applied to the EMA while the cursor is stationary. */
const POLL_DECAY = 0.15;
/** No-mousemove gap (ms) after which the cursor counts as stationary (~2 frames). */
const STALE_THRESHOLD = 32;
/** EMA factor for cursor speed — small, so one fast sample doesn't unlatch. */
const CURSOR_EMA_ALPHA = 0.01;
/** Gap (ms) beyond which the previous sample is stale and the EMA resets. */
const CURSOR_GAP_RESET_MS = 5000;

export interface CursorSpeedRefs {
	/** EMA-smoothed pointer speed in px/ms. */
	readonly cursorSpeedRef: RefObject<number>;
	/** Last pointer sample (position + timestamp), for the staleness check. */
	readonly lastCursorRef: RefObject<
		{ x: number; y: number; t: number } | undefined
	>;
}

/**
 * Mount once per surface: tracks EMA-smoothed pointer velocity off document
 * mousemove + wheel and returns the refs the insertion-point gating reads.
 */
export function useCursorSpeed(): CursorSpeedRefs {
	const cursorSpeedRef = useRef(0);
	const lastCursorRef = useRef<{ x: number; y: number; t: number } | undefined>(
		undefined,
	);
	useEffect(() => {
		const speedRef = cursorSpeedRef;
		const lastRef = lastCursorRef;
		const onMouseMove = (e: MouseEvent) => {
			const now = performance.now();
			const last = lastRef.current;
			if (last) {
				const dt = now - last.t;
				if (dt > 0) {
					const dx = e.clientX - last.x;
					const dy = e.clientY - last.y;
					const speed = Math.sqrt(dx * dx + dy * dy) / dt;
					speedRef.current =
						dt > CURSOR_GAP_RESET_MS
							? speed
							: CURSOR_EMA_ALPHA * speed +
								(1 - CURSOR_EMA_ALPHA) * speedRef.current;
				}
			}
			lastRef.current = { x: e.clientX, y: e.clientY, t: now };
		};
		const onWheel = (e: WheelEvent) => {
			const now = performance.now();
			const last = lastRef.current;
			if (last) {
				const dt = now - last.t;
				if (dt > 0) {
					const pxDelta = Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
					const speed = pxDelta / dt;
					speedRef.current =
						dt > CURSOR_GAP_RESET_MS
							? speed
							: CURSOR_EMA_ALPHA * speed +
								(1 - CURSOR_EMA_ALPHA) * speedRef.current;
				}
				last.t = now;
			}
		};
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("wheel", onWheel, { passive: true });
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("wheel", onWheel);
		};
	}, []);
	return { cursorSpeedRef, lastCursorRef };
}

/** Surface-wide cursor-speed refs for insertion points delivered via context
 *  (the app tree). Empty by default → gating degrades to an immediate reveal. */
const CursorSpeedContext = createContext<Partial<CursorSpeedRefs>>({});

export const CursorSpeedProvider = CursorSpeedContext.Provider;

export function useCursorSpeedContext(): Partial<CursorSpeedRefs> {
	return useContext(CursorSpeedContext);
}

interface InsertionHoverOpts {
	readonly cursorSpeedRef?: RefObject<number>;
	readonly lastCursorRef?: RefObject<
		{ x: number; y: number; t: number } | undefined
	>;
	/** Read on mouse-leave: when it returns true the affordance stays revealed
	 *  (its popup is open, so the pointer may be inside a portalled popup). */
	readonly keepOpen?: () => boolean;
}

export interface InsertionHover<T extends HTMLElement = HTMLDivElement> {
	/** Whether the affordance should be shown/expanded right now. */
	readonly revealed: boolean;
	/** Force reveal (e.g. the popup just opened). */
	readonly reveal: () => void;
	/** Collapse (e.g. the popup closed). */
	readonly reset: () => void;
	/** Attach to the affordance element — drives the mount-time cursor check. */
	readonly containerRef: RefObject<T | null>;
	readonly onMouseEnter: () => void;
	readonly onMouseMove: () => void;
	readonly onMouseLeave: () => void;
}

/**
 * Per-affordance reveal gating. Reveals on mouse-enter only once the cursor is
 * slow (EMA ≤ threshold); a fast cursor starts a poll that reveals when it
 * settles — so traversing past the gap never pops it open. Mirrors the form
 * canvas's original InsertionPoint behavior exactly.
 */
export function useInsertionHover<T extends HTMLElement = HTMLDivElement>({
	cursorSpeedRef,
	lastCursorRef,
	keepOpen,
}: InsertionHoverOpts): InsertionHover<T> {
	const [hovered, setHovered] = useState(false);
	const containerRef = useRef<T>(null);
	const pendingRef = useRef(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// Latest keepOpen in a ref so the leave handler stays referentially stable.
	const keepOpenRef = useRef(keepOpen);
	keepOpenRef.current = keepOpen;

	const clearPoll = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);
	useEffect(() => () => clearPoll(), [clearPoll]);

	const reveal = useCallback(() => {
		clearPoll();
		pendingRef.current = false;
		setHovered(true);
	}, [clearPoll]);

	const reset = useCallback(() => {
		clearPoll();
		pendingRef.current = false;
		setHovered(false);
	}, [clearPoll]);

	const startSpeedPoll = useCallback(() => {
		pendingRef.current = true;
		clearPoll();
		pollRef.current = setInterval(() => {
			// If the cursor hasn't moved in ~2 frames, decay the EMA toward 0.
			const lastT = lastCursorRef?.current?.t ?? 0;
			if (performance.now() - lastT > STALE_THRESHOLD) {
				if (cursorSpeedRef) cursorSpeedRef.current *= 1 - POLL_DECAY;
			}
			if ((cursorSpeedRef?.current ?? 0) <= SPEED_THRESHOLD) reveal();
		}, POLL_INTERVAL);
	}, [cursorSpeedRef, lastCursorRef, reveal, clearPoll]);

	// Mount-time cursor check: if the cursor is already over the affordance when
	// it mounts (no mouseenter will fire), reveal — or poll if it's moving fast.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; reads stable RefObject.current once
	useEffect(() => {
		const el = containerRef.current;
		const pos = lastCursorRef?.current;
		if (!el || !pos) return;
		const rect = el.getBoundingClientRect();
		const inside =
			pos.x >= rect.left &&
			pos.x <= rect.right &&
			pos.y >= rect.top &&
			pos.y <= rect.bottom;
		if (inside) {
			if ((cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD) startSpeedPoll();
			else setHovered(true);
		}
	}, []);

	const onMouseEnter = useCallback(() => {
		if ((cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD) startSpeedPoll();
		else reveal();
	}, [cursorSpeedRef, reveal, startSpeedPoll]);

	const onMouseMove = useCallback(() => {
		if (!pendingRef.current) return;
		if ((cursorSpeedRef?.current ?? 0) <= SPEED_THRESHOLD) reveal();
	}, [cursorSpeedRef, reveal]);

	const onMouseLeave = useCallback(() => {
		clearPoll();
		pendingRef.current = false;
		if (!keepOpenRef.current?.()) setHovered(false);
	}, [clearPoll]);

	return {
		revealed: hovered,
		reveal,
		reset,
		containerRef,
		onMouseEnter,
		onMouseMove,
		onMouseLeave,
	};
}
