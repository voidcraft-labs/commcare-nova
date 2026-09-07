import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { expandDoc } from "../expander";
import { runValidation } from "../validator/runner";

export const containerScenarios = [
	"titled",
	"untitled",
	"empty",
	"transparent",
	"labelled",
	"user",
	"nested",
	"registration",
	"path",
	"literal",
	"expression",
	"cousins",
	"query",
	"nested-query",
	"path-late",
	"nested-count",
] as const;
export type ContainerScenario = (typeof containerScenarios)[number];
const text = (id: string) => f({ kind: "text", id, label: proseText(id) });
const count = (id: string, value: string) =>
	f({
		kind: "repeat",
		id,
		label: proseText(id),
		repeat_mode: "count_bound",
		repeat_count: value,
		children: [text("answer")],
	});
const group = (id: string, children: FieldSpec[]) =>
	f({ kind: "group", id, label: proseText(id), children });
export function containerWireFixture(scenario: ContainerScenario) {
	let fields: FieldSpec[];
	switch (scenario) {
		case "titled":
			fields = [
				f({
					kind: "section",
					id: "page",
					label: proseText("About you"),
					children: [text("answer")],
				}),
			];
			break;
		case "untitled":
			fields = [f({ kind: "section", id: "page", children: [text("answer")] })];
			break;
		case "empty":
			fields = [
				f({ kind: "section", id: "page", children: [text("answer")] }),
				f({
					kind: "section",
					id: "empty",
					label: proseText("Later"),
					children: [],
				}),
			];
			break;
		case "transparent":
			fields = [
				f({
					kind: "group",
					id: "page",
					label: proseText(""),
					children: [text("answer")],
				}),
			];
			break;
		case "labelled":
			fields = [group("page", [text("answer")])];
			break;
		case "user":
			fields = [
				f({
					kind: "repeat",
					id: "items",
					repeat_mode: "user_controlled",
					label: proseText(""),
					children: [text("answer")],
				}),
			];
			break;
		case "nested":
			fields = [
				f({
					kind: "section",
					id: "page",
					label: proseText("About you"),
					children: [
						group("named", [text("answer")]),
						f({
							kind: "group",
							id: "plain",
							label: proseText(""),
							children: [text("answer")],
						}),
					],
				}),
			];
			break;
		case "registration":
			fields = [
				f({
					kind: "section",
					id: "page",
					label: proseText("About you"),
					children: [
						f({
							kind: "text",
							id: "answer",
							label: proseText("Name"),
							caseWrite: { caseType: "patient", property: "case_name" },
						}),
					],
				}),
			];
			break;
		case "path":
			fields = [
				f({
					kind: "int",
					id: "size",
					label: proseText("Size"),
					default_value: "2",
				}),
				count("items", "#form/size"),
			];
			break;
		case "literal":
			fields = [count("items", "3")];
			break;
		case "expression":
			fields = [
				f({
					kind: "int",
					id: "size",
					label: proseText("Size"),
					default_value: "2",
				}),
				count("items", "#form/size + 2"),
			];
			break;
		case "cousins":
			fields = [
				group("one", [count("items", "3")]),
				group("two", [count("items", "5")]),
			];
			break;
		case "path-late":
			fields = [
				count("items", "#form/size"),
				f({
					kind: "int",
					id: "size",
					label: proseText("Size"),
					default_value: "2",
				}),
			];
			break;
		case "nested-count":
			fields = [
				f({
					kind: "repeat",
					id: "parents",
					label: proseText("Parents"),
					repeat_mode: "query_bound",
					data_source: { ids_query: "'a b'" },
					children: [
						count("items", "#form/parents/size + 1"),
						f({
							kind: "hidden",
							id: "size",
							calculate: "if(current()/../@id = 'a', 1, 2)",
						}),
					],
				}),
			];
			break;

		case "query":
			fields = [
				f({
					kind: "repeat",
					id: "items",
					label: proseText("Items"),
					repeat_mode: "query_bound",
					data_source: { ids_query: "'a b c'" },
					children: [
						f({ kind: "hidden", id: "item_id", calculate: "current()/../@id" }),
						text("answer"),
					],
				}),
			];
			break;
		case "nested-query":
			fields = [
				f({
					kind: "repeat",
					id: "items",
					label: proseText("Items"),
					repeat_mode: "query_bound",
					data_source: { ids_query: "'a b'" },
					children: [
						f({
							kind: "hidden",
							id: "child_ids",
							calculate: "if(current()/../@id = 'a', 'a1 a2', 'b1')",
						}),
						f({
							kind: "repeat",
							id: "children",
							label: proseText("Children"),
							repeat_mode: "query_bound",
							data_source: { ids_query: "#form/items/child_ids" },
							children: [
								f({
									kind: "hidden",
									id: "item_id",
									calculate: "current()/../@id",
								}),
								text("answer"),
							],
						}),
					],
				}),
			];
			break;
	}
	const doc = buildDoc({
		appName: `Containers ${scenario}`,
		...(scenario === "registration" && {
			caseTypes: [{ name: "patient", properties: [] }],
		}),
		modules: [
			{
				name: "M",
				...(scenario === "registration" && {
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				}),
				forms: [
					{
						name: "F",
						type: scenario === "registration" ? "registration" : "survey",
						fields,
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify({ scenario, findings }));
	return doc;
}

// Parsed structure only. Native form-entry compatibility is owned by ContainerRuntimeTest.
export function containerXml(scenario: ContainerScenario) {
	const hq = expandDoc(containerWireFixture(scenario));
	const xml = Object.values(hq._attachments)[0];
	if (typeof xml !== "string") throw new Error("Missing form attachment");
	const root = parseDocument(xml, { xmlMode: true });
	const elements = (name: string) =>
		findAll((n) => isTag(n) && n.name === name, root.children);
	return { root, elements };
}
