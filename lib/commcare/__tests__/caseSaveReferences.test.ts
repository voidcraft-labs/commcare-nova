/** `caseSaveReferences` held to the editor's rules for `case_references_data.save`
 * (HQ's form builder, `logic.js::LogicManager.caseReferences`). Most trees are
 * Nova's own emission, parsed back from the stored form source; the trees for
 * the rules' other branches are hand-built, since Nova emits none of them.
 * What HQ and its form builder do with the map is the proof lane's. */
import { Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { el } from "@/lib/commcare/elementBuilders";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqCaseSaveReference } from "@/lib/commcare/types";
import { checkCaseReferences } from "@/lib/commcare/validator/hqJsonOracle";
import { caseSaveReferences } from "@/lib/commcare/xform/caseSaveReferences";
import { parseXml } from "@/lib/commcare/xmlParse";
import type { BlueprintDoc } from "@/lib/domain";
import {
	caseOperationFixture,
	type OperationScenario,
} from "./caseOperationFixture";

const CASE_XMLNS = "http://commcarehq.org/case/transaction/v2";

/** The stored save map of the form holding case operations, beside the map
 * the function derives from that form's stored source. */
function emitted(doc: BlueprintDoc) {
	const hq = expandDoc(doc);
	const forms = hq.modules
		.flatMap((module) => module.forms)
		.filter((form) => Object.keys(form.case_references_data.save).length > 0);
	expect(forms).toHaveLength(1);
	const [form] = forms;
	const source = hq._attachments[`${form.unique_id}.xml`];
	const html = parseXml(source).children.find(isTag);
	if (html === undefined) throw new Error("The form source has no root.");
	return {
		hq,
		stored: form.case_references_data.save,
		derived: caseSaveReferences(html),
	};
}

function scenario(name: OperationScenario) {
	return emitted(caseOperationFixture(name));
}

const ref = (
	case_type: string,
	properties: string[],
	create = false,
	close = false,
): HqCaseSaveReference => ({
	doc_type: "CaseSaveReference",
	case_type,
	properties,
	create,
	close,
});

describe("caseSaveReferences over Nova's emission", () => {
	it("stores the map the function derives from the stored source", () => {
		for (const name of [
			"sequence",
			"conditional",
			"retype",
			"repeat",
			"query",
			"key",
			"link",
			"scalar",
		] as const) {
			const { hq, stored, derived } = scenario(name);
			expect(stored, name).toEqual(derived);
			expect(checkCaseReferences(hq), name).toEqual([]);
		}
	});

	it("is held by checkCaseReferences to the source's blocks and HQ's create requirements", () => {
		const { hq, stored } = scenario("sequence");
		delete stored["/data/nova_operations/finish_visit"];
		stored["/data/nova_operations/create_visit"].properties = ["case_type"];
		stored["/data/nova_operations/elsewhere"] = ref("visit", ["note"]);
		expect(checkCaseReferences(hq)).toHaveLength(3);
	});

	it("lists a create's rows, then case_type, case_name and owner_id, and each update, guard and close", () => {
		expect(scenario("sequence").derived).toEqual({
			"/data/nova_operations/before_ordinary": ref("patient", [
				"nickname",
				"occurred_at",
				"reference_at",
			]),
			"/data/nova_operations/create_visit": ref(
				"visit",
				["source_id", "occurred_at", "case_type", "case_name", "owner_id"],
				true,
			),
			"/data/nova_operations/nova_guard_create_visit_text": ref("visit", [
				"case_type",
			]),
			"/data/nova_operations/tag_visit": ref("visit", ["owner_id", "nickname"]),
			"/data/nova_operations/nova_guard_tag_visit_text": ref("visit", [
				"case_type",
			]),
			// An index leaf is never listed; the block's ordering guard is.
			"/data/nova_operations/unlink_visit": ref("visit", ["case_type"]),
			"/data/nova_operations/finish_visit": ref(
				"visit",
				["final_note"],
				false,
				true,
			),
		});
	});

	it("lists owner_id for a create with no authored owner, whose bind holds the acting user", () => {
		const doc = caseOperationFixture("key");
		const form = Object.values(doc.forms).find(
			(candidate) => (candidate.caseOperations ?? []).length > 0,
		);
		if (form === undefined) throw new Error("The fixture has no operations.");
		const [create, ...rest] = form.caseOperations ?? [];
		const { owner: _owner, ...unowned } = create;
		form.caseOperations = [unowned, ...rest];
		expect(
			emitted(doc).derived[
				"/data/nova_operations/nova_keyed_create_visit/create_visit"
			],
		).toEqual(
			ref("visit", ["source_id", "case_type", "case_name", "owner_id"], true),
		);
	});

	it("keys a close only, a rename and a retype by their condition groups", () => {
		expect(scenario("retype").derived).toEqual({
			"/data/nova_operations/nova_condition_promote/promote": ref("patient", [
				"case_type",
				"changed_type_at",
			]),
			"/data/nova_operations/nova_condition_promote/nova_guard_promote_retype":
				ref("visit", ["case_type"]),
			"/data/nova_operations/nova_condition_rename_promoted/rename_promoted":
				ref("visit", ["case_name"]),
			"/data/nova_operations/nova_condition_rename_promoted/nova_guard_rename_promoted_text":
				ref("visit", ["case_type"]),
			"/data/nova_operations/nova_condition_finish_promoted/finish_promoted":
				ref("visit", ["case_type"], false, true),
		});
	});

	it("keys a block inside a repeat and inside a query repeat by plain steps", () => {
		expect(Object.keys(scenario("repeat").derived)).toEqual([
			"/data/items/nova_operations/create_visit",
			"/data/items/nova_operations/nova_guard_create_visit_text",
			"/data/items/nova_operations/nova_condition_tag_visit/tag_visit",
			"/data/items/nova_operations/nova_condition_tag_visit/nova_guard_tag_visit_text",
			"/data/items/nova_operations/unlink_visit",
			"/data/items/nova_operations/finish_visit",
		]);
		const query = scenario("query").derived;
		expect(Object.keys(query)).toEqual([
			"/data/items/item/nova_operations/create_visit",
			"/data/items/item/nova_operations/nova_guard_create_visit_text",
			"/data/items/item/nova_operations/nova_condition_tag_visit/tag_visit",
			"/data/items/item/nova_operations/nova_condition_tag_visit/nova_guard_tag_visit_text",
			"/data/items/item/nova_operations/unlink_visit",
			"/data/items/item/nova_operations/finish_visit",
		]);
		expect(query["/data/items/item/nova_operations/create_visit"]).toEqual(
			ref("visit", ["source_id", "case_type", "case_name", "owner_id"], true),
		);
	});
});

