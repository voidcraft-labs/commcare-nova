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
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	searchInputDependencyUses,
	searchInputFormFieldDependencies,
	searchInputRemovalDependencies,
} from "@/lib/doc/searchInputMutations";
import {
	type BlueprintDoc,
	effectiveCaseTypes,
	type Uuid,
	writerPreloadsFromLoadedCase,
} from "@/lib/domain";
import {
	substituteUnansweredSearchInputsInExpression,
	substituteUnansweredSearchInputsInPredicate,
} from "@/lib/domain/predicate";
import { duplicateSelectOptionValues } from "@/lib/domain/selectOptionValue";
import { selectOptionValueSpaces } from "../../selectOptionValueRepair";
import { type JsonRecord, readRawDocument } from "../oldShape";
import { rawWriterPreloads } from "../steps/hiddenInertDefault";
import {
	optionValueSpaces,
	planDuplicateOptionValueSplit,
} from "../steps/optionValues";
import { reservedSearchInputsStep } from "../steps/reservedSearchInputs";
import { rawTimeProperties, timeOrderingStep } from "../steps/timeOrdering";
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

describe("reserved-search-inputs removes what the removeSearchInput reducer removes, and rewrites the places the removal dependencies name", () => {
	const PATIENTS = testUuid("patients") as Uuid;
	const INCLUDE = testUuid("include-closed") as Uuid;
	const OWNER = testUuid("owner") as Uuid;
	const QUERY = testUuid("query") as Uuid;
	const CARRIED = testUuid("carried") as Uuid;
	const read = {
		kind: "term",
		term: { kind: "input", searchInputUuid: INCLUDE },
	};

	/**
	 * A menu whose own-key include_closed input is read by the list's filter,
	 * a sibling's check, a calculated column, the assigned-cases expression,
	 * the Search action's condition and a no-matches form's field. An
	 * advanced input named _xpath_query and an exact input on owner_id reach
	 * HQ under no key of their own and stay. An own-key input named
	 * _xpath_query can't be built here: a case property's name starts with a
	 * letter, and an exact input's name is its property's.
	 */
	function document(): BlueprintDoc {
		return produce(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: "Name", data_type: "text" as const },
							{
								name: "include_closed",
								label: "Include closed",
								data_type: "text" as const,
							},
						],
					},
				],
				modules: [
					{
						uuid: "patients",
						name: "Patients",
						caseType: "patient",
						caseSearchConfig: {
							searchFirst: true,
							excludedOwnerIds: read,
							searchButtonDisplayCondition: {
								kind: "not",
								clause: { kind: "is-blank", left: read },
							},
						} as never,
						caseListConfig: {
							...columns(),
							filter: {
								kind: "when-input-present",
								input: { kind: "input", searchInputUuid: INCLUDE },
								clause: {
									kind: "eq",
									left: {
										kind: "term",
										term: {
											kind: "prop",
											caseType: "patient",
											property: "include_closed",
										},
									},
									right: read,
								},
							},
							searchInputs: [
								{
									uuid: INCLUDE,
									kind: "simple",
									type: "text",
									name: "include_closed",
									label: "Include closed",
									property: "include_closed",
								},
								{
									uuid: OWNER,
									kind: "simple",
									type: "text",
									name: "owner_id",
									label: "Owner",
									property: "owner_id",
									validation: {
										rule: { kind: "is-blank", left: read },
										message: "Leave Owner blank to include closed cases.",
									},
								},
								{
									uuid: QUERY,
									kind: "advanced",
									type: "text",
									name: "_xpath_query",
									label: "Query",
									predicate: {
										kind: "when-input-present",
										input: { kind: "input", searchInputUuid: QUERY },
										clause: {
											kind: "eq",
											left: {
												kind: "term",
												term: {
													kind: "prop",
													caseType: "patient",
													property: "case_name",
												},
											},
											right: {
												kind: "term",
												term: { kind: "input", searchInputUuid: QUERY },
											},
										},
									},
								},
							],
						} as never,
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "note" })],
							},
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "hidden",
										id: "carried",
										uuid: "carried",
										calculate: {
											parts: [
												{
													kind: "search-answer-ref",
													searchInputUuid: INCLUDE,
												},
											],
										},
									}),
								],
							},
						],
					},
				],
			}),
			(draft) => {
				const config = draft.modules[PATIENTS]?.caseListConfig;
				if (config === undefined) return;
				const calculated = testUuid("calculated") as Uuid;
				config.columns.push({
					uuid: calculated,
					kind: "calculated",
					header: "Closed asked",
					expression: read,
				} as never);
				config.listColumnOrder.push(calculated);
				config.detailColumnOrder.push(calculated);
				const register = draft.formOrder[PATIENTS]?.[1];
				const form = register === undefined ? undefined : draft.forms[register];
				if (form !== undefined) form.entry = { kind: "search-no-matches" };
			},
		);
	}

	it("over an own-key reserved input read in every place a removal names", () => {
		const doc = document();
		const module = doc.modules[PATIENTS];
		const config = module?.caseListConfig;
		if (module === undefined || config === undefined)
			throw new Error("The document lost its menu.");
		const dependencies = [
			...searchInputRemovalDependencies(
				config,
				module.caseSearchConfig,
				INCLUDE,
			),
			...searchInputFormFieldDependencies(doc, PATIENTS, INCLUDE),
		];
		expect(dependencies.map((dependency) => dependency.kind)).toEqual([
			"cases-available",
			"search-field-condition",
			"calculated-column",
			"assigned-cases",
			"search-button-visibility",
			"form-field",
		]);
		const reduced = produce(doc, (draft) => {
			applyMutations(draft, [
				{ kind: "removeSearchInput", moduleUuid: PATIENTS, uuid: INCLUDE },
			]);
		});

		const target = raw("reserved", doc);
		const changes = reservedSearchInputsStep.apply(target, {
			appId: "reserved",
			projectId: "project",
			lookupColumnTypes: new Map(),
			deployments: [],
		});
		const stepConfig = target.modules[PATIENTS]?.caseListConfig as {
			searchInputs: JsonRecord[];
			filter: unknown;
			columns: JsonRecord[];
		};
		expect(stepConfig.searchInputs.map((input) => input.uuid)).toEqual(
			reduced.modules[PATIENTS]?.caseListConfig?.searchInputs.map(
				(input) => input.uuid,
			),
		);
		const removed = changes.find(
			(change) => change.reason === "search-input-removed",
		);
		expect(removed?.detail?.expressions).toBe(
			String(
				dependencies.reduce(
					(sum, dependency) =>
						sum +
						(dependency.kind === "form-field"
							? searchInputDependencyUses(dependency)
							: 1),
					0,
				),
			),
		);

		// Each place reads the removed input alone, so its rewrite is the
		// unanswered reading of every Search input.
		const searchConfig = module.caseSearchConfig as {
			excludedOwnerIds: never;
			searchButtonDisplayCondition: never;
		};
		const stepSearch = target.modules[PATIENTS]?.caseSearchConfig as JsonRecord;
		expect(stepConfig.filter).toEqual(
			substituteUnansweredSearchInputsInPredicate(config.filter as never),
		);
		expect(
			stepConfig.searchInputs.find((input) => input.uuid === OWNER)?.validation,
		).toEqual({
			rule: substituteUnansweredSearchInputsInPredicate({
				kind: "is-blank",
				left: read,
			} as never),
			message: "Leave Owner blank to include closed cases.",
		});
		expect(
			stepConfig.columns.find((column) => column.kind === "calculated")
				?.expression,
		).toEqual(substituteUnansweredSearchInputsInExpression(read as never));
		expect(stepSearch.excludedOwnerIds).toEqual(
			substituteUnansweredSearchInputsInExpression(
				searchConfig.excludedOwnerIds,
			),
		);
		expect(stepSearch.searchButtonDisplayCondition).toEqual(
			substituteUnansweredSearchInputsInPredicate(
				searchConfig.searchButtonDisplayCondition,
			),
		);
		expect(target.fields[CARRIED]?.calculate).toEqual({
			parts: [{ kind: "text", text: "''" }],
		});
	});
});

