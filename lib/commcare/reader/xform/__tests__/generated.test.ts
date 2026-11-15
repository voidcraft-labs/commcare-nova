/**
 * Every purpose of `GENERATED_RULES`, held at the form reader's boundary: a
 * document that makes the production emitter write the node is emitted and
 * read back, and the node takes its purpose's role, never a field's. The same
 * source with one token of what proves the node changed, and with the node
 * renamed, reads the node as the person's own Hidden Value: an edit made in
 * HQ's form builder is kept, and a name the allocator would not give proves
 * nothing. The case region's purposes (keyed creates and their counts,
 * conditions, guards and clock nodes) are read as the region, each container
 * named for what it is, and left to the case management stage; renamed, or its
 * shape edited, a node is no container of Nova's.
 *
 * Plausible failures: a purpose with no rule; an edited node folded into
 * Nova's; a renamed node folded; a generated node read as a field; the
 * earlier spelling of a date and time's case text not recognized, or
 * recognized without saying what the first publish changes.
 */

import { type Element, isTag } from "domhandler";
import { findOne } from "domutils";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { and, eq, formField, literal } from "@/lib/domain/expression/builders";
import { caseCaptureFixture } from "../../../__tests__/caseCaptureFixture";
import {
	caseOperationFixture,
	type OperationScenario,
} from "../../../__tests__/caseOperationFixture";
import { constraintMessageFixture } from "../../../__tests__/constraintMessageFixture";
import { extensionCaseFixture } from "../../../__tests__/extensionCaseFixture";
import { expandDoc } from "../../../expander";
import { serializeXml } from "../../../serializeXml";
import { FormPath } from "../../../xform/formPath";
import { generatedBaseName } from "../../../xform/generatedNodes";
import { parseXml } from "../../../xmlParse";
import {
	storedInstantValue,
	typedInstantValue,
} from "../../../xpath/wire/instant";
import { serializeWire } from "../../../xpath/wire/serialize";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import {
	type AppJson,
	readCases,
	readFields,
} from "../../caseManagement/__tests__/caseReading";
import { readHqApp } from "../../index";
import {
	DATETIME_SIBLING_ENTRY,
	datetimeSpelling,
	GENERATED_RULES,
	isAllocatedName,
} from "../generated";
import type { NodeRole } from "../index";
import { readForm, XMLNS } from "./formReading";

const TARGET = { origin: "https://india.commcarehq.org", domain: "clinic" };

/** Every form of a document as the HQ import file holds it, under the reader's own `xmlns`. */
function sources(doc: BlueprintDoc): string[] {
	const hq = expandDoc(doc, { attachmentTarget: TARGET });
	return hq.modules.flatMap((module) =>
		module.forms.map((form) => {
			const xml = hq._attachments[`${form.unique_id}.xml`];
			if (typeof xml !== "string") throw new Error("Missing form attachment.");
			return xml.replace(`xmlns="${form.xmlns}"`, `xmlns="${XMLNS}"`);
		}),
	);
}

/** The one emitted form that holds `name`. */
function sourceHolding(doc: BlueprintDoc, name: string): string {
	const found = sources(doc).filter((xml) => xml.includes(`<${name}`));
	expect(found).toHaveLength(1);
	return found[0] as string;
}

/** The role the reading gives the node at `path` below the data root, or the one node named
 *  `path` where it holds no slash. */
async function roleAt(
	source: string,
	path: string,
): Promise<NodeRole | undefined> {
	const reading = await readForm(source);
	const xform = reading.xform;
	if (xform === null) throw new Error("The form did not read.");
	const node =
		xform.nodes.get(path) ??
		[...xform.nodes.values()].find((one) => one.name === path);
	if (node === undefined) throw new Error(`No node at ${path}.`);
	return xform.roles.get(node);
}

/** The source with one attribute of the bind of `nodeset` set to `value`. */
function bindEdited(
	source: string,
	nodeset: string,
	attribute: string,
	value: string,
): string {
	const document = parseXml(source);
	const bind = findOne(
		(element: Element) =>
			element.name === "bind" && element.attribs.nodeset === nodeset,
		document.children.filter(isTag),
		true,
	);
	if (bind === null) throw new Error(`No bind of ${nodeset}.`);
	bind.attribs[attribute] = value;
	return serializeXml(document);
}

const survey = (fields: FieldSpec[]): BlueprintDoc =>
	buildDoc({
		modules: [
			{ name: "Menu", forms: [{ name: "Form", type: "survey", fields }] },
		],
	});

