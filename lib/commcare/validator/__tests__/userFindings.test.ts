import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { eq, literal, sessionUserProperty } from "@/lib/domain/predicate";
import type { ValidationError, ValidationErrorCode } from "../errors";
import { errorIdentity } from "../gate";
import { errorWithinScope, runValidation } from "../runner";

const USER_FINDING_CODES = [
	"USER_PROPERTY_SLUG_INVALID",
	"USER_PROPERTY_SLUG_DUPLICATE",
	"USER_TYPE_NAME_DUPLICATE",
	"PERSONA_NAME_DUPLICATE",
	"PERSONA_USER_TYPE_UNKNOWN",
	"USER_DATA_UNKNOWN_PROPERTY",
	"USER_DATA_INVALID_CHOICE",
	"USER_PROPERTY_CHOICES_DUPLICATE",
] as const satisfies readonly ValidationErrorCode[];
const USER_FINDING_CODE_SET: ReadonlySet<ValidationErrorCode> = new Set(
	USER_FINDING_CODES,
);

function userDoc(): BlueprintDoc {
	const propertyUuid = asUuid("property-region");
	const unknownPropertyUuid = asUuid("property-missing");
	const roleOneUuid = asUuid("role-one");
	const roleTwoUuid = asUuid("role-two");
	const personaOneUuid = asUuid("persona-one");
	const personaTwoUuid = asUuid("persona-two");
	return {
		...buildDoc(),
		userProperties: {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "region",
				label: "Region",
				choices: ["north", "north"],
			},
			[asUuid("property-duplicate")]: {
				uuid: asUuid("property-duplicate"),
				slug: "region",
				label: "Duplicate region",
			},
			[asUuid("property-invalid")]: {
				uuid: asUuid("property-invalid"),
				slug: "has spaces",
				label: "Invalid",
			},
		},
		userTypes: {
			[roleOneUuid]: {
				uuid: roleOneUuid,
				name: "Nurse",
				values: {
					[propertyUuid]: "south",
					[unknownPropertyUuid]: "orphaned",
				},
			},
			[roleTwoUuid]: {
				uuid: roleTwoUuid,
				name: "nurse",
				values: { [unknownPropertyUuid]: "also orphaned" },
			},
		},
		personas: {
			[personaOneUuid]: {
				uuid: personaOneUuid,
				name: "Amina",
				userTypeUuid: asUuid("role-missing"),
				values: { [unknownPropertyUuid]: "orphaned" },
			},
			[personaTwoUuid]: {
				uuid: personaTwoUuid,
				name: "amina",
				values: { [propertyUuid]: "south" },
			},
		},
	};
}