describe("hidden-inert-default reads a preloaded writer as writerPreloadsFromLoadedCase does", () => {
	it("over a writer in a registration, a follow-up, a close, a survey, a multi-select follow-up, and a follow-up writing another case type", () => {
		const hidden = (id: string, caseType: string) =>
			f({
				kind: "hidden",
				id,
				caseWrite: { caseType, property: `${id}_value` },
			});
		const doc = buildDoc({
			caseTypes: CASE_TYPES,
			modules: [
				{
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
								hidden("seeded", "household"),
							],
						},
						{
							name: "Visit",
							type: "followup",
							fields: [hidden("kept", "household"), hidden("child", "member")],
						},
						{
							name: "Close",
							type: "close",
							fields: [hidden("closing", "household")],
						},
					],
				},
				{
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
							fields: [hidden("batched", "household")],
						},
					],
				},
				{
					name: "Survey",
					forms: [
						{
							name: "Ask",
							type: "survey",
							fields: [hidden("asked", "household")],
						},
					],
				},
			],
		});
		const document = raw("hidden writers", doc);
		const answers: [string, boolean][] = [];
		for (const moduleUuid of doc.moduleOrder) {
			const module = doc.modules[moduleUuid];
			for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
				const form = doc.forms[formUuid];
				for (const fieldUuid of doc.fieldOrder[formUuid] ?? []) {
					const field = doc.fields[fieldUuid];
					if (field?.kind !== "hidden" || module === undefined || !form)
						continue;
					const production = writerPreloadsFromLoadedCase(field, module, form);
					expect(
						rawWriterPreloads(
							document.fields[fieldUuid] as JsonRecord,
							document.modules[moduleUuid],
							document.forms[formUuid],
						),
						field.id,
					).toBe(production);
					answers.push([field.id, production]);
				}
			}
		}
		expect(answers).toEqual([
			["seeded", false],
			["kept", true],
			["child", false],
			["closing", true],
			["batched", false],
			["asked", false],
		]);
	});
});

