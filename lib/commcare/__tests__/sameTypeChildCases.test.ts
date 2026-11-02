/**
 * The basic children of their own menu's case type, which a publish checks
 * the project space indexes. Until a publish can check that, an unheld
 * create of that type takes Save to Case, so only a held one is listed.
 * Catches a publish that misses the check, or asks it of a Save to Case
 * child.
 */
import { describe, expect, it } from "vitest";
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
	it("lists no unheld create of the menu's own type: it takes Save to Case", () => {
		const { doc } = placementFixture("registration", {
			operations: (t) => [own({ name: read("name") }), twin(t)],
		});
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
