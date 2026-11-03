/**
 * The after-submit projection (`formLinkProjection.ts`): the emitted order
 * and each link's `xpath` (its condition and held-case guards, an otherwise
 * link's negations, HQ's fallback), HQ's frame-children algorithm, datum
 * matching, the `previous` frame, and the totality predicates the validator
 * asks before projecting.
 *
 * Local projection regressions, including deliberately invalid lower-boundary
 * inputs. Native HQ/Core links corpus independently owns wire acceptance.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	entryFrameDatums,
	type FrameChild,
	type FrameDatum,
	formFrameChildren,
	formLinkActionsBuildable,
	formLinkProjectionContext,
	matchFrameToManual,
	matchFrameToSource,
	moduleCaseTypeForActions,
	ownCaseSessionRef,
	type ProjectedAfterSubmit,
	previousFrameChildren,
	projectAfterSubmit,
	sessionDataRef,
	targetFrameChildren,
	targetSelectionDatums,
} from "@/lib/commcare/formLinkProjection";
import { runValidation } from "@/lib/commcare/validator/runner";
import { serializeWire, type WireExpr, w } from "@/lib/commcare/xpath";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	tileCell,
	type Uuid,
} from "@/lib/domain";
import { and, eq, literal, neq, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";

function wireText(value: WireExpr | undefined): string | undefined {
	return value === undefined
		? undefined
		: serializeWire(value, { target: "suite" }).text;
}
function fallbackText(fallback: ProjectedAfterSubmit["fallback"]) {
	return fallback.kind === "built-in"
		? { ...fallback, xpath: wireText(fallback.xpath) }
		: fallback;
}
/** Each emitted link's uuid and role with its `xpath` printed. */
function emittedText(projected: ProjectedAfterSubmit | undefined) {
	return (projected?.links ?? []).map((link) => ({
		uuid: link.uuid,
		role: link.role,
		...(link.xpath !== undefined && { xpath: wireText(link.xpath) }),
	}));
}
function project(doc: BlueprintDoc, formUuid: Uuid) {
	return projectAfterSubmit(doc, formLinkProjectionContext(doc), formUuid);
}

const ALICE =
	"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/username = 'alice'";
const BEA =
	"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/username = 'bea'";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const REGISTER = testUuid("frm-reg");
const VISIT = testUuid("frm-visit");
const REGISTER_AGAIN = testUuid("frm-reg2");
const LINK_VISIT = testUuid("lnk-visit");
const LINK_REGISTER = testUuid("lnk-reg");

const nameWriter = () =>
	f({
		kind: "text",
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType: "frog", property: "case_name" },
	});

