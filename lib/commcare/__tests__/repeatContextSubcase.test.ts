/** Scoped repeat transactions from accepted apps. Native Core execution of
 * user/query repeats is covered by the capture proof; this matrix checks
 * multiple child buckets, count repeats, cousin scopes and suite allocation. */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, proseText } from "@/lib/domain";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

function one(elements: Element[]): Element {
	expect(elements).toHaveLength(1);
	const element = elements[0];
	if (!element) throw new Error("Missing XML element");
	return element;
}
function child(parent: Element, name: string): Element {
	return one(parent.children.filter(isTag).filter((e) => e.name === name));
}
function parse(xml: string) {
	new SaxesParser({ xmlns: true }).write(xml).close();
	return one(parseDocument(xml, { xmlMode: true }).children.filter(isTag));
}
function nameWriter(caseType: string): FieldSpec {
	return f({
		kind: "text",
		id: "case_name",
		caseWrite: { caseType, property: "case_name" },
	});
}
function fixture(fields: FieldSpec[], types: string[]) {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	return buildDoc({
		appName: "Repeated case evidence",
		caseTypes: ["household", ...types].map((name) => ({
			name,
			...(name === "household" ? {} : { parent_type: "household" }),
			properties: [{ name: "case_name", label: proseText("Name") }],
		})),
		modules: [
			{
				name: "Parents",
				caseType: "household",
				caseListConfig: list(),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [nameWriter("household"), ...fields],
					},
				],
			},
			...types.map((name) => ({
				name,
				caseType: name,
				caseListOnly: true,
				caseListConfig: list(),
				forms: [],
			})),
		],
	});
}
function compile(doc: ReturnType<typeof buildDoc>) {
	expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
		true,
	);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	);
	const html = parse(zip.readAsText("modules-0/forms-0.xml"));
	const model = child(child(html, "h:head"), "model");
	const data = child(
		one(
			model.children
				.filter(isTag)
				.filter((e) => e.name === "instance" && e.attribs.src === undefined),
		),
		"data",
	);
	const suite = parse(zip.readAsText("suite.xml"));
	const entry = one(
		suite.children
			.filter(isTag)
			.filter(
				(e) =>
					e.name === "entry" &&
					e.children
						.filter(isTag)
						.some(
							(e) =>
								e.name === "form" &&
								e.children.some(
									(t) =>
										t.type === "text" &&
										t.data === hq.modules[0].forms[0].xmlns,
								),
						),
			),
	);
	const binds = (path: string) =>
		one(
			model.children
				.filter(isTag)
				.filter((e) => e.name === "bind" && e.attribs.nodeset === path),
		).attribs;
	const setvalues = (path: string) =>
		model.children
			.filter(isTag)
			.filter((e) => e.name === "setvalue" && e.attribs.ref === path)
			.map((e) => e.attribs);
	return {
		data,
		body: child(html, "h:body"),
		binds,
		setvalues,
		datums: child(entry, "session")
			.children.filter(isTag)
			.map((e) => e.attribs),
	};
}
function assertChild(
	output: ReturnType<typeof compile>,
	parent: Element,
	casePath: string,
	type: string,
	nameParent: string,
) {
	const namePath = `${nameParent}/case_name`;
	const trimmedPath = `${nameParent}/nova_trimmed_case_name`;
	const transaction = child(parent, "case");
	expect(transaction.attribs).toEqual({
		case_id: "",
		date_modified: "",
		user_id: "",
		xmlns: "http://commcarehq.org/case/transaction/v2",
	});
	expect(transaction.children.filter(isTag).map((e) => e.name)).toEqual([
		"create",
		"update",
		"index",
	]);
	expect(child(child(transaction, "index"), "parent").attribs).toEqual({
		case_type: "household",
	});
	expect(output.binds(`${casePath}/index/parent`)).toEqual({
		nodeset: `${casePath}/index/parent`,
		calculate: "/data/case/@case_id",
	});
	expect(output.binds(`${casePath}/create/case_type`)).toEqual({
		nodeset: `${casePath}/create/case_type`,
		calculate: `'${type}'`,
	});
	// The create names the question's trimmed sibling, which carries the trim
	// and HQ's inert required stamp; the question carries the requirement and
	// the check a worker meets.
	expect(output.binds(`${casePath}/create/case_name`)).toEqual({
		nodeset: `${casePath}/create/case_name`,
		calculate: trimmedPath,
	});
	expect(output.binds(trimmedPath)).toEqual({
		nodeset: trimmedPath,
		calculate: `replace(${namePath}, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')`,
		relevant: `count(${namePath}) > 0`,
		required: "true()",
	});
	expect(output.binds(namePath)).toEqual({
		nodeset: namePath,
		type: "xsd:string",
		required: "true()",
		constraint: NAME_CHECK,
	});
}
const TRIMMED_ANSWER = "replace(., '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')";
const NAME_CHECK = `string-length(${TRIMMED_ANSWER}) > 0 and string-length(${TRIMMED_ANSWER}) <= 255`;
for (const mode of ["user_controlled", "count_bound", "query_bound"] as const) {
	for (const count of [1, 2]) {
		it(`${mode}: ${count} child buckets retain their answer scope and per-iteration identity`, () => {
			const types = count === 1 ? ["child1"] : ["child1", "child2"];
			const repeat = f({
				kind: "repeat",
				id: "children",
				repeat_mode: mode,
				...(mode === "count_bound"
					? { repeat_count: "2" }
					: mode === "query_bound"
						? { data_source: { ids_query: "'first second'" } }
						: {}),
				children:
					count === 1
						? [nameWriter("child1")]
						: types.map((type) =>
								f({
									kind: "group",
									id: `${type}_section`,
									children: [nameWriter(type)],
								}),
							),
			});
			const output = compile(fixture([repeat], types));
			const outer = child(output.data, "children");
			const template = mode === "query_bound" ? child(outer, "item") : outer;
			expect(template.attribs["jr:template"]).toBe("");
			const scope =
				mode === "query_bound" ? "/data/children/item" : "/data/children";
			expect(template.children.filter(isTag).map((e) => e.name)).toEqual(
				// HQ inserts a repeat's single subcase block as the item's first
				// child, and appends one wrapper per subcase when there are several.
				count === 1
					? ["case", "case_name", "nova_trimmed_case_name"]
					: ["child1_section", "child2_section", "subcase_0", "subcase_1"],
			);
			for (let index = 0; index < types.length; index++) {
				const type = types[index];
				const holder =
					count === 1 ? template : child(template, `subcase_${index}`);
				const path =
					count === 1 ? `${scope}/case` : `${scope}/subcase_${index}/case`;
				assertChild(
					output,
					holder,
					path,
					type,
					count === 1 ? scope : `${scope}/${type}_section`,
				);
				expect(output.binds(`${path}/@case_id`)).toEqual({
					nodeset: `${path}/@case_id`,
					calculate: "uuid()",
				});
				expect(output.setvalues(`${path}/@case_id`)).toEqual([]);
			}
			const control = one(
				findAll((e) => e.name === "repeat", output.body.children),
			);
			expect(control.attribs).toEqual({
				nodeset: scope,
				...(mode === "count_bound"
					? {
							"jr:count": "/data/nova_count_children",
							"jr:noAddRemove": "true()",
						}
					: mode === "query_bound"
						? {
								"jr:count": "/data/children/@count",
								"jr:noAddRemove": "true()",
							}
						: {}),
			});
			if (mode === "count_bound") {
				expect(child(output.data, "nova_count_children").children).toEqual([]);
				expect(output.binds("/data/nova_count_children")).toEqual({
					nodeset: "/data/nova_count_children",
					type: "xsd:int",
					calculate: "2",
				});
				expect(output.setvalues("/data/nova_count_children")).toEqual([]);
			}
			expect(output.datums).toEqual([
				{ id: "case_id_new_household_0", function: "uuid()" },
			]);
		});
	}
}
it("keeps identical cousin question IDs in independent repeat case buckets", () => {
	const output = compile(
		fixture(
			["family", "neighbors"].map((id) =>
				f({
					kind: "repeat",
					id,
					repeat_mode: "user_controlled",
					children: [nameWriter("person")],
				}),
			),
			["person"],
		),
	);
	for (const id of ["family", "neighbors"]) {
		const scope = `/data/${id}`;
		assertChild(
			output,
			child(output.data, id),
			`${scope}/case`,
			"person",
			scope,
		);
		expect(output.binds(`${scope}/case/@case_id`)).toEqual({
			nodeset: `${scope}/case/@case_id`,
			calculate: "uuid()",
		});
	}
	expect(output.datums).toEqual([
		{ id: "case_id_new_household_0", function: "uuid()" },
	]);
});
it("preserves global action indices across root, repeat and root child creates", () => {
	const output = compile(
		fixture(
			[
				f({
					kind: "group",
					id: "guardian",
					children: [nameWriter("guardian")],
				}),
				f({
					kind: "repeat",
					id: "children",
					repeat_mode: "user_controlled",
					children: [nameWriter("child")],
				}),
				f({ kind: "group", id: "consent", children: [nameWriter("consent")] }),
			],
			["guardian", "child", "consent"],
		),
	);
	for (const [type, index, datum] of [
		["guardian", 0, "case_id_new_guardian_1"],
		["consent", 2, "case_id_new_consent_3"],
	] as const) {
		const path = `/data/subcase_${index}/case`;
		assertChild(
			output,
			child(output.data, `subcase_${index}`),
			path,
			type,
			`/data/${type}`,
		);
		expect(output.setvalues(`${path}/@case_id`)).toEqual([
			{
				ref: `${path}/@case_id`,
				event: "xforms-ready",
				value: `instance('commcaresession')/session/data/${datum}`,
			},
		]);
	}
	assertChild(
		output,
		child(output.data, "children"),
		"/data/children/case",
		"child",
		"/data/children",
	);
	expect(output.binds("/data/children/case/@case_id")).toEqual({
		nodeset: "/data/children/case/@case_id",
		calculate: "uuid()",
	});
	// The data node's order is HQ's: fields, the subcase blocks, then the
	// form's own case, then meta (`xform.py::XForm._create_casexml`).
	expect(output.data.children.filter(isTag).map((e) => e.name)).toEqual([
		"case_name",
		"nova_trimmed_case_name",
		"guardian",
		"children",
		"consent",
		"subcase_0",
		"subcase_2",
		"case",
		"orx:meta",
	]);
	expect(output.datums).toEqual([
		{ id: "case_id_new_household_0", function: "uuid()" },
		{ id: "case_id_new_guardian_1", function: "uuid()" },
		{ id: "case_id_new_consent_3", function: "uuid()" },
	]);
});
