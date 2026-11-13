/**
 * A case type may start with a digit or a hyphen, or be a word reference
 * text fixes, such as `case`. Every name the emitter derives from one is
 * still one name: each session datum id, each advanced tag, and the id the
 * form's own case change is born with, which names its Save to Case block
 * and is a question ID HQ's form builder takes without a warning.
 */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { advancedTagSchema } from "@/lib/domain/placements";
import { questionIdProblem } from "@/lib/domain/questionId";
import { allocateAdvancedTags, HQ_CASE_TAG_PATTERN } from "../advancedTags";
import { compileCcz } from "../compiler";
import { XML_ELEMENT_NAME_REGEX } from "../constants";
import { expandDoc } from "../expander";
import { checkCompilerEvidence } from "./compilerEvidence";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

const TYPES = [
	["1st-visit", "case_1st_visit"],
	["case", "case_case"],
	["-flagged", "case__flagged"],
	["2024", "case_2024"],
] as const;

/** One menu per type: a registration, and a follow-up saving `code`. */
function app() {
	return buildDoc({
		caseTypes: TYPES.map(([name]) => ({
			name,
			properties: [
				{ name: "case_name", label: "Name" },
				{ name: "code", label: "Code" },
			],
		})),
		modules: TYPES.map(([caseType]) => ({
			name: `Menu ${caseType}`,
			caseType,
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					name: `Register ${caseType}`,
					type: "registration" as const,
					fields: [
						f({
							kind: "text",
							id: "name",
							caseWrite: { caseType, property: "case_name" },
						}),
					],
				},
				{
					name: `Visit ${caseType}`,
					type: "followup" as const,
					fields: [
						f({
							kind: "text",
							id: "note",
							caseWrite: { caseType, property: "code" },
						}),
					],
				},
			],
		})),
	});
}

/** `app()` with each follow-up's saved value computed from its answer,
 *  which only a Save to Case block can state. */
function computedWrites() {
	const doc = app();
	for (const formUuid of Object.values(doc.formOrder).flat()) {
		const form = doc.forms[formUuid];
		if (form.type !== "followup") continue;
		const write = form.caseOperations?.[0]?.writes?.[0];
		if (write === undefined) throw new Error("no own case write");
		write.value = {
			kind: "concat",
			parts: [
				write.value,
				{ kind: "term", term: { kind: "literal", value: "!" } },
			],
		};
	}
	return structuredClone(doc);
}

function tagged(root: Element, name: string): Element[] {
	const out: Element[] = [];
	const walk = (element: Element) => {
		for (const child of element.children.filter(isTag)) {
			if (child.name === name) out.push(child);
			walk(child);
		}
	};
	walk(root);
	return out;
}

describe("names derived from a case type", () => {
	it("mints the own change's id as a question ID HQ's form builder takes", () => {
		const doc = app();
		for (const [index, [, id]] of TYPES.entries()) {
			for (const formUuid of doc.formOrder[doc.moduleOrder[index]])
				expect(doc.forms[formUuid].caseOperations?.[0]?.id).toBe(id);
			expect(questionIdProblem(id)).toBeUndefined();
		}
	});

	it("passes every oracle, its Save to Case blocks named by the minted ids", () => {
		const doc = computedWrites();
		checkCompilerEvidence(doc);
		const hq = expandDoc(doc);
		const blockNames = Object.values(hq._attachments)
			.filter((value): value is string => typeof value === "string")
			.flatMap((source) =>
				parseDocument(source, { xmlMode: true }).children.filter(isTag),
			)
			.flatMap((root) => tagged(root, "nova_operations"))
			.flatMap((group) =>
				group.children.filter(isTag).map((block) => block.name),
			);
		expect(blockNames.sort()).toEqual(TYPES.map(([, id]) => id).sort());
	});

	it("writes every session datum id as one element name", () => {
		const doc = app();
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const suite = parseDocument(zip.readAsText("suite.xml"), { xmlMode: true });
		const ids = suite.children
			.filter(isTag)
			.flatMap((root) => tagged(root, "datum"))
			.map((datum) => datum.attribs.id ?? "");
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids)
			expect(XML_ELEMENT_NAME_REGEX.test(id), id).toBe(true);
		expect(ids).toContain("case_id_new_1st-visit_0");
		expect(ids).toContain("case_id_new_-flagged_0");
	});

	it("allocates advanced tags HQ's case page and the tag schema both take", () => {
		const { loads, opens } = allocateAdvancedTags({
			loads: TYPES.map(([caseType]) => ({ caseType, worker: false })),
			opens: TYPES.map(([caseType]) => ({ caseType })),
			rootNames: new Set(),
		});
		const tags = [...loads, ...opens];
		expect(new Set(tags).size).toBe(tags.length);
		for (const tag of tags) {
			expect(HQ_CASE_TAG_PATTERN.test(tag), tag).toBe(true);
			expect(advancedTagSchema.safeParse(tag).success, tag).toBe(true);
		}
		expect(loads).toContain("load_1st_visit0");
		expect(loads).toContain("load__flagged2");
	});
});
