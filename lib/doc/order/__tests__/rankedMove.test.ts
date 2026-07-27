// Property + case tests for the ranked move primitive.
//
// The contract is one sentence: apply the plan's `order` to the mover and every
// `rekey` to its sibling, and the mover lands at the REQUESTED index while the
// siblings keep their relative order. `planRankedMove` is total, so the
// exhaustive property test at the bottom is the real oracle — it enumerates
// every key vector over an alphabet carrying duplicates, absent keys and
// foreign trailing zeros, against every destination, and asserts exactly that
// sentence. The named cases above it exist to say WHICH shape costs a rekey.

import { describe, expect, it } from "vitest";
import { planRankedMove, type RankedItem } from "../rankedMove";

/** The tie-break `orderedCaseOperations` uses — what these plans target. */
const compareUuid = (left: string, right: string): number =>
	left.localeCompare(right);

function row(uuid: string, order?: string): RankedItem {
	return order === undefined ? { uuid } : { uuid, order };
}

/** `orderedCaseOperations`' comparator, on plain rows. */
function display(rows: readonly RankedItem[]): RankedItem[] {
	return [...rows].sort((left, right) => {
		if (left.order !== undefined && right.order !== undefined) {
			if (left.order < right.order) return -1;
			if (left.order > right.order) return 1;
			return compareUuid(left.uuid, right.uuid);
		}
		if (left.order !== undefined) return -1;
		if (right.order !== undefined) return 1;
		return compareUuid(left.uuid, right.uuid);
	});
}

/** Plan the move, apply the whole plan, and report what the sort then says. */
function land(
	siblings: readonly RankedItem[],
	moverUuid: string,
	toIndex: number,
) {
	const plan = planRankedMove(siblings, moverUuid, toIndex, compareUuid);
	const rekeyed = new Map(plan.rekeys.map((r) => [r.uuid, r.order]));
	const sorted = display([
		{ uuid: moverUuid, order: plan.order },
		...siblings.map((sibling) => {
			const order = rekeyed.get(sibling.uuid);
			return order === undefined ? sibling : { ...sibling, order };
		}),
	]);
	return {
		plan,
		index: sorted.findIndex((entry) => entry.uuid === moverUuid),
		siblingUuids: sorted
			.filter((entry) => entry.uuid !== moverUuid)
			.map((entry) => entry.uuid),
	};
}

describe("planRankedMove — the common case costs nothing", () => {
	it("mints one key between distinct neighbours and re-keys no sibling", () => {
		const siblings = [row("s2", "a"), row("s4", "m"), row("s6", "z")];
		for (const toIndex of [0, 1, 2, 3]) {
			const result = land(siblings, "s3", toIndex);
			expect(result.plan.rekeys).toEqual([]);
			expect(result.index).toBe(toIndex);
			expect(result.siblingUuids).toEqual(["s2", "s4", "s6"]);
		}
	});

	it("clamps a destination past either end", () => {
		const siblings = [row("s2", "a"), row("s4", "m")];
		expect(land(siblings, "s3", -5).index).toBe(0);
		expect(land(siblings, "s3", 99).index).toBe(2);
	});
});

describe("planRankedMove — a tied run", () => {
	const tied = [row("s2", "a"), row("s4", "a"), row("s6", "a"), row("s8", "a")];

	it("re-keys the SMALLER side and lands inside the run", () => {
		// Destination 1: one sibling below it, three above — the one below moves.
		const low = land(tied, "s9", 1);
		expect(low.index).toBe(1);
		expect(low.plan.rekeys.map((rekey) => rekey.uuid)).toEqual(["s2"]);
		expect(low.siblingUuids).toEqual(["s2", "s4", "s6", "s8"]);

		// Destination 3: three below, one above — the one above moves.
		const high = land(tied, "s9", 3);
		expect(high.index).toBe(3);
		expect(high.plan.rekeys.map((rekey) => rekey.uuid)).toEqual(["s8"]);
		expect(high.siblingUuids).toEqual(["s2", "s4", "s6", "s8"]);
	});

	it("breaks a draw toward the upper side, deterministically", () => {
		const even = land(tied, "s9", 2);
		expect(even.index).toBe(2);
		expect(even.plan.rekeys.map((rekey) => rekey.uuid)).toEqual(["s6", "s8"]);
		expect(even.siblingUuids).toEqual(["s2", "s4", "s6", "s8"]);
	});

	it("costs nothing at either boundary of the run", () => {
		const bounded = [
			row("s1", "A"),
			row("s2", "m"),
			row("s4", "m"),
			row("s6", "m"),
			row("s9", "z"),
		];
		for (const toIndex of [1, 4]) {
			const result = land(bounded, "s5", toIndex);
			expect(result.plan.rekeys).toEqual([]);
			expect(result.index).toBe(toIndex);
		}
	});

	it("reuses the tied key when the mover's uuid falls in the neighbours' gap", () => {
		const siblings = [row("s2", "m"), row("s6", "m")];
		const inside = land(siblings, "s4", 1);
		expect(inside.plan).toEqual({ order: "m", rekeys: [] });
		expect(inside.index).toBe(1);

		// The same destination for a uuid OUTSIDE that gap is unreachable by any
		// single key, so it has to open one.
		const outside = land(siblings, "s1", 1);
		expect(outside.plan.rekeys.length).toBeGreaterThan(0);
		expect(outside.index).toBe(1);
	});

	it("re-keys a numerically tied but raw-distinct pair, which has no key between it", () => {
		// "a" and "a0" are the same fraction; no string sorts strictly between
		// them either, so reusing a key cannot work and `keyBetween` would throw.
		const siblings = [row("s2", "a"), row("s6", "a0")];
		const result = land(siblings, "s4", 1);
		expect(result.plan.rekeys.map((rekey) => rekey.uuid)).toEqual(["s6"]);
		expect(result.index).toBe(1);
		expect(result.siblingUuids).toEqual(["s2", "s6"]);
	});
});

