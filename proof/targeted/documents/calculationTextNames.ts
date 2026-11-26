import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { calculatedColumn, tileCell } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-calculation-text-names";
const uuid = (name: string) => targetedUuid(ID, name);
const LAYOUTS = ["list", "tile"] as const;
const CASE_ID = "targeted-visit";

function collidingText(word: string): string {
	const usualKey = `case_text_${word.replaceAll("-", "")}`;
	return `${usualKey} v${usualKey} v00000002_${usualKey}`;
}

export function calculationTextNames() {
	const doc = buildDoc({
		appId: ID,
		appName: "Visit summaries",
		caseTypes: [{ name: "visit", properties: [] }],
		modules: LAYOUTS.map((layout) => {
			const word = uuid(`${layout}-word`);
			const column = calculatedColumn(
				uuid(`${layout}-summary`),
				"Summary",
				{
					kind: "concat",
					parts: [
						{ kind: "case-text", textUuid: word },
						term(literal(collidingText(word))),
					],
				},
				layout === "tile" ? { tile: tileCell(0, 0, 12, 1) } : {},
			);
			return {
				uuid: uuid(layout),
				name: layout === "tile" ? "Visit tiles" : "Visit list",
				caseType: "visit",
				caseListConfig: caseListOf(
					[{ ...column, texts: [{ uuid: word, label: "Village" }] }],
					layout === "tile" ? { tile: {} } : {},
				),
				forms: [
					{
						uuid: uuid(`${layout}-followup`),
						name: "Visit",
						type: "followup",
						fields: [
							f({ uuid: uuid(`${layout}-notes`), id: "notes", kind: "text" }),
						],
					},
				],
			};
		}),
	});
	return targetedDocument({
		id: ID,
		rows: ["Calculated translation names preserve colliding XPath literals"],
		doc,
		expected: {
			intent: LAYOUTS.map((layout, index) => ({
				id: `${layout}-summary-label`,
				export: "local",
				form: uuid(`${layout}-followup`),
				restore: "restore.xml",
				request: { session: { command: `m${index}-f0` }, caseList: {} },
				expect: [
					{ pointer: "/caseList/rows/0/caseId", value: CASE_ID },
					{
						pointer: "/caseList/rows/0/fields/0",
						value: `Village${collidingText(uuid(`${layout}-word`))}`,
					},
				],
			})),
		},
		files: {
			"restore.xml": restoreXml({
				cases: [{ id: CASE_ID, type: "visit", name: "Riverside" }],
			}),
		},
	});
}
