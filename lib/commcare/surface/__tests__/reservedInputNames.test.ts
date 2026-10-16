/**
 * Holds Nova's reserved Search question names equal to the generated
 * surface's `csql-key` family (read from HQ's own constants at the pinned
 * commit), minus the two keys HQ searches as the case's id and its owner. A
 * key HQ adds reaches `surface.json` with the weekly pin update and fails
 * here until the constant names it.
 */

import { describe, expect, it } from "vitest";
import {
	isReservedSearchInputName,
	RESERVED_SEARCH_INPUT_NAME_PREFIXES,
	RESERVED_SEARCH_INPUT_NAMES,
} from "@/lib/commcare/suite/case-search/reservedInputNames";
import surface from "../surface.json";

const CSQL_KEY = "csql-key:";
const SEARCHED_AS_THE_CASE = new Set(["case_id", "owner_id"]);

function csqlKeyFamily(): { names: string[]; prefixes: string[] } {
	const names: string[] = [];
	const prefixes: string[] = [];
	for (const [id, item] of Object.entries(
		surface.items as Record<string, { readonly prefix?: string }>,
	)) {
		if (!id.startsWith(CSQL_KEY)) continue;
		if (item.prefix !== undefined) {
			prefixes.push(item.prefix);
			continue;
		}
		const name = id.slice(CSQL_KEY.length);
		if (!SEARCHED_AS_THE_CASE.has(name)) names.push(name);
	}
	return { names: names.sort(), prefixes: prefixes.sort() };
}

describe("reserved Search question names", () => {
	it("equal the surface's csql-key family without case_id and owner_id", () => {
		const family = csqlKeyFamily();
		expect([...RESERVED_SEARCH_INPUT_NAMES].sort()).toEqual(family.names);
		expect([...RESERVED_SEARCH_INPUT_NAME_PREFIXES].sort()).toEqual(
			family.prefixes,
		);
		expect(family.names).toHaveLength(16);
	});

	it("read a name under a reserved prefix as reserved, and the bare prefix word as free", () => {
		expect(isReservedSearchInputName("indices.parent")).toBe(true);
		expect(isReservedSearchInputName("indices")).toBe(false);
	});

	it("leave case_id and owner_id free", () => {
		expect(isReservedSearchInputName("case_id")).toBe(false);
		expect(isReservedSearchInputName("owner_id")).toBe(false);
		expect(isReservedSearchInputName("include_closed")).toBe(true);
	});
});
