// Deterministic gesture simulations against the pure insertion-intent model.
// Timestamps are explicit; a "gesture" is a sequence of pointerMove samples at
// a realistic event rate (125Hz) plus tick() frames (60Hz) while stationary —
// exactly what the DOM binding feeds the model.
//
// Two motion profiles matter: `glide` moves at CONSTANT velocity (passing
// through — the settling gate must keep gaps shut), and `approach` decelerates
// into its endpoint (aiming — the Fitts's-law profile real hands produce,
// which the gate must reward).

import { describe, expect, it } from "vitest";
import {
	createInsertionIntentModel,
	type InsertionIntentModel,
	type ZoneRect,
} from "@/lib/ui/insertionIntent";

/** Three 24px-tall gap zones in a 600px column, like a form canvas:
 *  A y[100,124], B y[224,248], C y[348,372] — fields between them. */
const zones = new Map<string, ZoneRect>([
	["A", { left: 0, top: 100, right: 400, bottom: 124 }],
	["B", { left: 0, top: 224, right: 400, bottom: 248 }],
	["C", { left: 0, top: 348, right: 400, bottom: 372 }],
]);

const makeModel = (): InsertionIntentModel =>
	createInsertionIntentModel(() => zones);

/** Move at CONSTANT velocity from (x0,y0) to (x1,y1) over `ms` at 125Hz.
 *  Returns the end time. */
function glide(
	m: InsertionIntentModel,
	t0: number,
	from: { x: number; y: number },
	to: { x: number; y: number },
	ms: number,
): number {
	const steps = Math.max(1, Math.round(ms / 8));
	for (let i = 1; i <= steps; i++) {
		const f = i / steps;
		m.pointerMove(
			from.x + (to.x - from.x) * f,
			from.y + (to.y - from.y) * f,
			t0 + ms * f,
		);
	}
	return t0 + ms;
}

/** Move with an ease-out profile — DECELERATING into the endpoint, the way a
 *  human aims at a target. Returns the end time. */
function approach(
	m: InsertionIntentModel,
	t0: number,
	from: { x: number; y: number },
	to: { x: number; y: number },
	ms: number,
): number {
	const steps = Math.max(1, Math.round(ms / 8));
	for (let i = 1; i <= steps; i++) {
		const p = i / steps;
		const f = 1 - (1 - p) ** 2;
		m.pointerMove(
			from.x + (to.x - from.x) * f,
			from.y + (to.y - from.y) * f,
			t0 + ms * p,
		);
	}
	return t0 + ms;
}

/** Hold the pointer still, ticking at 60Hz. Returns the end time. */
function dwell(m: InsertionIntentModel, t0: number, ms: number): number {
	for (let t = t0 + 16; t <= t0 + ms; t += 16) m.tick(t);
	return t0 + ms;
}

/** Aim at B's center from above and let it open — the canonical open. */
function openB(m: InsertionIntentModel, t0: number): number {
	let t = approach(m, t0, { x: 200, y: 176 }, { x: 200, y: 236 }, 400);
	t = dwell(m, t, 300);
	expect(m.getSnapshot().openId).toBe("B");
	return t;
}

