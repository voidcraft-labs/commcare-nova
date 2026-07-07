// lib/ui/hooks/useInsertionZone.tsx
//
// The DOM/React binding for the pure insertion-intent model
// (lib/ui/insertionIntent.ts) — ONE implementation behind both the form
// canvas's InsertionPoint and the app tree's insertion strips.
//
//   - <InsertionIntentProvider> mounts once per surface. It owns the model,
//     the document-level listeners that feed it (pointermove, wheel,
//     pointerleave/blur, scroll + resize for rect invalidation), and a rAF
//     loop that runs ONLY while the model is arming/open/closing — an idle
//     surface costs a few passive listeners and nothing else.
//   - useInsertionZone() registers the attached element as a zone and
//     subscribes to ITS slice of the model: `status` ('idle'|'arming'|'open')
//     and `progress` (0..1 arming evidence, for the pre-open glow).
//
// Zone rects are measured lazily into a cache invalidated on scroll, resize,
// and registration changes, plus a short TTL for layout shifts nothing
// observes (content edits, font swaps). Containment is computed from these
// rects — never from DOM enter/leave events, which go stale the moment layout
// moves under a stationary pointer.

"use client";
import {
	createContext,
	type ReactNode,
	type RefCallback,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import {
	createInsertionIntentModel,
	type InsertionIntentConfig,
	type InsertionIntentModel,
	type ZoneRect,
	type ZoneStatus,
} from "@/lib/ui/insertionIntent";

/** Re-measure zone rects at most this often (ms) even without an observed
 *  invalidation — cheap insurance against unobserved layout shifts. */
const RECT_TTL_MS = 300;

/** After an invalidation, serve the stale rects for up to this long before
 *  re-measuring. Momentum scrolling fires wheel + capture-phase scroll events
 *  (plus virtualizer row registrations) several times per frame — sweeping
 *  every zone's getBoundingClientRect per event is the hottest-path layout
 *  cost, and nothing can open mid-scroll anyway (speed reads as travel). */
const RECT_STALE_GRACE_MS = 30;

/** Surfaces that host insertion zones mark their scroll/canvas root with this
 *  attribute; a pointer hit that resolves outside every marked surface is an
 *  overlay (portalled popup, dialog) covering the zone. */
export const INSERTION_SURFACE_ATTR = "data-insertion-surface";

interface IntentBinding {
	readonly model: InsertionIntentModel;
	registerZone(id: string, el: HTMLElement): () => void;
	/** Routed through the binding (not the model) so releasing a hold restarts
	 *  the tick loop — the grace close needs frames to count down. */
	setHold(id: string, held: boolean): void;
	attach(): () => void;
}

function createBinding(config?: Partial<InsertionIntentConfig>): IntentBinding {
	const elements = new Map<string, HTMLElement>();
	let rects: Map<string, ZoneRect> | null = null;
	let rectsAt = 0;
	let rectsDirty = false;

	const measure = (now: number): Map<string, ZoneRect> => {
		const next = new Map<string, ZoneRect>();
		for (const [id, el] of elements) {
			const r = el.getBoundingClientRect();
			// A hidden zone (collapsed group, display:none) measures 0×0 —
			// it simply contains no points.
			next.set(id, {
				left: r.left,
				top: r.top,
				right: r.right,
				bottom: r.bottom,
			});
		}
		rects = next;
		rectsAt = now;
		rectsDirty = false;
		return next;
	};

	const getZones = (): ReadonlyMap<string, ZoneRect> => {
		const now = performance.now();
		if (rects === null || now - rectsAt > RECT_TTL_MS) return measure(now);
		// Dirty rects stay in service briefly — see RECT_STALE_GRACE_MS.
		if (rectsDirty && now - rectsAt >= RECT_STALE_GRACE_MS) return measure(now);
		return rects;
	};

	const isObstructed = (x: number, y: number, zoneId: string): boolean => {
		const el = elements.get(zoneId);
		if (!el) return true;
		const hit = document.elementFromPoint(x, y);
		if (hit === null) return false;
		// A hit inside the zone itself, or anywhere in a marked insertion
		// surface (an adjacent row — the zone's hit pad extends a few px past
		// its element), is unobstructed; anything else is an overlay.
		if (el.contains(hit)) return false;
		return hit.closest(`[${INSERTION_SURFACE_ATTR}]`) === null;
	};

	const model = createInsertionIntentModel(getZones, config, { isObstructed });

	const invalidateRects = (): void => {
		rectsDirty = true;
	};

	// ── Tick loop: runs only while the model has time-dependent work ──
	let raf = 0;
	let attached = false;
	const loop = (): void => {
		raf = 0;
		if (!attached) return;
		model.tick(performance.now());
		if (model.needsTick()) raf = requestAnimationFrame(loop);
	};
	const ensureLoop = (): void => {
		if (attached && raf === 0 && model.needsTick())
			raf = requestAnimationFrame(loop);
	};

	return {
		model,

		registerZone(id, el) {
			elements.set(id, el);
			invalidateRects();
			// Zones register during React's commit — evaluate on a microtask so a
			// zone appearing under a stationary pointer still arms, without
			// notifying subscribers mid-commit.
			queueMicrotask(() => {
				if (!attached || !elements.has(id)) return;
				model.tick(performance.now());
				ensureLoop();
			});
			return () => {
				elements.delete(id);
				invalidateRects();
			};
		},

		setHold(id, heldNow) {
			model.setHold(id, heldNow, performance.now());
			ensureLoop();
		},

		attach() {
			attached = true;

			const onPointerMove = (e: PointerEvent): void => {
				model.pointerMove(e.clientX, e.clientY, e.timeStamp);
				ensureLoop();
			};
			const onWheel = (e: WheelEvent): void => {
				const px = Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
				invalidateRects();
				model.motionBump(px, e.timeStamp);
				ensureLoop();
			};
			const onPointerGone = (e: Event): void => {
				model.pointerGone(e.timeStamp);
				ensureLoop();
			};
			const onScroll = (): void => {
				invalidateRects();
				// Keyboard and programmatic scrolls fire no wheel events, but the
				// content still travels under a parked pointer — without a speed
				// signal, a gap sliding under the cursor would read as deliberate
				// dwell and pop open mid-scroll.
				model.travelBump(performance.now());
				ensureLoop();
			};
			const onResize = (): void => {
				invalidateRects();
			};

			document.addEventListener("pointermove", onPointerMove, {
				passive: true,
			});
			document.addEventListener("wheel", onWheel, { passive: true });
			// `pointerleave` on the root element fires when the pointer exits the
			// window; blur covers focus loss (cmd-tab) with the pointer parked.
			document.documentElement.addEventListener("pointerleave", onPointerGone);
			window.addEventListener("blur", onPointerGone);
			document.addEventListener("scroll", onScroll, {
				capture: true,
				passive: true,
			});
			window.addEventListener("resize", onResize);

			return () => {
				attached = false;
				if (raf !== 0) cancelAnimationFrame(raf);
				raf = 0;
				document.removeEventListener("pointermove", onPointerMove);
				document.removeEventListener("wheel", onWheel);
				document.documentElement.removeEventListener(
					"pointerleave",
					onPointerGone,
				);
				window.removeEventListener("blur", onPointerGone);
				document.removeEventListener("scroll", onScroll, { capture: true });
				window.removeEventListener("resize", onResize);
			};
		},
	};
}

const InsertionIntentContext = createContext<IntentBinding | null>(null);

/**
 * Mount once per surface that hosts insertion zones (the form canvas's
 * virtual list, the app tree). `config` overrides tuning constants — the
 * insertion lab uses it; product surfaces take the defaults.
 */
export function InsertionIntentProvider({
	children,
	config,
}: {
	readonly children: ReactNode;
	readonly config?: Partial<InsertionIntentConfig>;
}) {
	const [binding] = useState(() => createBinding(config));
	useEffect(() => binding.attach(), [binding]);
	return (
		<InsertionIntentContext.Provider value={binding}>
			{children}
		</InsertionIntentContext.Provider>
	);
}

export interface InsertionZone {
	/** Attach to the zone's element (ref callback with cleanup). */
	readonly ref: RefCallback<HTMLElement>;
	/** 'idle' → nothing; 'arming' → evidence accumulating (glow); 'open' →
	 *  show the affordance. */
	readonly status: ZoneStatus;
	/** Arming evidence 0..1 — drives the pre-open glow. 0 unless arming. */
	readonly progress: number;
	/** Pin the zone open while its popup/menu is up. */
	readonly setHold: (held: boolean) => void;
}

const NO_ZONE: InsertionZone = {
	ref: () => {},
	status: "idle",
	progress: 0,
	setHold: () => {},
};

/**
 * Direct access to the surface's intent model — for the dev-only insertion
 * lab (live config tuning, HUD introspection). Product surfaces never need
 * this; they read zone state through `useInsertionZone`.
 */
export function useInsertionIntentDebug(): InsertionIntentModel | null {
	return useContext(InsertionIntentContext)?.model ?? null;
}

/**
 * Register the attached element as an insertion zone and read its intent
 * state. Requires an ancestor InsertionIntentProvider; without one the zone
 * is inert (never reveals) — every insertion surface mounts the provider.
 */
export function useInsertionZone(): InsertionZone {
	const binding = useContext(InsertionIntentContext);
	const id = useId();

	const ref = useCallback(
		(el: HTMLElement | null) => {
			if (!binding || el === null) return;
			return binding.registerZone(id, el);
		},
		[binding, id],
	);

	const subscribe = useCallback(
		(cb: () => void) => binding?.model.subscribe(cb) ?? (() => {}),
		[binding],
	);
	const status = useSyncExternalStore(
		subscribe,
		(): ZoneStatus => {
			const snap = binding?.model.getSnapshot();
			if (!snap) return "idle";
			if (snap.openId === id) return "open";
			if (snap.armingId === id) return "arming";
			return "idle";
		},
		() => "idle" as ZoneStatus,
	);
	const progress = useSyncExternalStore(
		subscribe,
		(): number => {
			const snap = binding?.model.getSnapshot();
			return snap?.armingId === id ? snap.progress : 0;
		},
		() => 0,
	);

	const setHold = useCallback(
		(heldNow: boolean) => {
			binding?.setHold(id, heldNow);
		},
		[binding, id],
	);

	return useMemo(
		() => (binding ? { ref, status, progress, setHold } : NO_ZONE),
		[binding, ref, status, progress, setHold],
	);
}
