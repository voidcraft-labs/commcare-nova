import { describe, expect, it } from "vitest";
import { mutationSchema } from "@/lib/doc/types";
import { proseText } from "@/lib/domain/prose";
import {
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
	MODULE_REFERENCE_SLOTS,
} from "@/lib/domain/referenceSlots";
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
	LEGACY_OPTION_UUID_NAMESPACE,
	type LegacyAppSnapshot,
	type LegacyEntityRow,
	legacyOptionUuidV5,
	planCanonicalAppMigration,
} from "../20260728000000_canonical_identity_foundation/frozenTransform";

const MODULE_UUID = "10000000-0000-4000-8000-000000000001";
const FORM_UUID = "20000000-0000-4000-8000-000000000002";
const FIELD_UUID = "30000000-0000-4000-8000-000000000003";
const SECOND_FIELD_UUID = "40000000-0000-4000-8000-000000000004";

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
					finding.path.startsWith("membership."),
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
					finding.path.endsWith(".cycle"),
			),
		).toBe(true);
	});
});

describe("canonical identity frozen occurrence manifest", () => {
	it("covers every schema-derived entity reference slot with the same surface", () => {
		const frozen = new Set(
			FROZEN_ENTITY_OCCURRENCES.map(
				(entry) => `${entry.entity}\u0000${entry.path}\u0000${entry.surface}`,
			),
		);
		for (const entry of [
			...FIELD_REFERENCE_SLOTS,
			...FORM_REFERENCE_SLOTS,
			...MODULE_REFERENCE_SLOTS,
		]) {
			expect(
				frozen.has(`${entry.entity}\u0000${entry.path}\u0000${entry.kind}`),
				`${entry.entity}.${entry.path} (${entry.kind})`,
			).toBe(true);
		}
		expect(
			new Set(
				FROZEN_ENTITY_OCCURRENCES.map(
					(entry) => `${entry.entity}\u0000${entry.path}`,
				),
			).size,
		).toBe(FROZEN_ENTITY_OCCURRENCES.length);
	});

	it("pins every final mutation discriminator exactly once", () => {
		const liveKinds = mutationSchema.options.map((arm) => {
			if ("shape" in arm) {
				return (arm.shape.kind as { value: string }).value;
			}
			const nested = "options" in arm ? arm.options : [];
			const kinds = new Set(
				nested.map((option) => (option.shape.kind as { value: string }).value),
			);
			expect([...kinds]).toEqual(["updateField"]);
			return "updateField";
		});
		expect([...FROZEN_FINAL_MUTATION_KINDS]).toEqual(liveKinds);
		expect(new Set(liveKinds).size).toBe(liveKinds.length);
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
});
