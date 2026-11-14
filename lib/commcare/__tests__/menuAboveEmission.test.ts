/**
 * Both exports of menus that show their forms in the menu above, read back
 * by the suite and HQ JSON oracles and the XML parser, with the stacks held
 * to HQ's own fixture for the same basic shape
 * (`corehq/apps/app_manager/tests/data/form_workflow/suite-workflow-module-in-root.xml`,
 * `test_form_workflow.py::test_form_workflow_module_in_root`), and the
 * frame invariant over the `menu-screens` corpus: no frame Nova writes for
 * an admitted document holds a chosen case ahead of its first command.
 */
import AdmZip from "adm-zip";
import type { Element } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import {
	type FrameChild,
	formFrameChildren,
	formLinkProjectionContext,
	frameLeadsWithSelection,
	menuIdOf,
	moduleFrameChildren,
	previousEntryFrameChildren,
	ROOT_MENU_ID,
	targetFrameChildren,
} from "@/lib/commcare/formLinkProjection";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { parseXml } from "@/lib/commcare/xmlParse";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	effectivePostSubmit,
	formLinkEntries,
	moduleHasOwnScreen,
	resolveFormLinkTarget,
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { assertGenerated, manifestFor } from "./compilerEvidence";
import { menuScreenDocArbitrary } from "./menuScreenDocArbitrary";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

const roleIs = (role: string) => eq(sessionUser("role"), literal(role));
const ROLE_READ = "instance('commcaresession')/session/user/data/role";

function admitted(doc: BlueprintDoc): BlueprintDoc {
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

interface Compiled {
	readonly hq: ReturnType<typeof expandDoc>;
	readonly suite: string;
	readonly suiteDoc: ReturnType<typeof parseXml>;
}

function compiled(doc: BlueprintDoc): Compiled {
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
	return { hq, suite, suiteDoc: parseXml(suite) };
}

function elements(compiledSuite: Compiled, name: string): Element[] {
	return findAll(
		(element) => element.name === name,
		compiledSuite.suiteDoc.children,
	);
}

function childElements(element: Element, name?: string): Element[] {
	return getChildren(element).filter(
		(child): child is Element =>
			child.type === "tag" && (name === undefined || child.name === name),
	);
}

/** The `<menu>` whose commands include `commandId`. */
function menuHolding(compiledSuite: Compiled, commandId: string): Element {
	const menus = elements(compiledSuite, "menu").filter((menu) =>
		childElements(menu, "command").some(
			(command) => getAttributeValue(command, "id") === commandId,
		),
	);
	expect(menus).toHaveLength(1);
	return menus[0] as Element;
}

function entryOf(compiledSuite: Compiled, commandId: string): Element {
	const entries = elements(compiledSuite, "entry").filter((entry) =>
		childElements(entry, "command").some(
			(command) => getAttributeValue(command, "id") === commandId,
		),
	);
	expect(entries).toHaveLength(1);
	return entries[0] as Element;
}

/** The stack frames of an entry, as `{name, id?, value}` children. */
function stackFrames(entry: Element) {
	return childElements(entry, "stack").flatMap((stack) =>
		childElements(stack, "create").map((create) =>
			childElements(create).map((child) => ({
				name: child.name,
				...(child.attribs.id !== undefined && { id: child.attribs.id }),
				value: child.attribs.value,
			})),
		),
	);
}

function textLocale(menu: Element): string | undefined {
	const display = childElements(menu, "display")[0];
	const text = childElements(display ?? menu, "text")[0];
	return text === undefined
		? undefined
		: getAttributeValue(childElements(text, "locale")[0] as Element, "id");
}

function mediaLocales(menu: Element): string[] {
	const display = childElements(menu, "display")[0];
	if (display === undefined) return [];
	return childElements(display, "text")
		.filter((text) => text.attribs.form !== undefined)
		.map(
			(text) =>
				getAttributeValue(childElements(text, "locale")[0] as Element, "id") ??
				"",
		);
}

function instanceIds(element: Element): string[] {
	return childElements(element, "instance").map((i) => i.attribs.id ?? "");
}

const registration = (uuid: string, name: string) => ({
	uuid,
	name,
	type: "registration" as const,
	fields: [
		f({
			kind: "text",
			id: "case_name",
			label: proseText("Name"),
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
	],
});
const followup = (
	uuid: string,
	name: string,
	extra: { postSubmit?: "previous" } = {},
) => ({
	uuid,
	name,
	type: "followup" as const,
	...extra,
	fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
});
const survey = (
	uuid: string,
	name: string,
	extra: { postSubmit?: "previous" } = {},
) => ({
	uuid,
	name,
	type: "survey" as const,
	...extra,
	fields: [f({ kind: "text", id: "q", label: proseText("Question") })],
});
const patients = () => caseListConfig([{ field: "case_name", header: "Name" }]);

/**
 * HQ's basic part of `_build_workflow_app`, in Nova's preorder: `m0` a menu
 * of two surveys; `m1` above with a registration and a follow-up; its
 * child `m2` (HQ's `m5`) keeping its screen; `m3` (HQ's `m2`) above with two
 * follow-ups. Every form is `previous` where Nova offers it.
 */
function hqShapeDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Module in root",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "m0",
				name: "Surveys",
				forms: [
					survey("m0f0", "Survey one", { postSubmit: "previous" }),
					survey("m0f1", "Survey two", { postSubmit: "previous" }),
				],
			},
			{
				uuid: "m1",
				name: "Registration",
				caseType: "patient",
				caseListConfig: patients(),
				forms: [registration("m1f0", "Register"), followup("m1f1", "Visit")],
			},
			{
				uuid: "m2",
				name: "Child visits",
				caseType: "patient",
				caseListConfig: patients(),
				forms: [followup("m2f0", "Child visit", { postSubmit: "previous" })],
			},
			{
				uuid: "m3",
				name: "Visits",
				caseType: "patient",
				caseListConfig: patients(),
				forms: [followup("m3f0", "Visit A"), followup("m3f1", "Visit B")],
			},
		],
	});
	doc.modules[testUuid("m2")].parentModuleUuid = testUuid("m1");
	doc.modules[testUuid("m1")].formsInMenuAbove = true;
	doc.modules[testUuid("m3")].formsInMenuAbove = true;
	return admitted(doc);
}

