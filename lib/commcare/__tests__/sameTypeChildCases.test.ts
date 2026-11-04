/**
 * The basic children of their own menu's case type, which a publish checks
 * the project space indexes. An unheld create of that type takes a basic
 * subcase slot like any child, so it is listed as a held one is. Catches a
 * publish that misses the check, or asks it of a Save to Case child.
 */
import { describe, expect, it } from "vitest";
import { planPlacements } from "@/lib/commcare/placement";
import { sameTypeBasicChildCases } from "@/lib/commcare/sameTypeChildCases";
import type { CaseOperation, Form } from "@/lib/domain";
import {
	childCreate,
	OP,
	own,
	placementFixture,
	read,
} from "./placementFixture";

const twin = (
	formType: Form["type"],
	extra: Partial<CaseOperation> = {},
): CaseOperation =>
	({
		...childCreate("twin", formType),
		caseType: "patient",
		...extra,
	}) as CaseOperation;

describe("sameTypeBasicChildCases", () => {
	it("lists an unheld create of the menu's own type, with what the form does to its own case", () => {
		const registers = placementFixture("registration", {
			operations: (t) => [own({ name: read("name") }), twin(t)],
		});
		expect(sameTypeBasicChildCases(registers.doc)).toEqual([
			{
				formUuid: registers.formUuid,
				operationUuid: OP("twin"),
				caseType: "patient",
				ownCase: "registers",
			},
		]);
		const worksOn = placementFixture("followup", {
			operations: (t) => [own(), twin(t)],
		});
		expect(sameTypeBasicChildCases(worksOn.doc)).toEqual([
			{
				formUuid: worksOn.formUuid,
				operationUuid: OP("twin"),
				caseType: "patient",
				ownCase: "works-on",
			},
		]);
	});

	it("lists no create of its own type placed in Save to Case", () => {
		// A write that carries a condition keeps a create out of every basic slot.
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own(),
				twin(t, {
					writes: [
						{ property: "age", value: read("age"), condition: read("flag") },
					],
				}),
			],
		});
		expect(
			planPlacements(doc, formUuid).placements.get(OP("twin"))?.placement.kind,
		).toBe("save-to-case");
		expect(sameTypeBasicChildCases(doc)).toEqual([]);
	});

	it("lists one held in a basic subcase slot, with what the form does to its own case", () => {
		const held = { kind: "basic", slot: "subcase", index: 0 } as const;
		const registers = placementFixture("registration", {
			operations: (t) => [
				own({ name: read("name") }),
				twin(t, { placement: held }),
			],
		});
		expect(sameTypeBasicChildCases(registers.doc)).toEqual([
			{
				formUuid: registers.formUuid,
				operationUuid: OP("twin"),
				caseType: "patient",
				ownCase: "registers",
			},
		]);
		const worksOn = placementFixture("followup", {
			operations: (t) => [own(), twin(t, { placement: held })],
		});
		expect(sameTypeBasicChildCases(worksOn.doc)).toMatchObject([
			{ operationUuid: OP("twin"), ownCase: "works-on" },
		]);
	});

	it("lists no basic child of another type", () => {
		const { doc } = placementFixture("followup", {
			operations: (t) => [own(), childCreate("kid", t)],
		});
		expect(sameTypeBasicChildCases(doc)).toEqual([]);
	});
});
