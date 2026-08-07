/**
 * Change-set handles — the private symbol table and its structural resolver.
 *
 * Three laws are pinned here, because every one of them is what keeps a
 * handle out of canonical state:
 *
 *   - the SPELLING is a bounded lowercase slug, so an uppercase, digit-led,
 *     spaced, or over-long name is not a handle at all;
 *   - a REFERENCE is exactly the one-key `{ handle: "@name" }` object —
 *     never a prose string that happens to contain `@name`, and never an
 *     object that carries `handle` beside other keys;
 *   - a handle BINDS ONCE to a server-minted canonical UUID, and a
 *     redeclaration or an unbound reference is a `HANDLE_RESOLUTION_FAILED`
 *     staging rejection rather than a silent rebind.
 */

import { describe, expect, it } from "vitest";
import { ChangeSetStagingRejectedError } from "@/lib/agent/change-set/errors";
import {
	asHandleRef,
	HandleTable,
	resolveHandleRefs,
} from "@/lib/agent/change-set/handles";
import {
	CHANGE_SET_HANDLE_PATTERN,
	type ChangeSetHandle,
	changeSetHandleSchema,
} from "@/lib/agent/change-set/schemas";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain";

/** The branded spelling, so tests address the table the way staging does. */
function handle(name: string): ChangeSetHandle {
	return changeSetHandleSchema.parse(name);
}

const MAX_LENGTH_NAME = `@a${"b".repeat(63)}`;

describe("CHANGE_SET_HANDLE_PATTERN", () => {
	it("accepts a bounded lowercase slug", () => {
		expect(CHANGE_SET_HANDLE_PATTERN.test("@a")).toBe(true);
		expect(CHANGE_SET_HANDLE_PATTERN.test("@reg_form-1")).toBe(true);
		expect(MAX_LENGTH_NAME).toHaveLength(65);
		expect(CHANGE_SET_HANDLE_PATTERN.test(MAX_LENGTH_NAME)).toBe(true);
	});

	it("rejects every spelling that is not one", () => {
		for (const candidate of [
			"@",
			"@UPPER",
			"@1x",
			"a",
			"@a b",
			"@a.b",
			"",
			`${MAX_LENGTH_NAME}b`,
			`@${"b".repeat(80)}`,
		]) {
			expect(
				CHANGE_SET_HANDLE_PATTERN.test(candidate),
				`${JSON.stringify(candidate)} should not be a handle`,
			).toBe(false);
		}
	});
});

describe("asHandleRef", () => {
	it("reads exactly the one-key handle object", () => {
		expect(asHandleRef({ handle: "@x" })).toBe("@x");
		expect(asHandleRef({ handle: "@reg_form-1" })).toBe("@reg_form-1");
	});

	it("is not a reference when `handle` sits beside other keys", () => {
		expect(asHandleRef({ handle: "@x", extra: 1 })).toBeNull();
	});

	it("is not a reference when the value is not a handle spelling", () => {
		expect(asHandleRef({ handle: "@UPPER" })).toBeNull();
		expect(asHandleRef({ handle: "x" })).toBeNull();
		expect(asHandleRef({ handle: 1 })).toBeNull();
		expect(asHandleRef({ handle: null })).toBeNull();
	});

	it("never reads a handle out of a bare string, array, or scalar", () => {
		expect(asHandleRef("@x")).toBeNull();
		expect(asHandleRef([{ handle: "@x" }])).toBeNull();
		expect(asHandleRef(null)).toBeNull();
		expect(asHandleRef(7)).toBeNull();
		expect(asHandleRef(undefined)).toBeNull();
	});
});

