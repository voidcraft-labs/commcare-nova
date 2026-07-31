import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	parseFrozenCatalogXPath,
	printFrozenCatalogXPath,
} from "../20260728000000_canonical_identity_foundation/frozenCatalogXPath";
import {
	FROZEN_ENTITY_OCCURRENCES,
	FROZEN_FINAL_MUTATION_KINDS,
	FROZEN_OCCURRENCE_TABLES,
	FROZEN_STORAGE_OCCURRENCES,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	canonicalIdentityDigest,
	LEGACY_OPTION_UUID_NAMESPACE,
	type LegacyAppSnapshot,
	type LegacyEntityRow,
	legacyOptionUuidV5,
	planCanonicalAppMigration,
	rewriteFrozenCaseTypeSchema,
} from "../20260728000000_canonical_identity_foundation/frozenTransform";

const MODULE_UUID = "10000000-0000-4000-8000-000000000001";
const FORM_UUID = "20000000-0000-4000-8000-000000000002";
const FIELD_UUID = "30000000-0000-4000-8000-000000000003";
const SECOND_FIELD_UUID = "40000000-0000-4000-8000-000000000004";

function proseText(text: string) {
	return { parts: [{ kind: "text" as const, text }] };
}

function frozenCorpusDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshot(rows: readonly LegacyEntityRow[]): LegacyAppSnapshot {
	return {
		appId: "app-test",
		appName: "Test",
		connectType: null,
		caseTypes: [],
		logo: null,
		mutationSeq: "0",
		rows,
	};
}

function moduleRow(): LegacyEntityRow {
	return {
		appId: "app-test",
		uuid: MODULE_UUID,
		kind: "module",
		parentUuid: null,
		ordinal: 0,
		data: { uuid: MODULE_UUID, name: "Module" },
	};
}

function formRow(overrides: Partial<LegacyEntityRow> = {}): LegacyEntityRow {
	return {
		appId: "app-test",
		uuid: FORM_UUID,
		kind: "form",
		parentUuid: MODULE_UUID,
		ordinal: 0,
		data: { uuid: FORM_UUID, name: "Form" },
		...overrides,
	};
}

function selectField(
	options: readonly Record<string, unknown>[],
	overrides: Partial<LegacyEntityRow> = {},
): LegacyEntityRow {
	return {
		appId: "app-test",
		uuid: FIELD_UUID,
		kind: "field",
		parentUuid: FORM_UUID,
		ordinal: 0,
		data: {
			uuid: FIELD_UUID,
			id: "choice",
			kind: "single_select",
			label: proseText("Choice"),
			options,
		},
		...overrides,
	};
}

function textField(data: Record<string, unknown>): LegacyEntityRow {
	return {
		appId: "app-test",
		uuid: FIELD_UUID,
		kind: "field",
		parentUuid: FORM_UUID,
		ordinal: 0,
		data: {
			uuid: FIELD_UUID,
			id: "first_name",
			kind: "text",
			label: proseText("First name"),
			...data,
		},
	};
}

describe("canonical identity frozen case-write cutover", () => {
	it("moves the exact legacy binding while keeping field identity independent", () => {
		const plan = planCanonicalAppMigration(
			snapshot([
				moduleRow(),
				formRow(),
				textField({ case_property_on: "patient" }),
			]),
		);

		expect(plan.findings).toEqual([]);
		expect(plan.rewrites.caseWriteBindings).toBe(1);
		expect(plan.rows[2]?.data).toMatchObject({
			id: "first_name",
			caseWrite: { caseType: "patient", property: "first_name" },
		});
		expect(plan.rows[2]?.data).not.toHaveProperty("case_property_on");
	});

	it("accepts final caseWrite without coupling it back to field id", () => {
		const plan = planCanonicalAppMigration(
			snapshot([
				moduleRow(),
				formRow(),
				textField({
					id: "friendly_question",
					caseWrite: { caseType: "patient", property: "first_name" },
				}),
			]),
		);

		expect(plan.findings).toEqual([]);
		expect(plan.rewrites.caseWriteBindings).toBe(0);
		expect(plan.beforeDigest).toBe(plan.afterDigest);
	});

	it.each([
		[
			"mixed legacy and final bindings",
			{
				case_property_on: "patient",
				caseWrite: { caseType: "patient", property: "first_name" },
			},
		],
		[
			"a legacy standard-property writer alias",
			{ id: "name", case_property_on: "patient" },
		],
		[
			"a malformed final binding",
			{ caseWrite: { caseType: "patient", property: "name" } },
		],
	])("blocks %s", (_label, data) => {
		const plan = planCanonicalAppMigration(
			snapshot([moduleRow(), formRow(), textField(data)]),
		);

		expect(
			plan.findings.some((finding) => finding.carrierId === "field-case-write"),
		).toBe(true);
	});
});