describe("insertion intent model", () => {
	it("a fast swipe across every gap opens nothing and shows nothing", () => {
		const m = makeModel();
		// 500px of vertical travel in 180ms (~2800 px/s) straight through A, B, C.
		glide(m, 0, { x: 200, y: 0 }, { x: 200, y: 500 }, 180);
		expect(m.getSnapshot().openId).toBeNull();
		expect(m.getSnapshot().progress).toBeLessThan(0.3);
	});

	it("a swipe with human accel/decel endpoints still opens nothing", () => {
		const m = makeModel();
		// Ease-out swipe: launches fast, decelerates to a stop past C on a
		// field row — the endpoint gaps see the slow phases.
		approach(m, 0, { x: 200, y: 60 }, { x: 200, y: 420 }, 250);
		dwell(m, 250, 500);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("a swipe that turns around on a gap never opens it (reversal)", () => {
		const m = makeModel();
		// Ease-out down-swipe bottoming on C…
		let t = approach(m, 0, { x: 200, y: 60 }, { x: 200, y: 358 }, 320);
		// …a brief human hesitation at the bottom of the swing…
		t = glide(m, t, { x: 200, y: 358 }, { x: 200, y: 362 }, 60);
		expect(m.getSnapshot().openId).toBeNull(); // commit window holds
		// …then straight back up. The reversal pin drains the evidence.
		t = glide(m, t, { x: 200, y: 362 }, { x: 200, y: 80 }, 160);
		expect(m.getSnapshot().openId).toBeNull();
		dwell(m, t, 400);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("an overshoot correction — reverse and STOP on the gap — still opens", () => {
		const m = makeModel();
		// Swipe down past C…
		let t = approach(m, 0, { x: 200, y: 60 }, { x: 200, y: 430 }, 260);
		// …come back up a short hop and stop dead on C.
		t = approach(m, t, { x: 200, y: 430 }, { x: 200, y: 360 }, 180);
		t = dwell(m, t, 600);
		expect(m.getSnapshot().openId).toBe("C");
	});

	it("a constant slow drift across gaps opens nothing (passing through)", () => {
		const m = makeModel();
		// 200 px/s straight through all three zones — sub-traversal speed but
		// no deceleration signature.
		glide(m, 0, { x: 200, y: 60 }, { x: 200, y: 420 }, 1800);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("a deliberate approach opens as the pointer arrives", () => {
		const m = makeModel();
		// Decelerate 60px into B's center over 400ms (peak ~300 px/s).
		approach(m, 0, { x: 200, y: 176 }, { x: 200, y: 236 }, 400);
		// Open by arrival or within a frame or two of it.
		dwell(m, 400, 60);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("a flick that stops dead on a gap opens after a settle beat", () => {
		const m = makeModel();
		// Flick 400px in 100ms (4000 px/s), landing centered on B.
		let t = glide(m, 0, { x: 200, y: 636 }, { x: 200, y: 236 }, 100);
		expect(m.getSnapshot().openId).toBeNull();
		// The beat: still shut shortly after landing…
		t = dwell(m, t, 120);
		expect(m.getSnapshot().openId).toBeNull();
		// …open once the speed estimate settles.
		t = dwell(m, t, 500);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("a teleport (huge event gap) then dwell opens fast — the automation case", () => {
		const m = makeModel();
		m.pointerMove(200, 50, 0);
		// Next event 3 seconds later, 186px away — not a velocity sample.
		m.pointerMove(200, 236, 3000);
		dwell(m, 3000, 120);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("leaving an open zone closes it after the grace period, not before", () => {
		const m = makeModel();
		let t = openB(m, 0);
		// Move well outside (into the field row below).
		t = glide(m, t, { x: 200, y: 236 }, { x: 200, y: 300 }, 80);
		expect(m.getSnapshot().openId).toBe("B"); // inside grace
		t = dwell(m, t, 200);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("pointer leaving the surface closes the open zone", () => {
		const m = makeModel();
		const t = openB(m, 0);
		m.pointerGone(t);
		dwell(m, t, 300);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("walking from an open zone to a neighbor transfers quickly (warm)", () => {
		const m = makeModel();
		let t = openB(m, 0);
		// Travel down to C at a moderate 500 px/s and pause briefly.
		t = glide(m, t, { x: 200, y: 236 }, { x: 200, y: 360 }, 250);
		t = dwell(m, t, 250);
		expect(m.getSnapshot().openId).toBe("C");
	});

	it("scroll bumps read as travel — a gap under a scrolling pointer stays shut", () => {
		const m = makeModel();
		// Pointer parked on B, but wheel deltas are streaming.
		m.pointerMove(200, 236, 0);
		let t = 0;
		for (let i = 0; i < 20; i++) {
			t += 16;
			m.motionBump(40, t); // ~2500 px/s of relative motion
		}
		expect(m.getSnapshot().openId).toBeNull();
		// Scroll stops; the pointer is resting on a gap → it opens after settle.
		dwell(m, t, 600);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("travel bumps (keyboard/programmatic scroll) also keep gaps shut", () => {
		const m = makeModel();
		m.pointerMove(200, 236, 0);
		let t = 0;
		for (let i = 0; i < 20; i++) {
			t += 16;
			m.travelBump(t);
		}
		expect(m.getSnapshot().openId).toBeNull();
		dwell(m, t, 600);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("brushing in and out at speed never accumulates to an open", () => {
		const m = makeModel();
		let t = 0;
		// Zig-zag over B's boundary at ~1200 px/s, five times.
		for (let i = 0; i < 5; i++) {
			t = glide(m, t, { x: 200, y: 190 }, { x: 200, y: 250 }, 50);
			t = glide(m, t, { x: 200, y: 250 }, { x: 200, y: 190 }, 50);
		}
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("a hold pins the zone open with the pointer long gone; unhold releases", () => {
		const m = makeModel();
		let t = openB(m, 0);
		m.setHold("B", true, t);
		m.pointerGone(t);
		t = dwell(m, t, 1000);
		expect(m.getSnapshot().openId).toBe("B");
		m.setHold("B", false, t);
		t = dwell(m, t, 300);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("a hold opens a zone that was never pointer-opened (click-before-reveal)", () => {
		const m = makeModel();
		m.pointerMove(200, 236, 0);
		m.setHold("B", true, 10);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("holds are single-slot: a new hold atomically transfers the pin", () => {
		const m = makeModel();
		m.pointerMove(200, 236, 0);
		m.setHold("B", true, 10);
		expect(m.getSnapshot().openId).toBe("B");
		// The shared menu re-anchors to C — C's hold replaces B's outright.
		m.setHold("C", true, 20);
		expect(m.getSnapshot().openId).toBe("C");
		// B's straggling release (its close-broadcast subscriber) is a no-op.
		m.setHold("B", false, 30);
		expect(m.getSnapshot().openId).toBe("C");
		// Pointer leaves before the real release — everything closes.
		m.pointerGone(35);
		m.setHold("C", false, 40);
		dwell(m, 40, 300);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("re-approaching within the warm window opens faster than cold", () => {
		const m = makeModel();
		let t = openB(m, 0);
		t = glide(m, t, { x: 200, y: 236 }, { x: 200, y: 320 }, 100);
		t = dwell(m, t, 200); // grace elapses → closed, warm window running
		expect(m.getSnapshot().openId).toBeNull();
		t = approach(m, t, { x: 200, y: 320 }, { x: 200, y: 236 }, 150);
		// Opens within ~200ms of arrival — a cold flick-stop needs 2-3× that.
		t = dwell(m, t, 200);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("progress rises while arming and is quantized", () => {
		const m = makeModel();
		// Land on B stationary (teleport semantics: v ≈ 0) and take two frames.
		m.pointerMove(200, 236, 0);
		m.tick(16);
		const snap = m.getSnapshot();
		if (snap.openId === null) {
			expect(snap.armingId).toBe("B");
			expect(snap.progress).toBeGreaterThan(0);
		}
		// Quantization: progress is always a multiple of 1/24.
		expect(Math.round(snap.progress * 24)).toBeCloseTo(snap.progress * 24, 10);
	});

	it("a swipe-through leaves no ticking residue (rAF loop can stop)", () => {
		const m = makeModel();
		// Cross B fast and land in dead space below it.
		glide(m, 0, { x: 200, y: 190 }, { x: 200, y: 300 }, 60);
		dwell(m, 60, 400);
		expect(m.getSnapshot().openId).toBeNull();
		expect(m.needsTick()).toBe(false);
	});

	it("an obstructed zone accumulates nothing (popup overlays the gap)", () => {
		let obstructed = true;
		const m = createInsertionIntentModel(() => zones, undefined, {
			isObstructed: () => obstructed,
		});
		let t = approach(m, 0, { x: 200, y: 176 }, { x: 200, y: 236 }, 300);
		t = dwell(m, t, 600);
		expect(m.getSnapshot().openId).toBeNull();
		// The overlay goes away (popup closed) — dwell now opens it.
		obstructed = false;
		dwell(m, t, 300);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("a hold drops sibling arming evidence — no frozen glow behind a menu", () => {
		const m = makeModel();
		// Land on B stationary and bank partial evidence (not enough to open)…
		m.pointerMove(200, 236, 0);
		m.tick(16);
		expect(m.getSnapshot().armingId).toBe("B");
		// …then a menu pins C.
		m.setHold("C", true, 20);
		const t = dwell(m, 20, 100);
		const snap = m.getSnapshot();
		expect(snap.openId).toBe("C");
		expect(snap.armingId).toBeNull();
		expect(snap.progress).toBe(0);
		// Pinned-held is a steady state: the tick loop may stop.
		expect(m.needsTick()).toBe(false);
		m.setHold("C", false, t);
	});

	it("needsTick is false when idle and true while arming or open", () => {
		const m = makeModel();
		expect(m.needsTick()).toBe(false);
		m.pointerMove(200, 400, 0); // outside any zone (below C's bottom + pad)
		expect(m.needsTick()).toBe(false);
		m.pointerMove(200, 236, 20);
		expect(m.needsTick()).toBe(true); // arming must be tick-driven from here
		// The 164px-in-20ms entry reads as a flick — give it the settle beat.
		dwell(m, 20, 600);
		expect(m.getSnapshot().openId).toBe("B");
		expect(m.needsTick()).toBe(true);
	});
});
