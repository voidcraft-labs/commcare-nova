import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import {
	echoLookupDefinitions,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { wireTable } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { calculatedColumn } from "@/lib/domain";
import { eq, literal, matchAll, tableLookup } from "@/lib/domain/predicate";
import { sourceSessionDatums } from "@/lib/preview/engine/formLinkEvaluation";

import { getFormTool } from "../getForm";
import { getModuleTool } from "../getModule";
import { updateFormTool } from "../updateForm";

const MODULE = testUuid("loans");
const RETURN = testUuid("return");

describe("navigation through authoring reads", () => {
	it("resolves a previous task with a valid lookup-backed case-list filter without needing wire names", async () => {
		const table = wireTable("regions", [{ name: "name", type: "text" }]);
		const doc = buildDoc({
			caseTypes: [{ name: "loan", properties: [] }],
			modules: [
				{
					uuid: "loans",
					name: "Loans",
					caseType: "loan",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						filter: eq(
							tableLookup(table.id, table.columns[0].id, matchAll()),
							literal("north"),
						),
					},
					forms: [
						{
							uuid: "return",
							name: "Return",
							type: "close",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		const definitions = echoLookupDefinitions([table]);
		const harness = makeToolWorkspaceHarness(
			expectAdmittedDoc(doc, {
				kind: "available",
				projectId: "project-test",
				projectRevision: table.definitionRevision,
				definitions: [table],
			}),
			{
				lookupDefinitions: definitions,
				lookupCatalog: () => definitions([table.id]),
			},
		);
		const result = await harness.runTool(getFormTool, {
			moduleUuid: MODULE,
			formUuid: RETURN,
		});
		if ("error" in result.data) throw new Error(result.data.error);
		expect(result.data.navigation?.afterSubmit.fallback).toMatchObject({
			screen: "menu",
			moduleUuid: MODULE,
		});
		expect([
			...sourceSessionDatums(doc, RETURN, {
				caseId: "loan-a",
				childCases: [],
			}).values(),
		]).toContainEqual({ value: "loan-a" });
	});
	it("resolves grouped tiles with lookup-backed display expressions without lowering their selectors", async () => {
		const table = wireTable("regions", [{ name: "name", type: "text" }]);
		const doc = tileFixture("grouped-one");
		const mod = Object.values(doc.modules)[0];
		const formUuid = doc.formOrder[mod.uuid][0];
		const config = mod.caseListConfig;
		if (!config) throw new Error("Missing tile configuration");
		config.filter = eq(
			tableLookup(table.id, table.columns[0].id, matchAll()),
			literal("north"),
		);
		const displayed = config.columns[1];
		config.columns[1] = calculatedColumn(
			displayed.uuid,
			"Region",
			tableLookup(table.id, table.columns[0].id, matchAll()),
			{ tile: displayed.tile },
		);
		const definitions = echoLookupDefinitions([table]);
		const harness = makeToolWorkspaceHarness(
			expectAdmittedDoc(doc, {
				kind: "available",
				projectId: "project-test",
				projectRevision: table.definitionRevision,
				definitions: [table],
			}),
			{
				lookupDefinitions: definitions,
				lookupCatalog: () => definitions([table.id]),
			},
		);
		const result = await harness.runTool(getFormTool, {
			moduleUuid: mod.uuid,
			formUuid,
		});
		if ("error" in result.data) throw new Error(result.data.error);
		expect(result.data.navigation?.afterSubmit.fallback).toMatchObject({
			screen: "record-selection",
			moduleUuid: mod.uuid,
			formUuid,
			selectingModuleUuids: [mod.uuid],
		});
		expect([
			...sourceSessionDatums(doc, formUuid, {
				caseId: "visit-a",
				childCases: [],
			}).values(),
		]).toContainEqual({ value: "visit-a" });
	});
	it("returns concrete preceding-task navigation from update and read", async () => {
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
								{ field: "case_name", header: "Name" },
							]),
							forms: [
								{
									uuid: "return",
									name: "Return",
									type: "close",
									fields: [f({ kind: "text", id: "note" })],
								},
							],
						},
					],
				}),
			),
		);
		const updated = await harness.runTool(updateFormTool, {
			moduleUuid: MODULE,
			formUuid: RETURN,
			post_submit: "previous",
		});
		if ("error" in updated.result) throw new Error(updated.result.error);
		expect(updated.result.navigation?.afterSubmit.fallback).toMatchObject({
			screen: "menu",
			moduleUuid: MODULE,
		});
		const read = await harness.runTool(getFormTool, {
			moduleUuid: MODULE,
			formUuid: RETURN,
		});
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.navigation).toEqual(updated.result.navigation);
	});
	it("qualifies an incomplete private neighbor instead of inventing its next task", async () => {
		// This is the real staged shape between createForm and addFields.
		const doc = buildDoc({
			caseTypes: [{ name: "loan", properties: [] }],
			modules: [
				{
					uuid: "loans",
					name: "Loans",
					caseType: "loan",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "return",
							name: "Return",
							type: "close",
							fields: [f({ kind: "text", id: "note" })],
						},
						{ name: "Register", type: "registration" },
					],
				},
			],
		});
		const harness = makeToolWorkspaceHarness(doc);
		const read = await harness.runTool(getFormTool, {
			moduleUuid: MODULE,
			formUuid: RETURN,
		});
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.navigation?.afterSubmit.fallback).toMatchObject({
			screen: "unavailable",
			findings: [{ code: "CASE_CREATE_NAME_MISSING", moduleUuid: MODULE }],
		});
	});
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
