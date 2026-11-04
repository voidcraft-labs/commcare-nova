/**
 * `publishedCaseBlocks` reads the case blocks HQ's build of each form writes
 * from an app source as HQ holds it. HQ's reads are the boundary: a reader
 * proven only on Nova's own output would prove nothing about HQ's. So it is
 * read over two kinds of HQ evidence. HQ's own test fixtures pair an app
 * source (or HQ's own actions over a stored XForm) with the XForm HQ's build
 * makes of it, and every block the reader finds must stand in that build at
 * its path. The retained HQ reads under `proof/hq-reads/` are app sources HQ
 * served after Nova's pushes and HQ's own saves; they carry the Save to Case
 * blocks, the worker's record, subcases in and out of repeats, a menu that
 * selects several cases, model iteration, HQ-made forms and a shadow form.
 *
 * No retained read holds an advanced form with actions, so the advanced
 * blocks are read from HQ's own advanced fixtures only.
 *
 * The plausible failures: a block at the wrong path (the `nest` rule, the
 * advanced count that only indexed opens enter), a block HQ's build does not
 * write (a several-case menu's own case, a load with nothing to write), a
 * form keyed by position, and a guess where the source is malformed.
 */
import { readFileSync } from "node:fs";
import { type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { parseXml } from "@/lib/commcare/xmlParse";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import {
	type PublishedCaseBlock,
	type PublishedForm,
	publishedCaseBlocks,
} from "../publishedCaseBlocks";

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fixture(path: string): string {
	return readFileSync(new URL(path, FIXTURES), "utf8");
}

/** A retained HQ read: the app source of its response body. */
function retainedRead(path: string): Record<string, unknown> {
	const response = JSON.parse(
		readFileSync(
			new URL(`../../../../proof/hq-reads/${path}`, import.meta.url),
			"utf8",
		),
	) as { body: string };
	return JSON.parse(response.body) as Record<string, unknown>;
}

/** The reader over `source` as a deployment's baseline stores it. */
function read(source: unknown): ReadonlyMap<string, PublishedForm> {
	const baseline = normalizeHqAppSource(source);
	if ("malformed" in baseline)
		throw new Error(`The source is not an application: ${baseline.malformed}`);
	return publishedCaseBlocks(baseline.normalized);
}

function formOf(
	forms: ReadonlyMap<string, PublishedForm>,
	xmlns: string,
): PublishedForm {
	const form = forms.get(xmlns);
	if (form === undefined) throw new Error(`No form read for ${xmlns}`);
	return form;
}

/** A block as plain data, its properties as an object. */
function plain(block: PublishedCaseBlock) {
	return "properties" in block
		? { ...block, properties: Object.fromEntries(block.properties) }
		: block;
}

const tagChildren = (element: Element) => element.children.filter(isTag);

/** The data root of HQ's built XForm `xml`. */
function dataRootOf(xml: string): Element {
	const find = (element: Element | undefined, name: string) =>
		element && tagChildren(element).find((child) => child.name === name);
	const html = parseXml(xml).children.find(isTag);
	const instance = find(find(find(html, "h:head"), "model"), "instance");
	const root = instance && tagChildren(instance)[0];
	if (root === undefined) throw new Error("HQ's build has no data root");
	return root;
}

/** The element at `path` (element names joined by `/`) under the data root
 *  of HQ's built XForm, if there is one. */
function elementAt(xml: string, path: string): Element | undefined {
	let at: Element | undefined = dataRootOf(xml);
	for (const segment of path.split("/"))
		at = at && tagChildren(at).find((child) => child.name === segment);
	return at;
}

/** Every block of `form` stands in HQ's build `xml` at its path: the own
 *  block is its `case` element, every other block holds one. */
function expectBlocksInBuild(form: PublishedForm, xml: string): void {
	for (const block of form.blocks) {
		const element = elementAt(xml, block.path);
		expect(element, block.path).toBeDefined();
		const caseElement =
			block.kind === "basic-own"
				? element
				: element &&
					tagChildren(element).find((child) => child.name === "case");
		expect(caseElement?.name, block.path).toBe("case");
		expect(caseElement?.attribs.xmlns, block.path).toBe(
			"http://commcarehq.org/case/transaction/v2",
		);
	}
}

/** Every `case` element HQ's build writes under the data root, by the path
 *  of the element holding it (the root's own `case` as `case`). */
function builtCasePaths(xml: string): string[] {
	const root = dataRootOf(xml);
	const paths: string[] = [];
	const walk = (element: Element, path: readonly string[]) => {
		for (const child of tagChildren(element)) {
			if (child.name === "case")
				paths.push(path.length === 0 ? "case" : path.join("/"));
			else walk(child, [...path, child.name]);
		}
	};
	walk(root, []);
	return paths.sort();
}

describe("HQ's own fixtures", () => {
	it("reads a repeat's only subcase at the repeat and the form's own case at `case`", () => {
		const forms = read(
			JSON.parse(fixture("form_preparation_v2/subcase-repeat.json")),
		);
		const form = formOf(
			forms,
			"http://openrosa.org/formdesigner/21683C30-2763-4659-B13F-2D4AF089EF7C",
		);
		expect(form.blocks.map(plain)).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "mother",
				opens: true,
				closes: false,
				properties: { name: "/data/mother_name" },
			},
			{
				kind: "basic-subcase",
				index: 0,
				path: "child",
				repeatContext: "child",
				caseType: "child",
				relationship: "child",
				properties: { name: "/data/child/name" },
			},
		]);
		expect(form.modelIterationRows).toEqual([]);
		const built = fixture("form_preparation_v2/subcase-repeat.xml");
		expectBlocksInBuild(form, built);
		expect(form.blocks.map((block) => block.path).sort()).toEqual(
			builtCasePaths(built),
		);
	});

	it("reads two subcases of one repeat at `subcase_<i>` in it, and a follow-up's empty own block", () => {
		const forms = read(
			JSON.parse(fixture("form_preparation_v2/multiple_subcase_repeat.json")),
		);
		const form = formOf(
			forms,
			"http://openrosa.org/formdesigner/ABD894EB-0E04-44DB-9558-915A13A72F49",
		);
		expect(
			form.blocks.map((block) =>
				block.kind === "basic-subcase"
					? [block.kind, block.path, block.repeatContext, block.caseType]
					: [block.kind, block.path],
			),
		).toEqual([
			["basic-own", "case"],
			["basic-subcase", "children/subcase_0", "children", "child1"],
			["basic-subcase", "children/subcase_1", "children", "child2"],
		]);
		const built = fixture("form_preparation_v2/multiple_subcase_repeat.xml");
		expectBlocksInBuild(form, built);
		expect(form.blocks.map((block) => block.path).sort()).toEqual(
			builtCasePaths(built),
		);

		// A follow-up whose update writes nothing still binds its case.
		expect(
			formOf(
				forms,
				"http://openrosa.org/formdesigner/E2F31438-4225-436E-9809-3196BE7F9295",
			).blocks.map(plain),
		).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "child1",
				opens: false,
				closes: false,
				properties: {},
			},
		]);
	});

	it("reads Save to Case blocks from the stored XForm, a block whose type is an expression as `null`", () => {
		const source = fixture("save_to_case_in_groups.xml");
		const forms = publishedCaseBlocks({
			doc_type: "Application",
			modules: [
				{
					doc_type: "Module",
					case_type: "patient",
					forms: [
						{
							doc_type: "Form",
							unique_id: "f",
							xmlns:
								"http://openrosa.org/formdesigner/DA1A9BA7-8EBD-4172-AABD-6185F1E2CEC9",
							requires: "case",
							actions: { doc_type: "FormActions" },
						},
					],
				},
			],
			_attachments: { "f.xml": source },
		});
		expect(
			formOf(
				forms,
				"http://openrosa.org/formdesigner/DA1A9BA7-8EBD-4172-AABD-6185F1E2CEC9",
			).blocks,
		).toEqual([
			{
				kind: "save-to-case",
				path: "a_repeat/save_to_case_in_repeat",
				caseType: null,
			},
			{
				kind: "save-to-case",
				path: "a_group/save_to_case_in_group",
				caseType: null,
			},
		]);
	});

	describe("advanced forms, built from HQ's own advanced tests", () => {
		const condition = (type: string) => ({ type });
		/** One advanced form over `stored` with HQ's test's `actions`. */
		const advanced = (stored: string, actions: Record<string, unknown>) => {
			const xmlns = "http://openrosa.org/formdesigner/advanced";
			const forms = publishedCaseBlocks({
				doc_type: "Application",
				modules: [
					{
						doc_type: "AdvancedModule",
						case_type: "test_case_type",
						forms: [
							{
								doc_type: "AdvancedForm",
								unique_id: "f",
								xmlns,
								actions: {
									doc_type: "AdvancedFormActions",
									load_update_cases: [],
									open_cases: [],
									...actions,
								},
							},
						],
					},
				],
				_attachments: { "f.xml": stored },
			});
			return formOf(forms, xmlns);
		};
		const load = (tag: string, extra: Record<string, unknown> = {}) => ({
			case_type: "parent_test_case_type",
			case_tag: tag,
			case_properties: {},
			close_condition: condition("never"),
			...extra,
		});
		const open = (tag: string, extra: Record<string, unknown> = {}) => ({
			case_type: "test_case_type",
			case_tag: tag,
			name_update: { question_path: "/data/mother_name" },
			case_properties: {},
			case_indices: [],
			open_condition: condition("always"),
			close_condition: condition("never"),
			...extra,
		});

		it("reads a load that writes at `case_<tag>` (test_update_case)", () => {
			const form = advanced(fixture("original_form.xml"), {
				load_update_cases: [
					load("load_1", {
						case_type: "test_case_type",
						case_properties: {
							question1: { question_path: "/data/question1" },
						},
					}),
				],
			});
			expect(form.blocks.map(plain)).toEqual([
				{
					kind: "advanced",
					action: "load",
					tag: "load_1",
					path: "case_load_1",
					caseType: "test_case_type",
					properties: { question1: "/data/question1" },
				},
			]);
			const built = fixture("form_preparation_v2_advanced/update_case.xml");
			expectBlocksInBuild(form, built);
			expect(builtCasePaths(built)).toEqual(["case_load_1"]);
		});

		it("reads an open at the data root (test_open_update_case)", () => {
			const form = advanced(fixture("original_form.xml"), {
				open_cases: [
					open("open_1", {
						name_update: { question_path: "/data/question1" },
						case_properties: {
							question1: { question_path: "/data/question1" },
						},
					}),
				],
			});
			expect(form.blocks.map(plain)).toEqual([
				{
					kind: "advanced",
					action: "open",
					tag: "open_1",
					path: "case_open_1",
					caseType: "test_case_type",
					properties: {
						name: "/data/question1",
						question1: "/data/question1",
					},
				},
			]);
			const built = fixture(
				"form_preparation_v2_advanced/open_update_case.xml",
			);
			expectBlocksInBuild(form, built);
			expect(builtCasePaths(built)).toEqual(["case_open_1"]);
		});

		it("reads a repeat's only indexed open at the repeat, and gives a load with nothing to write no block (test_subcase_repeat)", () => {
			const form = advanced(
				fixture("form_preparation_v2_advanced/subcase_original.xml"),
				{
					load_update_cases: [load("load_1")],
					open_cases: [
						open("open_1", {
							case_indices: [{ tag: "load_1" }],
							repeat_context: "/data/child",
						}),
					],
				},
			);
			expect(form.blocks.map((block) => [block.kind, block.path])).toEqual([
				["advanced", "child"],
			]);
			const built = fixture("form_preparation_v2_advanced/subcase-repeat.xml");
			expectBlocksInBuild(form, built);
			expect(builtCasePaths(built)).toEqual(["child"]);
		});

		it("reads two indexed opens of one repeat at `case_<tag>` in it (test_subcase_multiple_repeats)", () => {
			const form = advanced(
				fixture("form_preparation_v2_advanced/subcase_original.xml"),
				{
					load_update_cases: [load("load_1")],
					open_cases: ["open_1", "open_2"].map((tag, index) =>
						open(tag, {
							case_type: `child${index + 1}`,
							case_indices: [{ tag: "load_1" }],
							repeat_context: "/data/child",
							open_condition: {
								type: "if",
								question: "/data/child/which_child",
								answer: String(index + 1),
							},
						}),
					),
				},
			);
			expect(
				form.blocks.map((block) => [
					block.kind,
					block.path,
					block.kind === "advanced" ? block.caseType : undefined,
				]),
			).toEqual([
				["advanced", "child/case_open_1", "child1"],
				["advanced", "child/case_open_2", "child2"],
			]);
			const built = fixture(
				"form_preparation_v2_advanced/subcase-repeat-multiple.xml",
			);
			expectBlocksInBuild(form, built);
			expect(builtCasePaths(built)).toEqual([
				"child/case_open_1",
				"child/case_open_2",
			]);
		});
	});
});

