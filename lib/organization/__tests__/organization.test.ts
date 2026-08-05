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
import {
	removeOrganizationLevelPlan,
	setPersonaLocationsMutations,
} from "@/lib/doc/organizationMutations";
import {
	automationMessageText,
	type BlueprintDoc,
	levelMayNestUnder,
	locationPropertySchema,
	MAX_LOCATION_PROPERTY_CHOICES,
	MAX_LOCATION_VALUE_LENGTH,
	type OrganizationLevel,
	organizationLevelSchema,
	type Persona,
} from "@/lib/domain";
import { fixedLocation, term } from "@/lib/domain/predicate";
import { extractLocationReferenceTargets } from "@/lib/organization/commitIntegrity";
import {
	canonicalCoordinate,
	createLocationInputSchema,
	deriveSiteCode,
	MAX_ATOMIC_LOCATION_DESCENDANTS,
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

describe("setPersonaLocationsMutations", () => {
	it("deduplicates a maximum-size assignment in first-seen order", () => {
		const ids = Array.from({ length: 10_000 }, (_, index) =>
			asUuid(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
		);
		const [mutation] = setPersonaLocationsMutations(
			asUuid("ffffffff-ffff-4fff-8fff-ffffffffffff"),
			[...ids, ...ids],
		);
		expect(mutation).toMatchObject({
			kind: "updatePersona",
			patch: {
				locations: {
					primaryUuid: ids[0],
					additionalUuids: ids.slice(1),
				},
			},
		});
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

	it("refuses an empty closed choice catalog before it can dead-end places", () => {
		expect(
			locationPropertySchema.safeParse({
				uuid: lower,
				slug: "kind",
				label: "Facility kind",
				required: true,
				choices: [],
			}).success,
		).toBe(false);
	});

	it("bounds closed choices to values and payloads the location store accepts", () => {
		const base = {
			uuid: lower,
			slug: "kind",
			label: "Facility kind",
		};
		expect(
			locationPropertySchema.safeParse({
				...base,
				choices: ["a".repeat(MAX_LOCATION_VALUE_LENGTH)],
			}).success,
		).toBe(true);
		expect(
			locationPropertySchema.safeParse({
				...base,
				choices: ["a".repeat(MAX_LOCATION_VALUE_LENGTH + 1)],
			}).success,
		).toBe(false);
		expect(
			locationPropertySchema.safeParse({
				...base,
				choices: Array.from(
					{ length: MAX_LOCATION_PROPERTY_CHOICES + 1 },
					(_, index) => `choice-${index}`,
				),
			}).success,
		).toBe(false);
	});

	it("refuses duplicate semantic level identities", () => {
		expect(
			organizationLevelSchema.safeParse({
				uuid: lower,
				code: "facility",
				name: "Facility",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: {
					reach: "own-branch-limited",
					levelUuids: [lower, lower],
				},
			}).success,
		).toBe(false);
		expect(
			locationPropertySchema.safeParse({
				uuid: lower,
				slug: "kind",
				label: "Facility kind",
				levelUuids: [lower, lower],
			}).success,
		).toBe(false);
	});

	it("refuses strings Postgres cannot persist", () => {
		for (const invalid of ["North\u0000District", "North\uD800District"]) {
			expect(
				createLocationInputSchema.safeParse({
					levelUuid: lower,
					name: invalid,
				}).success,
			).toBe(false);
			expect(
				updateLocationInputSchema.safeParse({ name: invalid }).success,
			).toBe(false);
			expect(
				createLocationInputSchema.safeParse({
					levelUuid: lower,
					name: "North",
					externalId: invalid,
				}).success,
			).toBe(false);
			expect(
				updateLocationInputSchema.safeParse({ externalId: invalid }).success,
			).toBe(false);
		}
		expect(
			createLocationInputSchema.safeParse({
				levelUuid: lower,
				name: "North 😀",
				externalId: "external-😀",
			}).success,
		).toBe(true);
	});

	it("admits a structurally nested descendant tree within the request bound", () => {
		const base = {
			levelUuid: lower,
			name: "North",
			descendants: [
				{
					levelUuid: lower,
					name: "Facility",
					descendants: [
						{
							levelUuid: lower,
							name: "Ward",
						},
					],
				},
			],
		};
		expect(createLocationInputSchema.safeParse(base).success).toBe(true);
		const tooMany = {
			...base,
			descendants: [
				{
					levelUuid: lower,
					name: "Facility",
					descendants: Array.from(
						{ length: MAX_ATOMIC_LOCATION_DESCENDANTS },
						(_, index) => ({
							levelUuid: lower,
							name: `Ward ${index}`,
						}),
					),
				},
			],
		};
		expect(createLocationInputSchema.safeParse(tooMany).success).toBe(false);

		let deep: Record<string, unknown> = {
			levelUuid: lower,
			name: "Deep leaf",
		};
		for (let depth = 0; depth < 2_500; depth += 1) {
			deep = {
				levelUuid: lower,
				name: `Deep ${depth}`,
				descendants: [deep],
			};
		}
		expect(createLocationInputSchema.safeParse(deep).success).toBe(false);
	});

	it("canonicalizes coordinates to the matching numeric(20,10) spelling", () => {
		const parsed = createLocationInputSchema.parse({
			levelUuid: lower,
			name: "North",
			latitude: "-0.0000000000",
			longitude: "12.3400000000",
		});
		expect(parsed.latitude).toBe("0");
		expect(parsed.longitude).toBe("12.34");
		expect(canonicalCoordinate("180.0000000000")).toBe("180");
		expect(
			createLocationInputSchema.safeParse({
				levelUuid: lower,
				name: "North",
				latitude: "1.12345678901",
			}).success,
		).toBe(false);
	});

	it("supports UUID-addressed value edits and atomic retype/move patches", () => {
		expect(
			updateLocationInputSchema.parse({
				valuePatch: { [lower]: null },
				levelUuid: lower,
				parentId: null,
				afterSiblingId: null,
			}),
		).toMatchObject({
			valuePatch: { [lower]: null },
			levelUuid: lower,
			parentId: null,
			afterSiblingId: null,
		});
		expect(updateLocationInputSchema.safeParse({}).success).toBe(false);
		expect(
			updateLocationInputSchema.safeParse({
				values: { [lower]: "all" },
				valuePatch: { [lower]: "one" },
			}).success,
		).toBe(false);
		expect(
			updateLocationInputSchema.safeParse({
				valuePatch: { [lower]: "one", [upper]: "two" },
			}).success,
		).toBe(false);
	});
});

describe("removeOrganizationLevelPlan", () => {
	it("gives a workable recovery when archived rows still occupy the level", () => {
		const region = asUuid("11111111-1111-4111-8111-111111111111");
		const doc = docWithPersonas([]);
		doc.organizationLevels = { [region]: level(region, "Region") };
		doc.organizationLevelOrder = [region];

		expect(
			removeOrganizationLevelPlan(doc, region, new Set([region])),
		).toMatchObject({
			ok: false,
			userMessage: expect.stringMatching(
				/bring back any archived places.*move every place/i,
			),
		});
	});

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

	it("refuses to remove a level used by an automation recipient filter", () => {
		const region = asUuid("11111111-1111-4111-8111-111111111111");
		const automationUuid = asUuid("33333333-3333-4333-8333-333333333333");
		const recipientUuid = asUuid("44444444-4444-4444-8444-444444444444");
		const eventUuid = asUuid("55555555-5555-4555-8555-555555555555");
		const locationUuid = asUuid("66666666-6666-4666-8666-666666666666");
		const doc = docWithPersonas([]);
		doc.organizationLevels = { [region]: level(region, "Region") };
		doc.organizationLevelOrder = [region];
		doc.automations = {
			[automationUuid]: {
				uuid: automationUuid,
				kind: "conditional-alert",
				name: "Regional reminder",
				caseType: "patient",
				criteriaOperator: "all",
				criteria: [],
				setupOnlyCriteria: [],
				recipients: [{ uuid: recipientUuid, kind: "location", locationUuid }],
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: eventUuid,
							minutesToWait: 0,
							content: {
								kind: "sms",
								message: automationMessageText("Follow up"),
							},
						},
					],
				},
				includeDescendantLocations: true,
				locationLevelUuids: [region],
				userDataFilters: [],
				useUserCaseForFilter: false,
			},
		};
		doc.automationOrder = [automationUuid];

		expect(removeOrganizationLevelPlan(doc, region)).toEqual({
			ok: false,
			userMessage:
				'Automation "Regional reminder" uses "Region" as a recipient location level. Change that automation first, then remove the level.',
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
			fingerprintRows: [],
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
		expect(plan.fingerprintRows).toEqual([
			{
				personaUuid: asUuid("p1"),
				before: [asUuid("loc-a"), asUuid("loc-b")],
				after: [],
			},
		]);
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

	it("includes automation location conditions in the same exact edge set", () => {
		const locationUuid = asUuid("loc-automation-condition");
		const automationUuid = asUuid("automation-location-condition");
		const doc = {
			...docWithPersonas([]),
			automations: {
				[automationUuid]: {
					uuid: automationUuid,
					kind: "case-update",
					name: "Location cleanup",
					caseType: "visit",
					criteriaOperator: "all",
					criteria: [
						{
							uuid: asUuid("automation-location-criterion"),
							kind: "location",
							locationUuid,
							includeDescendants: true,
						},
					],
					setupOnlyCriteria: [],
					updates: [],
					closeCase: true,
				},
			},
			automationOrder: [automationUuid],
		} as unknown as BlueprintDoc;
		expect(extractLocationReferenceTargets(doc)).toEqual([locationUuid]);
	});
});
