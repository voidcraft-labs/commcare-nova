import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	normalizeBlueprintOwnRecords,
	toRscSerializableDoc,
} from "@/lib/doc/ownRecords";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	plainColumn,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("prototype-module");
const FORM = testUuid("prototype-form");
const FIELD = testUuid("prototype-status");
const PROPERTY = testUuid("prototype-property");
const ROLE = testUuid("prototype-role");
const PERSONA = testUuid("prototype-persona");
const AUTOMATION = testUuid("prototype-automation");

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("prototype-column"), "case_name", "Name"),
					],
					listColumnOrder: [testUuid("prototype-column")],
					detailColumnOrder: [testUuid("prototype-column")],
					searchInputs: [],
				},
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: FIELD,
								id: "visit_status",
								kind: "text",
								label: proseText("Status"),
								caseWrite: { caseType: "patient", property: "visit_status" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "visit_status", label: proseText("Status") }],
			},
		],
	});
	doc.userProperties = {
		[PROPERTY]: { uuid: PROPERTY, slug: "region", label: "Region" },
	};
	doc.userPropertyOrder = [PROPERTY];
	doc.userTypes = {
		[ROLE]: { uuid: ROLE, name: "Worker", values: { [PROPERTY]: "north" } },
	};
	doc.userTypeOrder = [ROLE];
	doc.personas = {
		[PERSONA]: {
			uuid: PERSONA,
			name: "Asha",
			userTypeUuid: ROLE,
			values: { [PROPERTY]: "south" },
		},
	};
	doc.personaOrder = [PERSONA];
	doc.automations = {
		[AUTOMATION]: {
			uuid: AUTOMATION,
			kind: "case-update",
			name: "Close completed cases",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [],
			closeCase: true,
		},
	};
	doc.automationOrder = [AUTOMATION];
	assertAdmittedDoc(doc);
	return doc;
}

function ownRecords(doc: BlueprintDoc): object[] {
	return [
		doc.modules,
		doc.forms,
		doc.fields,
		doc.formOrder,
		doc.fieldOrder,
		doc.fieldParent,
		doc.userProperties,
		doc.userTypes,
		doc.personas,
		doc.automations,
		doc.userTypes?.[ROLE]?.values,
		doc.personas?.[PERSONA]?.values,
	].map((record) => {
		if (record === undefined) throw new Error("expected fixture record");
		return record;
	});
}

function expectOwnOnly(records: object[]): void {
	for (const record of records) {
		expect(Object.getPrototypeOf(record)).toBeNull();
		expect("constructor" in record).toBe(false);
		expect("toString" in record).toBe(false);
	}
}

describe("prototype-safe document boundaries", () => {
	it("starts a new store without inherited record membership", () => {
		const doc = createBlueprintDocStore().getState();
		expectOwnOnly([
			doc.modules,
			doc.forms,
			doc.fields,
			doc.formOrder,
			doc.fieldOrder,
			doc.fieldParent,
		]);
	});

	it.each(["__proto__", "constructor", "toString"])(
		"refuses %s as an authored identity",
		(uuid) => {
			expect(() =>
				mutationSchema.parse({
					kind: "addModule",
					module: { uuid, id: "module", name: "Module" },
				}),
			).toThrow(/canonical lowercase RFC UUID/);
		},
	);

	it("hydrates actual JSON without mutating the stored snapshot and derives parent identity", () => {
		const persisted = blueprintDocSchema.parse(
			JSON.parse(JSON.stringify(toPersistableDoc(fixture()))),
		);
		const bytes = JSON.stringify(persisted);
		const hydrated = hydratePersistedBlueprint(persisted);
		assertAdmittedDoc(hydrated);
		expectOwnOnly(ownRecords(hydrated));
		expect(hydrated.fieldParent[FIELD]).toBe(FORM);
		expect(hydrated.userTypes?.[ROLE]?.values?.[PROPERTY]).toBe("north");
		expect(hydrated.personas?.[PERSONA]?.values?.[PROPERTY]).toBe("south");
		expect(JSON.stringify(persisted)).toBe(bytes);
		expect(hydrated.fields[FIELD]).not.toBe(persisted.fields[FIELD]);
	});

	it("projects ordinary transport records and restores own-only membership on client hydration", () => {
		const normalized = hydratePersistedBlueprint(toPersistableDoc(fixture()));
		const transport = toRscSerializableDoc(toPersistableDoc(normalized));
		for (const record of [
			transport.modules,
			transport.forms,
			transport.fields,
			transport.formOrder,
			transport.fieldOrder,
			transport.userProperties,
			transport.userTypes,
			transport.personas,
			transport.automations,
			transport.userTypes?.[ROLE]?.values,
			transport.personas?.[PERSONA]?.values,
		]) {
			expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
		}
		expect(transport).toEqual(toPersistableDoc(normalized));
		expect(transport.fields[FIELD]).not.toBe(normalized.fields[FIELD]);
		expectOwnOnly(ownRecords(normalized));
		expectOwnOnly(ownRecords(hydratePersistedBlueprint(transport)));
	});

	it("normalizes ordinary nested mutation payload records at actual admission and reduction", () => {
		const doc = fixture();
		const secondRole = testUuid("second-role");
		const command = {
			kind: "addUserType" as const,
			userType: {
				uuid: secondRole,
				name: "Supervisor",
				values: { [PROPERTY]: "east" },
			},
		};
		expect(Object.getPrototypeOf(command.userType.values)).toBe(
			Object.prototype,
		);
		const verdict = mutationCommitVerdict(
			doc,
			[command],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok, JSON.stringify(verdict.ok ? [] : verdict.findings)).toBe(
			true,
		);
		if (!verdict.ok)
			throw new Error(JSON.stringify(verdict.ok ? [] : verdict.findings));
		const next = produce(doc, (draft) => {
			applyMutations(draft, [command]);
		});
		assertAdmittedDoc(next);
		expectOwnOnly(ownRecords(next));
		expect(
			Object.getPrototypeOf(next.userTypes?.[secondRole]?.values),
		).toBeNull();
		expect(next.userTypes?.[secondRole]?.values?.[PROPERTY]).toBe("east");
		expect(Object.getPrototypeOf(command.userType.values)).toBe(
			Object.prototype,
		);
	});

	it("preserves hostile own keys at the lower-level normalizer while admission refuses them", () => {
		// Deliberately malformed data exercises the generic record boundary; it is
		// never presented as a reachable authored app or as a valid UUID fixture.
		const doc = fixture();
		const values = Object.fromEntries([
			["__proto__", "north"],
			["constructor", "south"],
		]);
		doc.userTypes = { [ROLE]: { uuid: ROLE, name: "Worker", values } };
		expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
			false,
		);
		normalizeBlueprintOwnRecords(doc);
		const stored = doc.userTypes[ROLE].values;
		expect(Object.getPrototypeOf(stored)).toBeNull();
		expect(Object.hasOwn(stored ?? {}, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(stored ?? {}, "__proto__")?.value,
		).toBe("north");
		expect(stored?.constructor).toBe("south");
		expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
	});
});
