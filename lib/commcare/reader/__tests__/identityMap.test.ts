/**
 * The projection of a Nova document onto the keys a reading of its CommCare
 * HQ app mints under. Catches an entity the projection skips or invents, a
 * key it gives twice, a projection that changes between two calls, and a key
 * that moves under an edit that keeps the entity (or holds still under one
 * that makes it another): a rename, a reorder of a case list's columns, and
 * a basic subcase moved to another index.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { advancedDocArbitrary } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { expressionDocArbitrary } from "@/lib/commcare/__tests__/expressionDocArbitrary";
import {
	childCreate,
	OP,
	OPT,
	own,
	placementFixture,
	U,
} from "@/lib/commcare/__tests__/placementFixture";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { planPlacements } from "@/lib/commcare/placement";
import {
	DERIVED_WIRE_IDENTITY,
	derivedFormXmlns,
	derivedUniqueId,
	targetWireIdentity,
} from "@/lib/commcare/wireIdentity";
import {
	authoredBlueprintIdentities,
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	idMappingColumn,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	EXTERNAL_ENTITY_KINDS,
	type ExternalEntityKind,
	externalKey,
	externalKeyText,
	type IdentityMapEntry,
} from "../identity";
import { externalIdentityMap } from "../identityMap";
import { recordSyntaxKey } from "../syntaxCompare";

const EXTERNAL = new Set<string>(EXTERNAL_ENTITY_KINDS);

/** Each entity's key text, by its UUID. */
function keysByUuid(entries: readonly IdentityMapEntry[]): Map<Uuid, string> {
	return new Map(entries.map((entry) => [entry.uuid, externalKeyText(entry)]));
}

/** The UUIDs whose key differs between two maps of one entity set. */
function movedKeys(
	before: readonly IdentityMapEntry[],
	after: readonly IdentityMapEntry[],
): Set<Uuid> {
	const a = keysByUuid(before);
	const b = keysByUuid(after);
	expect(new Set(b.keys())).toEqual(new Set(a.keys()));
	return new Set(
		[...a].filter(([uuid, key]) => b.get(uuid) !== key).map(([uuid]) => uuid),
	);
}

