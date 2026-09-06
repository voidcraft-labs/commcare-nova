import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
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
import { blueprintDocSchema, type Form, proseText } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";

const target = { origin: "https://www.commcarehq.org", domain: "demo-project" };
const scope = "/data/__nova_selected_cases/item/__nova_operations";
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
	expect(XMLValidator.validate(xml)).toBe(true);
	return one(parseDocument(xml, { xmlMode: true }).children.filter(isTag));
}
function formTree(xml: string) {
	const html = parse(xml);
	const model = child(child(html, "h:head"), "model");
	const data = child(
		one(
			model.children
				.filter(isTag)
				.filter((e) => e.name === "instance" && e.attribs.src === undefined),
		),
		"data",
	);
	const operations = child(
		child(child(data, "__nova_selected_cases"), "item"),
		"__nova_operations",
	);
	return {
		model,
		data,
		operations,
		bind: (path: string) =>
			one(
				model.children
					.filter(isTag)
					.filter((e) => e.name === "bind" && e.attribs.nodeset === path),
			).attribs,
	};
}
function fixture(
	type: "followup" | "close",
	fields: FieldSpec[],
	operation?: NonNullable<Form["caseOperations"]>[number],
	extraType?: "visit" | "archived_patient",
) {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...list(),
					selection: { kind: "multiple", maximum: 15 },
				},
				forms: [{ name: "Review selected", type, fields }],
			},
			...(extraType === "visit"
				? [
						{
							name: "Visits",
							caseType: "visit",
							caseListOnly: true,
							caseListConfig: list(),
							forms: [],
						},
					]
				: []),
		],
		caseTypes: [
			{
				name: "patient",
				properties: ["case_name", "note", "reviewed", "photo", "photo_url"].map(
					(name) => ({ name, label: proseText(name) }),
				),
			},
			...(extraType
				? [
						{
							name: extraType,
							...(extraType === "visit" ? { parent_type: "patient" } : {}),
							properties: (extraType === "archived_patient"
								? ["case_name", "note", "reviewed", "photo", "photo_url"]
								: ["case_name"]
							).map((name) => ({ name, label: proseText(name) })),
						},
					]
				: []),
		],
	});
	if (operation)
		(doc.forms[doc.formOrder[doc.moduleOrder[0]][0]] as Form).caseOperations = [
			operation,
		];
	return doc;
}
function artifacts(doc: ReturnType<typeof buildDoc>, published = true) {
	expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
		true,
	);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(
		doc,
		published ? { attachmentTarget: target } : undefined,
	);
	const form = hq.modules[0].forms[0];
	const source = hq._attachments[`${form.unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing form source");
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	const suite = parse(zip.readAsText("suite.xml"));
	const entry = one(
		suite.children
			.filter(isTag)
			.filter(
				(e) =>
					e.name === "entry" &&
					e.children
						.filter(isTag)
						.some((e) => e.name === "form" && textContent(e) === form.xmlns),
			),
	);
	expect(form.actions.update_case.update).toEqual({});
	expect(form.actions.update_case.condition.type).toBe("never");
	expect(form.actions.case_preload.preload).toEqual({});
	expect(form.actions.case_preload.condition.type).toBe("never");
	return {
		hq,
		entry,
		forms: [
			formTree(source),
			formTree(zip.readAsText("modules-0/forms-0.xml")),
		],
	};
}
function selectedIdentity(form: ReturnType<typeof formTree>, name: string) {
	expect(form.bind(`${scope}/${name}/case/@case_id`)).toEqual({
		nodeset: `${scope}/${name}/case/@case_id`,
		calculate: "current()/../../../../@id",
	});
	expect(
		form.data.children.filter(isTag).filter((e) => e.name === "case"),
	).toEqual([]);
	expect(
		one(
			form.model.children
				.filter(isTag)
				.filter(
					(e) => e.name === "instance" && e.attribs.id === "selected_cases",
				),
		).attribs,
	).toEqual({
		src: "jr://instance/selected-entities/selected_cases",
		id: "selected_cases",
	});
}
it("emits an ordinary shared update in both artifacts and limits multiple selection to the short detail", () => {
	const doc = fixture("followup", [
		f({
			kind: "text",
			id: "note",
			caseWrite: { caseType: "patient", property: "note" },
		}),
	]);
	const output = artifacts(doc);
	for (const form of output.forms) {
		expect(form.operations.children.filter(isTag).map((e) => e.name)).toEqual([
			"__nova_update_selected_cases",
		]);
		const transaction = child(
			child(form.operations, "__nova_update_selected_cases"),
			"case",
		);
		expect(
			child(transaction, "update")
				.children.filter(isTag)
				.map((e) => e.name),
		).toEqual(["note"]);
		expect(
			form.bind(`${scope}/__nova_update_selected_cases/case/update/note`),
		).toEqual({
			nodeset: `${scope}/__nova_update_selected_cases/case/update/note`,
			calculate: "/data/note",
			relevant: "count(/data/note) > 0 and string(/data/note) != ''",
		});
		selectedIdentity(form, "__nova_update_selected_cases");
	}
	expect(output.hq.modules[0].case_details.short.multi_select).toBe(true);
	expect(output.hq.modules[0].case_details.short.max_select_value).toBe(15);
	expect(output.hq.modules[0].case_details.long.multi_select).toBeUndefined();
	expect(
		output.hq.modules[0].case_details.long.max_select_value,
	).toBeUndefined();
});
for (const published of [true, false]) {
	it(`orders authored effects, shared scalar/file writes and close with ${published ? "a target" : "no target"}`, () => {
		const doc = fixture(
			"close",
			[
				f({
					kind: "text",
					id: "full_name",
					caseWrite: { caseType: "patient", property: "case_name" },
				}),
				f({
					kind: "text",
					id: "note",
					default_value: "'Review completed'",
					caseWrite: { caseType: "patient", property: "note" },
				}),
				f({
					kind: "text",
					id: "external_id",
					caseWrite: { caseType: "patient", property: "external_id" },
				}),
				f({
					kind: "image",
					id: "photo",
					caseWrite: {
						caseType: "patient",
						property: "photo",
						mode: "attachment",
					},
				}),
				f({
					kind: "image",
					id: "photo_link",
					caseWrite: {
						caseType: "patient",
						property: "photo_url",
						mode: "url",
					},
				}),
			],
			{
				uuid: testUuid("mark"),
				id: "mark_selected",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "reviewed", value: term(literal("yes")) }],
			},
		);
		for (const form of artifacts(doc, published).forms) {
			expect(form.operations.children.filter(isTag).map((e) => e.name)).toEqual(
				[
					"mark_selected",
					"__nova_update_selected_cases",
					"__nova_close_selected_cases",
				],
			);
			for (const name of [
				"mark_selected",
				"__nova_update_selected_cases",
				"__nova_close_selected_cases",
			])
				selectedIdentity(form, name);
			expect(form.bind(`${scope}/mark_selected/case/update/reviewed`)).toEqual({
				nodeset: `${scope}/mark_selected/case/update/reviewed`,
				calculate: "'yes'",
			});
			const transaction = child(
				child(form.operations, "__nova_update_selected_cases"),
				"case",
			);
			expect(transaction.children.filter(isTag).map((e) => e.name)).toEqual([
				"update",
				"attachment",
			]);
			expect(
				child(transaction, "update")
					.children.filter(isTag)
					.map((e) => e.name),
			).toEqual([
				"case_name",
				"note",
				"external_id",
				...(published ? ["photo_url"] : []),
			]);
			expect(child(child(transaction, "attachment"), "photo").attribs).toEqual({
				src: "",
				from: "local",
			});
			const writers = [
				[
					"case_name",
					"replace(/data/full_name, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')",
					"/data/full_name",
					true,
				],
				["note", "/data/note", "/data/note", false],
				[
					"external_id",
					"replace(/data/external_id, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')",
					"/data/external_id",
					true,
				],
				...(published
					? [
							[
								"photo_url",
								"/data/__nova_url_photo_link",
								"/data/__nova_url_photo_link",
								false,
							] as const,
						]
					: []),
			] as const;
			for (const [property, calculate, source, scalar] of writers)
				expect(
					form.bind(
						`${scope}/__nova_update_selected_cases/case/update/${property}`,
					),
				).toEqual({
					nodeset: `${scope}/__nova_update_selected_cases/case/update/${property}`,
					calculate,
					relevant: `count(${source}) > 0 and string(${calculate}) != ''`,
					...(scalar ? { constraint: "string-length(.) <= 255" } : {}),
				});
			expect(
				form.bind(
					`${scope}/__nova_update_selected_cases/case/attachment/photo`,
				),
			).toEqual({
				nodeset: `${scope}/__nova_update_selected_cases/case/attachment/photo`,
				relevant: "count(/data/photo) = 1 and string(/data/photo) != ''",
			});
			expect(
				form.bind(
					`${scope}/__nova_update_selected_cases/case/attachment/photo/@src`,
				),
			).toEqual({
				nodeset: `${scope}/__nova_update_selected_cases/case/attachment/photo/@src`,
				calculate: "/data/photo",
			});
			const close = child(
				child(form.operations, "__nova_close_selected_cases"),
				"case",
			);
			expect(close.children.filter(isTag).map((e) => e.name)).toEqual([
				"close",
			]);
			const initialNote = one(
				form.model.children
					.filter(isTag)
					.filter(
						(e) => e.name === "setvalue" && e.attribs.ref === "/data/note",
					),
			);
			expect(initialNote.attribs.value).toBe("'Review completed'");
			expect(initialNote.attribs.event).toBe("xforms-ready");
		}
	});
}
it("allocates each child inside the selected-parent iteration without consuming the scalar HQ datum", () => {
	const output = artifacts(
		fixture(
			"followup",
			[
				f({
					kind: "text",
					id: "visit_name",
					caseWrite: { caseType: "visit", property: "case_name" },
				}),
			],
			undefined,
			"visit",
		),
	);
	const datum = one(
		child(output.entry, "session")
			.children.filter(isTag)
			.filter(
				(e) => e.name === "datum" && e.attribs.id === "case_id_new_visit_0",
			),
	);
	expect(datum.attribs).toEqual({
		id: "case_id_new_visit_0",
		function: "uuid()",
	});
	for (const form of output.forms) {
		expect(form.operations.children.filter(isTag).map((e) => e.name)).toEqual([
			"__nova_subcase_0",
		]);
		const transaction = child(
			child(form.operations, "__nova_subcase_0"),
			"case",
		);
		expect(child(child(transaction, "index"), "parent").attribs).toEqual({
			case_type: "patient",
			relationship: "child",
		});
		expect(form.bind(`${scope}/__nova_subcase_0/case/@case_id`)).toEqual({
			nodeset: `${scope}/__nova_subcase_0/case/@case_id`,
			calculate: "uuid()",
		});
		expect(form.bind(`${scope}/__nova_subcase_0/case/index/parent`)).toEqual({
			nodeset: `${scope}/__nova_subcase_0/case/index/parent`,
			calculate: "current()/../../../../../@id",
		});
		expect(
			findAll(
				(e) =>
					Object.values(e.attribs).some((value) =>
						value.includes("session/data/case_id_new_visit_0"),
					),
				form.model.children,
			),
		).toEqual([]);
	}
});
it("leaves an earlier retype intact when the ordinary final action only closes", () => {
	const output = artifacts(
		fixture(
			"close",
			[f({ kind: "text", id: "note" })],
			{
				uuid: testUuid("88888888-8888-4888-8888-888888888888"),
				id: "archive_selected",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				retype: "archived_patient",
			},
			"archived_patient",
		),
	);
	for (const form of output.forms) {
		expect(form.operations.children.filter(isTag).map((e) => e.name)).toEqual([
			"archive_selected",
			"__nova_guard_88888888_8888_4888_8888_888888888888_retype_identity",
			"__nova_close_selected_cases",
		]);
		expect(
			form.bind(`${scope}/archive_selected/case/update/case_type`),
		).toEqual({
			nodeset: `${scope}/archive_selected/case/update/case_type`,
			calculate: "'archived_patient'",
		});
		expect(
			child(child(form.operations, "__nova_close_selected_cases"), "case")
				.children.filter(isTag)
				.map((e) => e.name),
		).toEqual(["close"]);
		selectedIdentity(form, "archive_selected");
		selectedIdentity(form, "__nova_close_selected_cases");
	}
});
