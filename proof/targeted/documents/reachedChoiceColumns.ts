/** HQ's non-calculated translatable column walks the case indices and displays
 * the reached property's text. Its translated mapping entries are held but
 * unused by that XPath. A separate calculation makes the active locale visible.
 */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	calculatedColumn,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	translationUnitsById,
} from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/expression/builders";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-reached-choice-columns";
const uuid = (name: string) => targetedUuid(ID, name);

export function reachedChoiceColumns() {
	const visit = uuid("visit");
	const direct = reachedColumn("parent-zone", "Parent area", ["parent"]);
	const chained = reachedColumn("host-parent-zone", "Host parent area", [
		"host",
		"parent",
	]);
	const proofWord = { uuid: uuid("locale-word"), label: "Hello" };
	const languageControl = {
		...calculatedColumn(
			uuid("locale-control"),
			"Greeting",
			concat(
				{ kind: "case-text", textUuid: proofWord.uuid },
				term(literal("!")),
			),
		),
		texts: [proofWord],
	};
	const doc = buildDoc({
		appId: ID,
		appName: "Related areas",
		caseTypes: [{ name: "member", properties: [] }],
		modules: [
			{
				uuid: uuid("members"),
				name: "Members",
				caseType: "member",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					direct,
					chained,
					languageControl,
				]),
				forms: [
					{
						uuid: visit,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	const units = translationUnitsById(doc);
	function translated(column: typeof languageControl, value: string) {
		const piece = column.texts[0];
		const id = makeTranslationUnitId(
			"column",
			column.uuid,
			"calculation-text",
			piece.uuid,
		);
		const unit = units.get(id);
		if (!unit) throw new Error("Missing calculation text translation unit");
		return [
			id,
			{
				value,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human" as const,
				review: "reviewed" as const,
				translatedFrom: "eng",
			},
		] as const;
	}
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: {
			fra: Object.fromEntries([
				translated(direct, "Un libellé inutilisé"),
				translated(chained, "Un autre libellé inutilisé"),
				translated(languageControl, "Bonjour"),
			]),
		},
	};
	return targetedDocument({
		id: ID,
		doc,
		rows: ["Case list translated calculation over a reached record"],
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: "areas-east",
						type: "household",
						name: "East house",
						properties: { area: "East bank" },
					},
					{
						id: "areas-west",
						type: "district",
						name: "West district",
						properties: { area: "West bank" },
					},
					{
						id: "areas-host",
						type: "visit_host",
						name: "Host",
						indices: [
							{
								identifier: "parent",
								caseId: "areas-west",
								caseType: "district",
							},
						],
					},
					{
						id: "areas-member",
						type: "member",
						name: "Ada",
						properties: { area: "Member value" },
						indices: [
							{
								identifier: "parent",
								caseId: "areas-east",
								caseType: "household",
							},
							{
								identifier: "host",
								caseId: "areas-host",
								caseType: "visit_host",
								relationship: "extension",
							},
						],
					},
					{
						id: "areas-unlinked",
						type: "member",
						name: "Bea",
						properties: { area: "Unlinked" },
					},
				],
			}),
		},
		expected: {
			intent: (["en", "fr"] as const).map((locale) => ({
				id: `reached-areas-${locale}`,
				export: "local",
				form: visit,
				restore: "restore.xml",
				request: { session: { command: "m0-f0" }, caseList: {}, locale },
				expect: [
					{ pointer: "/caseList/rows/0/caseId", value: "areas-member" },
					{ pointer: "/caseList/rows/0/fields/1", value: "East bank" },
					{ pointer: "/caseList/rows/0/fields/2", value: "West bank" },
					{
						pointer: "/caseList/rows/0/fields/3",
						value: locale === "en" ? "Hello!" : "Bonjour!",
					},
					{ pointer: "/caseList/rows/1/caseId", value: "areas-unlinked" },
					{ pointer: "/caseList/rows/1/fields/1", value: "" },
					{ pointer: "/caseList/rows/1/fields/2", value: "" },
				],
			})),
		},
	});
}

function reachedColumn(
	id: string,
	header: string,
	links: readonly [string, ...string[]],
) {
	const [first, ...rest] = links;
	return {
		...calculatedColumn(
			uuid(id),
			header,
			term({
				kind: "prop",
				caseType: "member",
				property: "area",
				via: {
					kind: "ancestor",
					via: [
						{ identifier: first },
						...rest.map((identifier) => ({ identifier })),
					],
				},
				readReached: true,
			}),
		),
		texts: [{ uuid: uuid(`${id}-unused`), label: "Unused translated label" }],
	};
}
