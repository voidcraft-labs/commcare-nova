// lib/commcare/suite/case-list/__tests__/sortKeys.test.ts
//
// Acceptance tests for the sort-key resolution + emit helpers
// that drive case-list short-detail `<sort>` blocks. Each test
// pins the wire shape against CCHQ's canonical multi-sort
// fixture at
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml:44-99`.
//
// Coverage organizes around three shells:
//
//   1. Resolution — `findSortKey` matching property-source and
//      calculated-source keys, plus the no-match short-circuit.
//   2. Wire emission — `emitSortBlock` and `emitCalculatedSortBlock`
//      across every (type, direction) combination Nova exposes.
//   3. Wire-vocab maps — direct assertions against the exported
//      `SORT_TYPE_WIRE_MAP` / `SORT_DIRECTION_WIRE_MAP` records,
//      pinning the four-arm Nova → CCHQ translation.

import { describe, expect, it } from "vitest";
import {
	calculatedSortSource,
	propertySortSource,
	type SortKey,
	sortKey,
} from "@/lib/domain";
import {
	emitCalculatedSortBlock,
	emitSortBlock,
	findSortKey,
	SORT_DIRECTION_WIRE_MAP,
	SORT_TYPE_WIRE_MAP,
} from "../sortKeys";

// ============================================================
// Shell 1 — sort-key resolution
// ============================================================

describe("findSortKey — property source", () => {
	it("returns the matching property key with 1-based order", () => {
		const sort: SortKey[] = [
			sortKey(propertySortSource("birthdate"), "date", "desc"),
			sortKey(propertySortSource("name"), "plain", "asc"),
		];
		const match = findSortKey(sort, { kind: "property", property: "name" });
		expect(match).toBeDefined();
		expect(match?.order).toBe(2);
		expect(match?.key.source).toEqual({ kind: "property", property: "name" });
	});

	it("returns undefined when no key matches the property name", () => {
		const sort: SortKey[] = [
			sortKey(propertySortSource("birthdate"), "date", "desc"),
		];
		const match = findSortKey(sort, { kind: "property", property: "name" });
		expect(match).toBeUndefined();
	});

	it("does not match a calculated-source key for a property target", () => {
		// Same string, different source kind — must not match.
		const sort: SortKey[] = [
			sortKey(calculatedSortSource("name"), "plain", "asc"),
		];
		const match = findSortKey(sort, { kind: "property", property: "name" });
		expect(match).toBeUndefined();
	});
});

describe("findSortKey — calculated source", () => {
	it("returns the matching calc key with 1-based order", () => {
		const sort: SortKey[] = [
			sortKey(propertySortSource("name"), "plain", "asc"),
			sortKey(calculatedSortSource("overdue"), "integer", "desc"),
		];
		const match = findSortKey(sort, { kind: "calculated", id: "overdue" });
		expect(match).toBeDefined();
		expect(match?.order).toBe(2);
		expect(match?.key.source).toEqual({
			kind: "calculated",
			columnId: "overdue",
		});
	});

	it("returns undefined when no calc key matches the id", () => {
		const sort: SortKey[] = [
			sortKey(calculatedSortSource("overdue"), "integer", "desc"),
		];
		const match = findSortKey(sort, { kind: "calculated", id: "overdue_x" });
		expect(match).toBeUndefined();
	});

	it("does not match a property-source key for a calc target", () => {
		const sort: SortKey[] = [
			sortKey(propertySortSource("overdue"), "plain", "asc"),
		];
		const match = findSortKey(sort, { kind: "calculated", id: "overdue" });
		expect(match).toBeUndefined();
	});
});

// ============================================================
// Shell 2 — wire emission
// ============================================================

describe("emitSortBlock", () => {
	it("emits a string-typed ascending sort matching the CCHQ multi-sort fixture", () => {
		// CCHQ fixture: `<sort type="string" order="3" direction="ascending">`
		// from `multi-sort.xml:61-65` (the case_name field's sort).
		const xml = emitSortBlock({
			order: 3,
			direction: "asc",
			type: "plain",
			xpathFunction: "case_name",
		});
		expect(xml).toContain('type="string"');
		expect(xml).toContain('order="3"');
		expect(xml).toContain('direction="ascending"');
		expect(xml).toContain('<xpath function="case_name"/>');
	});

	it("emits a string-typed descending sort for date sources", () => {
		// CCHQ fixture: `<sort type="string" order="1" direction="descending">`
		// targeting `birthdate` per `multi-sort.xml:44-49`. Nova maps
		// `date` → wire `string` per the SORT_TYPE_TO_WIRE table.
		const xml = emitSortBlock({
			order: 1,
			direction: "desc",
			type: "date",
			xpathFunction: "birthdate",
		});
		expect(xml).toContain('type="string"');
		expect(xml).toContain('order="1"');
		expect(xml).toContain('direction="descending"');
		expect(xml).toContain('<xpath function="birthdate"/>');
	});

	it("emits an int-typed sort for integer SortType", () => {
		const xml = emitSortBlock({
			order: 1,
			direction: "asc",
			type: "integer",
			xpathFunction: "age",
		});
		expect(xml).toContain('type="int"');
	});

	it("emits a double-typed sort for decimal SortType", () => {
		const xml = emitSortBlock({
			order: 1,
			direction: "asc",
			type: "decimal",
			xpathFunction: "weight_kg",
		});
		expect(xml).toContain('type="double"');
	});

	it("XML-escapes the xpath function to keep attribute-value rules intact", () => {
		// An XPath that surfaces `<` or `&` (e.g. a comparison left
		// inside a calc) would break the attribute-value parse without
		// escaping. The helper is responsible for surfacing the
		// escaped form.
		const xml = emitSortBlock({
			order: 1,
			direction: "asc",
			type: "plain",
			xpathFunction: "if(a < b, 'x', 'y')",
		});
		expect(xml).toContain("a &lt; b");
		// Single quotes survive verbatim — XPath strings inside the
		// double-quoted attribute use them.
		expect(xml).toContain("'x'");
	});
});

describe("emitCalculatedSortBlock", () => {
	it("emits the CCHQ inline-variable shape for a calc-targeted sort", () => {
		// CCHQ wire shape per `detail_screen.py:185-196` — the sort
		// xpath references `$calculated_property` and the calc
		// xpath rides as a `<variable>` block inside the `<xpath>`.
		const xml = emitCalculatedSortBlock({
			order: 1,
			direction: "desc",
			type: "integer",
			calcXpath: "(today() - date(opened_on)) div 7",
		});
		expect(xml).toContain('type="int"');
		expect(xml).toContain('order="1"');
		expect(xml).toContain('direction="descending"');
		expect(xml).toContain('<xpath function="$calculated_property">');
		expect(xml).toContain('<variable name="calculated_property">');
		// The inner xpath carries the calc's lowered expression,
		// XML-escaped.
		expect(xml).toContain("today() - date(opened_on)");
	});

	it("XML-escapes the inner calc xpath", () => {
		const xml = emitCalculatedSortBlock({
			order: 1,
			direction: "asc",
			type: "plain",
			calcXpath: "if(a < b, 'x', 'y')",
		});
		expect(xml).toContain("a &lt; b");
		expect(xml).toContain('<xpath function="$calculated_property">');
	});
});

// ============================================================
// Shell 3 — wire-vocab maps
// ============================================================

describe("SORT_TYPE_WIRE_MAP", () => {
	it("maps every Nova SortType arm to the CCHQ wire vocabulary", () => {
		// Pin the four-arm translation table. Adding a SortType arm
		// without updating this map would surface as a Record-
		// exhaustiveness compile error AND a missing assertion here.
		expect(SORT_TYPE_WIRE_MAP.plain).toBe("string");
		expect(SORT_TYPE_WIRE_MAP.date).toBe("string");
		expect(SORT_TYPE_WIRE_MAP.integer).toBe("int");
		expect(SORT_TYPE_WIRE_MAP.decimal).toBe("double");
	});
});

describe("SORT_DIRECTION_WIRE_MAP", () => {
	it("maps Nova SortDirection arms to CCHQ's spelled-out attribute values", () => {
		expect(SORT_DIRECTION_WIRE_MAP.asc).toBe("ascending");
		expect(SORT_DIRECTION_WIRE_MAP.desc).toBe("descending");
	});
});
