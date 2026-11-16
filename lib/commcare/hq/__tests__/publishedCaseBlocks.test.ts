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
 * form keyed by position, a condition, an index or a session value read
 * otherwise than the build writes it, a form left out in silence, and a
 * source that holds `update_mode: edit` read as one that holds none, which
 * would skip the one probe of the source project space that decides what
 * the word means.
 */
import { readFileSync } from "node:fs";
import { type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { parseXml } from "@/lib/commcare/xmlParse";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import {
	type PublishedCaseBlock,
	type PublishedCaseBlocks,
	type PublishedForm,
	publishedCaseBlocks,
	sourceHoldsEditMode,
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
function readAll(source: unknown): PublishedCaseBlocks {
	const baseline = normalizeHqAppSource(source);
	if ("malformed" in baseline)
		throw new Error(`The source is not an application: ${baseline.malformed}`);
	return publishedCaseBlocks(baseline.normalized);
}

/** The forms the reader read from `source`. */
function read(source: unknown): ReadonlyMap<string, PublishedForm> {
	return readAll(source).forms;
}

function formOf(
	forms: ReadonlyMap<string, PublishedForm>,
	xmlns: string,
): PublishedForm {
	const form = forms.get(xmlns);
	if (form === undefined) throw new Error(`No form read for ${xmlns}`);
	return form;
}

/** A block as plain data: its properties as an object, its edit-only keys as a list. */
function plain(block: PublishedCaseBlock) {
	return block.kind === "save-to-case"
		? block
		: {
				...block,
				properties: Object.fromEntries(block.properties),
				editOnly: [...block.editOnly],
			};
}

const ALWAYS = { type: "always" } as const;
const NEVER = { type: "never" } as const;
const OWN_PARENT = {
	identifier: "parent",
	target: { kind: "own" },
	relationship: "child",
} as const;

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
				condition: ALWAYS,
				closeCondition: NEVER,
				sessionDatum: "case_id_new_mother_0",
				ownerWritten: false,
				properties: { name: "/data/mother_name" },
				editOnly: [],
			},
			{
				kind: "basic-subcase",
				index: 0,
				path: "child",
				repeatContext: "child",
				caseType: "child",
				condition: ALWAYS,
				closeCondition: NEVER,
				indices: [OWN_PARENT],
				ownerWritten: false,
				properties: { name: "/data/child/name" },
				editOnly: [],
			},
		]);
		expect(form.modelIterationRows).toEqual([]);
		const built = fixture("form_preparation_v2/subcase-repeat.xml");
		expectBlocksInBuild(form, built);
		expect(form.blocks.map((block) => block.path).sort()).toEqual(
			builtCasePaths(built),
		);
	});

	it("reads two subcases of one repeat at `subcase_<i>` in it, each with its condition, and a follow-up's empty own block", () => {
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
					? [
							block.kind,
							block.path,
							block.repeatContext,
							block.caseType,
							block.condition,
						]
					: [block.kind, block.path],
			),
		).toEqual([
			["basic-own", "case"],
			[
				"basic-subcase",
				"children/subcase_0",
				"children",
				"child1",
				{
					type: "if",
					question: "children/which_child",
					answer: "1",
					operator: "=",
				},
			],
			[
				"basic-subcase",
				"children/subcase_1",
				"children",
				"child2",
				{
					type: "if",
					question: "children/which_child",
					answer: "2",
					operator: "=",
				},
			],
		]);
		const built = fixture("form_preparation_v2/multiple_subcase_repeat.xml");
		expectBlocksInBuild(form, built);
		expect(form.blocks.map((block) => block.path).sort()).toEqual(
			builtCasePaths(built),
		);

		// A follow-up whose update writes nothing still binds its case, which
		// it reads from `case_id` in a menu with no parent.
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
				condition: ALWAYS,
				closeCondition: NEVER,
				sessionDatum: "case_id",
				ownerWritten: false,
				properties: {},
				editOnly: [],
			},
		]);
	});

	it("reads Save to Case blocks from the stored XForm, a block whose type is an expression as `null`", () => {
		const source = fixture("save_to_case_in_groups.xml");
		const { forms } = publishedCaseBlocks({
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
			).blocks.map((block) => [
				block.kind,
				block.path,
				block.kind === "save-to-case" ? block.caseType : undefined,
			]),
		).toEqual([
			["save-to-case", "a_repeat/save_to_case_in_repeat", null],
			["save-to-case", "a_group/save_to_case_in_group", null],
		]);
	});

	describe("advanced forms, built from HQ's own advanced tests", () => {
		const condition = (type: string) => ({ type });
		/** One advanced form over `stored` with HQ's test's `actions`. */
		const advanced = (stored: string, actions: Record<string, unknown>) => {
			const xmlns = "http://openrosa.org/formdesigner/advanced";
			const { forms } = publishedCaseBlocks({
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
					condition: ALWAYS,
					closeCondition: NEVER,
					indices: [],
					ownerWritten: false,
					properties: { question1: "/data/question1" },
					editOnly: [],
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
					condition: ALWAYS,
					closeCondition: NEVER,
					indices: [],
					ownerWritten: false,
					properties: {
						name: "/data/question1",
						question1: "/data/question1",
					},
					editOnly: [],
				},
			]);
			const built = fixture(
				"form_preparation_v2_advanced/open_update_case.xml",
			);
			expectBlocksInBuild(form, built);
			expect(builtCasePaths(built)).toEqual(["case_open_1"]);
		});

		it("reads a repeat's only indexed open at the repeat, with its index to the load, and gives a load with nothing to write no block (test_subcase_repeat)", () => {
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
			expect(
				form.blocks.map((block) => [
					block.kind,
					block.path,
					block.kind === "advanced" ? block.indices : undefined,
				]),
			).toEqual([
				[
					"advanced",
					"child",
					[
						{
							identifier: "parent",
							target: { kind: "tag", tag: "load_1" },
							relationship: "child",
						},
					],
				],
			]);
			const built = fixture("form_preparation_v2_advanced/subcase-repeat.xml");
			expectBlocksInBuild(form, built);
			expect(builtCasePaths(built)).toEqual(["child"]);
		});

		it("reads two indexed opens of one repeat at `case_<tag>` in it, each with its open condition (test_subcase_multiple_repeats)", () => {
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
					block.kind === "advanced" ? block.condition : undefined,
				]),
			).toEqual(
				[1, 2].map((n) => [
					"advanced",
					`child/case_open_${n}`,
					`child${n}`,
					{
						type: "if",
						question: "child/which_child",
						answer: String(n),
						operator: "=",
					},
				]),
			);
			const built = fixture(
				"form_preparation_v2_advanced/subcase-repeat-multiple.xml",
			);
			expectBlocksInBuild(form, built);
			expect(builtCasePaths(built)).toEqual([
				"child/case_open_1",
				"child/case_open_2",
			]);
		});

		it("reads an open's own index names, relationships and close, a load's close and owner, and `edit` on each", () => {
			const form = advanced(fixture("original_form.xml"), {
				load_update_cases: [
					load("load_1", {
						case_properties: {
							owner_id: { question_path: "/data/question1" },
							seen: { question_path: "/data/question1", update_mode: "edit" },
						},
						close_condition: {
							type: "if",
							question: "question1",
							answer: "done",
							operator: "selected",
						},
					}),
				],
				open_cases: [
					open("open_1", {
						case_properties: {
							note: { question_path: "/data/question1", update_mode: "edit" },
						},
						case_indices: [
							{
								tag: "load_1",
								reference_id: "host",
								relationship: "extension",
							},
							{ tag: "load_1", reference_id: "", relationship: "question" },
						],
						close_condition: condition("always"),
					}),
				],
			});
			expect(form.blocks.map(plain)).toEqual([
				expect.objectContaining({
					tag: "load_1",
					closeCondition: {
						type: "if",
						question: "question1",
						answer: "done",
						operator: "selected",
					},
					ownerWritten: true,
					editOnly: ["seen"],
				}),
				expect.objectContaining({
					tag: "open_1",
					closeCondition: ALWAYS,
					indices: [
						{
							identifier: "host",
							target: { kind: "tag", tag: "load_1" },
							relationship: "extension",
						},
						{
							identifier: "parent",
							target: { kind: "tag", tag: "load_1" },
							relationship: "question",
						},
					],
					ownerWritten: false,
					editOnly: ["note"],
				}),
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
				condition: ALWAYS,
				closeCondition: NEVER,
				sessionDatum: "case_id_new_household_0",
				ownerWritten: false,
				properties: {
					name: "/data/nova_trimmed_household_name",
					village: "/data/village",
				},
				editOnly: [],
			},
			{
				kind: "basic-subcase",
				index: 0,
				path: "subcase_0",
				repeatContext: null,
				caseType: "head",
				condition: ALWAYS,
				closeCondition: NEVER,
				indices: [OWN_PARENT],
				ownerWritten: false,
				properties: { name: "/data/nova_trimmed_head_name" },
				editOnly: [],
			},
			{
				kind: "basic-subcase",
				index: 1,
				path: "members",
				repeatContext: "members",
				caseType: "member",
				condition: ALWAYS,
				closeCondition: NEVER,
				indices: [OWN_PARENT],
				ownerWritten: false,
				properties: { name: "/data/members/nova_trimmed_member_name" },
				editOnly: [],
			},
		]);
	});

	it("reads the worker's record and Save to Case blocks at the root and in a repeat, each with its actions, index and leaves", () => {
		const form = formOf(
			caseWrites,
			xmlns("BE01648F-79F0-5EDB-A6E1-4EAD8A75885F"),
		);
		const guard = (path: string, caseType: string) => ({
			kind: "save-to-case",
			path,
			caseType,
			actions: ["update"],
			indices: [],
			properties: ["update/case_type"],
		});
		const create = ["create/case_name", "create/case_type", "create/owner_id"];
		expect(form.blocks.map(plain)).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "household",
				opens: false,
				closes: false,
				condition: ALWAYS,
				closeCondition: NEVER,
				sessionDatum: "case_id",
				ownerWritten: false,
				properties: { last_note: "/data/visit_note" },
				editOnly: [],
			},
			{
				kind: "basic-usercase",
				path: "commcare_usercase",
				properties: { visits_done: "/data/visits_done" },
				editOnly: [],
			},
			{
				kind: "save-to-case",
				path: "nova_operations/nova_keyed_add_referral/add_referral",
				caseType: "household",
				actions: ["create"],
				indices: [],
				properties: create,
			},
			guard("nova_operations/nova_guard_add_referral_text", "household"),
			{
				kind: "save-to-case",
				path: "nova_operations/mark_visited",
				caseType: "household",
				actions: ["update"],
				indices: [],
				properties: ["update/visited"],
			},
			{
				kind: "save-to-case",
				path: "nova_operations/nova_condition_flag_household/flag_household",
				caseType: "household",
				actions: ["update"],
				indices: [],
				properties: ["update/flagged"],
			},
			{
				kind: "save-to-case",
				path: "arrivals/nova_operations/add_arrival",
				caseType: "member",
				actions: ["create"],
				indices: [{ identifier: "parent", relationship: "child" }],
				properties: create,
			},
			guard("arrivals/nova_operations/nova_guard_add_arrival_text", "member"),
		]);
	});

	it("reads a close in Case Management with its condition, and an own close in a block of its own", () => {
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
				condition: ALWAYS,
				closeCondition: {
					type: "if",
					question: "outcome",
					answer: "moved",
					operator: "=",
				},
				sessionDatum: "case_id",
				ownerWritten: false,
				properties: {},
				editOnly: [],
			},
		]);
		expect(
			formOf(
				caseWrites,
				xmlns("F6A05AB4-66FD-58D8-AC89-69067CAD3964"),
			).blocks.map((block) => [
				block.kind,
				block.path,
				block.kind === "save-to-case" ? block.actions : undefined,
			]),
		).toEqual([
			["basic-own", "case", undefined],
			[
				"save-to-case",
				"nova_operations/nova_condition_close/nova_close",
				["close"],
			],
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

	it("reads an extension subcase as the basic build writes it, a child of the own case, and the block that carries the extension in the source", () => {
		const forms = read(
			retainedRead("targeted-migration-extension-children/app-source.json"),
		);
		expect(
			formOf(forms, xmlns("145A1192-EB99-5116-A297-183476567D42")).blocks.map(
				(block) =>
					block.kind === "basic-subcase" || block.kind === "save-to-case"
						? [block.kind, block.path, block.indices]
						: [block.kind, block.path],
			),
		).toEqual([
			["basic-own", "case"],
			["basic-subcase", "subcase_0", [OWN_PARENT]],
			[
				"save-to-case",
				"nova_subcases/nova_subcase_0",
				[{ identifier: "parent", relationship: "extension" }],
			],
		]);
		// An inactive subcase keeps its block, with its `never`.
		expect(
			formOf(forms, xmlns("145A1192-EB99-5116-A297-183476567D42")).blocks.find(
				(block) => block.kind === "basic-subcase",
			),
		).toMatchObject({ condition: NEVER });
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
		const hqBuilt = readAll(hqBuiltSource);
		// The registration form, by where the read holds it: its xmlns derives
		// from the fixture's ids, which move as the corpus grows.
		const registration = (
			hqBuiltSource.modules as { forms: { xmlns: string }[] }[]
		)[0]?.forms[1]?.xmlns;
		if (registration === undefined)
			throw new Error("The HQ-built read lost its registration form.");
		expect(formOf(hqBuilt.forms, registration).blocks.map(plain)).toEqual([
			{
				kind: "basic-own",
				path: "case",
				caseType: "patient",
				opens: true,
				closes: false,
				condition: ALWAYS,
				closeCondition: NEVER,
				sessionDatum: "case_id_new_patient_0",
				ownerWritten: false,
				properties: {
					name: "/data/nova_trimmed_name",
					external_id: "/data/nova_trimmed_external",
				},
				editOnly: [],
			},
		]);
		// An advanced form HQ made with no actions writes no block, and the
		// shadow form, which has no xmlns of its own, is listed as left out.
		expect(
			formOf(
				hqBuilt.forms,
				"http://openrosa.org/formdesigner/61BCD95D-0A17-4E62-BFC9-E102629BCC19",
			).blocks,
		).toEqual([]);
		expect(hqBuilt.forms.size).toBe(4);
		expect(hqBuilt.unread).toEqual([
			{ menu: 1, form: 2, xmlns: null, reason: "shadow-form" },
		]);

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

/** The retained case-writes source, edited by `edit` before it is read. */
function editedCaseWrites(
	edit: (
		modules: Record<string, unknown>[],
		attachments: Record<string, string>,
	) => void,
): PublishedCaseBlocks {
	const source = retainedRead("targeted-migration-case-writes/app-source.json");
	edit(
		source.modules as Record<string, unknown>[],
		source._attachments as Record<string, string>,
	);
	return readAll(source);
}

type Json = Record<string, unknown>;
const formsOf = (module: Json) => module.forms as Json[];
const actionsOf = (form: Json) => form.actions as Json;

describe("the session value an own block reads", () => {
	const visit = (blocks: PublishedCaseBlocks) =>
		formOf(
			blocks.forms,
			"http://openrosa.org/formdesigner/BE01648F-79F0-5EDB-A6E1-4EAD8A75885F",
		).blocks.find((block) => block.kind === "basic-own");

	it("is read from the entry, and so is null, in a menu under a parent menu or with a parent selection", () => {
		expect(
			visit(
				editedCaseWrites((modules) => {
					modules[1].root_module_id = "a-parent-menu";
				}),
			),
		).toMatchObject({ sessionDatum: null });
		expect(
			visit(
				editedCaseWrites((modules) => {
					modules[1].parent_select = {
						active: true,
						relationship: "parent",
						module_id: "a-parent-menu",
					};
				}),
			),
		).toMatchObject({ sessionDatum: null });
		// An inactive selection is none.
		expect(
			visit(
				editedCaseWrites((modules) => {
					modules[1].parent_select = {
						active: false,
						relationship: "parent",
						module_id: "a-parent-menu",
					};
				}),
			),
		).toMatchObject({ sessionDatum: "case_id" });
	});
});

describe("owners and `update_mode: edit`", () => {
	it("reads owner_id among a block's updates, and every `edit` key, on the own, worker and child blocks", () => {
		const blocks = editedCaseWrites((modules) => {
			const [registration] = formsOf(modules[0]);
			const actions = actionsOf(registration);
			const update = (actions.update_case as Json).update as Json;
			update.owner_id = { question_path: "/data/village" };
			update.village = { question_path: "/data/village", update_mode: "edit" };
			const [head] = actions.subcases as Json[];
			head.case_properties = {
				owner_id: { question_path: "/data/village" },
				age: { question_path: "/data/village", update_mode: "edit" },
			};
			const [visit] = formsOf(modules[1]);
			const worker = actionsOf(visit).usercase_update as Json;
			worker.update = {
				visits_done: {
					question_path: "/data/visits_done",
					update_mode: "edit",
				},
			};
		});
		const registration = formOf(
			blocks.forms,
			"http://openrosa.org/formdesigner/195EBC95-CD9C-53F9-ACB3-96C77E70AE25",
		);
		expect(registration.blocks.map(plain)).toEqual([
			expect.objectContaining({
				kind: "basic-own",
				ownerWritten: true,
				editOnly: ["village"],
			}),
			expect.objectContaining({
				kind: "basic-subcase",
				index: 0,
				ownerWritten: true,
				editOnly: ["age"],
			}),
			expect.objectContaining({
				kind: "basic-subcase",
				index: 1,
				ownerWritten: false,
				editOnly: [],
			}),
		]);
		expect(
			formOf(
				blocks.forms,
				"http://openrosa.org/formdesigner/BE01648F-79F0-5EDB-A6E1-4EAD8A75885F",
			)
				.blocks.map(plain)
				.find((block) => block.kind === "basic-usercase"),
		).toMatchObject({ editOnly: ["visits_done"] });
	});

	it("says a source holds `edit` where any block of each kind holds it, and holds none where none does", () => {
		const unedited = readAll(
			retainedRead("targeted-migration-case-writes/app-source.json"),
		);
		expect(sourceHoldsEditMode(unedited)).toBe(false);
		const edit = { question_path: "/data/village", update_mode: "edit" };
		const sources = {
			own: editedCaseWrites((modules) => {
				const actions = actionsOf(formsOf(modules[0])[0]);
				((actions.update_case as Json).update as Json).village = edit;
			}),
			child: editedCaseWrites((modules) => {
				const actions = actionsOf(formsOf(modules[0])[0]);
				(actions.subcases as Json[])[1].case_properties = { age: edit };
			}),
			worker: editedCaseWrites((modules) => {
				const actions = actionsOf(formsOf(modules[1])[0]);
				(actions.usercase_update as Json).update = { visits_done: edit };
			}),
		};
		for (const [kind, blocks] of Object.entries(sources))
			expect(sourceHoldsEditMode(blocks), kind).toBe(true);

		const advanced = (property: "load" | "open") =>
			publishedCaseBlocks({
				doc_type: "Application",
				modules: [
					{
						doc_type: "AdvancedModule",
						case_type: "test_case_type",
						forms: [
							{
								doc_type: "AdvancedForm",
								unique_id: "f",
								xmlns: "http://openrosa.org/formdesigner/advanced",
								actions: {
									load_update_cases: [
										{
											case_type: "test_case_type",
											case_tag: "load_1",
											case_properties:
												property === "load" ? { note: edit } : {},
										},
									],
									open_cases: [
										{
											case_type: "test_case_type",
											case_tag: "open_1",
											name_update: { question_path: "/data/question1" },
											case_properties:
												property === "open" ? { note: edit } : {},
											open_condition: { type: "always" },
										},
									],
								},
							},
						],
					},
				],
				_attachments: { "f.xml": fixture("original_form.xml") },
			});
		expect(sourceHoldsEditMode(advanced("load"))).toBe(true);
		expect(sourceHoldsEditMode(advanced("open"))).toBe(true);
	});
});

describe("what the reader leaves out", () => {
	it("reads nothing from a source that is not an application, or from an empty shell", () => {
		const nothing = { forms: new Map(), unread: [] };
		expect(publishedCaseBlocks(null)).toEqual(nothing);
		expect(publishedCaseBlocks({ doc_type: "LinkedApplication" })).toEqual(
			nothing,
		);
		expect(
			publishedCaseBlocks({ doc_type: "Application", modules: {} }),
		).toEqual(nothing);
		expect(
			publishedCaseBlocks(retainedRead("publish/source-shell.json")),
		).toEqual(nothing);
	});

	it("lists every form it leaves out by its position and with why, and reads the others", () => {
		const several =
			"http://openrosa.org/formdesigner/7650B44A-8C1B-58CE-AE23-ED64DE40945A";
		const blocks = editedCaseWrites((modules, attachments) => {
			const [registration] = formsOf(modules[0]);
			const [visit, discharge, close, ownClose] = formsOf(modules[1]);
			registration.actions = "not an object";
			attachments[`${visit.unique_id as string}.xml`] = "<h:html";
			close.xmlns = discharge.xmlns;
			delete ownClose.xmlns;
		});
		expect([...blocks.forms.keys()]).toEqual([several]);
		expect(formOf(blocks.forms, several)).toEqual(
			formOf(caseWritesRead(), several),
		);
		const discharge =
			"http://openrosa.org/formdesigner/416EDBCC-2FE7-5AA0-AC91-C802BDBB34BC";
		expect(blocks.unread).toEqual([
			{
				menu: 0,
				form: 0,
				xmlns:
					"http://openrosa.org/formdesigner/195EBC95-CD9C-53F9-ACB3-96C77E70AE25",
				reason: "actions-malformed",
			},
			{
				menu: 1,
				form: 0,
				xmlns:
					"http://openrosa.org/formdesigner/BE01648F-79F0-5EDB-A6E1-4EAD8A75885F",
				reason: "xform-unparsed",
			},
			{ menu: 1, form: 1, xmlns: discharge, reason: "shared-xmlns" },
			{ menu: 1, form: 2, xmlns: discharge, reason: "shared-xmlns" },
			{ menu: 1, form: 3, xmlns: null, reason: "no-xmlns" },
		]);
	});

	it("names a form of no kind it reads, an absent XForm, a condition HQ's build cannot state, a data registry's load and a visit schedule", () => {
		const reasons = (blocks: PublishedCaseBlocks) =>
			blocks.unread.map(({ menu, form, reason }) => [menu, form, reason]);
		expect(
			reasons(
				editedCaseWrites((modules, attachments) => {
					const [registration] = formsOf(modules[0]);
					const [visit, discharge, close] = formsOf(modules[1]);
					registration.doc_type = "SurveyForm";
					delete attachments[`${visit.unique_id as string}.xml`];
					(actionsOf(close).close_case as Json).condition = {
						type: "if",
						question: "/elsewhere/outcome",
						answer: "moved",
					};
					(actionsOf(discharge).update_case as Json).update = {
						note: { question_path: "/data/note", update_mode: "sometimes" },
					};
				}),
			),
		).toEqual([
			[0, 0, "unknown-form-kind"],
			[1, 0, "no-xform"],
			[1, 1, "actions-malformed"],
			[1, 2, "actions-malformed"],
		]);
		// A follow-up of a menu whose search loads a data registry's case: the
		// build's block reads a project space setting the source does not say.
		expect(
			reasons(
				editedCaseWrites((modules) => {
					modules[1].search_config = {
						properties: [{ name: "name" }],
						data_registry: "a-registry",
						data_registry_workflow: "load_case",
					};
				}),
			),
		).toEqual([0, 1, 2, 3].map((form) => [1, form, "registry-load"]));
		const scheduled = publishedCaseBlocks({
			doc_type: "Application",
			modules: [
				{
					doc_type: "AdvancedModule",
					case_type: "test_case_type",
					has_schedule: true,
					forms: [
						{
							doc_type: "AdvancedForm",
							unique_id: "f",
							xmlns: "http://openrosa.org/formdesigner/advanced",
							schedule: { enabled: true },
							actions: { load_update_cases: [], open_cases: [] },
						},
					],
				},
			],
			_attachments: { "f.xml": fixture("original_form.xml") },
		});
		expect(reasons(scheduled)).toEqual([[0, 0, "visit-schedule"]]);
	});
});

function caseWritesRead(): ReadonlyMap<string, PublishedForm> {
	return read(retainedRead("targeted-migration-case-writes/app-source.json"));
}