function registration(fields: FieldSpec[]): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen_at", label: proseText("Seen") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ name: "Register", type: "registration", fields }],
			},
		],
	});
}

describe("the rules", () => {
	it("hold one rule per purpose, settled where its owner can be read", () => {
		for (const [purpose, rule] of Object.entries(GENERATED_RULES))
			expect(rule.purpose).toBe(purpose);
		expect(
			Object.values(GENERATED_RULES)
				.filter((rule) => rule.settledBy === "case-management")
				.map((rule) => rule.purpose)
				.sort(),
		).toEqual(
			[
				"condition",
				"datetime",
				"guard",
				"instant",
				"keyed",
				"keyed-count",
				"owner",
				"trimmed",
				"url",
			].sort(),
		);
	});

	it("take the allocator's base or a suffix from 1 with no leading zero", () => {
		const base = generatedBaseName("trimmed", "name");
		expect(base).toBe("nova_trimmed_name");
		expect(isAllocatedName("nova_trimmed_name", base)).toBe(true);
		expect(isAllocatedName("nova_trimmed_name_2", base)).toBe(true);
		expect(isAllocatedName("nova_trimmed_name_0", base)).toBe(false);
		expect(isAllocatedName("nova_trimmed_name_02", base)).toBe(false);
		expect(isAllocatedName("nova_trimmed_name_x", base)).toBe(false);
		expect(isAllocatedName("nova_trimmed_names", base)).toBe(false);
		expect(generatedBaseName("constraint-count", "gate", "0")).toBe(
			"nova_constraint_gate_0",
		);
		expect(generatedBaseName("guard", "op", "text")).toBe("nova_guard_op_text");
		expect(generatedBaseName("keyed-count", "nova_keyed_op_1")).toBe(
			"nova_count_nova_keyed_op_1",
		);
	});
});

describe("a validation count lifted out of a constraint", () => {
	const doc = survey([
		f({
			kind: "repeat",
			id: "roster",
			children: [f({ kind: "text", id: "answer" })],
		}),
		f({
			kind: "int",
			id: "gate",
			validate: "count(#form/roster/answer[. = 'x']) >= 1",
		}),
	]);
	const source = sources(doc)[0] as string;

	it("folds as the count its question's constraint reads, its calculate set aside", async () => {
		expect(await roleAt(source, "nova_constraint_gate_0")).toMatchObject({
			kind: "generated",
			purpose: "constraint-count",
		});
		const reading = await readForm(source);
		expect([...(reading.xform?.generatedValues.keys() ?? [])]).toEqual([
			"/data/nova_constraint_gate_0",
		]);
		expect(reading.xform?.generated.map((node) => node.name)).toEqual([
			"nova_constraint_gate_0",
		]);
	});

	it("is the person's Hidden Value once its calculate is no count, or once renamed", async () => {
		const edited = bindEdited(
			source,
			"/data/nova_constraint_gate_0",
			"calculate",
			"sum(/data/roster/answer)",
		);
		expect(await roleAt(edited, "nova_constraint_gate_0")).toMatchObject({
			kind: "field",
		});
		const renamed = source.replaceAll(
			"nova_constraint_gate_0",
			"nova_constraint_gate_x",
		);
		expect(await roleAt(renamed, "nova_constraint_gate_x")).toMatchObject({
			kind: "field",
		});
	});
});

describe("a protected validation message's carrier", () => {
	const { doc } = constraintMessageFixture("references");
	const source = sourceHolding(doc, "nova_constraint_message_checked");

	it("folds as the carrier of the question just before it", async () => {
		expect(
			await roleAt(source, "nova_constraint_message_checked"),
		).toMatchObject({
			kind: "generated",
			purpose: "constraint-message",
		});
	});

	it("is the person's question once its bind is changed, or once renamed", async () => {
		const edited = bindEdited(
			source,
			"/data/nova_constraint_message_checked",
			"relevant",
			"true()",
		);
		expect(
			await roleAt(edited, "nova_constraint_message_checked"),
		).toMatchObject({
			kind: "field",
		});
		const renamed = source.replaceAll(
			"nova_constraint_message_checked",
			"nova_constraint_message_checked_0",
		);
		expect(
			await roleAt(renamed, "nova_constraint_message_checked_0"),
		).toMatchObject({
			kind: "field",
		});
	});
});

