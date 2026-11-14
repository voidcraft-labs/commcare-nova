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
import { describe, expect, it } from "vitest";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, proseText } from "@/lib/domain";
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
import { typedInstantValue } from "../../../xpath/wire/instant";
import { serializeWire } from "../../../xpath/wire/serialize";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import {
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
