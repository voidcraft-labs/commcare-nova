import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { incrementalValidationScope as actualScope } from "@/lib/doc/incrementalValidationScope";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { asUuid, type Mutation } from "@/lib/doc/types";
import {
	type CaseOperation,
	type Column,
	dateColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	concat,
	dateCoerce,
	formField,
	input,
	isBlank,
	literal,
	not,
	now,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

/** The footprint the Builder gate computes: over the valid snapshot and the
 * candidate the batch produces from it. */
function incrementalValidationScope(
	doc: ReturnType<typeof buildDoc>,
	mutations: Mutation[],
) {
	assertAdmittedDoc(doc);
	const { nextDoc } = prepareMutationCandidate(
		doc,
		admitMutationBatch(mutations),
	);
	return actualScope(doc, mutations, nextDoc);
}
const PARENT_MODULE = asUuid("00000000-0000-4000-8000-000000000101");
const CHILD_MODULE = asUuid("00000000-0000-4000-8000-000000000102");
const CHILD_FORM = asUuid("00000000-0000-4000-8000-000000000103");
const LINK_MODULE = asUuid("00000000-0000-4000-8000-000000000104");
const LINK_FORM = asUuid("00000000-0000-4000-8000-000000000105");
const SECOND_MODULE = asUuid("00000000-0000-4000-8000-000000000106");
const SECOND_FORM = asUuid("00000000-0000-4000-8000-000000000107");

const MULTIPLE_FIVE = { kind: "multiple" as const, maximum: 5 };

function expectCommitParity(
	doc: ReturnType<typeof buildDoc>,
	mutations: Mutation[],
) {
	assertAdmittedDoc(doc);
	const absolute = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	const incremental = mutationCommitVerdictWithPrevalidation(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(incremental).toEqual(absolute);
	return absolute;
}

function fixture() {
	const doc = buildDoc({
		appName: "Incremental validation",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Visit",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit form",
						type: "followup",
						fields: [
							f({ kind: "text", id: "name" }),
							f({ kind: "text", id: "age" }),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	if (moduleUuid === undefined) throw new Error("fixture module missing");
	const formUuid = doc.formOrder[moduleUuid]?.[0];
	if (formUuid === undefined) throw new Error("fixture form missing");
	const fieldUuid = doc.fieldOrder[formUuid]?.[0];
	if (fieldUuid === undefined) throw new Error("fixture field missing");
	return { doc, moduleUuid, formUuid, fieldUuid };
}

describe("incrementalValidationScope", () => {
	it("scopes ordinary field patches and option-owned edits to their form", () => {
		const { doc, formUuid, fieldUuid } = fixture();
		const scope = incrementalValidationScope(doc, [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { id: "full_name" },
			},
		]);
		expect(scope).toEqual({ formUuids: new Set([formUuid]) });
	});

	it("rechecks module rules when a case destination changes and every inferred fact stays", () => {
		/* Two text writers of one declared text property: dropping one leaves
		 * the catalog and every writer opinion as they were. */
		const writer = (id: string) =>
			f({
				kind: "text",
				id,
				caseWrite: { caseType: "patient", property: "note" },
			});
		const doc = buildDoc({
			appName: "Two writers",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
			],
			modules: [
				{
					uuid: LINK_MODULE,
					name: "Visit",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: LINK_FORM,
							name: "Visit form",
							type: "followup",
							fields: [writer("note")],
						},
						{
							uuid: SECOND_FORM,
							name: "Review form",
							type: "followup",
							fields: [writer("remark")],
						},
					],
				},
			],
		});
		const fieldUuid = doc.fieldOrder[LINK_FORM]?.[0];
		if (fieldUuid === undefined) throw new Error("writer fixture missing");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { caseWrite: null },
			},
		];
		expect(incrementalValidationScope(doc, mutations)).toEqual({
			moduleUuids: new Set([LINK_MODULE]),
			formUuids: new Set([LINK_FORM]),
		});
		expect(expectCommitParity(doc, mutations).ok).toBe(true);
	});

	it("takes the absolute gate when a case destination changes an operation's inferred writer types", () => {
		const doc = buildDoc({
			appName: "Writer and operation dependency",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "nickname", label: "Nickname", data_type: "text" },
						{ name: "mixed", label: "Mixed" },
					],
				},
			],
			modules: [
				{
					name: "Author",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Edit field",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "nickname",
									caseWrite: {
										caseType: "patient",
										property: "nickname",
									},
								}),
							],
						},
					],
				},
				{
					name: "Automation",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Run operation",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		const authorModuleUuid = doc.moduleOrder[0];
		const operationModuleUuid = doc.moduleOrder[1];
		if (authorModuleUuid === undefined || operationModuleUuid === undefined) {
			throw new Error("operation dependency modules missing");
		}
		const authorFormUuid = doc.formOrder[authorModuleUuid]?.[0];
		const operationFormUuid = doc.formOrder[operationModuleUuid]?.[0];
		const fieldUuid =
			authorFormUuid === undefined
				? undefined
				: doc.fieldOrder[authorFormUuid]?.[0];
		if (
			authorFormUuid === undefined ||
			operationFormUuid === undefined ||
			fieldUuid === undefined
		) {
			throw new Error("operation dependency fixture missing");
		}
		const operation: CaseOperation = {
			uuid: asUuid("00000000-0000-4000-8000-000000000077"),
			id: "write_mixed",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [{ property: "mixed", value: term(literal(7)) }],
		};
		doc.forms[operationFormUuid] = {
			...doc.forms[operationFormUuid],
			caseOperations: [operation],
		};
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "mixed" },
				},
			},
		];

		expect(incrementalValidationScope(doc, mutations)).toBeUndefined();
		assertAdmittedDoc(doc);
		const absolute = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const incremental = mutationCommitVerdictWithPrevalidation(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(absolute.ok).toBe(false);
		expect(incremental).toEqual(absolute);
		if (!absolute.ok) {
			expect(absolute.findings.map((finding) => finding.code)).toContain(
				"CASE_OPERATION_EXPRESSION_TYPE",
			);
		}
	});

	it("unions form and module footprints across a safe batch", () => {
		const { doc, moduleUuid, formUuid, fieldUuid } = fixture();
		const scope = incrementalValidationScope(doc, [
			{
				kind: "setFieldMedia",
				fieldUuid,
				slot: "label",
				media: null,
			},
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { filter: null },
			},
		]);
		expect(scope).toEqual({
			moduleUuids: new Set([moduleUuid]),
			formUuids: new Set([formUuid]),
		});
	});

	it("uses the bounded dependency closure for selection edits and unions it across the batch", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: PARENT_MODULE,
					name: "Choose patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [],
				},
				{
					uuid: CHILD_MODULE,
					name: "Review patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [
						{
							uuid: CHILD_FORM,
							name: "Review",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
				{
					uuid: LINK_MODULE,
					name: "Linked workflow",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [
						{
							uuid: LINK_FORM,
							name: "Continue",
							type: "followup",
							fields: [f({ kind: "text", id: "decision" })],
							formLinks: [
								{
									target: {
										type: "form",
										moduleUuid: CHILD_MODULE,
										formUuid: CHILD_FORM,
									},
								},
							],
						},
					],
				},
				{
					uuid: SECOND_MODULE,
					name: "Second workflow",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: SECOND_FORM,
							name: "Second review",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		doc.modules[CHILD_MODULE].parentModuleUuid = PARENT_MODULE;

		expect(
			incrementalValidationScope(doc, [
				{
					kind: "setCaseListMeta",
					uuid: CHILD_MODULE,
					patch: { selection: { kind: "multiple", maximum: 4 } },
				},
				{
					kind: "setCaseListMeta",
					uuid: SECOND_MODULE,
					patch: { selection: MULTIPLE_FIVE },
				},
			]),
		).toEqual({
			moduleUuids: new Set([CHILD_MODULE, PARENT_MODULE, SECOND_MODULE]),
			formUuids: new Set([CHILD_FORM, LINK_FORM, SECOND_FORM]),
		});
	});

	it("uses app-only scope for presentation scalars", () => {
		const { doc } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{ kind: "setAppName", name: "Renamed" },
			]),
		).toEqual({});
	});

	it("scopes ordinary form and module settings to the owning module", () => {
		const { doc, moduleUuid, formUuid } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: { postSubmit: "app_home" },
				},
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { purpose: "Collect visit information" },
				},
			]),
		).toEqual({
			moduleUuids: new Set([moduleUuid]),
			formUuids: new Set([formUuid]),
		});
	});

	it("falls back when form/module changes alter cross-form session shape", () => {
		const { doc, moduleUuid, formUuid } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: { type: "followup" },
				},
			]),
		).toBeUndefined();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { caseType: "person" },
				},
			]),
		).toBeUndefined();
		/* Opening a module on Search hands its search instance to a submenu or
		 * a parent-select child, whose own rules must run. */
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {},
					caseSearchConfigPatch: { searchFirst: true },
				},
			]),
		).toBeUndefined();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {},
					caseSearchConfigPatch: { searchFirst: null },
				},
			]),
		).toEqual({
			/* Turning Search first off withdraws what the search found from
			 * every form in the module, so each one's rules run. */
			moduleUuids: new Set([moduleUuid]),
			formUuids: new Set(doc.formOrder[moduleUuid]),
		});
	});

	it("falls back to the absolute gate for structural or cross-scope work", () => {
		const { doc, fieldUuid } = fixture();
		const conversion = {
			kind: "convertField",
			uuid: fieldUuid,
			toKind: "int",
		} satisfies Mutation;
		expect(incrementalValidationScope(doc, [conversion])).toBeUndefined();
		expect(
			incrementalValidationScope(doc, [
				{ kind: "setAppName", name: "Renamed" },
				conversion,
			]),
		).toBeUndefined();
	});

	it("falls back when a target cannot be placed in the proven footprint", () => {
		const { doc } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateField",
					uuid: asUuid("00000000-0000-4000-8000-000000000099"),
					targetKind: "text",
					patch: { id: "missing" },
				},
			]),
		).toBeUndefined();
	});

	it("matches the absolute gate for accepted and rejected field edits", () => {
		const { doc, fieldUuid } = fixture();
		for (const [id, accepted] of [
			["full_name", true],
			["age", false],
		] as const) {
			const mutations: Mutation[] = [
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: { id },
				},
			];
			assertAdmittedDoc(doc);
			const absolute = mutationCommitVerdict(
				doc,
				mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			const incremental = mutationCommitVerdictWithPrevalidation(
				doc,
				mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(absolute.ok).toBe(accepted);
			expect(incremental.ok).toBe(accepted);
			if (!absolute.ok && !incremental.ok) {
				expect(incremental.findings.map((finding) => finding.code)).toEqual(
					absolute.findings.map((finding) => finding.code),
				);
			}
		}
	});

	it("matches the absolute gate when changing between one and several cases", () => {
		for (const startsMultiple of [false, true]) {
			const config = caseListConfig([{ field: "case_name", header: "Name" }]);
			if (startsMultiple) config.selection = MULTIPLE_FIVE;
			const doc = buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "note", label: "Note" }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: config,
						forms: [
							{
								name: "Review",
								type: "followup",
								fields: [
									f({
										kind: "text",
										id: "note",
										caseWrite: {
											caseType: "patient",
											property: "note",
										},
									}),
								],
							},
						],
					},
				],
			});
			const moduleUuid = doc.moduleOrder[0];
			const mutation: Mutation = {
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { selection: startsMultiple ? null : MULTIPLE_FIVE },
			};

			expect(expectCommitParity(doc, [mutation]).ok).toBe(true);
		}
	});

	it("matches the absolute gate when a destination maximum becomes too small", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: LINK_MODULE,
					name: "Source",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: { kind: "multiple", maximum: 10 },
					},
					forms: [
						{
							uuid: LINK_FORM,
							name: "Source form",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
							formLinks: [
								{
									target: {
										type: "form",
										moduleUuid: CHILD_MODULE,
										formUuid: CHILD_FORM,
									},
								},
							],
						},
					],
				},
				{
					uuid: CHILD_MODULE,
					name: "Target",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: { kind: "multiple", maximum: 10 },
					},
					forms: [
						{
							uuid: CHILD_FORM,
							name: "Target form",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		const verdict = expectCommitParity(doc, [
			{
				kind: "setCaseListMeta",
				uuid: CHILD_MODULE,
				patch: { selection: MULTIPLE_FIVE },
			},
		]);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "FORM_LINK_SELECTION_CARDINALITY",
						location: expect.objectContaining({ formUuid: LINK_FORM }),
					}),
				]),
			);
		}
	});

	it("matches the absolute gate when a child no longer accepts its parent's complete selection", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: PARENT_MODULE,
					name: "Choose patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [],
				},
				{
					uuid: CHILD_MODULE,
					name: "Review patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [
						{
							uuid: CHILD_FORM,
							name: "Review",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		doc.modules[CHILD_MODULE].parentModuleUuid = PARENT_MODULE;
		const verdict = expectCommitParity(doc, [
			{
				kind: "setCaseListMeta",
				uuid: CHILD_MODULE,
				patch: { selection: { kind: "multiple", maximum: 4 } },
			},
		]);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "MULTI_SELECT_NO_BATCH_CONSUMER",
						location: expect.objectContaining({ moduleUuid: PARENT_MODULE }),
					}),
				]),
			);
		}
	});

	it("matches the absolute gate when a writer changes another module's case list", () => {
		const doc = buildDoc({
			appName: "Writer dependency",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "nickname", header: "Nickname" },
					]),
					forms: [
						{
							name: "Update patient",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "nickname",
									caseWrite: {
										caseType: "patient",
										property: "nickname",
									},
								}),
							],
						},
					],
				},
				{
					name: "Patient records",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "nickname", header: "Nickname" },
					]),
					forms: [],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]]?.[0];
		const fieldUuid = formUuid && doc.fieldOrder[formUuid]?.[0];
		if (fieldUuid === undefined) throw new Error("writer fixture missing");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { caseWrite: null },
			},
		];
		assertAdmittedDoc(doc);
		const absolute = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const incremental = mutationCommitVerdictWithPrevalidation(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(absolute.ok).toBe(false);
		expect(incremental).toEqual(absolute);
	});
});

