/** Export regressions for accepted operation programs. Their execution and
 * resulting native case records are checked by CaseOperationRuntimeTest.java. */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { getText } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { datetimeCaseValueExpression } from "@/lib/commcare/xform/datetimeCaseValue";
import { parser } from "@/lib/commcare/xpath/parser";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, proseText } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { w } from "../xpath/wire/builders";
import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";
import {
	caseOperationFixture,
	type OperationScenario,
	operationScenarios,
} from "./caseOperationFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { xpathEvidence } from "./xpathEvidence";

const xformText = (expression: WireExpr) =>
	serializeWire(expression, { target: "xform", constraint: false }).text;

function one(elements: Element[]): Element {
	expect(elements).toHaveLength(1);
	const element = elements[0];
	if (!element) throw new Error("Expected one XML element");
	return element;
}
const children = (element: Element) => element.children.filter(isTag);
const child = (parent: Element, name: string) =>
	one(children(parent).filter((element) => element.name === name));
function tree(xml: string) {
	new SaxesParser({ xmlns: true }).write(xml).close();
	const html = one(
		parseDocument(xml, { xmlMode: true }).children.filter(isTag),
	);
	const model = child(child(html, "h:head"), "model");
	const instance = one(
		children(model).filter(
			(element) => element.name === "instance" && !element.attribs.src,
		),
	);
	return { model, data: child(instance, "data") };
}
/** Every case block under `group` in document order, with its path: an
 * element whose child is the transaction's `<case>`. */
