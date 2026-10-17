/**
 * Each step that restates a production rule over the raw rows, held equal to
 * that rule over one document read both ways: built in the current schema,
 * handed to the production function hydrated and to the step as the raw
 * carriers the writer stores (`blueprintScalars`, `decomposeBlueprint`).
 * A frozen fixture lacks every slot the stack makes required, so the
 * documents are built here (part 10 of step 2's plan, "Scripts and their
 * layout"). Each pull request whose step restates a rule adds its cases.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	entrySessionDatums,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { duplicateSelectOptionValues } from "@/lib/domain/selectOptionValue";
import { selectOptionValueSpaces } from "../../selectOptionValueRepair";
import { type JsonRecord, readRawDocument } from "../oldShape";
import {
	optionValueSpaces,
	planDuplicateOptionValueSplit,
} from "../steps/optionValues";
import { declaredSessionDatumIds } from "../steps/unsuppliedSessionReads";
import { carriersOf } from "./fixtures/preStep";

const raw = (id: string, doc: BlueprintDoc) =>
	readRawDocument(id, carriersOf(toPersistableDoc(doc)));

const CASE_TYPES = [
	{
		name: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
		],
	},
	{
		name: "member",
		parent_type: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
		],
	},
	{
		name: "visit",
		parent_type: "member",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
		],
	},
];

const columns = () => caseListConfig([{ field: "case_name", header: "Name" }]);

/** The documents, each holding the shapes an entry's datums depend on. */
const DOCUMENTS: Readonly<Record<string, () => BlueprintDoc>> = {
	"registration with child cases and the worker's own case": () =>
		produce(
			buildDoc({
				caseTypes: CASE_TYPES,
				modules: [
					{
						uuid: "households",
						name: "Households",
						caseType: "household",
						caseListConfig: columns(),
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
									f({
										kind: "text",
										id: "head",
										caseWrite: { caseType: "member", property: "case_name" },
									}),
									f({
										kind: "repeat",
										id: "kids",
										repeat_mode: "user_controlled",
										children: [
											f({
												kind: "text",
												id: "kid",
												caseWrite: {
													caseType: "member",
													property: "case_name",
												},
											}),
										],
									}),
									f({
										kind: "text",
										id: "nickname",
										caseWrite: {
											caseType: "commcare-user",
											property: "nickname",
										},
									}),
								],
							},
							{
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "note" })],
							},
						],
					},
				],
			}),
			(draft) => {
				const uuid = testUuid("nickname-property");
				draft.userProperties = {
					[uuid]: { uuid, slug: "nickname", label: "Nickname" },
				};
				draft.userPropertyOrder = [uuid];
			},
		),
	"a selection through a parent case, a grouped tile and a child menu": () =>
		produce(
			buildDoc({
				caseTypes: CASE_TYPES,
				modules: [
					{
						uuid: "households",
						name: "Households",
						caseType: "household",
						caseListConfig: columns(),
						forms: [
							{
								name: "Check",
								type: "followup",
								fields: [f({ kind: "text", id: "a" })],
							},
						],
					},
					{
						uuid: "visits",
						name: "Visits",
						caseType: "visit",
						caseListConfig: columns(),
						forms: [
							{
								name: "See visit",
								type: "followup",
								fields: [f({ kind: "text", id: "e" })],
							},
						],
					},
					{
						uuid: "members",
						name: "Members",
						caseType: "member",
						parentCaseModuleUuid: "households",
						caseListConfig: columns(),
						forms: [
							{
								name: "Check member",
								type: "followup",
								fields: [f({ kind: "text", id: "b" })],
							},
							{
								name: "Close member",
								type: "close",
								fields: [f({ kind: "text", id: "c" })],
							},
						],
					},
					{
						uuid: "member-visits",
						name: "Member visits",
						caseType: "member",
						caseListConfig: columns(),
						forms: [
							{
								name: "Again",
								type: "followup",
								fields: [f({ kind: "text", id: "d" })],
							},
						],
					},
				],
			}),
			(draft) => {
				const members = draft.modules[testUuid("members") as Uuid];
				if (members?.caseListConfig !== undefined) {
					members.caseListConfig.tile = {
						grouping: { identifier: "parent", headerRows: 1 },
					} as never;
				}
				const again = draft.modules[testUuid("member-visits") as Uuid];
				if (again !== undefined)
					again.parentModuleUuid = testUuid("members") as Uuid;
				const visits = draft.modules[testUuid("visits") as Uuid];
				if (visits !== undefined)
					visits.parentModuleUuid = testUuid("households") as Uuid;
			},
		),
	"several cases, a search that opens first, and a child menu of each": () =>
		produce(
			buildDoc({
				caseTypes: CASE_TYPES,
				modules: [
					{
						uuid: "batches",
						name: "Batches",
						caseType: "household",
						caseListConfig: {
							...columns(),
							selection: { kind: "multiple", maximum: 5 },
						},
						forms: [
							{
								name: "Batch",
								type: "followup",
								fields: [f({ kind: "text", id: "a" })],
							},
						],
					},
					{
						uuid: "several",
						name: "Several",
						caseType: "household",
						caseListConfig: {
							...columns(),
							selection: { kind: "multiple", maximum: 5 },
						},
						forms: [
							{
								name: "Batch again",
								type: "followup",
								fields: [f({ kind: "text", id: "b" })],
							},
						],
					},
					{
						uuid: "found",
						name: "Found",
						caseType: "member",
						caseSearchConfig: { searchFirst: true },
						caseListConfig: {
							...columns(),
							searchInputs: [
								{
									uuid: testUuid("search-name"),
									kind: "simple",
									type: "text",
									name: "name",
									label: "Name",
									property: "case_name",
								},
							],
						} as never,
						forms: [
							{
								name: "Found one",
								type: "followup",
								fields: [f({ kind: "text", id: "c" })],
							},
						],
					},
					{
						uuid: "found-again",
						name: "Found again",
						caseType: "member",
						caseListConfig: columns(),
						forms: [
							{
								name: "Found it again",
								type: "followup",
								fields: [f({ kind: "text", id: "d" })],
							},
						],
					},
				],
			}),
			(draft) => {
				const several = draft.modules[testUuid("several") as Uuid];
				if (several !== undefined)
					several.parentModuleUuid = testUuid("batches") as Uuid;
				const again = draft.modules[testUuid("found-again") as Uuid];
				if (again !== undefined)
					again.parentModuleUuid = testUuid("found") as Uuid;
			},
		),
};

