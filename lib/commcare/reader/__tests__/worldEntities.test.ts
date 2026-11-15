/**
 * The project space's levels, and the worker and place information an app's
 * logic reads, as a reading brings them in.
 *
 * It would catch a level setting invented from `administrative`; a level
 * listed before its parent; a worker property minted for a built-in slug or
 * a slug outside the grammar; a draft holding a level the gate refuses,
 * or a level beneath one it refused; and a property minted for a read by name
 * under the UUID a held property kept from that slug, which would replace it.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	BUILT_IN_USER_PROPERTY_SLUGS,
	organizationLevelSchema,
	type Uuid,
} from "@/lib/domain";
import type { HqLocationType } from "../../hq/locations";
import {
	externalKey,
	matchingResolver,
	mintEntityUuid,
	mintingResolver,
} from "../identity";
import {
	levelsFromHq,
	namedWorkerReadsAreProperties,
	worldEntitiesFromReads,
} from "../worldEntities";

function level(
	code: string,
	parentCode: string | null,
	flags: Partial<HqLocationType> = {},
): HqLocationType {
	return {
		id: code,
		name: code.toUpperCase(),
		code,
		parentCode,
		administrative: false,
		sharesCases: false,
		viewDescendants: false,
		...flags,
	};
}

describe("levelsFromHq", () => {
	it("brings every level in, parent before child, each by the resolver's UUID for its code", () => {
		const { levels, findings } = levelsFromHq(
			[
				level("clinic", "district"),
				level("district", "state"),
				level("state", null),
			],
			mintingResolver("app-1"),
		);
		expect(findings).toEqual([]);
		expect(levels.map((one) => one.code)).toEqual([
			"state",
			"district",
			"clinic",
		]);
		const uuid = (code: string) =>
			mintEntityUuid("app-1", externalKey.organizationLevel(code));
		expect(levels.map((one) => [one.uuid, one.parentLevelUuid])).toEqual([
			[uuid("state"), undefined],
			[uuid("district"), uuid("state")],
			[uuid("clinic"), uuid("district")],
		]);
		for (const one of levels)
			expect(organizationLevelSchema.safeParse(one).success).toBe(true);
	});

	it.each([
		[false, false, { kind: "none" }],
		[true, false, { kind: "none" }],
		[false, true, { kind: "all" }],
		[true, true, { kind: "all" }],
	] as const)(
		"reads shares cases %s and views descendants %s as the case flow it gives, whatever administrative says",
		(sharesCases, viewDescendants, descendantCases) => {
			for (const administrative of [false, true]) {
				const { levels } = levelsFromHq(
					[
						level("site", null, {
							sharesCases,
							viewDescendants,
							administrative,
						}),
					],
					mintingResolver("app-1"),
				);
				expect(levels[0]).toMatchObject({
					caseFlow: {
						workers: "assigned",
						ownsCases: sharesCases,
						descendantCases,
					},
					addressBook: { reach: "own-branch" },
				});
			}
		},
	);

	it("leaves out a level whose code Nova cannot hold, and every level beneath it", () => {
		const { levels, findings } = levelsFromHq(
			[
				level("state", null),
				level("9-district", "state"),
				level("clinic", "9-district"),
				level("ward", "clinic"),
				level("region", "state"),
			],
			mintingResolver("app-1"),
		);
		expect(levels.map((one) => one.code)).toEqual(["state", "region"]);
		expect(findings).toEqual([
			{
				code: "place-not-holdable",
				standing: "not-yet",
				place: { kind: "organization" },
				subject: null,
				detail: { name: "9-DISTRICT" },
			},
		]);
	});

	it("gives a level whose parent is not listed a finding of its own", () => {
		const { levels, findings } = levelsFromHq(
			[level("clinic", "district")],
			mintingResolver("app-1"),
		);
		expect(levels).toEqual([]);
		expect(findings).toMatchObject([
			{ code: "place-not-holdable", detail: { name: "CLINIC" } },
		]);
	});
});

describe("worldEntitiesFromReads", () => {
	it("mints a property for each slug in the grammar, labelled with it, by the resolver's UUID", () => {
		const resolver = mintingResolver("app-1");
		const { userProperties, locationProperties } = worldEntitiesFromReads(
			{
				userFields: ["district_name", "rank", "district_name"],
				locationDataSlugs: ["catchment", "beds"],
			},
			resolver,
		);
		expect(userProperties).toEqual([
			{
				uuid: mintEntityUuid(
					"app-1",
					externalKey.userProperty("district_name"),
				),
				slug: "district_name",
				label: "district_name",
			},
			{
				uuid: mintEntityUuid("app-1", externalKey.userProperty("rank")),
				slug: "rank",
				label: "rank",
			},
		]);
		// In the order of the slugs, whichever was read first.
		expect(locationProperties).toEqual([
			{
				uuid: mintEntityUuid("app-1", externalKey.locationProperty("beds")),
				slug: "beds",
				label: "beds",
			},
			{
				uuid: mintEntityUuid(
					"app-1",
					externalKey.locationProperty("catchment"),
				),
				slug: "catchment",
				label: "catchment",
			},
		]);
	});

	it("mints no worker property for a slug CommCare supplies, or one outside the grammar", () => {
		const [builtIn] = [...BUILT_IN_USER_PROPERTY_SLUGS];
		const resolver = mintingResolver("app-1");
		const { userProperties, locationProperties } = worldEntitiesFromReads(
			{
				userFields: [
					builtIn ?? "commcare_first_name",
					"2fa",
					"has space",
					"commcare_x",
				],
				locationDataSlugs: [""],
			},
			resolver,
		);
		expect(userProperties).toEqual([]);
		expect(locationProperties).toEqual([]);
		expect(resolver.entries()).toEqual([]);
	});
});

describe("namedWorkerReadsAreProperties", () => {
	it("mints a property read by name under a UUID no held property holds, as a re-read does", () => {
		const base = buildDoc({
			modules: [
				{
					name: "Workers",
					forms: [
						{
							name: "Check",
							type: "survey",
							fields: [
								f({ kind: "hidden", id: "role", calculate: "#user/role" }),
							],
						},
					],
				},
			],
		});
		/* A reading minted `role`; Nova renamed it `position`, which kept the UUID. */
		const kept = mintEntityUuid(base.appId, externalKey.userProperty("role"));
		const doc = produce(base, (draft) => {
			draft.userProperties = {
				[kept]: { uuid: kept, slug: "position", label: "Position" },
			} as never;
			draft.userPropertyOrder = [kept];
		});
		const chosen = namedWorkerReadsAreProperties(doc);
		const reread = matchingResolver(doc.appId, [
			{ ...externalKey.userProperty("position"), uuid: kept },
		]).claim(externalKey.userProperty("role"), "app");
		if (!reread.ok) throw new Error("The read slug was claimed once.");
		expect(reread.uuid).not.toBe(kept);
		expect(
			(chosen.userPropertyOrder ?? []).map(
				(uuid: Uuid) => chosen.userProperties?.[uuid],
			),
		).toEqual([
			{ uuid: kept, slug: "position", label: "Position" },
			{ uuid: reread.uuid, slug: "role", label: "role" },
		]);
	});
});
