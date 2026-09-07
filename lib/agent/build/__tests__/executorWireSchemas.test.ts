/** Offline executor grammar admission. These tests validate complete provider
 * payloads and canonical parsing; they do not claim provider acceptance or a
 * persisted tool dispatch. */
import Ajv from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import {
	expectAdmittedDoc,
	surveyFixture,
} from "@/lib/agent/__tests__/admittedFixture";
import { sharedHandleDeclarer } from "@/lib/agent/change-set/handleDeclarations";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import { proseText } from "@/lib/domain/prose";
import { buildExecutorTools } from "../executorLoop";
import {
	executorCatalogDefaultHandleIssue,
	executorCreationHandleIssue,
	executorWireToolSchema,
} from "../executorWireSchemas";

const uuid = "11111111-1111-4111-8111-111111111111";
const lookup = "018f0000-0000-7000-8000-000000000001";
const h = (handle: string) => ({ handle });
const address = {
	moduleUuid: h("@patients"),
	formUuid: h("@visit"),
	fieldUuid: h("@risk"),
};
const option = (name: string) => ({
	optionUuid: h(`@${name}`),
	value: name,
	label: proseText(name),
});
function moduleInput() {
	return {
		moduleUuid: h("@patients"),
		name: "Patients",
		case_type: "patient",
		forms: [
			{
				formUuid: h("@register"),
				name: "Register",
				type: "registration",
				fields: [
					{
						fieldUuid: h("@name"),
						id: "name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						fieldUuid: h("@risk"),
						id: "risk",
						kind: "single_select",
						label: proseText("Risk"),
						optionsSource: {
							kind: "inline",
							options: [option("routine"), option("priority")],
						},
					},
				],
			},
		],
		case_list_columns: [
			{
				columnUuid: h("@name_column"),
				kind: "plain",
				field: "case_name",
				header: "Name",
			},
		],
	};
}
let surface: ReturnType<typeof buildExecutorTools>;
const validators = new Map<string, ReturnType<Ajv["compile"]>>();
beforeAll(() => {
	surface = buildExecutorTools();
});
function admits(name: string, input: unknown) {
	let validate = validators.get(name);
	if (!validate) {
		validate = new Ajv({ strict: false }).compile(surface[name].inputSchema);
		validators.set(name, validate);
	}
	return {
		valid: validate(JSON.parse(JSON.stringify(input))),
		errors: validate.errors,
	};
}
function expectAdmission(name: string, input: unknown) {
	const result = admits(name, input);
	expect(result.valid, JSON.stringify(result.errors)).toBe(true);
}

describe("executor creation grammar", () => {
	it("admits coherent nested creation and binds only its declared identities", () => {
		const input = moduleInput();
		expectAdmission("createModule", input);
		expect(executorCreationHandleIssue("createModule", input)).toBeNull();
		expect(sharedHandleDeclarer("createModule")?.(input)).toEqual([
			{ handle: "@patients", entityKind: "module" },
			{ handle: "@register", entityKind: "form" },
			{ handle: "@name", entityKind: "field" },
			{ handle: "@risk", entityKind: "field" },
			{ handle: "@routine", entityKind: "option" },
			{ handle: "@priority", entityKind: "option" },
			{ handle: "@name_column", entityKind: "case_list_column" },
		]);
	});
	it.each([
		["moduleUuid"],
		["forms", 0, "formUuid"],
		["forms", 0, "fields", 0, "fieldUuid"],
		["forms", 0, "fields", 1, "optionsSource", "options", 1, "optionUuid"],
		["case_list_columns", 0, "columnUuid"],
	])(
		"refuses missing, canonical, malformed and extended handles at %j",
		(...path) => {
			for (const value of [
				undefined,
				uuid,
				null,
				{ handle: "risk" },
				{ handle: "@risk", extra: true },
			]) {
				const input = JSON.parse(JSON.stringify(moduleInput()));
				expectAdmission("createModule", input);
				let target = input;
				for (const key of path.slice(0, -1)) target = target[key];
				target[path[path.length - 1]] = value;
				expect(admits("createModule", input).valid).toBe(false);
				expect(executorCreationHandleIssue("createModule", input)).toBe(
					`input.${path.join(".")} must declare a durable handle.`,
				);
			}
		},
	);
	it("requires handles in replacement-created columns and select options", () => {
		const columns = {
			moduleUuid: h("@patients"),
			case_list_columns: moduleInput().case_list_columns,
		};
		const choices = {
			...address,
			source: {
				kind: "inline",
				options: [option("routine"), option("priority")],
			},
		};
		expectAdmission("updateModule", columns);
		expectAdmission("setFieldOptionsSource", choices);
		const badColumn = JSON.parse(JSON.stringify(columns));
		badColumn.case_list_columns[0].columnUuid = uuid;
		const badChoice = JSON.parse(JSON.stringify(choices));
		badChoice.source.options[0].optionUuid = uuid;
		expect(admits("updateModule", badColumn).valid).toBe(false);
		expect(admits("setFieldOptionsSource", badChoice).valid).toBe(false);
	});
	it.each([uuid, h("@existing")])(
		"admits existing entity references %j and nullable root placement",
		(reference) => {
			expectAdmission("moveField", {
				moduleUuid: reference,
				formUuid: reference,
				fieldUuid: reference,
				parentUuid: null,
			});
			expectAdmission("moveField", { ...address, beforeFieldUuid: reference });
			expectAdmission("moveField", {
				...address,
				afterFieldUuid: reference,
				parentUuid: reference,
			});
			expect(
				admits("moveField", { ...address, beforeFieldUuid: { handle: "bad" } })
					.valid,
			).toBe(false);
		},
	);
});