describe("unsupplied-session-reads declares the ids entrySessionDatums declares", () => {
	it.each(Object.entries(DOCUMENTS))("over %s", (name, build) => {
		const doc = build();
		const context = formLinkProjectionContext(doc, { entryMetadataOnly: true });
		const document = raw(name, doc);
		let forms = 0;
		for (const moduleUuid of doc.moduleOrder) {
			for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
				forms += 1;
				expect(
					[...declaredSessionDatumIds(document, moduleUuid, formUuid)],
					`${doc.forms[formUuid]?.name}`,
				).toEqual([
					...new Set(
						entrySessionDatums(doc, context, moduleUuid, formUuid).map(
							(datum) => datum.id,
						),
					),
				]);
			}
		}
		expect(forms).toBeGreaterThan(1);
	});
});

describe("option-values gives each later holder the value the refusal offers", () => {
	it("over a select whose choices share values, alone in its space", () => {
		const values = ["yes", "no", "yes", "yes", "yes_2", "no"];
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Ask",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "answer",
									optionsSource: {
										kind: "inline",
										options: values.map((value, index) => ({
											uuid: testUuid(`option-${index}`),
											value,
											label: { parts: [{ kind: "text", text: value }] },
										})),
									},
								}),
							],
						},
					],
				},
			],
		});
		const document = raw("options", doc);
		const splits = planDuplicateOptionValueSplit(document);
		expect(
			splits.map((split) => ({ index: split.index, to: split.to })),
		).toEqual(
			duplicateSelectOptionValues(values).map((duplicate) => ({
				index: duplicate.index,
				to: duplicate.suggestion,
			})),
		);
		const [field] = Object.values(document.fields) as JsonRecord[];
		const stored = (field as JsonRecord).optionsSource as {
			options: { value: string }[];
		};
		expect(stored.options.map((option) => option.value)).toEqual([
			"yes",
			"no",
			"yes_3",
			"yes_4",
			"yes_2",
			"no_2",
		]);
	});
});

describe("option-values groups choice lists into the repair's value spaces", () => {
	it("over a catalog, two selects that write its property, and a select that writes none", () => {
		const choices = (prefix: string) => ({
			kind: "inline" as const,
			options: ["open", "closed"].map((value, index) => ({
				uuid: testUuid(`${prefix}-${index}`),
				value,
				label: { parts: [{ kind: "text" as const, text: value }] },
			})),
		});
		const doc = buildDoc({
			caseTypes: [
				{
					name: "client",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{
							name: "status",
							label: "Status",
							data_type: "single_select",
							options: [
								{ value: "open", label: "Open" },
								{ value: "closed", label: "Closed" },
							],
						},
					],
				},
			],
			modules: [
				{
					name: "Clients",
					caseType: "client",
					caseListConfig: columns(),
					forms: ["Register", "Follow up"].map((name, index) => ({
						name,
						type:
							index === 0 ? ("registration" as const) : ("followup" as const),
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "single_select",
								id: "status",
								optionsSource: choices(`status-${index}`),
								caseWrite: { caseType: "client", property: "status" },
							}),
							f({
								kind: "multi_select",
								id: "flags",
								optionsSource: choices(`flags-${index}`),
							}),
						],
					})),
				},
			],
		});
		const persistable = toPersistableDoc(doc);
		const fieldUuidById = (id: string) =>
			Object.values(persistable.fields)
				.filter((field) => field?.id === id)
				.map((field) => field?.uuid as string);
		const production = new Map(
			[...selectOptionValueSpaces(structuredClone(persistable))].map(
				([key, space]) => [
					key,
					space.lists
						.map((list) =>
							list.where.kind === "catalog-option"
								? "catalog"
								: list.where.fieldUuid,
						)
						.sort(),
				],
			),
		);
		const step = new Map(
			[...optionValueSpaces(raw("spaces", doc))].map(([key, lists]) => [
				key,
				lists
					.map((list) =>
						list.owner.kind === "catalog" ? "catalog" : list.owner.fieldUuid,
					)
					.sort(),
			]),
		);
		expect(step).toEqual(production);
		/* The catalog and both status selects share one space; each flags
		 * select is a space of its own. */
		expect(production.get("client\u0000status")).toEqual(
			["catalog", ...fieldUuidById("status")].sort(),
		);
		expect(production.size).toBe(3);
	});
});