/** HQ's `form_link_multiple.xml` scenario in Nova's vocabulary. */
function frogDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Frogs",
		caseTypes: [
			{
				name: "frog",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-reg",
						name: "Register frog",
						type: "registration",
						formLinks: [
							{
								uuid: "lnk-visit",
								condition: "#user/username = 'alice'",
								target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
							},
							{
								uuid: "lnk-reg",
								condition: "#user/username = 'bea'",
								target: {
									type: "form",
									moduleUuid: CARE,
									formUuid: REGISTER_AGAIN,
								},
							},
						],
						fields: [nameWriter()],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Frog care",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "frog", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-reg2",
						name: "Register another",
						type: "registration",
						fields: [nameWriter()],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

/** Strip the render closure so frame datums compare structurally. */
function shape(child: FrameChild) {
	return child.type === "command"
		? child
		: {
				type: "datum" as const,
				id: child.datum.id,
				requiresSelection: child.datum.requiresSelection,
				...(child.datum.caseType !== undefined && {
					caseType: child.datum.caseType,
				}),
				...(child.datum.function !== undefined && {
					function: child.datum.function,
				}),
			};
}

const datum = (
	id: string,
	requiresSelection: boolean,
	caseType?: string,
	fn?: WireExpr,
): FrameDatum => ({
	id,
	requiresSelection,
	...(caseType !== undefined && { caseType }),
	...(fn !== undefined && { function: fn }),
});

describe("projectAfterSubmit: order and otherwise", () => {
	it("emits the destinations in reverse author order, each with its own condition", () => {
		const doc = frogDoc();
		const projected = project(doc, REGISTER);
		expect(emittedText(projected)).toEqual([
			{ uuid: LINK_REGISTER, role: "destination", xpath: BEA },
			{ uuid: LINK_VISIT, role: "destination", xpath: ALICE },
		]);
		// No otherwise: the app home follows, and HQ gets no fallback.
		expect(projected?.fallback).toEqual({ kind: "none" });
	});

	it("a built-in otherwise is HQ's fallback over every non-blank xpath in emitted order", () => {
		const doc = structuredClone(frogDoc());
		const reg = doc.forms[REGISTER];
		if (reg === undefined) throw new Error("fixture");
		reg.otherwise = { kind: "destination", destination: "module" };
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(
			fallbackText(project(doc, REGISTER)?.fallback ?? { kind: "none" }),
		).toEqual({
			kind: "built-in",
			destination: "module",
			xpath: `not(${BEA}) and not(${ALICE})`,
		});
	});

	it("an otherwise link negates every destination, then conjoins its own held-case guard", () => {
		const doc = structuredClone(frogDoc());
		const reg = doc.forms[REGISTER];
		if (reg === undefined) throw new Error("fixture");
		reg.otherwise = {
			kind: "link",
			uuid: testUuid("lnk-otherwise"),
			target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
			datums: [
				{
					name: { kind: "selected-case", module: CARE },
					xpath: term(literal("frog-7")),
				},
			],
		};
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const projected = project(doc, REGISTER);
		expect(emittedText(projected).at(-1)).toEqual({
			uuid: testUuid("lnk-otherwise"),
			role: "otherwise",
			xpath: `not(${BEA}) and not(${ALICE}) and count(instance('casedb')/casedb/case[@case_id = 'frog-7' and @case_type = 'frog']) > 0`,
		});
		expect(projected?.links.at(-1)?.datums.map((datum) => datum.name)).toEqual([
			"case_id",
		]);
		expect(projected?.fallback).toEqual({ kind: "none" });
	});

	it("an every-time destination emits no xpath and stays out of the fallback's negations", () => {
		const doc = structuredClone(frogDoc());
		const reg = doc.forms[REGISTER];
		const [first] = reg?.formLinks ?? [];
		if (reg === undefined || first === undefined) throw new Error("fixture");
		reg.formLinks = [
			first,
			{
				uuid: testUuid("lnk-every"),
				target: { type: "module", moduleUuid: CARE },
			},
		];
		reg.otherwise = { kind: "destination", destination: "firstMenu" };
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const projected = project(doc, REGISTER);
		expect(emittedText(projected)).toEqual([
			{ uuid: testUuid("lnk-every"), role: "destination" },
			{ uuid: LINK_VISIT, role: "destination", xpath: ALICE },
		]);
		expect(fallbackText(projected?.fallback ?? { kind: "none" })).toEqual({
			kind: "built-in",
			destination: "firstMenu",
			xpath: `not(${ALICE})`,
		});
	});

	it("builds no fallback where every destination runs every time, as HQ builds none", () => {
		// The gate refuses this otherwise (nothing may not run); the
		// projection stays total and writes what HQ would build from it.
		const doc = structuredClone(frogDoc());
		const reg = doc.forms[REGISTER];
		if (reg === undefined) throw new Error("fixture");
		reg.formLinks = [
			{
				uuid: testUuid("lnk-every"),
				target: { type: "module", moduleUuid: CARE },
			},
		];
		reg.otherwise = { kind: "destination", destination: "module" };
		const projected = project(doc, REGISTER);
		expect(emittedText(projected)).toEqual([
			{ uuid: testUuid("lnk-every"), role: "destination" },
		]);
		expect(projected?.fallback).toEqual({ kind: "none" });
	});

	it("starts this form again in its own menu, a registration on a new case", () => {
		const doc = structuredClone(frogDoc());
		const reg = doc.forms[REGISTER];
		if (reg === undefined) throw new Error("fixture");
		reg.formLinks = [
			{ uuid: testUuid("lnk-again"), target: { type: "this-form" } },
		];
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const [link] = project(doc, REGISTER)?.links ?? [];
		expect(link).toMatchObject({
			role: "destination",
			target: { type: "form", moduleUuid: INTAKE, formUuid: REGISTER },
			children: [
				{ type: "command", id: "m0" },
				{ type: "datum", id: "case_id_new_frog_0", value: w.call("uuid") },
				{ type: "command", id: "m0-f0" },
			],
			datums: [],
			unmatched: [],
		});
		expect(link?.xpath).toBeUndefined();
	});
});

describe("frame children (HQ `get_frame_children`)", () => {
	it("a module target is the module command alone", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			targetFrameChildren(doc, ctx, { type: "module", moduleUuid: CARE }),
		).toEqual([{ type: "command", id: "m1" }]);
	});

	it("a form target is m, the module's common datum prefix, m-f, then the rest", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		// Frog care holds a followup ([case_id]) and a registration
		// ([case_id_new_frog_0]): no common prefix, so each form's datums
		// follow its own command.
		expect(formFrameChildren(doc, ctx, CARE, VISIT).map(shape)).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f0" },
			{
				type: "datum",
				id: "case_id",
				requiresSelection: true,
				caseType: "frog",
			},
		]);
		expect(
			formFrameChildren(doc, ctx, CARE, REGISTER_AGAIN).map(shape),
		).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f1" },
			{
				type: "datum",
				id: "case_id_new_frog_0",
				requiresSelection: false,
				caseType: "frog",
				function: w.call("uuid"),
			},
		]);
	});

	it("hoists the shared selection datum ahead of the form command in a case-first module", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "mod-p",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-a",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "a", label: proseText("A") })],
						},
						{
							uuid: "frm-b",
							name: "Close",
							type: "close",
							fields: [f({ kind: "text", id: "b", label: proseText("B") })],
						},
					],
				},
			],
		});
		const ctx = formLinkProjectionContext(doc);
		expect(
			formFrameChildren(doc, ctx, testUuid("mod-p"), testUuid("frm-b")).map(
				shape,
			),
		).toEqual([
			{ type: "command", id: "m0" },
			{
				type: "datum",
				id: "case_id",
				requiresSelection: true,
				caseType: "patient",
			},
			{ type: "command", id: "m0-f1" },
		]);
	});

	it("names the selection datums a target needs", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			targetSelectionDatums(doc, ctx, {
				type: "form",
				moduleUuid: CARE,
				formUuid: VISIT,
			}).map((d) => d.id),
		).toEqual(["case_id"]);
		expect(
			targetSelectionDatums(doc, ctx, {
				type: "form",
				moduleUuid: CARE,
				formUuid: REGISTER_AGAIN,
			}),
		).toEqual([]);
	});

	it("reads a registration form's entry datums with their case type", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			entryFrameDatums(doc, ctx, INTAKE, REGISTER).map((d) => ({
				id: d.id,
				requiresSelection: d.requiresSelection,
				caseType: d.caseType,
				function: d.function,
			})),
		).toEqual([
			{
				id: "case_id_new_frog_0",
				requiresSelection: false,
				caseType: "frog",
				function: w.call("uuid"),
			},
		]);
	});
});