describe("planRankedMove — the un-keyed suffix", () => {
	const siblings = [row("s2", "a"), row("s4"), row("s6")];

	it("costs nothing at the start of the suffix", () => {
		const result = land(siblings, "s9", 1);
		expect(result.plan.rekeys).toEqual([]);
		expect(result.index).toBe(1);
		expect(result.siblingUuids).toEqual(["s2", "s4", "s6"]);
	});

	it("keys the siblings that must stay below it, and only those", () => {
		const inside = land(siblings, "s9", 2);
		expect(inside.plan.rekeys.map((rekey) => rekey.uuid)).toEqual(["s4"]);
		expect(inside.index).toBe(2);
		expect(inside.siblingUuids).toEqual(["s2", "s4", "s6"]);

		const end = land(siblings, "s9", 3);
		expect(end.plan.rekeys.map((rekey) => rekey.uuid)).toEqual(["s4", "s6"]);
		expect(end.index).toBe(3);
		expect(end.siblingUuids).toEqual(["s2", "s4", "s6"]);
	});

	it("places into a wholly un-keyed sequence", () => {
		const unkeyed = [row("s2"), row("s6")];
		for (const toIndex of [0, 1, 2]) {
			const result = land(unkeyed, "s4", toIndex);
			expect(result.index).toBe(toIndex);
			expect(result.siblingUuids).toEqual(["s2", "s6"]);
		}
	});
});

describe("planRankedMove — foreign keys the wire can carry", () => {
	// `order` is a wire-open string: an MCP client or a crafted PUT can persist
	// a key that is numerically zero, or one with trailing zeros. Neither is an
	// error to raise — they are neighbours a row still has to be placed against.
	it("places against a zero key at both ends without throwing", () => {
		const siblings = [row("s4", "0")];
		expect(land(siblings, "s2", 0).index).toBe(0);
		expect(land(siblings, "s6", 1).index).toBe(1);
	});

	it("places against zero-extension twins", () => {
		const siblings = [row("s2", "0"), row("s6", "00")];
		const result = land(siblings, "s4", 1);
		expect(result.index).toBe(1);
		expect(result.siblingUuids).toEqual(["s2", "s6"]);
	});

	it("places against a trailing-zero key", () => {
		const siblings = [row("s2", "A0"), row("s6", "B")];
		for (const toIndex of [0, 1, 2]) {
			const result = land(siblings, "s4", toIndex);
			expect(result.index).toBe(toIndex);
			expect(result.siblingUuids).toEqual(["s2", "s6"]);
		}
	});
});

describe("planRankedMove — exhaustive", () => {
	// Duplicates, an absent key, a zero key, and a zero-extension of a real key:
	// every shape whose feasibility differs. Three siblings is enough for a tied
	// run to have a strict interior AND a side to prefer.
	const ALPHABET = [undefined, "0", "a", "a0", "b"] as const;
	const SIBLING_UUIDS = ["s2", "s4", "s6"];
	// Below every sibling, in each gap, and above every sibling — the mover's
	// uuid is what decides a tie, so it is part of the input space.
	const MOVER_UUIDS = ["s1", "s3", "s5", "s7"];

	function keyVectors(length: number): (string | undefined)[][] {
		if (length === 0) return [[]];
		return keyVectors(length - 1).flatMap((prefix) =>
			ALPHABET.map((key) => [...prefix, key]),
		);
	}

	it("lands at the requested index and preserves the sibling subsequence", () => {
		let cases = 0;
		for (let length = 0; length <= SIBLING_UUIDS.length; length++) {
			for (const keys of keyVectors(length)) {
				// The primitive reads DISPLAY order, which is what its caller hands
				// it — so sort the generated vector the way the document would.
				const siblings = display(
					keys.map((key, index) => row(SIBLING_UUIDS[index], key)),
				);
				const expected = siblings.map((sibling) => sibling.uuid);
				for (const moverUuid of MOVER_UUIDS) {
					for (let toIndex = 0; toIndex <= length; toIndex++) {
						const result = land(siblings, moverUuid, toIndex);
						const shape = `${JSON.stringify(keys)} ${moverUuid} → ${toIndex}`;
						expect(`${shape}: ${result.index}`).toBe(`${shape}: ${toIndex}`);
						expect(result.siblingUuids).toEqual(expected);
						// A rekey names a real sibling and the run ascends.
						const orders = result.plan.rekeys.map((rekey) => rekey.order);
						expect([...orders].sort()).toEqual(orders);
						for (const rekey of result.plan.rekeys) {
							expect(expected).toContain(rekey.uuid);
						}
						cases++;
					}
				}
			}
		}
		expect(cases).toBe(2344);
	});
});
