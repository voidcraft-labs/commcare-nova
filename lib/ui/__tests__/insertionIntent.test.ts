// Deterministic gesture simulations against the pure insertion-intent model.
// Timestamps are explicit; a "gesture" is a sequence of pointerMove samples at
// a realistic event rate (125Hz) plus tick() frames (60Hz) while stationary —
// exactly what the DOM binding feeds the model.

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

/** Move the pointer from (x0,y0) to (x1,y1) over `ms` at 125Hz samples.
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

/** Hold the pointer still, ticking at 60Hz. Returns the end time. */
function dwell(m: InsertionIntentModel, t0: number, ms: number): number {
	for (let t = t0 + 16; t <= t0 + ms; t += 16) m.tick(t);
	return t0 + ms;
}

describe("insertion intent model", () => {
	it("a fast swipe across every gap opens nothing", () => {
		const m = makeModel();
		// 500px of vertical travel in 180ms (~2800 px/s) straight through A, B, C.
		glide(m, 0, { x: 200, y: 0 }, { x: 200, y: 500 }, 180);
		expect(m.getSnapshot().openId).toBeNull();
		// And no lingering arming evidence worth showing.
		expect(m.getSnapshot().progress).toBeLessThan(0.3);
	});

	it("a slow, deliberate approach opens almost immediately", () => {
		const m = makeModel();
		// Approach B from 60px above at ~150 px/s, then creep through it.
		let t = glide(m, 0, { x: 200, y: 164 }, { x: 200, y: 210 }, 300);
		t = glide(m, t, { x: 200, y: 210 }, { x: 200, y: 236 }, 180);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("a flick that stops dead on a gap opens after a short settle", () => {
		const m = makeModel();
		// Flick 400px in 100ms (4000 px/s), landing centered on B.
		let t = glide(m, 0, { x: 200, y: 636 }, { x: 200, y: 236 }, 100);
		expect(m.getSnapshot().openId).toBeNull();
		// Stationary on B: the speed estimate decays, evidence fills.
		t = dwell(m, t, 400);
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
		let t = glide(m, 0, { x: 200, y: 200 }, { x: 200, y: 236 }, 250);
		t = dwell(m, t, 100);
		expect(m.getSnapshot().openId).toBe("B");
		// Move well outside (into the field row below).
		t = glide(m, t, { x: 200, y: 236 }, { x: 200, y: 300 }, 80);
		expect(m.getSnapshot().openId).toBe("B"); // inside grace
		t = dwell(m, t, 200);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("pointer leaving the surface closes the open zone", () => {
		const m = makeModel();
		let t = glide(m, 0, { x: 200, y: 200 }, { x: 200, y: 236 }, 250);
		t = dwell(m, t, 100);
		expect(m.getSnapshot().openId).toBe("B");
		m.pointerGone(t);
		dwell(m, t, 300);
		expect(m.getSnapshot().openId).toBeNull();
	});

	it("walking from an open zone to a neighbor transfers quickly (warm)", () => {
		const m = makeModel();
		let t = glide(m, 0, { x: 200, y: 200 }, { x: 200, y: 236 }, 250);
		t = dwell(m, t, 100);
		expect(m.getSnapshot().openId).toBe("B");
		// Travel down to C at a moderate 500 px/s and pause briefly.
		t = glide(m, t, { x: 200, y: 236 }, { x: 200, y: 360 }, 250);
		t = dwell(m, t, 120);
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
		dwell(m, t, 500);
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
		let t = glide(m, 0, { x: 200, y: 200 }, { x: 200, y: 236 }, 250);
		t = dwell(m, t, 100);
		expect(m.getSnapshot().openId).toBe("B");
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
		// Open B, leave it, and measure how long a moderate-speed return takes.
		let t = glide(m, 0, { x: 200, y: 200 }, { x: 200, y: 236 }, 250);
		t = dwell(m, t, 100);
		t = glide(m, t, { x: 200, y: 236 }, { x: 200, y: 320 }, 100);
		t = dwell(m, t, 200); // grace elapses → closed, warm window running
		expect(m.getSnapshot().openId).toBeNull();
		t = glide(m, t, { x: 200, y: 320 }, { x: 200, y: 236 }, 120);
		t = dwell(m, t, 60);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("progress rises while arming and is quantized", () => {
		const m = makeModel();
		const t = glide(m, 0, { x: 200, y: 300 }, { x: 200, y: 240 }, 400);
		m.tick(t + 16);
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
		let t = glide(m, 0, { x: 200, y: 200 }, { x: 200, y: 236 }, 300);
		t = dwell(m, t, 600);
		expect(m.getSnapshot().openId).toBeNull();
		// The overlay goes away (popup closed) — dwell now opens it.
		obstructed = false;
		dwell(m, t, 300);
		expect(m.getSnapshot().openId).toBe("B");
	});

	it("a hold drops sibling arming evidence — no frozen glow behind a menu", () => {
		const m = makeModel();
		// Accumulate partial evidence on B (slow approach, not enough to open)…
		let t = glide(m, 0, { x: 200, y: 210 }, { x: 200, y: 236 }, 60);
		expect(m.getSnapshot().armingId).not.toBeNull();
		// …then a menu pins C.
		m.setHold("C", true, t + 10);
		t = dwell(m, t + 10, 100);
		const snap = m.getSnapshot();
		expect(snap.openId).toBe("C");
		expect(snap.armingId).toBeNull();
		expect(snap.progress).toBe(0);
		// Pinned-held is a steady state: the tick loop may stop.
		expect(m.needsTick()).toBe(false);
	});

	it("needsTick is false when idle and true while arming or open", () => {
		const m = makeModel();
		expect(m.needsTick()).toBe(false);
		// Pointer stops inside B on its very first in-zone event.
		m.pointerMove(200, 400, 0); // outside any zone (below C's bottom + pad)
		expect(m.needsTick()).toBe(false);
		m.pointerMove(200, 236, 20);
		expect(m.needsTick()).toBe(true); // arming must be tick-driven from here
		// The 164px-in-20ms entry reads as a flick — give it the settle beat.
		dwell(m, 20, 500);
		expect(m.getSnapshot().openId).toBe("B");
		expect(m.needsTick()).toBe(true);
	});
});