describe("retained HQ reads", () => {
	const caseWrites = read(
		retainedRead("targeted-migration-case-writes/app-source.json"),
	);
	const xmlns = (suffix: string) =>
		`http://openrosa.org/formdesigner/${suffix}`;

	it("reads a registration's own block, a root subcase and a repeat's only subcase", () => {
		expect(
			formOf(
				caseWrites,
				xmlns("195EBC95-CD9C-53F9-ACB3-96C77E70AE25"),
			).blocks.map(plain),
		).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "household",
				opens: true,
				closes: false,
				properties: {
					name: "/data/nova_trimmed_household_name",
					village: "/data/village",
				},
			},
			{
				kind: "basic-subcase",
				index: 0,
				path: "subcase_0",
				repeatContext: null,
				caseType: "head",
				relationship: "child",
				properties: { name: "/data/nova_trimmed_head_name" },
			},
			{
				kind: "basic-subcase",
				index: 1,
				path: "members",
				repeatContext: "members",
				caseType: "member",
				relationship: "child",
				properties: { name: "/data/members/nova_trimmed_member_name" },
			},
		]);
	});

	it("reads the worker's record and Save to Case blocks at the root and in a repeat", () => {
		const form = formOf(
			caseWrites,
			xmlns("BE01648F-79F0-5EDB-A6E1-4EAD8A75885F"),
		);
		expect(form.blocks.map(plain)).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "household",
				opens: false,
				closes: false,
				properties: { last_note: "/data/visit_note" },
			},
			{
				kind: "basic-usercase",
				path: "commcare_usercase",
				properties: { visits_done: "/data/visits_done" },
			},
			{
				kind: "save-to-case",
				path: "nova_operations/nova_keyed_add_referral/add_referral",
				caseType: "household",
			},
			{
				kind: "save-to-case",
				path: "nova_operations/nova_guard_add_referral_text",
				caseType: "household",
			},
			{
				kind: "save-to-case",
				path: "nova_operations/mark_visited",
				caseType: "household",
			},
			{
				kind: "save-to-case",
				path: "nova_operations/nova_condition_flag_household/flag_household",
				caseType: "household",
			},
			{
				kind: "save-to-case",
				path: "arrivals/nova_operations/add_arrival",
				caseType: "member",
			},
			{
				kind: "save-to-case",
				path: "arrivals/nova_operations/nova_guard_add_arrival_text",
				caseType: "member",
			},
		]);
	});

	it("reads a close in Case Management and an own close in a block of its own", () => {
		expect(
			formOf(
				caseWrites,
				xmlns("B599FEA0-E02A-5394-A0D5-FF5AAA49E4B0"),
			).blocks.map(plain),
		).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "household",
				opens: false,
				closes: true,
				properties: {},
			},
		]);
		expect(
			formOf(
				caseWrites,
				xmlns("F6A05AB4-66FD-58D8-AC89-69067CAD3964"),
			).blocks.map((block) => [block.kind, block.path]),
		).toEqual([
			["basic-own", "case"],
			["save-to-case", "nova_operations/nova_condition_close/nova_close"],
		]);
	});

	it("gives a menu that selects several cases no own block, and reads its model-iteration row", () => {
		const form = formOf(
			caseWrites,
			xmlns("7650B44A-8C1B-58CE-AE23-ED64DE40945A"),
		);
		expect(form.blocks.map((block) => [block.kind, block.path])).toEqual([
			[
				"save-to-case",
				"nova_selected_cases/item/nova_operations/nova_condition_update_selected_cases/nova_update_selected_cases",
			],
		]);
		expect(form.modelIterationRows).toEqual(["nova_selected_cases/item"]);
	});

	it("reads an extension subcase and the block that carries it in the source", () => {
		const forms = read(
			retainedRead("targeted-migration-extension-children/app-source.json"),
		);
		expect(
			formOf(forms, xmlns("145A1192-EB99-5116-A297-183476567D42")).blocks.map(
				(block) =>
					block.kind === "basic-subcase"
						? [block.kind, block.path, block.relationship]
						: [block.kind, block.path],
			),
		).toEqual([
			["basic-own", "case"],
			["basic-subcase", "subcase_0", "extension"],
			["save-to-case", "nova_subcases/nova_subcase_0"],
		]);
	});

	it("reads every model-iteration row, nested in groups too", () => {
		const forms = read(
			retainedRead("targeted-migration-query-repeats/app-source.json"),
		);
		const form = formOf(forms, xmlns("370D830D-B6D3-5A61-A124-0DC7F537D71D"));
		expect(form.blocks).toEqual([]);
		expect(form.modelIterationRows).toEqual([
			"visits/item",
			"households/members/item",
			"checks/later/item",
		]);
	});

	it("keys forms by xmlns, whatever their position or who made their xmlns", () => {
		const source = retainedRead(
			"targeted-migration-case-writes/app-source.json",
		);
		const modules = source.modules as { forms: unknown[] }[];
		const reordered = {
			...source,
			modules: [...modules]
				.reverse()
				.map((module) => ({ ...module, forms: [...module.forms].reverse() })),
		};
		const forms = read(reordered);
		expect([...forms.keys()].sort()).toEqual([...caseWrites.keys()].sort());
		for (const [key, form] of caseWrites)
			expect(formOf(forms, key)).toEqual(form);

		// HQ-made forms keep HQ's xmlns, an override of the one Nova derives.
		const hqBuiltSource = retainedRead("hq-built/app-source.json");
		const hqBuilt = read(hqBuiltSource);
		// The registration form, by where the read holds it: its xmlns derives
		// from the fixture's ids, which move as the corpus grows.
		const registration = (
			hqBuiltSource.modules as { forms: { xmlns: string }[] }[]
		)[0]?.forms[1]?.xmlns;
		if (registration === undefined)
			throw new Error("The HQ-built read lost its registration form.");
		expect(formOf(hqBuilt, registration).blocks.map(plain)).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "patient",
				opens: true,
				closes: false,
				properties: {
					name: "/data/nova_trimmed_name",
					external_id: "/data/nova_trimmed_external",
				},
			},
		]);
		// An advanced form HQ made with no actions writes no block, and the
		// shadow form, which has no xmlns of its own, is left out.
		expect(
			formOf(
				hqBuilt,
				"http://openrosa.org/formdesigner/61BCD95D-0A17-4E62-BFC9-E102629BCC19",
			).blocks,
		).toEqual([]);
		expect(hqBuilt.size).toBe(4);

		// A form given another xmlns is read under it, and not under its old one.
		const renamed = structuredClone(source) as typeof source;
		const first = (renamed.modules as { forms: Record<string, unknown>[] }[])[0]
			.forms[0];
		const old = first.xmlns as string;
		first.xmlns = "http://openrosa.org/formdesigner/override";
		const overridden = read(renamed);
		expect(overridden.has(old)).toBe(false);
		expect(
			formOf(overridden, "http://openrosa.org/formdesigner/override"),
		).toEqual({
			...formOf(caseWrites, old),
			xmlns: "http://openrosa.org/formdesigner/override",
		});
	});
});

