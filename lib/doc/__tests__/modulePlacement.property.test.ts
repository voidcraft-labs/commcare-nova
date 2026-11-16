/**
 * The work a whole-app batch of menu births does once rather than once per
 * menu, held to the plain paths it replaced over the documents the oracle
 * corpora draw:
 *
 * - the reducer's placement of a menu (`mutations/modules.ts`), which asks
 *   whether the anchor is a sibling of the destination by the anchor alone
 *   and copies the order once, never scanning every menu's parent;
 * - the sequence admission's sibling groups
 *   (`mutationSequenceAdmission.ts::placeModule`), which place a birth in
 *   the group in place and no longer rebuild an order nothing reads;
 * - the admission of two admitted batches joined
 *   (`mutationAdmission.ts::concatAdmittedMutationBatches`), which takes
 *   each admitted mutation as it stands.
 *
 * Each plain path is the code as it stood, written out here. A plausible
 * failure: a placement that lands a menu elsewhere, or refuses or admits an
 * anchor the plain path did not, in a batch that places several menus.
 */
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { advancedDocArbitrary } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { menuScreenDocArbitrary } from "@/lib/commcare/__tests__/menuScreenDocArbitrary";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	concatAdmittedMutationBatches,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import { mutationSequenceAdmissionIssue } from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { Uuid } from "@/lib/domain/uuid";

type Parent = Uuid | null;

function parentOf(doc: BlueprintDoc, uuid: Uuid): Parent | undefined {
	const module = doc.modules[uuid];
	if (module === undefined) return undefined;
	return module.parentModuleUuid ?? null;
}

function siblings(doc: BlueprintDoc, parent: Parent, excluding?: Uuid): Uuid[] {
	return doc.moduleOrder.filter(
		(uuid) => uuid !== excluding && parentOf(doc, uuid) === parent,
	);
}

/** The reducer's placement as it stood: every sibling scanned, the order copied twice. */
function plainPlacement(
	doc: BlueprintDoc,
	uuid: Uuid,
	destinationParent: Parent,
	after: Uuid | null | undefined,
	moving: readonly Uuid[],
): Uuid[] | undefined {
	if (destinationParent !== null) {
		if (destinationParent === uuid) return undefined;
		if (parentOf(doc, destinationParent) !== null) return undefined;
		if (moving.length > 1) return undefined;
	}
	const destinationSiblings = siblings(doc, destinationParent, uuid);
	if (
		after !== undefined &&
		after !== null &&
		!destinationSiblings.includes(after)
	)
		return undefined;
	const movingSet = new Set(moving);
	const without = doc.moduleOrder.filter((entry) => !movingSet.has(entry));
	let insertionIndex: number;
	if (destinationParent === null) {
		if (after === undefined) insertionIndex = without.length;
		else if (after === null) insertionIndex = 0;
		else {
			const anchorIndex = without.indexOf(after);
			if (anchorIndex < 0) return undefined;
			insertionIndex = anchorIndex + 1;
			while (insertionIndex < without.length) {
				const candidate = without[insertionIndex];
				if (candidate === undefined || parentOf(doc, candidate) !== after)
					break;
				insertionIndex++;
			}
		}
	} else {
		const parentIndex = without.indexOf(destinationParent);
		if (parentIndex < 0) return undefined;
		if (after === null) insertionIndex = parentIndex + 1;
		else if (after !== undefined) {
			const anchorIndex = without.indexOf(after);
			if (anchorIndex < 0) return undefined;
			insertionIndex = anchorIndex + 1;
		} else {
			insertionIndex = parentIndex + 1;
			while (insertionIndex < without.length) {
				const candidate = without[insertionIndex];
				if (
					candidate === undefined ||
					parentOf(doc, candidate) !== destinationParent
				)
					break;
				insertionIndex++;
			}
		}
	}
	return [
		...without.slice(0, insertionIndex),
		...moving,
		...without.slice(insertionIndex),
	];
}

/** The order the reducer leaves after `mutation`, by the plain placement. */
function plainOrderAfter(doc: BlueprintDoc, mutation: Mutation): Uuid[] {
	if (mutation.kind === "addModule") {
		const uuid = mutation.module.uuid;
		return (
			plainPlacement(
				doc,
				uuid,
				mutation.module.parentModuleUuid ?? null,
				mutation.after,
				[uuid],
			) ?? doc.moduleOrder
		);
	}
	if (mutation.kind !== "moveModule") return doc.moduleOrder;
	const { uuid } = mutation;
	if (doc.modules[uuid] === undefined || !doc.moduleOrder.includes(uuid))
		return doc.moduleOrder;
	const current = parentOf(doc, uuid);
	if (current === undefined) return doc.moduleOrder;
	const destination = Object.hasOwn(mutation, "parentModuleUuid")
		? (mutation.parentModuleUuid ?? null)
		: current;
	const moving = current === null ? [uuid, ...siblings(doc, uuid)] : [uuid];
	return (
		plainPlacement(doc, uuid, destination, mutation.after, moving) ??
		doc.moduleOrder
	);
}

