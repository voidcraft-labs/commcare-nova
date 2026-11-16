/**
 * Both exports of a case list that always offers another menu's
 * registration form, read back by the HQ JSON and suite oracles, with the
 * Register action and the two frame shapes held to HQ's own fixture for the
 * same shape (`corehq/apps/app_manager/tests/data/case_list_form/case-list-form-suite.xml`,
 * `test_case_list_form.py::test_case_list_registration_form`): a follow-up
 * menu `m0` whose list offers `m1`'s registration form, returning with the
 * new case chosen.
 */
import AdmZip from "adm-zip";
import type { Element } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { requiredProjectSpaceCapabilities } from "@/lib/commcare/projectSpaceCompatibility";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { parseXml } from "@/lib/commcare/xmlParse";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type {
	AlwaysOfferedRegistration,
	BlueprintDoc,
	PostSubmitDestination,
} from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { manifestFor } from "./compilerEvidence";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

const HOST = testUuid("host");
const REGISTER_FORM = testUuid("register-form");
const ICON = asMediaAssetId(testUuid("register-icon"));
const AUDIO = asMediaAssetId(testUuid("register-audio"));

function registerFromListDoc(
	slot: Omit<AlwaysOfferedRegistration, "kind" | "formUuid">,
	options: {
		readonly search?: boolean;
		readonly hostForms?: boolean;
		readonly formPostSubmit?: PostSubmitDestination;
	} = {},
): BlueprintDoc {
	const list = caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		appName: "Register from list",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "host",
				name: "Patients",
				caseType: "patient",
				caseListConfig:
					options.search === true
						? {
								...list,
								searchInputs: [
									{
										uuid: testUuid("search-name"),
										kind: "simple",
										type: "text",
										name: "name",
										label: "Name",
										property: "case_name",
									},
								],
							}
						: list,
				...(options.hostForms === false
					? { caseListMenuItem: {} }
					: {
							forms: [
								{
									uuid: "visit",
									name: "Visit",
									type: "followup" as const,
									fields: [
										f({ kind: "text", id: "note", label: proseText("Note") }),
									],
								},
							],
						}),
			},
			{
				uuid: "register-menu",
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "register-form",
						name: "Register patient",
						type: "registration" as const,
						...(options.formPostSubmit !== undefined && {
							postSubmit: options.formPostSubmit,
						}),
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[HOST].caseListRegistrationForm = {
		kind: "always",
		formUuid: REGISTER_FORM,
		...slot,
	};
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

function compiled(doc: BlueprintDoc) {
	const assets = manifestFor(doc);
	const hq = expandDoc(doc, { assets });
	expect(validateHqJson(hq)).toEqual([]);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
			assets,
		}),
	);
	const read = (path: string) => {
		const entry = zip.getEntry(path);
		if (entry === null) throw new Error(`The archive has no ${path}.`);
		return entry.getData().toString("utf8");
	};
	const suite = read("suite.xml");
	const strings = new Map<string, string>();
	for (const line of read("default/app_strings.txt").split("\n")) {
		const at = line.indexOf("=");
		if (at >= 0) strings.set(line.slice(0, at), line.slice(at + 1));
	}
	expect(
		validateSuite(suite, new Set(strings.keys()), {
			appStringValues: strings,
			manifest: new Set([...assets.values()].map((a) => a.wirePath)),
		}),
	).toEqual([]);
	return { hq, suiteDoc: parseXml(suite), strings, assets };
}

function childElements(element: Element, name?: string): Element[] {
	return getChildren(element).filter(
		(child): child is Element =>
			child.type === "tag" && (name === undefined || child.name === name),
	);
}

function byName(root: { children: unknown[] }, name: string): Element[] {
	return findAll(
		(element) => element.name === name,
		root.children as Parameters<typeof findAll>[1],
	);
}

function detail(suiteDoc: ReturnType<typeof parseXml>, id: string): Element {
	const found = byName(suiteDoc, "detail").filter(
		(element) => getAttributeValue(element, "id") === id,
	);
	expect(found).toHaveLength(1);
	return found[0] as Element;
}

function entry(suiteDoc: ReturnType<typeof parseXml>, command: string) {
	const found = byName(suiteDoc, "entry").filter((element) =>
		childElements(element, "command").some(
			(child) => getAttributeValue(child, "id") === command,
		),
	);
	expect(found).toHaveLength(1);
	return found[0] as Element;
}

function frames(element: Element) {
	return childElements(element, "stack").flatMap((stack) =>
		childElements(stack, "create").map((create) => ({
			if: create.attribs.if,
			children: childElements(create).map((child) => ({
				name: child.name,
				...(child.attribs.id !== undefined && { id: child.attribs.id }),
				value: child.attribs.value,
			})),
		})),
	);
}

/** The action's push as `{name, id?, value}`, and its display's locales. */
function registerAction(action: Element) {
	const display = childElements(action, "display")[0] as Element;
	const push = childElements(
		childElements(action, "stack")[0] as Element,
		"push",
	)[0] as Element;
	return {
		relevant: action.attribs.relevant,
		display: childElements(display, "text").map((text) => ({
			form: text.attribs.form,
			locale: getAttributeValue(
				childElements(text, "locale")[0] as Element,
				"id",
			),
		})),
		push: childElements(push).map((child) => ({
			name: child.name,
			...(child.attribs.id !== undefined && { id: child.attribs.id }),
			value: child.attribs.value,
		})),
	};
}