describe("HandleTable", () => {
	it("binds a handle once to a freshly minted canonical UUID", () => {
		const table = new HandleTable();
		const uuid = table.declare(handle("@reg_form"), "form");
		expect(uuid).toMatch(CANONICAL_UUID_PATTERN);
		expect(table.lookup(handle("@reg_form"))).toEqual({
			uuid,
			entityKind: "form",
		});
	});

	it("mints a distinct UUID per handle", () => {
		const table = new HandleTable();
		const first = table.declare(handle("@a"), "field");
		const second = table.declare(handle("@b"), "field");
		expect(first).not.toBe(second);
	});

	it("rehydrates durable bindings through the constructor", () => {
		const uuid = new HandleTable().declare(handle("@seed"), "module");
		const table = new HandleTable([
			{
				handle: handle("@seed"),
				uuid,
				entityKind: "module",
				bindingRequestId: "req-1",
			},
		]);
		expect(table.lookup(handle("@seed"))).toEqual({
			uuid,
			entityKind: "module",
		});
		expect(table.entries()).toEqual([
			[handle("@seed"), { uuid, entityKind: "module" }],
		]);
	});

	it("refuses to redeclare a bound handle, whatever kind the second call names", () => {
		const table = new HandleTable();
		table.declare(handle("@dup"), "form");
		for (const kind of ["form", "field"] as const) {
			expect(() => table.declare(handle("@dup"), kind)).toThrow(
				ChangeSetStagingRejectedError,
			);
		}
		try {
			table.declare(handle("@dup"), "field");
			expect.unreachable("a redeclaration must reject");
		} catch (error) {
			expect(error).toBeInstanceOf(ChangeSetStagingRejectedError);
			if (error instanceof ChangeSetStagingRejectedError) {
				expect(error.code).toBe("HANDLE_RESOLUTION_FAILED");
				expect(error.message).toContain("@dup");
			}
		}
	});

	it("clone() is a scratch copy — a tentative declaration never reaches the original", () => {
		const table = new HandleTable();
		const original = table.declare(handle("@shared"), "module");
		const scratch = table.clone();

		expect(scratch.lookup(handle("@shared"))).toEqual({
			uuid: original,
			entityKind: "module",
		});
		const tentative = scratch.declare(handle("@tentative"), "form");

		expect(scratch.lookup(handle("@tentative"))?.uuid).toBe(tentative);
		expect(table.lookup(handle("@tentative"))).toBeUndefined();
		/* The original is free to bind that name itself — the abandoned
		 * invocation reserved nothing. */
		expect(table.declare(handle("@tentative"), "field")).not.toBe(tentative);
	});
});

describe("resolveHandleRefs", () => {
	function tableWith(...names: readonly string[]): {
		table: HandleTable;
		uuids: Record<string, string>;
	} {
		const table = new HandleTable();
		const uuids: Record<string, string> = {};
		for (const name of names)
			uuids[name] = table.declare(handle(name), "field");
		return { table, uuids };
	}

	it("replaces handle references nested anywhere in the input", () => {
		const { table, uuids } = tableWith("@a", "@b");
		const { resolved } = resolveHandleRefs(
			{
				target: { handle: "@a" },
				items: [
					{ parent: { handle: "@b" }, depth: { inner: [{ handle: "@a" }] } },
				],
			},
			table,
		);
		expect(resolved).toEqual({
			target: uuids["@a"],
			items: [{ parent: uuids["@b"], depth: { inner: [uuids["@a"]] } }],
		});
	});

	it("resolves a handle reference standing alone at the root", () => {
		const { table, uuids } = tableWith("@root");
		expect(resolveHandleRefs({ handle: "@root" }, table).resolved).toBe(
			uuids["@root"],
		);
	});

	it("leaves prose, plain strings, and handle-bearing objects with other keys untouched", () => {
		const { table } = tableWith("@a");
		const input = {
			message: "See @a for the registration form",
			label: "@a",
			decoy: { handle: "@a", extra: 1 },
			scalars: [1, true, null],
		};
		expect(resolveHandleRefs(input, table).resolved).toEqual(input);
	});

	it("records each used handle once, in first-seen order", () => {
		const { table } = tableWith("@a", "@b", "@c");
		const { used } = resolveHandleRefs(
			[
				{ handle: "@b" },
				{ handle: "@a" },
				{ nested: { handle: "@b" } },
				{ handle: "@c" },
			],
			table,
		);
		expect(used).toEqual(["@b", "@a", "@c"]);
	});

	it("records nothing when the input references no handle", () => {
		const { table } = tableWith("@a");
		expect(resolveHandleRefs({ label: "plain" }, table).used).toEqual([]);
	});

	it("rejects a reference to a handle this change set has not bound", () => {
		const { table } = tableWith("@a");
		try {
			resolveHandleRefs({ target: { handle: "@later" } }, table);
			expect.unreachable("an unbound handle must reject");
		} catch (error) {
			expect(error).toBeInstanceOf(ChangeSetStagingRejectedError);
			if (error instanceof ChangeSetStagingRejectedError) {
				expect(error.code).toBe("HANDLE_RESOLUTION_FAILED");
				expect(error.message).toContain("@later");
			}
		}
	});
});