describe("time-ordering finds what the gate refuses", () => {
	const TIME_CASE_TYPES = [
		{
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name", data_type: "text" as const },
				{ name: "visit_time", label: "Visit time", data_type: "time" as const },
				{ name: "dob", label: "Birth date", data_type: "date" as const },
				{ name: "arrival", label: "Arrival" },
			],
		},
	];

	function timeDoc(
		filter: unknown,
		relevant: string,
		required?: string,
	): BlueprintDoc {
		const doc = buildDoc({
			caseTypes: TIME_CASE_TYPES,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: columns(),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "time", id: "start" }),
								f({
									kind: "time",
									id: "arrived",
									caseWrite: { caseType: "patient", property: "arrival" },
								}),
								f({ kind: "date", id: "day" }),
								f({
									kind: "hidden",
									id: "start_copy",
									calculate: "#form/start",
								}),
								f({ kind: "label", id: "checked", relevant }),
							],
						},
					],
				},
			],
		});
		return produce(doc, (draft) => {
			const module = draft.modules[draft.moduleOrder[0] as Uuid];
			if (module?.caseListConfig !== undefined)
				module.caseListConfig.filter = filter as never;
			if (required !== undefined) {
				const visitTime = draft.caseTypes?.[0]?.properties[1];
				if (visitTime !== undefined)
					visitTime.required = { parts: [{ kind: "text", text: required }] };
			}
		});
	}

	it("reads the same time properties effectiveCaseTypes types as a time", () => {
		const doc = timeDoc(undefined, "true()");
		expect([...rawTimeProperties(raw("time properties", doc))].sort()).toEqual(
			effectiveCaseTypes(doc)
				.flatMap((caseType) =>
					caseType.properties
						.filter((property) => property.data_type === "time")
						.map((property) => `${caseType.name}/${property.name}`),
				)
				.sort(),
		);
	});

	const prop = (property: string) => ({
		kind: "term",
		term: { kind: "prop", caseType: "patient", property },
	});
	const literal = (value: string, data_type?: string) => ({
		kind: "term",
		term: { kind: "literal", value, ...(data_type && { data_type }) },
	});

	it.each([
		[
			"an ordering on a declared time",
			true,
			{ kind: "gt", left: prop("visit_time"), right: literal("08:00", "time") },
		],
		[
			"an ordering on a written time",
			true,
			{ kind: "lte", left: prop("arrival"), right: literal("08:00", "time") },
		],
		[
			"a range on a time",
			true,
			{
				kind: "between",
				left: prop("visit_time"),
				lower: literal("08:00", "time"),
				lowerInclusive: true,
				upperInclusive: true,
			},
		],
		[
			"a time compared with =",
			false,
			{ kind: "eq", left: prop("visit_time"), right: literal("08:00", "time") },
		],
		[
			"an ordering on a date",
			false,
			{ kind: "gt", left: prop("dob"), right: literal("2026-01-01", "date") },
		],
	] as const)("in a Predicate slot, over %s", (name, refused, filter) => {
		const doc = timeDoc(filter, "true()");
		const gate = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((error) =>
			error.message.includes("A time of day can't be compared"),
		);
		const step = timeOrderingStep.apply(raw(name, doc), {
			appId: name,
			projectId: "project",
			lookupColumnTypes: new Map(),
			deployments: [],
		});
		expect(gate).toBe(refused);
		expect(step.length > 0).toBe(gate);
	});

	it.each([
		["two time questions", true, "#form/start < #form/arrived", undefined],
		[
			"a hidden value whose calculate is a time",
			true,
			"#form/start_copy > 3",
			undefined,
		],
		["a time property", true, "#patient/visit_time >= 3", undefined],
		["text holding a colon", true, "#form/day > '09:00'", undefined],
		["a time compared with =", false, "#form/start = #form/arrived", undefined],
		["a date", false, "#form/day > today()", undefined],
		[
			"a catalog property's required condition",
			true,
			"true()",
			"#patient/visit_time > '08:00'",
		],
	] as const)("in form logic, over %s", (name, refused, relevant, required) => {
		const doc = timeDoc(undefined, relevant, required);
		const gate = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
			(error) => error.code === "XPATH_TIME_ORDERING",
		);
		const step = timeOrderingStep.apply(raw(name, doc), {
			appId: name,
			projectId: "project",
			lookupColumnTypes: new Map(),
			deployments: [],
		});
		expect(gate).toBe(refused);
		expect(step.length > 0).toBe(gate);
	});
});
