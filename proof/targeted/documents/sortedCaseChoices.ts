import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	and,
	eq,
	formField,
	literal,
	lt,
	matchAll,
	prop,
} from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const id = "targeted-sorted-case-choices";
const uuid = (name: string) => targetedUuid(id, name);
const regionMatches = eq(prop("clinic", "region"), formField(uuid("region")));
const firstTwo = lt({ kind: "call", fn: "position", args: [] }, literal(3));

export function sortedCaseChoices() {
	const doc = buildDoc({
		appId: id,
		appName: "Clinic choices",
		caseTypes: [
			{
				name: "clinic",
				properties: [
					{ name: "region", label: "Region", data_type: "text" },
					{ name: "rank", label: "Order", data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("directory"),
				name: "Directory",
				forms: [
					{
						name: "Choose a clinic",
						uuid: uuid("choose"),
						type: "survey",
						fields: [
							f({
								uuid: uuid("region"),
								kind: "text",
								id: "region",
								label: "Region",
							}),
							...(
								[
									{ key: "type_order", label: "All clinics" },
									{
										key: "source_order",
										label: "Source order",
										filter: regionMatches,
									},
									{
										key: "sorted",
										label: "Sorted clinics",
										filter: regionMatches,
										sortProperty: "rank",
									},
									{
										key: "limited",
										label: "Limit before sorting",
										filter: and(firstTwo, regionMatches),
										sortProperty: "rank",
									},
								] as const
							).map(({ key, label, ...query }) =>
								f({
									uuid: uuid(key),
									kind: "single_select",
									id: key,
									label,
									optionsSource: {
										kind: "cases",
										caseType: "clinic",
										labelProperty: "case_name",
										...query,
									},
								}),
							),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["questions, itemset sort reference"],
		doc,
		files: {
			"intent-restore.xml": restoreXml({
				cases: [
					{
						id: "north-late",
						type: "clinic",
						name: "Alpha label",
						properties: { region: "north", rank: "2" },
					},
					{
						id: "north-tie-first",
						type: "clinic",
						name: "Zulu label",
						properties: { region: "north", rank: "10" },
					},
					{
						id: "south",
						type: "clinic",
						name: "South only",
						properties: { region: "south", rank: "0" },
					},
				],
			}),
		},
		expected: {
			intent: [
				{
					id: "typed-choice-order",
					export: "local",
					form: uuid("choose"),
					restore: "intent-restore.xml",
					request: {
						answers: [
							{ path: "/data/region", value: "north" },
							{ path: "/data/sorted", value: "north-tie-first" },
						],
						expressions: ["/data/sorted"],
					},
					expect: [
						{
							pointer: "/answers/1/choices",
							value: [
								{ value: "north-tie-first", text: "Zulu label" },
								{ value: "north-late", text: "Alpha label" },
							],
						},
						{ pointer: "/answers/1/result", value: "ok" },
						{ pointer: "/values/0/value", value: "north-tie-first" },
					],
				},
			],
		},
	});
}

export function caseChoiceReopen() {
	const id = "targeted-case-choice-reopen";
	const uuid = (name: string) => targetedUuid(id, name);
	const doc = buildDoc({
		appId: id,
		appName: "Clinic choice recovery",
		caseTypes: [
			{
				name: "clinic",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
		],
		modules: [
			{
				uuid: uuid("directory"),
				name: "Directory",
				forms: [
					{
						name: "Resume a clinic choice",
						uuid: uuid("choose"),
						type: "survey",
						fields: [
							f({
								uuid: uuid("clinic"),
								kind: "single_select",
								id: "clinic",
								label: "Clinic",
								required: matchAll(),
								optionsSource: {
									kind: "cases",
									caseType: "clinic",
									labelProperty: "case_name",
									filter: eq(prop("clinic", "region"), literal("north")),
								},
							}),
						],
					},
				],
			},
		],
	});
	const before = {
		restore: "before-restore.xml",
		choice: "old-clinic",
		label: "Original clinic",
	};
	const after = {
		restore: "after-restore.xml",
		choice: "new-clinic",
		label: "Replacement clinic",
	};
	const restore = (eligible: string) =>
		restoreXml({
			cases: [before, after].map(({ choice, label }) => ({
				id: choice,
				type: "clinic",
				name: label,
				properties: { region: choice === eligible ? "north" : "south" },
			})),
		});
	return targetedDocument({
		id,
		rows: ["questions, queried choices after incomplete form reopen"],
		doc,
		files: {
			[before.restore]: restore(before.choice),
			[after.restore]: restore(after.choice),
		},
		expected: {
			intent: [before, after].map(({ restore, choice, label }) => ({
				id: choice,
				export: "local",
				form: uuid("choose"),
				restore,
				request: {
					answers: [{ path: "/data/clinic", value: choice }],
					expressions: ["/data/clinic"],
				},
				expect: [
					{
						pointer: "/answers/0/choices",
						value: [{ value: choice, text: label }],
					},
					{ pointer: "/answers/0/result", value: "ok" },
					{ pointer: "/values/0/value", value: choice },
				],
			})),
		},
	});
}