describe("user finding identity and scoping", () => {
	it.each(["2fa_region", "-area"])(
		"rejects the XML-unsafe worker-property slug %s",
		(slug) => {
			const propertyUuid = asUuid(`property-${slug}`);
			const doc: BlueprintDoc = {
				...buildDoc(),
				userProperties: {
					[propertyUuid]: {
						uuid: propertyUuid,
						slug,
						label: "Invalid worker information",
					},
				},
			};

			expect(
				runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
					.filter((finding) => finding.code === "USER_PROPERTY_SLUG_INVALID")
					.map(errorIdentity),
			).toEqual([`USER_PROPERTY_SLUG_INVALID|userProperty=${propertyUuid}`]);
		},
	);

	it("keeps independent invalid user entities distinct", () => {
		const findings = runValidation(
			userDoc(),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter((finding) => USER_FINDING_CODE_SET.has(finding.code));

		const grouped = new Map<ValidationErrorCode, ValidationError[]>();
		for (const finding of findings) {
			const group = grouped.get(finding.code) ?? [];
			group.push(finding);
			grouped.set(finding.code, group);
		}

		for (const [code, group] of grouped) {
			const identities = group.map(errorIdentity);
			expect(
				new Set(identities).size,
				`${code} findings must retain their stable entity discriminators`,
			).toBe(identities.length);
		}

		expect(grouped.get("USER_DATA_UNKNOWN_PROPERTY")).toHaveLength(3);
		expect(grouped.get("USER_DATA_INVALID_CHOICE")).toHaveLength(2);
	});

	it("retains every app-wide user finding under a form-only scope", () => {
		const findings = runValidation(userDoc(), LOOKUP_CONTEXT_UNAVAILABLE);
		const userFindings = findings.filter((finding) =>
			USER_FINDING_CODE_SET.has(finding.code),
		);
		const unrelatedScope = {
			formUuids: new Set([asUuid("unrelated-form")]),
		};

		expect(
			[...new Set(userFindings.map((finding) => finding.code))].sort(),
		).toEqual([...USER_FINDING_CODES].sort());
		expect(
			userFindings.every((finding) =>
				errorWithinScope(finding, unrelatedScope),
			),
		).toBe(true);

		const scoped = runValidation(userDoc(), LOOKUP_CONTEXT_UNAVAILABLE, {
			scope: unrelatedScope,
		}).filter((finding) => USER_FINDING_CODE_SET.has(finding.code));
		expect(scoped).toEqual(userFindings);
	});

	it("reports every member of each duplicate group independent of record order", () => {
		const properties = [
			{
				uuid: asUuid("property-a"),
				order: "c",
				slug: "Region",
				label: "Region A",
			},
			{
				uuid: asUuid("property-b"),
				order: "a",
				slug: "region",
				label: "Region B",
			},
			{
				uuid: asUuid("property-c"),
				order: "b",
				slug: "REGION",
				label: "Region C",
			},
		] as const;
		const roles = [
			{ uuid: asUuid("role-a"), order: "c", name: "Nurse" },
			{ uuid: asUuid("role-b"), order: "a", name: " nurse " },
			{ uuid: asUuid("role-c"), order: "b", name: "NURSE" },
		] as const;
		const personas = [
			{ uuid: asUuid("persona-a"), order: "c", name: "Amina" },
			{ uuid: asUuid("persona-b"), order: "a", name: " amina " },
			{ uuid: asUuid("persona-c"), order: "b", name: "AMINA" },
		] as const;
		const make = (reverse: boolean): BlueprintDoc => ({
			...buildDoc(),
			userProperties: Object.fromEntries(
				(reverse ? [...properties].reverse() : properties).map((property) => [
					property.uuid,
					property,
				]),
			),
			userTypes: Object.fromEntries(
				(reverse ? [...roles].reverse() : roles).map((role) => [
					role.uuid,
					role,
				]),
			),
			personas: Object.fromEntries(
				(reverse ? [...personas].reverse() : personas).map((persona) => [
					persona.uuid,
					persona,
				]),
			),
		});
		const identities = (doc: BlueprintDoc) =>
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
				.filter((finding) =>
					[
						"USER_PROPERTY_SLUG_DUPLICATE",
						"USER_TYPE_NAME_DUPLICATE",
						"PERSONA_NAME_DUPLICATE",
					].includes(finding.code),
				)
				.map(errorIdentity);

		const expected = [
			`USER_PROPERTY_SLUG_DUPLICATE|userProperty=${properties[1].uuid}`,
			`USER_PROPERTY_SLUG_DUPLICATE|userProperty=${properties[2].uuid}`,
			`USER_PROPERTY_SLUG_DUPLICATE|userProperty=${properties[0].uuid}`,
			`USER_TYPE_NAME_DUPLICATE|userType=${roles[1].uuid}`,
			`USER_TYPE_NAME_DUPLICATE|userType=${roles[2].uuid}`,
			`USER_TYPE_NAME_DUPLICATE|userType=${roles[0].uuid}`,
			`PERSONA_NAME_DUPLICATE|persona=${personas[1].uuid}`,
			`PERSONA_NAME_DUPLICATE|persona=${personas[2].uuid}`,
			`PERSONA_NAME_DUPLICATE|persona=${personas[0].uuid}`,
		];
		expect(identities(make(false))).toEqual(expected);
		expect(identities(make(true))).toEqual(expected);
	});

	it("orders legacy missing-order duplicate findings by uuid", () => {
		const properties = [
			{
				uuid: asUuid("property-c"),
				slug: "REGION",
				label: "Region C",
			},
			{
				uuid: asUuid("property-a"),
				slug: "Region",
				label: "Region A",
			},
			{
				uuid: asUuid("property-b"),
				slug: "region",
				label: "Region B",
			},
		] as const;
		const make = (
			values: readonly (typeof properties)[number][],
		): BlueprintDoc => ({
			...buildDoc(),
			userProperties: Object.fromEntries(
				values.map((property) => [property.uuid, property]),
			),
		});
		const identities = (doc: BlueprintDoc) =>
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
				.filter((finding) => finding.code === "USER_PROPERTY_SLUG_DUPLICATE")
				.map(errorIdentity);
		const expected = ["property-a", "property-b", "property-c"].map(
			(uuid) => `USER_PROPERTY_SLUG_DUPLICATE|userProperty=${uuid}`,
		);

		expect(identities(make(properties))).toEqual(expected);
		expect(identities(make([...properties].reverse()))).toEqual(expected);
	});

	it("requires references to resolve through own record membership", () => {
		const roleUuid = asUuid("role");
		const personaUuid = asUuid("persona");
		const doc: BlueprintDoc = {
			...buildDoc(),
			userTypes: {
				[roleUuid]: {
					uuid: roleUuid,
					name: "Role",
					values: Object.fromEntries([["constructor", "poison"]]),
				},
			},
			personas: {
				[personaUuid]: {
					uuid: personaUuid,
					name: "Asha",
					userTypeUuid: asUuid("constructor"),
				},
			},
		};

		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			findings
				.filter((finding) => finding.code === "PERSONA_USER_TYPE_UNKNOWN")
				.map(errorIdentity),
		).toEqual([`PERSONA_USER_TYPE_UNKNOWN|persona=${personaUuid}`]);
		expect(
			findings
				.filter((finding) => finding.code === "USER_DATA_UNKNOWN_PROPERTY")
				.map(errorIdentity),
		).toEqual([
			`USER_DATA_UNKNOWN_PROPERTY|ownerKind=userType|owner=${roleUuid}|userProperty=constructor`,
		]);
	});

	it("gives duplicate accepted values a stable property finding", () => {
		const propertyUuid = asUuid("property-choices");
		const doc: BlueprintDoc = {
			...buildDoc(),
			userProperties: {
				[propertyUuid]: {
					uuid: propertyUuid,
					slug: "region",
					label: "Region",
					choices: ["north", "south", "north"],
				},
			},
		};

		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "USER_PROPERTY_CHOICES_DUPLICATE",
		);
		expect(findings.map(errorIdentity)).toEqual([
			`USER_PROPERTY_CHOICES_DUPLICATE|userProperty=${propertyUuid}`,
		]);
	});

	it("does not read an inherited prototype member as a persona choice value", () => {
		const propertyUuid = asUuid("constructor");
		const personaUuid = asUuid("persona");
		const doc: BlueprintDoc = {
			...buildDoc(),
			userProperties: Object.fromEntries([
				[
					propertyUuid,
					{
						uuid: propertyUuid,
						slug: "region",
						label: "Region",
						choices: ["north"],
					},
				],
			]),
			personas: {
				[personaUuid]: {
					uuid: personaUuid,
					name: "Asha",
				},
			},
		};

		expect(() => runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).not.toThrow();
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
				(finding) => finding.code === "USER_DATA_INVALID_CHOICE",
			),
		).toEqual([]);
	});

	it("reports every entity participating in one app-global uuid collision", () => {
		const doc = buildDoc({ modules: [{ name: "Patients" }] });
		const moduleUuid = doc.moduleOrder[0];
		doc.userProperties = {
			[moduleUuid]: {
				uuid: moduleUuid,
				slug: "region",
				label: "Region",
			},
		};

		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "BLUEPRINT_ENTITY_UUID_DUPLICATE",
		);
		expect(findings.map(errorIdentity).sort()).toEqual(
			[
				`BLUEPRINT_ENTITY_UUID_DUPLICATE|entity=${moduleUuid}|entityKind=module`,
				`BLUEPRINT_ENTITY_UUID_DUPLICATE|entity=${moduleUuid}|entityKind=userProperty`,
			].sort(),
		);
	});

	it("rejects a dangling custom worker-property identity", () => {
		const propertyUuid = asUuid("missing-worker-property");
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					displayCondition: eq(
						sessionUserProperty(propertyUuid),
						literal("north"),
					),
				},
			],
		});

		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "USER_PROPERTY_REFERENCE_UNKNOWN",
		);
		expect(findings.map(errorIdentity)).toEqual([
			`USER_PROPERTY_REFERENCE_UNKNOWN|userProperty=${propertyUuid}`,
		]);
	});
});
