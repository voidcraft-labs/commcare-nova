import { describe, expect, it } from "vitest";
import { directRepeatCountReference } from "@/lib/domain/repeatCount";
import { asUuid } from "@/lib/domain/uuid";

describe("direct count identity", () => {
	const id = asUuid("11111111-1111-4111-8111-111111111111");
	it("recognizes either identity spelling with surrounding whitespace", () => {
		for (const kind of ["field-ref", "path-ref"] as const)
			expect(
				directRepeatCountReference({
					parts: [
						{ kind: "text", text: " " },
						{ kind, uuid: id },
					],
				}),
			).toBe(id);
	});
	it("keeps expressions and secondary instances behind a calculated value", () => {
		expect(
			directRepeatCountReference({
				parts: [
					{ kind: "field-ref", uuid: id },
					{ kind: "text", text: " + 1" },
				],
			}),
		).toBeUndefined();
		expect(
			directRepeatCountReference({
				parts: [{ kind: "text", text: "instance('casedb')/casedb/case/n" }],
			}),
		).toBeUndefined();
	});
});
