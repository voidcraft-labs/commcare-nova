// What CommCare HQ stores of a case list column names the column in HQ's own
// build: the app string id of its header is made from the stored `field`
// (`id_strings.py::detail_column_header_locale`,
// `m<module>.<detail>.<model>_<field>_<position>.header`), and a sort element
// joins its column by that same text. HQ's Case List page names the case's
// name `name` and the date it was opened `date-opened`, and every new menu
// holds a `name` column on both screens. Contract: Nova writes those words in
// HQ JSON, its own archive gives each column the id HQ's build gives it, and
// a menu that lists no cases holds the new menu's pair. Plausible failure: a
// column written `case_name` moves every header id of an app made in
// CommCare HQ on its first publish (`m0.case_long.case_name_1.header` becomes
// `case_case_name_1`), and a survey menu written with no detail column drops
// a detail HQ built of it.

import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { plainColumn, proseText } from "@/lib/domain";

const RUNTIME_TARGET = {
	server: "production",
	domain: "nova-words",
	appId: "words",
} as const;

function listDoc() {
	const columns = [
		plainColumn(testUuid("words-name"), "case_name", "Name", {
			sort: { direction: "asc", priority: 1 },
		}),
		plainColumn(testUuid("words-opened"), "date_opened", "Opened"),
		plainColumn(testUuid("words-village"), "village", "Village"),
	];
	const order = columns.map((column) => column.uuid);
	return buildDoc({
		appName: "Words",
		modules: [
			{
				name: "Households",
				caseType: "household",
				caseListConfig: {
					columns,
					listColumnOrder: order,
					detailColumnOrder: [...order],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "village", label: proseText("Village") }),
						],
					},
				],
			},
			{
				name: "Survey",
				forms: [
					{
						name: "Feedback",
						type: "survey",
						fields: [
							f({ kind: "text", id: "comment", label: proseText("Comment") }),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "village", label: proseText("Village"), data_type: "text" },
				],
			},
		],
	});
}

function suiteDetails(doc: ReturnType<typeof listDoc>): Element[] {
	const options = { runtimeTarget: RUNTIME_TARGET };
	const zip = new AdmZip(
		compileCcz(expandDoc(doc, options), doc.appName, doc, options),
	);
	return findAll(
		(node) => node.name === "detail",
		parseDocument(zip.readAsText("suite.xml"), { xmlMode: true }).children,
	);
}

function children(parent: Element, name: string): Element[] {
	return parent.children.filter(
		(node): node is Element => isTag(node) && node.name === name,
	);
}

function headerLocaleIds(detail: Element): string[] {
	return children(detail, "field").map((field) => {
		const [header] = children(field, "header");
		if (header === undefined) return "";
		return (
			findAll((node) => node.name === "locale", header.children)[0]?.attribs
				.id ?? ""
		);
	});
}

describe("CommCare HQ's words for a case list column's property", () => {
	it("are written in HQ JSON's columns and sort elements", () => {
		const doc = listDoc();
		assertAdmittedDoc(doc);
		const details = expandDoc(doc, { runtimeTarget: RUNTIME_TARGET }).modules[0]
			?.case_details;
		expect(details?.short.columns.map((column) => column.field)).toEqual([
			"name",
			"date-opened",
			"village",
		]);
		expect(details?.long.columns.map((column) => column.field)).toEqual([
			"name",
			"date-opened",
			"village",
		]);
		expect(details?.short.sort_elements.map((sort) => sort.field)).toEqual([
			"name",
		]);
	});

	it("name each header in Nova's archive by the id HQ's build gives it from the stored field", () => {
		const doc = listDoc();
		const hq = expandDoc(doc, { runtimeTarget: RUNTIME_TARGET });
		const details = suiteDetails(doc);
		for (const kind of ["short", "long"] as const) {
			const detail = details.find(
				(one) => one.attribs.id === `m0_case_${kind}`,
			);
			if (detail === undefined)
				throw new Error(`The archive holds no m0_case_${kind}.`);
			const stored = hq.modules[0]?.case_details[kind].columns ?? [];
			expect(headerLocaleIds(detail)).toEqual(
				stored.map(
					(column, index) =>
						`m0.case_${kind}.case_${String(column.field)}_${index + 1}.header`,
				),
			);
		}
	});

	it("give a menu that lists no cases the one name column on both screens, as every new menu in HQ holds", () => {
		const doc = listDoc();
		const survey = expandDoc(doc, { runtimeTarget: RUNTIME_TARGET }).modules[1]
			?.case_details;
		const shell = [{ field: "name", header: { en: "Name" } }];
		for (const columns of [survey?.short.columns, survey?.long.columns])
			expect(
				columns?.map((column) => ({
					field: column.field,
					header: column.header,
				})),
			).toEqual(shell);
	});
});