describe("datum matching", () => {
	const target: FrameChild[] = [
		{ type: "command", id: "m1" },
		{ type: "command", id: "m1-f0" },
		{ type: "datum", datum: datum("case_id", true, "frog") },
	];

	it("keeps the target id when the source carries the same id and type", () => {
		const match = matchFrameToSource(target, [datum("case_id", true, "frog")]);
		expect(match.unmatched).toEqual([]);
		expect(match.matched).toEqual([{ id: "case_id", sourceId: "case_id" }]);
		expect(match.children).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f0" },
			{ type: "datum", id: "case_id", value: sessionDataRef("case_id") },
		]);
	});

	it("carries the source id when the same type lives under another id (HQ `_find_best_match`)", () => {
		const match = matchFrameToSource(target, [
			datum("case_id_new_frog_0", false, "frog", w.call("uuid")),
		]);
		expect(match.unmatched).toEqual([]);
		expect(match.matched).toEqual([
			{ id: "case_id", sourceId: "case_id_new_frog_0" },
		]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id",
			value: sessionDataRef("case_id_new_frog_0"),
		});
	});

	it("takes the FIRST source datum of the type in source order", () => {
		const match = matchFrameToSource(target, [
			datum("case_id_new_frog_0", false, "frog", w.call("uuid")),
			datum("case_id", true, "frog"),
		]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id",
			value: sessionDataRef("case_id_new_frog_0"),
		});
	});

	it("skips root-module placeholder datums when choosing an automatic source", () => {
		const match = matchFrameToSource(target, [
			{
				...datum("case_id_new_frog_0", false, "frog", w.call("uuid")),
				fromParentModule: true,
			},
			datum("case_id_new_frog_1", false, "frog", w.call("uuid")),
		]);
		expect(match.unmatched).toEqual([]);
		expect(match.matched).toEqual([
			{ id: "case_id", sourceId: "case_id_new_frog_1" },
		]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id",
			value: sessionDataRef("case_id_new_frog_1"),
		});
	});

	it("reports a selection datum nothing in the source satisfies", () => {
		// A type-less source datum never matches, and a different type
		// never matches: the wire cannot supply a valid target case.
		const match = matchFrameToSource(target, [
			datum("case_id", true),
			datum("case_id", true, "toad"),
		]);
		expect(match.unmatched.map((d) => d.id)).toEqual(["case_id"]);
	});

	it("carries a function datum as its function, never as a session ref", () => {
		const match = matchFrameToSource(
			[
				{ type: "command", id: "m1" },
				{ type: "command", id: "m1-f1" },
				{
					type: "datum",
					datum: datum("case_id_new_frog_0", false, "frog", w.call("uuid")),
				},
			],
			[datum("case_id", true, "frog")],
		);
		expect(match.unmatched).toEqual([]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id_new_frog_0",
			value: w.call("uuid"),
		});
	});

	it("manual values land on the target datum they name and report the rest", () => {
		const match = matchFrameToManual(
			[
				{ type: "command", id: "m1" },
				{ type: "datum", datum: datum("parent_id", true, "clinic") },
				{ type: "command", id: "m1-f0" },
				{ type: "datum", datum: datum("case_id", true, "frog") },
				{
					type: "datum",
					datum: datum("case_id_new_visit_1", false, "visit", w.call("uuid")),
				},
			],
			[
				{ name: "case_id", xpath: w.str("frog-7") },
				{
					name: "nothing_reads_this",
					xpath: w.str("x"),
				},
			],
			new Set(),
		);
		expect(match.children).toEqual([
			{ type: "command", id: "m1" },
			// An unnamed selection datum is still carried by its self
			// reference so the frame is total — and reported as `missing`.
			{ type: "datum", id: "parent_id", value: sessionDataRef("parent_id") },
			{ type: "command", id: "m1-f0" },
			{
				type: "datum",
				id: "case_id",
				value: w.str("frog-7"),
			},
			// A function datum nobody names keeps its function.
			{ type: "datum", id: "case_id_new_visit_1", value: w.call("uuid") },
		]);
		expect(match.missing.map((d) => d.id)).toEqual(["parent_id"]);
		expect(match.unused).toEqual(["nothing_reads_this"]);
	});
});

