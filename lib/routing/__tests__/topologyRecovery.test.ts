import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Module, Uuid } from "@/lib/domain";
import { formerParentRecovery } from "@/lib/routing/topologyRecovery";

const PARENT = testUuid("parent00-0000-4000-8000-000000000001");
const CHILD = testUuid("child000-0000-4000-8000-000000000002");
const FORM = testUuid("form0000-0000-4000-8000-000000000003");

function module(uuid: Uuid, name: string, extra: Partial<Module> = {}): Module {
	return { uuid, id: name.toLowerCase(), name, ...extra };
}

describe("formerParentRecovery", () => {
	it("recovers a remotely deleted child form to its surviving former parent", () => {
		const previousModules = {
			[PARENT]: module(PARENT, "Care"),
			[CHILD]: module(CHILD, "Visits", { parentModuleUuid: PARENT }),
		};
		expect(
			formerParentRecovery(
				[FORM],
				{
					location: { kind: "form", moduleUuid: CHILD, formUuid: FORM },
					modules: previousModules,
				},
				{ [PARENT]: previousModules[PARENT] },
			),
		).toEqual({ kind: "module", moduleUuid: PARENT });
	});

	it("recovers to Results when the surviving parent is a bare case list", () => {
		const parent = module(PARENT, "Care", { caseListOnly: true });
		const child = module(CHILD, "Visits", { parentModuleUuid: PARENT });
		expect(
			formerParentRecovery(
				[CHILD],
				{
					location: { kind: "module", moduleUuid: CHILD },
					modules: { [PARENT]: parent, [CHILD]: child },
				},
				{ [PARENT]: parent },
			),
		).toEqual({ kind: "cases", moduleUuid: PARENT });
	});

	it("recovers to the menu when a case-list-only parent still has a child", () => {
		const parent = module(PARENT, "Care", { caseListOnly: true });
		const deleted = module(CHILD, "Visits", { parentModuleUuid: PARENT });
		const survivingChildUuid = testUuid("surviving-child");
		const survivingChild = module(survivingChildUuid, "Referrals", {
			parentModuleUuid: PARENT,
		});
		expect(
			formerParentRecovery(
				[CHILD],
				{
					location: { kind: "module", moduleUuid: CHILD },
					modules: {
						[PARENT]: parent,
						[CHILD]: deleted,
						[survivingChildUuid]: survivingChild,
					},
				},
				{
					[PARENT]: parent,
					[survivingChildUuid]: survivingChild,
				},
			),
		).toEqual({ kind: "module", moduleUuid: PARENT });
	});

	it("recovers a deleted root to Home", () => {
		const root = module(PARENT, "Care");
		expect(
			formerParentRecovery(
				[PARENT],
				{
					location: { kind: "module", moduleUuid: PARENT },
					modules: { [PARENT]: root },
				},
				{},
			),
		).toEqual({ kind: "home" });
	});

	it("does not apply stale ancestry after an intentional URL change", () => {
		const parent = module(PARENT, "Care");
		const child = module(CHILD, "Visits", { parentModuleUuid: PARENT });
		expect(
			formerParentRecovery(
				["some-other-route"],
				{
					location: { kind: "module", moduleUuid: CHILD },
					modules: { [PARENT]: parent, [CHILD]: child },
				},
				{ [PARENT]: parent },
			),
		).toBeUndefined();
	});
});
