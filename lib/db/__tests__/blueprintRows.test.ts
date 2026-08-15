// Round-trip fidelity for the entity-row projection — the invariant the
// commit gate, the validator, and the fold check all stand on:
// `assemble(decompose(doc)) ≡ doc`, including the reducer's key-per-parent
// shape (`formOrder[m]` exists EMPTY for a formless module; `fieldOrder[f]`
// for a fieldless form and a childless group/repeat container), which
// decompose can't carry as rows and assemble must re-seed.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import {
	caseListModuleMutations,
	surveyModuleMutations,
} from "@/lib/doc/scaffolds";
import {
	type BlueprintDoc,
	type LookupOptionsSource,
	lookupColumnIdSchema,
	lookupTableIdSchema,
	personasOf,
	userPropertiesOf,
	userTypesOf,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	assembleBlueprint,
	blueprintScalars,
	decomposeBlueprint,
	diffBlueprints,
} from "../blueprintRows";

function emptyDoc(appId: string): BlueprintDoc {
	return {
		appId,
		appName: "Round Trip",
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

function roundTrip(doc: BlueprintDoc) {
	const persistable = toPersistableDoc(doc);
	const rows = decomposeBlueprint(persistable).map((row) => ({
		...row,
		// PostgreSQL jsonb owns entity-row storage. Exercise the same plain-JSON
		// boundary rather than handing assembleBlueprint the original references.
		data: JSON.parse(JSON.stringify(row.data)),
	}));
	return assembleBlueprint(doc.appId, blueprintScalars(persistable), rows);
}

describe("blueprint entity-row round trip", () => {
	it("reproduces a case-list-only module (formless — empty formOrder key survives)", () => {
		const doc = emptyDoc("rt-app-1");
		applyMutations(
			doc,
			caseListModuleMutations(doc, { caseType: "patient" }).mutations,
		);
		const assembled = roundTrip(doc);
		expect(assembled).toEqual(toPersistableDoc(doc));
		// The load-bearing shape detail: the formless module still carries its
		// (empty) membership key, exactly as the reducer left it.
		const moduleUuid = doc.moduleOrder[0];
		expect(assembled.formOrder[moduleUuid]).toEqual([]);
	});

	it("reproduces a survey module (module → form → field chain)", () => {
		const doc = emptyDoc("rt-app-2");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const assembled = roundTrip(doc);
		expect(assembled).toEqual(toPersistableDoc(doc));
	});

	it("round-trips the app-level localization overlay outside entity rows", () => {
		const doc = emptyDoc("rt-app-localization");
		doc.localization = {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "Español", direction: "ltr" },
			},
			translations: { es: {} },
		};
		expect(roundTrip(doc)).toEqual(toPersistableDoc(doc));
	});

	it("preserves a dormant lookup-backed select through entity-row hydration", () => {
		const moduleUuid = testUuid("10000000-0000-4000-8000-000000000001");
		const formUuid = testUuid("20000000-0000-4000-8000-000000000001");
		const fieldUuid = testUuid("30000000-0000-4000-8000-000000000001");
		const tableId = lookupTableIdSchema.parse(
			"018f3e8a-7b2c-7def-8abc-1234567890ab",
		);
		const valueColumnId = lookupColumnIdSchema.parse(
			"018f3e8a-7b2c-7def-8abc-1234567890ad",
		);
		const labelColumnId = lookupColumnIdSchema.parse(
			"018f3e8a-7b2c-7def-8abc-1234567890ae",
		);
		const optionsSource = {
			kind: "lookup",
			tableId,
			valueColumnId,
			labelColumnId,
			filter: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "table-column", tableId, columnId: valueColumnId },
				},
				right: {
					kind: "table-lookup",
					tableId,
					resultColumnId: labelColumnId,
					where: { kind: "match-all" },
				},
			},
		} satisfies LookupOptionsSource;
		const doc: BlueprintDoc = {
			...emptyDoc("rt-app-lookup"),
			modules: {
				[moduleUuid]: {
					uuid: moduleUuid,
					id: "visits",
					name: "Visits",
				},
			},
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "visit",
					name: "Visit",
					type: "survey",
				},
			},
			fields: {
				[fieldUuid]: {
					uuid: fieldUuid,
					id: "status",
					kind: "single_select",
					label: proseText("Status"),
					optionsSource,
				},
			},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [fieldUuid] },
			fieldParent: { [fieldUuid]: formUuid },
		};

		const assembled = roundTrip(doc);
		expect(assembled.fields[fieldUuid]).toMatchObject({ optionsSource });
		expect(assembled).toEqual(toPersistableDoc(doc));
	});

	it("diff of an unchanged doc is empty", () => {
		const doc = emptyDoc("rt-app-3");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const persistable = toPersistableDoc(doc);
		const { upserts, deletedUuids } = diffBlueprints(persistable, persistable);
		expect(upserts).toEqual([]);
		expect(deletedUuids).toEqual([]);
	});

	it("diff is key-order-insensitive (a jsonb round-trip's reorder is not dirty)", () => {
		const doc = emptyDoc("rt-app-4");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const persistable = toPersistableDoc(doc);
		// Simulate jsonb normalization: rebuild with reversed key order.
		const reordered = JSON.parse(
			JSON.stringify(persistable, (_k, v) =>
				v !== null && typeof v === "object" && !Array.isArray(v)
					? Object.fromEntries(Object.entries(v).reverse())
					: v,
			),
		);
		const { upserts, deletedUuids } = diffBlueprints(reordered, persistable);
		expect(upserts).toEqual([]);
		expect(deletedUuids).toEqual([]);
	});

	it("refuses to persist a doc whose form record is missing from every membership array", () => {
		const doc = emptyDoc("rt-app-5");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const persistable = toPersistableDoc(doc);
		const broken = structuredClone(persistable);
		broken.formOrder = Object.fromEntries(
			Object.entries(broken.formOrder).map(([k]) => [k, []]),
		);
		expect(() => decomposeBlueprint(broken)).toThrow(
			/absent from every formOrder membership array/,
		);
	});

	it("refuses a parent on a flat organization row instead of dropping it", () => {
		const levelUuid = testUuid("11111111-1111-4111-8111-111111111111");
		const parentUuid = testUuid("22222222-2222-4222-8222-222222222222");
		const doc = emptyDoc("rt-flat-parent");
		doc.organizationLevels = {
			[levelUuid]: {
				uuid: levelUuid,
				code: "region",
				name: "Region",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
		};
		doc.organizationLevelOrder = [levelUuid];
		const persistable = toPersistableDoc(doc);
		const rows = decomposeBlueprint(persistable).map((row) =>
			row.uuid === levelUuid ? { ...row, parent_uuid: parentUuid } : row,
		);

		expect(() =>
			assembleBlueprint(doc.appId, blueprintScalars(persistable), rows),
		).toThrow(/flat entity.*unexpected parent/);
	});
});

