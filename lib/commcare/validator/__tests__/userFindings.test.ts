import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, withUserSequences } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
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
	const propertyUuid = testUuid("property-region");
	const unknownPropertyUuid = testUuid("property-missing");
	const roleOneUuid = testUuid("role-one");
	const roleTwoUuid = testUuid("role-two");
	const personaOneUuid = testUuid("persona-one");
	const personaTwoUuid = testUuid("persona-two");
	return withUserSequences({
		...buildDoc(),
		userProperties: {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "region",
				label: "Region",
				choices: ["north", "north"],
			},
			[testUuid("property-duplicate")]: {
				uuid: testUuid("property-duplicate"),
				slug: "region",
				label: "Duplicate region",
			},
			[testUuid("property-invalid")]: {
				uuid: testUuid("property-invalid"),
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
				userTypeUuid: testUuid("role-missing"),
				values: { [unknownPropertyUuid]: "orphaned" },
			},
			[personaTwoUuid]: {
				uuid: personaTwoUuid,
				name: "amina",
				values: { [propertyUuid]: "south" },
			},
		},
	});
}

describe("user finding identity and scoping", () => {
	it.each(["2fa_region", "-area"])(
		"rejects the XML-unsafe worker-property slug %s",
		(slug) => {
			const propertyUuid = testUuid(`property-${slug}`);
			const doc: BlueprintDoc = withUserSequences({
				...buildDoc(),
				userProperties: {
					[propertyUuid]: {
						uuid: propertyUuid,
						slug,
						label: "Invalid worker information",
					},
				},
			});

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
			formUuids: new Set([testUuid("unrelated-form")]),
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
				uuid: testUuid("property-a"),
				slug: "Region",
				label: "Region A",
			},
			{
				uuid: testUuid("property-b"),
				slug: "region",
				label: "Region B",
			},
			{
				uuid: testUuid("property-c"),
				slug: "REGION",
				label: "Region C",
			},
		] as const;
		const roles = [
			{ uuid: testUuid("role-a"), name: "Nurse" },
			{ uuid: testUuid("role-b"), name: " nurse " },
			{ uuid: testUuid("role-c"), name: "NURSE" },
		] as const;
		const personas = [
			{ uuid: testUuid("persona-a"), name: "Amina" },
			{ uuid: testUuid("persona-b"), name: " amina " },
			{ uuid: testUuid("persona-c"), name: "AMINA" },
		] as const;
		// `reverse` flips the RECORDS' key order while every sequence stays put:
		// the sequence decides what the author sees, so the findings must not
		// move when the storage map happens to enumerate the other way.
		const make = (reverse: boolean): BlueprintDoc => ({
			...buildDoc(),
			userProperties: Object.fromEntries(
				(reverse ? [...properties].reverse() : properties).map((property) => [
					property.uuid,
					property,
				]),
			),
			userPropertyOrder: properties.map((property) => property.uuid),
			userTypes: Object.fromEntries(
				(reverse ? [...roles].reverse() : roles).map((role) => [
					role.uuid,
					role,
				]),
			),
			userTypeOrder: roles.map((role) => role.uuid),
			personas: Object.fromEntries(
				(reverse ? [...personas].reverse() : personas).map((persona) => [
					persona.uuid,
					persona,
				]),
			),
			personaOrder: personas.map((persona) => persona.uuid),
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

		// Every member of the group is reported, in the sequence the author
		// sees them in.
		const expected = [
			...properties.map(
				(property) =>
					`USER_PROPERTY_SLUG_DUPLICATE|userProperty=${property.uuid}`,
			),
			...roles.map((role) => `USER_TYPE_NAME_DUPLICATE|userType=${role.uuid}`),
			...personas.map(
				(persona) => `PERSONA_NAME_DUPLICATE|persona=${persona.uuid}`,
			),
		];
		expect(identities(make(false))).toEqual(expected);
		expect(identities(make(true))).toEqual(expected);
	});

	it("requires references to resolve through own record membership", () => {
		const roleUuid = testUuid("role");
		const personaUuid = testUuid("persona");
		const doc: BlueprintDoc = withUserSequences({
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
					userTypeUuid: testUuid("constructor"),
				},
			},
		});

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
		const propertyUuid = testUuid("property-choices");
		const doc: BlueprintDoc = withUserSequences({
			...buildDoc(),
			userProperties: {
				[propertyUuid]: {
					uuid: propertyUuid,
					slug: "region",
					label: "Region",
					choices: ["north", "south", "north"],
				},
			},
		});

		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "USER_PROPERTY_CHOICES_DUPLICATE",
		);
		expect(findings.map(errorIdentity)).toEqual([
			`USER_PROPERTY_CHOICES_DUPLICATE|userProperty=${propertyUuid}`,
		]);
	});

	it("does not read an inherited prototype member as a persona choice value", () => {
		const propertyUuid = testUuid("constructor");
		const personaUuid = testUuid("persona");
		const doc: BlueprintDoc = withUserSequences({
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
		});

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
		const propertyUuid = testUuid("missing-worker-property");
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
