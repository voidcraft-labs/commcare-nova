/**
 * The local suite's entry of a form in an advanced menu. CommCare HQ builds
 * the same entry from the advanced form it is sent
 * (`suite_xml/sections/entries.py::EntriesHelper.configure_entry_advanced_form`),
 * and every expression the form and its links hold prints the ids of these
 * datums, so a local datum HQ names otherwise is a `.ccz` whose form reads a
 * session value its entry never sets. Each datum is checked against the
 * identities `entryDatumIds` gives the printers, which read a menu turned
 * advanced the same way they read it basic.
 */
import { describe, expect, it } from "vitest";
import { planFormCaseWire } from "@/lib/commcare/casePlacementPlan";
import {
	caseListSessionDatums,
	entryDatumIdResolver,
	entryDatumIds,
	entryFrameDatums,
	entrySessionDatums,
	formLinkProjectionContext,
	projectFormLinks,
} from "@/lib/commcare/formLinkProjection";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { serializeXml } from "@/lib/commcare/serializeXml";
import {
	buildEntryElement,
	deriveEntryDefinition,
	type SessionDatum,
} from "@/lib/commcare/session";
import { USERCASE_ID_FUNCTION } from "@/lib/commcare/usercaseWire";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { isBlank, prop } from "@/lib/domain/expression/builders";
import {
	advancedFixture,
	chosen,
	HOUSEHOLDS,
	MEMBERS,
	OP,
	read,
	UNDER_TEST,
	VISIT_REVIEW,
	VISITS,
} from "./advancedPlacementFixture";

const OWN = OP("own");

const own = (extra: Partial<CaseOperation> = {}): CaseOperation =>
	({ uuid: OWN, id: "own_case", action: "own", ...extra }) as CaseOperation;

const workerUpdate = (): CaseOperation =>
	({
		uuid: OP("worker"),
		id: "worker",
		action: "update",
		caseType: "commcare-user",
		target: { kind: "worker-record" },
		writes: [{ property: "age", value: read("age") }],
	}) as CaseOperation;

/** A visit created under the household chosen first in the chain. */
const visitUnderHousehold = (): CaseOperation =>
	({
		uuid: OP("visit"),
		id: "visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: read("name"),
		links: [
			{
				identifier: "parent",
				targetType: "household",
				target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
				relationship: "child",
			},
		],
	}) as CaseOperation;

/** A follow-up in Members, chosen under its household, held advanced. */
function memberFollowup(
	operations: () => CaseOperation[],
	configure?: (doc: BlueprintDoc) => void,
	nested = false,
): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "members",
		nested,
		operations,
		...(configure !== undefined && { configure }),
	}).doc;
}

function entry(doc: BlueprintDoc, moduleUuid: Uuid = MEMBERS) {
	const ctx = formLinkProjectionContext(doc);
	return {
		datums: entrySessionDatums(doc, ctx, moduleUuid, UNDER_TEST),
		rows: entryDatumIds(doc, ctx, moduleUuid, UNDER_TEST),
	};
}

const text = (expr: WireExpr | undefined): string | undefined =>
	expr === undefined
		? undefined
		: serializeWire(expr, { target: "suite" }).text;

const view = (datum: SessionDatum) => ({
	id: datum.id,
	nodeset: text(datum.nodeset),
	function: text(datum.function),
	detailSelect: datum.detailSelect,
	detailConfirm: datum.detailConfirm,
});

const nodeset = (type: string, ...predicates: string[]) =>
	`instance('casedb')/casedb/case[@case_type = '${type}'][@status = 'open']${predicates.join("")}`;
const session = (id: string) =>
	`instance('commcaresession')/session/data/${id}`;

