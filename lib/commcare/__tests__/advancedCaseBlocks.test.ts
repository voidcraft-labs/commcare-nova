/**
 * The local archive's case blocks of an advanced form, written as CommCare
 * HQ's build writes them (`xform.py::XForm._create_casexml_advanced`).
 *
 * Contract: for each shape `get_action_path` distinguishes (an open action
 * at the root, the one open action of a repeat, and a repeat holding two
 * open actions that index a case), the block stands where HQ's build puts
 * it, with its `<case>` first in its node; every bind calculates and guards
 * what HQ's does; `<create>`'s owner is the worker or HQ's `-`; and each
 * `<index>` names its case type and, for an extension, its relationship.
 *
 * The plausible failure is an injection that proof 3 would show only on a
 * document that holds the shape: a block one element off, a missing
 * guard, or an index that reads the aligned datum where HQ reads the
 * load's own. Every result is first held to the XForm oracle, so a block
 * that parses wrong fails before its paths are read.
 */
import { describe, expect, it } from "vitest";
import { alwaysCondition, ifCondition, neverCondition } from "@/lib/commcare";
import type {
	AdvancedFormActions,
	AdvancedOpenCaseAction,
	CaseIndex,
	ConditionalCaseUpdate,
	LoadUpdateAction,
} from "@/lib/commcare/types";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { addAdvancedCaseBlocks } from "@/lib/commcare/xform/advancedCaseBlocks";
import { buildXFormSource } from "@/lib/commcare/xform/builder";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import { advancedFixture, UNDER_TEST } from "./advancedPlacementFixture";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

const CASE_XMLNS = "http://commcarehq.org/case/transaction/v2";

/** The fixture's form as a plain source: no case change of its own, so
 *  every block in the result is the injection's. */
function source(): string {
	const { doc } = advancedFixture({ formType: "survey", heldKind: false });
	return buildXFormSource(doc, UNDER_TEST, { xmlns: "http://example.org/f" })
		.xml;
}

const update = (
	question_path: string,
	update_mode: ConditionalCaseUpdate["update_mode"] = "always",
): ConditionalCaseUpdate => ({ question_path, update_mode });

const index = (
	tag: string,
	relationship: CaseIndex["relationship"],
	reference_id = "parent",
): CaseIndex => ({
	doc_type: "CaseIndex",
	tag,
	reference_id,
	relationship,
	relationship_question: "",
});

function load(
	tag: string,
	patch: Partial<LoadUpdateAction> = {},
): LoadUpdateAction {
	return {
		doc_type: "LoadUpdateAction",
		case_type: "household",
		case_tag: tag,
		details_module: "m0",
		case_properties: {},
		preload: {},
		close_condition: neverCondition(),
		case_index: {
			doc_type: "CaseIndex",
			tag: "",
			reference_id: "parent",
			relationship: "child",
			relationship_question: "",
		},
		auto_select: null,
		load_case_from_fixture: null,
		show_product_stock: false,
		product_program: "",
		...patch,
	};
}

function open(
	tag: string,
	patch: Partial<AdvancedOpenCaseAction> = {},
): AdvancedOpenCaseAction {
	return {
		doc_type: "AdvancedOpenCaseAction",
		case_type: "visit",
		case_tag: tag,
		name_update: update("/data/name"),
		case_properties: {},
		repeat_context: "",
		case_indices: [],
		open_condition: alwaysCondition(),
		close_condition: neverCondition(),
		...patch,
	};
}

interface Injected {
	readonly data: XmlEvidence;
	readonly binds: ReadonlyMap<string, Record<string, string>>;
	readonly setvalues: ReadonlyMap<string, string>;
	readonly instances: readonly string[];
}

