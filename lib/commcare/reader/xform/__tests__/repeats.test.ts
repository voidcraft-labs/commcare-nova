/**
 * Repeats (10.3) and where model iteration is held (10.4). Each row of the
 * repeat table is read from a source written for it; a model-iteration
 * repeat Nova's own emitter writes is read back as one, and one missing a
 * setvalue is not held. Over documents, the verdict holds model iteration
 * exactly where Nova's own rule runs it. It would catch a count repeat over a
 * Hidden Value read as anything but a count from that Hidden Value, a wrapper
 * missing a setvalue held, and a refused shape held.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { buildXForm } from "../../../xform/builder";
import { modelIterationVerdict } from "../repeats";
import {
	codesAt,
	readFields,
	readForm,
	unrecognizedAt,
	XMLNS,
	xformSource,
} from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** A repeat of one text question, with `count` its `jr:count` and `n` a question of `kind`. */
function counted(
	count: string | undefined,
	counter?: { readonly bind: string; readonly body: string },
) {
	return xformSource({
		data: `<n/><r jr:template=""><q/></r>`,
		model: `${counter?.bind ?? '<bind nodeset="/data/n" type="xsd:int"/>'}<bind nodeset="/data/r/q" type="xsd:string"/>`,
		body: `${counter?.body ?? '<input ref="/data/n"/>'}<group><repeat nodeset="/data/r"${
			count === undefined ? "" : ` jr:count="${count}" jr:noAddRemove="true()"`
		}><input ref="/data/r/q"/></repeat></group>`,
	});
}

describe("the repeat table", () => {
	it("reads a repeat with no count as one whose rows the worker adds", async () => {
		const reading = await readForm(counted(undefined));
		const fields = readFields(reading.xform ?? ({} as never));
		expect(
			fields.map((field) => [field.id, field.kind, field.field.repeat_mode]),
		).toEqual([
			["n", "int", undefined],
			["r", "repeat", "user_controlled"],
			["q", "text", undefined],
		]);
		expect(codesAt(reading, "r")).toEqual([]);
	});

	it("refuses jr:noAddRemove with no count", async () => {
		const reading = await readForm(
			xformSource({
				data: `<r jr:template=""><q/></r>`,
				model: '<bind nodeset="/data/r/q" type="xsd:string"/>',
				body: '<group><repeat nodeset="/data/r" jr:noAddRemove="true()"><input ref="/data/r/q"/></repeat></group>',
			}),
		);
		expect(codesAt(reading, "r")).toEqual([
			Q("jr-noaddremove-without-jr-count"),
		]);
	});

	it("refuses a count that is no path, and one that names no node", async () => {
		expect(codesAt(await readForm(counted("/data/n + 1")), "r")).toEqual([
			Q("jr-count-that-is-not-a-path-such-as-data-n-1"),
		]);
		expect(codesAt(await readForm(counted("/data/nothing")), "r")).toEqual([
			Q("jr-count-naming-a-node-in-a-secondary-instance-or-no-node"),
		]);
	});

	it("holds a count from an integer question, a Hidden Value or a single select", async () => {
		const integer = await readForm(counted("/data/n"));
		const [, repeat] = readFields(integer.xform ?? ({} as never));
		expect(repeat?.field.repeat_mode).toBe("count_bound");
		expect(repeat?.expressions.map((one) => [one.slot, one.text])).toEqual([
			["repeat_count", "/data/n"],
		]);
		// The count waits for the expression stage, which claims it.
		expect(unrecognizedAt(integer, "r")).toEqual(["xform:repeat@jr:count"]);
		expect(codesAt(integer, "r")).toEqual(["unrecognized"]);
		expect(
			integer.closed.claims.counts[
				Q("repeat-with-jr-count-naming-an-integer-question-of-the-form-s")
			],
		).toBeGreaterThan(0);

		const hidden = await readForm(
			counted("/data/n", {
				bind: '<bind nodeset="/data/n" calculate="2"/>',
				body: "",
			}),
		);
		expect(codesAt(hidden, "r")).toEqual(["unrecognized"]);
		expect(
			hidden.closed.claims.counts[
				Q("jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in")
			],
		).toBeGreaterThan(0);

		const select = await readForm(
			counted("/data/n", {
				bind: '<bind nodeset="/data/n" type="xsd:string"/>',
				body: '<select1 ref="/data/n"><item><value>1</value></item><item><value>2</value></item></select1>',
			}),
		);
		expect(codesAt(select, "r")).toEqual(["unrecognized"]);
		expect(
			select.closed.claims.counts[
				Q("jr-count-naming-a-single-select-question-whose-every-choice")
			],
		).toBeGreaterThan(0);
	});

	it("refuses a count from a decimal question and from any other kind", async () => {
		expect(
			codesAt(
				await readForm(
					counted("/data/n", {
						bind: '<bind nodeset="/data/n" type="xsd:double"/>',
						body: '<input ref="/data/n"/>',
					}),
				),
				"r",
			),
		).toEqual([Q("jr-count-naming-a-decimal-question")]);
		expect(
			codesAt(
				await readForm(
					counted("/data/n", {
						bind: '<bind nodeset="/data/n" type="xsd:string"/>',
						body: '<input ref="/data/n"/>',
					}),
				),
				"r",
			),
		).toEqual([
			Q("jr-count-naming-any-other-question-kind-text-barcode-multi"),
		]);
	});

	it("refuses add captions and drops the others where they hold text", async () => {
		const reading = await readForm(
			xformSource({
				data: `<r jr:template=""><q/></r>`,
				model: '<bind nodeset="/data/r/q" type="xsd:string"/>',
				body: '<group><repeat nodeset="/data/r"><jr:addCaption>Add</jr:addCaption><jr:delCaption>Remove</jr:delCaption><input ref="/data/r/q"/></repeat></group>',
			}),
		);
		expect(codesAt(reading, "r")).toEqual([
			Q("repeat-add-captions-jr-addcaption-jr-addemptycaption"),
		]);
	});
});

