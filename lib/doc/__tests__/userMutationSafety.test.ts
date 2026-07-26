import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import { removeUserPropertyMutations } from "@/lib/doc/userMutations";
import { asUuid, type BlueprintDoc } from "@/lib/domain";

const PROPERTY_A = asUuid("__proto__");
const PROPERTY_B = asUuid("constructor");
const TYPE = asUuid("toString");
const PERSONA = asUuid("hasOwnProperty");

function ownRecord<T>(
	entries: ReadonlyArray<readonly [string, T]>,
): Record<string, T> {
	return Object.fromEntries(entries);
}

function fold(doc: BlueprintDoc, ...batches: Mutation[][]): BlueprintDoc {
	return produce(doc, (draft) => {
		for (const batch of batches) applyMutations(draft, batch);
	});
}

function userDoc(): BlueprintDoc {
	return {
		...buildDoc(),
		userProperties: ownRecord([
			[PROPERTY_A, { uuid: PROPERTY_A, slug: "__proto__", label: "Prototype" }],
			[
				PROPERTY_B,
				{ uuid: PROPERTY_B, slug: "constructor", label: "Constructor" },
			],
		]),
		userTypes: ownRecord([
			[
				TYPE,
				{
					uuid: TYPE,
					name: "Hostile-key role",
					values: ownRecord([
						[PROPERTY_A, "north"],
						[PROPERTY_B, "community"],
					]),
				},
			],
		]),
		personas: ownRecord([
			[
				PERSONA,
				{
					uuid: PERSONA,
					name: "Hostile-key persona",
					userTypeUuid: TYPE,
					values: ownRecord([[PROPERTY_A, "south"]]),
				},
			],
		]),
	};
}

function valueUpdate(
	kind: "updateUserType" | "updatePersona",
	uuid: string,
	propertyUuid: string,
	value: string | null,
	fallbackValues: Record<string, string> | null,
): Mutation {
	return {
		kind,
		uuid: asUuid(uuid),
		patch: { values: fallbackValues },
		valuePatch: { userPropertyUuid: asUuid(propertyUuid), value },
	} as Mutation;
}