describe("a protected validation message, read whole", () => {
	/** The findings a whole reading of `doc`'s export leaves at a question, with `edit` applied. */
	async function questionFindings(
		doc: BlueprintDoc,
		edit: (xml: string) => string = (xml) => xml,
	): Promise<string[]> {
		const outcome = readHqApp(await inputFor(exportedBody(doc, { xml: edit })));
		return (outcome.kind === "account" ? outcome.findings : [])
			.filter((finding) => finding.place.kind === "question")
			.map((finding) => `${finding.code} ${finding.detail.name ?? ""}`);
	}

	it("reads the carrier's text as the question's message, its expression and forms claimed", async () => {
		const { doc } = constraintMessageFixture("references");
		expect(await questionFindings(doc)).toEqual([]);
	});

	it("leaves a composed expression that is not the message's own unclaimed", async () => {
		const { doc } = constraintMessageFixture("references");
		const edited = await questionFindings(doc, (xml) =>
			xml.replace(
				"__nova_mode&apos;) = &apos;media&apos;",
				"__nova_mode&apos;) = &apos;plain&apos;",
			),
		);
		expect(edited).toContain("unrecognized xform:bind@jr:constraintMsg");
	});
});

describe("a count repeat's count node", () => {
	const doc = survey([
		f({ kind: "int", id: "n" }),
		f({
			kind: "repeat",
			id: "rows",
			repeat_mode: "count_bound",
			repeat_count: "#form/n + 1",
			children: [f({ kind: "text", id: "answer" })],
		} as FieldSpec),
	]);
	const source = sources(doc)[0] as string;

	it("folds as the count the repeat's jr:count names, its calculate the repeat's count", async () => {
		expect(await roleAt(source, "nova_count_rows")).toMatchObject({
			kind: "generated",
			purpose: "count",
		});
		const reading = await readForm(source);
		const rows = reading.xform
			?.childrenOf(null)
			.find((field) => field.id === "rows");
		expect(rows?.field.repeat_mode).toBe("count_bound");
		expect(rows?.expressions.map((one) => [one.slot, one.text])).toContainEqual(
			["repeat_count", "/data/n + 1"],
		);
	});

	it("is the person's Hidden Value once its type is changed, or once renamed", async () => {
		const edited = bindEdited(
			source,
			"/data/nova_count_rows",
			"type",
			"xsd:string",
		);
		expect(await roleAt(edited, "nova_count_rows")).toMatchObject({
			kind: "field",
		});
		const renamed = source.replaceAll("nova_count_rows", "nova_count_rowz");
		expect(await roleAt(renamed, "nova_count_rowz")).toMatchObject({
			kind: "field",
		});
	});
});