function blocksUnder(
	group: Element,
	groupPath: string,
): Map<string, { element: Element; path: string }> {
	const out = new Map<string, { element: Element; path: string }>();
	const visit = (element: Element, path: string) => {
		for (const next of children(element)) {
			const nextPath = `${path}/${next.name}`;
			if (
				children(next).some(
					(element) =>
						element.name === "case" && element.attribs.xmlns === namespace,
				)
			)
				out.set(next.name, { element: next, path: nextPath });
			else visit(next, nextPath);
		}
	};
	visit(group, groupPath);
	return out;
}
const sequence = ["create_visit", "tag_visit", "unlink_visit", "finish_visit"];
const transitions = ["promote", "rename_promoted", "finish_promoted"];
const expectedOperations: Record<OperationScenario, string[]> = {
	sequence: ["before_ordinary", ...sequence],
	conditional: sequence,
	repeat: sequence,
	query: sequence,
	retype: transitions,
	"expression-retype": transitions,
	key: ["create_visit"],
	"key-query": ["create_visit"],
	link: ["link_patient"],
	scalar: ["rename_patient"],
	relation: ["mark_related"],
	nested: ["update_child", "update_parent"],
};
const selected = "instance('commcaresession')/session/data/case_id";
const namespace = "http://commcarehq.org/case/transaction/v2";
it.each(operationScenarios)(
	"%s: exports the accepted program with complete transaction paths",
	(scenario) => {
		const doc = caseOperationFixture(scenario);
		expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
			true,
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const hq = expandDoc(doc);
		const moduleIndex = scenario === "nested" ? 1 : 0;
		const source =
			hq._attachments[`${hq.modules[moduleIndex].forms[0].unique_id}.xml`];
		if (typeof source !== "string") throw new Error("Missing source XForm");
		const archive = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const device = archive.readAsText(`modules-${moduleIndex}/forms-0.xml`);
		const repeated =
			scenario === "repeat" || scenario === "query" || scenario === "key-query";
		const query = scenario === "query" || scenario === "key-query";
		const keyed = scenario === "key" || scenario === "key-query";
		const scope = query
			? "/data/items/item"
			: scenario === "repeat"
				? "/data/items"
				: "/data";
		for (const [mode, xml] of [
			["source", source],
			["device", device],
		]) {
			const { model, data } = tree(xml);
			const container = query
				? child(child(data, "items"), "item")
				: scenario === "repeat"
					? child(data, "items")
					: data;
			const operations = child(container, "nova_operations");
			const base = `${scope}/nova_operations`;
			const blocks = blocksUnder(operations, base);
			const wrappers = [...blocks.keys()];
			const guards =
				keyed || scenario === "scalar" || scenario === "link"
					? 1
					: scenario === "relation" || scenario === "nested"
						? 0
						: 2;
			expect(wrappers).toHaveLength(
				expectedOperations[scenario].length + guards,
			);
			expect(
				wrappers.filter((name) => !name.startsWith("nova_guard_")),
			).toEqual(expectedOperations[scenario]);
			const binds = (path: string) =>
				children(model).filter(
					(element) =>
						element.name === "bind" && element.attribs.nodeset === path,
				);
			const bind = (path: string) => one(binds(path)).attribs;
			const block = (name: string) => {
				const found = blocks.get(name);
				if (found === undefined) throw new Error(`No block ${name}`);
				return found;
			};
			const at = (name: string) => block(name).path;
			const caseBlock = (name: string) => child(block(name).element, "case");
			for (const wrapper of wrappers) {
				const path = `${at(wrapper)}/case`;
				expect(caseBlock(wrapper).attribs).toEqual({
					case_id: "",
					date_modified: "",
					user_id: "",
					xmlns: namespace,
				});
				expect(bind(`${path}/@date_modified`)).toEqual({
					nodeset: `${path}/@date_modified`,
					calculate: "/data/meta/timeEnd",
					type: "xsd:dateTime",
				});
				expect(bind(`${path}/@user_id`)).toEqual({
					nodeset: `${path}/@user_id`,
					calculate: "/data/meta/userID",
				});
			}
			if (expectedOperations[scenario].includes("create_visit")) {
				expect(
					children(caseBlock("create_visit")).map((element) => element.name),
				).toEqual(["create", "update", "index"]);
				expect(
					children(child(caseBlock("create_visit"), "create")).map(
						(element) => element.name,
					),
				).toEqual(["case_type", "case_name", "owner_id"]);
				expect(
					children(child(caseBlock("create_visit"), "update")).map(
						(element) => element.name,
					),
				).toEqual(
					scenario === "sequence"
						? ["source_id", "occurred_at"]
						: ["source_id"],
				);
				expect(
					child(child(caseBlock("create_visit"), "index"), "parent").attribs,
				).toEqual({ case_type: "patient", relationship: "child" });
				expect(
					xpathEvidence(
						bind(`${at("create_visit")}/case/update/source_id`).calculate,
					),
				).toEqual(
					xpathEvidence(
						`instance('casedb')/casedb/case[@case_id=${selected}]/${scenario === "sequence" ? "nickname" : "case_name"}`,
					),
				);
				expect(
					xpathEvidence(
						bind(`${at("create_visit")}/case/index/parent`).calculate,
					),
				).toEqual(xpathEvidence(selected));
				const id = `${at("create_visit")}/case/@case_id`;
				const seeds = children(model).filter(
					(element) =>
						element.name === "setvalue" && element.attribs.ref === id,
				);
				if (keyed) {
					expect(seeds).toEqual([]);
					const key = repeated ? "current()/../../../../key" : "/data/key";
					expect(xpathEvidence(bind(id).calculate)).toEqual(
						xpathEvidence(
							`if(string-length(${key}) > 0 and string-length(${key}) <= 205, concat('nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:', ${key}), '')`,
						),
					);
				} else if (repeated) {
					expect(seeds).toEqual([]);
					expect(bind(id)).toEqual({ nodeset: id, calculate: "uuid()" });
				} else {
					expect(binds(id)).toEqual([]);
					expect(one(seeds).attribs).toEqual({
						event: "xforms-ready",
						ref: id,
						value: "uuid()",
					});
				}
			}
			if (expectedOperations[scenario].includes("unlink_visit")) {
				expect(
					children(caseBlock("unlink_visit")).map((element) => element.name),
				).toEqual(["update", "index"]);
				expect(
					children(child(caseBlock("unlink_visit"), "update")).map(
						(element) => element.name,
					),
				).toEqual(["case_type"]);
				expect(
					xpathEvidence(
						bind(`${at("unlink_visit")}/case/update/case_type`).calculate,
					),
				).toEqual(xpathEvidence("'visit'"));
				expect(binds(`${at("unlink_visit")}/case/index/parent`)).toEqual([]);
				expect(
					children(caseBlock("finish_visit")).map((element) => element.name),
				).toEqual(["update", "close"]);
				expect(
					children(child(caseBlock("finish_visit"), "update")).map(
						(element) => element.name,
					),
				).toEqual(["final_note"]);
				expect(
					xpathEvidence(
						bind(`${at("finish_visit")}/case/update/final_note`).calculate,
					),
				).toEqual(xpathEvidence("'Finished'"));
				// One block reads another through `current()`, at the root as in
				// a repeat row; each of these stands in its condition group where
				// the operation is conditional.
				const grouped = scenario === "conditional" || repeated ? "../" : "";
				for (const name of ["tag_visit", "unlink_visit", "finish_visit"]) {
					expect(
						xpathEvidence(bind(`${at(name)}/case/@case_id`).calculate),
					).toEqual(
						xpathEvidence(
							`current()/../../../${scenario === "conditional" || (repeated && name === "tag_visit") ? "../" : ""}create_visit/case/@case_id`,
						),
					);
				}
				expect(bind(`${at("tag_visit")}/case/update/nickname`)).toEqual({
					nodeset: `${at("tag_visit")}/case/update/nickname`,
					relevant: repeated
						? `current()/../../../../../${grouped}key = 'write'`
						: "/data/key = 'write'",
					calculate: `current()/../../../../${grouped}create_visit/case/@case_id`,
				});
			}
			if (scenario === "conditional") {
				// A create's condition is its Open Case Condition; an update's or
				// a close's, and every guard's, is its condition group's.
				expect(children(operations).map((element) => element.name)).toEqual([
					"create_visit",
					"nova_condition_create_visit",
					"nova_condition_tag_visit",
					"nova_condition_unlink_visit",
					"nova_condition_finish_visit",
				]);
				expect(
					xpathEvidence(bind(`${base}/create_visit/case`).relevant),
				).toEqual(xpathEvidence("/data/enabled = 'yes'"));
				for (const name of sequence)
					expect(
						xpathEvidence(bind(`${base}/nova_condition_${name}`).relevant),
					).toEqual(xpathEvidence("/data/enabled = 'yes'"));
				for (const name of wrappers) expect(binds(at(name))).toEqual([]);
				expect(at("nova_guard_create_visit_text")).toBe(
					`${base}/nova_condition_create_visit/nova_guard_create_visit_text`,
				);
			}
			if (expectedOperations[scenario] === transitions) {
				expect(
					xpathEvidence(bind(`${base}/nova_condition_promote`).relevant),
				).toEqual(xpathEvidence("/data/enabled = 'yes'"));
				expect(at("promote")).toBe(`${base}/nova_condition_promote/promote`);
				const target =
					scenario === "retype"
						? selected
						: "instance('casedb')/casedb/case[@case_id=(/data/destination) and @case_type='patient']/@case_id";
				for (const name of transitions)
					expect(
						xpathEvidence(bind(`${at(name)}/case/@case_id`).calculate),
					).toEqual(xpathEvidence(target));
				// HQ's form builder writes a row's bind untyped, so the leaf is
				// untyped and its calculate keeps the clock.
				const changedTypeAt = bind(
					`${at("promote")}/case/update/changed_type_at`,
				);
				expect(changedTypeAt.type).toBeUndefined();
				expect(xpathEvidence(changedTypeAt.calculate)).toEqual(
					xpathEvidence(xformText(datetimeCaseValueExpression(w.call("now")))),
				);
				expect(
					xpathEvidence(
						bind(`${at("promote")}/case/update/case_type`).calculate,
					),
				).toEqual(xpathEvidence("'visit'"));
				expect(
					xpathEvidence(
						bind(`${at("finish_promoted")}/case/update/case_type`).calculate,
					),
				).toEqual(xpathEvidence("'visit'"));
				expect(
					children(caseBlock("finish_promoted")).map((element) => element.name),
				).toEqual(["update", "close"]);
			}
			if (scenario === "link") {
				expect(wrappers).toHaveLength(2);
				expect(
					children(caseBlock("link_patient")).map((element) => element.name),
				).toEqual(["update", "index"]);
				const selector =
					"instance('casedb')/casedb/case[@case_id=(/data/destination) and @case_type='patient']/@case_id";
				expect(
					xpathEvidence(
						bind(`${base}/link_patient/case/index/related`).calculate,
					),
				).toEqual(xpathEvidence(selector));
				const guard = wrappers[1];
				expect(guard).toBe("nova_guard_link_patient_type");
				expect(
					children(caseBlock(guard)).map((element) => element.name),
				).toEqual(["update"]);
				const id = "current()/../../../link_patient/case/@case_id";
				expect(
					xpathEvidence(bind(`${base}/${guard}/case/@case_id`).calculate),
				).toEqual(
					xpathEvidence(
						`if(count(${selector}) > 0 and string(${selector}) != ${id}, ${id}, '')`,
					),
				);
			}
			if (scenario === "scalar") {
				expect(
					children(child(caseBlock("rename_patient"), "update")).map(
						(element) => element.name,
					),
				).toEqual(["case_name", "owner_id", "external_id"]);
				for (const [property, question] of [
					["case_name", "answer"],
					["owner_id", "destination"],
					["external_id", "key"],
				]) {
					expect(
						xpathEvidence(
							bind(`${at("rename_patient")}/case/update/${property}`).calculate,
						),
					).toEqual(
						xpathEvidence(
							`replace(/data/${question}, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')`,
						),
					);
				}
				expect(wrappers).toHaveLength(2);
			}
			if (scenario === "relation" || (repeated && !keyed)) {
				const operation = repeated ? "tag_visit" : "mark_related";
				const answer = repeated ? "current()/../../answer" : "/data/answer";
				expect(
					xpathEvidence(bind(`${base}/nova_condition_${operation}`).relevant),
				).toEqual(
					xpathEvidence(
						`count(${selected}) > 0 and selected(join(' ', instance('casedb')/casedb/case[@case_type='visit' and (nickname = ${answer})]/index/parent), ${selected})`,
					),
				);
			}
			if (scenario === "nested") {
				const own = "instance('commcaresession')/session/data/case_id_patient";
				const suite = one(
					parseDocument(archive.readAsText("suite.xml"), {
						xmlMode: true,
					}).children.filter(isTag),
				);
				const entry = one(
					children(suite).filter(
						(element) =>
							element.name === "entry" &&
							children(element).some(
								(node) =>
									node.name === "form" && getText(node) === data.attribs.xmlns,
							),
					),
				);
				expect(
					children(child(entry, "session"))
						.filter((element) => element.name === "datum")
						.map((element) => ({
							...element.attribs,
							nodeset: xpathEvidence(element.attribs.nodeset),
						})),
				).toEqual([
					{
						id: "case_id",
						nodeset: xpathEvidence(
							"instance('casedb')/casedb/case[@case_type='household'][@status='open']",
						),
						value: "./@case_id",
						"detail-select": "m0_case_short",
					},
					{
						id: "case_id_patient",
						nodeset: xpathEvidence(
							"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/case_id]",
						),
						value: "./@case_id",
						"detail-select": "m1_case_short",
						"detail-confirm": "m1_case_long",
					},
				]);
				expect(
					xpathEvidence(bind(`${at("update_child")}/case/@case_id`).calculate),
				).toEqual(xpathEvidence(own));
				expect(
					xpathEvidence(
						bind(`${at("update_child")}/case/update/nickname`).calculate,
					),
				).toEqual(
					xpathEvidence(
						`instance('casedb')/casedb/case[@case_id=${own}]/case_name`,
					),
				);
			}
			if (scenario === "sequence") {
				for (const property of [
					"calculated_at",
					"defaulted_at",
					"visible_at",
				]) {
					const questionPath =
						hq.modules[0].forms[0].actions.update_case.update[property]
							.question_path;
					expect(bind(`/data/${property}`).type).toBe("xsd:dateTime");
					// HQ's ordinary update must read a string carrier that exists in
					// both source and device forms, not the date-valued question.
					expect(bind(questionPath).type).toBe("xsd:string");
					expect(bind(questionPath).calculate).toContain(`/data/${property}`);
				}
				for (const [operation, property, value] of [
					["create_visit", "occurred_at", w.call("now")],
					["before_ordinary", "occurred_at", w.call("now")],
					[
						"before_ordinary",
						"reference_at",
						w.str("2026-04-17T14:23:41+03:00"),
					],
				] as const) {
					// HQ's form builder writes a row's bind untyped, so the leaf is
					// untyped and its calculate keeps the clock.
					const leaf = bind(`${at(operation)}/case/update/${property}`);
					expect(leaf.type).toBeUndefined();
					expect(xpathEvidence(leaf.calculate)).toEqual(
						xpathEvidence(xformText(datetimeCaseValueExpression(value))),
					);
				}
			}
			if (scenario === "sequence" && mode === "device") {
				const names = children(data).map((element) => element.name);
				expect(names.indexOf("nova_operations")).toBeLessThan(
					names.indexOf("case"),
				);
				expect(
					children(child(child(data, "case"), "update")).map(
						(element) => element.name,
					),
				).toEqual(["calculated_at", "defaulted_at", "nickname", "visible_at"]);
			}
		}
	},
);