describe("previousFrameChildren (HQ `previous_screen`)", () => {
	it("pops the last child and keeps popping while the popped child was a non-selection datum", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		// Forms-first module: [m1, m1-f0, case_id] → pop case_id → m1-f0 is
		// a command, stop.
		expect(previousFrameChildren(doc, ctx, CARE, VISIT)).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f0" },
		]);
		// [m1, m1-f1, case_id_new_frog_0] → the popped child is a function
		// datum, so HQ pops again → the command goes too → [m1]. A
		// registration form's "previous" is its module menu.
		expect(previousFrameChildren(doc, ctx, CARE, REGISTER_AGAIN)).toEqual([
			{ type: "command", id: "m1" },
		]);
	});

	it("keeps the hoisted selection datum in a case-first module", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "mod-p",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-a",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "a", label: proseText("A") })],
						},
					],
				},
			],
		});
		const ctx = formLinkProjectionContext(doc);
		// [m0, case_id, m0-f0] → pop m0-f0 → case_id is a selection, keep.
		expect(
			previousFrameChildren(doc, ctx, testUuid("mod-p"), testUuid("frm-a")),
		).toEqual([
			{ type: "command", id: "m0" },
			{ type: "datum", id: "case_id", value: sessionDataRef("case_id") },
		]);
	});
});