describe("canonical identity frozen option UUIDv5", () => {
	it("pins the namespace and RFC UUIDv5 vectors", () => {
		expect(LEGACY_OPTION_UUID_NAMESPACE).toBe(
			"44f7e0cf-2896-4b28-a4e9-ac621746eb0a",
		);
		expect(
			legacyOptionUuidV5("00000000-0000-4000-8000-000000000001-opt-0"),
		).toBe("c26e830a-a319-50f4-90a7-50be9bc5ba15");
		expect(
			legacyOptionUuidV5("ffffffff-ffff-4fff-bfff-ffffffffffff-opt-159"),
		).toBe("f27c531d-cd4d-54b7-aa82-d719e7864398");
	});

	it("rewrites only the exact current-index legacy identity", () => {
		const canonical = "50000000-0000-4000-8000-000000000005";
		const legacy = `${FIELD_UUID}-opt-0`;
		const plan = planCanonicalAppMigration(
			snapshot([
				moduleRow(),
				formRow(),
				selectField([
					{ uuid: legacy, value: "a", label: "A" },
					{ uuid: canonical, value: "b", label: "B" },
				]),
			]),
		);

		expect(plan.findings).toEqual([]);
		expect(plan.rewrites.optionUuids).toBe(1);
		const field = plan.rows.find((row) => row.uuid === FIELD_UUID);
		const source = field?.data.optionsSource as {
			kind: string;
			options: Array<{ uuid: string }>;
		};
		expect(source.kind).toBe("inline");
		expect(source.options.map((option) => option.uuid)).toEqual([
			legacyOptionUuidV5(legacy),
			canonical,
		]);
	});

	it.each([
		["missing", undefined],
		["stale position", `${FIELD_UUID}-opt-99`],
		["arbitrary string", "choice-a"],
	])("blocks a %s identity", (_label, uuid) => {
		const plan = planCanonicalAppMigration(
			snapshot([
				moduleRow(),
				formRow(),
				selectField([
					{ ...(uuid !== undefined && { uuid }), value: "a", label: "A" },
					{
						uuid: "50000000-0000-4000-8000-000000000005",
						value: "b",
						label: "B",
					},
				]),
			]),
		);

		expect(plan.findings.map((finding) => finding.code)).toContain(
			"invalid-authored-uuid",
		);
	});

	it("detects a mapped target collision with an existing authored identity", () => {
		const legacy = `${FIELD_UUID}-opt-0`;
		const target = legacyOptionUuidV5(legacy);
		const plan = planCanonicalAppMigration(
			snapshot([
				moduleRow(),
				formRow(),
				selectField([
					{ uuid: legacy, value: "a", label: "A" },
					{ uuid: target, value: "b", label: "B" },
				]),
			]),
		);

		expect(plan.findings.map((finding) => finding.code)).toContain(
			"authored-uuid-collision",
		);
	});
});

