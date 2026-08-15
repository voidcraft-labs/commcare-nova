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

import { describe, expect, it } from "vitest";
import {
	canonicalJsonDigest,
	canonicalJsonText,
	WORKSPACE_CALL_PROTOCOL_VERSION,
	workspaceCallInputDigest,
} from "@/lib/agent/change-set/digest";
import {
	canonicalJsonDigest as leafDigest,
	canonicalJsonText as leafText,
} from "@/lib/utils/canonicalJson";

const HEX_64 = /^[a-f0-9]{64}$/;

/** Keys chosen so code-point order (`Z` < `_x` < `a` < `b`) differs from both
 *  insertion order and any locale-aware collation. */
const FIXTURE = {
	b: [3, { d: 4, c: [5, { f: 6, e: 7 }] }],
	a: 1,
	Z: { y: "y", x: "x" },
	_x: null,
};

describe("canonicalJsonText", () => {
	it("sorts every object's keys by UTF-16 code point, recursively, leaving array order alone", () => {
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

	it("is the one shared implementation the change-set vocabulary re-exports", () => {
		expect(canonicalJsonText).toBe(leafText);
		expect(canonicalJsonDigest).toBe(leafDigest);
	});
});

describe("canonicalJsonDigest", () => {
	it("is 64 lowercase hex characters", () => {
		expect(canonicalJsonDigest(FIXTURE)).toMatch(HEX_64);
		expect(canonicalJsonDigest(null)).toMatch(HEX_64);
		expect(canonicalJsonDigest([])).toMatch(HEX_64);
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

	it("is 64 lowercase hex characters", () => {
		expect(workspaceCallInputDigest(base)).toMatch(HEX_64);
	});
});