describe("what the reader leaves out", () => {
	it("reads nothing from a source that is not an application, or from an empty shell", () => {
		expect(publishedCaseBlocks(null).size).toBe(0);
		expect(publishedCaseBlocks({ doc_type: "LinkedApplication" }).size).toBe(0);
		expect(
			publishedCaseBlocks({ doc_type: "Application", modules: {} }).size,
		).toBe(0);
		expect(
			publishedCaseBlocks(retainedRead("publish/source-shell.json")).size,
		).toBe(0);
	});

	it("leaves out a malformed form, an unparsed XForm, a shared xmlns and a form without one, and reads the others", () => {
		const source = retainedRead(
			"targeted-migration-case-writes/app-source.json",
		);
		const modules = source.modules as { forms: Record<string, unknown>[] }[];
		const attachments = source._attachments as Record<string, string>;
		const [registration] = modules[0].forms;
		const [visit, discharge, close, ownClose] = modules[1].forms;
		const [several] = modules[2].forms;
		registration.actions = "not an object";
		attachments[`${visit.unique_id as string}.xml`] = "<h:html";
		close.xmlns = discharge.xmlns;
		delete ownClose.xmlns;
		const forms = read(source);
		expect([...forms.keys()]).toEqual([several.xmlns]);
		expect(formOf(forms, several.xmlns as string)).toEqual(
			formOf(caseWritesRead(), several.xmlns as string),
		);
	});
});

function caseWritesRead(): ReadonlyMap<string, PublishedForm> {
	return read(retainedRead("targeted-migration-case-writes/app-source.json"));
}
