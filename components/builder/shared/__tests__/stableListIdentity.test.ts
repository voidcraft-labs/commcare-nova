import { describe, expect, it } from "vitest";
import {
	createStableListIdentity,
	reconcileStableListKeys,
	stableValueFingerprint,
} from "../stableListIdentity";

interface Row {
	value: string;
}
const clone = <T>(value: T): T => structuredClone(value);

function mounted(items: readonly Row[]) {
	const owner = createStableListIdentity<Row>("list");
	let frame = owner.render(items);
	frame.commit();
	return {
		owner,
		get frame() {
			return frame;
		},
		publish(next: readonly Row[]) {
			frame = owner.render(next);
			frame.commit();
			return frame;
		},
	};
}

describe("committed stable-list identity", () => {
	it("distinguishes values and canonicalizes only object key order", () => {
		expect(
			stableValueFingerprint({ value: "a", nested: { enabled: true } }),
		).toBe(stableValueFingerprint({ nested: { enabled: true }, value: "a" }));
		const values = [
			null,
			undefined,
			"1",
			1,
			true,
			{ a: 1 },
			{ a: "1" },
			[1, 2],
			[2, 1],
		];
		expect(new Set(values.map(stableValueFingerprint)).size).toBe(
			values.length,
		);
	});

	it("retains each duplicate occurrence through clones, local moves, insertions and deletion", () => {
		const a = { value: "same" },
			b = { value: "same" },
			c = { value: "other" };
		const list = mounted([a, b, c]);
		const [ak, bk, ck] = list.frame.keys;
		expect(new Set(list.frame.keys).size).toBe(3);
		expect(list.publish(clone([a, b, c])).keys).toEqual([ak, bk, ck]);
		list.frame.stage([b, a, c], { kind: "move", fromIndex: 1, toIndex: 0 });
		expect(list.publish(clone([b, a, c])).keys).toEqual([bk, ak, ck]);
		const inserted = { value: "same" };
		list.frame.stage([b, inserted, a, c], {
			kind: "splice",
			index: 1,
			deleteCount: 0,
			insertCount: 1,
		});
		const next = list.publish(clone([b, inserted, a, c]));
		const added = next.keys[1];
		expect(next.keys).toEqual([bk, added, ak, ck]);
		expect([ak, bk, ck]).not.toContain(added);
		list.frame.stage([b, inserted, c], {
			kind: "splice",
			index: 2,
			deleteCount: 1,
			insertCount: 0,
		});
		expect(list.publish(clone([b, inserted, c])).keys).toEqual([bk, added, ck]);
	});

	it("preserves all positions for replacements and resets all occurrences explicitly", () => {
		const list = mounted([{ value: "a" }, { value: "b" }]);
		const keys = [...list.frame.keys];
		const replacement = [{ value: "edited" }, { value: "changed" }];
		list.frame.stage(replacement, { kind: "replace" });
		expect(list.publish(clone(replacement)).keys).toEqual(keys);
		list.frame.stage(replacement, { kind: "reset" });
		const reset = list.publish(clone(replacement)).keys;
		expect(new Set([...keys, ...reset]).size).toBe(4);
	});

	it("discards rejected duplicate intent and never resurrects it on an unrelated clone", () => {
		const initial = [{ value: "same" }, { value: "same" }];
		const list = mounted(initial);
		const keys = [...list.frame.keys];
		list.frame.stage([initial[1], initial[0]], {
			kind: "move",
			fromIndex: 1,
			toIndex: 0,
		});
		expect(list.publish(initial).keys).toEqual(keys);
		expect(list.publish(clone(initial)).keys).toEqual(keys);
	});

	it("does not publish or consume a pending edit from an abandoned render", () => {
		const a = { value: "a" },
			b = { value: "b" };
		const list = mounted([a, b]);
		const keys = [...list.frame.keys];
		list.frame.stage([b, a], { kind: "move", fromIndex: 1, toIndex: 0 });
		const abandoned = list.owner.render([{ value: "unrelated" }]);
		expect(abandoned.keys).not.toEqual(keys);
		expect(list.publish(clone([b, a])).keys).toEqual([keys[1], keys[0]]);
	});

	it("does not let a stale frame consume newer staged intent", () => {
		const initial = [{ value: "a" }, { value: "b" }];
		const list = mounted(initial);
		const keys = [...list.frame.keys];
		list.frame.stage([...initial].reverse(), {
			kind: "move",
			fromIndex: 1,
			toIndex: 0,
		});
		const earlier = list.owner.render(clone([...initial].reverse()));
		earlier.stage([{ value: "inserted" }, initial[1], initial[0]], {
			kind: "splice",
			index: 0,
			deleteCount: 0,
			insertCount: 1,
		});
		earlier.commit();
		const result = list.publish([
			{ value: "inserted" },
			initial[1],
			initial[0],
		]).keys;
		expect(result.slice(1)).toEqual([keys[1], keys[0]]);
		expect(keys).not.toContain(result[0]);
	});

	it("rejects mismatched operations without changing the committed ledger", () => {
		const initial = [{ value: "a" }, { value: "b" }];
		const list = mounted(initial);
		const keys = [...list.frame.keys];
		expect(() => list.frame.stage([], { kind: "replace" })).toThrow(
			"same row count",
		);
		expect(() =>
			list.frame.stage(initial, { kind: "move", fromIndex: 4, toIndex: 0 }),
		).toThrow("existing row");
		expect(() =>
			list.frame.stage(initial, {
				kind: "splice",
				index: 1,
				deleteCount: 1,
				insertCount: 0,
			}),
		).toThrow("next row count");
		expect(list.publish(clone(initial)).keys).toEqual(keys);
	});
});

describe("external stable-list reconciliation", () => {
	const a = { value: "a" },
		b = { value: "b" },
		c = { value: "c" };
	const reconcile = (next: readonly Row[]) =>
		reconcileStableListKeys({
			previousItems: [a, b, c],
			previousKeys: ["a-key", "b-key", "c-key"],
			nextItems: next,
			prefix: "peer",
			nextOrdinal: 3,
		});
	it("follows unique external reorder and never gives a removed head's key to a new tail", () => {
		expect(reconcile(clone([c, a, b])).keys).toEqual([
			"c-key",
			"a-key",
			"b-key",
		]);
		expect(reconcile(clone([b, c, { value: "new" }])).keys).toEqual([
			"b-key",
			"c-key",
			"peer:row:3",
		]);
	});
	it("retains only an unambiguous same-slot replacement", () => {
		expect(reconcile(clone([a, { value: "edited" }, c])).keys).toEqual([
			"a-key",
			"b-key",
			"c-key",
		]);
		expect(
			reconcile([{ value: "changed-a" }, { value: "changed-b" }, clone(c)])
				.keys,
		).toEqual(["peer:row:3", "peer:row:4", "c-key"]);
	});
	it("matches exact duplicate references before structural occurrences", () => {
		const first = { value: "same" },
			second = { value: "same" };
		expect(
			reconcileStableListKeys({
				previousItems: [first, second],
				previousKeys: ["first", "second"],
				nextItems: [second, clone(first)],
				prefix: "list",
				nextOrdinal: 2,
			}).keys,
		).toEqual(["second", "first"]);
	});
});