describe("canonical identity frozen catalog XPath", () => {
	it("keeps syntax-valid reference-free source byte exact", () => {
		const source = "string-length(.) > 0";
		const result = parseFrozenCatalogXPath(source, "patient");

		expect(result).toEqual({
			expression: { parts: [{ kind: "text", text: source }] },
			issues: [],
		});
		expect(printFrozenCatalogXPath(result.expression)).toBe(source);
	});

	it("converts an explicit enclosing-case reference and reparses identically", () => {
		const source = "#patient/status = 'open'";
		const result = parseFrozenCatalogXPath(source, "patient");

		expect(result).toEqual({
			expression: {
				parts: [
					{ kind: "case-ref", caseType: "patient", property: "status" },
					{ kind: "text", text: " = 'open'" },
				],
			},
			issues: [],
		});
		expect(printFrozenCatalogXPath(result.expression)).toBe(source);
	});

	it.each([
		"#form/name = 'A'",
		"#case/status = 'open'",
		"#user/username = 'a'",
		"/data/name = 'A'",
		"count(/data/group/name) > 0",
	])("blocks an illegal catalog-scope reference: %s", (source) => {
		const result = parseFrozenCatalogXPath(source, "patient");

		expect(result.issues.map((issue) => issue.code)).toContain(
			"illegal-reference",
		);
	});

	it("blocks syntax-invalid source", () => {
		expect(parseFrozenCatalogXPath("(", "patient").issues).toEqual([
			{ code: "syntax", from: 0, to: 1 },
		]);
	});

	it("uses the frozen parser from the app-plan transform", () => {
		const plan = planCanonicalAppMigration({
			...snapshot([moduleRow(), formRow()]),
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "status",
							label: "Status",
							validation: "#patient/status = 'open'",
						},
						{
							name: "name",
							label: "Name",
							validation: "#form/name != ''",
						},
					],
				},
			],
		});

		expect(
			plan.findings.filter((finding) => finding.code === "hidden-reference"),
		).toHaveLength(1);
		const caseTypes = plan.caseTypes as Array<{
			properties: Array<{ validation: unknown }>;
		}>;
		expect(caseTypes[0]?.properties[0]?.validation).toEqual({
			parts: [
				{ kind: "case-ref", caseType: "patient", property: "status" },
				{ kind: "text", text: " = 'open'" },
			],
		});
		expect(caseTypes[0]?.properties[1]?.validation).toBe("#form/name != ''");
	});
});

describe("canonical identity topology closure", () => {
	it("rejects a null parent for an owned field", () => {
		const plan = planCanonicalAppMigration(
			snapshot([
				moduleRow(),
				formRow(),
				selectField(
					[
						{
							uuid: `${FIELD_UUID}-opt-0`,
							value: "a",
							label: "A",
						},
						{
							uuid: `${FIELD_UUID}-opt-1`,
							value: "b",
							label: "B",
						},
					],
					{ parentUuid: null },
				),
			]),
		);

		expect(plan.findings.map((finding) => finding.code)).toContain(
			"invalid-topology",
		);
	});

	it("rejects a form with a wrong-kind parent", () => {
		const plan = planCanonicalAppMigration(
			snapshot([moduleRow(), formRow({ parentUuid: FORM_UUID })]),
		);

		expect(plan.findings.map((finding) => finding.code)).toContain(
			"invalid-topology",
		);
	});

	it("rejects duplicate membership ordinals", () => {
		const first = selectField([
			{ uuid: `${FIELD_UUID}-opt-0`, value: "a", label: "A" },
			{ uuid: `${FIELD_UUID}-opt-1`, value: "b", label: "B" },
		]);
		const second: LegacyEntityRow = {
			...first,
			uuid: SECOND_FIELD_UUID,
			data: {
				...first.data,
				uuid: SECOND_FIELD_UUID,
				id: "second",
				options: [
					{ uuid: `${SECOND_FIELD_UUID}-opt-0`, value: "a", label: "A" },
					{ uuid: `${SECOND_FIELD_UUID}-opt-1`, value: "b", label: "B" },
				],
			},
		};
		const plan = planCanonicalAppMigration(
			snapshot([moduleRow(), formRow(), first, second]),
		);

		expect(
			plan.findings.some(
				(finding) =>
					finding.code === "invalid-topology" &&
					finding.path ===
						`blueprint:${canonicalIdentityDigest(
							`membership.${FORM_UUID}:field.${SECOND_FIELD_UUID}`,
						)}`,
			),
		).toBe(true);
	});

	it("rejects a field-parent cycle", () => {
		const first: LegacyEntityRow = {
			appId: "app-test",
			uuid: FIELD_UUID,
			kind: "field",
			parentUuid: SECOND_FIELD_UUID,
			ordinal: 0,
			data: { uuid: FIELD_UUID, id: "a", kind: "group", label: proseText("A") },
		};
		const second: LegacyEntityRow = {
			appId: "app-test",
			uuid: SECOND_FIELD_UUID,
			kind: "field",
			parentUuid: FIELD_UUID,
			ordinal: 0,
			data: {
				uuid: SECOND_FIELD_UUID,
				id: "b",
				kind: "group",
				label: proseText("B"),
			},
		};
		const plan = planCanonicalAppMigration(
			snapshot([moduleRow(), formRow(), first, second]),
		);

		expect(
			plan.findings.some(
				(finding) =>
					finding.code === "invalid-topology" &&
					finding.path ===
						`blueprint:${canonicalIdentityDigest(
							`entities.field.${FIELD_UUID}.cycle`,
						)}`,
			),
		).toBe(true);
	});
});