describe("an advanced form's entry", () => {
	it("chooses the chain's cases, each after the first under the one before it by its index name", () => {
		const doc = memberFollowup(
			() => [own({ writes: [{ property: "age", value: read("age") }] })],
			(doc) => {
				const config = doc.modules[HOUSEHOLDS].caseListConfig;
				if (config !== undefined)
					doc.modules[HOUSEHOLDS] = {
						...doc.modules[HOUSEHOLDS],
						caseListConfig: {
							...config,
							filter: isBlank(prop("household", "case_name")),
						},
					};
			},
		);
		expect(emittedModuleKind(doc, MEMBERS)).toBe("advanced");
		const { datums, rows } = entry(doc);
		// The list module's filter narrows its load as it narrows the same
		// household's basic selection.
		const basic = entrySessionDatums(
			doc,
			formLinkProjectionContext(doc, { moduleKinds: "basic" }),
			MEMBERS,
			UNDER_TEST,
		);
		const householdNodeset = text(basic[0]?.nodeset);
		expect(householdNodeset).not.toBe(nodeset("household"));
		expect(datums.map(view)).toEqual([
			{
				id: "case_id_load_household0",
				nodeset: householdNodeset,
				function: undefined,
				detailSelect: "m0_case_short",
				// The member load is chosen under this one, and no open action
				// indexes it, so HQ goes on to the next list.
				detailConfirm: undefined,
			},
			{
				id: "case_id_load_member1",
				nodeset: nodeset(
					"member",
					`[index/parent = ${session("case_id_load_household0")}]`,
				),
				function: undefined,
				detailSelect: "m1_case_short",
				detailConfirm: "m1_case_long",
			},
		]);
		expect(rows.map((row) => [row.id, row.refs])).toEqual([
			[
				"case_id_load_household0",
				[{ kind: "selected-case", module: HOUSEHOLDS }],
			],
			["case_id_load_member1", [{ kind: "selected-case", module: MEMBERS }]],
		]);
	});

	it("keeps a load's confirmation where an open action indexes it", () => {
		const doc = memberFollowup(() => [own(), visitUnderHousehold()]);
		const plan = planFormCaseWire(doc, UNDER_TEST);
		expect(plan.kind).toBe("advanced");
		const { datums, rows } = entry(doc);
		expect(datums.map(view)).toEqual([
			{
				id: "case_id_load_household0",
				nodeset: nodeset("household"),
				function: undefined,
				detailSelect: "m0_case_short",
				detailConfirm: "m0_case_long",
			},
			{
				id: "case_id_load_member1",
				nodeset: nodeset(
					"member",
					`[index/parent = ${session("case_id_load_household0")}]`,
				),
				function: undefined,
				detailSelect: "m1_case_short",
				detailConfirm: "m1_case_long",
			},
			{
				id: "case_id_new_visit_0",
				nodeset: undefined,
				function: "uuid()",
				detailSelect: undefined,
				detailConfirm: undefined,
			},
		]);
		expect(rows.at(-1)).toMatchObject({
			id: "case_id_new_visit_0",
			refs: [{ kind: "new-child-case", caseType: "visit" }],
		});
		// The open action's datum is the plan's.
		expect(plan.datums.map((datum) => datum.id)).toEqual([
			"case_id_new_visit_0",
		]);
	});

	it("selects the worker's record on its own, after the chain, and asserts the restore holds it", () => {
		const doc = memberFollowup(() => [own(), workerUpdate()]);
		const { datums, rows } = entry(doc);
		expect(datums.map((datum) => datum.id)).toEqual([
			"case_id_load_household0",
			"case_id_load_member1",
			"case_id_autoload_commcare_user2",
		]);
		const worker = datums[2];
		expect(text(worker?.function)).toBe(text(USERCASE_ID_FUNCTION));
		expect(worker?.caseType).toBe("commcare-user");
		expect(rows[2]?.refs).toEqual([{ kind: "worker-record" }]);
		const definition = deriveEntryDefinition({
			formXmlns: "http://example.org/under-test",
			moduleIndex: 1,
			formIndex: 0,
			formType: "followup",
			postSubmit: "app_home",
			projectedSessionDatums: datums,
			expressions: () => ({}) as never,
		});
		expect(
			definition.assertions?.map((assertion) => assertion.localeId),
		).toEqual(["case_autoload.usercase.case_missing"]);
		const xml = serializeXml(buildEntryElement(definition));
		expect(xml).toContain('<datum id="case_id_autoload_commcare_user2"');
		expect(xml).not.toContain("usercase_id");
		expect(xml.indexOf("</session>")).toBeLessThan(xml.indexOf("<assertions>"));
	});

	it("mints a uuid() for each case an open action outside a repeat creates", () => {
		const doc = advancedFixture({
			formType: "registration",
			operations: () => [
				own({ name: read("name") }),
				{
					uuid: OP("visit"),
					id: "visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: read("name"),
					links: [
						{
							identifier: "parent",
							targetType: "household",
							target: { kind: "op", opUuid: OWN },
							relationship: "extension",
						},
					],
				} as CaseOperation,
			],
		}).doc;
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		const { datums, rows } = entry(doc, HOUSEHOLDS);
		expect(datums.map(view)).toEqual([
			{
				id: "case_id_new_household_0",
				nodeset: undefined,
				function: "uuid()",
				detailSelect: undefined,
				detailConfirm: undefined,
			},
			{
				id: "case_id_new_visit_1",
				nodeset: undefined,
				function: "uuid()",
				detailSelect: undefined,
				detailConfirm: undefined,
			},
		]);
		expect(rows.map((row) => [row.id, row.refs])).toEqual([
			["case_id_new_household_0", [{ kind: "new-case" }]],
			["case_id_new_visit_1", [{ kind: "new-child-case", caseType: "visit" }]],
		]);
		expect(
			planFormCaseWire(doc, UNDER_TEST).datums.map((datum) => datum.id),
		).toEqual(rows.map((row) => row.id));
	});

	it("hands an open action's new case to a link's target by its case type", () => {
		const doc = advancedFixture({
			formType: "registration",
			heldKind: false,
			operations: () => [
				own({ name: read("name") }),
				{
					uuid: OP("visit"),
					id: "visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: read("name"),
					links: [
						{
							identifier: "parent",
							targetType: "household",
							target: { kind: "op", opUuid: OWN },
							relationship: "extension",
						},
					],
				} as CaseOperation,
			],
			configure: (doc) => {
				const form = doc.forms[UNDER_TEST];
				if (form !== undefined)
					doc.forms[UNDER_TEST] = {
						...form,
						formLinks: [
							{
								uuid: OP("link"),
								target: {
									type: "form",
									moduleUuid: VISITS,
									formUuid: VISIT_REVIEW,
								},
							},
						],
					};
			},
		}).doc;
		// The link carries the visit, which a basic form gives no datum.
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		const ctx = formLinkProjectionContext(doc);
		expect(
			entryFrameDatums(doc, ctx, HOUSEHOLDS, UNDER_TEST).map((datum) => [
				datum.id,
				datum.caseType,
			]),
		).toEqual([
			["case_id_new_household_0", "household"],
			["case_id_new_visit_1", "visit"],
		]);
		const [link] = projectFormLinks(doc, ctx, UNDER_TEST)?.links ?? [];
		expect(link?.missing).toEqual([]);
		const carried = link?.children.find(
			(child) => child.type === "datum" && child.id === "case_id",
		);
		expect(carried?.type === "datum" ? text(carried.value) : undefined).toBe(
			session("case_id_new_visit_1"),
		);
	});

	it("aligns a child menu's loads with its root's first form, as add_parent_datums does", () => {
		const doc = memberFollowup(() => [own()], undefined, true);
		const { datums, rows } = entry(doc);
		// The root's first form, a basic follow-up of Households, chooses its
		// household as `case_id`; the chain's first load takes that id, and
		// the member load is chosen under it by the renamed id.
		expect(datums.map(view)).toEqual([
			{
				id: "case_id",
				nodeset: nodeset("household"),
				function: undefined,
				detailSelect: "m0_case_short",
				detailConfirm: undefined,
			},
			{
				id: "case_id_load_member1",
				nodeset: nodeset("member", `[index/parent = ${session("case_id")}]`),
				function: undefined,
				detailSelect: "m1_case_short",
				detailConfirm: "m1_case_long",
			},
		]);
		const resolve = entryDatumIdResolver(rows);
		expect(resolve({ kind: "selected-case", module: HOUSEHOLDS })).toBe(
			"case_id",
		);
		expect(resolve({ kind: "selected-case", module: MEMBERS })).toBe(
			"case_id_load_member1",
		);
	});

	it("is the basic entry under a context that projects every menu as basic", () => {
		const doc = memberFollowup(() => [own()]);
		const ctx = formLinkProjectionContext(doc, {
			entryMetadataOnly: true,
			moduleKinds: "basic",
		});
		expect(
			entrySessionDatums(doc, ctx, MEMBERS, UNDER_TEST).map(
				(datum) => datum.id,
			),
		).toEqual(["parent_id", "case_id"]);
	});
});

describe("an advanced menu's case list entry", () => {
	it("lists every open case of its type under one datum named for the type", () => {
		const doc = advancedFixture({ formType: "followup", menu: "members" }).doc;
		doc.formOrder[MEMBERS] = [];
		delete doc.forms[UNDER_TEST];
		delete doc.fieldOrder[UNDER_TEST];
		doc.modules[MEMBERS] = {
			...doc.modules[MEMBERS],
			caseListOnly: true,
			parentCaseModuleUuid: undefined,
		};
		expect(emittedModuleKind(doc, MEMBERS)).toBe("advanced");
		const ctx = formLinkProjectionContext(doc);
		const datums = caseListSessionDatums(doc, ctx, MEMBERS);
		expect(datums.map(view)).toEqual([
			{
				id: "case_id_case_member",
				nodeset: nodeset("member"),
				function: undefined,
				detailSelect: "m1_case_short",
				detailConfirm: "m1_case_long",
			},
		]);
		expect(entryDatumIds(doc, ctx, MEMBERS).map((row) => row.refs)).toEqual([
			[{ kind: "selected-case", module: MEMBERS }],
		]);
	});
});