describe("external identity and canonical parser boundaries", () => {
	it("keeps media assets canonical while field addresses accept handles", () => {
		const input = {
			attachments: [{ ...address, slot: "label", media: { image: uuid } }],
		};
		expectAdmission("attachFieldMedia", input);
		expect(
			admits("attachFieldMedia", {
				attachments: [
					{ ...input.attachments[0], media: { image: h("@image") } },
				],
			}).valid,
		).toBe(false);
	});
	it.each(["existing-project-lookup", "designed-project-lookup"])(
		"admits exact accepted %s sources, without offering handles for table or columns",
		(kind) => {
			const source = {
				kind,
				tableId: lookup,
				valueColumnId: lookup,
				labelColumnId: lookup,
			};
			expectAdmission("setFieldOptionsSource", { ...address, source });
			for (const key of ["tableId", "valueColumnId", "labelColumnId"])
				expect(
					admits("setFieldOptionsSource", {
						...address,
						source: { ...source, [key]: h("@external") },
					}).valid,
				).toBe(false);
			expect(
				admits("setFieldOptionsSource", {
					...address,
					source: { ...source, kind: "lookup" },
				}).valid,
			).toBe(false);
		},
	);
	it("leaves chat grammar and original canonical parsing unchanged after private projection", async () => {
		const entry = CHANGE_SET_TOOL_REGISTRY.get("createModule");
		if (!entry) throw new Error("Missing creator");
		const chat = wireToolSchema(entry.tool.inputSchema);
		const before = structuredClone(chat.jsonSchema);
		const privateSchema = executorWireToolSchema(
			"createModule",
			entry.tool.inputSchema,
		);
		// Mutating the returned private tree must not mutate the cached chat tree.
		privateSchema.description = "Private caller annotation";
		const privateName = privateSchema.properties?.name;
		if (!privateName || typeof privateName !== "object")
			throw new Error("Missing private name schema");
		privateName.description = "Private nested annotation";
		expect(chat.jsonSchema).toEqual(before);
		const input = moduleInput();
		const canonical = JSON.parse(JSON.stringify(input), (_key, value) =>
			value &&
			typeof value === "object" &&
			Object.keys(value).length === 1 &&
			typeof value.handle === "string"
				? uuid
				: value,
		);
		const chatGrammar = new Ajv({ strict: false }).compile(chat.jsonSchema);
		expect(chatGrammar(canonical), JSON.stringify(chatGrammar.errors)).toBe(
			true,
		);
		expect(chatGrammar(input)).toBe(false);
		const parsedCanonical = await chat.validate?.(canonical);
		expect(parsedCanonical?.success, JSON.stringify(parsedCanonical)).toBe(
			true,
		);
		expect((await chat.validate?.(input))?.success).toBe(false);
		expect(admits("createModule", canonical).valid).toBe(false);
	});
});

describe("catalog default declaration guard", () => {
	it.each(["addFields", "createForm", "createModule"])(
		"requires explicit option identities for %s inferred selects",
		(name) => {
			const doc = surveyFixture();
			doc.caseTypes = [
				{
					name: "patient",
					properties: [
						{
							name: "risk",
							label: proseText("Risk"),
							data_type: "single_select",
							options: [
								{ value: "routine", label: proseText("Routine") },
								{ value: "priority", label: proseText("Priority") },
							],
						},
					],
				},
			];
			expectAdmittedDoc(doc);
			const wrap = (field: unknown) =>
				name === "createModule"
					? { forms: [{ fields: [field] }] }
					: { fields: [field] };
			const field = {
				fieldUuid: h("@risk"),
				id: "risk",
				caseWrite: { caseType: "patient", property: "risk" },
			};
			for (const kind of [undefined, null, "single_select", "multi_select"])
				for (const optionsSource of [undefined, null])
					expect(
						executorCatalogDefaultHandleIssue(
							name,
							wrap({ ...field, kind, optionsSource }),
							doc,
						),
					).toBe(
						"input field 0 writes select property patient.risk; pass its catalog options as an explicit inline optionsSource and give every optionUuid a durable handle.",
					);
			expect(
				executorCatalogDefaultHandleIssue(
					name,
					wrap({ ...field, kind: "text" }),
					doc,
				),
			).toBeNull();
			expect(
				executorCatalogDefaultHandleIssue(
					name,
					wrap({
						...field,
						optionsSource: {
							kind: "inline",
							options: [option("routine"), option("priority")],
						},
					}),
					doc,
				),
			).toBeNull();
			expect(
				executorCatalogDefaultHandleIssue(
					name,
					wrap({
						...field,
						caseWrite: { caseType: "patient", property: "case_name" },
					}),
					doc,
				),
			).toBeNull();
		},
	);
});
