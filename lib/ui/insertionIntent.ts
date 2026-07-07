// lib/ui/insertionIntent.ts
//
// The insertion-point intent model — the pure state machine behind every
// hover-reveal insertion affordance (the form canvas's InsertionPoint and the
// app tree's insertion strips). It answers ONE question continuously: "does
// the user want the insertion affordance under the pointer right now?"
//
// The mental model is an EVIDENCE ACCUMULATOR, not a threshold:
//
//   - Pointer speed is an exponential moving average whose smoothing factor
//     derives from the inter-event dt (a fixed per-event alpha would make the
//     estimate depend on the event rate), and which decays analytically while
//     no events arrive — a stopped mouse fires no events, so a read-time decay
//     is the only way the estimate ever reaches zero.
//   - While the pointer is inside a zone, evidence accumulates at
//     `dt / dwellFor(speed)`: a slow, deliberate pointer needs only
//     `minDwellMs` of presence, a fast one needs `maxDwellMs`. A swipe crosses
//     a zone in a few milliseconds and accumulates a few percent — it never
//     opens. A flick that STOPS on a zone opens as the speed estimate decays —
//     the "you meant it after all" beat. Evidence reaching 1 opens the zone.
//   - Evidence decays (rather than resetting) when the pointer slips out, so
//     boundary jitter keeps partial credit but a real departure clears fast.
//   - Evidence only accumulates while SETTLING — genuinely slow, or
//     decelerating (the fast estimate visibly below a slower trend EMA).
//     Aiming brakes into its target; passing through holds speed.
//   - Direction guards the two cases speed alone can't tell apart. A swipe's
//     TURNAROUND decelerates exactly like an arrival — but then the direction
//     flips while momentum is high, which pins the speed estimate back up to
//     the trend (the reversal pin) and drains the evidence. And because the
//     turnaround is unknowable until the return motion begins, evidence that
//     fills while still moving must survive `OPEN_COMMIT_MS` of continued
//     settling before it opens — an aim sails through; a reversal breaks
//     settling inside the window and aborts.
//
// Zone membership is GEOMETRIC — point-in-rect against caller-supplied rects —
// never DOM enter/leave events, because layout can move under a stationary
// pointer (reveals, scrolls, virtualizer remeasures) and the DOM fires nothing
// when it does. The open zone's rect is inflated by `openPadPx` (hysteresis)
// and closing always waits `closeGraceMs`, so micro-jitter at an edge can't
// flicker the affordance.
//
// Everything here is pure: callers feed events with explicit timestamps and
// provide rects through `getZones`, so tests drive the model deterministically
// (see lib/ui/hooks/useInsertionZone.tsx for the DOM/React binding).