describe("projectAfterSubmit: frames and reads", () => {
	it.each([false, true])(
		"substitutes an earlier grouped-tile case datum (manual: %s)",
		(manual) => {
			const doc = structuredClone(frogDoc());
			const config = caseListConfig([
				{ field: "case_name", header: "Name" },
				{ field: "mood", header: "Mood" },
			]);
			config.columns = config.columns.map((column, index) => ({
				...column,
				tile: tileCell(0, index, 4, 1),
			}));
			config.tile = { grouping: { identifier: "parent", headerRows: 1 } };
			doc.modules[CARE].caseListConfig = config;
			doc.forms[REGISTER].formLinks = [
				{
					uuid: LINK_VISIT,
					target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
					...(manual && {
						datums: [
							{
								name: { kind: "selected-case" as const, module: CARE },
								xpath: term(literal("frog-7")),
							},
						],
					}),
				},
			];
			blueprintDocSchema.parse(toPersistableDoc(doc));
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const projected = project(doc, REGISTER);
			const companion = projected?.links[0]?.children.find(
				(child) => child.type === "datum" && child.id === "case_id_parent_ids",
			);
			expect(companion?.type).toBe("datum");
			if (companion?.type !== "datum")
				throw new Error("Missing grouped companion datum");
			expect(wireText(companion.value)).toBe(
				manual
					? "join(' ', distinct-values(instance('casedb')/casedb/case[@case_id = 'frog-7']/index/parent))"
					: "join(' ', distinct-values(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id_new_frog_0]/index/parent))",
			);
		},
	);

	it("projects two admitted destinations, each frame matched to the source", () => {
		const doc = frogDoc();
		const projected = project(doc, REGISTER);
		expect(projected).toBeDefined();
		if (projected === undefined) return;
		const byUuid = new Map(projected.links.map((link) => [link.uuid, link]));
		expect(byUuid.get(LINK_VISIT)).toMatchObject({
			uuid: LINK_VISIT,
			role: "destination",
			target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
			children: [
				{ type: "command", id: "m1" },
				{ type: "command", id: "m1-f0" },
				{
					type: "datum",
					id: "case_id",
					value: sessionDataRef("case_id_new_frog_0"),
				},
			],
			datums: [],
			unmatched: [],
			missing: [],
			unused: [],
		});
		expect(byUuid.get(LINK_REGISTER)).toMatchObject({
			uuid: LINK_REGISTER,
			children: [
				{ type: "command", id: "m1" },
				{ type: "command", id: "m1-f1" },
				{ type: "datum", id: "case_id_new_frog_0", value: w.call("uuid") },
			],
		});
	});

	it("anchors a registration form's case reads at the case it created", () => {
		// After a registration form closes its case EXISTS and the entry's
		// create datum names it, so `#frog/mood` walks casedb from
		// `case_id_new_frog_0` and `#frog/case_id` IS that datum.
		const doc = structuredClone(frogDoc());
		const reg = doc.forms[REGISTER];
		if (reg?.formLinks?.[0] === undefined) throw new Error("fixture");
		reg.formLinks = [
			{
				...reg.formLinks[0],
				condition: and(
					eq(
						{ kind: "form-case", caseType: "frog", property: "mood" },
						literal("happy"),
					),
					neq(
						{ kind: "form-case", caseType: "frog", property: "case_id" },
						literal(""),
					),
				),
			},
		];
		const projected = project(doc, REGISTER);
		const created = wireText(sessionDataRef("case_id_new_frog_0"));
		expect(wireText(projected?.links[0]?.xpath)).toBe(
			`instance('casedb')/casedb/case[@case_id = ${created}]/mood = 'happy' and ${created} != ''`,
		);
	});

	it("anchors a case-loading form's case reads at the selected case, and reads case_id as the attribute", () => {
		const doc = structuredClone(frogDoc());
		const visit = doc.forms[VISIT];
		if (visit === undefined) throw new Error("fixture");
		visit.formLinks = [
			{
				uuid: testUuid("lnk-back"),
				condition: neq(
					{ kind: "form-case", caseType: "frog", property: "case_id" },
					literal(""),
				),
				target: { type: "module", moduleUuid: INTAKE },
			},
			{
				uuid: testUuid("lnk-else"),
				target: { type: "module", moduleUuid: CARE },
			},
		];
		const projected = project(doc, VISIT);
		const back = projected?.links.find(
			(link) => link.uuid === testUuid("lnk-back"),
		);
		expect(wireText(back?.xpath)).toBe(
			`${wireText(sessionDataRef("case_id"))} != ''`,
		);
	});

	it("returns undefined for a form without links", () => {
		const doc = frogDoc();
		expect(project(doc, VISIT)).toBeUndefined();
	});
});

