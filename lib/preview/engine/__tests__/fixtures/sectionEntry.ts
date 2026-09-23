import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";

/** Later row insertion reads earlier answers; the outer count was captured
 * at form start. This same authored document is used by the browser, journey
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