describe("a query repeat in the count placement", () => {
	const doc = survey([
		f({ kind: "text", id: "pick" }),
		f({
			kind: "repeat",
			id: "r",
			label: proseText("r"),
			repeat_mode: "query_bound",
			data_source: { ids_query: "#form/pick" },
			children: [
				f({ kind: "text", id: "answer" }),
				f({
					kind: "hidden",
					id: "made",
					calculate: "current()/../../@current_index",
				}),
			],
		} as FieldSpec),
	]);
	const source = sources(doc)[0] as string;

	it("is one repeat at its wrapper, its row no field and its generated nodes folded", async () => {
		const reading = await readForm(source);
		const xform = reading.xform;
		if (xform === null) throw new Error("The form did not read.");
		const r = xform.childrenOf(null).find((field) => field.id === "r");
		expect(r?.kind).toBe("repeat");
		expect(r?.field).toMatchObject({
			repeat_mode: "query_bound",
			placement: "count",
		});
		expect(r?.expressions.map((one) => [one.slot, one.text])).toContainEqual([
			"ids_query",
			"/data/pick",
		]);
		expect(xform.childrenOf(r ?? null).map((field) => field.id)).toEqual([
			"answer",
			"made",
		]);
		const roles = Object.fromEntries(
			[
				"r/nova_query_ids_r",
				"r/nova_query_count_r",
				"r/nova_query_position_r",
				"r/item/nova_query_id_r",
				"r/item/nova_query_index_r",
			].map((path) => {
				const node = xform.nodes.get(path);
				const role = node === undefined ? undefined : xform.roles.get(node);
				return [path, role?.kind === "generated" ? role.purpose : role?.kind];
			}),
		);
		expect(roles).toEqual({
			"r/nova_query_ids_r": "query-ids",
			"r/nova_query_count_r": "query-count",
			"r/nova_query_position_r": "query-position",
			"r/item/nova_query_id_r": "query-id",
			"r/item/nova_query_index_r": "query-index",
		});
		const row = xform.nodes.get("r/item");
		expect(row === undefined ? undefined : xform.roles.get(row)?.kind).toBe(
			"query-row",
		);
	});

	it("is no count placement once its count's calculate is edited, or its nodes renamed", async () => {
		const edited = bindEdited(
			source,
			"/data/r/nova_query_count_r",
			"calculate",
			"count(../nova_query_ids_r)",
		);
		const editedRead = await readForm(edited);
		expect(
			editedRead.xform?.childrenOf(null).find((field) => field.id === "r")
				?.field.placement,
		).not.toBe("count");
		const renamed = source.replaceAll(
			"nova_query_count_r",
			"nova_query_count_q",
		);
		const renamedRead = await readForm(renamed);
		expect(
			renamedRead.xform?.childrenOf(null).find((field) => field.id === "r")
				?.field.placement,
		).not.toBe("count");
	});

	/** The source with the value of the setvalue of `ref` set to `value`. */
	function setvalueEdited(ref: string, value: string): string {
		const document = parseXml(source);
		const setvalue = findOne(
			(element: Element) =>
				element.name === "setvalue" && element.attribs.ref === ref,
			document.children.filter(isTag),
			true,
		);
		if (setvalue === null) throw new Error(`No setvalue of ${ref}.`);
		setvalue.attribs.value = value;
		return serializeXml(document);
	}

	/** The role of `path`'s node, read from `edited`, where the node is still there. */
	async function kindAt(edited: string, path: string): Promise<string> {
		const reading = await readForm(edited);
		const node = reading.xform?.nodes.get(path);
		const role =
			node === undefined ? undefined : reading.xform?.roles.get(node);
		return role?.kind === "generated" ? role.purpose : String(role?.kind);
	}

	it.each([
		[
			"query-ids",
			"r/nova_query_ids_r",
			() =>
				bindEdited(
					source,
					"/data/r/nova_query_ids_r",
					"calculate",
					"join(',', /data/pick)",
				),
		],
		[
			"query-position",
			"r/nova_query_position_r",
			() =>
				bindEdited(
					source,
					"/data/r/nova_query_position_r",
					"calculate",
					"count(../nova_query_ids_r)",
				),
		],
		[
			"query-id",
			"r/item/nova_query_id_r",
			() =>
				bindEdited(
					source,
					"/data/r/item/nova_query_id_r",
					"calculate",
					"selected-at(../../nova_query_ids_r, 0)",
				),
		],
		[
			"query-index",
			"r/item/nova_query_index_r",
			() =>
				setvalueEdited("/data/r/item/nova_query_index_r", "position(..) + 1"),
		],
	] as const)(
		"reads the %s node as no generated node once one token of it is changed",
		async (purpose, path, edit) => {
			expect(await kindAt(source, path)).toBe(purpose);
			const edited = edit();
			expect(edited).not.toBe(source);
			expect(await kindAt(edited, path)).not.toBe(purpose);
		},
	);

	it.each([
		["query-ids", "nova_query_ids_r", "r/nova_query_ids_q"],
		["query-position", "nova_query_position_r", "r/nova_query_position_q"],
		["query-id", "nova_query_id_r", "r/item/nova_query_id_q"],
		["query-index", "nova_query_index_r", "r/item/nova_query_index_q"],
	] as const)(
		"reads the %s node as no generated node once renamed",
		async (purpose, name, renamedPath) => {
			const renamedName = renamedPath.slice(renamedPath.lastIndexOf("/") + 1);
			const renamed = source.replaceAll(name, renamedName);
			expect(await kindAt(renamed, renamedPath)).not.toBe(purpose);
			expect(await kindAt(renamed, renamedPath)).not.toBe("generated");
		},
	);
});