function inject(
	actions: Omit<AdvancedFormActions, "doc_type">,
	loadDatumIds?: ReadonlyMap<string, string>,
): Injected {
	const xml = addMetaBlock(
		addAdvancedCaseBlocks(
			source(),
			{ actions: { doc_type: "AdvancedFormActions", ...actions } },
			loadDatumIds === undefined ? {} : { loadDatumIds },
		),
	);
	expect(validateXForm(xml, "Under test", "Households")).toEqual([]);
	const root = readXmlEvidence(xml);
	const model = find(find(root, "head"), "model");
	const primary = model.children.find(
		(child) => child.name === "instance" && child.attributes.id === undefined,
	);
	const data = primary?.children[0];
	if (data === undefined) throw new Error("The form has no data node.");
	const binds = new Map<string, Record<string, string>>();
	const setvalues = new Map<string, string>();
	for (const child of model.children) {
		if (child.name === "bind") {
			const nodeset = child.attributes.nodeset ?? "";
			binds.set(nodeset, { ...binds.get(nodeset), ...child.attributes });
		}
		if (child.name === "setvalue")
			setvalues.set(child.attributes.ref ?? "", child.attributes.value ?? "");
	}
	return {
		data,
		binds,
		setvalues,
		instances: model.children
			.filter((child) => child.name === "instance")
			.flatMap((child) =>
				child.attributes.id === undefined ? [] : [child.attributes.id],
			),
	};
}

function find(node: XmlEvidence, name: string): XmlEvidence {
	const child = node.children.find((c) => c.name === name);
	if (child === undefined)
		throw new Error(`<${node.name}> holds no <${name}>.`);
	return child;
}

function at(node: XmlEvidence, ...names: string[]): XmlEvidence {
	return names.reduce(find, node);
}

const names = (node: XmlEvidence) => node.children.map((child) => child.name);