describe("user collection mutations", () => {
	it("adds, updates, and removes hostile schema-valid record keys as own data", () => {
		const empty = buildDoc();
		const added = fold(empty, [
			{
				kind: "addUserProperty",
				property: {
					uuid: PROPERTY_A,
					slug: "__proto__",
					label: "Prototype",
				},
			},
			{
				kind: "addUserType",
				userType: {
					uuid: TYPE,
					name: "Hostile-key role",
					values: ownRecord([[PROPERTY_A, "north"]]),
				},
			},
			{
				kind: "addPersona",
				persona: {
					uuid: PERSONA,
					name: "Hostile-key persona",
					userTypeUuid: TYPE,
				},
			},
		]);

		expect(Object.hasOwn(added.userProperties ?? {}, PROPERTY_A)).toBe(true);
		expect(Object.hasOwn(added.userTypes ?? {}, TYPE)).toBe(true);
		expect(Object.hasOwn(added.personas ?? {}, PERSONA)).toBe(true);
		expect(added.userProperties?.[PROPERTY_A]?.label).toBe("Prototype");

		const updated = fold(added, [
			{
				kind: "updateUserProperty",
				uuid: PROPERTY_A,
				patch: { label: "Own prototype" },
			},
			valueUpdate(
				"updateUserType",
				TYPE,
				PROPERTY_A,
				"south",
				ownRecord([[PROPERTY_A, "south"]]),
			),
		]);
		expect(updated.userProperties?.[PROPERTY_A]?.label).toBe("Own prototype");
		expect(updated.userTypes?.[TYPE]?.values?.[PROPERTY_A]).toBe("south");

		const removed = fold(updated, [
			{ kind: "removePersona", uuid: PERSONA },
			{ kind: "removeUserType", uuid: TYPE },
			{ kind: "removeUserProperty", uuid: PROPERTY_A },
		]);
		expect(removed.personas).toBeUndefined();
		expect(removed.userTypes).toBeUndefined();
		expect(removed.userProperties).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("label");
	});

	it("merges concurrent writes to different value keys in either order", () => {
		const base = userDoc();
		const left = valueUpdate(
			"updateUserType",
			TYPE,
			PROPERTY_A,
			"left",
			ownRecord([
				[PROPERTY_A, "left"],
				[PROPERTY_B, "community"],
			]),
		);
		const right = valueUpdate(
			"updateUserType",
			TYPE,
			PROPERTY_B,
			"right",
			ownRecord([
				[PROPERTY_A, "north"],
				[PROPERTY_B, "right"],
			]),
		);

		const leftThenRight = fold(base, [left], [right]);
		const rightThenLeft = fold(base, [right], [left]);
		expect(leftThenRight.userTypes?.[TYPE]?.values).toEqual(
			ownRecord([
				[PROPERTY_A, "left"],
				[PROPERTY_B, "right"],
			]),
		);
		expect(rightThenLeft).toEqual(leftThenRight);
	});

	it("cleans a removed property with per-key mutations without clobbering a peer value", () => {
		const base = userDoc();
		const removal = removeUserPropertyMutations(base, PROPERTY_A);
		const cleanupEvents = removal.filter(
			(mutation) =>
				mutation.kind === "updateUserType" || mutation.kind === "updatePersona",
		);
		expect(cleanupEvents).toHaveLength(2);
		expect(
			cleanupEvents.every(
				(mutation) =>
					"valuePatch" in mutation &&
					mutation.valuePatch?.userPropertyUuid === PROPERTY_A &&
					mutation.valuePatch.value === null,
			),
		).toBe(true);

		const peer = valueUpdate(
			"updateUserType",
			TYPE,
			PROPERTY_B,
			"peer edit",
			ownRecord([
				[PROPERTY_A, "north"],
				[PROPERTY_B, "peer edit"],
			]),
		);
		const removalThenPeer = fold(base, removal, [peer]);
		const peerThenRemoval = fold(base, [peer], removal);
		expect(removalThenPeer.userTypes?.[TYPE]?.values).toEqual(
			ownRecord([[PROPERTY_B, "peer edit"]]),
		);
		expect(peerThenRemoval).toEqual(removalThenPeer);
	});
});

describe("user collection diff", () => {
	it("treats an inherited-name UUID as absent unless it is an own record key", () => {
		const before = buildDoc();
		const after: BlueprintDoc = {
			...before,
			userTypes: ownRecord([
				[
					asUuid("constructor"),
					{ uuid: asUuid("constructor"), name: "Constructor role" },
				],
			]),
		};

		expect(diffDocsToMutations(before, after)).toEqual([
			{
				kind: "addUserType",
				userType: { uuid: asUuid("constructor"), name: "Constructor role" },
			},
		]);
		expect(diffDocsToMutations(after, before)).toEqual([
			{ kind: "removeUserType", uuid: asUuid("constructor") },
		]);
	});

	it("emits one semantic mutation per changed value key", () => {
		const before = userDoc();
		const after: BlueprintDoc = {
			...before,
			userTypes: ownRecord([
				[
					TYPE,
					{
						...before.userTypes?.[TYPE],
						uuid: TYPE,
						name: "Hostile-key role",
						values: ownRecord([
							[PROPERTY_A, "after-a"],
							[PROPERTY_B, "after-b"],
						]),
					},
				],
			]),
		};

		const updates = diffDocsToMutations(before, after).filter(
			(mutation) => mutation.kind === "updateUserType",
		);
		expect(updates).toHaveLength(2);
		expect(
			updates.map((mutation) => mutation.valuePatch?.userPropertyUuid).sort(),
		).toEqual([PROPERTY_A, PROPERTY_B].sort());
		expect(fold(before, updates).userTypes).toEqual(after.userTypes);
	});
});
