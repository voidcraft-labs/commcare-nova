import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";

import { getFormTool } from "../getForm";
import { getModuleTool } from "../getModule";

const MODULE = testUuid("loans");
const RETURN = testUuid("return");

describe("navigation through authoring reads", () => {
	it("updates the resolved destination when registration makes a case-first module a menu", async () => {
		const harness = makeToolWorkspaceHarness(
			expectAdmittedDoc(
				buildDoc({
					caseTypes: [{ name: "loan", properties: [] }],
					modules: [
						{
							uuid: "loans",
							name: "Loans",
							caseType: "loan",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Loan" },
							]),
							forms: [
								{
									uuid: "return",
									name: "Return",
									type: "close",
									postSubmit: "module",
									fields: [f({ id: "note", kind: "text" })],
								},
							],
						},
					],
				}),
			),
		);
		const before = await harness.runTool(getFormTool, {
			formUuid: RETURN,
			moduleUuid: MODULE,
		});
		if ("error" in before.data) throw new Error(before.data.error);
		expect(before.data.navigation).toMatchObject({
			recordSelection: "required",
			afterSubmit: {
				fallback: { screen: "results", withSelectedRecord: "menu" },
			},
		});
		const menuDoc = buildDoc({
			caseTypes: [{ name: "loan", properties: [] }],
			modules: [
				{
					uuid: "loans",
					name: "Loans",
					caseType: "loan",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Loan" },
					]),
					forms: [
						{
							uuid: "return",
							name: "Return",
							type: "close",
							postSubmit: "module",
							fields: [f({ id: "note", kind: "text" })],
						},
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "name",
									kind: "text",
									caseWrite: { caseType: "loan", property: "case_name" },
								}),
							],
						},
					],
				},
			],
		});
		const menuHarness = makeToolWorkspaceHarness(expectAdmittedDoc(menuDoc));

		const after = await menuHarness.runTool(getFormTool, {
			formUuid: RETURN,
			moduleUuid: MODULE,
		});
		if ("error" in after.data) throw new Error(after.data.error);
		expect(after.data.navigation?.afterSubmit.fallback).toEqual({
			screen: "menu",
			moduleUuid: MODULE,
			name: "Loans",
		});
		const module = await menuHarness.runTool(getModuleTool, {
			moduleUuid: MODULE,
		});
		if ("error" in module.data) throw new Error(module.data.error);
		expect(module.data.opening).toEqual(
			after.data.navigation?.afterSubmit.fallback,
		);
	});
});