const HOUSES = testUuid("houses");
const PEOPLE = testUuid("people");
const REGISTER_PERSON = testUuid("register-person");

/** HQ's `test_case_list_form_parent_child_submodule_basic` shape: a menu of
 *  houses whose forms open a house, a submenu of people under it that
 *  chooses the house first, and a menu whose registration form opens a
 *  person under a chosen house, which the people's list always offers. */
function submenuHostDoc(afterSubmit: AlwaysOfferedRegistration["afterSubmit"]) {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		appName: "Register into a submenu",
		caseTypes: [
			{ name: "house", properties: [] },
			{ name: "person", parent_type: "house", properties: [] },
		],
		modules: [
			{
				uuid: "houses",
				name: "Update house",
				caseType: "house",
				caseListConfig: list(),
				forms: [
					{
						name: "Update house",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "people",
				name: "Update person",
				caseType: "person",
				parentCaseModuleUuid: "houses",
				caseListConfig: list(),
				forms: [
					{
						name: "Update person",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "register-people",
				name: "Register person",
				caseType: "person",
				parentCaseModuleUuid: "houses",
				caseListConfig: list(),
				forms: [
					{
						uuid: "register-person",
						name: "Register person",
						type: "registration" as const,
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "person", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[PEOPLE] = { ...doc.modules[PEOPLE], parentModuleUuid: HOUSES };
	doc.modules[PEOPLE].caseListRegistrationForm = {
		kind: "always",
		formUuid: REGISTER_PERSON,
		afterSubmit,
	};
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

const RETURN_TO =
	"count(instance('commcaresession')/session/data/return_to) = 1 and instance('commcaresession')/session/data/return_to = 'm0'";
const NEW_CASE =
	"instance('commcaresession')/session/data/case_id_new_patient_0";
const NEW_CASE_ROW = `count(instance('casedb')/casedb/case[@case_id = ${NEW_CASE}])`;

describe("a case list that always offers another menu's registration form", () => {
	it("writes HQ's case_list_form on the host, with no hidden module and no relevancy", () => {
		const { hq } = compiled(
			registerFromListDoc({ label: "New patient", afterSubmit: "new-case" }),
		);
		expect(hq.modules).toHaveLength(2);
		const [host, registration] = hq.modules;
		expect(host?.case_list_form).toEqual({
			doc_type: "CaseListForm",
			form_id: registration?.forms[0]?.unique_id,
			label: { en: "New patient" },
			post_form_workflow: "default",
			media_image: {},
			media_audio: {},
		});
		expect(hq.add_ons?.register_from_case_list).toBe(true);
	});

	it("writes `case_list` for Back to this list and the form's name with no label", () => {
		const { hq } = compiled(registerFromListDoc({ afterSubmit: "case-list" }));
		expect(hq.modules[0]?.case_list_form).toMatchObject({
			label: { en: "Register patient" },
			post_form_workflow: "case_list",
		});
	});

	it("mounts HQ's Register action on the host's case list, pushing the form's own command", () => {
		const { suiteDoc, strings } = compiled(
			registerFromListDoc({ label: "New patient", afterSubmit: "new-case" }),
		);
		const actions = childElements(detail(suiteDoc, "m0_case_short"), "action");
		expect(actions).toHaveLength(1);
		expect(registerAction(actions[0] as Element)).toEqual({
			relevant: undefined,
			display: [{ form: undefined, locale: "case_list_form.m0" }],
			push: [
				{ name: "command", value: "'m1-f0'" },
				{ name: "datum", id: "case_id_new_patient_0", value: "uuid()" },
				{ name: "datum", id: "return_to", value: "'m0'" },
			],
		});
		expect(strings.get("case_list_form.m0")).toBe("New patient");
	});

	it("writes HQ's two `default` frames on the offered form's entry", () => {
		const { suiteDoc } = compiled(
			registerFromListDoc({ afterSubmit: "new-case" }),
		);
		expect(frames(entry(suiteDoc, "m1-f0"))).toEqual([
			{
				if: `${RETURN_TO} and ${NEW_CASE_ROW} > 0`,
				children: [
					{ name: "command", value: "'m0'" },
					{ name: "datum", id: "case_id", value: NEW_CASE },
				],
			},
			{
				if: `${RETURN_TO} and ${NEW_CASE_ROW} = 0`,
				children: [{ name: "command", value: "'m0'" }],
			},
		]);
	});

	it("writes one `case_list` frame, cut before the case the form creates", () => {
		const { suiteDoc } = compiled(
			registerFromListDoc({ afterSubmit: "case-list" }),
		);
		expect(frames(entry(suiteDoc, "m1-f0"))).toEqual([
			{ if: RETURN_TO, children: [{ name: "command", value: "'m0'" }] },
		]);
	});

	it("returns a host with no forms to its command alone, under either choice", () => {
		const { suiteDoc } = compiled(
			registerFromListDoc({ afterSubmit: "new-case" }, { hostForms: false }),
		);
		expect(frames(entry(suiteDoc, "m1-f0"))).toEqual([
			{
				if: `${RETURN_TO} and ${NEW_CASE_ROW} > 0`,
				children: [{ name: "command", value: "'m0'" }],
			},
			{
				if: `${RETURN_TO} and ${NEW_CASE_ROW} = 0`,
				children: [{ name: "command", value: "'m0'" }],
			},
		]);
	});

	it("writes no return frame where the form's own after-submit is in force", () => {
		const { hq, suiteDoc } = compiled(
			registerFromListDoc(
				{ afterSubmit: "new-case" },
				{ formPostSubmit: "firstMenu" },
			),
		);
		expect(hq.modules[0]?.case_list_form.post_form_workflow).toBe("default");
		const written = frames(entry(suiteDoc, "m1-f0"));
		expect(written.every((frame) => !frame.if?.includes("return_to"))).toBe(
			true,
		);
	});

	it("puts the action on the search results list too, before the Search action", () => {
		const { suiteDoc } = compiled(
			registerFromListDoc({ afterSubmit: "case-list" }, { search: true }),
		);
		for (const id of ["m0_case_short", "m0_search_short"]) {
			const actions = childElements(detail(suiteDoc, id), "action");
			expect(actions.length).toBeGreaterThan(0);
			expect(registerAction(actions[0] as Element).push[0]).toEqual({
				name: "command",
				value: "'m1-f0'",
			});
		}
	});

	it("writes the button's icon and spoken label in both exports", () => {
		const doc = registerFromListDoc({
			icon: ICON,
			audioLabel: AUDIO,
			afterSubmit: "case-list",
		});
		const { hq, suiteDoc, strings, assets } = compiled(doc);
		const image = assets.get(ICON)?.wirePath;
		const audio = assets.get(AUDIO)?.wirePath;
		expect(image).toBeDefined();
		expect(audio).toBeDefined();
		expect(hq.modules[0]?.case_list_form).toMatchObject({
			media_image: { en: `jr://file/${image}` },
			media_audio: { en: `jr://file/${audio}` },
		});
		const action = childElements(detail(suiteDoc, "m0_case_short"), "action");
		expect(registerAction(action[0] as Element).display).toEqual([
			{ form: undefined, locale: "case_list_form.m0" },
			{ form: "image", locale: "case_list_form.m0.icon" },
			{ form: "audio", locale: "case_list_form.m0.audio" },
		]);
		expect(strings.get("case_list_form.m0.icon")).toBe(`jr://file/${image}`);
		expect(strings.get("case_list_form.m0.audio")).toBe(`jr://file/${audio}`);
	});

	it("asks no project-space capability for a list that always offers a form", () => {
		expect(
			requiredProjectSpaceCapabilities(
				registerFromListDoc({ afterSubmit: "new-case" }),
			).map((use) => use.id),
		).not.toContain("registration-after-empty-search");
	});
});

describe("a submenu's list under a menu that chooses a case first", () => {
	const RETURN_TO_PEOPLE =
		"count(instance('commcaresession')/session/data/return_to) = 1 and instance('commcaresession')/session/data/return_to = 'm1'";
	const NEW_PERSON =
		"instance('commcaresession')/session/data/case_id_new_person_0";
	const NEW_PERSON_ROW = `count(instance('casedb')/casedb/case[@case_id = ${NEW_PERSON}])`;
	const HOUSE = "instance('commcaresession')/session/data/case_id";

	it("writes HQ's `default` frames, naming the parent's chosen case once", () => {
		const { suiteDoc } = compiled(submenuHostDoc("new-case"));
		expect(frames(entry(suiteDoc, "m2-f0"))).toEqual([
			{
				if: `${RETURN_TO_PEOPLE} and ${NEW_PERSON_ROW} > 0`,
				children: [
					{ name: "command", value: "'m0'" },
					{ name: "datum", id: "case_id", value: HOUSE },
					{ name: "command", value: "'m1'" },
					{ name: "datum", id: "case_id_person", value: NEW_PERSON },
				],
			},
			{
				if: `${RETURN_TO_PEOPLE} and ${NEW_PERSON_ROW} = 0`,
				children: [
					{ name: "command", value: "'m0'" },
					{ name: "datum", id: "case_id", value: HOUSE },
					{ name: "command", value: "'m1'" },
				],
			},
		]);
	});

	it("writes HQ's one `case_list` frame, which keeps the submenu's copy of the chosen case", () => {
		const { suiteDoc } = compiled(submenuHostDoc("case-list"));
		expect(frames(entry(suiteDoc, "m2-f0"))).toEqual([
			{
				if: RETURN_TO_PEOPLE,
				children: [
					{ name: "command", value: "'m0'" },
					{ name: "datum", id: "case_id", value: HOUSE },
					{ name: "command", value: "'m1'" },
					{ name: "datum", id: "case_id", value: HOUSE },
				],
			},
		]);
	});
});