function holdsTheProjectionContract(doc: BlueprintDoc): void {
	const entries = externalIdentityMap(doc, DERIVED_WIRE_IDENTITY);
	const expected = authoredBlueprintIdentities(doc)
		.filter((identity) => EXTERNAL.has(identity.kind))
		.map((identity) => `${identity.kind} ${identity.uuid}`)
		.sort();
	expect(entries.map((entry) => `${entry.kind} ${entry.uuid}`).sort()).toEqual(
		expected,
	);
	const texts = entries.map((entry) => externalKeyText(entry));
	expect(new Set(texts).size).toBe(texts.length);
	expect(texts).toEqual(
		[...texts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
	);
	expect(externalIdentityMap(doc, DERIVED_WIRE_IDENTITY)).toEqual(entries);
}

describe("externalIdentityMap over admitted documents", () => {
	// Drawing an admitted document, which runs the commit gate over it, is
	// each case's cost; the projection itself takes a few milliseconds.
	it("maps every entity of an external kind once, and nothing else, over the expression corpus", () => {
		fc.assert(fc.property(expressionDocArbitrary, holdsTheProjectionContract), {
			seed: 20261113,
			numRuns: 25,
		});
	});

	it("maps every entity of an external kind once, and nothing else, over the advanced corpus", () => {
		fc.assert(fc.property(advancedDocArbitrary, holdsTheProjectionContract), {
			seed: 20261114,
			numRuns: 25,
		});
	});
});

const LEVEL = testUuid("map-level");
const LOCATION_PROPERTY = testUuid("map-location-property");
const USER_PROPERTY = testUuid("map-user-property");
const USER_TYPE = testUuid("map-user-type");

/** The placement fixture with one entity of every external kind, and a user
 *  type, which has none. */
function everyKindDoc(): BlueprintDoc {
	const { doc, formUuid, moduleUuid } = placementFixture("followup", {
		operations: (formType) => [
			own(),
			childCreate("kid", formType),
			childCreate("row", formType, { repeat: "kids" }),
		],
	});
	const module = doc.modules[moduleUuid];
	const config = module.caseListConfig as CaseListConfig;
	const calculated = {
		uuid: testUuid("map-calculated"),
		kind: "calculated",
		header: "Score",
		expression: { kind: "term", term: { kind: "literal", value: "1" } },
	} as unknown as Column;
	const mapping = idMappingColumn(testUuid("map-column"), "region", "Region", [
		{
			uuid: testUuid("map-entry"),
			value: "north",
			label: "North",
		},
	]);
	doc.modules[moduleUuid] = {
		...module,
		entryPoint: { uuid: testUuid("map-menu-entry"), id: "patients" },
		caseListEntryPoint: {
			uuid: testUuid("map-list-entry"),
			id: "patient-list",
		},
		caseListConfig: {
			...config,
			columns: [...config.columns, calculated, mapping],
			calculatedSorts: [
				{
					uuid: testUuid("map-sort"),
					expression: term(literal("north")),
					direction: "asc",
					priority: 0,
				},
			],
			listColumnOrder: [
				...config.listColumnOrder,
				calculated.uuid,
				mapping.uuid,
			],
			detailColumnOrder: [
				...config.detailColumnOrder,
				calculated.uuid,
				mapping.uuid,
			],
			searchInputs: [
				{
					uuid: testUuid("map-search-name"),
					kind: "simple",
					name: "patient_name",
					label: "Name",
					property: "case_name",
					mode: { kind: "exact" },
				},
			] as unknown as CaseListConfig["searchInputs"],
		},
	};
	const kidsModule = doc.moduleOrder[1];
	doc.forms[formUuid] = {
		...doc.forms[formUuid],
		entryPoint: { uuid: testUuid("map-form-entry"), id: "follow-up" },
		formLinks: [
			{ uuid: testUuid("map-link-again"), target: { type: "this-form" } },
			{
				uuid: testUuid("map-link-kids"),
				target: { type: "module", moduleUuid: kidsModule },
			},
		],
		otherwise: {
			kind: "link",
			uuid: testUuid("map-link-otherwise"),
			target: { type: "this-form" },
		},
	};
	return {
		...doc,
		userProperties: {
			[USER_PROPERTY]: {
				uuid: USER_PROPERTY,
				slug: "district",
				label: "District",
			},
		} as unknown as BlueprintDoc["userProperties"],
		userPropertyOrder: [USER_PROPERTY],
		userTypes: {
			[USER_TYPE]: { uuid: USER_TYPE, name: "Nurse" },
		} as unknown as BlueprintDoc["userTypes"],
		userTypeOrder: [USER_TYPE],
		organizationLevels: {
			[LEVEL]: { uuid: LEVEL, code: "district", name: "District" },
		} as unknown as BlueprintDoc["organizationLevels"],
		organizationLevelOrder: [LEVEL],
		locationProperties: {
			[LOCATION_PROPERTY]: {
				uuid: LOCATION_PROPERTY,
				slug: "district",
				label: "District",
			},
		} as unknown as BlueprintDoc["locationProperties"],
		locationPropertyOrder: [LOCATION_PROPERTY],
	};
}

describe("externalIdentityMap's keys", () => {
	it("spells each entity's key from its document, as the key table gives it", () => {
		const doc = everyKindDoc();
		const formUuid = testUuid("form-under-test");
		const moduleUuid = doc.moduleOrder[0];
		const entries = externalIdentityMap(doc, DERIVED_WIRE_IDENTITY);
		expect(new Set(entries.map((entry) => entry.kind))).toEqual(
			new Set<ExternalEntityKind>(EXTERNAL_ENTITY_KINDS),
		);
		holdsTheProjectionContract(doc);

		const keys = keysByUuid(entries);
		const xmlns = derivedFormXmlns(formUuid);
		const menu = derivedUniqueId(moduleUuid);
		const expectKey = (uuid: Uuid, key: ReturnType<typeof externalKey.form>) =>
			expect(keys.get(uuid)).toBe(externalKeyText(key));

		expectKey(moduleUuid, externalKey.module(menu));
		expectKey(formUuid, externalKey.form(xmlns));
		expectKey(U("inner"), externalKey.field(xmlns, ["grp", "inner"]));
		expectKey(U("kid_name"), externalKey.field(xmlns, ["kids", "kid_name"]));
		expectKey(OPT("yes"), externalKey.selectOption(xmlns, ["status"], "yes"));
		expectKey(
			testUuid("map-calculated"),
			externalKey.caseListColumn(menu, "calculated", "", 0),
		);
		expectKey(
			testUuid("map-sort"),
			externalKey.caseListSort(menu, recordSyntaxKey("'north'"), 0),
		);
		expectKey(
			testUuid("map-search-name"),
			externalKey.searchInput(menu, "patient_name"),
		);
		expectKey(
			testUuid("map-menu-entry"),
			externalKey.entryPoint("module", menu, "menu"),
		);
		expectKey(
			testUuid("map-list-entry"),
			externalKey.entryPoint("module", menu, "case-list"),
		);
		expectKey(
			testUuid("map-form-entry"),
			externalKey.entryPoint("form", xmlns),
		);
		expectKey(
			testUuid("map-link-again"),
			externalKey.formLink(xmlns, ["this-form"], 0),
		);
		expectKey(
			testUuid("map-link-kids"),
			externalKey.formLink(
				xmlns,
				["module", derivedUniqueId(doc.moduleOrder[1])],
				0,
			),
		);
		// The otherwise link counts after the destinations.
		expectKey(
			testUuid("map-link-otherwise"),
			externalKey.formLink(xmlns, ["this-form"], 1),
		);
		expectKey(
			OP("own"),
			externalKey.caseOperation(xmlns, ["basic", "own"], "own", 0),
		);
		const placements = planPlacements(doc, formUuid).placements;
		expect(placements.get(OP("kid"))?.placement).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 0,
		});
		expectKey(
			OP("kid"),
			externalKey.caseOperation(xmlns, ["basic", "subcase", 0], "create", 0),
		);
		expect(placements.get(OP("row"))?.placement).toEqual({
			kind: "basic",
			slot: "subcase-row",
		});
		expectKey(
			OP("row"),
			externalKey.caseOperation(
				xmlns,
				["basic", "subcase-row", ["kids"]],
				"create",
				0,
			),
		);
		expectKey(USER_PROPERTY, externalKey.userProperty("district"));
		expectKey(LEVEL, externalKey.organizationLevel("district"));
		expectKey(LOCATION_PROPERTY, externalKey.locationProperty("district"));
	});

	it("reserves the accepted rule identity when fresh HQ lookup data has lost its table or result column", () => {
		const doc = everyKindDoc();
		const mod = doc.modules[doc.moduleOrder[0]];
		const sort = mod.caseListConfig?.calculatedSorts?.[0];
		if (!sort) throw new Error("Missing independent order");
		const tableId = "018f0000-0000-7000-8000-0000000000a1" as LookupTableId;
		const columnId = "018f0000-0000-7000-8000-0000000000b1" as LookupColumnId;
		sort.expression = {
			kind: "table-lookup",
			tableId,
			resultColumnId: columnId,
			where: { kind: "match-all" },
		};
		const table = {
			id: tableId,
			tag: "districts",
			columns: [
				{
					id: columnId,
					wireName: "rank",
					label: "Rank",
					dataType: "text" as const,
				},
			],
		};
		const entry = (naming: ReturnType<typeof lookupWireNaming>) =>
			externalIdentityMap(doc, DERIVED_WIRE_IDENTITY, naming).find(
				(e) => e.uuid === sort.uuid,
			);
		const prior = entry(lookupWireNaming([table]));
		expect(prior?.kind).toBe("caseListSort");
		expect(prior?.parts[1]).toContain("districts");
		for (const naming of [
			lookupWireNaming([]),
			lookupWireNaming([{ ...table, columns: [] }]),
		]) {
			const unavailable = entry(naming);
			expect(unavailable?.uuid).toBe(sort.uuid);
			expect(unavailable?.parts).not.toEqual(prior?.parts);
		}
	});

	it("reads menu ids and form namespaces from the identity it is handed", () => {
		const doc = everyKindDoc();
		const formUuid = testUuid("form-under-test");
		const moduleUuid = doc.moduleOrder[0];
		const xmlns = "http://openrosa.org/formdesigner/hq-held";
		const keys = keysByUuid(
			externalIdentityMap(
				doc,
				targetWireIdentity([
					{
						entityKind: "module",
						novaEntityUuid: moduleUuid,
						uniqueId: "hq-menu",
						xmlns: null,
					},
					{
						entityKind: "form",
						novaEntityUuid: formUuid,
						uniqueId: null,
						xmlns,
					},
				]),
			),
		);
		expect(keys.get(moduleUuid)).toBe(
			externalKeyText(externalKey.module("hq-menu")),
		);
		expect(keys.get(U("name"))).toBe(
			externalKeyText(externalKey.field(xmlns, ["name"])),
		);
	});

	it("refuses a document two of whose entities share one key", () => {
		const doc = everyKindDoc();
		const second = testUuid("map-user-property-again");
		const twice = {
			...doc,
			userProperties: {
				...doc.userProperties,
				[second]: { uuid: second, slug: "district", label: "District" },
			} as unknown as BlueprintDoc["userProperties"],
			userPropertyOrder: [USER_PROPERTY, second],
		};
		expect(() => externalIdentityMap(twice, DERIVED_WIRE_IDENTITY)).toThrow(
			/share one userProperty key/,
		);
	});
});

