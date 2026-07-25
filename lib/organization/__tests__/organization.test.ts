/**
 * The organization store's pure halves: site-code derivation, the persona
 * unassignment plan the archive cascade commits, and the reference-target
 * extractor the guarded commit replaces its edge set from.
 *
 * Postgres-backed coverage of the store itself lives in the integration
 * suite; everything here runs without a container because it is genuinely
 * pure — which is also why these are the parts worth pinning densely.
 */

import { describe, expect, it } from "vitest";
import { asUuid, type BlueprintDoc, type Persona } from "@/lib/domain";
import { extractLocationReferenceTargets } from "@/lib/organization/commitIntegrity";
import {
	deriveSiteCode,
	organizationRevisionSchema,
	SITE_CODE_PATTERN,
} from "@/lib/organization/schema";
import { planPersonaUnassignment } from "@/lib/organization/service";

function docWithPersonas(personas: Persona[]): BlueprintDoc {
	return {
		appId: "app",
		appName: "Organization",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
		personas: Object.fromEntries(
			personas.map((persona) => [persona.uuid, persona]),
		),
	};
}

function persona(
	uuid: string,
	name: string,
	locations?: { primaryUuid: string; additionalUuids?: string[] },
): Persona {
	return {
		uuid: asUuid(uuid),
		name,
		...(locations !== undefined && {
			locations: {
				primaryUuid: asUuid(locations.primaryUuid),
				...(locations.additionalUuids !== undefined && {
					additionalUuids: locations.additionalUuids.map(asUuid),
				}),
			},
		}),
	};
}

describe("deriveSiteCode", () => {
	it("slugifies a name into the charset HQ accepts", () => {
		expect(deriveSiteCode("North District", new Set())).toBe("north_district");
		expect(deriveSiteCode("St. Mary's Clinic #2", new Set())).toBe(
			"st_mary_s_clinic_2",
		);
	});

	it("keeps accented Latin letters by stripping their marks", () => {
		// Dropping the letter outright would turn "Hôpital Général" into
		// "h_pital_g_n_ral", which is unreadable as a bulk-upload key.
		expect(deriveSiteCode("Hôpital Général", new Set())).toBe(
			"hopital_general",
		);
	});

	it("falls back rather than deriving an illegal empty code", () => {
		// A name in a script the slug charset drops entirely would otherwise
		// derive "", which fails the pattern HQ validates against.
		expect(deriveSiteCode("保健所", new Set())).toBe("place");
		expect(deriveSiteCode("!!!", new Set())).toBe("place");
	});

	it("self-dedupes with a numeric suffix, as generate_code does", () => {
		expect(deriveSiteCode("Clinic", new Set(["clinic"]))).toBe("clinic2");
		expect(deriveSiteCode("Clinic", new Set(["clinic", "clinic2"]))).toBe(
			"clinic3",
		);
	});

	it("derives a code the pattern accepts for every input above", () => {
		for (const name of [
			"North District",
			"St. Mary's Clinic #2",
			"Hôpital Général",
			"保健所",
			"!!!",
			"a".repeat(400),
		]) {
			expect(deriveSiteCode(name, new Set())).toMatch(SITE_CODE_PATTERN);
		}
	});

	it("leaves room for the dedupe suffix on a very long name", () => {
		const derived = deriveSiteCode("a".repeat(400), new Set());
		expect(derived.length).toBeLessThanOrEqual(247);
	});
});

describe("organizationRevisionSchema", () => {
	it("accepts canonical decimals and rejects everything else", () => {
		expect(organizationRevisionSchema.safeParse("0").success).toBe(true);
		expect(organizationRevisionSchema.safeParse("42").success).toBe(true);
		// Past 2^53 — the exact reason revisions stay strings.
		expect(
			organizationRevisionSchema.safeParse("9007199254740993").success,
		).toBe(true);
		expect(organizationRevisionSchema.safeParse("01").success).toBe(false);
		expect(organizationRevisionSchema.safeParse("-1").success).toBe(false);
		expect(organizationRevisionSchema.safeParse("1.0").success).toBe(false);
		expect(
			organizationRevisionSchema.safeParse("9223372036854775808").success,
		).toBe(false);
	});
});

