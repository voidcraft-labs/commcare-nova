/**
 * The canonical-JSON digest discipline every change-set identity is built on
 * (`lib/utils/canonicalJson.ts`), plus the staging input digest that keys
 * request idempotency (`lib/agent/change-set/digest.ts`).
 *
 * Two properties carry the whole protocol: the canonical TEXT is a function
 * of a value's content and never of its key insertion order, and a staging
 * digest changes whenever any part of the caller's actual request changes —
 * including the protocol version itself, so a future protocol revision cannot
 * silently replay an old receipt.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalJsonDigest,
	canonicalJsonText,
	WORKSPACE_CALL_PROTOCOL_VERSION,
	workspaceCallInputDigest,
} from "@/lib/agent/change-set/digest";
import {
	persistModelValue,
	rehydrateModelValue,
} from "@/lib/agent/modelMessagePersistence";

/** Keys chosen so code-point order (`Z` < `_x` < `a` < `b`) differs from both
 *  insertion order and any locale-aware collation. */
const FIXTURE = {
	b: [3, { d: 4, c: [5, { f: 6, e: 7 }] }],
	a: 1,
	Z: { y: "y", x: "x" },
	_x: null,
};

describe("canonicalJsonText", () => {
	it("sorts ordinary string keys by UTF-16 code unit, recursively, leaving array order alone", () => {
		expect(canonicalJsonText(FIXTURE)).toBe(
			'{"Z":{"x":"x","y":"y"},"_x":null,"a":1,"b":[3,{"c":[5,{"e":7,"f":6}],"d":4}]}',
		);
	});

	it("is the same text for two objects that differ only in key insertion order", () => {
		const reordered = {
			_x: null,
			a: 1,
			Z: { x: "x", y: "y" },
			b: [3, { c: [5, { e: 7, f: 6 }], d: 4 }],
		};
		expect(canonicalJsonText(reordered)).toBe(canonicalJsonText(FIXTURE));
		expect(canonicalJsonDigest(reordered)).toBe(canonicalJsonDigest(FIXTURE));
	});

	it("drops undefined-valued own properties exactly as JSON.stringify does", () => {
		expect(canonicalJsonText({ a: 1, b: undefined })).toBe('{"a":1}');
		expect(canonicalJsonDigest({ a: 1, b: undefined })).toBe(
			canonicalJsonDigest({ a: 1 }),
		);
	});

	it("refuses a value that serializes to nothing rather than digesting an absence", () => {
		expect(() => canonicalJsonText(undefined)).toThrow(/serializes to nothing/);
	});
});

describe("canonicalJsonDigest", () => {
	it("hashes the exact canonical UTF-8 bytes", () => {
		const bytes =
			'{"Z":{"x":"x","y":"y"},"_x":null,"a":1,"b":[3,{"c":[5,{"e":7,"f":6}],"d":4}]}';
		expect(canonicalJsonDigest(FIXTURE)).toBe(
			createHash("sha256").update(bytes, "utf8").digest("hex"),
		);
	});
	it.each([
		'{"__proto__":{"x":1},"a":2}',
		'{"nested":{"__proto__":{"x":1},"a":2}}',
		'[{"__proto__":{"x":1},"a":2}]',
	])("preserves own __proto__ JSON member in %s", (json) => {
		const value = JSON.parse(json);
		expect(canonicalJsonText(value)).toBe(json);
		expect(canonicalJsonDigest(value)).toBe(
			createHash("sha256").update(json, "utf8").digest("hex"),
		);
	});
	it("distinguishes an own prototype-named key from an absent key", () => {
		expect(
			canonicalJsonDigest(JSON.parse('{"__proto__":{"x":1},"a":2}')),
		).not.toBe(canonicalJsonDigest({ a: 2 }));
	});

	it("keeps existing encoded model-value digest bytes stable for customer prototype-named keys", () => {
		const customerValue = JSON.parse('{"__proto__":"kept"}');
		const persisted = persistModelValue(customerValue);
		// These were already the stored bytes before own JSON-key preservation:
		// customer keys are strings in entries, never object property names.
		const bytes =
			'{"encoding":"nova-model-value-v1","value":{"entries":[["__proto__",{"kind":"string","value":"kept"}]],"kind":"object"}}';
		expect(canonicalJsonText(persisted)).toBe(bytes);
		expect(canonicalJsonDigest(persisted)).toBe(
			createHash("sha256").update(bytes, "utf8").digest("hex"),
		);
		expect(rehydrateModelValue(persisted)).toEqual(customerValue);
	});

	it("separates values that differ only in content", () => {
		expect(canonicalJsonDigest({ a: 1 })).not.toBe(
			canonicalJsonDigest({ a: 2 }),
		);
		expect(canonicalJsonDigest({ a: 1 })).not.toBe(
			canonicalJsonDigest({ b: 1 }),
		);
	});
});

describe("workspaceCallInputDigest", () => {
	const base = {
		toolName: "addFields",
		expectedWorkspaceRevision: 3,
		projectedInput: { formUuid: "f", items: [{ label: "Name" }] },
	} as const;

	it("digests the exact protocol envelope, so the protocol version participates", () => {
		expect(workspaceCallInputDigest(base)).toBe(
			canonicalJsonDigest({
				workspaceCallProtocolVersion: WORKSPACE_CALL_PROTOCOL_VERSION,
				toolName: base.toolName,
				expectedWorkspaceRevision: base.expectedWorkspaceRevision,
				projectedInput: base.projectedInput,
			}),
		);
		expect(workspaceCallInputDigest(base)).not.toBe(
			canonicalJsonDigest({
				workspaceCallProtocolVersion: WORKSPACE_CALL_PROTOCOL_VERSION + 1,
				toolName: base.toolName,
				expectedWorkspaceRevision: base.expectedWorkspaceRevision,
				projectedInput: base.projectedInput,
			}),
		);
	});

	it("changes when the tool name changes", () => {
		expect(
			workspaceCallInputDigest({ ...base, toolName: "createForm" }),
		).not.toBe(workspaceCallInputDigest(base));
	});

	it("changes when the expected workspace revision changes", () => {
		expect(
			workspaceCallInputDigest({ ...base, expectedWorkspaceRevision: 4 }),
		).not.toBe(workspaceCallInputDigest(base));
	});

	it("changes when the projected input changes", () => {
		expect(
			workspaceCallInputDigest({
				...base,
				projectedInput: { formUuid: "f", items: [{ label: "Age" }] },
			}),
		).not.toBe(workspaceCallInputDigest(base));
	});

	it("is stable across key order inside the projected input", () => {
		expect(
			workspaceCallInputDigest({
				...base,
				projectedInput: { items: [{ label: "Name" }], formUuid: "f" },
			}),
		).toBe(workspaceCallInputDigest(base));
	});
});