describe("canonical identity frozen occurrence manifest", () => {
	it("pins the complete frozen entity-reference surface", () => {
		expect(frozenCorpusDigest(FROZEN_ENTITY_OCCURRENCES)).toBe(
			"c9306b06b78e7e88ad8c56805b17f4fd0e584daf1aeda1e74f264e3a55bc0f48",
		);
		expect(
			new Set(
				FROZEN_ENTITY_OCCURRENCES.map(
					(entry) => `${entry.entity}\u0000${entry.path}`,
				),
			).size,
		).toBe(FROZEN_ENTITY_OCCURRENCES.length);
	});

	it("pins every final mutation discriminator exactly once", () => {
		expect(frozenCorpusDigest(FROZEN_FINAL_MUTATION_KINDS)).toBe(
			"46d0b88142bc7557d32ee0b017909f20298891dd0023e73c2e29ddbeb04f5dee",
		);
		expect(new Set(FROZEN_FINAL_MUTATION_KINDS).size).toBe(
			FROZEN_FINAL_MUTATION_KINDS.length,
		);
	});

	it("classifies every storage occurrence and derives the locked table set", () => {
		expect(FROZEN_STORAGE_OCCURRENCES.length).toBeGreaterThan(0);
		expect(
			new Set(FROZEN_STORAGE_OCCURRENCES.map((entry) => entry.id)).size,
		).toBe(FROZEN_STORAGE_OCCURRENCES.length);
		expect(
			new Set(FROZEN_STORAGE_OCCURRENCES.map((entry) => entry.disposition)),
		).toEqual(
			new Set([
				"rewrite-current",
				"block-current",
				"archive-exact",
				"opaque-pre-horizon",
				"delete-operational",
				"preserve-exact",
				"DDL",
			]),
		);
		expect([...FROZEN_OCCURRENCE_TABLES]).toEqual([
			...new Set(FROZEN_STORAGE_OCCURRENCES.map((entry) => entry.table)),
		]);
	});

	it("keeps reference-looking prose literal unless the frozen repair typed it", () => {
		const field: LegacyEntityRow = {
			appId: "app-test",
			uuid: FIELD_UUID,
			kind: "field",
			parentUuid: FORM_UUID,
			ordinal: 0,
			data: {
				uuid: FIELD_UUID,
				id: "name",
				kind: "text",
				label: "See #form/name and #case/name",
			},
		};
		const plan = planCanonicalAppMigration(
			snapshot([moduleRow(), formRow(), field]),
		);

		expect(plan.findings).toEqual([]);
		expect(plan.rows[2]?.data.label).toEqual({
			parts: [{ kind: "text", text: "See #form/name and #case/name" }],
		});
	});

	it("applies the contextual #case matrix through frozen Lezer", () => {
		const module = moduleRow();
		module.data.caseType = "patient";
		const form = formRow({
			data: {
				uuid: FORM_UUID,
				id: "edit",
				name: "Edit",
				type: "followup",
			},
		});
		const field: LegacyEntityRow = {
			appId: "app-test",
			uuid: FIELD_UUID,
			kind: "field",
			parentUuid: FORM_UUID,
			ordinal: 0,
			data: {
				uuid: FIELD_UUID,
				id: "gate",
				kind: "hidden",
				relevant: "#case/name != ''",
			},
		};
		const plan = planCanonicalAppMigration({
			...snapshot([module, form, field]),
			caseTypes: [{ name: "patient", properties: [] }],
		});

		expect(plan.findings).toEqual([]);
		expect(plan.rows[2]?.data.relevant).toEqual({
			parts: [
				{ kind: "case-ref", caseType: "patient", property: "case_name" },
				{ kind: "text", text: " != ''" },
			],
		});

		const registration = planCanonicalAppMigration({
			...snapshot([
				module,
				formRow({
					data: {
						uuid: FORM_UUID,
						id: "register",
						name: "Register",
						type: "registration",
					},
				}),
				{
					...field,
					data: { ...field.data, relevant: "#case/status = 'open'" },
				},
			]),
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(registration.findings.map((finding) => finding.code)).toContain(
			"unresolved-reference",
		);
	});

	it("converts literal date/post-submit spellings and exact empty Connect absence", () => {
		const columnUuid = "50000000-0000-4000-8000-000000000005";
		const inputUuid = "60000000-0000-4000-8000-000000000006";
		const module = moduleRow();
		module.data.caseListConfig = {
			columns: [
				{
					uuid: columnUuid,
					kind: "date",
					field: "date-opened",
					header: "Opened",
					pattern: "short",
				},
			],
			listColumnOrder: [columnUuid],
			detailColumnOrder: [columnUuid],
			searchInputs: [
				{
					uuid: inputUuid,
					kind: "simple",
					name: "opened",
					label: "Opened",
					type: "date-range",
					property: "date-opened",
					mode: { kind: "range" },
				},
			],
		};
		const form = formRow({
			data: {
				uuid: FORM_UUID,
				id: "form",
				name: "Form",
				type: "survey",
				connect: {},
				postSubmit: "root",
			},
		});
		const plan = planCanonicalAppMigration(snapshot([module, form]));

		expect(plan.findings).toEqual([]);
		const migratedModule = plan.rows[0]?.data.caseListConfig as {
			columns: Array<{ field: string; pattern: string }>;
			searchInputs: Array<{ property: string }>;
		};
		expect(migratedModule.columns[0]).toMatchObject({
			field: "date_opened",
			pattern: "%m/%d/%Y",
		});
		expect(migratedModule.searchInputs[0]?.property).toBe("date_opened");
		expect(plan.rows[1]?.data).not.toHaveProperty("connect");
		expect(plan.rows[1]?.data.postSubmit).toBe("app_home");
	});

	it("blocks standard-property writers, malformed mapping rows, and off-mode Connect", () => {
		const columnUuid = "50000000-0000-4000-8000-000000000005";
		const module = moduleRow();
		module.data.caseListConfig = {
			columns: [
				{
					uuid: columnUuid,
					kind: "id-mapping",
					field: "status",
					header: "Status",
					mapping: [{ value: "", label: "Blank" }],
				},
			],
			listColumnOrder: [columnUuid],
			detailColumnOrder: [columnUuid],
			searchInputs: [],
		};
		const form = formRow({
			data: {
				uuid: FORM_UUID,
				id: "edit",
				name: "Edit",
				type: "followup",
				connect: {
					learn_module: {
						id: "learn",
						name: "Learn",
						description: "Learn",
						time_estimate: 1,
					},
				},
				caseOperations: [
					{
						uuid: "70000000-0000-4000-8000-000000000007",
						id: "edit",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [
							{
								property: "external-id",
								value: {
									kind: "term",
									term: { kind: "literal", value: "x" },
								},
							},
						],
					},
				],
			},
		});
		const plan = planCanonicalAppMigration(snapshot([module, form]));

		expect(plan.findings.map((finding) => finding.carrierId)).toEqual(
			expect.arrayContaining([
				"mapping",
				"connect",
				"standard-property-writer",
			]),
		);
	});

	it("uses declared predicate slots instead of rewriting lookalike objects", () => {
		const SEARCH_INPUT_UUID = "50000000-0000-4000-8000-000000000005";
		const module = moduleRow();
		module.data.caseListConfig = {
			columns: [],
			listColumnOrder: [],
			detailColumnOrder: [],
			searchInputs: [
				{
					uuid: SEARCH_INPUT_UUID,
					kind: "simple",
					name: "query",
					label: "Query",
					property: "name",
					type: "text",
					mode: { kind: "exact" },
				},
			],
			filter: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "input", name: "query" },
				},
				right: {
					kind: "term",
					term: { kind: "literal", value: "yes" },
				},
			},
		};
		module.data.unrelated = { kind: "input", name: "query" };
		const plan = planCanonicalAppMigration(snapshot([module, formRow()]));
		const migrated = plan.rows[0]?.data;
		expect(migrated).toBeDefined();
		const config = migrated?.caseListConfig as Record<string, unknown>;
		const filter = config.filter as Record<string, unknown>;
		const left = filter.left as Record<string, unknown>;

		expect(left.term).toEqual({
			kind: "input",
			searchInputUuid: SEARCH_INPUT_UUID,
		});
		expect(migrated?.unrelated).toEqual({ kind: "input", name: "query" });
		expect(plan.rewrites.searchInputRefs).toBe(1);
	});

	it("final-parses each declared AST carrier with strict frozen shapes", () => {
		const module = moduleRow();
		module.data.caseListConfig = {
			columns: [],
			listColumnOrder: [],
			detailColumnOrder: [],
			searchInputs: [],
			filter: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "literal", value: "yes", stale: true },
				},
				right: {
					kind: "term",
					term: { kind: "literal", value: "yes" },
				},
			},
		};

		const plan = planCanonicalAppMigration(snapshot([module, formRow()]));

		expect(
			plan.findings.some(
				(finding) =>
					finding.carrierId === "expression-ast" &&
					finding.path ===
						`blueprint:${canonicalIdentityDigest(
							`entities.module.${MODULE_UUID}.caseListConfig.filter`,
						)}`,
			),
		).toBe(true);
	});

	it("reparses reference-looking XPath text through frozen Lezer", () => {
		const field: LegacyEntityRow = {
			appId: "app-test",
			uuid: FIELD_UUID,
			kind: "field",
			parentUuid: FORM_UUID,
			ordinal: 0,
			data: {
				uuid: FIELD_UUID,
				id: "name",
				kind: "hidden",
				relevant: {
					parts: [{ kind: "text", text: "#form/name = /data/name" }],
				},
			},
		};
		const plan = planCanonicalAppMigration(
			snapshot([moduleRow(), formRow(), field]),
		);

		expect(plan.findings).toEqual([]);
		expect(plan.rows[2]?.data.relevant).toEqual({
			parts: [
				{ kind: "field-ref", uuid: FIELD_UUID },
				{ kind: "text", text: " = " },
				{ kind: "path-ref", uuid: FIELD_UUID },
			],
		});
	});

	it("rebuilds materialized case schemas from canonical catalog semantics", () => {
		const rebuilt = rewriteFrozenCaseTypeSchema(
			{
				type: "object",
				properties: {
					name: { type: "string" },
					stale: { type: "number" },
				},
				additionalProperties: true,
			},
			{
				name: "patient",
				properties: [
					{ name: "case_name" },
					{ name: "age", data_type: "int" },
					{ name: "choice", data_type: "single_select" },
				],
			},
			"case_type_schemas.fixture.schema",
		);
		expect(rebuilt.findings).toEqual([]);
		expect(rebuilt.schema).toEqual({
			type: "object",
			properties: {
				age: {
					type: "integer",
					minimum: -2_147_483_648,
					maximum: 2_147_483_647,
				},
				choice: { type: "string", "x-novaDataType": "single_select" },
			},
			additionalProperties: false,
		});
		expect(rebuilt.rewrites).toBe(1);
	});
});