/**
 * Every menu shape: `m0` keeps its screen; its child `m1` shows its forms
 * there, with its own condition, icon and a `previous` form; `m2` is a
 * top-level menu above with a condition; under it, `m3` keeps its screen and
 * `m4` shows its forms above with no condition of its own.
 */
function menuShapesDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Menu shapes",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "s0",
				name: "Clinic",
				caseType: "patient",
				caseListConfig: patients(),
				displayCondition: roleIs("supervisor"),
				forms: [followup("s0f0", "Clinic visit")],
			},
			{
				uuid: "s1",
				name: "Clinic extras",
				caseType: "patient",
				caseListConfig: patients(),
				displayCondition: roleIs("nurse"),
				forms: [followup("s1f0", "Extra visit", { postSubmit: "previous" })],
			},
			{
				uuid: "s2",
				name: "Home tasks",
				displayCondition: roleIs("lead"),
				forms: [survey("s2f0", "Home check")],
			},
			{
				uuid: "s3",
				name: "Home submenu",
				forms: [survey("s3f0", "Sub check")],
			},
			{
				uuid: "s4",
				name: "Home extras",
				forms: [survey("s4f0", "Extra check")],
			},
		],
	});
	doc.modules[testUuid("s1")].parentModuleUuid = testUuid("s0");
	doc.modules[testUuid("s3")].parentModuleUuid = testUuid("s2");
	doc.modules[testUuid("s4")].parentModuleUuid = testUuid("s2");
	for (const label of ["s1", "s2", "s4"])
		doc.modules[testUuid(label)].formsInMenuAbove = true;
	doc.modules[testUuid("s1")].icon = asMediaAssetId(testUuid("s1-icon"));
	return admitted(doc);
}

describe("the HQ JSON of a menu that shows its forms in the menu above", () => {
	it("writes put_in_root on each such menu and needs the menu_mode add-on", () => {
		const doc = menuShapesDoc();
		const { hq } = compiled(doc);
		expect(hq.modules.map((module) => module.put_in_root)).toEqual([
			false,
			true,
			true,
			false,
			true,
		]);
		expect(hq.add_ons?.menu_mode).toBe(true);
		// Its own filter, name and media are written as they are.
		expect(hq.modules[1]?.module_filter).not.toBeNull();
		expect(hq.modules[4]?.module_filter).toBeNull();
		expect(Object.keys(hq.modules[1]?.media_image ?? {})).not.toHaveLength(0);
	});

	it("needs no menu_mode add-on where no menu shows its forms above", () => {
		const doc = menuShapesDoc();
		for (const uuid of doc.moduleOrder)
			delete doc.modules[uuid].formsInMenuAbove;
		const { hq } = compiled(admitted(doc));
		expect(hq.modules.every((module) => !module.put_in_root)).toBe(true);
		expect(hq.add_ons?.menu_mode).toBeUndefined();
	});
});