/** A form tree holding one Save to Case block `/data/visit` whose `case`
 * holds `caseChildren`, with `binds` in the model. */
function handBuilt(
	caseChildren: Element[],
	binds: Record<string, string | undefined>,
	caseType = "visit",
): Element {
	return el("h:html", {}, [
		el("h:head", {}, [
			el("model", {}, [
				el("instance", {}, [
					el("data", {}, [
						el("note", {}),
						el(
							"visit",
							{ "vellum:role": "SaveToCase", "vellum:case_type": caseType },
							[
								el(
									"case",
									{
										case_id: "",
										date_modified: "",
										user_id: "",
										xmlns: CASE_XMLNS,
									},
									caseChildren,
								),
							],
						),
					]),
				]),
				el("instance", { id: "casedb", src: "jr://instance/casedb" }),
				// These external source fixtures deliberately include bindings Nova
				// does not emit, including malformed and empty expressions.
				...Object.entries(binds).map(
					([nodeset, calculate]) =>
						new Element("bind", {
							nodeset,
							...(calculate !== undefined && { calculate }),
						}),
				),
			]),
		]),
		el("h:body", {}),
	]);
}

const createLeaves = () =>
	el("create", {}, [
		el("case_type", {}),
		el("case_name", {}),
		el("owner_id", {}),
	]);

describe("caseSaveReferences over hand-built trees", () => {
	it("lists no leaf that carries no bind and no index leaf", () => {
		const tree = handBuilt(
			[
				el("update", {}, [el("bound", {}), el("unbound", {})]),
				el("index", {}, [el("parent", { case_type: "patient" })]),
			],
			{
				"/data/visit/case/update/bound": "/data/note",
				"/data/visit/case/index/parent": "/data/note",
				"/data/visit/case/@case_id": "/data/note",
			},
		);
		expect(caseSaveReferences(tree)).toEqual({
			"/data/visit": ref("visit", ["bound"]),
		});
	});

	it("reads the case type from a quoted literal create/case_type bind over vellum:case_type", () => {
		const tree = handBuilt([createLeaves()], {
			"/data/visit/case/create/case_type": '"household"',
			"/data/visit/case/create/case_name": "/data/note",
		});
		expect(caseSaveReferences(tree)).toEqual({
			"/data/visit": ref("household", ["case_type", "case_name"], true),
		});
	});

	it("reads an empty case type, still listing case_type, from an expression create/case_type bind", () => {
		const tree = handBuilt([createLeaves()], {
			"/data/visit/case/create/case_type": "/data/note",
			"/data/visit/case/create/case_name": "/data/note",
			"/data/visit/case/create/owner_id": "/data/note",
		});
		expect(caseSaveReferences(tree)).toEqual({
			"/data/visit": ref("", ["case_type", "case_name", "owner_id"], true),
		});
	});

	it("reads a quoted create/case_type bind spanning a line break as an expression", () => {
		const tree = handBuilt([createLeaves()], {
			"/data/visit/case/create/case_type": "'house\nhold'",
			"/data/visit/case/create/case_name": "/data/note",
		});
		expect(caseSaveReferences(tree)).toEqual({
			"/data/visit": ref("", ["case_type", "case_name"], true),
		});
	});

	it("lists no case_name for a create/case_name bind with an empty calculate", () => {
		const tree = handBuilt([createLeaves()], {
			"/data/visit/case/create/case_type": "'visit'",
			"/data/visit/case/create/case_name": "",
		});
		expect(caseSaveReferences(tree)).toEqual({
			"/data/visit": ref("visit", ["case_type"], true),
		});
	});

	it("reads an update leaf named close as a block that closes, as the editor's find does", () => {
		const tree = handBuilt([el("update", {}, [el("close", {})])], {
			"/data/visit/case/update/close": "/data/note",
		});
		expect(caseSaveReferences(tree)).toEqual({
			"/data/visit": ref("visit", ["close"], false, true),
		});
	});

	it("throws on a bind whose nodeset is no data path, rather than leave its leaf unlisted", () => {
		const tree = handBuilt([el("update", {}, [el("bound", {})])], {
			"/data/visit/case/update/bound": "/data/note",
			"/data/visit/case/update/bad-name": "/data/note",
		});
		expect(() => caseSaveReferences(tree)).toThrow(/bad-name/);
	});
});
