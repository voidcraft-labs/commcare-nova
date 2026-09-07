/** Eligibility and complete write inputs for the worker-row sweep. These are
 * projection tests over UserCollections, not database/query-count evidence. */
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { UserCollections } from "@/lib/domain";
import {
	workersNeedingUsercaseSync,
	workersWithRemovedUsercases,
} from "../syncUsercaseRow";

const A = testUuid("sync-amara");
const B = testUuid("sync-bala");
const C = testUuid("sync-chen");
const ROLE = testUuid("sync-role");
const CADRE = testUuid("sync-cadre");
type CollectionsFixture = {
	-readonly [Key in keyof Required<UserCollections>]: Required<UserCollections>[Key];
};
function fixture(): CollectionsFixture {
	return {
		userProperties: { [CADRE]: { uuid: CADRE, slug: "cadre", label: "Cadre" } },
		userPropertyOrder: [CADRE],
		userTypes: {
			[ROLE]: { uuid: ROLE, name: "Nurse", values: { [CADRE]: "nurse" } },
		},
		userTypeOrder: [ROLE],
		personas: {
			[A]: { uuid: A, name: "Amara", userTypeUuid: ROLE },
			[B]: {
				uuid: B,
				name: "Bala",
				userTypeUuid: ROLE,
				values: { [CADRE]: "" },
			},
			[C]: {
				uuid: C,
				name: "Chen",
				userTypeUuid: ROLE,
				values: { [CADRE]: "driver" },
			},
		},
		personaOrder: [A, B, C],
	};
}
function changes(prior: UserCollections, next: UserCollections) {
	return workersNeedingUsercaseSync({ prior, next, projectSpace: null });
}
function worker(
	id: string,
	name: string,
	authored: Record<string, string>,
	locationIds: string[] = [],
) {
	return {
		worker: { id, username: name, personName: name, email: "", locationIds },
		authored,
	};
}
function changedIds(prior: UserCollections, next: UserCollections) {
	return changes(prior, next)
		.map((entry) => entry.worker.id)
		.sort();
}

it("ignores unchanged values, cloned collections, presentation metadata and authored ordering", () => {
	const prior = fixture(),
		next = structuredClone(prior);
	expect(changes(prior, prior)).toEqual([]);
	expect(changes(prior, next)).toEqual([]);
	next.userProperties[CADRE].label = "Job";
	next.userTypes[ROLE].name = "Community team";
	next.personas[A].description = "A field worker";
	next.personaOrder = [C, B, A];
	expect(changes(prior, next)).toEqual([]);
	expect(workersWithRemovedUsercases({ prior, next })).toEqual([]);
});

it("supplies the exact renamed worker, ordered locations and inherited values without rewriting colleagues or input state", () => {
	const prior = fixture(),
		next = structuredClone(prior);
	const main = testUuid("sync-main"),
		additional = testUuid("sync-additional");
	next.personas[A] = {
		...next.personas[A],
		name: "Amara Sow",
		locations: { primaryUuid: main, additionalUuids: [additional] },
	};
	const before = structuredClone({ prior, next });
	expect(changes(prior, next)).toEqual([
		worker(A, "Amara Sow", { [CADRE]: "nurse" }, [main, additional]),
	]);
	expect({ prior, next }).toEqual(before);
	const reversed = structuredClone(next);
	reversed.personas[A].locations = {
		primaryUuid: additional,
		additionalUuids: [main],
	};
	expect(changes(next, reversed)).toEqual([
		worker(A, "Amara Sow", { [CADRE]: "nurse" }, [additional, main]),
	]);
});

it("recomputes role defaults only for inheriting personas, preserving blank and nonblank overrides", () => {
	const prior = fixture(),
		next = structuredClone(prior);
	next.userTypes[ROLE].values = { [CADRE]: "supervisor" };
	expect(changes(prior, next)).toEqual([
		worker(A, "Amara", { [CADRE]: "supervisor" }),
	]);
	const overridden = structuredClone(prior);
	overridden.personas[A].values = { [CADRE]: "nurse" };
	expect(changes(prior, overridden)).toEqual([]);
	const clearedOverride = structuredClone(prior);
	delete clearedOverride.personas[B].values;
	expect(changes(prior, clearedOverride)).toEqual([
		worker(B, "Bala", { [CADRE]: "nurse" }),
	]);
});

it("resynchronizes every affected record when the stored property surface changes, even without an authored value change", () => {
	const prior = fixture(),
		added = structuredClone(prior);
	const license = testUuid("sync-license");
	added.userProperties[license] = {
		uuid: license,
		slug: "license",
		label: "License",
	};
	added.userPropertyOrder = [CADRE, license];
	expect(changedIds(prior, added)).toEqual([A, B, C].sort());
	expect(changedIds(added, prior)).toEqual([A, B, C].sort());
	const renamed = structuredClone(prior);
	renamed.userProperties[CADRE].slug = "job";
	expect(changedIds(prior, renamed)).toEqual([A, B, C].sort());
	expect(
		changes(prior, renamed).find((entry) => entry.worker.id === A),
	).toEqual(worker(A, "Amara", { [CADRE]: "nurse" }));
});

it("separates added and removed identities from updates, including replacement under the same display name", () => {
	const prior = fixture(),
		next = structuredClone(prior);
	const replacement = testUuid("sync-replacement");
	delete next.personas[A];
	next.personas[replacement] = {
		uuid: replacement,
		name: "Amara",
		userTypeUuid: ROLE,
	};
	next.personaOrder = [replacement, B, C];
	expect(changes(prior, next)).toEqual([
		worker(replacement, "Amara", { [CADRE]: "nurse" }),
	]);
	expect(workersWithRemovedUsercases({ prior, next })).toEqual([A]);
	expect(changes(next, {})).toEqual([]);
	expect(
		[...workersWithRemovedUsercases({ prior: next, next: {} })].sort(),
	).toEqual([replacement, B, C].sort());
	expect(workersWithRemovedUsercases({ prior: {}, next })).toEqual([]);
});