describe("ownCaseSessionRef", () => {
	it("is the selection datum on a case-loading form and the create datum on a registration form", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			ownCaseSessionRef(
				doc,
				CARE,
				"followup",
				entryFrameDatums(doc, ctx, CARE, VISIT),
			),
		).toEqual(sessionDataRef("case_id"));
		expect(
			ownCaseSessionRef(
				doc,
				INTAKE,
				"registration",
				entryFrameDatums(doc, ctx, INTAKE, REGISTER),
			),
		).toEqual(sessionDataRef("case_id_new_frog_0"));
	});

	it("is undefined for a survey, which carries no case", () => {
		const doc = structuredClone(frogDoc());
		const mod = doc.modules[INTAKE];
		const reg = doc.forms[REGISTER];
		if (mod === undefined || reg === undefined) throw new Error("fixture");
		mod.caseType = undefined;
		mod.caseListConfig = undefined;
		reg.type = "survey";
		reg.formLinks = undefined;
		// A survey holds no own case.
		reg.caseOperations = undefined;
		const ctx = formLinkProjectionContext(doc);
		expect(
			ownCaseSessionRef(
				doc,
				INTAKE,
				"survey",
				entryFrameDatums(doc, ctx, INTAKE, REGISTER),
			),
		).toBeUndefined();
	});
});

describe("totality predicates", () => {
	it("formLinkActionsBuildable says no when a module the frame reads is outside the sequence or has a malformed case type", () => {
		const doc = frogDoc();
		const links = doc.forms[REGISTER]?.formLinks ?? [];
		expect(formLinkActionsBuildable(doc, REGISTER, links)).toBe(true);

		const badType = structuredClone(doc);
		const care = badType.modules[CARE];
		if (care === undefined) throw new Error("fixture");
		care.caseType = "frog case";
		expect(formLinkActionsBuildable(badType, REGISTER, links)).toBe(false);
		expect(() => project(badType, REGISTER)).toThrow();

		const unsequenced = structuredClone(doc);
		unsequenced.moduleOrder = unsequenced.moduleOrder.filter(
			(uuid) => uuid !== CARE,
		);
		expect(formLinkActionsBuildable(unsequenced, REGISTER, links)).toBe(false);
	});

	it("formLinkActionsBuildable reads a this-form link as its source form's menu", () => {
		const doc = frogDoc();
		const links = [{ target: { type: "this-form" as const } }];
		expect(formLinkActionsBuildable(doc, REGISTER, links)).toBe(true);
		const broken = structuredClone(doc);
		unname(broken, REGISTER);
		expect(formLinkActionsBuildable(broken, REGISTER, links)).toBe(false);
	});

	it("moduleCaseTypeForActions mirrors the expander's case-activity gate", () => {
		const doc = buildDoc({
			appName: "Gate",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "mod-survey",
					name: "Surveys",
					caseType: "patient",
					forms: [
						{
							name: "S",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
				{
					uuid: "mod-viewer",
					name: "Viewer",
					caseType: "patient",
					caseListMenuItem: {},
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [],
				},
			],
		});
		expect(moduleCaseTypeForActions(doc, testUuid("mod-survey"))).toBe("");
		expect(moduleCaseTypeForActions(doc, testUuid("mod-viewer"))).toBe(
			"patient",
		);
	});

	it("formLinkActionsBuildable says no when a form the frame reads has no buildable actions", () => {
		const doc = frogDoc();
		const links = doc.forms[REGISTER]?.formLinks ?? [];
		expect(formLinkActionsBuildable(doc, REGISTER, links)).toBe(true);
		// Strip the target module's registration of the name of the case it
		// creates: the validator refuses it (CASE_CREATE_NAME_MISSING) and the
		// wire plan would throw on it.
		const broken = structuredClone(doc);
		unname(broken, REGISTER_AGAIN);
		expect(formLinkActionsBuildable(broken, REGISTER, links)).toBe(false);
	});

	it("formLinkActionsBuildable closes over a child module's structural-root forms", () => {
		const doc = frogDoc();
		const care = doc.modules[CARE];
		const visit = doc.forms[VISIT];
		if (care === undefined || visit === undefined) throw new Error("fixture");
		care.parentModuleUuid = INTAKE;
		const links = [
			{
				uuid: testUuid("lnk-child-self"),
				target: { type: "module" as const, moduleUuid: CARE },
			},
		];
		expect(formLinkActionsBuildable(doc, VISIT, links)).toBe(true);

		const broken = structuredClone(doc);
		unname(broken, REGISTER);

		expect(formLinkActionsBuildable(broken, VISIT, links)).toBe(false);
	});
});

/** Take the name of the case `formUuid` creates off its own case. */
function unname(doc: BlueprintDoc, formUuid: Uuid): void {
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation) => operation.action === "own",
	);
	if (own?.name === undefined) throw new Error("fixture missing its name");
	delete own.name;
}
