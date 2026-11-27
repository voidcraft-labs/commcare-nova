import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { caseListModuleMutations } from "@/lib/doc/scaffolds";
import { sharedChildUuid } from "@/lib/doc/sharedFormChildren";
import { withListedMenuHierarchy } from "@/lib/doc/sharedMenuHierarchy";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	entryDatumSupplies,
	entryPointInventory,
	menuFormUuidsOf,
	moduleIsCaseFirst,
	moduleUuidOfForm,
} from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/expression";
import { menuScreenEntries } from "@/lib/domain/menuScreens";
import { buildUrl, parsePathToLocation } from "@/lib/routing/location";
import { compileCcz } from "../compiler";
import { projectEntryPoint } from "../entryPointProjection";
import { expandDoc } from "../expander";
import {
	entryDatumIds,
	entrySessionDatums,
	formCommandId,
	formLinkProjectionContext,
	menuIdOf,
	moduleIndexOf,
	owningModuleOf,
	projectAfterSubmit,
} from "../formLinkProjection";
import { readMenusOf } from "../reader/menus/__tests__/menuReading";
import { runValidation } from "../validator/runner";
import {
	REGISTER,
	ROUTE,
	SOURCE,
	twoMenus,
	VISIT,
} from "./menuFormRoutesFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

function commit(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	return verdict.nextDoc;
}

