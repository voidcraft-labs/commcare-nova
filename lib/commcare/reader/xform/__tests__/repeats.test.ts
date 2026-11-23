/**
 * Repeats and where model iteration is held. Each row of the
 * repeat table is read from a source written for it; a model-iteration
 * repeat Nova's own emitter writes is read back as one, and one missing a
 * setvalue is not held. Over documents, the verdict holds model iteration
 * exactly where Nova's own rule runs it. It would catch a count repeat over a
 * Hidden Value read as anything but a count from that Hidden Value, a wrapper
 * missing a setvalue held, and a refused shape held.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { Finding } from "@/lib/publish/hqFindings";
import { buildXForm } from "../../../xform/builder";
import {
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readHqApp } from "../../index";
import { modelIterationVerdict } from "../repeats";
import {
	codesAt,
	formFindings,
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

/** The codes at the question at `path` of a form read through every stage, the bound
 *  document's own refusals among them. */
async function codesThroughEveryStage(
	source: string,
	path: string,
): Promise<string[]> {
	const body = {
		...retainedSourceBody("shell/app-source"),
		modules: [
			{
				doc_type: "Module",
				unique_id: "m-reader",
				name: { en: "Menu" },
				case_type: "",
				forms: [
					{
						doc_type: "Form",
						unique_id: "r1",
						xmlns: XMLNS,
						name: { en: "Form" },
					},
				],
			},
		],
		_attachments: { "r1.xml": source },
	};
	const input = readerInput(await sourceFromBody(body));
	const outcome = readHqApp({ ...input, recordDialect: () => undefined });
	const findings: readonly Finding[] =
		outcome.kind === "account" ? outcome.findings : [];
	return findings
		.filter(
			(finding) =>
				finding.place.kind === "question" && finding.place.path === path,
		)
		.map((finding) => finding.code);
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

	it("refuses a count that is no path, and one that names no node of the form's data", async () => {
		expect(codesAt(await readForm(counted("/data/n + 1")), "r")).toEqual([
			Q("jr-count-that-is-not-a-path-such-as-data-n-1"),
		]);
		expect(codesAt(await readForm(counted("/data/nothing")), "r")).toEqual([
			Q("jr-count-naming-a-node-in-a-secondary-instance-or-no-node"),
		]);
		expect(
			codesAt(
				await readForm(counted("instance('casedb')/casedb/case/@count")),
				"r",
			),
		).toEqual([Q("jr-count-naming-a-node-in-a-secondary-instance-or-no-node")]);
	});

	it("reads the count node Nova generates as the count, its calculate the repeat's count", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Menu",
					forms: [
						{
							name: "Form",
							type: "survey",
							fields: [
								f({ kind: "int", id: "n" }),
								f({
									kind: "repeat",
									id: "rows",
									repeat_mode: "count_bound",
									repeat_count: "#form/n + 1",
									children: [f({ kind: "text", id: "answer" })],
								} as FieldSpec),
							],
						},
					],
				},
			],
		});
		const reading = await readForm(
			buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], { xmlns: XMLNS }),
		);
		const fields = readFields(reading.xform ?? ({} as never));
		expect(fields.map((field) => field.id)).toEqual(["n", "rows", "answer"]);
		const rows = fields[1];
		expect(rows?.field.repeat_mode).toBe("count_bound");
		expect(
			rows?.expressions.map((one) => [one.slot, one.text, one.key]),
		).toEqual([["repeat_count", "/data/n + 1", "xform:model/bind@calculate"]]);
		// The count waits for the expression stage, which claims it.
		expect(
			codesAt(reading, "rows").filter((code) => code !== "unrecognized"),
		).toEqual([]);
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
		// An authored Hidden Value stays the person's field, and the count is a read of it,
		// registered from the repeat's own `jr:count`, never the Hidden Value's calculate.
		const hiddenFields = readFields(hidden.xform ?? ({} as never));
		expect(
			hiddenFields.map((field) => [field.id, field.kind, field.standIn]),
		).toEqual([
			["n", "hidden", false],
			["r", "repeat", false],
			["q", "text", false],
		]);
		expect(
			hiddenFields[1]?.expressions.map((one) => [one.slot, one.text, one.key]),
		).toEqual([["repeat_count", "/data/n", "xform:repeat@jr:count"]]);
		expect(codesAt(hidden, "r")).toEqual(["unrecognized"]);
		expect(
			hidden.closed.claims.counts[
				Q("jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in")
			],
		).toBeGreaterThan(0);

		const select = await readForm(
			counted("/data/n", {
				bind: '<bind nodeset="/data/n" type="xsd:string"/>',
				body: '<select1 ref="/data/n"><item><label>One</label><value>1</value></item><item><label>Two</label><value>2</value></item></select1>',
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

	it("refuses, over the bound document, a Hidden Value count that is no whole number", async () => {
		expect(
			await codesThroughEveryStage(
				counted("/data/n", {
					bind: '<bind nodeset="/data/n" calculate="1.5"/>',
					body: "",
				}),
				"r",
			),
		).toEqual([
			Q("jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer"),
		]);
	});

	it("refuses, over the bound document, a single select count with a choice that is no whole number", async () => {
		expect(
			await codesThroughEveryStage(
				counted("/data/n", {
					bind: '<bind nodeset="/data/n" type="xsd:string"/>',
					body: '<select1 ref="/data/n"><item><label>One</label><value>1</value></item><item><label>Some</label><value>some</value></item></select1>',
				}),
				"r",
			),
		).toEqual([
			Q("jr-count-naming-any-other-question-kind-text-barcode-multi"),
		]);
	});

	it("refuses, over the bound document, a count that reads the rows it creates", async () => {
		expect(
			await codesThroughEveryStage(
				counted("/data/n", {
					bind: '<bind nodeset="/data/n" calculate="count(/data/r) + 1"/>',
					body: "",
				}),
				"r",
			),
		).toEqual([
			Q("a-count-that-depends-on-the-rows-it-creates-through-calculations"),
		]);
	});

	it("reads the add caption and drops a deletion caption where both hold text", async () => {
		const reading = await readForm(
			xformSource({
				data: `<r jr:template=""><q/></r>`,
				model: '<bind nodeset="/data/r/q" type="xsd:string"/>',
				body: '<group><repeat nodeset="/data/r"><jr:addCaption>Add</jr:addCaption><jr:delCaption>Remove</jr:delCaption><input ref="/data/r/q"/></repeat></group>',
			}),
		);
		expect(codesAt(reading, "r")).toEqual([]);
		expect(
			readFields(reading.xform ?? ({} as never)).find(
				(field) => field.id === "r",
			)?.field,
		).toMatchObject({ addLabel: { parts: [{ kind: "text", text: "Add" }] } });
	});
});

const REPEAT = testUuid("repeat");
const ASKED = testUuid("asked");

function queryDoc(
	options: {
		readonly query?: string;
		readonly nested?: boolean;
		readonly outerCount?: string;
		readonly relevant?: string;
		/** When the query runs, where the author chose. */
		readonly rowTiming?: "on-open" | "as-answers-change";
		/** A display condition on a group around the repeat. */
		readonly groupRelevant?: string;
		/** The asked question's default. */
		readonly askedDefault?: string;
	} = {},
): BlueprintDoc {
	const query = f({
		uuid: REPEAT,
		kind: "repeat",
		id: "visits",
		repeat_mode: "query_bound",
		data_source: { ids_query: options.query ?? "'a b'" },
		...(options.relevant === undefined ? {} : { relevant: options.relevant }),
		...(options.rowTiming === undefined
			? {}
			: { rowTiming: options.rowTiming }),
		children: [f({ kind: "text", id: "note" })],
	});
	const repeat =
		options.groupRelevant === undefined
			? query
			: f({
					kind: "group",
					id: "around",
					relevant: options.groupRelevant,
					children: [query],
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
							f({
								uuid: ASKED,
								kind: "text",
								id: "asked",
								...(options.askedDefault === undefined
									? {}
									: { default_value: options.askedDefault }),
							}),
							options.nested === true
								? f({
										kind: "repeat",
										id: "outer",
										...(options.outerCount === undefined
											? {}
											: {
													repeat_mode: "count_bound",
													repeat_count: options.outerCount,
												}),
										children: [repeat],
									})
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

	it("reads a row condition back from the row's bind, where the export writes it", async () => {
		const doc = queryDoc({
			relevant: "#form/asked = 'yes'",
			rowTiming: "on-open",
		});
		const source = buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], {
			xmlns: XMLNS,
		});
		expect(source).toContain('nodeset="/data/visits/item" relevant=');
		const reading = await readForm(source);
		const visits = readFields(reading.xform ?? ({} as never)).find(
			(field) => field.id === "visits",
		);
		expect(visits?.field).toMatchObject({
			repeat_mode: "query_bound",
			placement: "model-iteration",
		});
		expect(visits?.expressions.map((one) => [one.slot, one.text])).toEqual([
			["ids_query", "'a b'"],
			["relevant", "/data/asked = 'yes'"],
		]);
		// The query's own text is claimed once the form's expressions bind,
		// past this stage, as for the repeat with no condition above.
		expect(unrecognizedAt(reading, "visits")).toEqual(["xform:setvalue@value"]);
		expect(
			codesAt(reading, "visits").filter((code) => code !== "unrecognized"),
		).toEqual([]);
	});

	it("refuses a condition on the container's own bind, which the form builder discards", async () => {
		const doc = queryDoc({ rowTiming: "on-open" });
		const source = buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], {
			xmlns: XMLNS,
		});
		expect(source).toContain("<bind ");
		// The condition stands on the container, where the publish could not
		// keep it: it would move to the rows and keep `@ids` in the submission.
		const reading = await readForm(
			source.replace(
				"<bind ",
				`<bind nodeset="/data/visits" relevant="/data/asked = 'yes'"/><bind `,
			),
		);
		expect(codesAt(reading, "visits")).toContain(
			Q("relevance-bound-on-a-model-iteration-repeat-s-container"),
		);
		const visits = readFields(reading.xform ?? ({} as never)).find(
			(field) => field.id === "visits",
		);
		expect(visits?.expressions.map((one) => one.slot)).not.toContain(
			"relevant",
		);
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

describe("a count-placement query repeat Nova writes", () => {
	it("reads back as a query repeat in the count placement, at its wrapper, its query registered", async () => {
		const doc = queryDoc({ nested: true });
		const reading = await readForm(
			buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], { xmlns: XMLNS }),
		);
		const fields = readFields(reading.xform ?? ({} as never));
		expect(fields.map((field) => field.id)).toEqual([
			"asked",
			"outer",
			"visits",
			"note",
		]);
		const visits = fields.find((field) => field.id === "visits");
		expect(visits?.field).toMatchObject({
			repeat_mode: "query_bound",
			placement: "count",
		});
		expect(visits?.standIn).toBe(false);
		// The query is the slot's; each generated node's calculate is the emitter's own, read for
		// the uses its syntax makes alone.
		expect(
			visits?.expressions
				.filter((one) => one.usesOnly !== true)
				.map((one) => [one.slot, one.text]),
		).toEqual([["ids_query", "'a b'"]]);
		expect(
			visits?.expressions
				.filter((one) => one.usesOnly === true)
				.map((one) => one.at),
		).toEqual(
			visits?.expressions
				.filter((one) => one.usesOnly === true)
				.map((one) => one.at)
				.filter((at) => "element" in at && at.attribute === "calculate"),
		);
		// The row is no field: the repeat's children are the row's.
		expect(fields.find((field) => field.id === "item")).toBeUndefined();
		expect(
			codesAt(reading, "outer/visits").filter(
				(code) => code !== "unrecognized",
			),
		).toEqual([]);
		expect(
			reading.closed.claims.counts[
				Q("count-repeat-whose-count-and-row-ids-come-from-one-query-a")
			],
		).toBeGreaterThan(0);
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
		expect(verdict(queryDoc({ nested: true, outerCount: "1" }))).toBe("held");
		expect(verdict(queryDoc({ nested: true, outerCount: "2" }))).toBe(
			Q("model-iteration-repeat-nested-in-another-repeat-of-any-kind"),
		);
		expect(verdict(queryDoc({ nested: true, query: "''" }))).toBe("held");
		expect(verdict(queryDoc({ query: "#form/asked" }))).toBe(
			Q("model-iteration-repeat-whose-query-reads-a-form-answer-that-is"),
		);
	});

	it("refuses one whose query reads a question whose default is set after the row ids", () => {
		const doc = queryDoc({ query: "#form/asked", askedDefault: "'x'" });
		expect(verdict(doc, (uuid) => uuid === ASKED)).toBe(
			Q("model-iteration-repeat-whose-query-reads-a-form-answer-that-is"),
		);
		// An earlier assignment is available to the snapshot.
		expect(verdict(doc)).toBe("held");
	});

	it("captures while a condition is initially relevant and detects an earlier answer that suppressed its count", () => {
		expect(verdict(queryDoc({ groupRelevant: "#form/asked = 'yes'" }))).toBe(
			"held",
		);
		expect(
			verdict(
				queryDoc({
					askedDefault: "'no'",
					groupRelevant: "#form/asked = 'yes'",
				}),
			),
		).toBe(Q("model-iteration-repeat-under-an-ancestor-that-core-s-load-can"));
	});

	it("keeps an explicit condition and a query with a fallback for blank input", () => {
		expect(verdict(queryDoc({ relevant: "true()" }))).toBe("held");
		expect(
			verdict(queryDoc({ query: "if(#form/asked = '', 'a b', #form/asked)" })),
		).toBe("held");
	});
});

