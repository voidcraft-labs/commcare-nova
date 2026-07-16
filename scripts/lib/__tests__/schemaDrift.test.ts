/**
 * `dataTypeFromSpec` — the stored-spec inversion the drift scripts
 * classify with. The load-bearing case is the LEGACY select shape:
 * rows written while the schema generator still emitted option-value
 * enums must invert to their select type so the enum-drop deploy
 * classifies as a refinement (spec re-sync), never a spurious retype
 * that would run per-row casts across every production app.
 */

import { describe, expect, it } from "vitest";
import { dataTypeFromSpec } from "../schemaDrift";

describe("dataTypeFromSpec", () => {
	it("inverts the legacy enum-bearing select spec to single_select", () => {
		expect(dataTypeFromSpec({ type: "string", enum: ["open", "closed"] })).toBe(
			"single_select",
		);
	});

	it("inverts today's bare-string spec to text (cast-equivalent for selects)", () => {
		expect(dataTypeFromSpec({ type: "string" })).toBe("text");
	});

	it("inverts array specs to multi_select regardless of legacy item enums", () => {
		expect(dataTypeFromSpec({ type: "array", items: { type: "string" } })).toBe(
			"multi_select",
		);
	});

	it("inverts the typed scalar and format specs to their data types", () => {
		expect(
			dataTypeFromSpec({
				type: "integer",
				minimum: -2_147_483_648,
				maximum: 2_147_483_647,
			}),
		).toBe("int");
		expect(dataTypeFromSpec({ type: "number" })).toBe("decimal");
		expect(dataTypeFromSpec({ type: "string", format: "date" })).toBe("date");
		expect(dataTypeFromSpec({ type: "string", format: "time" })).toBe("time");
		expect(dataTypeFromSpec({ type: "string", format: "date-time" })).toBe(
			"datetime",
		);
	});

	it("inverts a pattern-bearing string spec to geopoint", () => {
		expect(dataTypeFromSpec({ type: "string", pattern: "^-?\\d+" })).toBe(
			"geopoint",
		);
	});

	it("a legacy enum wins over format/pattern branches (order of checks)", () => {
		// A spec carrying BOTH enum and pattern never shipped, but the
		// inversion's branch order is what the legacy classification
		// hangs on — pin it so a refactor reordering the checks fails
		// here instead of during a production drift run.
		expect(
			dataTypeFromSpec({ type: "string", enum: ["a"], pattern: "^a$" }),
		).toBe("single_select");
	});

	it("returns undefined for a spec no generator arm ever emitted", () => {
		expect(dataTypeFromSpec({ type: "string", format: "email" })).toBe(
			undefined,
		);
	});
});
