import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type BreadcrumbContext, buildBreadcrumbs } from "../breadcrumbs";
import type { Location } from "../types";

const moduleUuid = testUuid("module");
const formUuid = testUuid("form");
const selected = testUuid("selected");
const context: BreadcrumbContext = {
	moduleUuid,
	formUuid,
	moduleName: "Patients",
	formName: "Register",
	moduleIsBareCaseList: false,
	parentModuleIsBareCaseList: false,
};
const home = { key: "home", label: "Home", location: { kind: "home" } };
const moduleCrumb = {
	key: `m:${moduleUuid}`,
	label: "Patients",
	location: { kind: "module", moduleUuid },
};
const formCrumb = {
	key: `f:${formUuid}`,
	label: "Register",
	location: { kind: "form", moduleUuid, formUuid },
};
const noEntities: BreadcrumbContext = {
	moduleIsBareCaseList: false,
	parentModuleIsBareCaseList: false,
};

describe("edit breadcrumbs", () => {
	it("roots app and Project administration outside the app's modules", () => {
		expect(buildBreadcrumbs({ kind: "home" }, noEntities)).toEqual([home]);
		expect(buildBreadcrumbs({ kind: "project-data" }, noEntities)).toEqual([
			home,
			{
				key: "project-data",
				label: "Project data",
				location: { kind: "project-data" },
			},
		]);
		expect(
			buildBreadcrumbs(
				{ kind: "app-setup", section: "deep-links", entryPointUuid: selected },
				noEntities,
			),
		).toEqual([
			home,
			{
				key: "app-setup",
				label: "App setup",
				location: { kind: "app-setup", section: "users" },
			},
			{
				key: "app-setup:deep-links",
				label: "Deep links",
				location: { kind: "app-setup", section: "deep-links" },
			},
		]);
	});
	it.each([
		["search-config", "Search"],
		["detail-config", "Details"],
		["data-review", "Data to review"],
		["module-condition", "When it appears"],
	] as const)("names the %s screen and its destination", (kind, label) => {
		expect(buildBreadcrumbs({ kind, moduleUuid }, context)).toEqual([
			home,
			moduleCrumb,
			{ key: `${kind}:${moduleUuid}`, label, location: { kind, moduleUuid } },
		]);
	});
	it.each([
		{ kind: "form-operations", moduleUuid, formUuid, operationUuid: selected },
		{ kind: "form-links", moduleUuid, formUuid, linkUuid: selected },
		{ kind: "form-condition", moduleUuid, formUuid },
	] satisfies Location[])(
		"keeps form ancestry for $kind without a selection crumb",
		(loc) => {
			const names = {
				"form-operations": "Case changes",
				"form-links": "After submit",
				"form-condition": "When it appears",
			};
			expect(buildBreadcrumbs(loc, context)).toEqual([
				home,
				moduleCrumb,
				formCrumb,
				{
					key: `${loc.kind}:${formUuid}`,
					label: names[loc.kind],
					location: { kind: loc.kind, moduleUuid, formUuid },
				},
			]);
		},
	);
	it("uses projected names and parent menu identity for nested forms", () => {
		const parentModuleUuid = testUuid("parent");
		expect(
			buildBreadcrumbs(
				{ kind: "form", moduleUuid, formUuid, selectedUuid: selected },
				{
					...context,
					parentModuleUuid,
					parentModuleName: "Soins",
					moduleName: "Patients français",
					formName: "Inscrire",
				},
			),
		).toEqual([
			home,
			{
				key: `m:${parentModuleUuid}`,
				label: "Soins",
				location: { kind: "module", moduleUuid: parentModuleUuid },
			},
			{ ...moduleCrumb, label: "Patients français" },
			{ ...formCrumb, label: "Inscrire" },
		]);
	});
	it("keeps Results and case detail distinct, collapsing only a bare list destination", () => {
		const loc: Location = { kind: "cases", moduleUuid, caseId: "patient/a" };
		const caseCrumb = {
			key: "case:patient/a",
			label: "patient/a",
			location: loc,
		};
		expect(buildBreadcrumbs(loc, context)).toEqual([
			home,
			moduleCrumb,
			{
				key: `cases:${moduleUuid}`,
				label: "Results",
				location: { kind: "cases", moduleUuid },
			},
			caseCrumb,
		]);
		expect(
			buildBreadcrumbs(loc, { ...context, moduleIsBareCaseList: true }),
		).toEqual([
			home,
			{ ...moduleCrumb, location: { kind: "cases", moduleUuid } },
			caseCrumb,
		]);
	});
});