describe("a case write's siblings, proposed for the case management stage", () => {
	it("proposes a case name's trimmed sibling, and reads an edited one as the person's", async () => {
		const doc = registration([
			f({
				kind: "text",
				id: "name",
				caseWrite: { caseType: "patient", property: "case_name" },
			}),
		]);
		const source = sourceHolding(doc, "nova_trimmed_name");
		expect(await roleAt(source, "nova_trimmed_name")).toMatchObject({
			kind: "generated-candidate",
			purpose: "trimmed",
		});
		const reading = await readForm(source);
		expect(reading.xform?.candidates.map((node) => node.name)).toEqual([
			"nova_trimmed_name",
		]);
		const edited = bindEdited(
			source,
			"/data/nova_trimmed_name",
			"calculate",
			"/data/name",
		);
		expect(await roleAt(edited, "nova_trimmed_name")).toMatchObject({
			kind: "field",
		});
		const renamed = source.replaceAll("nova_trimmed_name", "nova_trimmed_nom");
		expect(await roleAt(renamed, "nova_trimmed_nom")).toMatchObject({
			kind: "field",
		});
	});

	it("proposes a date and time's case text, in today's spelling and in the earlier one", async () => {
		const doc = registration([
			f({
				kind: "text",
				id: "name",
				caseWrite: { caseType: "patient", property: "case_name" },
			}),
			f({
				kind: "datetime",
				id: "seen",
				caseWrite: { caseType: "patient", property: "seen_at" },
			}),
		]);
		const source = sourceHolding(doc, "nova_datetime_seen");
		expect(await roleAt(source, "nova_datetime_seen")).toMatchObject({
			kind: "generated-candidate",
			purpose: "datetime",
		});
		const seen = FormPath.root().child("seen");
		const earlier = serializeWire(typedInstantValue(seen.toWire()), {
			target: "xform",
			constraint: false,
		}).text;
		expect(datetimeSpelling(earlier, seen)).toBe("earlier");
		expect(datetimeSpelling("/data/seen", seen)).toBe("copy");
		expect(datetimeSpelling("/data/name", seen)).toBeUndefined();
		const reading = await readForm(source);
		const xform = reading.xform;
		const node = [...(xform?.nodes.values() ?? [])].find(
			(one) => one.name === "nova_datetime_seen",
		);
		if (xform === null || xform === undefined || node === undefined)
			throw new Error("The form did not read.");
		xform.settle(node, "generated");
		expect(
			xform.generated.map((one) => [one.purpose, one.owner]),
		).toContainEqual(["datetime", "/data/seen"]);
		expect(reading.ctx.facts.sameStateRewrites).toEqual([]);
		const renamed = source.replaceAll(
			"nova_datetime_seen",
			"nova_datetime_saw",
		);
		expect(await roleAt(renamed, "nova_datetime_saw")).toMatchObject({
			kind: "field",
		});
	});

	it("settles a date and time's case text in the earlier spelling, and says the first publish saves it as CommCare HQ stores it", async () => {
		const doc = registration([
			f({
				kind: "text",
				id: "name",
				caseWrite: { caseType: "patient", property: "case_name" },
			}),
			f({
				kind: "datetime",
				id: "seen",
				caseWrite: { caseType: "patient", property: "seen_at" },
			}),
		]);
		const earlier = serializeWire(
			typedInstantValue(FormPath.root().child("seen").toWire()),
			{ target: "xform", constraint: false },
		).text;
		const source = bindEdited(
			sourceHolding(doc, "nova_datetime_seen"),
			"/data/nova_datetime_seen",
			"calculate",
			earlier,
		);
		const reading = await readForm(source);
		const xform = reading.xform;
		const node = [...(xform?.nodes.values() ?? [])].find(
			(one) => one.name === "nova_datetime_seen",
		);
		if (xform === null || xform === undefined || node === undefined)
			throw new Error("The form did not read.");
		expect(xform.roles.get(node)).toMatchObject({
			kind: "generated-candidate",
			purpose: "datetime",
		});
		xform.settle(node, "generated");
		expect(
			xform.generated.map((one) => [one.purpose, one.owner]),
		).toContainEqual(["datetime", "/data/seen"]);
		expect(reading.ctx.facts.sameStateRewrites).toEqual([
			{
				entry: DATETIME_SIBLING_ENTRY,
				path: "/data/nova_datetime_seen",
				register: "date-and-time-saved-as-hq-stores-it",
			},
		]);
		// One token of the earlier spelling changed is no spelling Nova wrote.
		const edited = bindEdited(
			source,
			"/data/nova_datetime_seen",
			"calculate",
			earlier.replace("%Y", "%y"),
		);
		expect(edited).not.toBe(source);
		expect(await roleAt(edited, "nova_datetime_seen")).toMatchObject({
			kind: "field",
		});
	});

	it("proposes a Hidden Value's copy of a case's stored date and time as the emitter writes it today, and the case management stage folds it", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "seen_at",
							label: proseText("Seen"),
							data_type: "datetime",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "seen",
									calculate: "#patient/seen_at",
									caseWrite: { caseType: "patient", property: "seen_at" },
								}),
							],
						},
					],
				},
			],
		});
		const source = sourceHolding(doc, "nova_datetime_seen");
		const bind = findOne(
			(element: Element) =>
				element.name === "bind" &&
				element.attribs.nodeset === "/data/nova_datetime_seen",
			parseXml(source).children.filter(isTag),
			true,
		);
		// A Hidden Value Core holds as text is written as itself.
		expect(bind?.attribs.calculate).toBe("/data/seen");
		expect(await roleAt(source, "nova_datetime_seen")).toMatchObject({
			kind: "generated-candidate",
			purpose: "datetime",
		});
		const reading = await readCases(doc);
		const xform = reading.forms[0]?.xform;
		if (xform === null || xform === undefined)
			throw new Error("The form did not read.");
		expect(
			xform.generated.map((one) => [one.purpose, one.owner, one.name]),
		).toContainEqual(["datetime", "/data/seen", "nova_datetime_seen"]);
		expect(readFields(xform).map((field) => field.id)).toEqual(["seen"]);
		expect(reading.ctx.facts.sameStateRewrites).toEqual([]);
	});

	/** A follow-up whose Hidden Value `seen`, calculated by `calculate`, saves a date and time,
	 *  beside a registration whose date-and-time question saves the same property, so the
	 *  property's type is one a reading of the app can tell. */
	const hiddenSeenApp = (calculate: string): BlueprintDoc =>
		buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "seen_at",
							label: proseText("Seen"),
							data_type: "datetime",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "datetime",
									id: "first_seen",
									caseWrite: { caseType: "patient", property: "seen_at" },
								}),
							],
						},
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "seen",
									calculate,
									caseWrite: { caseType: "patient", property: "seen_at" },
								}),
							],
						},
					],
				},
			],
		});

	it.each([
		["a copy of a case's stored text", "#patient/seen_at", "stored"],
		["a typed date and time", "now()", "copy"],
	] as const)(
		"reads a Hidden Value holding %s whole, and its date-and-time sibling in the other spelling as one Nova would write differently",
		async (_, calculate, other) => {
			const doc = hiddenSeenApp(calculate);
			const clean = readHqApp(await inputFor(exportedBody(doc)));
			expect(clean.kind === "account" ? clean.findings : []).toEqual([]);
			const seen = FormPath.root().child("seen").toWire();
			const spelled = serializeWire(
				other === "stored" ? storedInstantValue(seen) : seen,
				{ target: "xform", constraint: false },
			).text;
			const edited = readHqApp(
				await inputFor(
					exportedBody(doc, {
						xml: (xml) =>
							xml.includes('nodeset="/data/nova_datetime_seen"')
								? bindEdited(
										xml,
										"/data/nova_datetime_seen",
										"calculate",
										spelled,
									)
								: xml,
					}),
				),
			);
			expect(
				(edited.kind === "account" ? edited.findings : []).map((one) => [
					one.code,
					(one.place as { path?: string }).path,
					one.detail.name,
				]),
			).toEqual([["unrecognized", "seen", "xform:model/bind@calculate"]]);
		},
	);

	it("proposes a capture's link node, and reads one for another project space as the person's", async () => {
		const doc = caseCaptureFixture("registration");
		const source = sourceHolding(doc, "nova_url_thepicture");
		expect(await roleAt(source, "nova_url_thepicture")).toMatchObject({
			kind: "generated-candidate",
			purpose: "url",
		});
		const elsewhere = source.replaceAll("/a/clinic/", "/a/elsewhere/");
		expect(await roleAt(elsewhere, "nova_url_thepicture")).toMatchObject({
			kind: "field",
		});
		const renamed = source.replaceAll(
			"nova_url_thepicture",
			"nova_url_thephoto",
		);
		expect(await roleAt(renamed, "nova_url_thephoto")).toMatchObject({
			kind: "field",
		});
	});

	it("proposes an advanced open action's owner node, and settles a candidate left open as a field", async () => {
		const doc = extensionCaseFixture("registration");
		const source = sourceHolding(doc, "nova_owner_episode");
		for (const name of ["nova_owner_episode", "nova_owner_consent"])
			expect(await roleAt(source, name)).toMatchObject({
				kind: "generated-candidate",
				purpose: "owner",
				owner: null,
				ownerValue: "acting-user",
			});
		const edited = bindEdited(
			source,
			"/data/nova_owner_episode",
			"calculate",
			"instance('commcaresession')/session/context/username",
		);
		expect(await roleAt(edited, "nova_owner_episode")).toMatchObject({
			kind: "field",
		});
		const settled = await readForm(source, { mint: true });
		expect(settled.xform?.candidates).toEqual([]);
		const node = [...(settled.xform?.nodes.values() ?? [])].find(
			(one) => one.name === "nova_owner_episode",
		);
		expect(
			node === undefined ? undefined : settled.xform?.roles.get(node)?.kind,
		).toBe("field");
	});

	/** The owner nodes the case management stage folded in the form that holds them, and the
	 *  form's fields. */
	async function ownerReading(rename?: {
		readonly from: string;
		readonly to: string;
	}): Promise<{
		owners: string[][];
		fields: string[];
		owner: (id: string) => unknown;
	}> {
		const doc = extensionCaseFixture("registration");
		const reading = await readCases(
			doc,
			rename === undefined
				? {}
				: {
						editSource: (xml) => xml.replaceAll(rename.from, rename.to),
						edit: (app: AppJson) => {
							for (const module of app.modules)
								for (const form of module.forms) {
									const opens = form.actions?.open_cases;
									if (!Array.isArray(opens)) continue;
									for (const open of opens as {
										case_properties?: Record<
											string,
											{ question_path?: string }
										>;
									}[]) {
										const owner = open.case_properties?.owner_id;
										if (owner?.question_path !== undefined)
											owner.question_path = owner.question_path.replaceAll(
												rename.from,
												rename.to,
											);
									}
								}
						},
					},
		);
		const form = reading.forms.find(
			(one) =>
				one.xform !== null &&
				[...one.xform.nodes.values()].some((node) =>
					node.name.includes("owner_"),
				),
		);
		const xform = form?.xform;
		if (form === undefined || xform === null || xform === undefined)
			throw new Error("No form holds an owner node.");
		return {
			owners: xform.generated
				.filter((one) => one.purpose === "owner")
				.map((one) => [one.owner, one.name]),
			fields: readFields(xform).map((field) => field.id),
			owner: (id) =>
				(form.form.caseOperations ?? []).find(
					(operation) => operation.id === id,
				)?.owner,
		};
	}

	it("settles each owner node an open action names as Nova's, keyed by the operation its name gives", async () => {
		const { owners, fields, owner } = await ownerReading();
		expect(owners.sort()).toEqual([
			["/data#consent", "nova_owner_consent"],
			["/data#episode", "nova_owner_episode"],
		]);
		expect(fields.filter((id) => id.startsWith("nova_owner_"))).toEqual([]);
		// An opened case owned by the worker prints as one with no owner
		// (`generatedNodes.ts::advancedOwnerNodeValue`), so the folded node reads
		// as no owner (`opened-case-owner-acting-user-is-absent`).
		expect(owner("episode")).toBeUndefined();
		expect(owner("consent")).toBeUndefined();
	});

	it.each([
		["a name with no owner prefix", "owner_episode"],
		["a name the allocator gives no operation", "nova_owner_ep-isode"],
	])(
		"reads an owner node renamed to %s as the person's Hidden Value",
		async (_, to) => {
			const { owners, fields, owner } = await ownerReading({
				from: "nova_owner_episode",
				to,
			});
			expect(owners).toEqual([["/data#consent", "nova_owner_consent"]]);
			expect(fields).toContain(to);
			expect(owner("episode")).toMatchObject({
				kind: "term",
				term: { kind: "field" },
			});
		},
	);
});