/**
 * The three flat user collections round-trip like any other entity, with
 * one extra rule the others don't need: an app that declares none must
 * assemble to exactly the doc it did before they existed. That is what
 * keeps a tab still running pre-collection code from meeting a shape its
 * strict schema refuses — and it is the reason the doc slots are optional
 * rather than always-present empty records.
 */
describe("the user collections", () => {
	const PROPERTY = testUuid("a1111111-1111-4111-8111-111111111111");
	const TYPE = testUuid("a2222222-2222-4222-8222-222222222222");
	const PERSONA = testUuid("a3333333-3333-4333-8333-333333333333");

	function docWithUsers(): BlueprintDoc {
		const doc = emptyDoc("rt-users");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		applyMutations(doc, [
			{
				kind: "addUserProperty",
				property: {
					uuid: PROPERTY,
					slug: "region",
					label: "Region",
					choices: ["north", "south"],
				},
			},
			{
				kind: "addUserType",
				userType: {
					uuid: TYPE,
					name: "CHW",
					values: { [PROPERTY]: "north" },
				},
			},
			{
				kind: "addPersona",
				persona: {
					uuid: PERSONA,
					name: "Asha",
					userTypeUuid: TYPE,
					values: { [PROPERTY]: "south" },
				},
			},
		]);
		return doc;
	}

	it("round-trips all three through their own row kinds", () => {
		const doc = docWithUsers();
		const persistable = toPersistableDoc(doc);
		const rows = decomposeBlueprint(persistable);
		expect(
			rows.filter((row) => row.uuid === PROPERTY).map((row) => row.kind),
		).toEqual(["user_property"]);
		expect(
			rows.filter((row) => row.uuid === TYPE).map((row) => row.kind),
		).toEqual(["user_type"]);
		expect(
			rows.filter((row) => row.uuid === PERSONA).map((row) => row.kind),
		).toEqual(["persona"]);
		expect(roundTrip(doc)).toEqual(persistable);
	});

	it("round-trips prototype-named authored text without changing membership", () => {
		const propertyUuid = PROPERTY;
		const typeUuid = TYPE;
		const personaUuid = PERSONA;
		const doc = emptyDoc("rt-users-hostile-keys");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		applyMutations(doc, [
			{
				kind: "addUserProperty",
				property: {
					uuid: propertyUuid,
					slug: "__proto__",
					label: "constructor",
				},
			},
			{
				kind: "addUserType",
				userType: {
					uuid: typeUuid,
					name: "__proto__",
					values: Object.fromEntries([[propertyUuid, "role"]]),
				},
			},
			{
				kind: "addPersona",
				persona: {
					uuid: personaUuid,
					name: "constructor",
					userTypeUuid: typeUuid,
				},
			},
		]);

		const assembled = roundTrip(doc);
		expect(Object.hasOwn(assembled.userProperties ?? {}, propertyUuid)).toBe(
			true,
		);
		expect(Object.hasOwn(assembled.userTypes ?? {}, typeUuid)).toBe(true);
		expect(Object.hasOwn(assembled.personas ?? {}, personaUuid)).toBe(true);
		expect(assembled.userProperties?.[propertyUuid]?.slug).toBe("__proto__");
		expect(assembled.userProperties?.[propertyUuid]?.label).toBe("constructor");
		expect(assembled.userTypes?.[typeUuid]?.name).toBe("__proto__");
		expect(assembled.personas?.[personaUuid]?.name).toBe("constructor");
		expect(assembled.userTypes?.[typeUuid]?.values?.[propertyUuid]).toBe(
			"role",
		);
	});

	it("omits an empty collection entirely rather than assembling an empty record", () => {
		const doc = emptyDoc("rt-users-empty");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const assembled = roundTrip(doc);
		expect(Object.hasOwn(assembled, "userProperties")).toBe(false);
		expect(Object.hasOwn(assembled, "userTypes")).toBe(false);
		expect(Object.hasOwn(assembled, "personas")).toBe(false);
		for (const record of [
			userPropertiesOf(assembled),
			userTypesOf(assembled),
			personasOf(assembled),
		]) {
			expect(Object.getPrototypeOf(record)).toBeNull();
			expect(Object.hasOwn(record, "constructor")).toBe(false);
			expect(Object.hasOwn(record, "__proto__")).toBe(false);
		}
	});

	it("gives the slot back when the last entry is removed", () => {
		const doc = docWithUsers();
		applyMutations(doc, [
			{ kind: "removePersona", uuid: PERSONA },
			{ kind: "removeUserType", uuid: TYPE },
			{ kind: "removeUserProperty", uuid: PROPERTY },
		]);
		const assembled = roundTrip(doc);
		expect(Object.hasOwn(assembled, "userProperties")).toBe(false);
		expect(Object.hasOwn(assembled, "userTypes")).toBe(false);
		expect(Object.hasOwn(assembled, "personas")).toBe(false);
	});

	it("refuses a row-key collision even if persistence is called past the gate", () => {
		const doc = emptyDoc("rt-users-collision");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const moduleUuid = doc.moduleOrder[0];
		doc.userProperties = {
			[moduleUuid]: {
				uuid: moduleUuid,
				slug: "region",
				label: "Region",
			},
		};

		expect(() => decomposeBlueprint(toPersistableDoc(doc))).toThrow(
			/appears in both modules and userProperties/i,
		);
	});

	it("refuses an entity-identity collision hidden behind a different record key", () => {
		const doc = emptyDoc("rt-users-identity-collision");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const moduleUuid = doc.moduleOrder[0];
		const aliasKey = testUuid("aliased-property-row-key");
		doc.userProperties = {
			[aliasKey]: {
				uuid: moduleUuid,
				slug: "region",
				label: "Region",
			},
		};

		expect(() => decomposeBlueprint(toPersistableDoc(doc))).toThrow(
			/appears in both modules and userProperties/i,
		);
	});

	it.each(["__proto__", "constructor"])(
		"round-trips %s as the own identity of every entity kind",
		(identity) => {
			const uuid = testUuid(identity);
			const parentModule = testUuid("parent-module");
			const parentForm = testUuid("parent-form");
			const cases: Array<{
				kind: string;
				doc: BlueprintDoc;
				record: (doc: ReturnType<typeof roundTrip>) => object | undefined;
			}> = [
				{
					kind: "module",
					doc: {
						...emptyDoc(`rt-${identity}-module`),
						modules: Object.fromEntries([
							[uuid, { uuid, id: "module", name: "Module" }],
						]),
						moduleOrder: [uuid],
						formOrder: Object.fromEntries([[uuid, []]]),
					},
					record: (doc) => doc.modules,
				},
				{
					kind: "form",
					doc: {
						...emptyDoc(`rt-${identity}-form`),
						modules: {
							[parentModule]: {
								uuid: parentModule,
								id: "module",
								name: "Module",
							},
						},
						forms: Object.fromEntries([
							[
								uuid,
								{
									uuid,
									id: "form",
									name: "Form",
									type: "survey" as const,
								},
							],
						]),
						moduleOrder: [parentModule],
						formOrder: { [parentModule]: [uuid] },
						fieldOrder: Object.fromEntries([[uuid, []]]),
					},
					record: (doc) => doc.forms,
				},
				{
					kind: "field",
					doc: {
						...emptyDoc(`rt-${identity}-field`),
						modules: {
							[parentModule]: {
								uuid: parentModule,
								id: "module",
								name: "Module",
							},
						},
						forms: {
							[parentForm]: {
								uuid: parentForm,
								id: "form",
								name: "Form",
								type: "survey",
							},
						},
						fields: Object.fromEntries([
							[
								uuid,
								{
									uuid,
									id: "question",
									kind: "text" as const,
									label: proseText("Question"),
								},
							],
						]),
						moduleOrder: [parentModule],
						formOrder: { [parentModule]: [parentForm] },
						fieldOrder: { [parentForm]: [uuid] },
					},
					record: (doc) => doc.fields,
				},
				{
					kind: "user property",
					doc: {
						...emptyDoc(`rt-${identity}-property`),
						userProperties: Object.fromEntries([
							[uuid, { uuid, slug: "region", label: "Region" }],
						]),
						userPropertyOrder: [uuid],
					},
					record: (doc) => doc.userProperties,
				},
				{
					kind: "user type",
					doc: {
						...emptyDoc(`rt-${identity}-type`),
						userTypes: Object.fromEntries([[uuid, { uuid, name: "Worker" }]]),
						userTypeOrder: [uuid],
					},
					record: (doc) => doc.userTypes,
				},
				{
					kind: "persona",
					doc: {
						...emptyDoc(`rt-${identity}-persona`),
						personas: Object.fromEntries([[uuid, { uuid, name: "Asha" }]]),
						personaOrder: [uuid],
					},
					record: (doc) => doc.personas,
				},
			];

			for (const candidate of cases) {
				const assembled = roundTrip(candidate.doc);
				const record = candidate.record(assembled);
				expect(
					Object.hasOwn(record ?? {}, uuid),
					`${candidate.kind} must retain ${identity} as an own identity`,
				).toBe(true);
				expect(Object.getPrototypeOf(record as object)).toBeNull();
				expect(
					decomposeBlueprint(assembled).some(
						(row) =>
							row.kind.replaceAll("_", " ") === candidate.kind &&
							row.uuid === uuid,
					),
				).toBe(true);
			}
		},
	);
});