describe("a form listed in a second menu", () => {
	it("checks the one shared form condition against every screen that can list it", () => {
		const doc = twoMenus();
		const base = mutationCommitVerdict(
			doc,
			[{ kind: "removeForm", uuid: REGISTER }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!base.ok) throw new Error(JSON.stringify(base.findings));
		const withCondition = structuredClone(base.nextDoc);
		withCondition.forms[VISIT].displayCondition = eq(
			prop("patient", "status"),
			literal("open"),
		);
		expect(runValidation(withCondition, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual(
			[],
		);
		const opened = mutationCommitVerdict(
			withCondition,
			[
				{
					kind: "updateModule",
					uuid: ROUTE,
					patch: { formsInMenuAbove: true },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(opened).toMatchObject({
			ok: false,
			findings: expect.arrayContaining([
				expect.objectContaining({
					code: "FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE",
					location: expect.objectContaining({
						moduleUuid: ROUTE,
						formUuid: VISIT,
					}),
				}),
			]),
		});
	});

	it("creates and edits the same source forms through the shared authoring tools with independent per-menu exclusions", async () => {
		const doc = twoMenus();
		const { makeToolWorkspaceHarness } = await import(
			"@/lib/agent/__tests__/fixtures"
		);
		const { expectAdmittedDoc } = await import(
			"@/lib/agent/__tests__/admittedFixture"
		);
		const { createModuleTool } = await import("@/lib/agent/tools/createModule");
		const { updateModuleTool } = await import("@/lib/agent/tools/updateModule");
		const { getModuleTool } = await import("@/lib/agent/tools/getModule");
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));
		const uuid = testUuid("visits-today");
		const created = await h.runTool(createModuleTool, {
			moduleUuid: uuid,
			name: "Visits today",
			forms_from_menu: { menuUuid: SOURCE, excludedFormUuids: [REGISTER] },
		});
		if ("error" in created.result) throw new Error(created.result.error);
		const visible = await h.runTool(getModuleTool, { moduleUuid: uuid });
		if ("error" in visible.data) throw new Error(visible.data.error);
		expect(visible.data.forms.map((form) => form.uuid)).toEqual([VISIT]);
		expect(visible.data.case_type).toBe("patient");
		expect(visible.data.forms_from_menu).toEqual({
			menuUuid: SOURCE,
			name: "Patients",
			excludedFormUuids: [REGISTER],
		});
		const changes = await h.runTool(updateModuleTool, {
			moduleUuid: uuid,
			listed_form: {
				sourceMenuUuid: SOURCE,
				formUuid: REGISTER,
				included: true,
			},
		});
		if ("error" in changes.result) throw new Error(changes.result.error);
		expect(menuFormUuidsOf(h.currentDoc(), uuid)).toEqual([REGISTER, VISIT]);
		expect(menuFormUuidsOf(h.currentDoc(), ROUTE)).toEqual([VISIT]);
		expect(Object.keys(h.currentDoc().forms)).toHaveLength(2);
	});

	it("keeps a hidden form link dormant, and refuses a duplicate or whitespace id at its actual menu", async () => {
		const hidden = await readMenusOf(twoMenus(), (app) => {
			const route = app.modules[0];
			const source = app.modules[1];
			route.excluded_form_ids = source.forms.map((form) => form.unique_id);
		});
		expect(hidden.findings).toEqual([]);
		const doc = hidden.doc;
		if (!doc) throw new Error("Missing app containing a paused form link.");
		const route = Object.values(doc.modules).find(
			(module) => module.name === "Clinic",
		);
		if (!route) throw new Error("Missing clinic menu.");
		expect(menuFormUuidsOf(doc, route.uuid)).toEqual([]);
		expect(route.formsFromMenu?.entryPoints?.[0]?.entryPoint.id).toBe(
			"clinic-visit",
		);
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		expect(zip.readAsText("suite.xml")).not.toContain('id="clinic-visit"');
		for (const [id, entry] of [
			[
				"visit",
				"two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form",
			],
			[
				" clinic-visit ",
				"a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding",
			],
		]) {
			const read = await readMenusOf(twoMenus(), (app) => {
				(
					app.modules[0].form_session_endpoints as {
						session_endpoint_id: string;
					}[]
				)[0].session_endpoint_id = id;
			});
			expect(read.outcome.defects).toEqual([]);
			expect(read.findings.map((finding) => finding.code)).toEqual([
				`menus-and-case-lists/${entry}`,
			]);
		}
	});
	it("leaves a menu that lists no visible form out of the suite and the running screens, as HQ's build does", () => {
		const doc = twoMenus();
		const route = doc.modules[ROUTE].formsFromMenu;
		if (!route) throw new Error("Missing the listed-forms source.");
		route.excludedFormUuids = [REGISTER, VISIT];
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const ctx = formLinkProjectionContext(doc);
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const xml = new DOMParser().parseFromString(
			zip.readAsText("suite.xml"),
			"application/xml",
		);
		expect(
			Array.from(xml.getElementsByTagName("menu")).map((menu) =>
				menu.getAttribute("id"),
			),
		).toEqual([`m${moduleIndexOf(ctx, SOURCE)}`]);
		expect(menuScreenEntries(doc, { kind: "first-menu" })).toEqual([
			{ kind: "menu", moduleUuid: SOURCE },
		]);
		// Its own deep link waits, as its form links do, until a form shows.
		expect(
			Array.from(xml.getElementsByTagName("endpoint")).map((endpoint) =>
				endpoint.getAttribute("id"),
			),
		).toEqual(["visit"]);
		const linked = structuredClone(doc);
		linked.forms[VISIT].formLinks = [
			{
				uuid: testUuid("open-empty-clinic"),
				target: { type: "module", moduleUuid: ROUTE },
			},
		];
		expect(
			runValidation(linked, LOOKUP_CONTEXT_UNAVAILABLE).map(
				(finding) => finding.message,
			),
		).toContain(
			"Show a form in “Clinic” so the link after “Visit” has a menu to open.",
		);
	});

	it("names a submenu under the listing menu with its parent's suffix in the menu and every stack that opens it, as HQ's build does", () => {
		const twins = twoMenus();
		const neighborhood = caseListModuleMutations(twins, {
			caseType: "patient",
			name: "Neighborhood",
			parentModuleUuid: SOURCE,
		});
		const scaffolded = commit(
			twins,
			withListedMenuHierarchy(twins, neighborhood.mutations),
		);
		const moved = commit(scaffolded, [
			{
				kind: "moveForm",
				uuid: VISIT,
				toModuleUuid: neighborhood.moduleUuid,
				after: null,
			},
			{
				kind: "updateModule",
				uuid: ROUTE,
				patch: {},
				listedForm: { sourceUuid: SOURCE, formUuid: REGISTER, included: true },
			},
		]);
		const doc = structuredClone(moved);
		const child = sharedChildUuid(ROUTE, neighborhood.moduleUuid);
		doc.forms[REGISTER].formLinks = [
			{
				uuid: testUuid("open-clinic-neighborhood"),
				target: { type: "form", moduleUuid: child, formUuid: VISIT },
			},
		];
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const ctx = formLinkProjectionContext(doc);
		const route = `m${moduleIndexOf(ctx, ROUTE)}`;
		const childId = `m${moduleIndexOf(ctx, child)}.${route}`;
		const sourceChild = `m${moduleIndexOf(ctx, neighborhood.moduleUuid)}`;
		expect(menuIdOf(doc, ctx, child)).toBe(childId);
		const xml = new DOMParser().parseFromString(
			new AdmZip(
				compileCcz(expandDoc(doc), doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			).readAsText("suite.xml"),
			"application/xml",
		);
		const menus = Array.from(xml.getElementsByTagName("menu")).map((menu) => [
			menu.getAttribute("id"),
			menu.getAttribute("root"),
		]);
		const source = `m${moduleIndexOf(ctx, SOURCE)}`;
		expect(menus).toContainEqual([childId, route]);
		expect(menus).toContainEqual([sourceChild, source]);
		const stacks = Array.from(xml.getElementsByTagName("stack"));
		const stackCommands = stacks.flatMap((stack) =>
			Array.from(stack.getElementsByTagName("command")).map((command) =>
				command.getAttribute("value"),
			),
		);
		expect(stackCommands).toContain(`'${childId}'`);

		const hidden = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateModule",
					uuid: ROUTE,
					patch: {},
					listedForm: {
						sourceUuid: SOURCE,
						formUuid: REGISTER,
						included: false,
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(hidden).toMatchObject({
			ok: false,
			findings: expect.arrayContaining([
				expect.objectContaining({
					code: "MENU_FORM_SOURCE_INVALID",
					message:
						"Show a form in “Clinic” so workers can reach “Neighborhood” inside it.",
				}),
			]),
		});
	});

	it("keeps one form, its owning menu and ordinary bypass while listing the same namespace and separate deep link through Clinic", () => {
		const doc = twoMenus();
		expect(menuFormUuidsOf(doc, ROUTE)).toEqual([VISIT]);
		expect(menuFormUuidsOf(doc, SOURCE)).toEqual([REGISTER, VISIT]);
		expect(moduleUuidOfForm(doc, VISIT)).toBe(SOURCE);
		expect(moduleIsCaseFirst(doc, ROUTE)).toBe(true);
		expect(moduleIsCaseFirst(doc, SOURCE)).toBe(false);
		expect(
			entryPointInventory(doc).map(({ target, entryPoint }) => [
				target.moduleUuid,
				entryPoint.id,
				entryPoint.ignoreDisplayConditions,
			]),
		).toEqual([
			[ROUTE, "clinic", undefined],
			[ROUTE, "clinic-visit", undefined],
			[SOURCE, "visit", true],
		]);
	});

	it("opens the listing menu's own deep link over every form of its source, as HQ's endpoint builder does", () => {
		// `get_frame_children(module, None)` on a ShadowModule reads the
		// SOURCE's entries, including the registration the menu leaves out,
		// so the common prefix is empty and the link takes no case.
		const projection = projectEntryPoint(twoMenus(), {
			kind: "module",
			moduleUuid: ROUTE,
		});
		expect(projection.requiredSelections).toEqual([]);
		expect(projection.frame).toEqual([{ type: "command", id: "m0" }]);
	});

	it("publishes one source XForm, and both local suite commands point to that same form with the source label", () => {
		const doc = twoMenus();
		const hq = expandDoc(doc);
		const [mirror, source] = hq.modules;
		expect(mirror.doc_type).toBe("ShadowModule");
		expect(mirror).toMatchObject({
			shadow_module_version: 2,
			source_module_id: source.unique_id,
			forms: [],
			excluded_form_ids: [source.forms[0].unique_id],
			form_session_endpoints: [
				{
					form_id: source.forms[1].unique_id,
					session_endpoint_id: "clinic-visit",
				},
			],
		});
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const xml = new DOMParser().parseFromString(
			zip.readAsText("suite.xml"),
			"application/xml",
		);
		const entries = Array.from(xml.getElementsByTagName("entry")).filter(
			(entry) =>
				entry.getElementsByTagName("form")[0]?.textContent ===
				source.forms[1].xmlns,
		);
		expect(
			entries.map((entry) =>
				entry.getElementsByTagName("command")[0]?.getAttribute("id"),
			),
		).toEqual(["m0-f1", "m1-f1"]);
		expect(
			entries.map((entry) =>
				entry.getElementsByTagName("locale")[0]?.getAttribute("id"),
			),
		).toEqual(["forms.m1f1", "forms.m1f1"]);
		expect(xml.getElementsByTagName("xform")).toHaveLength(2);
		const endpoints = Array.from(xml.getElementsByTagName("endpoint")).map(
			(el) => el.getAttribute("id"),
		);
		expect(endpoints).toEqual(
			expect.arrayContaining(["clinic", "clinic-visit", "visit"]),
		);
	});

	it("round-trips the worker route and keeps its form link paused when the menu link is removed", () => {
		const doc = twoMenus();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const current = {
			kind: "form" as const,
			moduleUuid: ROUTE,
			formUuid: VISIT,
		};
		const path = buildUrl("/build/one", current, doc);
		expect(path).toBe(`/build/one/${ROUTE}/forms/${VISIT}`);
		expect(
			parsePathToLocation(path.slice("/build/one/".length).split("/"), doc),
		).toEqual(current);
		expect(parsePathToLocation([ROUTE, "forms", REGISTER], doc)).toEqual({
			kind: "module",
			moduleUuid: ROUTE,
		});
		delete doc.modules[ROUTE].entryPoint;
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(
			entryPointInventory(doc).some(
				(row) => row.entryPoint.id === "clinic-visit",
			),
		).toBe(true);
		const hq = expandDoc(doc);
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		expect(zip.readAsText("suite.xml")).not.toContain('id="clinic-visit"');
	});

	it("keeps explicit and current form routes across a worker’s after-submit frame, publish and read-back", async () => {
		const doc = twoMenus();
		doc.forms[VISIT].formLinks = [
			{ uuid: testUuid("visit-again"), target: { type: "this-form" } },
		];
		doc.forms[REGISTER].formLinks = [
			{
				uuid: testUuid("open-clinic"),
				target: { type: "form", moduleUuid: ROUTE, formUuid: VISIT },
			},
		];
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const ctx = formLinkProjectionContext(doc);
		for (const [source, form, route, command] of [
			[ROUTE, VISIT, ROUTE, "m0-f1"],
			[SOURCE, VISIT, SOURCE, "m1-f1"],
			[SOURCE, REGISTER, ROUTE, "m0-f1"],
		] as const) {
			const link = projectAfterSubmit(doc, ctx, form, source)?.links[0];
			expect(link?.target).toEqual({
				type: "form",
				moduleUuid: route,
				formUuid: VISIT,
			});
			expect(link?.children).toContainEqual({ type: "command", id: command });
		}
		const hq = expandDoc(doc);
		expect(hq.modules[1].forms[0].form_links?.[0]).toMatchObject({
			form_id: hq.modules[1].forms[1].unique_id,
			form_module_id: hq.modules[0].unique_id,
		});
		const read = await readMenusOf(doc);
		expect(read.outcome.defects).toEqual([]);
		expect(read.findings).toEqual([]);
		if (!read.doc) throw new Error("Missing app after the route read.");
		const route = Object.values(read.doc.modules).find(
			(menu) => menu.name === "Clinic",
		);
		const register = Object.values(read.doc.forms).find(
			(form) => form.name === "Register",
		);
		const visit = Object.values(read.doc.forms).find(
			(form) => form.name === "Visit",
		);
		expect(register?.formLinks?.[0]?.target).toEqual({
			type: "form",
			moduleUuid: route?.uuid,
			formUuid: visit?.uuid,
		});
		expect(visit?.formLinks?.[0]?.target).toEqual({ type: "this-form" });
	});

	it("reads the second menu and both distinct links back to the one source form", async () => {
		const read = await readMenusOf(twoMenus());
		expect(read.outcome.defects).toEqual([]);
		expect(read.findings).toEqual([]);
		const doc = read.doc;
		if (!doc) throw new Error("The two-menu source did not read.");
		const owner = Object.values(doc.modules).find(
			(menu) => menu.name === "Patients",
		);
		const route = Object.values(doc.modules).find(
			(menu) => menu.name === "Clinic",
		);
		const form = Object.values(doc.forms).find((f) => f.name === "Visit");
		expect(route?.formsFromMenu?.menuUuid).toBe(owner?.uuid);
		expect(
			route?.formsFromMenu?.entryPoints?.find(
				(row) => row.formUuid === form?.uuid,
			)?.entryPoint.id,
		).toBe("clinic-visit");
		expect(form?.entryPoint?.id).toBe("visit");
	});

	it("uses the route menu in the command and detail, the original form ordinal, and the source selection read by the form", () => {
		const doc = twoMenus();
		const ctx = formLinkProjectionContext(doc);
		expect(owningModuleOf(ctx, VISIT)).toBe(SOURCE);
		expect(formCommandId(ctx, ROUTE, VISIT)).toBe(
			`m${moduleIndexOf(ctx, ROUTE)}-f1`,
		);
		expect(() => formCommandId(ctx, ROUTE, REGISTER)).toThrow();
		expect(
			entryDatumSupplies(doc, { kind: "form", module: ROUTE, form: VISIT })
				.refs,
		).toEqual([
			{ ref: { kind: "selected-case", module: ROUTE }, scalar: true },
			{ ref: { kind: "selected-case", module: SOURCE }, scalar: true },
		]);
		const original = entrySessionDatums(doc, ctx, SOURCE, VISIT);
		const route = entrySessionDatums(doc, ctx, ROUTE, VISIT);
		const originalChoice = original.find((d) => d.id === "case_id");
		const routeChoice = route.find((d) => d.id === "case_id");
		expect(originalChoice?.detailSelect).toBe(
			`m${moduleIndexOf(ctx, SOURCE)}_case_short`,
		);
		expect(routeChoice?.detailSelect).toBe(
			`m${moduleIndexOf(ctx, ROUTE)}_case_short`,
		);
		expect(
			entryDatumIds(doc, ctx, ROUTE, VISIT).find((d) => d.id === "case_id")
				?.refs,
		).toEqual([
			{ kind: "selected-case", module: ROUTE },
			{ kind: "selected-case", module: SOURCE },
		]);
	});
});

describe("a badge on a form listed in a second menu", () => {
	it("names one badge text, the source menu's, on each menu's command for the form", () => {
		const doc = twoMenus();
		doc.forms[VISIT].badge = { kind: "text", text: "Due" };
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const ctx = formLinkProjectionContext(doc);
		const source = moduleIndexOf(ctx, SOURCE);
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const xml = new DOMParser().parseFromString(
			zip.readAsText("suite.xml"),
			"application/xml",
		);
		const badges = Array.from(xml.getElementsByTagName("entry")).flatMap(
			(entry) => {
				const command = entry.getElementsByTagName("command")[0];
				return Array.from(command?.getElementsByTagName("text") ?? [])
					.filter((text) => text.getAttribute("form") === "badge")
					.map((text) => [
						command?.getAttribute("id"),
						text.getElementsByTagName("locale")[0]?.getAttribute("id"),
					]);
			},
		);
		// HQ keys a form's badge by the form's own menu (`id_strings.py::form_custom_icon_locale`
		// reads `form.get_module()`), so the second menu's command names the source's text.
		expect(badges).toHaveLength(2);
		for (const [, locale] of badges)
			expect(locale).toBe(`forms.m${source}f1.badge`);
		expect(
			zip
				.readAsText("default/app_strings.txt")
				.split("\n")
				.filter((line) => line.startsWith(`forms.m${source}f1.badge=`)),
		).toEqual([`forms.m${source}f1.badge=Due`]);
	});
});
