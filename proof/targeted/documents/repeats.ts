/**
 * Repeats whose rows the document fixes, read back from Core.
 *
 * - `targeted-repeat-count-copy` (defect 30): a repeat counted by a hidden
 *   value. Nova writes every count other than an integer question into a
 *   `nova_count_<repeat>` node of its own with an `xsd:int` calculate
 *   (`lib/commcare/xform/builder.ts`,
 *   `lib/domain/repeatCount.ts::directRepeatCountReference`), so the
 *   submission holds a node the document does not. The row's other input, a
 *   count that is a fractional expression, is not here: such a count states
 *   no number of rows (Core refuses a count it cannot read as an integer,
 *   `javarosa form/api/FormEntryModel.createModelForGroup`, "must be a
 *   number"; Nova's `xsd:int` node truncates it,
 *   `core/model/condition/Recalculate.wrapData`), so there is no value to fix
 *   by hand, and a count that is an expression needs a node to hold it
 *   (`jr:count` names one, `core/model/GroupDef.getCountReference`), so it has
 *   no copy to show.
 * - `targeted-query-repeat-places` (defect 25, its two places no other
 *   document shows): a query repeat under a group that becomes relevant once
 *   the form is filled in, and one under a group that is never relevant.
 *   Nova runs a query repeat through a live count; a Vellum save rewrites it
 *   into model iteration, whose rows are taken when the form loads; the
 *   research says the first then stays empty and the second gets rows. For
 *   a query that reads no form answer neither reaches the submission: the
 *   first gets its rows, since Core runs a load-time `setvalue` whatever its
 *   target's relevance, and a group that is never relevant submits none
 *   (the harness's findings, correction 7). The document shows the rewrite.
 *
 * - `targeted-query-repeat-placements` (defect 25's fix, each placement): a
 *   survey whose query repeat `visits`, over `'a b'` at the root, runs as
 *   model iteration (its rows taken when the form opens); `readings`, whose
 *   query reads the answer `site`, and `children`, in the user repeat
 *   `households` with a query reading the household's own answer, run in the
 *   count placement, their rows following the query; and `stock`, in the
 *   count placement too, whose query finds fewer records once `site` is
 *   answered, with a case created for each of its rows.
 * - `targeted-repeat-count-whole` (defect 30's fix): repeats counted by an
 *   integer question, an integer single select (`1`, `2`, `3`) and a Hidden
 *   Value calculating `2`, each named by `jr:count` directly, and one counted
 *   by `int(#form/weight div 2)`, which keeps its `nova_count_<repeat>`
 *   node, since a count that is an expression needs a node to hold it.
 *
 * Fixed values: the hidden value says two rows, so the submission holds the
 * hidden value's node, the two rows and the meta block, four nodes in all;
 * the query names two pumps, so the relevant group holds two rows and the
 * other none. The placements' rows: `visits` holds `a` and `b`; with `site`
 * answered `north`, `readings` holds `r1` and `r2`, which model iteration
 * would not (its query ran when the form opened, with `site` blank, and
 * found `r3`); the first household, answered `c1 c2`, holds two children and
 * the second, answered `c3`, one. `stock` holds three rows while `site` is
 * blank; answered `south`, its query finds `k1` alone, so its first row
 * keeps its record and its answer, and its third row keeps its place but is
 * no longer relevant, so its answer reads blank and neither it nor the case
 * created for it is submitted. The whole counts: 2 for the integer
 * question answered 2, the select's second choice and the Hidden Value, and
 * 2 for a weight of 5, whose half is 2.5; the submission holds the four
 * counting answers, the eight rows, the carrier of the one expression count
 * and the meta block, fourteen nodes in all.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type CaseOperation, NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";

export function repeatCountCopy() {
	const id = "targeted-repeat-count-copy";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Counted rows",
		modules: [
			{
				uuid: uuid("module"),
				name: "Rows",
				forms: [
					{
						uuid: form,
						name: "Counted rows",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								uuid: uuid("planned"),
								id: "planned",
								calculate: "2",
							}),
							f({
								kind: "repeat",
								uuid: uuid("visits"),
								id: "visits",
								label: proseText("Visits"),
								repeat_mode: "count_bound",
								repeat_count: "#form/planned",
								children: [
									f({
										kind: "text",
										uuid: uuid("visit"),
										id: "visit",
										label: proseText("Visit"),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const expectation = (exportName: "local" | "A") => ({
		id: `submission-nodes-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form,
		request: {
			expressions: ["count(/data/*)", "count(/data/visits)"],
		},
		expect: [
			{ pointer: "/values/0/value", value: "4" },
			{ pointer: "/values/1/value", value: "2" },
		],
	});
	return targetedDocument({
		id,
		rows: ["30 (a repeat counted by a hidden value)"],
		doc,
		expected: { intent: [expectation("local"), expectation("A")] },
	});
}

export function queryRepeatPlaces() {
	const id = "targeted-query-repeat-places";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const pumps = (name: string) =>
		f({
			kind: "repeat",
			uuid: uuid(name),
			id: name,
			label: proseText("Pumps"),
			repeat_mode: "query_bound",
			data_source: { ids_query: "'pump tap'" },
			children: [
				f({
					kind: "text",
					uuid: uuid(`${name}-reading`),
					id: "reading",
					label: proseText("Reading"),
				}),
			],
		});
	const doc = buildDoc({
		appId: id,
		appName: "Pump readings",
		modules: [
			{
				uuid: uuid("module"),
				name: "Pumps",
				forms: [
					{
						uuid: form,
						name: "Readings",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								uuid: uuid("visited"),
								id: "visited",
								label: proseText("Visited the pumps?"),
								options: [
									{ value: "yes", label: "Yes" },
									{ value: "no", label: "No" },
								],
							}),
							f({
								kind: "group",
								uuid: uuid("later"),
								id: "later",
								label: proseText("Readings"),
								relevant: "#form/visited = 'yes'",
								children: [pumps("measured")],
							}),
							f({
								kind: "group",
								uuid: uuid("never"),
								id: "never",
								label: proseText("Missed readings"),
								relevant: "#form/visited = 'no'",
								children: [pumps("missed")],
							}),
						],
					},
				],
			},
		],
	});
	const expectation = (exportName: "local" | "A") => ({
		id: `pump-rows-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form,
		request: {
			// A select is answered by its option's position (Yes is the first).
			answers: [{ path: "/data/visited", value: "1" }],
			expressions: [
				"count(/data/later/measured/item)",
				"count(/data/never/missed/item)",
			],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value: "2" },
			{ pointer: "/values/1/value", value: "0" },
		],
	});
	return targetedDocument({
		id,
		rows: ["25 (a group relevant later, a false condition)"],
		doc,
		expected: { intent: [expectation("local"), expectation("A")] },
	});
}

export function queryRepeatPlacements() {
	const id = "targeted-query-repeat-placements";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const stock = uuid("stock");
	const stockId = uuid("stock-id");
	/** A query repeat over `query` whose row holds its record id in `rowId`. */
	const queryRepeat = (
		name: string,
		query: string,
		rowId: string,
		extra: ReturnType<typeof f>[] = [],
	) =>
		f({
			kind: "repeat",
			uuid: uuid(name),
			id: name,
			label: proseText(name),
			repeat_mode: "query_bound",
			data_source: { ids_query: query },
			children: [
				...extra,
				f({
					kind: "hidden",
					uuid: uuid(`${name}-id`),
					id: rowId,
					calculate: "../@id",
				}),
			],
		});
	const checks: CaseOperation[] = [
		{
			// A case for each row of `stock`, inside the row.
			uuid: uuid("check-stock"),
			id: "check_stock",
			action: "create",
			caseType: "stock_check",
			target: { kind: "new" },
			forEach: { repeat: stock },
			name: term(formField(stockId)),
		},
	];
	const doc = buildDoc(
		{
			appId: id,
			appName: "Placements",
			// Declared for Web Apps and Android, as a new app is.
			appSettings: { ...NEW_APP_SETTINGS },
			caseTypes: [
				{
					name: "stock_check",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: uuid("module"),
					name: "Rounds",
					forms: [
						{
							uuid: form,
							name: "Round",
							type: "survey",
							fields: [
								// Reads no answer, at the root: model iteration.
								queryRepeat("visits", "'a b'", "visit_id"),
								// Reads `site`, answered after its rows are made.
								queryRepeat(
									"stock",
									"if(#form/site = 'south', 'k1', 'k1 k2 k3')",
									"stock_id",
									[
										f({
											kind: "text",
											uuid: uuid("level"),
											id: "level",
											label: proseText("Level"),
										}),
									],
								),
								f({
									kind: "text",
									uuid: uuid("site"),
									id: "site",
									label: proseText("Site"),
								}),
								// Reads `site`: its rows follow the answer.
								queryRepeat(
									"readings",
									"if(#form/site = 'north', 'r1 r2', 'r3')",
									"reading_id",
								),
								f({
									kind: "repeat",
									uuid: uuid("households"),
									id: "households",
									label: proseText("Households"),
									children: [
										f({
											kind: "text",
											uuid: uuid("child-ids"),
											id: "child_ids",
											label: proseText("Children"),
										}),
										// Inside a repeat, reading the household's answer.
										queryRepeat(
											"children",
											"#form/households/child_ids",
											"child_id",
										),
									],
								}),
							],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[form].caseOperations = checks;
		},
	);
	const exportId = (exportName: "local" | "A") =>
		exportName === "local" ? "local" : "a";
	const followed = (exportName: "local" | "A"): Expectation => ({
		id: `placement-rows-${exportId(exportName)}`,
		export: exportName,
		form,
		request: {
			repeats: { "/data/households": 2 },
			answers: [
				{ path: "/data/stock/item/level", value: "5" },
				{ path: "/data/site", value: "north" },
				{ path: "/data/households[1]/child_ids[1]", value: "c1 c2" },
				{ path: "/data/households[2]/child_ids[1]", value: "c3" },
			],
			expressions: [
				"count(/data/visits/item)",
				"/data/visits/item[1]/visit_id",
				"/data/visits/item[2]/visit_id",
				"count(/data/readings/item)",
				"/data/readings/item[1]/reading_id",
				"/data/readings/item[2]/reading_id",
				"count(/data/households[1]/children/item)",
				"/data/households[1]/children/item[1]/child_id",
				"/data/households[1]/children/item[2]/child_id",
				"count(/data/households[2]/children/item)",
				"/data/households[2]/children/item[1]/child_id",
			],
		},
		expect: [
			// Three stock levels, the site and two households' children.
			...[0, 1, 2, 3, 4, 5].map((index) => ({
				pointer: `/answers/${index}/result`,
				value: "ok",
			})),
			...["2", "a", "b", "2", "r1", "r2", "2", "c1", "c2", "1", "c3"].map(
				(value, index) => ({ pointer: `/values/${index}/value`, value }),
			),
		],
	});
	const shrunk = (exportName: "local" | "A"): Expectation => ({
		id: `shrunk-rows-${exportId(exportName)}`,
		export: exportName,
		form,
		request: {
			answers: [
				{ path: "/data/stock/item/level", value: "5" },
				{ path: "/data/site", value: "south" },
			],
			expressions: [
				"count(/data/stock/item)",
				"/data/stock/item[1]/stock_id",
				"/data/stock/item[1]/level",
				"/data/stock/item[3]/level",
				"count(/data/readings/item)",
				"/data/readings/item[1]/reading_id",
			],
		},
		expect: [
			// Three stock levels, then the site.
			...[0, 1, 2, 3].map((index) => ({
				pointer: `/answers/${index}/result`,
				value: "ok",
			})),
			// The third row keeps its place and is no longer relevant, so its
			// answer reads blank and is not submitted.
			...["3", "k1", "5", "", "1", "r3"].map((value, index) => ({
				pointer: `/values/${index}/value`,
				value,
			})),
		],
	});
	return targetedDocument({
		id,
		rows: ["25 (each query repeat placement)"],
		doc,
		expected: {
			intent: [followed("local"), followed("A"), shrunk("local"), shrunk("A")],
		},
	});
}

export function repeatCountWhole() {
	const id = "targeted-repeat-count-whole";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const counted = (name: string, count: string) =>
		f({
			kind: "repeat",
			uuid: uuid(name),
			id: name,
			label: proseText(name),
			repeat_mode: "count_bound",
			repeat_count: count,
			children: [
				f({
					kind: "text",
					uuid: uuid(`${name}-note`),
					id: "note",
					label: proseText("Note"),
				}),
			],
		});
	const doc = buildDoc({
		appId: id,
		appName: "Whole counts",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: uuid("module"),
				name: "Counts",
				forms: [
					{
						uuid: form,
						name: "Counts",
						type: "survey",
						fields: [
							f({
								kind: "int",
								uuid: uuid("number"),
								id: "number",
								label: proseText("Number"),
							}),
							counted("by_number", "#form/number"),
							f({
								kind: "single_select",
								uuid: uuid("choice"),
								id: "choice",
								label: proseText("Choice"),
								options: ["1", "2", "3"].map((value) => ({
									uuid: uuid(`choice-${value}`),
									value,
									label: value,
								})),
							}),
							counted("by_choice", "#form/choice"),
							f({
								kind: "hidden",
								uuid: uuid("planned"),
								id: "planned",
								calculate: "2",
							}),
							counted("by_planned", "#form/planned"),
							f({
								kind: "decimal",
								uuid: uuid("weight"),
								id: "weight",
								label: proseText("Weight"),
							}),
							counted("by_weight", "int(#form/weight div 2)"),
						],
					},
				],
			},
		],
	});
	const expectation = (exportName: "local" | "A"): Expectation => ({
		id: `whole-counts-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form,
		request: {
			// A select is answered by its option's position (`2` is the second).
			answers: [
				{ path: "/data/number", value: "2" },
				{ path: "/data/choice", value: "2" },
				{ path: "/data/weight", value: "5" },
			],
			expressions: [
				"count(/data/by_number)",
				"count(/data/by_choice)",
				"count(/data/by_planned)",
				"count(/data/by_weight)",
				"count(/data/*)",
			],
		},
		expect: [
			...[0, 1, 2].map((index) => ({
				pointer: `/answers/${index}/result`,
				value: "ok",
			})),
			...["2", "2", "2", "2", "14"].map((value, index) => ({
				pointer: `/values/${index}/value`,
				value,
			})),
		],
	});
	return targetedDocument({
		id,
		rows: ["30 (a whole-number count, direct or carried)"],
		doc,
		expected: { intent: [expectation("local"), expectation("A")] },
	});
}