it("refuses the old repeated-key update fixture at admission", () => {
	const doc = caseOperationFixture("query");
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const form = Object.values(doc.forms).find((form) => form.caseOperations);
	const create = form?.caseOperations?.[0];
	const key = Object.values(doc.fields).find((field) => field.id === "key");
	if (!create || !key) throw new Error("Missing operation fixture identity");
	create.target = { kind: "new", idFrom: key.uuid };
	expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
		true,
	);
	expect(
		runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(finding) => finding.code,
		),
	).toEqual([
		"CASE_OPERATION_EXECUTION_ORDER",
		"CASE_OPERATION_EXECUTION_ORDER",
		"CASE_OPERATION_EXECUTION_ORDER",
	]);
});

/** The form source HQ receives for the fixture's operation form. */
function sourceOf(doc: BlueprintDoc, moduleIndex = 0) {
	const hq = expandDoc(doc);
	const source =
		hq._attachments[`${hq.modules[moduleIndex].forms[0].unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing source XForm");
	const parsed = tree(source);
	const html = parsed.model.parent?.parent;
	if (!html || !isTag(html)) throw new Error("Missing form root");
	return { ...parsed, body: child(html, "h:body") };
}
const bindsOf = (model: Element) =>
	children(model).filter((element) => element.name === "bind");
const fieldUuid = (doc: BlueprintDoc, id: string) => {
	const field = Object.values(doc.fields).find((field) => field.id === id);
	if (field === undefined) throw new Error(`No field ${id}`);
	return field.uuid;
};

/** The outermost location paths of an expression. */
function locationPaths(source: string): string[] {
	const out: string[] = [];
	parser.parse(source).iterate({
		enter(cursor) {
			if (cursor.name !== "Child" && cursor.name !== "Descendant") return;
			out.push(source.slice(cursor.from, cursor.to));
			return false;
		},
	});
	return out;
}

it("writes one update-only guard of each kind after its operation's block, reading the block through current()", () => {
	const doc = caseOperationFixture("expression-retype");
	const promote = Object.values(doc.forms).find(
		(form) => form.caseOperations !== undefined,
	)?.caseOperations?.[0];
	if (promote === undefined) throw new Error("Missing promote");
	promote.rename = term(formField(fieldUuid(doc, "answer")));
	promote.links = ["first", "second"].map((identifier) => ({
		identifier,
		targetType: "patient",
		relationship: "child" as const,
		target: {
			kind: "expression" as const,
			expr: term(formField(fieldUuid(doc, "destination"))),
		},
	}));
	const { model, data } = sourceOf(doc);
	const group = child(child(data, "nova_operations"), "nova_condition_promote");
	const base = "/data/nova_operations/nova_condition_promote";
	expect(children(group).map((element) => element.name)).toEqual([
		"promote",
		"nova_guard_promote_type",
		"nova_guard_promote_retype",
		"nova_guard_promote_text",
	]);
	for (const kind of ["type", "retype", "text"]) {
		const name = `nova_guard_promote_${kind}`;
		const guard = child(group, name);
		expect(guard.attribs).toEqual({
			"vellum:role": "SaveToCase",
			"vellum:case_type": "visit",
		});
		expect(
			children(child(guard, "case")).map((element) => [
				element.name,
				children(element).map((leaf) => leaf.name),
			]),
		).toEqual([["update", ["case_type"]]]);
		const path = `${base}/${name}/case`;
		const guardBinds = bindsOf(model).filter((bind) =>
			bind.attribs.nodeset?.startsWith(`${path}/`),
		);
		expect(guardBinds.map((bind) => bind.attribs.nodeset)).toEqual([
			`${path}/update/case_type`,
			`${path}/@date_modified`,
			`${path}/@user_id`,
			`${path}/@case_id`,
		]);
		expect(xpathEvidence(guardBinds[0].attribs.calculate)).toEqual(
			xpathEvidence("'visit'"),
		);
		const reads = locationPaths(guardBinds[3].attribs.calculate ?? "").filter(
			(read) => read.includes("promote/case"),
		);
		expect(reads.length).toBeGreaterThan(0);
		for (const read of reads) expect(read.startsWith("current()/")).toBe(true);
	}
	const typeCheck =
		bindsOf(model).find(
			(bind) =>
				bind.attribs.nodeset ===
				`${base}/nova_guard_promote_type/case/@case_id`,
		)?.attribs.calculate ?? "";
	// One type guard holds both links: one test per link, in link order.
	const counts: string[] = [];
	parser.parse(typeCheck).iterate({
		enter(cursor) {
			const name = cursor.node.getChild("FunctionName");
			if (cursor.name === "Invoke" && name !== null)
				counts.push(typeCheck.slice(name.from, name.to));
		},
	});
	expect(counts.filter((name) => name === "count")).toHaveLength(2);
});

it("checks an external_id write declared datetime in its text guard", () => {
	const doc = caseOperationFixture("scalar");
	const operation = Object.values(doc.forms).find(
		(form) => form.caseOperations !== undefined,
	)?.caseOperations?.[0];
	const patient = doc.caseTypes?.find((type) => type.name === "patient");
	if (operation === undefined || patient === undefined)
		throw new Error("Missing scalar fixture identity");
	// The external_id write is the operation's only text-guarded value.
	operation.rename = undefined;
	operation.owner = undefined;
	patient.properties = [
		...patient.properties.filter((property) => property.name !== "external_id"),
		{
			name: "external_id",
			label: proseText("External ID"),
			data_type: "datetime",
		},
	];
	const { model } = sourceOf(doc);
	const calculate = (nodeset: string) =>
		bindsOf(model).find((bind) => bind.attribs.nodeset === nodeset)?.attribs
			.calculate ?? "";
	const leaf = "/data/nova_operations/rename_patient/case/update/external_id";
	expect(xpathEvidence(calculate(leaf))).toEqual(
		xpathEvidence(
			`replace(${xformText(datetimeCaseValueExpression(w.form(["key"])))}, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')`,
		),
	);
	const check = calculate(
		"/data/nova_operations/nova_guard_rename_patient_text/case/@case_id",
	);
	expect(check.startsWith("if(, ")).toBe(false);
	expect(
		locationPaths(check).some((path) =>
			path.endsWith("rename_patient/case/update/external_id"),
		),
	).toBe(true);
});