describe("the local suite's menus", () => {
	const doc = menuShapesDoc();
	const suite = compiled(doc);

	it("gives a submenu above its parent's id and name, keeps its own media, and conjoins the two conditions", () => {
		const menu = menuHolding(suite, "m1-f0");
		expect(menu.attribs.id).toBe("m0");
		expect(menu.attribs.root).toBeUndefined();
		expect(textLocale(menu)).toBe("modules.m0");
		expect(mediaLocales(menu)).toEqual(["modules.m1.icon"]);
		expect(menu.attribs.relevant).toBe(
			`(${ROLE_READ} = 'nurse') and (${ROLE_READ} = 'supervisor')`,
		);
		// The condition's instance is declared on its own `<menu>`.
		expect(instanceIds(menu)).toEqual(["commcaresession"]);
	});

	it("writes the parent's own menu as before, beside the submenu's", () => {
		const menu = menuHolding(suite, "m0-f0");
		expect(menu.attribs.id).toBe("m0");
		expect(textLocale(menu)).toBe("modules.m0");
		expect(menu.attribs.relevant).toBe(`${ROLE_READ} = 'supervisor'`);
	});

	it("lists a top-level menu above on the root menu, with its own name and condition", () => {
		const menu = menuHolding(suite, "m2-f0");
		expect(menu.attribs.id).toBe(ROOT_MENU_ID);
		expect(menu.attribs.root).toBeUndefined();
		expect(textLocale(menu)).toBe("modules.m2");
		expect(menu.attribs.relevant).toBe(`${ROLE_READ} = 'lead'`);
	});

	it("roots a submenu that keeps its screen under a parent above at the root menu", () => {
		const menu = menuHolding(suite, "m3-f0");
		expect(menu.attribs.id).toBe("m3");
		expect(menu.attribs.root).toBe(ROOT_MENU_ID);
		expect(menu.attribs.relevant).toBeUndefined();
	});

	it("gives a submenu above under a parent above the root id, its own name and its parent's condition alone", () => {
		const menu = menuHolding(suite, "m4-f0");
		expect(menu.attribs.id).toBe(ROOT_MENU_ID);
		expect(textLocale(menu)).toBe("modules.m4");
		expect(menu.attribs.relevant).toBe(`${ROLE_READ} = 'lead'`);
		expect(instanceIds(menu)).toEqual(["commcaresession"]);
		// No entry declares the menu's condition's instance for it.
		expect(instanceIds(entryOf(suite, "m4-f0"))).not.toContain(
			"commcaresession",
		);
	});

	it("writes each menu's name under its own locale whatever its menu shows", () => {
		expect(suite.suite).toContain("modules.m1");
		const projection = formLinkProjectionContext(doc);
		expect(
			doc.moduleOrder.map((uuid) => menuIdOf(doc, projection, uuid)),
		).toEqual(["m0", "m0", ROOT_MENU_ID, "m3", ROOT_MENU_ID]);
	});

	it("writes `previous` in a submenu above as HQ does: the parent's command twice, then the chosen case", () => {
		expect(stackFrames(entryOf(suite, "m1-f0"))).toEqual([
			[
				{ name: "command", value: "'m0'" },
				{ name: "command", value: "'m0'" },
				{
					name: "datum",
					id: "case_id",
					value: "instance('commcaresession')/session/data/case_id",
				},
			],
		]);
	});
});

