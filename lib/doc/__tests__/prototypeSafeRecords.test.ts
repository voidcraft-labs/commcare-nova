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
		label: id,
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

	it.each([
		{
			label: "module",
			moduleUuid: "__proto__",
			formUuid: "ordinary-form",
			fieldUuid: "ordinary-field",
		},
		{
			label: "form",
			moduleUuid: "ordinary-module",
			formUuid: "constructor",
			fieldUuid: "ordinary-field",
		},
		{
			label: "field __proto__",
			moduleUuid: "ordinary-module",
			formUuid: "ordinary-form",
			fieldUuid: "__proto__",
		},
		{
			label: "field constructor",
			moduleUuid: "ordinary-module",
			formUuid: "ordinary-form",
			fieldUuid: "constructor",
		},
	])(
		"applies mutationSchema-admitted $label identities as own members",
		({ moduleUuid, formUuid, fieldUuid }) => {
			const mutations = parsed([
				{ kind: "addModule", module: module_(moduleUuid) },
				{
					kind: "addForm",
					moduleUuid,
					form: form_(formUuid),
				},
				{
					kind: "addField",
					parentUuid: formUuid,
					field: textField(fieldUuid),
				},
			]);

			const next = fold(emptyDoc(), mutations);

			expect(Object.hasOwn(next.modules, moduleUuid)).toBe(true);
			expect(Object.hasOwn(next.formOrder, moduleUuid)).toBe(true);
			expect(Object.hasOwn(next.forms, formUuid)).toBe(true);
			expect(Object.hasOwn(next.fieldOrder, formUuid)).toBe(true);
			expect(Object.hasOwn(next.fields, fieldUuid)).toBe(true);
			expect(Object.hasOwn(next.fieldParent, fieldUuid)).toBe(true);
			expect(next.fieldParent[testUuid(fieldUuid)]).toBe(formUuid);
			for (const record of [
				next.modules,
				next.forms,
				next.fields,
				next.formOrder,
				next.fieldOrder,
				next.fieldParent,
			]) {
				expectNullPrototype(record);
			}
		},
	);

	it("hydrates JSON records with own membership and derived parents intact", () => {
		const mutations = parsed([
			{ kind: "addModule", module: module_("ordinary-module") },
			{
				kind: "addForm",
				moduleUuid: "ordinary-module",
				form: form_("constructor"),
			},
			{
				kind: "addField",
				parentUuid: "constructor",
				field: textField("__proto__", "status"),
			},
			{
				kind: "addUserProperty",
				property: {
					uuid: "__proto__",
					slug: "region",
					label: "Region",
				},
			},
			{
				kind: "addUserType",
				userType: {
					uuid: "constructor",
					name: "Worker",
					values: Object.fromEntries([["__proto__", "north"]]),
				},
			},
			{
				kind: "addPersona",
				persona: {
					uuid: "toString",
					name: "Asha",
					userTypeUuid: "constructor",
					values: Object.fromEntries([["__proto__", "south"]]),
				},
			},
		]);
		const applied = fold(emptyDoc(), mutations);
		const persisted = JSON.parse(
			JSON.stringify(toPersistableDoc(applied)),
		) as ReturnType<typeof toPersistableDoc>;

		const hydrated = hydratePersistedBlueprint(persisted);

		expect(Object.hasOwn(hydrated.forms, "constructor")).toBe(true);
		expect(Object.hasOwn(hydrated.fields, "__proto__")).toBe(true);
		expect(Object.hasOwn(hydrated.fieldParent, "__proto__")).toBe(true);
		expect(hydrated.fieldParent[testUuid("__proto__")]).toBe("constructor");
		expect(
			Object.hasOwn(
				hydrated.userTypes?.[testUuid("constructor")]?.values ?? {},
				"__proto__",
			),
		).toBe(true);
		expect(
			Object.hasOwn(
				hydrated.personas?.[testUuid("toString")]?.values ?? {},
				"__proto__",
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
			hydrated.userTypes?.[testUuid("constructor")]?.values,
			hydrated.personas?.[testUuid("toString")]?.values,
		]) {
			expectNullPrototype(record);
		}
	});

	it("uses ordinary records across React Flight, then restores own-only records on hydration", () => {
		const applied = fold(
			emptyDoc(),
			parsed([
				{ kind: "addModule", module: module_("__proto__") },
				{
					kind: "addUserProperty",
					property: {
						uuid: "constructor",
						slug: "region",
						label: "Region",
					},
				},
				{
					kind: "addUserType",
					userType: {
						uuid: "worker",
						name: "Worker",
						values: Object.fromEntries([["constructor", "north"]]),
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
		expect(
			Object.getPrototypeOf(
				transport.userTypes?.[testUuid("worker")]?.values ?? {},
			),
		).toBe(Object.prototype);
		expect(Object.hasOwn(transport.modules, "__proto__")).toBe(true);
		expect(Object.hasOwn(transport.userProperties ?? {}, "constructor")).toBe(
			true,
		);
		expect(
			Object.hasOwn(
				transport.userTypes?.[testUuid("worker")]?.values ?? {},
				"constructor",
			),
		).toBe(true);
		expectNullPrototype(normalized.modules);

		const hydrated = hydratePersistedBlueprint(transport);
		expectNullPrototype(hydrated.modules);
		expectNullPrototype(hydrated.userProperties);
		expectNullPrototype(hydrated.userTypes);
		expectNullPrototype(hydrated.userTypes?.[testUuid("worker")]?.values);
	});

	it("diffs and replays special-key structural additions", () => {
		const mutations = parsed([
			{ kind: "addModule", module: module_("ordinary-module") },
			{
				kind: "addForm",
				moduleUuid: "ordinary-module",
				form: form_("ordinary-form"),
			},
			{
				kind: "addField",
				parentUuid: "ordinary-form",
				field: textField("__proto__", "prototype"),
			},
			{
				kind: "addField",
				parentUuid: "ordinary-form",
				field: textField("constructor", "constructor"),
			},
		]);
		const before = emptyDoc();
		const desired = fold(before, mutations);

		const replayed = fold(before, diffDocsToMutations(before, desired));

		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(desired));
		expect(Object.hasOwn(replayed.fields, "__proto__")).toBe(true);
		expect(Object.hasOwn(replayed.fields, "constructor")).toBe(true);
	});

	it("prints the current field id and derived parent path after rename and move", () => {
		const initial = fold(
			emptyDoc(),
			parsed([
				{ kind: "addModule", module: module_("ordinary-module") },
				{
					kind: "addForm",
					moduleUuid: "ordinary-module",
					form: form_("ordinary-form"),
				},
				{
					kind: "addField",
					parentUuid: "ordinary-form",
					field: {
						uuid: "constructor",
						kind: "group",
						id: "group",
						label: "Group",
					},
				},
				{
					kind: "addField",
					parentUuid: "ordinary-form",
					field: textField("__proto__", "status"),
				},
			]),
		);
		const moved = fold(
			initial,
			parsed([
				{
					kind: "renameField",
					uuid: "__proto__",
					newId: "current_status",
				},
				{
					kind: "moveField",
					uuid: "__proto__",
					toParentUuid: "constructor",
					after: null,
				},
			]),
		);
		const printable = toPersistableDoc(moved);

		expect(
			printXPath(
				{ parts: [{ kind: "field-ref", uuid: testUuid("__proto__") }] },
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
						...module_("ordinary-module"),
						caseType: "patient",
					},
				},
				{
					kind: "addForm",
					moduleUuid: "ordinary-module",
					form: form_("ordinary-form"),
				},
				{
					kind: "addField",
					parentUuid: "ordinary-form",
					field: {
						...textField("constructor", "status"),
						case_property_on: "patient",
					},
				},
				{
					kind: "addField",
					parentUuid: "ordinary-form",
					field: {
						...textField("__proto__", "watcher"),
						label: "See #form/status and #case/status",
						relevant: {
							parts: [
								{
									kind: "field-ref",
									uuid: "constructor",
								},
							],
						},
					},
				},
			]),
		);

		expect(declarersOf(next, "patient", "status")).toEqual(["constructor"]);
		expect(
			referencingCarrierUuids(next, entityTargetKey("constructor")),
		).toEqual(["__proto__"]);
		const rebuilt = buildReferenceIndex(next);
		expect(next.refIndex).toEqual(rebuilt);

		for (const index of [next.refIndex, rebuilt]) {
			expect(index).toBeDefined();
			if (index === undefined) throw new Error("reference index missing");
			for (const record of [
				index.in,
				index.out,
				index.decl,
				index.local,
				index.ctx,
			]) {
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
			for (const bucket of [index.decl, index.local, index.ctx]) {
				for (const members of Object.values(bucket)) {
					expectNullPrototype(members);
				}
			}
		}
	});
});
