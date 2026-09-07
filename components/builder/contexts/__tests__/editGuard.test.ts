import { describe, expect, it } from "vitest";
import { createEditGuard } from "../editGuard";

describe("current edit guard", () => {
	it("allows navigation without an owner and restores it when the owner releases", () => {
		const guard = createEditGuard();
		expect(guard.consult()).toBe(true);
		const release = guard.register(() => false);
		expect(guard.consult()).toBe(false);
		release();
		expect(guard.consult()).toBe(true);
	});
	it("evaluates the current owner's live draft decision on each navigation", () => {
		const guard = createEditGuard();
		let valid = false;
		guard.register(() => valid);
		expect(guard.consult()).toBe(false);
		valid = true;
		expect(guard.consult()).toBe(true);
	});
	it("an older owner's cleanup cannot clear the newer blocking editor", () => {
		const guard = createEditGuard();
		const releaseOld = guard.register(() => true);
		const releaseCurrent = guard.register(() => false);
		releaseOld();
		expect(guard.consult()).toBe(false);
		releaseCurrent();
		expect(guard.consult()).toBe(true);
	});
});