describe("addAdvancedCaseBlocks", () => {
	it("returns a form with no load and no open action unchanged", () => {
		const xml = source();
		expect(
			addAdvancedCaseBlocks(xml, {
				actions: {
					doc_type: "AdvancedFormActions",
					load_update_cases: [],
					open_cases: [],
				},
			}),
		).toBe(xml);
	});

	it("writes a load's block at the data root, its updates sorted and guarded, its ancestors' blocks and its close", () => {
		const { data, binds, instances } = inject(
			{
				load_update_cases: [
					load("load_household0", {
						case_properties: {
							zeta: update("/data/age"),
							name: update("/data/name", "edit"),
							"parent/region": update("/data/status"),
						},
						close_condition: ifCondition("/data/status", "no"),
					}),
					// A load that writes nothing and closes nothing has no block.
					load("load_member1", { case_type: "member" }),
				],
				open_cases: [],
			},
			new Map([["load_household0", "case_id_aligned"]]),
		);
		const block = find(data, "case_load_household0");
		expect(names(data).filter((n) => n.startsWith("case_"))).toEqual([
			"case_load_household0",
		]);
		const caseEl = find(block, "case");
		expect(caseEl.uri).toBe(CASE_XMLNS);
		expect(caseEl.attributes).toEqual({
			case_id: "",
			date_modified: "",
			user_id: "",
			xmlns: CASE_XMLNS,
		});
		expect(names(caseEl)).toEqual(["update", "close"]);
		// `name` is written `case_name`, and rows are in code-point order.
		expect(names(find(caseEl, "update"))).toEqual(["case_name", "zeta"]);
		const base = "/data/case_load_household0/case";
		expect(binds.get(`${base}/@case_id`)?.calculate).toBe(
			"instance('commcaresession')/session/data/case_id_aligned",
		);
		expect(binds.get(`${base}/@date_modified`)).toMatchObject({
			type: "xsd:dateTime",
			calculate: "/data/meta/timeEnd",
		});
		expect(binds.get(`${base}/@user_id`)?.calculate).toBe("/data/meta/userID");
		expect(binds.get(`${base}/update/zeta`)).toMatchObject({
			calculate: "/data/age",
			relevant: "count(/data/age) > 0",
		});
		expect(binds.get(`${base}/update/case_name`)).toMatchObject({
			calculate: "/data/name",
			relevant:
				"count(/data/name) > 0 and instance('casedb')/casedb/case[@case_id = /data/case_load_household0/case/@case_id]/case_name != /data/name",
		});
		expect(binds.get(`${base}/close`)?.relevant).toBe("/data/status = 'no'");
		// The ancestor's block, under `parents`, reads the case its index reaches.
		expect(names(block)).toEqual(["case", "parents"]);
		const parentCase = at(block, "parents", "parent", "case");
		expect(names(parentCase)).toEqual(["update"]);
		const parentBase = "/data/case_load_household0/parents/parent/case";
		expect(binds.get(`${parentBase}/@case_id`)?.calculate).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id_aligned]/index/parent",
		);
		expect(binds.get(`${parentBase}/update/region`)).toMatchObject({
			calculate: "/data/status",
			relevant: "count(/data/status) > 0",
		});
		expect(instances).toEqual(["casedb", "commcaresession"]);
	});

	it("writes a root open action in its own element, its id from its datum and its owner the worker", () => {
		const { data, binds, setvalues } = inject({
			load_update_cases: [],
			open_cases: [
				open("open_visit_0", {
					case_properties: { notes: update("/data/owner_q") },
					open_condition: ifCondition("/data/status", "yes", "selected"),
					close_condition: alwaysCondition(),
				}),
			],
		});
		const caseEl = at(data, "case_open_visit_0", "case");
		expect(names(caseEl)).toEqual(["create", "update", "close"]);
		const create = find(caseEl, "create");
		expect(names(create)).toEqual(["case_name", "owner_id", "case_type"]);
		expect(find(create, "case_type").text).toBe("visit");
		expect(find(create, "owner_id").text).toBe("");
		const base = "/data/case_open_visit_0/case";
		expect(setvalues.get(`${base}/@case_id`)).toBe(
			"instance('commcaresession')/session/data/case_id_new_visit_0",
		);
		expect(binds.has(`${base}/@case_id`)).toBe(false);
		expect(binds.get(base)?.relevant).toBe("selected(/data/status, 'yes')");
		expect(binds.get(`${base}/create/case_name`)?.calculate).toBe("/data/name");
		expect(binds.get(`${base}/create/owner_id`)?.calculate).toBe(
			"/data/meta/userID",
		);
		expect(binds.get("/data/name")?.required).toBe("true()");
		expect(binds.get(`${base}/update/notes`)?.relevant).toBe(
			"count(/data/owner_q) > 0",
		);
		// HQ's `XForm.add_bind` drops an `always` condition's `true()`, and with
		// it the bind its nodeset alone would be: the close stands unbound.
		expect(names(caseEl)).toContain("close");
		expect(binds.has(`${base}/close`)).toBe(false);
	});

	it("writes HQ's '-' owner where every index is an extension or the action names owner_id", () => {
		const { data, binds } = inject({
			load_update_cases: [
				load("load_household0", {
					case_properties: { seen: update("/data/age") },
				}),
			],
			open_cases: [
				open("open_visit_0", {
					case_indices: [index("load_household0", "extension", "host")],
				}),
				open("open_visit_1", {
					case_properties: { owner_id: update("/data/owner_q") },
				}),
				open("open_visit_2", {
					case_indices: [index("load_household0", "child")],
				}),
			],
		});
		const owner = (tag: string) =>
			at(data, `case_${tag}`, "case", "create", "owner_id").text;
		expect(owner("open_visit_0")).toBe("-");
		expect(owner("open_visit_1")).toBe("-");
		expect(owner("open_visit_2")).toBe("");
		expect(binds.has("/data/case_open_visit_0/case/create/owner_id")).toBe(
			false,
		);
		expect(binds.has("/data/case_open_visit_1/case/create/owner_id")).toBe(
			false,
		);
		expect(
			binds.get("/data/case_open_visit_1/case/update/owner_id")?.calculate,
		).toBe("/data/owner_q");
		expect(
			binds.get("/data/case_open_visit_2/case/create/owner_id")?.calculate,
		).toBe("/data/meta/userID");
		// The loads' blocks come before the open actions', as HQ appends them.
		expect(names(data).filter((n) => n.startsWith("case_"))).toEqual([
			"case_load_household0",
			"case_open_visit_0",
			"case_open_visit_1",
			"case_open_visit_2",
		]);
	});

	it("names each index by its reference id, its case type, an extension's relationship, and the load's own datum", () => {
		const { data, binds } = inject(
			{
				load_update_cases: [load("load_household0")],
				open_cases: [
					open("open_visit_0", {
						case_indices: [index("load_household0", "extension", "host")],
					}),
					open("open_member_1", {
						case_type: "member",
						case_indices: [
							index("load_household0", "child"),
							index("open_visit_0", "child", "visit"),
						],
					}),
				],
			},
			new Map([["load_household0", "case_id_aligned"]]),
		);
		const hostIndex = at(data, "case_open_visit_0", "case", "index");
		expect(hostIndex.children.map((c) => [c.name, c.attributes])).toEqual([
			["host", { case_type: "household", relationship: "extension" }],
		]);
		const memberCase = at(data, "case_open_member_1", "case");
		expect(names(memberCase)).toEqual(["create", "index"]);
		expect(
			find(memberCase, "index").children.map((c) => [c.name, c.attributes]),
		).toEqual([
			["parent", { case_type: "household" }],
			["visit", { case_type: "visit" }],
		]);
		// An index to a load reads the load's own datum, before alignment.
		expect(
			binds.get("/data/case_open_member_1/case/index/parent")?.calculate,
		).toBe("instance('commcaresession')/session/data/case_id_load_household0");
		expect(
			binds.get("/data/case_open_member_1/case/index/visit")?.calculate,
		).toBe("/data/case_open_visit_0/case/@case_id");
	});

	it("writes a repeat's one open action as the first child of its row, its id a uuid()", () => {
		const { data, binds, setvalues } = inject({
			load_update_cases: [],
			open_cases: [
				open("open_visit_0", {
					name_update: update("/data/kids/kid_name"),
					repeat_context: "/data/kids",
				}),
			],
		});
		const row = find(data, "kids");
		expect(names(row)[0]).toBe("case");
		expect(names(row).filter((n) => n === "case")).toHaveLength(1);
		expect(find(row, "case").uri).toBe(CASE_XMLNS);
		expect(binds.get("/data/kids/case/@case_id")?.calculate).toBe("uuid()");
		expect(setvalues.has("/data/kids/case/@case_id")).toBe(false);
		expect(binds.get("/data/kids/case/create/case_name")?.calculate).toBe(
			"/data/kids/kid_name",
		);
		expect(binds.get("/data/kids/kid_name")?.required).toBe("true()");
	});

	it("nests every open action of a repeat that holds two indexed ones in its own element, the case first in it", () => {
		const { data, binds } = inject({
			load_update_cases: [load("load_household0")],
			open_cases: [
				open("open_visit_0", {
					name_update: update("/data/kids/kid_name"),
					repeat_context: "/data/kids",
					case_indices: [index("load_household0", "child")],
				}),
				open("open_visit_1", {
					name_update: update("/data/kids/kid_name"),
					repeat_context: "/data/kids",
					case_indices: [index("open_visit_0", "extension", "host")],
				}),
				open("open_visit_2", {
					name_update: update("/data/kids/kid_name"),
					repeat_context: "/data/kids",
				}),
			],
		});
		const row = find(data, "kids");
		expect(names(row).slice(-3)).toEqual([
			"case_open_visit_0",
			"case_open_visit_1",
			"case_open_visit_2",
		]);
		for (const tag of ["open_visit_0", "open_visit_1", "open_visit_2"]) {
			expect(names(find(row, `case_${tag}`))[0]).toBe("case");
			expect(binds.get(`/data/kids/case_${tag}/case/@case_id`)?.calculate).toBe(
				"uuid()",
			);
		}
		expect(
			binds.get("/data/kids/case_open_visit_1/case/index/host")?.calculate,
		).toBe("/data/kids/case_open_visit_0/case/@case_id");
	});

	it("refuses two open actions at one repeat row, which HQ's build would write at one path", () => {
		expect(() =>
			addAdvancedCaseBlocks(source(), {
				actions: {
					doc_type: "AdvancedFormActions",
					load_update_cases: [],
					open_cases: [
						open("open_visit_0", {
							name_update: update("/data/kids/kid_name"),
							repeat_context: "/data/kids",
						}),
						open("open_visit_1", {
							name_update: update("/data/kids/kid_name"),
							repeat_context: "/data/kids",
						}),
					],
				},
			}),
		).toThrow(/two open actions at the row of the repeat \/data\/kids/);
	});
});