it("puts a root create keyed by an answer in a one-row repeat inside the operations group", () => {
	const { model, data, body } = sourceOf(caseOperationFixture("key"));
	const operations = child(data, "nova_operations");
	expect(children(operations).map((element) => element.name)).toEqual([
		"nova_count_nova_keyed_create_visit",
		"nova_keyed_create_visit",
		"nova_guard_create_visit_text",
	]);
	const keyed = child(operations, "nova_keyed_create_visit");
	expect(keyed.attribs).toEqual({ "jr:template": "" });
	expect(children(keyed).map((element) => element.name)).toEqual([
		"create_visit",
	]);
	const count = "/data/nova_operations/nova_count_nova_keyed_create_visit";
	const id =
		"/data/nova_operations/nova_keyed_create_visit/create_visit/case/@case_id";
	expect(
		bindsOf(model).find((bind) => bind.attribs.nodeset === count)?.attribs,
	).toEqual({ nodeset: count, type: "xsd:int", calculate: "1" });
	expect(
		bindsOf(model).find((bind) => bind.attribs.nodeset === id)?.attribs
			.calculate,
	).toContain("/data/key");
	expect(
		children(model).filter(
			(element) => element.name === "setvalue" && element.attribs.ref === id,
		),
	).toEqual([]);
	const control = children(body)[0];
	expect(control.attribs).toEqual({ ref: "/data/nova_operations" });
	const repeat = one(children(one(children(control))));
	expect(repeat.name).toBe("repeat");
	expect(repeat.attribs).toEqual({
		nodeset: "/data/nova_operations/nova_keyed_create_visit",
		"jr:count": count,
		"jr:noAddRemove": "true()",
	});
	// The guard stands outside the repeat and reads the block through it.
	expect(
		bindsOf(model).find(
			(bind) =>
				bind.attribs.nodeset ===
				"/data/nova_operations/nova_guard_create_visit_text/case/@case_id",
		)?.attribs.calculate,
	).toContain(
		"current()/../../../nova_keyed_create_visit/create_visit/case/@case_id",
	);
});

