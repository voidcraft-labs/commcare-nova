import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
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
				choices: ["north"],
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
});
