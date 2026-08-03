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
import { testUuid as asUuid } from "@/__tests__/helpers/uuid";
import { removeOrganizationLevelPlan } from "@/lib/doc/organizationMutations";
import {
	type BlueprintDoc,
	levelMayNestUnder,
	locationPropertySchema,
	type OrganizationLevel,
	type Persona,
} from "@/lib/domain";
import { fixedLocation, term } from "@/lib/domain/predicate";
import { extractLocationReferenceTargets } from "@/lib/organization/commitIntegrity";
import {
	createLocationInputSchema,
	deriveSiteCode,
	organizationRevisionSchema,
	SITE_CODE_PATTERN,
	updateLocationInputSchema,
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

function level(
	uuid: string,
	name: string,
	parentLevelUuid?: string,
): OrganizationLevel {
	return {
		uuid: asUuid(uuid),
		code: uuid,
		name,
		...(parentLevelUuid !== undefined && {
			parentLevelUuid: asUuid(parentLevelUuid),
		}),
		caseFlow: { workers: "none", ownsCases: false },
		addressBook: { reach: "own-branch" },
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

describe("organization authoring input identity", () => {
	const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const upper = lower.toUpperCase();
	const nil = "00000000-0000-0000-0000-000000000000";

	it("admits only canonical lowercase non-nil UUID identities", () => {
		const valid = {
			levelUuid: lower,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values: { [lower]: "value" },
		};
		expect(createLocationInputSchema.safeParse(valid).success).toBe(true);
		for (const invalid of [upper, nil, "not-a-uuid"]) {
			expect(
				createLocationInputSchema.safeParse({ ...valid, levelUuid: invalid })
					.success,
			).toBe(false);
			expect(
				createLocationInputSchema.safeParse({
					...valid,
					values: { [invalid]: "value" },
				}).success,
			).toBe(false);
		}
		expect(
			updateLocationInputSchema.safeParse({ levelUuid: upper }).success,
		).toBe(false);
	});

	it("keeps the exact upstream 255-character place-information label bound", () => {
		const base = { uuid: lower, slug: "phone" };
		expect(
			locationPropertySchema.safeParse({ ...base, label: "a".repeat(255) })
				.success,
		).toBe(true);
		expect(
			locationPropertySchema.safeParse({ ...base, label: "a".repeat(256) })
				.success,
		).toBe(false);
	});
});

describe("removeOrganizationLevelPlan", () => {
	it("refuses to broaden a property that applies only to the removed level", () => {
		const region = asUuid("11111111-1111-4111-8111-111111111111");
		const property = asUuid("22222222-2222-4222-8222-222222222222");
		const doc = docWithPersonas([]);
		doc.organizationLevels = { [region]: level(region, "Region") };
		doc.organizationLevelOrder = [region];
		doc.locationProperties = {
			[property]: {
				uuid: property,
				slug: "phone",
				label: "Phone",
				levelUuids: [region],
			},
		};
		doc.locationPropertyOrder = [property];

		expect(removeOrganizationLevelPlan(doc, region)).toMatchObject({
			ok: false,
			userMessage: expect.stringMatching(/applies only to "Region"/),
		});
	});
});

describe("planPersonaUnassignment", () => {
	it("leaves a persona whose places are all still live untouched", () => {
		const doc = docWithPersonas([
			persona("p1", "Asha", { primaryUuid: "loc-a" }),
		]);
		expect(planPersonaUnassignment(doc, new Set([asUuid("loc-z")]))).toEqual({
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
		const plan = planPersonaUnassignment(
			doc,
			new Set([asUuid("loc-a"), asUuid("loc-b")]),
		);
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
		const plan = planPersonaUnassignment(doc, new Set([asUuid("loc-a")]));
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
		const plan = planPersonaUnassignment(doc, new Set([asUuid("loc-b")]));
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
		const plan = planPersonaUnassignment(doc, new Set([asUuid("loc-b")]));
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
		const plan = planPersonaUnassignment(doc, new Set([asUuid("loc-a")]));
		expect(plan.personaNames).toEqual(["Asha"]);
		expect(plan.mutations).toHaveLength(1);
	});
});

describe("levelMayNestUnder", () => {
	// Region → District → Facility, plus a second branch off Region so the
	// forest is genuinely branching rather than a chain.
	const levels: Record<string, OrganizationLevel> = {
		[asUuid("region")]: level("region", "Region"),
		[asUuid("district")]: level("district", "District", "region"),
		[asUuid("facility")]: level("facility", "Facility", "district"),
		[asUuid("depot")]: level("depot", "Depot", "region"),
	};

	it("allows the level directly above", () => {
		expect(
			levelMayNestUnder(asUuid("facility"), asUuid("district"), levels),
		).toBe(true);
		expect(
			levelMayNestUnder(asUuid("district"), asUuid("region"), levels),
		).toBe(true);
	});

	it("allows SKIPPING an intermediate level", () => {
		// The capability this rule exists to permit: some regions run districts
		// and some do not, so a facility hangs straight off the region. The
		// fixture blank-fills `district_id` and an expression joining on it
		// truthfully finds nothing.
		expect(
			levelMayNestUnder(asUuid("facility"), asUuid("region"), levels),
		).toBe(true);
	});

	it("refuses a level under itself", () => {
		// The concrete breakage: the ancestor's write would overwrite the
		// child's own `{code}_id` with the parent's id, so every two-hop join
		// through that attribute silently resolves to the wrong element.
		expect(
			levelMayNestUnder(asUuid("facility"), asUuid("facility"), levels),
		).toBe(false);
	});

	it("refuses an inverted placement", () => {
		expect(
			levelMayNestUnder(asUuid("district"), asUuid("facility"), levels),
		).toBe(false);
		expect(
			levelMayNestUnder(asUuid("region"), asUuid("district"), levels),
		).toBe(false);
	});

	it("refuses a sibling branch", () => {
		// A depot is not above a facility, so a facility cannot sit in one.
		expect(levelMayNestUnder(asUuid("facility"), asUuid("depot"), levels)).toBe(
			false,
		);
	});

	it("refuses anything under a top level", () => {
		expect(levelMayNestUnder(asUuid("region"), asUuid("depot"), levels)).toBe(
			false,
		);
	});

	it("is false rather than throwing for an unknown level", () => {
		expect(levelMayNestUnder(asUuid("gone"), asUuid("region"), levels)).toBe(
			false,
		);
		expect(levelMayNestUnder(asUuid("facility"), asUuid("gone"), levels)).toBe(
			false,
		);
	});

	it("terminates on a cyclic parent chain rather than hanging", () => {
		// Unreachable through the validator, but this predicate also runs over
		// documents being repaired.
		const cyclic: Record<string, OrganizationLevel> = {
			[asUuid("a")]: level("a", "A", "b"),
			[asUuid("b")]: level("b", "B", "a"),
		};
		expect(levelMayNestUnder(asUuid("a"), asUuid("b"), cyclic)).toBe(true);
		expect(levelMayNestUnder(asUuid("a"), asUuid("a"), cyclic)).toBe(false);
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
		expect(extractLocationReferenceTargets(doc)).toEqual(
			[asUuid("loc-a"), asUuid("loc-b")].sort(),
		);
	});

	it("is empty for a document with no assignments", () => {
		expect(
			extractLocationReferenceTargets(docWithPersonas([persona("p1", "Asha")])),
		).toEqual([]);
		expect(extractLocationReferenceTargets(docWithPersonas([]))).toEqual([]);
	});

	it("includes fixed case-owner terms in the same exact edge set", () => {
		const locationUuid = asUuid("loc-fixed");
		const formUuid = asUuid("form-owner");
		const doc = {
			...docWithPersonas([persona("p1", "Asha")]),
			forms: {
				[formUuid]: {
					uuid: formUuid,
					caseOperations: [{ owner: term(fixedLocation(locationUuid)) }],
				},
			},
		} as unknown as BlueprintDoc;
		expect(extractLocationReferenceTargets(doc)).toEqual([locationUuid]);
	});
});