describe("the case region's purposes", () => {
	/** The one form of a case operation fixture holding an element whose name starts `prefix`,
	 *  that element's name, and the nodeset of its bind, where it has one. */
	function holding(
		scenario: OperationScenario,
		prefix: string,
	): { source: string; name: string; nodeset: string | undefined } {
		for (const source of sources(caseOperationFixture(scenario))) {
			const elements = parseXml(source).children.filter(isTag) as Element[];
			const node = findOne(
				(element: Element) => element.name.startsWith(prefix),
				elements,
				true,
			);
			if (node === null) continue;
			const bind = findOne(
				(element: Element) =>
					element.name === "bind" &&
					(element.attribs.nodeset ?? "").endsWith(`/${node.name}`),
				elements,
				true,
			);
			return { source, name: node.name, nodeset: bind?.attribs.nodeset };
		}
		throw new Error(`No form holds ${prefix}.`);
	}

	it.each([
		["key", "nova_keyed_", "keyed"],
		["key", "nova_count_nova_keyed_", "keyed-count"],
		["conditional", "nova_condition_", "condition"],
		["sequence", "nova_guard_", "guard"],
	] as const)(
		"reads %s's %s as the container %s, and a renamed one as none",
		async (scenario, prefix, container) => {
			const { source, name } = holding(scenario, prefix);
			expect(await roleAt(source, name)).toEqual({
				kind: "case-region",
				container,
			});
			const other = `renamed_${name.slice("nova_".length)}`;
			expect(
				await roleAt(source.replaceAll(name, other), other),
			).not.toMatchObject({ container });
		},
	);

	/** `xml` with one attribute of the bind whose nodeset ends `/${nodesetEnd}` set by `edit`;
	 *  `xml` itself where it holds no such bind. */
	function bindAttributeEdited(
		xml: string,
		nodesetEnd: string,
		attribute: string,
		edit: (value: string | undefined) => string,
	): string {
		const document = parseXml(xml);
		const bind = findOne(
			(element: Element) =>
				element.name === "bind" &&
				(element.attribs.nodeset ?? "").endsWith(`/${nodesetEnd}`),
			document.children.filter(isTag),
			true,
		);
		if (bind === null) return xml;
		bind.attribs[attribute] = edit(bind.attribs[attribute]);
		return serializeXml(document);
	}

	/** The case operation fixture's rename of the chosen case, under a condition of two
	 *  answers, which Case Management cannot state, so it stands in a condition group. */
	function conditionalRename(): BlueprintDoc {
		return produce(caseOperationFixture("scalar"), (draft) => {
			for (const form of Object.values(draft.forms))
				for (const operation of form.caseOperations ?? [])
					if (
						operation.id === "rename_patient" &&
						operation.action === "update"
					)
						operation.condition = and(
							eq(formField(testUuid("operation-enabled")), literal("yes")),
							eq(
								formField(testUuid("11111111-1111-4111-8111-111111111111")),
								literal("x"),
							),
						);
		});
	}

	it.each([
		[
			"a keyed create",
			"its id",
			() => caseOperationFixture("key"),
			"nova_keyed_create_visit/create_visit/case/@case_id",
			"calculate",
			(value: string | undefined) => (value ?? "").replace("<= 205", "<= 204"),
			"questions/savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside",
			"nova_operations/nova_keyed_create_visit/create_visit",
		],
		[
			"a keyed create",
			"its guard's id",
			() => caseOperationFixture("key"),
			"nova_guard_create_visit_text/case/@case_id",
			"calculate",
			(value: string | undefined) => (value ?? "").replace("<= 255", "<= 254"),
			"questions/savetocase-block-outside-nova-s-own-block-shape",
			"nova_operations/nova_keyed_create_visit/create_visit",
		],
		[
			"a conditional update",
			"its condition group's bind",
			conditionalRename,
			"nova_condition_rename_patient",
			"readonly",
			() => "true()",
			"questions/savetocase-block-outside-nova-s-own-block-shape",
			"nova_operations/nova_condition_rename_patient/rename_patient",
		],
	] as const)(
		"reads %s whole, and with %s edited as no block of Nova's",
		async (_, __, build, nodesetEnd, attribute, edit, code, block) => {
			const doc = build();
			const clean = readHqApp(await inputFor(exportedBody(doc)));
			expect(clean.kind === "account" ? clean.findings : []).toEqual([]);
			let edits = 0;
			const edited = readHqApp(
				await inputFor(
					exportedBody(doc, {
						xml: (xml) => {
							const out = bindAttributeEdited(xml, nodesetEnd, attribute, edit);
							if (out !== xml) edits += 1;
							return out;
						},
					}),
				),
			);
			expect(edits).toBe(1);
			expect(edited.kind).toBe("account");
			// The edited block is refused at its own path: never read as Nova's, never let pass.
			expect(
				(edited.kind === "account" ? edited.findings : []).map((one) => [
					one.code,
					(one.place as { path?: string }).path,
				]),
			).toContainEqual([code, block]);
		},
	);

	it("reads a keyed create's count as the region's only while its calculate is 1", async () => {
		const { source, name, nodeset } = holding("key", "nova_count_nova_keyed_");
		if (nodeset === undefined) throw new Error(`No bind of ${name}.`);
		const edited = bindEdited(source, nodeset, "calculate", "2");
		expect(await roleAt(edited, name)).not.toMatchObject({
			kind: "case-region",
		});
	});

	it("reads an operation's clock node as the region's, and an edited or renamed one as none", async () => {
		const { source, name, nodeset } = holding("sequence", "nova_instant_");
		if (nodeset === undefined) throw new Error(`No bind of ${name}.`);
		expect(await roleAt(source, name)).toMatchObject({ kind: "case-region" });
		const edited = bindEdited(source, nodeset, "calculate", "now()");
		expect(await roleAt(edited, name)).not.toMatchObject({
			kind: "case-region",
		});
		const other = `clock_${name.slice("nova_".length)}`;
		expect(
			await roleAt(source.replaceAll(name, other), other),
		).not.toMatchObject({ kind: "case-region" });
	});
});