export interface ZoneRect {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export interface InsertionIntentConfig {
	/** Speed-EMA time constant (ms) while speed is RISING. Short, so the very
	 *  first fast samples of a swipe stiffen the dwell requirement before the
	 *  swipe crosses anything — a symmetric constant lets gaps near the start
	 *  point bank evidence while the estimate is still catching up. */
	readonly speedRiseTauMs: number;
	/** Speed-EMA time constant (ms) while speed is FALLING — also its
	 *  no-events decay rate. Longer than the rise, so a swipe's deceleration
	 *  tail (and the moments right after a stop) still read as fast: the
	 *  settle beat after a flick comes from exactly this release. */
	readonly speedFallTauMs: number;
	/** Time constant (ms) of the slower trend EMA the settling test compares
	 *  against. */
	readonly trendTauMs: number;
	/** The pointer counts as SETTLING when speed < trend × this ratio — i.e.
	 *  measurably decelerating. Evidence accumulates only while settling or
	 *  below `slowSpeed`: aiming decelerates into its target (Fitts's law),
	 *  while passing through holds speed — this is what keeps a constant-speed
	 *  drift across gaps from opening them. */
	readonly settlingRatio: number;
	/** Dwell (ms) required to open at/below `slowSpeed` — the "you're clearly
	 *  aiming here" fast path. */
	readonly minDwellMs: number;
	/** Dwell (ms) required at/above `fastSpeed` — long enough that traversal
	 *  never opens, short enough that a flick-and-stop feels responsive. */
	readonly maxDwellMs: number;
	/** Speed (px/s) at/below which dwell is `minDwellMs`. */
	readonly slowSpeed: number;
	/** Speed (px/s) at/above which dwell is `maxDwellMs`. */
	readonly fastSpeed: number;
	/** Time constant (ms) of evidence decay while the pointer is outside the
	 *  zone it was accumulating on. */
	readonly scoreDecayTauMs: number;
	/** How long (ms) the pointer must be outside an open zone before it closes. */
	readonly closeGraceMs: number;
	/** Idle zones' hit rects are inflated by this margin (px). */
	readonly hitPadPx: number;
	/** The OPEN zone's keep-open rect is inflated by this larger margin (px) —
	 *  hysteresis, so the boundary to "leaving" sits outside the boundary to
	 *  "entering". */
	readonly openPadPx: number;
	/** After a zone closes (or while one is open), sibling zones open with
	 *  `warmDwellFactor` for this long (ms) — the submenu pattern: the first
	 *  open proves intent, walking along neighbors is fluid. */
	readonly warmWindowMs: number;
	readonly warmDwellFactor: number;
	/** Inter-event gap (ms) beyond which the pair is not a velocity sample
	 *  (sleep, teleport, tab switch) — the speed just decays across the gap. */
	readonly sampleGapResetMs: number;
}

export const DEFAULT_INSERTION_INTENT_CONFIG: InsertionIntentConfig = {
	speedRiseTauMs: 25,
	speedFallTauMs: 70,
	trendTauMs: 150,
	settlingRatio: 0.85,
	minDwellMs: 40,
	maxDwellMs: 280,
	slowSpeed: 80,
	fastSpeed: 1000,
	scoreDecayTauMs: 90,
	closeGraceMs: 120,
	hitPadPx: 4,
	openPadPx: 10,
	warmWindowMs: 450,
	warmDwellFactor: 0.35,
	sampleGapResetMs: 100,
};

/** A zone's externally-visible participation state. */
export type ZoneStatus = "idle" | "arming" | "open";

export interface InsertionIntentSnapshot {
	readonly openId: string | null;
	/** The zone currently accumulating evidence (never the open one). */
	readonly armingId: string | null;
	/** Accumulated evidence of `armingId`, 0..1, quantized so snapshots don't
	 *  churn every tick. */
	readonly progress: number;
}

/** Introspection for the tuning lab's HUD — not consumed by product surfaces. */
export interface InsertionIntentDebugState {
	readonly speed: number;
	readonly trend: number;
	readonly settling: boolean;
	readonly score: number;
	readonly candidateId: string | null;
	readonly dwellMs: number;
}

export interface InsertionIntentModel {
	pointerMove(x: number, y: number, t: number): void;
	/** Relative pointer↔content motion with no pointer displacement (wheel
	 *  scrolling) — feeds the speed estimate so scrolling counts as traveling. */
	motionBump(deltaPx: number, t: number): void;
	/** Content is moving under the pointer with no measurable delta (keyboard
	 *  or programmatic scrolling) — pin the speed estimate at travel speed so
	 *  gaps sliding under a parked pointer don't read as deliberate dwell. */
	travelBump(t: number): void;
	/** The pointer left the tracked surface (window leave, drag start). */
	pointerGone(t: number): void;
	/** Advance time-dependent state; the binding calls this each frame while
	 *  `needsTick()` — a stationary pointer fires no events, so accumulation,
	 *  speed decay, and the close grace all need ticks to make progress. */
	tick(t: number): void;
	/** Pin a zone open regardless of the pointer (its popup/menu is open). */
	setHold(id: string, held: boolean, t: number): void;
	needsTick(): boolean;
	getSnapshot(): InsertionIntentSnapshot;
	subscribe(listener: () => void): () => void;
	setConfig(partial: Partial<InsertionIntentConfig>): void;
	getConfig(): InsertionIntentConfig;
	debugState(t: number): InsertionIntentDebugState;
}

/** Speed reads as fully stationary this long (ms) after the last sample; past
 *  it the estimate decays analytically. Shorter would sag the estimate between
 *  ordinary 60–125Hz event frames; longer would delay the flick-and-stop open. */
const STATIONARY_AFTER_MS = 50;

/** Evidence below this is zero — keeps snapshots quiet after a casual crossing. */
const SCORE_EPSILON = 0.02;

/** One evaluation can grant at most this much dwell (ms) — a stalled tick loop
 *  (background tab) must not bank seconds of "presence" and open on resume. */
const MAX_ACCUMULATION_STEP_MS = 50;

/** Time constant (ms) of the velocity DIRECTION EMA — short, so it reflects
 *  the travel direction of the last few samples. */
const DIR_TAU_MS = 50;

/** Reversal test: a sample whose direction's cosine against the direction EMA
 *  is below this opposes recent travel — a turnaround, not an arrival. */
const REVERSAL_DOT = -0.3;

/** Both the sample and the direction EMA must exceed slowSpeed × this factor
 *  for the reversal test to fire — hand tremor produces moderate one-sample
 *  speeds in random directions, and a dwelling pointer must not self-pin. */
const REVERSAL_SPEED_FACTOR = 1.5;

/** Evidence that fills while the pointer is still moving (v ≥ slowSpeed) must
 *  survive this much further sustained settling before opening — the causality
 *  guard for turnarounds, which are only detectable once the return motion
 *  begins. Truly slow arrival (v < slowSpeed) opens immediately. */
const OPEN_COMMIT_MS = 60;

/** Snapshot progress quantization steps (re-renders per arming, at most). */
const PROGRESS_STEPS = 24;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const smoothstep = (edge0: number, edge1: number, x: number): number => {
	const f = clamp01((x - edge0) / (edge1 - edge0));
	return f * f * (3 - 2 * f);
};

const inflated = (r: ZoneRect, pad: number, x: number, y: number): boolean =>
	x >= r.left - pad &&
	x <= r.right + pad &&
	y >= r.top - pad &&
	y <= r.bottom + pad;

export interface InsertionIntentEnv {
	/** True when the point over `zoneId` is covered by something that is not
	 *  the zone's own surface (a portalled popup, a dialog) — evidence must
	 *  not accumulate through an overlay. Consulted only on the slow-dwell
	 *  path, so implementations may hit-test the DOM. */
	readonly isObstructed?: (x: number, y: number, zoneId: string) => boolean;
}

export function createInsertionIntentModel(
	getZones: () => ReadonlyMap<string, ZoneRect>,
	configOverrides?: Partial<InsertionIntentConfig>,
	env?: InsertionIntentEnv,
): InsertionIntentModel {
	const isObstructed = env?.isObstructed;
	let cfg: InsertionIntentConfig = {
		...DEFAULT_INSERTION_INTENT_CONFIG,
		...configOverrides,
	};

	// ── Speed estimate ────────────────────────────────────────────────
	let speed = 0; // px/s, fast-attack/slow-release EMA
	let trend = 0; // px/s, slower EMA — the settling baseline
	let dirX = 0; // px/s, velocity-vector EMA — recent travel direction
	let dirY = 0;
	let speedT = Number.NEGATIVE_INFINITY; // time of last speed sample

	// ── Pointer ───────────────────────────────────────────────────────
	let px = 0;
	let py = 0;
	let pointerKnown = false;

	// ── Evidence ──────────────────────────────────────────────────────
	let score = 0;
	let scoreZoneId: string | null = null;
	let scoreT = Number.NEGATIVE_INFINITY; // time of last accumulate/decay
	let scoreFullAt: number | null = null; // when evidence first reached 1

	// ── Open state ────────────────────────────────────────────────────
	let openId: string | null = null;
	let closePendingAt: number | null = null;
	let lastClosedAt = Number.NEGATIVE_INFINITY;
	/** Single slot: a surface has one popup, so at most one zone is pinned.
	 *  A new hold REPLACES the old one — that's what makes the shared menu's
	 *  re-anchor (close→reopen at another zone within one click) atomic. */
	let heldId: string | null = null;

	// ── Subscribers ───────────────────────────────────────────────────
	const listeners = new Set<() => void>();
	let snapshot: InsertionIntentSnapshot = {
		openId: null,
		armingId: null,
		progress: 0,
	};

	const speedAt = (t: number): number => {
		const idle = t - speedT;
		if (idle <= STATIONARY_AFTER_MS) return speed;
		return speed * Math.exp(-(idle - STATIONARY_AFTER_MS) / cfg.speedFallTauMs);
	};

	const trendAt = (t: number): number => {
		const idle = t - speedT;
		if (idle <= STATIONARY_AFTER_MS) return trend;
		return trend * Math.exp(-(idle - STATIONARY_AFTER_MS) / cfg.trendTauMs);
	};

	/** Aiming decelerates into its target; passing through holds speed. The
	 *  fast estimate dropping visibly below the slow trend is the deceleration
	 *  signature (below `slowSpeed` no signature is required — a creep or a
	 *  stationary pointer is intent on its own). */
	const isSettling = (v: number, t: number): boolean =>
		v < cfg.slowSpeed || v <= trendAt(t) * cfg.settlingRatio;

	const dwellFor = (v: number): number =>
		cfg.minDwellMs +
		(cfg.maxDwellMs - cfg.minDwellMs) *
			smoothstep(cfg.slowSpeed, cfg.fastSpeed, v);

	const updateMotion = (dx: number, dy: number, dt: number): void => {
		const vx = dx / (dt / 1000);
		const vy = dy / (dt / 1000);
		const inst = Math.hypot(vx, vy);
		// Reversal pin — checked against the direction EMA BEFORE this sample
		// joins it. Opposing recent travel at meaningful speed is a swipe
		// turnaround: carry the momentum through so the settling gate holds
		// (a turnaround's speed dip decelerates exactly like an arrival).
		const dirMag = Math.hypot(dirX, dirY);
		const floor = cfg.slowSpeed * REVERSAL_SPEED_FACTOR;
		if (inst > floor && dirMag > floor) {
			const dot = (vx * dirX + vy * dirY) / (inst * dirMag);
			if (dot < REVERSAL_DOT) speed = Math.max(speed, trend, inst);
		}
		const aDir = 1 - Math.exp(-dt / DIR_TAU_MS);
		dirX += aDir * (vx - dirX);
		dirY += aDir * (vy - dirY);
		const tau = inst > speed ? cfg.speedRiseTauMs : cfg.speedFallTauMs;
		speed += (1 - Math.exp(-dt / tau)) * (inst - speed);
		trend += (1 - Math.exp(-dt / cfg.trendTauMs)) * (inst - trend);
	};

	/** Nearest-centered zone whose rect (inflated by `pad`) contains the
	 *  pointer; pads can make neighbors overlap. */
	const bestContaining = (
		zones: ReadonlyMap<string, ZoneRect>,
		pad: number,
		excludeId: string | null,
	): string | null => {
		let best: string | null = null;
		let bestDist = Number.POSITIVE_INFINITY;
		for (const [id, r] of zones) {
			if (id === excludeId) continue;
			if (!inflated(r, pad, px, py)) continue;
			const cy = (r.top + r.bottom) / 2;
			const cx = (r.left + r.right) / 2;
			const dist = Math.abs(py - cy) + Math.abs(px - cx) * 0.1;
			if (dist < bestDist) {
				bestDist = dist;
				best = id;
			}
		}
		return best;
	};

	/** The zone under the pointer. Being ON a zone's actual rect always wins —
	 *  the open zone's hysteresis pad must never swallow a flush-adjacent
	 *  sibling (the tree's last-form strip and add-module strip sit within
	 *  each other's pads), or the pointer can rest ON one affordance while
	 *  another stays open. Off every raw rect, the open zone holds within its
	 *  larger pad; otherwise the nearest pad-inflated zone. */
	const findCandidate = (
		zones: ReadonlyMap<string, ZoneRect>,
	): string | null => {
		if (!pointerKnown) return null;
		const exact = bestContaining(zones, 0, null);
		if (exact !== null) return exact;
		if (openId !== null) {
			const r = zones.get(openId);
			if (r && inflated(r, cfg.openPadPx, px, py)) return openId;
		}
		return bestContaining(zones, cfg.hitPadPx, openId);
	};

	const publish = (): void => {
		const armingId =
			scoreZoneId !== null && scoreZoneId !== openId && score > SCORE_EPSILON
				? scoreZoneId
				: null;
		const progress =
			armingId === null
				? 0
				: Math.round(clamp01(score) * PROGRESS_STEPS) / PROGRESS_STEPS;
		if (
			snapshot.openId === openId &&
			snapshot.armingId === armingId &&
			snapshot.progress === progress
		)
			return;
		snapshot = { openId, armingId, progress };
		for (const l of listeners) l();
	};

	const evaluate = (t: number): void => {
		const zones = getZones();

		// The held zone is pinned open — its popup is up, the pointer may be in
		// a portal. Drop any sibling evidence outright (it would otherwise
		// publish as a frozen glow for the whole menu session, and it's stale
		// by the time the menu closes anyway). A held zone that unregistered
		// (scrolled out of the virtualizer) simply stops pinning until it
		// comes back.
		if (heldId !== null && zones.has(heldId)) {
			openId = heldId;
			closePendingAt = null;
			score = 0;
			scoreZoneId = null;
			scoreFullAt = null;
			scoreT = t;
			publish();
			return;
		}

		const candidate = findCandidate(zones);
		const v = speedAt(t);

		// Evidence bookkeeping.
		const dtRaw = t - scoreT;
		const dt = dtRaw > 0 && Number.isFinite(dtRaw) ? dtRaw : 0;
		if (candidate === null) {
			// Clear even from score exactly 0 — a fast crossing selects a zone
			// without ever accumulating, and a lingering scoreZoneId would keep
			// needsTick() (and the binding's rAF loop) alive forever.
			score *= Math.exp(-dt / cfg.scoreDecayTauMs);
			if (score < SCORE_EPSILON) {
				score = 0;
				scoreZoneId = null;
			}
		} else if (candidate === openId) {
			// Nothing to prove while already open.
			score = 0;
			scoreZoneId = null;
		} else if (candidate !== scoreZoneId) {
			scoreZoneId = candidate;
			score = 0;
		} else if (v >= cfg.fastSpeed) {
			// At traversal speed, presence is not evidence — scrolling or swiping
			// can park relative motion on a zone for hundreds of ms. Drain instead.
			score *= Math.exp(-dt / cfg.scoreDecayTauMs);
			if (score < SCORE_EPSILON) score = 0;
		} else if (!isSettling(v, t)) {
			// Sub-traversal speed but holding steady — passing through toward
			// something beyond, not braking into the gap. Drain.
			score *= Math.exp(-dt / cfg.scoreDecayTauMs);
			if (score < SCORE_EPSILON) score = 0;
		} else if (isObstructed?.(px, py, candidate)) {
			// Something covers the zone (a portalled popup, a dialog) — presence
			// inside an overlay is not intent toward the gap beneath it. Checked
			// only on this slow-dwell path so the DOM hit-test never runs during
			// traversal or scrolling.
			score *= Math.exp(-dt / cfg.scoreDecayTauMs);
			if (score < SCORE_EPSILON) score = 0;
		} else {
			const warm = openId !== null || t - lastClosedAt <= cfg.warmWindowMs;
			const dwell = dwellFor(v) * (warm ? cfg.warmDwellFactor : 1);
			score = Math.min(
				1,
				score + Math.min(dt, MAX_ACCUMULATION_STEP_MS) / dwell,
			);
		}
		if (score >= 1) scoreFullAt ??= t;
		else scoreFullAt = null;
		scoreT = t;

		// Transitions. Full evidence gathered while still MOVING must survive
		// the commit window — a turnaround is only detectable once the return
		// motion begins, and its reversal pin breaks settling (draining the
		// score below 1) before the window elapses. A truly slow arrival
		// commits immediately.
		const committed =
			score >= 1 &&
			(v < cfg.slowSpeed ||
				(scoreFullAt !== null && t - scoreFullAt >= OPEN_COMMIT_MS));
		if (candidate !== null && candidate !== openId && committed) {
			if (openId !== null) lastClosedAt = t;
			openId = candidate;
			closePendingAt = null;
			score = 0;
			scoreZoneId = null;
			scoreFullAt = null;
		} else if (openId !== null) {
			if (candidate === openId) {
				closePendingAt = null;
			} else {
				closePendingAt ??= t;
				if (t - closePendingAt >= cfg.closeGraceMs) {
					openId = null;
					closePendingAt = null;
					lastClosedAt = t;
				}
			}
		}

		publish();
	};

	return {
		pointerMove(x, y, t) {
			if (pointerKnown) {
				const dt = t - speedT;
				if (dt > 0 && dt <= cfg.sampleGapResetMs) {
					updateMotion(x - px, y - py, dt);
					speedT = t;
				} else if (dt > cfg.sampleGapResetMs) {
					// Not a velocity sample (idle gap or teleport): carry the decayed
					// estimates forward so a dwell right after arrival isn't judged by
					// pre-gap speed. The travel direction is stale too.
					speed = speedAt(t);
					trend = trendAt(t);
					dirX = 0;
					dirY = 0;
					speedT = t;
				}
			} else {
				// First sample after (re-)entry: settle the decayed estimates onto the
				// new clock, otherwise pre-departure speed would resurrect undecayed.
				speed = speedAt(t);
				trend = trendAt(t);
				dirX = 0;
				dirY = 0;
				speedT = t;
			}
			px = x;
			py = y;
			pointerKnown = true;
			evaluate(t);
		},

		motionBump(deltaPx, t) {
			const dt = t - speedT;
			if (dt > 0 && dt <= cfg.sampleGapResetMs) {
				// Signed vertical delta — a scroll-direction flip is a reversal too.
				updateMotion(0, deltaPx, dt);
			} else {
				// First motion after a gap: treat the burst as fast travel outright.
				speed = Math.max(speedAt(t), cfg.fastSpeed);
				trend = Math.max(trendAt(t), speed);
				dirX = 0;
				dirY = Math.sign(deltaPx) * speed;
			}
			speedT = t;
			evaluate(t);
		},

		travelBump(t) {
			// Pin both estimates: with speed == trend the pointer is NOT settling,
			// so nothing can arm mid-scroll; once the scrolling stops, speed falls
			// off faster than trend and the settle path opens as usual.
			speed = Math.max(speedAt(t), cfg.fastSpeed);
			trend = Math.max(trendAt(t), speed);
			speedT = t;
			evaluate(t);
		},

		pointerGone(t) {
			pointerKnown = false;
			evaluate(t);
		},

		tick(t) {
			evaluate(t);
		},

		setHold(id, heldNow, t) {
			if (heldNow) heldId = id;
			else if (heldId === id) heldId = null;
			evaluate(t);
		},

		needsTick() {
			// A pinned hold is a steady state — evaluate() short-circuits to a
			// no-op, so ticking at 60Hz for the life of an open popup would be
			// pure waste. Events (and the hold's release) restart the loop.
			if (heldId !== null && openId === heldId) return false;
			// `scoreZoneId` alone (even at score 0) needs ticks: a pointer that
			// stops on the very event that selected the zone would otherwise never
			// accumulate — no further events arrive from a stationary mouse.
			return openId !== null || closePendingAt !== null || scoreZoneId !== null;
		},

		getSnapshot() {
			return snapshot;
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		setConfig(partial) {
			cfg = { ...cfg, ...partial };
		},

		getConfig() {
			return cfg;
		},

		debugState(t) {
			const v = speedAt(t);
			return {
				speed: v,
				trend: trendAt(t),
				settling: isSettling(v, t),
				score,
				candidateId: scoreZoneId ?? (openId !== null ? openId : null),
				dwellMs: dwellFor(v),
			};
		},
	};
}