/** The sequence admission's menu placement as it stood, over a batch of menu births and moves. */
function plainAdmission(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): { mutationIndex: number; anchor: string } | undefined {
	const parent = new Map<string, string | null>();
	const groups = new Map<string, string[]>();
	for (const uuid of doc.moduleOrder) {
		const of = doc.modules[uuid]?.parentModuleUuid ?? null;
		parent.set(uuid, of);
		groups.set(of ?? "", [...(groups.get(of ?? "") ?? []), uuid]);
	}
	const place = (
		member: string,
		destinationParent: string | null,
		after: string | null | undefined,
		requireExisting: boolean,
	): boolean => {
		const currentParent = parent.get(member);
		if (requireExisting && currentParent === undefined) return false;
		const destinationKey = destinationParent ?? "";
		const destination = [...(groups.get(destinationKey) ?? [])].filter(
			(uuid) => uuid !== member,
		);
		if (after === member) return false;
		let at: number;
		if (after === undefined) at = destination.length;
		else if (after === null) at = 0;
		else {
			const anchorIndex = destination.indexOf(after);
			if (anchorIndex < 0) return false;
			at = anchorIndex + 1;
		}
		if (currentParent !== undefined)
			groups.set(
				currentParent ?? "",
				(groups.get(currentParent ?? "") ?? []).filter(
					(uuid) => uuid !== member,
				),
			);
		destination.splice(at, 0, member);
		groups.set(destinationKey, destination);
		parent.set(member, destinationParent);
		return true;
	};
	for (const [mutationIndex, mutation] of mutations.entries()) {
		const placed =
			mutation.kind === "addModule"
				? place(
						mutation.module.uuid,
						mutation.module.parentModuleUuid ?? null,
						mutation.after,
						false,
					)
				: mutation.kind === "moveModule"
					? place(
							mutation.uuid,
							Object.hasOwn(mutation, "parentModuleUuid")
								? (mutation.parentModuleUuid ?? null)
								: (parent.get(mutation.uuid) ?? null),
							mutation.after,
							true,
						)
					: true;
		if (!placed)
			return {
				mutationIndex,
				anchor:
					mutation.kind === "addModule" || mutation.kind === "moveModule"
						? (mutation.after ?? "(first)")
						: "(first)",
			};
	}
	return undefined;
}

/** A menu birth or move, its members, anchors and parents drawn from `pool`. */
const placementArbitrary = fc.record({
	kind: fc.constantFrom("add" as const, "move" as const),
	member: fc.nat(),
	after: fc.oneof(fc.constant(undefined), fc.constant(null), fc.nat()),
	parent: fc.oneof(fc.constant("omit" as const), fc.constant(null), fc.nat()),
});

function placementOf(
	doc: BlueprintDoc,
	pool: readonly Uuid[],
	draw: {
		kind: "add" | "move";
		member: number;
		after: number | null | undefined;
		parent: "omit" | number | null;
	},
	born: number,
): Mutation {
	const at = (index: number) => pool[index % pool.length] as Uuid;
	const after = typeof draw.after === "number" ? at(draw.after) : draw.after;
	const parent =
		typeof draw.parent === "number" ? at(draw.parent) : draw.parent;
	if (draw.kind === "add") {
		const template = Object.values(doc.modules)[0];
		const uuid = `born-menu-${born}` as Uuid;
		const { parentModuleUuid: _parent, ...rest } = template ?? {
			uuid,
			id: "born",
			name: "Born",
		};
		return {
			kind: "addModule",
			module: {
				...(rest as BlueprintDoc["modules"][string]),
				uuid,
				...(typeof parent === "string" ? { parentModuleUuid: parent } : {}),
			},
			...(after === undefined ? {} : { after }),
		} as Mutation;
	}
	return {
		kind: "moveModule",
		uuid: at(draw.member),
		...(after === undefined ? {} : { after }),
		...(parent === "omit" ? {} : { parentModuleUuid: parent }),
	} as Mutation;
}

const corpora: readonly [string, fc.Arbitrary<BlueprintDoc>][] = [
	["workflow", suiteDocArbitrary],
	["menu screens", menuScreenDocArbitrary],
	["advanced menus", advancedDocArbitrary],
];