it.each([
	["sequence", "a create at the root", "setvalue", "uuid()"],
	["repeat", "a create in a repeat", "bind", "uuid()"],
	["key-query", "a keyed create in a repeat", "bind", "nova-case-v1:"],
] as const)(
	"%s: %s keeps its own id spelling and needs no keyed repeat",
	(scenario, _what, spelling, value) => {
		const { model, data } = sourceOf(caseOperationFixture(scenario));
		const operations = blocksUnder(
			child(
				scenario === "key-query"
					? child(child(data, "items"), "item")
					: scenario === "repeat"
						? child(data, "items")
						: data,
				"nova_operations",
			),
			scenario === "key-query"
				? "/data/items/item/nova_operations"
				: scenario === "repeat"
					? "/data/items/nova_operations"
					: "/data/nova_operations",
		);
		const create = operations.get("create_visit");
		if (create === undefined) throw new Error("Missing create");
		expect(create.path).not.toContain("nova_keyed_");
		const id = `${create.path}/case/@case_id`;
		const carriers = children(model).filter((element) =>
			spelling === "setvalue"
				? element.name === "setvalue" && element.attribs.ref === id
				: element.name === "bind" && element.attribs.nodeset === id,
		);
		expect(
			one(carriers).attribs[spelling === "setvalue" ? "value" : "calculate"],
		).toContain(value);
	},
);
