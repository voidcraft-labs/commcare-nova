/**
 * The document `targeted-case-type-names`, whose case types are `case`,
 * `parent`, `1st-visit`, `-flagged` and `2024`: a type may start with a digit
 * or a hyphen, or be a word reference text fixes. Every name the emitter
 * derives from one is still one name: each session datum id, each advanced
 * tag (the `1st-visit` child the `case` registration creates is an advanced
 * open action, since an after-submit link carries it), and the id a case
 * change is born with, which names its Save to Case block (the `2024` and
 * `-flagged` extensions) and is a question ID HQ's form builder takes without
 * a warning. The follow-up's `#record/case/region` binds the parent record.
 */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ownCaseOperationId } from "@/lib/domain/caseOperationIdentifiers";
import { advancedTagSchema } from "@/lib/domain/placements";
import { questionIdProblem } from "@/lib/domain/questionId";
import { caseTypeNames } from "../../../proof/targeted/documents/caseTypeNames";
import { HQ_CASE_TAG_PATTERN } from "../advancedTags";
import { compileCcz } from "../compiler";
import { XML_ELEMENT_NAME_REGEX } from "../constants";
import { expandDoc } from "../expander";
import type { HqAdvancedForm, HqForm } from "../types";
import { parseXml } from "../xmlParse";
import { checkCompilerEvidence } from "./compilerEvidence";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

/** The id each of the document's case types mints for a form's own change. */
const MINTED = {
	case: "case_case",
	parent: "parent",
	"1st-visit": "case_1st_visit",
	"-flagged": "case__flagged",
	"2024": "case_2024",
} as const;

function caseTypeDoc() {
	return hydratePersistedBlueprint(caseTypeNames().doc);
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

function roots(xml: string): Element[] {
	return parseXml(xml).children.filter(isTag);
}

function hqForms(
	hq: ReturnType<typeof expandDoc>,
): (HqForm | HqAdvancedForm)[] {
	return hq.modules.flatMap(
		(module): (HqForm | HqAdvancedForm)[] => module.forms,
	);
}

describe("names derived from a case type", () => {
	it("mints each type's own change id as a question ID HQ's form builder takes", () => {
		const doc = caseTypeDoc();
		expect(
			Object.fromEntries(
				(doc.caseTypes ?? []).map((type) => [
					type.name,
					ownCaseOperationId(type.name, new Set()),
				]),
			),
		).toEqual(MINTED);
		for (const id of Object.values(MINTED))
			expect(questionIdProblem(id), id).toBeUndefined();
		/* The follow-ups' own changes were born with those ids. */
		const ownIds = Object.values(doc.forms)
			.filter((form) => form.type === "followup")
			.flatMap((form) => form.caseOperations ?? [])
			.filter((operation) => operation.action === "own")
			.map((operation) => operation.id);
		expect(ownIds).toEqual(
			expect.arrayContaining(["case_1st_visit", "case__flagged", "case_2024"]),
		);
	});

	it("passes every oracle, its Save to Case blocks named by the minted ids", () => {
		const doc = caseTypeDoc();
		checkCompilerEvidence(doc);
		const hq = expandDoc(doc);
		const blocks = Object.values(hq._attachments)
			.filter((value): value is string => typeof value === "string")
			.flatMap(roots)
			.flatMap((root) => tagged(root, "nova_operations"))
			.flatMap((group) => group.children.filter(isTag));
		expect(blocks.length).toBeGreaterThan(0);
		for (const block of blocks) {
			expect(block.attribs["vellum:role"]).toBe("SaveToCase");
			expect(questionIdProblem(block.name), block.name).toBeUndefined();
		}
		const creating = blocks
			.filter((block) => tagged(block, "create").length > 0)
			.map((block) => [block.name, block.attribs["vellum:case_type"]]);
		expect(creating.sort()).toEqual([
			["case_2024", "2024"],
			["case__flagged", "-flagged"],
		]);
		const saved = hqForms(hq).flatMap((form) =>
			Object.keys(form.case_references_data?.save ?? {}),
		);
		expect(saved).toEqual(
			expect.arrayContaining([
				"/data/nova_operations/case_2024",
				"/data/nova_operations/case__flagged",
			]),
		);
	});

	it("allocates advanced tags HQ's case page and the tag schema both take", () => {
		const hq = expandDoc(caseTypeDoc());
		const advanced = hq.modules.filter(
			(module) => module.doc_type === "AdvancedModule",
		);
		expect(advanced.map((module) => module.case_type)).toEqual(["case"]);
		const actions = advanced.flatMap((module) =>
			module.forms.flatMap((form) =>
				form.doc_type === "AdvancedForm"
					? [...form.actions.load_update_cases, ...form.actions.open_cases]
					: [],
			),
		);
		const tags = actions.map((action) => action.case_tag);
		expect(tags).toEqual(["open_case_0", "open_1st_visit_1"]);
		expect(new Set(tags).size).toBe(tags.length);
		for (const tag of tags) {
			expect(HQ_CASE_TAG_PATTERN.test(tag), tag).toBe(true);
			expect(advancedTagSchema.safeParse(tag).success, tag).toBe(true);
		}
	});

	it("writes every session datum id as one element name", () => {
		const doc = caseTypeDoc();
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const ids = roots(zip.readAsText("suite.xml"))
			.flatMap((root) => tagged(root, "datum"))
			.map((datum) => datum.attribs.id ?? "");
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids)
			expect(XML_ELEMENT_NAME_REGEX.test(id), id).toBe(true);
		expect(ids).toContain("case_id_new_case_0");
		expect(ids).toContain("case_id_new_1st-visit_1");
	});

	it("records `#record/case/region` as the parent's read, never a worker's", () => {
		const hq = expandDoc(caseTypeDoc());
		const visit = hqForms(hq).find((form) => form.name.en === "Record visit");
		expect(visit?.case_references_data?.load).toEqual({
			"/data/case_region": ["#case/parent/region"],
			"/data/outcome": ["#case/outcome"],
		});
	});
});
