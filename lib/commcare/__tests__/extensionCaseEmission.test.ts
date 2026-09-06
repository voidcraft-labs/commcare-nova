import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "./extensionCaseFixture";

function one(nodes: Element[]): Element {
	expect(nodes).toHaveLength(1);
	const node = nodes[0];
	if (!node) throw new Error("Missing wire node");
	return node;
}
function xmlTree(xml: string) {
	new SaxesParser({ xmlns: true }).write(xml).close();
	return parseDocument(xml, { xmlMode: true });
}
function at(parent: Element, name: string) {
	return one(parent.children.filter(isTag).filter((e) => e.name === name));
}

// HQ's native XForm._create_casexml ignores the relationship of basic subcase
// actions. Its action list nevertheless allocates navigation IDs even for
// condition=never. This test checks Nova's export contract, not a simulated HQ.
it.each(extensionScenarios)(
	"preserves extension transactions and identities for %s",
	(scenario) => {
		const doc = extensionCaseFixture(scenario);
		expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
			true,
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const hq = expandDoc(doc);
		const form = hq.modules[0].forms[0];
		expect(
			form.actions.subcases.map((s) => [
				s.case_type,
				s.relationship,
				s.condition.type,
			]),
		).toEqual([
			["episode", "extension", "never"],
			["visit", "child", "always"],
			["consent", "extension", "never"],
		]);
		const source = hq._attachments[`${form.unique_id}.xml`];
		if (typeof source !== "string") throw new Error("Missing source form");
		const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		const suite = xmlTree(zip.readAsText("suite.xml"));
		const entry = one(
			findAll(
				(e) =>
					e.name === "entry" &&
					e.children
						.filter(isTag)
						.some(
							(n) =>
								n.name === "form" &&
								n.children.some(
									(t) => t.type === "text" && t.data === form.xmlns,
								),
						),
				suite.children,
			),
		);
		const datums = at(entry, "session")
			.children.filter(isTag)
			.filter((e) => e.name === "datum");
		const repeated =
			scenario === "repeat" ||
			scenario === "query" ||
			scenario === "multiple-repeat";
		const multiple = scenario === "multiple" || scenario === "multiple-repeat";
		const offset = ["registration", "repeat", "query"].includes(scenario)
			? 1
			: 0;
		expect(
			datums
				.filter((d) => d.attribs.id?.startsWith("case_id_new_"))
				.map((d) => ({ id: d.attribs.id, function: d.attribs.function })),
		).toEqual([
			...(offset ? [{ id: "case_id_new_patient_0", function: "uuid()" }] : []),
			...(!repeated
				? ["episode", "visit", "consent"].map((type, i) => ({
						id: `case_id_new_${type}_${i + offset}`,
						function: "uuid()",
					}))
				: []),
		]);
		for (const xml of [source, zip.readAsText("modules-0/forms-0.xml")]) {
			const tree = xmlTree(xml);
			const model = at(at(one(tree.children.filter(isTag)), "h:head"), "model");
			const binds = model.children
				.filter(isTag)
				.filter((e) => e.name === "bind");
			const bindAt = (path: string) =>
				one(binds.filter((b) => b.attribs.nodeset === path)).attribs;
			const data = at(
				one(
					model.children
						.filter(isTag)
						.filter((e) => e.name === "instance" && !e.attribs.src),
				),
				"data",
			);
			const parent =
				scenario === "multiple-repeat"
					? at(at(at(data, "records"), "__nova_selected_cases"), "item")
					: scenario === "repeat"
						? at(data, "records")
						: scenario === "query"
							? at(at(data, "records"), "item")
							: scenario === "multiple"
								? at(at(data, "__nova_selected_cases"), "item")
								: data;
			const container = at(
				parent,
				multiple ? "__nova_operations" : "__nova_subcases",
			);
			expect(container.children.filter(isTag).map((e) => e.name)).toEqual(
				multiple
					? ["__nova_subcase_0", "__nova_subcase_1", "__nova_subcase_2"]
					: ["__nova_subcase_0", "__nova_subcase_2"],
			);
			const prefix =
				scenario === "multiple-repeat"
					? "/data/records/__nova_selected_cases/item"
					: scenario === "repeat"
						? "/data/records"
						: scenario === "query"
							? "/data/records/item"
							: scenario === "multiple"
								? "/data/__nova_selected_cases/item"
								: "/data";
			for (const [index, type] of [
				[0, "episode"],
				[2, "consent"],
			] as const) {
				const block = at(at(container, `__nova_subcase_${index}`), "case");
				expect(block.attribs).toEqual({
					case_id: "",
					date_modified: "",
					user_id: "",
					xmlns: "http://commcarehq.org/case/transaction/v2",
				});
				expect(at(at(block, "index"), "parent").attribs).toEqual({
					case_type: "patient",
					relationship: "extension",
				});
				expect(at(at(block, "update"), "note").attribs).toEqual({});
				const path = `${prefix}/${container.name}/__nova_subcase_${index}/case`;
				if (type === "episode") {
					expect(at(at(block, "attachment"), "photo").attribs).toEqual({
						src: "",
						from: "local",
					});
					expect(bindAt(`${path}/attachment/photo`).relevant).toBe(
						scenario === "multiple-repeat"
							? "count(current()/../../../../../../../episode_photo) = 1"
							: repeated
								? "count(current()/../../../../../episode_photo) = 1"
								: "count(/data/episode_photo) = 1",
					);
					expect(bindAt(`${path}/attachment/photo/@src`).calculate).toBe(
						scenario === "multiple-repeat"
							? "current()/../../../../../../../../episode_photo"
							: repeated
								? "current()/../../../../../../episode_photo"
								: "/data/episode_photo",
					);
				}
				expect(bindAt(`${path}/create/case_type`).calculate).toBe(`'${type}'`);
				expect(bindAt(`${path}/create/owner_id`).calculate).toBe(
					"/data/meta/userID",
				);
				expect(bindAt(`${path}/@date_modified`)).toEqual({
					nodeset: `${path}/@date_modified`,
					calculate: "/data/meta/timeEnd",
					type: "xsd:dateTime",
				});
				expect(bindAt(`${path}/@user_id`).calculate).toBe("/data/meta/userID");
				if (repeated || multiple)
					expect(bindAt(`${path}/@case_id`).calculate).toBe("uuid()");
				else
					expect(
						one(
							model.children
								.filter(isTag)
								.filter(
									(e) =>
										e.name === "setvalue" &&
										e.attribs.ref === `${path}/@case_id`,
								),
						).attribs,
					).toEqual({
						ref: `${path}/@case_id`,
						event: "xforms-ready",
						value: `instance('commcaresession')/session/data/case_id_new_${type}_${index + offset}`,
					});
				const sourcePrefix =
					scenario === "multiple-repeat"
						? "/data/records"
						: repeated
							? prefix
							: "/data";
				expect(bindAt(`${sourcePrefix}/${type}_name`).required).toBe("true()");
				expect(bindAt(`${path}/update/note`).calculate).toBe(
					scenario === "multiple-repeat"
						? `current()/../../../../../../../${type}_note`
						: repeated
							? `current()/../../../../../${type}_note`
							: `/data/${type}_note`,
				);
				expect(bindAt(`${path}/update/note`).relevant).toBe(
					scenario === "multiple-repeat"
						? `count(current()/../../../../../../../${type}_note) > 0`
						: repeated
							? `count(current()/../../../../../${type}_note) > 0`
							: `count(/data/${type}_note) > 0`,
				);
				expect(bindAt(`${path}/index/parent`).calculate).toBe(
					multiple
						? "current()/../../../../../@id"
						: offset
							? "/data/case/@case_id"
							: "instance('commcaresession')/session/data/case_id",
				);
			}
		}
		if (scenario === "registration") {
			const stack = one(findAll((e) => e.name === "stack", entry.children));
			expect(
				findAll(
					(e) => e.name === "datum" && e.attribs.id === "case_id",
					stack.children,
				).map((e) => e.attribs.value),
			).toContain(
				"instance('commcaresession')/session/data/case_id_new_episode_1",
			);
		}
	},
);
