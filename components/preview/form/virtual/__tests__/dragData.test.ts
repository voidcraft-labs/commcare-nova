/**
 * dragData helpers — payload factories, narrowing, and the cycle-safety
 * helper `isUuidInSubtree`.
 *
 * The cycle test is the most important one: dragging a group onto one of
 * its own descendants is the bug class pragmatic DnD can't prevent for us,
 * so we pin the behavior down in pure unit tests independent of the React
 * render tree.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	isDraggableQuestionData,
	isUuidInSubtree,
	makeDraggableQuestionData,
	makeDropEmptyContainerData,
	makeDropGroupHeaderData,
	makeDropQuestionData,
	readDropTargetData,
	targetContainerUuidFor,
} from "../dragData";

const F = asUuid("form-0000-0000-0000-000000000000");
const G = (n: number) => asUuid(`grp${n}-0000-0000-0000-000000000000`);
const Q = (n: number) => asUuid(`qst${n}-0000-0000-0000-000000000000`);

describe("isDraggableQuestionData", () => {
	it("accepts payloads produced by the factory", () => {
		const data = makeDraggableQuestionData(Q(1));
		expect(isDraggableQuestionData(data)).toBe(true);
	});

	it("rejects arbitrary unrelated payloads", () => {
		expect(isDraggableQuestionData({ kind: "other" })).toBe(false);
		expect(isDraggableQuestionData({})).toBe(false);
	});
});

describe("readDropTargetData", () => {
	it("narrows drop-question payloads", () => {
		const data = makeDropQuestionData(Q(1), F, 0);
		const narrowed = readDropTargetData(data);
		expect(narrowed?.kind).toBe("drop-question");
	});

	it("narrows drop-group-header payloads", () => {
		const data = makeDropGroupHeaderData(G(1), F, 2);
		const narrowed = readDropTargetData(data);
		expect(narrowed?.kind).toBe("drop-group-header");
	});

	it("narrows drop-empty-container payloads", () => {
		const data = makeDropEmptyContainerData(G(1));
		const narrowed = readDropTargetData(data);
		expect(narrowed?.kind).toBe("drop-empty-container");
	});

	it("returns null for unrecognized payloads", () => {
		expect(readDropTargetData({ kind: "external-thing" })).toBeNull();
		expect(readDropTargetData({})).toBeNull();
	});
});

describe("targetContainerUuidFor", () => {
	it("resolves a drop-question to the target's parent", () => {
		const data = makeDropQuestionData(Q(1), F, 0);
		const drop = readDropTargetData(data);
		if (!drop) throw new Error("unreachable");
		expect(targetContainerUuidFor(drop)).toBe(F);
	});

	it("resolves a drop-group-header to the group's own uuid", () => {
		const data = makeDropGroupHeaderData(G(1), F, 0);
		const drop = readDropTargetData(data);
		if (!drop) throw new Error("unreachable");
		expect(targetContainerUuidFor(drop)).toBe(G(1));
	});

	it("resolves a drop-empty-container to the container's uuid", () => {
		const data = makeDropEmptyContainerData(G(1));
		const drop = readDropTargetData(data);
		if (!drop) throw new Error("unreachable");
		expect(targetContainerUuidFor(drop)).toBe(G(1));
	});
});

describe("isUuidInSubtree", () => {
	// Simple tree:
	//   form
	//   ├─ G1
	//   │   ├─ G2
	//   │   │   └─ Q3
	//   │   └─ Q2
	//   └─ Q1
	const order: Record<string, readonly string[]> = {
		[F]: [G(1), Q(1)],
		[G(1)]: [G(2), Q(2)],
		[G(2)]: [Q(3)],
	};

	it("returns true for the ancestor itself", () => {
		expect(isUuidInSubtree(order, G(1), G(1))).toBe(true);
	});

	it("returns true for a direct child", () => {
		expect(isUuidInSubtree(order, G(1), Q(2))).toBe(true);
		expect(isUuidInSubtree(order, G(1), G(2))).toBe(true);
	});

	it("returns true for a deep descendant", () => {
		expect(isUuidInSubtree(order, G(1), Q(3))).toBe(true);
	});

	it("returns false for a sibling", () => {
		expect(isUuidInSubtree(order, G(1), Q(1))).toBe(false);
	});

	it("returns false when the ancestor has no entry in questionOrder", () => {
		// A leaf question has no order entry — everything outside its own
		// uuid should register as non-descendant.
		expect(isUuidInSubtree(order, Q(1), G(1))).toBe(false);
	});

	it("handles completely empty order maps", () => {
		expect(isUuidInSubtree({}, G(1), Q(1))).toBe(false);
		expect(isUuidInSubtree({}, G(1), G(1))).toBe(true);
	});

	it("is cycle-safe on malformed input — found target", () => {
		const cyclic: Record<string, readonly string[]> = {
			a: ["b"],
			b: ["a"],
		};
		expect(isUuidInSubtree(cyclic, "a", "b")).toBe(true);
	});

	it("is cycle-safe on malformed input — target not in graph", () => {
		// This is the dangerous case: without a visited set, the walker
		// would loop forever between a→b→a→b→... searching for "c".
		const cyclic: Record<string, readonly string[]> = {
			a: ["b"],
			b: ["a"],
		};
		expect(isUuidInSubtree(cyclic, "a", "c")).toBe(false);
	});
});