describe("planPersonaUnassignment", () => {
	it("leaves a persona whose places are all still live untouched", () => {
		const doc = docWithPersonas([
			persona("p1", "Asha", { primaryUuid: "loc-a" }),
		]);
		expect(planPersonaUnassignment(doc, new Set(["loc-z"]))).toEqual({
			mutations: [],
			personaNames: [],
		});
	});

	it("clears the whole slot when every place is archived", () => {
		// The explicit `null` is the point: a cleared optional slot cannot cross
		// the persistence wire or the SSE stream as `undefined`, because
		// JSON.stringify drops it.
		const doc = docWithPersonas([
			persona("p1", "Asha", {
				primaryUuid: "loc-a",
				additionalUuids: ["loc-b"],
			}),
		]);
		const plan = planPersonaUnassignment(doc, new Set(["loc-a", "loc-b"]));
		expect(plan.personaNames).toEqual(["Asha"]);
		expect(plan.mutations).toEqual([
			{
				kind: "updatePersona",
				uuid: asUuid("p1"),
				patch: { locations: null },
			},
		]);
	});

	it("promotes the next remaining place when the primary is archived", () => {
		// HQ's `unset_location_by_id(..., fall_back_to_next=True)`, which is what
		// makes archiving a facility not silently strand a worker nowhere.
		const doc = docWithPersonas([
			persona("p1", "Asha", {
				primaryUuid: "loc-a",
				additionalUuids: ["loc-b", "loc-c"],
			}),
		]);
		const plan = planPersonaUnassignment(doc, new Set(["loc-a"]));
		expect(plan.mutations).toEqual([
			{
				kind: "updatePersona",
				uuid: asUuid("p1"),
				patch: {
					locations: {
						primaryUuid: asUuid("loc-b"),
						additionalUuids: [asUuid("loc-c")],
					},
				},
			},
		]);
	});

	it("drops the additional list entirely when one place remains", () => {
		// An EMPTY `additionalUuids` would violate the schema's `.min(1)` and
		// would also be a second spelling of "no other places".
		const doc = docWithPersonas([
			persona("p1", "Asha", {
				primaryUuid: "loc-a",
				additionalUuids: ["loc-b"],
			}),
		]);
		const plan = planPersonaUnassignment(doc, new Set(["loc-b"]));
		expect(plan.mutations).toEqual([
			{
				kind: "updatePersona",
				uuid: asUuid("p1"),
				patch: { locations: { primaryUuid: asUuid("loc-a") } },
			},
		]);
	});

	it("keeps a non-primary archived place out without touching the primary", () => {
		const doc = docWithPersonas([
			persona("p1", "Asha", {
				primaryUuid: "loc-a",
				additionalUuids: ["loc-b", "loc-c"],
			}),
		]);
		const plan = planPersonaUnassignment(doc, new Set(["loc-b"]));
		expect(plan.mutations[0]).toMatchObject({
			patch: {
				locations: {
					primaryUuid: asUuid("loc-a"),
					additionalUuids: [asUuid("loc-c")],
				},
			},
		});
	});

	it("plans one mutation per affected persona and skips the rest", () => {
		const doc = docWithPersonas([
			persona("p1", "Asha", { primaryUuid: "loc-a" }),
			persona("p2", "Bimal", { primaryUuid: "loc-z" }),
			persona("p3", "Chandra"),
		]);
		const plan = planPersonaUnassignment(doc, new Set(["loc-a"]));
		expect(plan.personaNames).toEqual(["Asha"]);
		expect(plan.mutations).toHaveLength(1);
	});
});

describe("extractLocationReferenceTargets", () => {
	it("collects every assigned place, deduplicated and sorted", () => {
		// Sorted because insert order is the only thing keeping two concurrent
		// commits off a deadlock on the same edge rows.
		const doc = docWithPersonas([
			persona("p1", "Asha", {
				primaryUuid: "loc-b",
				additionalUuids: ["loc-a"],
			}),
			persona("p2", "Bimal", { primaryUuid: "loc-a" }),
		]);
		expect(extractLocationReferenceTargets(doc)).toEqual(["loc-a", "loc-b"]);
	});

	it("is empty for a document with no assignments", () => {
		expect(
			extractLocationReferenceTargets(docWithPersonas([persona("p1", "Asha")])),
		).toEqual([]);
		expect(extractLocationReferenceTargets(docWithPersonas([]))).toEqual([]);
	});
});
