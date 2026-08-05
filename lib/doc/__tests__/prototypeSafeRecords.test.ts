import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { toRscSerializableDoc } from "@/lib/doc/ownRecords";
import {
	buildReferenceIndex,
	declarersOf,
	referencingCarrierUuids,
} from "@/lib/doc/referenceIndex";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	entityTargetKey,
	type Field,
	type Form,
	type Module,
	printXPath,
	xpathPrintContext,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function emptyDoc(): BlueprintDoc {
	return {
		appId: "prototype-safe-records",
		appName: "Prototype-safe records",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

function module_(uuid: string): Module {
	return { uuid: testUuid(uuid), id: "module", name: `Module ${uuid}` };
}

function form_(uuid: string): Form {
	return {
		uuid: testUuid(uuid),
		id: "form",
		name: `Form ${uuid}`,
		type: "survey",
	};
}

function textField(uuid: string, id = uuid): Field {
	return {
		uuid: testUuid(uuid),
		kind: "text",
		id,
		label: proseText(id),
	};
}

function parsed(raw: unknown[]): Mutation[] {
	return raw.map((mutation) => mutationSchema.parse(mutation));
}

function fold(doc: BlueprintDoc, mutations: readonly Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

function expectNullPrototype(record: object | undefined): void {
	expect(record).toBeDefined();
	expect(Object.getPrototypeOf(record as object)).toBeNull();
}

const MODULE_UUID = testUuid("prototype-module");
const FORM_UUID = testUuid("prototype-form");
const GROUP_UUID = testUuid("prototype-group");
const STATUS_UUID = testUuid("prototype-status");
const WATCHER_UUID = testUuid("prototype-watcher");
const USER_PROPERTY_UUID = testUuid("prototype-user-property");
const USER_TYPE_UUID = testUuid("prototype-user-type");
const PERSONA_UUID = testUuid("prototype-persona");
const AUTOMATION_UUID = testUuid("prototype-automation");

describe("prototype-safe normalized blueprint records", () => {
	it("starts a fresh document store with normalized records", () => {
		const state = createBlueprintDocStore().getState();
		for (const record of [
			state.modules,
			state.forms,
			state.fields,
			state.formOrder,
			state.fieldOrder,
			state.fieldParent,
		]) {
			expectNullPrototype(record);
		}
	});

	it("normalizes an in-process mutation's ordinary nested value bag", () => {
		const values = Object.fromEntries([
			["__proto__", "north"],
			["constructor", "south"],
		]);
		expect(Object.getPrototypeOf(values)).toBe(Object.prototype);

		const next = fold(emptyDoc(), [
			{
				kind: "addUserType",
				userType: {
					uuid: testUuid("direct-role"),
					name: "Direct role",
					values,
				},
			},
		]);

		const stored = next.userTypes?.[testUuid("direct-role")]?.values;
		expectNullPrototype(stored);
		expect(Object.hasOwn(stored ?? {}, "__proto__")).toBe(true);
		expect(Object.hasOwn(stored ?? {}, "constructor")).toBe(true);
	});

	it("seeds and rebuilds the derived parent record at a mutation boundary", () => {
		const persisted = toPersistableDoc(emptyDoc());
		const next = fold(persisted as unknown as BlueprintDoc, [
			{ kind: "addModule", module: module_("module-without-fields") },
		]);

		expectNullPrototype(next.fieldParent);
		expect(next.fieldParent).toEqual({});
	});

	it.each(["__proto__", "constructor", "toString"])(
		"rejects the inherited-name identity %s before it can become a record key",
		(uuid) => {
			expect(() =>
				mutationSchema.parse({
					kind: "addModule",
					module: { uuid, id: "module", name: "Module" },
				}),
			).toThrow(/canonical lowercase RFC UUID/);
		},
	);

	it("hydrates JSON records with own membership and derived parents intact", () => {
		const mutations = parsed([
			{ kind: "addModule", module: module_("prototype-module") },
			{
				kind: "addForm",
				moduleUuid: MODULE_UUID,
				form: form_("prototype-form"),
			},
			{
				kind: "addField",
				parentUuid: FORM_UUID,
				field: textField("prototype-status", "status"),
			},
			{
				kind: "addUserProperty",
				property: {
					uuid: USER_PROPERTY_UUID,
					slug: "region",
					label: "Region",
				},
			},
			{
				kind: "addUserType",
				userType: {
					uuid: USER_TYPE_UUID,
					name: "Worker",
					values: Object.fromEntries([[USER_PROPERTY_UUID, "north"]]),
				},
			},
			{
				kind: "addPersona",
				persona: {
					uuid: PERSONA_UUID,
					name: "Asha",
					userTypeUuid: USER_TYPE_UUID,
					values: Object.fromEntries([[USER_PROPERTY_UUID, "south"]]),
				},
			},
		]);
		const applied = fold(emptyDoc(), mutations);
		const persisted = JSON.parse(
			JSON.stringify(toPersistableDoc(applied)),
		) as ReturnType<typeof toPersistableDoc>;

		const hydrated = hydratePersistedBlueprint(persisted);

		expect(Object.hasOwn(hydrated.forms, FORM_UUID)).toBe(true);
		expect(Object.hasOwn(hydrated.fields, STATUS_UUID)).toBe(true);
		expect(Object.hasOwn(hydrated.fieldParent, STATUS_UUID)).toBe(true);
		expect(hydrated.fieldParent[STATUS_UUID]).toBe(FORM_UUID);
		expect(
			Object.hasOwn(
				hydrated.userTypes?.[USER_TYPE_UUID]?.values ?? {},
				USER_PROPERTY_UUID,
			),
		).toBe(true);
		expect(
			Object.hasOwn(
				hydrated.personas?.[PERSONA_UUID]?.values ?? {},
				USER_PROPERTY_UUID,
			),
		).toBe(true);
		for (const record of [
			hydrated.modules,
			hydrated.forms,
			hydrated.fields,
			hydrated.formOrder,
			hydrated.fieldOrder,
			hydrated.fieldParent,
			hydrated.userProperties,
			hydrated.userTypes,
			hydrated.personas,
			hydrated.userTypes?.[USER_TYPE_UUID]?.values,
			hydrated.personas?.[PERSONA_UUID]?.values,
		]) {
			expectNullPrototype(record);
		}
	});

	it("uses ordinary records across React Flight, then restores own-only records on hydration", () => {
		const applied = fold(
			emptyDoc(),
			parsed([
				{ kind: "addModule", module: module_("prototype-module") },
				{
					kind: "addAutomation",
					automation: {
						uuid: AUTOMATION_UUID,
						kind: "case-update",
						name: "Close completed cases",
						caseType: "case",
						criteriaOperator: "all",
						criteria: [],
						setupOnlyCriteria: [],
						updates: [],
						closeCase: true,
					},
				},
				{
					kind: "addUserProperty",
					property: {
						uuid: USER_PROPERTY_UUID,
						slug: "region",
						label: "Region",
					},
				},
				{
					kind: "addUserType",
					userType: {
						uuid: USER_TYPE_UUID,
						name: "Worker",
						values: Object.fromEntries([[USER_PROPERTY_UUID, "north"]]),
					},
				},
			]),
		);
		const normalized = toPersistableDoc(applied);
		const transport = toRscSerializableDoc(normalized);

		expect(Object.getPrototypeOf(transport.modules)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(transport.formOrder)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(transport.userProperties ?? {})).toBe(
			Object.prototype,
		);
		expect(Object.getPrototypeOf(transport.userTypes ?? {})).toBe(
			Object.prototype,
		);
		expect(Object.getPrototypeOf(transport.automations ?? {})).toBe(
			Object.prototype,
		);
		expect(
			Object.getPrototypeOf(
				transport.userTypes?.[USER_TYPE_UUID]?.values ?? {},
			),
		).toBe(Object.prototype);
		expect(Object.hasOwn(transport.modules, MODULE_UUID)).toBe(true);
		expect(
			Object.hasOwn(transport.userProperties ?? {}, USER_PROPERTY_UUID),
		).toBe(true);
		expect(
			Object.hasOwn(
				transport.userTypes?.[USER_TYPE_UUID]?.values ?? {},
				USER_PROPERTY_UUID,
			),
		).toBe(true);
		expect(Object.hasOwn(transport.automations ?? {}, AUTOMATION_UUID)).toBe(
			true,
		);
		expectNullPrototype(normalized.modules);
		expectNullPrototype(normalized.automations);

		const hydrated = hydratePersistedBlueprint(transport);
		expectNullPrototype(hydrated.modules);
		expectNullPrototype(hydrated.userProperties);
		expectNullPrototype(hydrated.userTypes);
		expectNullPrototype(hydrated.userTypes?.[USER_TYPE_UUID]?.values);
		expectNullPrototype(hydrated.automations);
		expect(Object.hasOwn(hydrated.automations ?? {}, AUTOMATION_UUID)).toBe(
			true,
		);
	});

	it("diffs and replays strict-identity structural additions", () => {
		const mutations = parsed([
			{ kind: "addModule", module: module_("prototype-module") },
			{
				kind: "addForm",
				moduleUuid: MODULE_UUID,
				form: form_("prototype-form"),
			},
			{
				kind: "addField",
				parentUuid: FORM_UUID,
				field: textField("prototype-status", "prototype"),
			},
			{
				kind: "addField",
				parentUuid: FORM_UUID,
				field: textField("prototype-watcher", "constructor"),
			},
		]);
		const before = emptyDoc();
		const desired = fold(before, mutations);

		const replayed = fold(before, diffDocsToMutations(before, desired));

		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(desired));
		expect(Object.hasOwn(replayed.fields, STATUS_UUID)).toBe(true);
		expect(Object.hasOwn(replayed.fields, WATCHER_UUID)).toBe(true);
	});

	it("prints the current field id and derived parent path after rename and move", () => {
		const initial = fold(
			emptyDoc(),
			parsed([
				{ kind: "addModule", module: module_("prototype-module") },
				{
					kind: "addForm",
					moduleUuid: MODULE_UUID,
					form: form_("prototype-form"),
				},
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						uuid: GROUP_UUID,
						kind: "group",
						id: "group",
						label: proseText("Group"),
					},
				},
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: textField("prototype-status", "status"),
				},
			]),
		);
		const moved = fold(
			initial,
			parsed([
				{
					kind: "updateField",
					uuid: STATUS_UUID,
					targetKind: "text",
					patch: { id: "current_status" },
				},
				{
					kind: "moveField",
					uuid: STATUS_UUID,
					toParentUuid: GROUP_UUID,
					after: null,
				},
			]),
		);
		const printable = toPersistableDoc(moved);

		expect(
			printXPath(
				{ parts: [{ kind: "field-ref", uuid: STATUS_UUID }] },
				xpathPrintContext(printable),
			),
		).toBe("#form/group/current_status");
	});

	it("keeps rebuild and incremental reference-index buckets own-only", () => {
		const next = fold(
			emptyDoc(),
			parsed([
				{
					kind: "addModule",
					module: {
						...module_("prototype-module"),
						caseType: "patient",
					},
				},
				{
					kind: "addForm",
					moduleUuid: MODULE_UUID,
					form: form_("prototype-form"),
				},
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						...textField("prototype-status", "status"),
						caseWrite: { caseType: "patient", property: "status" },
					},
				},
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						...textField("prototype-watcher", "watcher"),
						label: proseText("See #form/status and #patient/status"),
						relevant: {
							parts: [
								{
									kind: "field-ref",
									uuid: STATUS_UUID,
								},
							],
						},
					},
				},
			]),
		);

		expect(declarersOf(next, "patient", "status")).toEqual([STATUS_UUID]);
		expect(referencingCarrierUuids(next, entityTargetKey(STATUS_UUID))).toEqual(
			[WATCHER_UUID],
		);
		const rebuilt = buildReferenceIndex(next);
		expect(next.refIndex).toEqual(rebuilt);

		for (const index of [next.refIndex, rebuilt]) {
			expect(index).toBeDefined();
			if (index === undefined) throw new Error("reference index missing");
			for (const record of [index.in, index.out, index.decl, index.ctx]) {
				expectNullPrototype(record);
			}
			for (const byCarrier of Object.values(index.in)) {
				expectNullPrototype(byCarrier);
				for (const slots of Object.values(byCarrier)) {
					expectNullPrototype(slots);
				}
			}
			for (const entry of Object.values(index.out)) {
				expectNullPrototype(entry.edges);
				for (const slots of Object.values(entry.edges)) {
					expectNullPrototype(slots);
				}
			}
			for (const bucket of [index.decl, index.ctx]) {
				for (const members of Object.values(bucket)) {
					expectNullPrototype(members);
				}
			}
		}
	});
});
