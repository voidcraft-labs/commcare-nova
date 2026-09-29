import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { actingUser, formField, term } from "@/lib/domain/predicate";

/** Later row insertion reads earlier answers; the outer count is constant. This same authored document is used by the browser, journey
 * and independent Core consumer. */
export function sectionEntryDoc() {
	return buildDoc({
		appName: "Asset inspection",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Inspect",
						type: "survey",
						fields: [
							f({
								kind: "section",
								id: "first",
								label: proseText("Choose area"),
								children: [
									f({
										kind: "text",
										id: "zone",
										label: proseText("Area"),
										required: "true()",
										default_value: "'north'",
									}),
								],
							}),
							f({
								kind: "section",
								id: "second",
								label: proseText("Inspect assets"),
								children: [
									f({
										kind: "repeat",
										id: "rounds",
										repeat_mode: "count_bound",
										repeat_count: "1",
										children: [
											f({
												kind: "repeat",
												id: "assets",
												repeat_mode: "query_bound",
												data_source: {
													ids_query:
														"if(#form/first/zone = 'north', 'pump tap', 'tank')",
												},
												children: [
													f({
														kind: "text",
														id: "note",
														label: proseText("Asset note"),
														default_value: "current()/../@id",
														required: "true()",
													}),
												],
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
}

/** #692: the count is blank when the form opens, answered on an earlier page. */
export function liveCountEntryDoc(withCaseEffects = false) {
	const doc = buildDoc({
		appName: "Live counts",
		caseTypes: withCaseEffects
			? [{ name: "activity", properties: [] }]
			: undefined,
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Counted visit",
						type: "survey",
						fields: [
							f({
								kind: "section",
								id: "first",
								label: proseText("Choose count"),
								children: [
									f({
										kind: "int",
										id: "size",
										label: proseText("Number of activities"),
									}),
								],
							}),
							f({
								kind: "section",
								id: "second",
								label: proseText("Activities"),
								children: [
									f({
										kind: "repeat",
										id: "items",
										label: proseText("Activity"),
										repeat_mode: "count_bound",
										repeat_count: "#form/first/size",
										children: [
											f({
												kind: "text",
												id: "answer",
												label: proseText("Activity note"),
											}),
											f({
												kind: "int",
												id: "size",
												label: proseText("Number of checks"),
											}),
											f({
												kind: "repeat",
												id: "direct",
												label: proseText("Direct checks"),
												repeat_mode: "count_bound",
												repeat_count: "#form/second/items/size",
												children: [
													f({
														kind: "text",
														id: "note",
														label: proseText("Direct note"),
													}),
												],
											}),
											f({
												kind: "repeat",
												id: "computed",
												label: proseText("Computed checks"),
												repeat_mode: "count_bound",
												repeat_count: "#form/second/items/size + 0.7",
												children: [
													f({
														kind: "text",
														id: "note",
														label: proseText("Computed note"),
													}),
												],
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	if (!withCaseEffects) return doc;
	const form = doc.forms[doc.formOrder[doc.moduleOrder[0]][0]];
	const repeat = Object.values(doc.fields).find(
		(field) => field.id === "items",
	);
	const answer = Object.values(doc.fields).find(
		(field) => field.id === "answer",
	);
	if (!repeat || !answer) throw new Error("Missing live-count fields");
	form.caseOperations = [
		{
			uuid: testUuid("live-count-create"),
			id: "create_activity",
			action: "create",
			caseType: "activity",
			target: { kind: "new" },
			name: term(formField(answer.uuid)),
			owner: actingUser(),
			forEach: { repeat: repeat.uuid },
		},
	];
	return doc;
}
