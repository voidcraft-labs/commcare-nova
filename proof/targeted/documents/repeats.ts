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
 * Fixed values: the hidden value says two rows, so the submission holds the
 * hidden value's node, the two rows and the meta block, four nodes in all;
 * the query names two pumps, so the relevant group holds two rows and the
 * other none.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";

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