const REPEAT = testUuid("repeat");
const ASKED = testUuid("asked");

function queryDoc(
	options: {
		readonly query?: string;
		readonly nested?: boolean;
		readonly relevant?: string;
	} = {},
): BlueprintDoc {
	const repeat = f({
		uuid: REPEAT,
		kind: "repeat",
		id: "visits",
		repeat_mode: "query_bound",
		data_source: { ids_query: options.query ?? "'a b'" },
		...(options.relevant === undefined ? {} : { relevant: options.relevant }),
		children: [f({ kind: "text", id: "note" })],
	});
	return buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Rounds",
						type: "survey",
						fields: [
							f({ uuid: ASKED, kind: "text", id: "asked" }),
							options.nested === true
								? f({ kind: "repeat", id: "outer", children: [repeat] })
								: repeat,
						],
					},
				],
			},
		],
	});
}

describe("a model-iteration repeat Nova writes", () => {
	it("reads back as a query repeat held in model iteration, its query registered", async () => {
		const doc = queryDoc();
		const reading = await readForm(
			buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], { xmlns: XMLNS }),
		);
		const fields = readFields(reading.xform ?? ({} as never));
		const visits = fields.find((field) => field.id === "visits");
		expect(fields.map((field) => field.id)).toEqual([
			"asked",
			"visits",
			"note",
		]);
		expect(visits?.field).toMatchObject({
			repeat_mode: "query_bound",
			placement: "model-iteration",
		});
		expect(visits?.standIn).toBe(false);
		expect(visits?.expressions.map((one) => [one.slot, one.text])).toEqual([
			["ids_query", "'a b'"],
		]);
		expect(
			codesAt(reading, "visits").filter((code) => code !== "unrecognized"),
		).toEqual([]);
		expect(
			reading.closed.claims.counts[
				Q("repeat-model-iteration-vellum-role-repeat-ids-count-current")
			],
		).toBeGreaterThan(0);
	});

	it("leaves a wrapper missing a setvalue unclaimed", async () => {
		const doc = queryDoc();
		const source = buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], {
			xmlns: XMLNS,
		});
		const start = source.indexOf(
			'<setvalue event="xforms-ready" ref="/data/visits/@count"',
		);
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("/>", start) + 2;
		const reading = await readForm(source.slice(0, start) + source.slice(end));
		const visits = readFields(reading.xform ?? ({} as never)).find(
			(field) => field.id === "visits",
		);
		expect(visits?.standIn).toBe(true);
		expect(
			reading.closed.claims.counts[
				Q("repeat-model-iteration-vellum-role-repeat-ids-count-current")
			],
		).toBeUndefined();
		expect(codesAt(reading, "visits")).toContain("unrecognized");
	});
});

describe("modelIterationVerdict", () => {
	const verdict = (
		doc: BlueprintDoc,
		setAfterIds: (uuid: Uuid) => boolean = () => false,
	) => {
		const read = modelIterationVerdict(
			doc,
			doc.formOrder[doc.moduleOrder[0]][0],
			REPEAT,
			setAfterIds,
		);
		return read.kind === "held" ? "held" : read.claim.entry;
	};

	it("holds a repeat Nova's own rule runs in model iteration", () => {
		expect(verdict(queryDoc())).toBe("held");
	});

	it("refuses a nested one, and one whose query reads an answer certainly blank at load", () => {
		expect(verdict(queryDoc({ nested: true }))).toBe(
			Q("model-iteration-repeat-nested-in-another-repeat-of-any-kind"),
		);
		expect(verdict(queryDoc({ query: "#form/asked" }))).toBe(
			Q("model-iteration-repeat-whose-query-reads-a-form-answer-that-is"),
		);
	});

	it("names every other need outside Nova's rule", () => {
		expect(verdict(queryDoc({ relevant: "true()" }))).toBe(
			Q("model-iteration-repeat-outside-nova-s-model-iteration-rule"),
		);
	});
});
