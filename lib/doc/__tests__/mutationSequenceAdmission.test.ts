import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationTargetsInvalid } from "@/lib/db/commitGuard";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	MUTATION_SEQUENCE_INVENTORY,
	mutationSequenceAdmissionIssue,
} from "@/lib/doc/mutationSequenceAdmission";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseOperationSchema,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const MISSING = testUuid("missing-sequence-neighbor");

function literal(value: string) {
	return {
		kind: "term" as const,
		term: { kind: "literal" as const, value },
	};
}

interface Fixture {
	doc: BlueprintDoc;
	moduleOne: Uuid;
	moduleTwo: Uuid;
	formOne: Uuid;
	formTwo: Uuid;
	fieldOne: Uuid;
	fieldTwo: Uuid;
	select: Uuid;
	option: Uuid;
	column: Uuid;
	searchInput: Uuid;
	operation: Uuid;
}

function fixture(): Fixture {
	const doc = buildDoc({
		modules: [
			{
				name: "One",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "First",
						type: "survey",
						fields: [
							f({ kind: "text", id: "a", label: proseText("A") }),
							f({
								kind: "single_select",
								id: "choice",
								label: proseText("Choice"),
								options: [
									{ value: "a", label: proseText("A") },
									{ value: "b", label: proseText("B") },
								],
							}),
						],
					},
				],
			},
			{
				name: "Two",
				forms: [
					{
						name: "Second",
						type: "survey",
						fields: [f({ kind: "text", id: "b", label: proseText("B") })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	const [moduleOne, moduleTwo] = doc.moduleOrder;
	const [formOne] = doc.formOrder[moduleOne] ?? [];
	const [formTwo] = doc.formOrder[moduleTwo] ?? [];
	const [fieldOne, select] = doc.fieldOrder[formOne] ?? [];
	const [fieldTwo] = doc.fieldOrder[formTwo] ?? [];
	const selectField = doc.fields[select];
	if (
		selectField === undefined ||
		!("optionsSource" in selectField) ||
		selectField.optionsSource.kind !== "inline"
	) {
		throw new Error("select fixture missing");
	}
	const option = selectField.optionsSource.options[0]?.uuid;
	const config = doc.modules[moduleOne]?.caseListConfig;
	const column = config?.columns[0]?.uuid;
	if (config === undefined || column === undefined || option === undefined) {
		throw new Error("case-list fixture missing");
	}
	const searchInput = testUuid("sequence-search-input");
	config.searchInputs = [
		{
			uuid: searchInput,
			kind: "simple",
			name: "name",
			label: "Name",
			type: "text",
			property: "case_name",
		},
	];
	const operation = testUuid("sequence-operation");
	const caseOperation: CaseOperation = {
		uuid: operation,
		id: "create_patient",
		action: "create",
		caseType: "patient",
		target: { kind: "new" },
		name: literal("Patient"),
		writes: [{ property: "status", value: literal("open") }],
		links: [
			{
				identifier: "parent",
				targetType: "household",
				target: null,
				relationship: "child",
			},
		],
	};
	doc.forms[formOne].caseOperations = [caseOperation];
	return {
		doc,
		moduleOne,
		moduleTwo,
		formOne,
		formTwo,
		fieldOne,
		fieldTwo,
		select,
		option,
		column,
		searchInput,
		operation,
	};
}

function missingAnchorMutations(fx: Fixture): Array<[string, Mutation]> {
	const currentColumn = fx.doc.modules[fx.moduleOne].caseListConfig?.columns[0];
	const currentInput =
		fx.doc.modules[fx.moduleOne].caseListConfig?.searchInputs[0];
	const selectField = fx.doc.fields[fx.select];
	if (
		currentColumn === undefined ||
		currentInput === undefined ||
		selectField === undefined ||
		!("optionsSource" in selectField) ||
		selectField.optionsSource.kind !== "inline"
	) {
		throw new Error("sequence fixture incomplete");
	}
	const currentOption = selectField.optionsSource.options[0];
	return [
		[
			"add module",
			{
				kind: "addModule",
				module: {
					uuid: testUuid("new-sequence-module"),
					id: "new_sequence_module",
					name: "New module",
				},
				after: MISSING,
			},
		],
		["move module", { kind: "moveModule", uuid: fx.moduleOne, after: MISSING }],
		[
			"add form",
			{
				kind: "addForm",
				moduleUuid: fx.moduleOne,
				form: {
					uuid: testUuid("new-sequence-form"),
					id: "new_sequence_form",
					name: "New form",
					type: "survey",
				},
				after: MISSING,
			},
		],
		[
			"move form",
			{
				kind: "moveForm",
				uuid: fx.formOne,
				toModuleUuid: fx.moduleOne,
				after: MISSING,
			},
		],
		[
			"add field",
			{
				kind: "addField",
				parentUuid: fx.formOne,
				field: {
					uuid: testUuid("new-sequence-field"),
					kind: "text",
					id: "new_field",
					label: proseText("New field"),
				},
				after: MISSING,
			},
		],
		[
			"move field",
			{
				kind: "moveField",
				uuid: fx.fieldOne,
				toParentUuid: fx.formOne,
				after: MISSING,
			},
		],
		[
			"add worker information",
			{
				kind: "addUserProperty",
				property: {
					uuid: testUuid("new-sequence-user-property"),
					slug: "district",
					label: "District",
				},
				after: MISSING,
			},
		],
		[
			"add user type",
			{
				kind: "addUserType",
				userType: {
					uuid: testUuid("new-sequence-user-type"),
					name: "CHW",
				},
				after: MISSING,
			},
		],
		[
			"add persona",
			{
				kind: "addPersona",
				persona: {
					uuid: testUuid("new-sequence-persona"),
					name: "Pat",
				},
				after: MISSING,
			},
		],
		[
			"add column",
			{
				kind: "addColumn",
				moduleUuid: fx.moduleOne,
				column: {
					...structuredClone(currentColumn),
					uuid: testUuid("new-sequence-column"),
				},
				afterInList: MISSING,
				afterInDetail: fx.column,
			},
		],
		[
			"move column",
			{
				kind: "moveColumn",
				moduleUuid: fx.moduleOne,
				uuid: fx.column,
				surface: "list",
				after: MISSING,
			},
		],
		[
			"add Search input",
			{
				kind: "addSearchInput",
				moduleUuid: fx.moduleOne,
				searchInput: {
					...structuredClone(currentInput),
					uuid: testUuid("new-sequence-search-input"),
					name: "other",
				},
				after: MISSING,
			},
		],
		[
			"move Search input",
			{
				kind: "moveSearchInput",
				moduleUuid: fx.moduleOne,
				uuid: fx.searchInput,
				after: MISSING,
			},
		],
		[
			"add option",
			{
				kind: "addOption",
				fieldUuid: fx.select,
				option: {
					...structuredClone(currentOption),
					uuid: testUuid("new-sequence-option"),
					value: "new",
				},
				after: MISSING,
			},
		],
		[
			"move option",
			{
				kind: "moveOption",
				fieldUuid: fx.select,
				uuid: fx.option,
				after: MISSING,
			},
		],
		[
			"add operation write",
			{
				kind: "updateForm",
				uuid: fx.formOne,
				patch: {},
				caseOperationPatch: {
					operation: "add-write",
					uuid: fx.operation,
					value: { property: "priority", value: literal("high") },
					after: "missing_property",
				},
			},
		],
		[
			"move operation write",
			{
				kind: "updateForm",
				uuid: fx.formOne,
				patch: {},
				caseOperationPatch: {
					operation: "move-write",
					uuid: fx.operation,
					property: "status",
					after: "missing_property",
				},
			},
		],
		[
			"add operation link",
			{
				kind: "updateForm",
				uuid: fx.formOne,
				patch: {},
				caseOperationPatch: {
					operation: "add-link",
					uuid: fx.operation,
					value: {
						identifier: "host",
						targetType: "household",
						target: null,
						relationship: "child",
					},
					after: "missing_link",
				},
			},
		],
		[
			"move operation link",
			{
				kind: "updateForm",
				uuid: fx.formOne,
				patch: {},
				caseOperationPatch: {
					operation: "move-link",
					uuid: fx.operation,
					identifier: "parent",
					after: "missing_link",
				},
			},
		],
		[
			"move operation",
			{
				kind: "updateForm",
				uuid: fx.formOne,
				patch: {},
				caseOperationPatch: {
					operation: "move",
					uuid: fx.operation,
					after: MISSING,
				},
			},
		],
	];
}

describe("mutation sequence admission", () => {
	const shared = fixture();
	it.each(missingAnchorMutations(shared))(
		"rejects a missing logical neighbor for %s on every live commit surface",
		(_label, mutation) => {
			const { doc } = shared;
			const admission = mutationSequenceAdmissionIssue(doc, [mutation]);
			expect(admission?.anchor).not.toBeUndefined();
			expect(mutationTargetsInvalid(doc, [mutation])).toBe(true);
			const verdict = mutationCommitVerdict(
				doc,
				[mutation],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok).toBe(false);
			if (verdict.ok) return;
			expect(verdict.findings.map((finding) => finding.code)).toEqual([
				"MUTATION_SEQUENCE_ANCHOR_INVALID",
			]);
		},
	);

	it("rejects a neighbor that exists in a different collection", () => {
		const fx = fixture();
		const mutation: Mutation = {
			kind: "moveForm",
			uuid: fx.formOne,
			toModuleUuid: fx.moduleOne,
			after: fx.formTwo,
		};
		expect(mutationSequenceAdmissionIssue(fx.doc, [mutation])).toMatchObject({
			anchor: fx.formTwo,
		});
	});

	it("accepts an anchor introduced earlier in the same batch", () => {
		const fx = fixture();
		const first = testUuid("same-batch-first-module");
		const second = testUuid("same-batch-second-module");
		const mutations: Mutation[] = [
			{
				kind: "addModule",
				module: { uuid: first, id: "first_new", name: "First new module" },
				after: fx.moduleOne,
			},
			{
				kind: "addModule",
				module: { uuid: second, id: "second_new", name: "Second new module" },
				after: first,
			},
		];
		expect(mutationSequenceAdmissionIssue(fx.doc, mutations)).toBeUndefined();
		expect(mutationTargetsInvalid(fx.doc, mutations)).toBe(false);
	});

	it("interprets module anchors within the selected sibling group", () => {
		const fx = fixture();
		fx.doc.modules[fx.moduleTwo].parentModuleUuid = fx.moduleOne;

		const historicalMove: Mutation = {
			kind: "moveModule",
			uuid: fx.moduleTwo,
			after: null,
		};
		expect(
			mutationSequenceAdmissionIssue(fx.doc, [historicalMove]),
		).toBeUndefined();
		expect(mutationTargetsInvalid(fx.doc, [historicalMove])).toBe(false);

		const crossGroupAnchor: Mutation = {
			kind: "moveModule",
			uuid: fx.moduleTwo,
			after: fx.moduleOne,
		};
		expect(
			mutationSequenceAdmissionIssue(fx.doc, [crossGroupAnchor]),
		).toMatchObject({ anchor: fx.moduleOne });
	});

	it("refuses nested parents and parent removal races in batch order", () => {
		const fx = fixture();
		fx.doc.modules[fx.moduleTwo].parentModuleUuid = fx.moduleOne;
		const grandchild = testUuid("nested-grandchild-module");
		const newborn = testUuid("racing-newborn-child-module");

		expect(
			mutationTargetsInvalid(fx.doc, [
				{
					kind: "addModule",
					module: {
						uuid: grandchild,
						id: "grandchild",
						name: "Grandchild",
						parentModuleUuid: fx.moduleTwo,
					},
				},
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(fx.doc, [
				{ kind: "removeModule", uuid: fx.moduleOne },
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(fx.doc, [
				{ kind: "removeModule", uuid: fx.moduleTwo },
				{
					kind: "addModule",
					module: {
						uuid: newborn,
						id: "newborn",
						name: "Newborn",
						parentModuleUuid: fx.moduleOne,
					},
				},
				{ kind: "removeModule", uuid: fx.moduleOne },
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(fx.doc, [
				{ kind: "removeModule", uuid: fx.moduleTwo },
				{
					kind: "addModule",
					module: {
						uuid: newborn,
						id: "newborn",
						name: "Newborn",
						parentModuleUuid: fx.moduleOne,
					},
				},
				{ kind: "removeModule", uuid: newborn },
				{ kind: "removeModule", uuid: fx.moduleOne },
			]),
		).toBe(false);
		expect(
			mutationTargetsInvalid(fx.doc, [
				{
					kind: "moveModule",
					uuid: fx.moduleTwo,
					parentModuleUuid: null,
					after: fx.moduleOne,
				},
				{ kind: "removeModule", uuid: fx.moduleOne },
			]),
		).toBe(false);
	});

	it("keeps operation birth as the one explicit append-only sequence arm", () => {
		const fx = fixture();
		const operation = caseOperationSchema.parse({
			uuid: testUuid("append-operation"),
			id: "update_patient",
			action: "create",
			caseType: "patient",
			target: { kind: "new" },
			name: literal("Patient"),
		});
		const mutation: Mutation = {
			kind: "updateForm",
			uuid: fx.formOne,
			patch: {},
			caseOperationChange: { operation: "add", value: operation },
		};
		expect(mutationSchema.safeParse(mutation).success).toBe(true);
		expect(mutationSequenceAdmissionIssue(fx.doc, [mutation])).toBeUndefined();
		expect(
			MUTATION_SEQUENCE_INVENTORY.filter(
				(entry) => entry.mode === "intentional-append",
			),
		).toEqual([
			{
				path: "updateForm.caseOperationChange.add",
				mode: "intentional-append",
			},
		]);
	});
});

function unwrap(schema: unknown): z.ZodType {
	let current: unknown = schema;
	while (
		current instanceof z.ZodOptional ||
		current instanceof z.ZodNullable ||
		current instanceof z.ZodDefault
	) {
		current = current.unwrap();
	}
	return current as z.ZodType;
}

function literalString(schema: unknown): string | undefined {
	const current = schema === undefined ? undefined : unwrap(schema);
	if (!(current instanceof z.ZodLiteral)) return undefined;
	const values = [...current.values];
	return typeof values[0] === "string" ? values[0] : undefined;
}

function schemaAfterPaths(
	schema: unknown,
	prefix: readonly string[],
): string[] {
	const current = unwrap(schema);
	if (current instanceof z.ZodUnion) {
		return current.options.flatMap((option) =>
			schemaAfterPaths(option, prefix),
		);
	}
	if (!(current instanceof z.ZodObject)) return [];
	const operation = literalString(current.shape.operation);
	const at = operation === undefined ? [...prefix] : [...prefix, operation];
	const paths: string[] = [];
	for (const [key, value] of Object.entries(current.shape)) {
		if (key === "kind" || key === "operation") continue;
		if (key === "after" || key === "afterInList" || key === "afterInDetail") {
			paths.push([...at, key].join("."));
		} else {
			paths.push(...schemaAfterPaths(value, [...at, key]));
		}
	}
	return paths;
}

describe("sequence inventory parity", () => {
	it("classifies every schema-declared logical-neighbor path", () => {
		const schemaPaths = new Set<string>();
		for (const arm of mutationSchema.options) {
			const current = unwrap(arm);
			if (current instanceof z.ZodUnion) {
				for (const option of current.options) {
					const object = unwrap(option);
					if (!(object instanceof z.ZodObject)) continue;
					const kind = literalString(object.shape.kind);
					if (kind !== undefined) {
						for (const path of schemaAfterPaths(object, [kind])) {
							schemaPaths.add(path);
						}
					}
				}
				continue;
			}
			if (!(current instanceof z.ZodObject)) continue;
			const kind = literalString(current.shape.kind);
			if (kind === undefined) continue;
			for (const path of schemaAfterPaths(current, [kind])) {
				schemaPaths.add(path);
			}
		}
		const inventoryPaths = MUTATION_SEQUENCE_INVENTORY.filter(
			(entry) => entry.mode !== "intentional-append",
		).map((entry) => entry.path);
		expect([...schemaPaths].sort()).toEqual([...inventoryPaths].sort());
	});
});