describe("stacks of HQ's module-in-root shape", () => {
	const doc = hqShapeDoc();
	const suite = compiled(doc);
	const projection = formLinkProjectionContext(emissionPlan(doc).doc);
	const previous = (moduleLabel: string, formLabel: string) =>
		previousEntryFrameChildren(
			doc,
			projection,
			testUuid(moduleLabel),
			testUuid(formLabel),
		).map((child) =>
			child.type === "command"
				? { command: child.id }
				: { datum: child.datum.id },
		);

	it("writes the frames HQ writes for the menus Nova offers previous in", () => {
		// HQ's m0-f0 and m0-f1.
		for (const command of ["m0-f0", "m0-f1"])
			expect(stackFrames(entryOf(suite, command))).toEqual([
				[{ name: "command", value: "'m0'" }],
			]);
		// HQ's m5-f0: a submenu that keeps its screen under a parent above,
		// with the parent's registration datum carried.
		expect(stackFrames(entryOf(suite, "m2-f0"))).toEqual([
			[
				{ name: "command", value: "'m2'" },
				{ name: "datum", id: "case_id_new_patient_0", value: "uuid()" },
				{
					name: "datum",
					id: "case_id",
					value: "instance('commcaresession')/session/data/case_id",
				},
			],
		]);
	});

	it("projects HQ's frames for forms listed on the first menu, which Nova does not offer previous", () => {
		// HQ's m1-f0 pops to nothing; m1-f1, m2-f0 and m2-f1 keep their own
		// command, since the root datums share no prefix.
		expect(previous("m1", "m1f0")).toEqual([]);
		expect(previous("m1", "m1f1")).toEqual([{ command: "m1-f1" }]);
		expect(previous("m3", "m3f0")).toEqual([{ command: "m3-f0" }]);
		expect(previous("m3", "m3f1")).toEqual([{ command: "m3-f1" }]);
		// Their default is the first menu, one empty frame.
		expect(stackFrames(entryOf(suite, "m1-f1"))).toEqual([[]]);
	});

	it("writes a form target through the first menu as its command and its own datums", () => {
		const children = formFrameChildren(
			doc,
			projection,
			testUuid("m3"),
			testUuid("m3f0"),
		);
		expect(
			children.map((child) =>
				child.type === "command" ? child.id : child.datum.id,
			),
		).toEqual(["m3-f0", "case_id"]);
		// A command records the screen it names.
		const [command] = moduleFrameChildren(doc, projection, testUuid("m2"));
		expect(command?.type).toBe("command");
		expect(projection.commandTargets.get(command as FrameChild)).toEqual({
			moduleUuid: testUuid("m2"),
		});
	});
});

/** Every frame Nova writes for the document, each with what it stands for:
 *  each link's target, each form's built-in destination and built-in
 *  otherwise, and each entry point. A `parentMenu` frame opens on the
 *  parent's own command where the parent keeps its screen, so it is held by
 *  that fact. */
function writtenFrames(doc: BlueprintDoc): {
	readonly frames: readonly { what: string; children: FrameChild[] }[];
	readonly parentMenuWithoutScreen: readonly string[];
} {
	const emitted = emissionPlan(doc).doc;
	const ctx = formLinkProjectionContext(emitted);
	const frames: { what: string; children: FrameChild[] }[] = [];
	const parentMenuWithoutScreen: string[] = [];
	for (const moduleUuid of ctx.moduleOrder) {
		const mod = emitted.modules[moduleUuid];
		if (mod?.entryPoint !== undefined || mod?.caseListEntryPoint !== undefined)
			frames.push({
				what: `entry point of ${mod.name}`,
				children: moduleFrameChildren(emitted, ctx, moduleUuid),
			});
		for (const formUuid of ctx.formOrder[moduleUuid] ?? []) {
			const form = emitted.forms[formUuid];
			if (form === undefined) continue;
			if (form.entryPoint !== undefined)
				frames.push({
					what: `entry point of ${form.name}`,
					children: formFrameChildren(emitted, ctx, moduleUuid, formUuid),
				});
			for (const entry of formLinkEntries(form)) {
				const target = resolveFormLinkTarget(
					emitted,
					formUuid,
					entry.link.target,
				);
				if (target !== undefined)
					frames.push({
						what: `link of ${form.name}`,
						children: targetFrameChildren(emitted, ctx, target),
					});
			}
			const destinations = [
				form.formLinks === undefined
					? effectivePostSubmit(emitted, formUuid)
					: undefined,
				form.otherwise?.kind === "destination"
					? form.otherwise.destination
					: undefined,
			];
			for (const destination of destinations) {
				if (destination === "previous")
					frames.push({
						what: `previous of ${form.name}`,
						children: previousEntryFrameChildren(
							emitted,
							ctx,
							moduleUuid,
							formUuid,
						),
					});
				if (destination === "module")
					frames.push({
						what: `module of ${form.name}`,
						children: moduleFrameChildren(emitted, ctx, moduleUuid),
					});
				if (
					destination === "parentMenu" &&
					mod?.parentModuleUuid !== undefined &&
					!moduleHasOwnScreen(emitted, mod.parentModuleUuid)
				)
					parentMenuWithoutScreen.push(form.name);
			}
		}
	}
	return { frames, parentMenuWithoutScreen };
}

it("writes no frame that holds a chosen case ahead of its first command, over the menu-screens corpus", {
	timeout: 60_000,
}, () => {
	let frames = 0;
	assertGenerated(
		fc.property(menuScreenDocArbitrary, (doc) => {
			const written = writtenFrames(doc);
			expect(written.parentMenuWithoutScreen).toEqual([]);
			for (const frame of written.frames) {
				frames++;
				expect(
					frameLeadsWithSelection(frame.children),
					`${frame.what} leads with a chosen case`,
				).toBe(false);
			}
		}),
		{ seed: 20261114, numRuns: 60 },
	);
	expect(frames).toBeGreaterThan(60);
});
