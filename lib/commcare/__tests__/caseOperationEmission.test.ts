/** Export regressions for accepted operation programs. Their execution and
 * resulting native case records are checked by CaseOperationRuntimeTest.java. */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { getText } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import {
	caseOperationFixture,
	type OperationScenario,
	operationScenarios,
} from "./caseOperationFixture";

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
	expect(XMLValidator.validate(xml)).toBe(true);
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
	nested: ["update_child"],
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
		const archive = new AdmZip(compileCcz(hq, doc.appName, doc));
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
			const operations = child(container, "__nova_operations");
			const wrappers = children(operations);
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
				wrappers
					.filter((element) => !element.name.startsWith("__nova_guard_"))
					.map((element) => element.name),
			).toEqual(expectedOperations[scenario]);
			const binds = (path: string) =>
				children(model).filter(
					(element) =>
						element.name === "bind" && element.attribs.nodeset === path,
				);
			const bind = (path: string) => one(binds(path)).attribs;
			const base = `${scope}/__nova_operations`;
			const caseBlock = (name: string) =>
				child(child(operations, name), "case");
			for (const wrapper of wrappers) {
				const path = `${base}/${wrapper.name}/case`;
				expect(child(wrapper, "case").attribs).toEqual({
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
				).toEqual(["source_id"]);
				expect(
					child(child(caseBlock("create_visit"), "index"), "parent").attribs,
				).toEqual({ case_type: "patient", relationship: "child" });
				expect(
					bind(`${base}/create_visit/case/update/source_id`).calculate,
				).toBe(
					`instance('casedb')/casedb/case[@case_id=${selected}]/${scenario === "sequence" ? "nickname" : "case_name"}`,
				);
				expect(bind(`${base}/create_visit/case/index/parent`).calculate).toBe(
					selected,
				);
				const id = `${base}/create_visit/case/@case_id`;
				const seeds = children(model).filter(
					(element) =>
						element.name === "setvalue" && element.attribs.ref === id,
				);
				if (keyed) {
					expect(seeds).toEqual([]);
					const key = repeated ? "current()/../../../../key" : "/data/key";
					expect(bind(id).calculate).toBe(
						`if(string-length(${key}) > 0 and string-length(${key}) <= 205, concat('nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:', ${key}), '')`,
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
					bind(`${base}/unlink_visit/case/update/case_type`).calculate,
				).toBe("'visit'");
				expect(binds(`${base}/unlink_visit/case/index/parent`)).toEqual([]);
				expect(
					children(caseBlock("finish_visit")).map((element) => element.name),
				).toEqual(["update", "close"]);
				expect(
					children(child(caseBlock("finish_visit"), "update")).map(
						(element) => element.name,
					),
				).toEqual(["final_note"]);
				expect(
					bind(`${base}/finish_visit/case/update/final_note`).calculate,
				).toBe("'Finished'");
				for (const name of ["tag_visit", "unlink_visit", "finish_visit"]) {
					expect(bind(`${base}/${name}/case/@case_id`).calculate).toBe(
						repeated
							? "current()/../../../create_visit/case/@case_id"
							: "/data/__nova_operations/create_visit/case/@case_id",
					);
				}
				expect(bind(`${base}/tag_visit/case/update/nickname`)).toEqual({
					nodeset: `${base}/tag_visit/case/update/nickname`,
					relevant: repeated
						? "current()/../../../../../key = 'write'"
						: "/data/key = 'write'",
					calculate: repeated
						? "current()/../../../../create_visit/case/@case_id"
						: "/data/__nova_operations/create_visit/case/@case_id",
				});
			}
			if (scenario === "conditional") {
				for (const wrapper of wrappers)
					expect(bind(`${base}/${wrapper.name}`).relevant).toBe(
						"/data/enabled = 'yes'",
					);
			}
			if (expectedOperations[scenario] === transitions) {
				for (const wrapper of wrappers)
					expect(bind(`${base}/${wrapper.name}`).relevant).toBe(
						"/data/enabled = 'yes'",
					);
				const target =
					scenario === "retype"
						? selected
						: "instance('casedb')/casedb/case[@case_id=(/data/destination) and @case_type='patient']/@case_id";
				for (const name of transitions)
					expect(bind(`${base}/${name}/case/@case_id`).calculate).toBe(target);
				expect(bind(`${base}/promote/case/update/case_type`).calculate).toBe(
					"'visit'",
				);
				expect(
					bind(`${base}/finish_promoted/case/update/case_type`).calculate,
				).toBe("'visit'");
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
				expect(bind(`${base}/link_patient/case/index/related`).calculate).toBe(
					selector,
				);
				const guard = wrappers[1].name;
				expect(
					children(caseBlock(guard)).map((element) => element.name),
				).toEqual(["update"]);
				expect(bind(`${base}/${guard}/case/@case_id`).calculate).toBe(
					`if(count(${selector}) > 0 and string(${selector}) != ${base}/link_patient/case/@case_id, ${base}/link_patient/case/@case_id, '')`,
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
						bind(`${base}/rename_patient/case/update/${property}`).calculate,
					).toBe(
						`replace(/data/${question}, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')`,
					);
				}
				expect(wrappers).toHaveLength(2);
			}
			if (scenario === "relation" || (repeated && !keyed)) {
				const operation = repeated ? "tag_visit" : "mark_related";
				const answer = repeated ? "current()/../../answer" : "/data/answer";
				expect(bind(`${base}/${operation}`).relevant).toBe(
					`count(${selected}) > 0 and selected(join(' ', instance('casedb')/casedb/case[@case_type='visit' and (nickname = ${answer})]/index/parent), ${selected})`,
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
						.map((element) => element.attribs),
				).toEqual([
					{
						id: "case_id",
						nodeset:
							"instance('casedb')/casedb/case[@case_type='household'][@status='open']",
						value: "./@case_id",
						"detail-select": "m0_case_short",
					},
					{
						id: "case_id_patient",
						nodeset:
							"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/case_id]",
						value: "./@case_id",
						"detail-select": "m1_case_short",
						"detail-confirm": "m1_case_long",
					},
				]);
				expect(bind(`${base}/update_child/case/@case_id`).calculate).toBe(own);
				expect(
					bind(`${base}/update_child/case/update/nickname`).calculate,
				).toBe(`instance('casedb')/casedb/case[@case_id=${own}]/case_name`);
			}
			if (scenario === "sequence" && mode === "device") {
				const names = children(data).map((element) => element.name);
				expect(names.indexOf("__nova_operations")).toBeLessThan(
					names.indexOf("case"),
				);
				expect(
					children(child(child(data, "case"), "update")).map(
						(element) => element.name,
					),
				).toEqual(["nickname"]);
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