describe("a menu placed once per birth", () => {
	it.each(corpora)(
		"lands each %s menu birth and move where the plain placement does",
		async (_name, arbitrary) => {
			await fc.assert(
				fc.property(
					arbitrary,
					fc.array(placementArbitrary, { minLength: 1, maxLength: 4 }),
					(doc, draws) => {
						const pool = [
							...doc.moduleOrder,
							"born-menu-0" as Uuid,
							"not-a-menu" as Uuid,
						];
						let working = doc;
						draws.forEach((draw, index) => {
							const mutation = placementOf(working, pool, draw, index);
							const expected = plainOrderAfter(working, mutation);
							working = produce(working, (draft) => {
								applyMutations(draft, [mutation]);
							});
							expect(working.moduleOrder).toEqual(expected);
						});
					},
				),
				{ numRuns: 40, seed: 20261116 },
			);
		},
		60_000,
	);

	it.each(corpora)(
		"admits a batch of %s menu births and moves where the plain admission does",
		async (_name, arbitrary) => {
			await fc.assert(
				fc.property(
					arbitrary,
					fc.array(placementArbitrary, { minLength: 1, maxLength: 6 }),
					(doc, draws) => {
						const pool = [
							...doc.moduleOrder,
							"born-menu-0" as Uuid,
							"born-menu-1" as Uuid,
							"not-a-menu" as Uuid,
						];
						const mutations = draws.map((draw, index) =>
							placementOf(doc, pool, draw, index),
						);
						const issue = mutationSequenceAdmissionIssue(doc, mutations);
						const plain = plainAdmission(doc, mutations);
						expect(
							issue === undefined
								? undefined
								: { mutationIndex: issue.mutationIndex, anchor: issue.anchor },
						).toEqual(plain);
					},
				),
				{ numRuns: 60, seed: 20261116 },
			);
		},
		60_000,
	);
});

function admission(run: () => unknown): unknown {
	try {
		return { admitted: run() };
	} catch (error) {
		if (error instanceof MutationWireCanonicalityError)
			return { refused: error.details };
		throw error;
	}
}

describe("two admitted batches joined", () => {
	it.each(corpora)(
		"admit a %s construction batch cut anywhere as the whole batch admits",
		async (_name, arbitrary) => {
			await fc.assert(
				fc.property(arbitrary, fc.nat(), (draw, cut) => {
					/* The draw as stored, so its batch is the wire's. */
					const doc = hydratePersistedBlueprint(
						JSON.parse(JSON.stringify(toPersistableDoc(draw))),
					);
					const batch = diffDocsToMutations(emptyBlueprintDoc(doc.appId), doc);
					const at = batch.length === 0 ? 0 : cut % (batch.length + 1);
					const whole = admission(() => admitMutationBatch(batch));
					const parts = [batch.slice(0, at), batch.slice(at)].map((part) =>
						admission(() => admitMutationBatch(part)),
					);
					/* A batch the whole admission refuses has a part it refuses. */
					if (!("admitted" in (whole as object))) {
						expect(
							parts.some((part) => !("admitted" in (part as object))),
						).toBe(true);
						return;
					}
					const [first, second] = parts.map(
						(part) => (part as { admitted: AdmittedMutationBatch }).admitted,
					) as [AdmittedMutationBatch, AdmittedMutationBatch];
					const joined = concatAdmittedMutationBatches(first, second);
					expect(joined).toEqual(
						(whole as { admitted: AdmittedMutationBatch }).admitted,
					);
					expect(Object.isFrozen(joined)).toBe(true);
					/* The gate meets it as admitted, as it meets the whole. */
					expect(admitMutationBatch(joined)).toBe(joined);
				}),
				{ numRuns: 20, seed: 20261116 },
			);
		},
		60_000,
	);

	it("refuses a case-property rename beside another mutation as the whole batch's admission does", () => {
		const rename = (): Mutation[] => [
			{
				kind: "renameCaseProperties",
				renames: [{ caseType: "patient", from: "age", to: "years" }],
			},
		];
		const other = (): Mutation[] => [{ kind: "setAppName", name: "Clinic" }];
		for (const [first, second] of [
			[rename, other],
			[other, rename],
		] as const)
			expect(
				admission(() =>
					concatAdmittedMutationBatches(
						admitMutationBatch(first()),
						admitMutationBatch(second()),
					),
				),
			).toEqual(admission(() => admitMutationBatch([...first(), ...second()])));
		const alone = admitMutationBatch(rename());
		expect(concatAdmittedMutationBatches(alone, admitMutationBatch([]))).toBe(
			alone,
		);
	});
});
