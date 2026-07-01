/**
 * Born select-option identity + order minting — the shared helper both the SA
 * assembly and the builder add gesture route their starter options through.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import { keyedOptions } from "../options";

describe("keyedOptions", () => {
	it("mints a distinct uuid + strictly-ascending order on every keyless option", () => {
		const result = keyedOptions([
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
			{ value: "c", label: "C" },
		]);
		expect(result).toBeDefined();
		if (!result) return;
		expect(result.every((o) => o.uuid !== undefined)).toBe(true);
		expect(result.every((o) => o.order !== undefined)).toBe(true);
		// Input order preserved via strictly-ascending keys.
		expect((result[0].order ?? "") < (result[1].order ?? "")).toBe(true);
		expect((result[1].order ?? "") < (result[2].order ?? "")).toBe(true);
		// Distinct identities.
		expect(new Set(result.map((o) => o.uuid)).size).toBe(3);
	});

	it("preserves an option's existing uuid + order", () => {
		const result = keyedOptions([
			{ value: "a", label: "A", uuid: asUuid("opt-1"), order: "V" },
		]);
		expect(result?.[0].uuid).toBe("opt-1");
		expect(result?.[0].order).toBe("V");
	});

	it("returns undefined for absent options", () => {
		expect(keyedOptions(undefined)).toBeUndefined();
	});

	it("threads a minted key AFTER a preceding existing key (mixed input)", () => {
		// A keyed option followed by keyless ones: the minted keys must sort AFTER
		// the existing key so the input order is preserved. A fresh 0..n run would
		// have keyed the trailing options below the leading one.
		const result = keyedOptions([
			{ value: "a", label: "A", uuid: asUuid("opt-a"), order: "V" },
			{ value: "b", label: "B" },
			{ value: "c", label: "C" },
		]);
		expect(result).toBeDefined();
		if (!result) return;
		expect(result[0].order).toBe("V");
		const orders = result.map((o) => o.order ?? "");
		// Strictly ascending, so array order == display order.
		expect(orders[0] < orders[1]).toBe(true);
		expect(orders[1] < orders[2]).toBe(true);
	});
});