describe("externalIdentityMap under edits", () => {
	it("moves the key of a renamed question and its descendants, and no other", () => {
		const { doc } = placementFixture("survey");
		const before = externalIdentityMap(doc, DERIVED_WIRE_IDENTITY);
		const renamed = (uuid: Uuid, id: string): BlueprintDoc => ({
			...doc,
			fields: { ...doc.fields, [uuid]: { ...doc.fields[uuid], id } },
		});
		expect(
			movedKeys(
				before,
				externalIdentityMap(
					renamed(U("grp"), "household"),
					DERIVED_WIRE_IDENTITY,
				),
			),
		).toEqual(new Set([U("grp"), U("inner")]));
		expect(
			movedKeys(
				before,
				externalIdentityMap(
					renamed(U("status"), "state"),
					DERIVED_WIRE_IDENTITY,
				),
			),
		).toEqual(
			new Set([U("status"), OPT("yes"), OPT("no"), OPT("it's"), OPT('"q"')]),
		);
	});

	it("keys a case list's columns by content and their order among equals", () => {
		const { doc, moduleUuid } = placementFixture("survey");
		const name = plainColumn(testUuid("col-name"), "case_name", "Name");
		const ageA = plainColumn(testUuid("col-age-a"), "age", "Age");
		const ageB = plainColumn(testUuid("col-age-b"), "age", "Age again");
		const phone = {
			uuid: testUuid("col-phone"),
			kind: "phone",
			field: "age",
			header: "Call",
		} satisfies Column;
		const withColumns = (
			columns: Column[],
			listColumnOrder: Uuid[],
		): BlueprintDoc => {
			const module = doc.modules[moduleUuid];
			return {
				...doc,
				modules: {
					...doc.modules,
					[moduleUuid]: {
						...module,
						caseListConfig: {
							...(module.caseListConfig as CaseListConfig),
							columns,
							listColumnOrder,
							detailColumnOrder: [...listColumnOrder],
						},
					},
				},
			};
		};
		const columns = [name, ageA, ageB, phone];
		const order = columns.map((column) => column.uuid);
		const before = externalIdentityMap(
			withColumns(columns, order),
			DERIVED_WIRE_IDENTITY,
		);

		// Columns no two of which share (kind, property) keep their keys.
		expect(
			movedKeys(
				before,
				externalIdentityMap(
					withColumns(columns, [phone.uuid, ageA.uuid, ageB.uuid, name.uuid]),
					DERIVED_WIRE_IDENTITY,
				),
			),
		).toEqual(new Set());

		// Two that do swap their keys.
		const swapped = keysByUuid(
			externalIdentityMap(
				withColumns(columns, [name.uuid, ageB.uuid, ageA.uuid, phone.uuid]),
				DERIVED_WIRE_IDENTITY,
			),
		);
		const original = keysByUuid(before);
		expect(swapped.get(ageA.uuid)).toBe(original.get(ageB.uuid));
		expect(swapped.get(ageB.uuid)).toBe(original.get(ageA.uuid));
		expect(swapped.get(name.uuid)).toBe(original.get(name.uuid));
		expect(swapped.get(phone.uuid)).toBe(original.get(phone.uuid));

		// The columns array carries no sequence.
		expect(
			movedKeys(
				before,
				externalIdentityMap(
					withColumns([...columns].reverse(), order),
					DERIVED_WIRE_IDENTITY,
				),
			),
		).toEqual(new Set());
	});

	it("moves the key of each basic subcase whose index moved, and no other", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: (formType) => [
				own(),
				...["a", "b", "c"].map((key) => childCreate(key, formType)),
			],
		});
		const [ownArm, a, b, c] = doc.forms[formUuid].caseOperations ?? [];
		const moved = {
			doc: {
				...doc,
				forms: {
					...doc.forms,
					[formUuid]: {
						...doc.forms[formUuid],
						caseOperations: [ownArm, b, a, c],
					},
				},
			},
		};
		const indexOf = (subject: BlueprintDoc, key: string) =>
			planPlacements(subject, formUuid).placements.get(OP(key))?.placement;
		expect(indexOf(doc, "a")).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 0,
		});
		expect(indexOf(moved.doc, "a")).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 1,
		});
		expect(
			movedKeys(
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				externalIdentityMap(moved.doc, DERIVED_WIRE_IDENTITY),
			),
		).toEqual(new Set([OP("a"), OP("b")]));
	});
});
