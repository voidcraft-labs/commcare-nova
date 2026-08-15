/**
 * The chat conversation's scroll model.
 *
 * One coherent rule set, stated once and applied everywhere, replacing the
 * per-symptom patches (a library pin + a remount initializer + a question-card
 * scrollIntoView effect) that each covered one case and fought the others:
 *
 *  - PINNED (the default): the view tracks "the bottom" through every kind of
 *    change — streamed content, container resizes, the centered↔sidebar width
 *    morph. "The bottom" is the literal bottom, except while a question card
 *    waits: then the target is capped so the card's TOP stays readable — the
 *    user answers a question from its start, and a card taller than the
 *    viewport pinned to its tail would open on its last option.
 *  - A USER scroll stays pinned inside a near-bottom range. Moving farther up
 *    leaves pinned mode, so tiny trackpad drift and layout rounding never show
 *    a jump button while the latest content is still in view.
 *  - Returning to that same range re-enters pinned mode. It is never an
 *    exact-pixel requirement.
 *  - The user's own send (or an answered question round) always re-enters
 *    pinned mode with an instant jump, wherever they had scrolled.
 *
 * The pure functions carry the whole decision model so it unit-tests without
 * a DOM; `ChatScrollController` is the thin binding that applies them —
 * ResizeObservers for content/container changes, and a programmatic-scroll
 * counter so the controller's own writes are never mistaken for the user's.
 */

/** Near-bottom range that stays in, or re-enters, pinned mode. */
export const PIN_BOTTOM_SLOP_PX = 100;

/** Breathing room kept above an anchored question card's top. */
export const ANCHOR_MARGIN_PX = 12;

export type ChatScrollMode = "pinned" | "free";

export interface ScrollMetrics {
	readonly scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
	return Math.max(
		0,
		metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
	);
}

/**
 * The mode after a USER scroll (never called for the controller's own writes).
 * The near-bottom range is symmetric: a tiny upward move remains pinned, and
 * returning to the range after reading older content re-pins.
 */
export function modeAfterUserScroll(metrics: ScrollMetrics): ChatScrollMode {
	return distanceFromBottom(metrics) <= PIN_BOTTOM_SLOP_PX ? "pinned" : "free";
}

/**
 * Where a pinned view sits. `anchorTop` is the content-relative top of the
 * waiting question card (null when none is waiting): a short card is fully
 * visible at the literal bottom, so the cap only takes over when the card is
 * taller than the viewport leaves room for — then the view opens at the
 * card's first question instead of its tail.
 */
export function pinnedScrollTarget(
	metrics: ScrollMetrics,
	anchorTop: number | null,
): number {
	const bottom = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
	if (anchorTop === null) return bottom;
	return Math.max(0, Math.min(bottom, anchorTop - ANCHOR_MARGIN_PX));
}

/** The selector marking the pinned view's anchor (the waiting card). */
const ANCHOR_SELECTOR = '[data-question-card="waiting"]';

type ModeListener = (mode: ChatScrollMode) => void;

export class ChatScrollController {
	private mode: ChatScrollMode = "pinned";
	private container: HTMLElement | null = null;
	private content: HTMLElement | null = null;
	private lastScrollTop = 0;
	private pendingProgrammaticScrolls = 0;
	private observers: ResizeObserver[] = [];
	private readonly modeListeners = new Set<ModeListener>();

	/**
	 * Bind to a scroll container and its content element. Runs from ref
	 * callbacks — commit-time, before paint — so the initial bottom position
	 * lands with no top-positioned first frame. Idempotent for the same pair:
	 * a re-render that replays the ref callbacks must not reset the mode (a
	 * re-attach on every render is how an escape would snap straight back to
	 * the bottom).
	 */
	attach(container: HTMLElement, content: HTMLElement): void {
		if (this.container === container && this.content === content) return;
		this.detach();
		this.container = container;
		this.content = content;
		this.mode = "pinned";
		this.lastScrollTop = container.scrollTop;
		this.applyPin();
		if (typeof ResizeObserver !== "undefined") {
			const follow = () => this.applyPin();
			for (const el of [container, content]) {
				const observer = new ResizeObserver(follow);
				observer.observe(el);
				this.observers.push(observer);
			}
		}
		this.notify();
	}

	detach(): void {
		for (const observer of this.observers) observer.disconnect();
		this.observers = [];
		this.container = null;
		this.content = null;
		this.pendingProgrammaticScrolls = 0;
	}

	get pinned(): boolean {
		return this.mode === "pinned";
	}

	/** Subscribe to mode changes; returns the unsubscribe. */
	subscribe(listener: ModeListener): () => void {
		this.modeListeners.add(listener);
		return () => this.modeListeners.delete(listener);
	}

	/** The container's scroll handler: ours to count down, or the user's to
	 *  rule on. */
	handleScroll(): void {
		const el = this.container;
		if (!el) return;
		if (this.pendingProgrammaticScrolls > 0) {
			this.pendingProgrammaticScrolls -= 1;
			this.lastScrollTop = el.scrollTop;
			return;
		}
		const next = modeAfterUserScroll(el);
		this.lastScrollTop = el.scrollTop;
		this.setMode(next);
	}

	/** The user's own send / answered round: back to the pinned position as
	 *  an instant jump, from wherever they had scrolled. */
	scrollToLatest(): void {
		this.setMode("pinned");
		this.applyPin();
	}

	private setMode(next: ChatScrollMode): void {
		if (this.mode === next) return;
		this.mode = next;
		this.notify();
	}

	private notify(): void {
		for (const listener of this.modeListeners) listener(this.mode);
	}

	/** Content-relative top of the LAST waiting question card, or null. */
	private anchorTop(): number | null {
		const container = this.container;
		const content = this.content;
		if (!container || !content) return null;
		const cards = content.querySelectorAll(ANCHOR_SELECTOR);
		const last = cards[cards.length - 1];
		if (!(last instanceof HTMLElement)) return null;
		return (
			last.getBoundingClientRect().top -
			container.getBoundingClientRect().top +
			container.scrollTop
		);
	}

	private applyPin(): void {
		const el = this.container;
		if (!el || this.mode !== "pinned") return;
		const target = pinnedScrollTarget(el, this.anchorTop());
		if (Math.abs(el.scrollTop - target) < 1) return;
		this.pendingProgrammaticScrolls += 1;
		el.scrollTop = target;
		if (Math.abs(el.scrollTop - this.lastScrollTop) < 1) {
			/* The browser clamped the write to the current position: no scroll
			 * event will fire, so the counter must not wait for one. */
			this.pendingProgrammaticScrolls -= 1;
		}
		this.lastScrollTop = el.scrollTop;
	}
}