describe("a query repeat's wrapper holding a node the emitter never writes there", () => {
	/** Nova's export of the form, with `total` added to the query repeat's wrapper as HQ's form
	 *  builder adds a Hidden Value to the group it shows there. */
	function withTotal(doc: BlueprintDoc, wrapperPath: string): string {
		const source = buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], {
			xmlns: XMLNS,
		});
		expect(source.split("</visits>")).toHaveLength(2);
		return source
			.replace("</visits>", "<total/></visits>")
			.replace(
				"</model>",
				`<bind nodeset="${wrapperPath}/total" calculate="count(${wrapperPath}/item)"/></model>`,
			);
	}

	it("is no count placement: the node stays outside every row, and the row's id reads as a hidden value keeping both its values", async () => {
		const source = withTotal(queryDoc({ nested: true }), "/data/outer/visits");
		const reading = await readForm(source);
		const fields = readFields(reading.xform ?? ({} as never));
		const visits = fields.find((field) => field.id === "visits");
		const total = fields.find((field) => field.id === "total");
		expect(visits?.kind).toBe("group");
		expect(total?.parent).toBe(visits);
		expect(
			reading.closed.claims.counts[
				Q("count-repeat-whose-count-and-row-ids-come-from-one-query-a")
			],
		).toBeUndefined();
		// The row's id holds the query's starting value beside its calculation,
		// which a Hidden Value now keeps whole, so nothing refuses the form.
		const rowId = fields.find((field) => field.id === "nova_query_id_visits");
		expect(rowId?.kind).toBe("hidden");
		expect(rowId?.expressions.map((expression) => expression.slot)).toEqual(
			expect.arrayContaining(["default_value", "calculate"]),
		);
		expect(
			await codesThroughEveryStage(
				source,
				"outer/visits/item/nova_query_id_visits",
			),
		).toEqual([]);
	});

	it("is no model iteration: the wrapper is left unclaimed", async () => {
		const reading = await readForm(withTotal(queryDoc(), "/data/visits"));
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

describe("a group holding a repeat beside another control", () => {
	const BARE = Q("bare-repeat-with-no-group-wrapper");
	const source = (beside: string, groupRef = "") =>
		xformSource({
			data: `<member jr:template=""><name/></member><notes/>`,
			model:
				'<bind nodeset="/data/member/name" type="xsd:string"/><bind nodeset="/data/notes" type="xsd:string"/>',
			body: `<group${groupRef}><label>Household</label><repeat nodeset="/data/member"><input ref="/data/member/name"/></repeat>${beside}</group>`,
		});

	it("is no repeat's wrapper, as Core collapses only a group whose one child is the repeat", async () => {
		for (const beside of [
			'<input ref="/data/notes"/>',
			// A control the body refuses is still a child of the group in Core.
			'<input ref="/data/notes" readonly="true()"/>',
		]) {
			const reading = await readForm(source(beside));
			const fields = readFields(reading.xform ?? ({} as never));
			expect(fields.some((field) => field.kind === "repeat")).toBe(false);
			expect(formFindings(reading).map((finding) => finding.code)).toContain(
				BARE,
			);
		}
	});

	it("is no wrapper with a `ref` either: the group stays a group", async () => {
		const reading = await readForm(
			xformSource({
				data: `<g><member jr:template=""><name/></member><notes/></g>`,
				model:
					'<bind nodeset="/data/g/member/name" type="xsd:string"/><bind nodeset="/data/g/notes" type="xsd:string"/>',
				body: '<group ref="/data/g"><label>Household</label><repeat nodeset="/data/g/member"><input ref="/data/g/member/name"/></repeat><input ref="/data/g/notes"/></group>',
			}),
		);
		const fields = readFields(reading.xform ?? ({} as never));
		expect(fields.find((field) => field.id === "g")?.kind).toBe("group");
		expect(fields.find((field) => field.id === "notes")?.parent?.id).toBe("g");
		expect(fields.some((field) => field.kind === "repeat")).toBe(false);
		expect(formFindings(reading).map((finding) => finding.code)).toContain(
			BARE,
		);
	});

	it("leaves a group whose one control is the repeat its wrapper, whatever its label", async () => {
		const reading = await readForm(source(""));
		const fields = readFields(reading.xform ?? ({} as never));
		expect(fields.map((field) => [field.id, field.kind])).toEqual([
			["member", "repeat"],
			["name", "text"],
			["notes", "hidden"],
		]);
		expect(formFindings(reading).map((finding) => finding.code)).not.toContain(
			BARE,
		);
	});
});
