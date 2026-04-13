import { afterEach, describe, expect, it } from "vitest";
import { signalGrid } from "../store";

describe("signalGrid store", () => {
	afterEach(() => {
		signalGrid.reset();
	});

	it("accumulates and drains stream energy", () => {
		signalGrid.injectEnergy(10);
		expect(signalGrid.drainEnergy()).toBe(10);
		// Second drain returns 0 -- energy was fully consumed
		expect(signalGrid.drainEnergy()).toBe(0);
	});

	it("tracks think energy independently from stream energy", () => {
		signalGrid.injectEnergy(5);
		signalGrid.injectThinkEnergy(20);

		// Draining one channel doesn't affect the other
		expect(signalGrid.drainEnergy()).toBe(5);
		expect(signalGrid.drainThinkEnergy()).toBe(20);
	});

	it("reset() clears both counters", () => {
		signalGrid.injectEnergy(100);
		signalGrid.injectThinkEnergy(200);
		signalGrid.reset();

		expect(signalGrid.drainEnergy()).toBe(0);
		expect(signalGrid.drainThinkEnergy()).toBe(0);
	});

	it("reset() clears energy injected across multiple calls", () => {
		signalGrid.injectEnergy(100);
		signalGrid.injectThinkEnergy(50);
		signalGrid.reset();
		expect(signalGrid.drainEnergy()).toBe(0);
		expect(signalGrid.drainThinkEnergy()).toBe(0);
	});
});