/* Inference is one fixpoint over every form, so a scoped commit is sound only
 * while it leaves every inferred fact where it was. Each batch below moves a
 * verdict in a form or module its own footprint never names, and the Builder
 * gate must refuse it exactly as the absolute gate does. */
describe("scoped commits under document-wide inference", () => {
	const AUTHOR_MODULE = testUuid("scope-author-module");
	const AUTHOR_FORM = testUuid("scope-author-form");
	const READER_MODULE = testUuid("scope-reader-module");
	const READER_FORM = testUuid("scope-reader-form");
	const WRITER = testUuid("scope-writer");
	const READER = testUuid("scope-reader");
	const NAME = testUuid("scope-name");
	const FLAG = testUuid("scope-flag");
	/* `concat('on ', #form/name)`: text where the writer used to save a date. */
	const textValue = concat(term(literal("on ")), term(formField(NAME)));

	function dateColumnConfig(property: string) {
		const column: Column = dateColumn(
			testUuid(`scope-column-${property}`),
			property,
			"Visit",
			"%d/%m/%Y",
		);
		return {
			...caseListConfig([]),
			columns: [column],
			listColumnOrder: [column.uuid],
			detailColumnOrder: [column.uuid],
		};
	}

	function twoModules(args: {
		readonly properties?: NonNullable<
			NonNullable<Parameters<typeof buildDoc>[0]>["caseTypes"]
		>[number]["properties"];
		readonly author: ReturnType<typeof f>[];
		readonly reader: ReturnType<typeof f>[];
		readonly readerCaseList?: ReturnType<typeof dateColumnConfig>;
	}) {
		return buildDoc({
			appName: "Inference footprint",
			caseTypes: [{ name: "patient", properties: args.properties ?? [] }],
			modules: [
				{
					uuid: AUTHOR_MODULE,
					name: "Author",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: AUTHOR_FORM,
							name: "Author form",
							type: "followup",
							fields: args.author,
						},
					],
				},
				{
					uuid: READER_MODULE,
					name: "Reader",
					caseType: "patient",
					caseListConfig:
						args.readerCaseList ??
						caseListConfig([{ field: "case_name", header: "Name" }]),
					forms: [
						{
							uuid: READER_FORM,
							name: "Reader form",
							type: "followup",
							fields: args.reader,
						},
					],
				},
			],
		});
	}

	function expectAbsoluteRefusal(
		doc: ReturnType<typeof buildDoc>,
		mutations: Mutation[],
		code: string,
		anchoredAt: { readonly formUuid?: string; readonly moduleUuid?: string },
	) {
		expect(incrementalValidationScope(doc, mutations)).toBeUndefined();
		const verdict = expectCommitParity(doc, mutations);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok)
			expect(verdict.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code,
						location: expect.objectContaining(anchoredAt),
					}),
				]),
			);
		return verdict;
	}

	it("refuses dropping the only writer of a property another form reads", () => {
		const doc = twoModules({
			author: [
				f({
					uuid: WRITER,
					kind: "text",
					id: "nickname",
					caseWrite: { caseType: "patient", property: "nickname" },
				}),
			],
			reader: [
				f({
					kind: "text",
					id: "greeting",
					relevant: "#patient/nickname != ''",
				}),
			],
		});
		const drop: Mutation = {
			kind: "updateField",
			uuid: WRITER,
			targetKind: "text",
			patch: { caseWrite: null },
		};
		expectAbsoluteRefusal(doc, [drop], "INVALID_CASE_REF", {
			formUuid: READER_FORM,
		});
	});

	it("refuses a Hidden Value calculation that retypes a property another module and form read", () => {
		const doc = twoModules({
			properties: [
				{ name: "visit", label: "Visit" },
				{ name: "last_visit", label: "Last visit", data_type: "date" },
			],
			author: [
				f({ uuid: NAME, kind: "text", id: "name", label: "Name" }),
				f({
					uuid: WRITER,
					kind: "hidden",
					id: "visit",
					calculate: "today()",
					caseWrite: { caseType: "patient", property: "visit" },
				}),
			],
			reader: [f({ kind: "text", id: "note" })],
			readerCaseList: dateColumnConfig("visit"),
		});
		/* The reader form copies the property into a date through a case
		 * operation, a form-logic read that its own type check holds. */
		const copy: CaseOperation = {
			uuid: testUuid("scope-copy-visit"),
			id: "copy_visit",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [
				{ property: "last_visit", value: term(prop("patient", "visit")) },
			],
		};
		doc.forms[READER_FORM] = {
			...doc.forms[READER_FORM],
			caseOperations: [copy],
		};
		const verdict = expectAbsoluteRefusal(
			doc,
			[
				{
					kind: "updateField",
					uuid: WRITER,
					targetKind: "hidden",
					patch: { calculate: textValue },
				},
			],
			"CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH",
			{ moduleUuid: READER_MODULE },
		);
		if (!verdict.ok)
			expect(verdict.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "CASE_OPERATION_EXPRESSION_TYPE",
						location: expect.objectContaining({ formUuid: READER_FORM }),
					}),
				]),
			);
	});

	it("refuses a retype that reaches another form through a chain of Hidden Values", () => {
		const doc = twoModules({
			properties: [
				{ name: "visit", label: "Visit" },
				{ name: "last_seen", label: "Last seen" },
			],
			author: [
				f({ uuid: NAME, kind: "text", id: "name", label: "Name" }),
				f({
					uuid: WRITER,
					kind: "hidden",
					id: "visit",
					calculate: "today()",
					caseWrite: { caseType: "patient", property: "visit" },
				}),
			],
			reader: [
				f({
					kind: "hidden",
					id: "copy",
					calculate: "#patient/visit",
					caseWrite: { caseType: "patient", property: "last_seen" },
				}),
			],
			readerCaseList: dateColumnConfig("last_seen"),
		});
		expectAbsoluteRefusal(
			doc,
			[
				{
					kind: "updateField",
					uuid: WRITER,
					targetKind: "hidden",
					patch: { calculate: textValue },
				},
			],
			"CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH",
			{ moduleUuid: READER_MODULE },
		);
	});

	it("refuses a Hidden Value whose new value no longer fits the type another form's question sets", () => {
		const doc = twoModules({
			properties: [{ name: "score", label: "Score", data_type: "int" }],
			author: [
				f({
					uuid: WRITER,
					kind: "hidden",
					id: "score_copy",
					calculate: "1",
					caseWrite: { caseType: "patient", property: "score" },
				}),
			],
			reader: [
				f({
					kind: "int",
					id: "score",
					caseWrite: { caseType: "patient", property: "score" },
				}),
			],
		});
		expectAbsoluteRefusal(
			doc,
			[
				{
					kind: "updateField",
					uuid: WRITER,
					targetKind: "hidden",
					patch: { calculate: term(literal("high")) },
				},
			],
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			{ formUuid: AUTHOR_FORM },
		);
	});

	it("refuses removing the choice another form's Hidden Value saves to a property this select starts on", () => {
		const doc = twoModules({
			properties: [
				{ name: "level", label: "Level", data_type: "single_select" },
			],
			author: [
				f({
					uuid: WRITER,
					kind: "hidden",
					id: "level_seed",
					calculate: "'high'",
					caseWrite: { caseType: "patient", property: "level" },
				}),
			],
			reader: [
				f({
					uuid: READER,
					kind: "single_select",
					id: "level",
					caseWrite: { caseType: "patient", property: "level" },
					options: [
						{ uuid: "scope-level-high", value: "high", label: "High" },
						{ uuid: "scope-level-low", value: "low", label: "Low" },
						{ uuid: "scope-level-none", value: "none", label: "None" },
					],
				}),
			],
		});
		const removal: Mutation = {
			kind: "removeOption",
			fieldUuid: READER,
			uuid: testUuid("scope-level-high"),
		};
		/* Choices type nothing, so the footprint stays narrow; the rule that
		 * holds the writer to them is app-wide and runs under every scope. */
		expect(incrementalValidationScope(doc, [removal])).toEqual({
			formUuids: new Set([READER_FORM]),
		});
		const verdict = expectCommitParity(doc, [removal]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok)
			expect(verdict.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
						location: expect.objectContaining({ formUuid: AUTHOR_FORM }),
					}),
				]),
			);
		const keep: Mutation = {
			kind: "removeOption",
			fieldUuid: READER,
			uuid: testUuid("scope-level-low"),
		};
		expect(expectCommitParity(doc, [keep]).ok).toBe(true);
	});

	it("refuses a Search prompt retype that a no-matches form's Hidden Value saves", () => {
		const SEARCH_MODULE = testUuid("scope-search-module");
		const REGISTER = testUuid("scope-search-register");
		const VISIT_INPUT = testUuid("scope-search-visit");
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [
			simpleSearchInputDef(VISIT_INPUT, "visit_on", "Visit on", "date", "seen"),
		];
		const doc = buildDoc({
			appName: "No-matches footprint",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "seen", label: "Seen", data_type: "date" },
					],
				},
			],
			modules: [
				{
					uuid: SEARCH_MODULE,
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
					caseSearchConfig: { searchFirst: true },
					forms: [
						{
							uuid: testUuid("scope-search-visit-form"),
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
						{
							uuid: REGISTER,
							name: "Register patient",
							type: "registration",
							entry: { kind: "search-no-matches" },
							fields: [
								f({
									kind: "text",
									id: "case_name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "hidden",
									id: "visit_on",
									default_value: term(input(VISIT_INPUT)),
									caseWrite: { caseType: "patient", property: "visit_on" },
								}),
							],
						},
					],
				},
				{
					uuid: READER_MODULE,
					name: "Reader",
					caseType: "patient",
					caseListConfig: dateColumnConfig("visit_on"),
					forms: [
						{
							uuid: READER_FORM,
							name: "Reader form",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		const { uuid: _uuid, ...content } = simpleSearchInputDef(
			VISIT_INPUT,
			"visit_on",
			"Visit on",
			"text",
			"case_name",
		);
		expectAbsoluteRefusal(
			doc,
			[
				{
					kind: "updateSearchInput",
					moduleUuid: SEARCH_MODULE,
					uuid: VISIT_INPUT,
					searchInput: content,
				},
			],
			"CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH",
			{ moduleUuid: READER_MODULE },
		);
	});

	it("keeps the narrow footprint for edits that move no inferred fact", () => {
		const doc = twoModules({
			properties: [{ name: "visit", label: "Visit" }],
			author: [
				f({ uuid: FLAG, kind: "text", id: "flag", label: "Flag" }),
				f({
					uuid: WRITER,
					kind: "hidden",
					id: "visit",
					calculate: "today()",
					caseWrite: { caseType: "patient", property: "visit" },
				}),
			],
			reader: [f({ kind: "text", id: "note" })],
			readerCaseList: dateColumnConfig("visit"),
		});
		for (const mutation of [
			{
				kind: "updateField",
				uuid: FLAG,
				targetKind: "text",
				patch: { label: proseText("Did we visit?") },
			},
			{
				kind: "updateField",
				uuid: WRITER,
				targetKind: "hidden",
				patch: { relevant: not(isBlank(formField(FLAG))) },
			},
			/* A different calculation that saves the same type. */
			{
				kind: "updateField",
				uuid: WRITER,
				targetKind: "hidden",
				patch: { calculate: dateCoerce(now()) },
			},
		] satisfies Mutation[]) {
			const mutations: Mutation[] = [mutation];
			expect(incrementalValidationScope(doc, mutations)).toEqual({
				formUuids: new Set([AUTHOR_FORM]),
			});
			expect(expectCommitParity(doc, mutations).ok).toBe(true);
		}
	});
});
