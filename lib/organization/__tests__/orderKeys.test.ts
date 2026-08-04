import { describe, expect, it } from "vitest";
import {
	boundedLocationOrderKeyAtIndex,
	MAX_LOCATION_ORDER_KEY_LENGTH,
} from "../orderKeys";

describe("organization location order keys", () => {
	it("keeps a maximum-size sequential append run bounded and ordered", () => {
		let keys: string[] = [];
		for (let index = 0; index < 10_000; index++) {
			const plan = boundedLocationOrderKeyAtIndex(keys, keys.length);
			if (plan.rebalancedExistingKeys !== undefined) {
				keys = [...plan.rebalancedExistingKeys];
			}
			keys.push(plan.key);
		}

		expect(keys).toHaveLength(10_000);
		expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(
			MAX_LOCATION_ORDER_KEY_LENGTH,
		);
		for (let index = 1; index < keys.length; index++) {
			expect(keys[index - 1] < keys[index]).toBe(true);
		}
	});

	it("preserves the requested semantic slot when it rebalances", () => {
		const longTail = `V${"V".repeat(MAX_LOCATION_ORDER_KEY_LENGTH)}`;
		const plan = boundedLocationOrderKeyAtIndex([longTail], 1);
		expect(plan.rebalancedExistingKeys).toHaveLength(1);
		expect((plan.rebalancedExistingKeys?.[0] ?? plan.key) < plan.key).toBe(
			true,
		);
	});
});
