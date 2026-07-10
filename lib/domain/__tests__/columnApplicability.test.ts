// The shared column-kind ↔ property-type predicate — one accept-set
// for the pickers, the workspace verdicts, and the gate rule. The
// load-bearing contract is honest-unknown-permissive: only a
// POSITIVELY incompatible resolved type rejects.

import { describe, expect, it } from "vitest";
import {
	columnKindAcceptsPropertyType,
	columnKindPropertyRequirement,
} from "@/lib/domain";

describe("columnKindAcceptsPropertyType", () => {
	it("accepts every kind on an unknown type — missing metadata is not a fact", () => {
		for (const kind of [
			"plain",
			"date",
			"phone",
			"id-mapping",
			"image-map",
			"interval",
			"calculated",
		] as const) {
			expect(columnKindAcceptsPropertyType(kind, undefined)).toBe(true);
		}
	});

	it("date / interval accept date and datetime, reject the rest", () => {
		for (const kind of ["date", "interval"] as const) {
			expect(columnKindAcceptsPropertyType(kind, "date")).toBe(true);
			expect(columnKindAcceptsPropertyType(kind, "datetime")).toBe(true);
			expect(columnKindAcceptsPropertyType(kind, "text")).toBe(false);
			expect(columnKindAcceptsPropertyType(kind, "int")).toBe(false);
			expect(columnKindAcceptsPropertyType(kind, "single_select")).toBe(false);
		}
	});

	it("phone accepts text-shaped, rejects temporal and numeric", () => {
		expect(columnKindAcceptsPropertyType("phone", "text")).toBe(true);
		expect(columnKindAcceptsPropertyType("phone", "single_select")).toBe(true);
		expect(columnKindAcceptsPropertyType("phone", "date")).toBe(false);
		expect(columnKindAcceptsPropertyType("phone", "int")).toBe(false);
	});

	it("universal kinds accept every resolved type", () => {
		for (const kind of [
			"plain",
			"id-mapping",
			"image-map",
			"calculated",
		] as const) {
			expect(columnKindPropertyRequirement(kind)).toBeNull();
			expect(columnKindAcceptsPropertyType(kind, "date")).toBe(true);
			expect(columnKindAcceptsPropertyType(kind, "geopoint")).toBe(true);
		}
	});
});
