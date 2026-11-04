/**
 * The invariant a publish's recording rests on: holding every placement the
 * emission derives changes no byte of what is emitted. Each generated
 * document is emitted as it is and again with `placementsToHold(doc)` applied
 * through the production admission and reducer, and the HQ import body and
 * the `.ccz` must be equal (both compiled at one sequence, so nothing the
 * sequence stamps differs, and at one instant, so no entry's time does).
 * The plausible failures are a derived Save to Case path that is not the
 * path the emitter writes (an allocator name the plan
 * does not reproduce), a held basic slot that the slot choice reads
 * differently from a derived one, and a held query repeat placement that
 * differs from the effective one; each changes a byte here. The held
 * document must also derive nothing more to hold.
 *
 * The advanced documents (`advancedDocArbitrary.ts`) hold a menu emitted
 * advanced for a create a link carries: holding its kind, and its forms'
 * loads and open actions by their tags, must keep every byte too, which a
 * held kind recorded after its forms' holds, or a tag the plan does not
 * keep, would not.
 *
 * The fuzz documents place their case changes in Case Management slots, so
 * the shared admitted emission corpus (`emissionFixtures.ts`) is held to the
 * same invariant: its case operation, capture and extension documents give
 * derived Save to Case paths and own closes in blocks of their own.
 */
import AdmZip from "adm-zip";
import * as fc from "fast-check";
import { expect, it, vi } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { advancedDocArbitrary } from "./advancedDocArbitrary";
import { assertGenerated, manifestFor } from "./compilerEvidence";
import { emissionFixtures } from "./emissionFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { blueprintDocArbitrary } from "./xformDocArbitrary";

const SEQUENCE = 7;

/** The instant every archive is written at: an archive entry carries the
 *  time it was added, so two archives made on either side of a clock tick
 *  differ in bytes and nothing else. */
const ARCHIVE_CLOCK = new Date("2026-11-02T00:00:00Z");

function emit(doc: BlueprintDoc, assets = manifestFor(doc)) {
	const hq = expandDoc(doc, { assets });
	vi.useFakeTimers({ toFake: ["Date"], now: ARCHIVE_CLOCK });
	try {
		const ccz = compileCcz(hq, doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
			assets,
			compiledAtSeq: SEQUENCE,
		});
		return { hq: JSON.stringify(hq), ccz };
	} finally {
		vi.useRealTimers();
	}
}

/** `doc` with `placementsToHold(doc)` applied through the production
 *  admission and reducer. */
function holding(doc: BlueprintDoc): BlueprintDoc {
	const candidate = prepareMutationCandidate(
		doc,
		admitMutationBatch([
			{ kind: "holdPlacements", holds: [...placementsToHold(doc)] },
		]),
	);
	expect(candidate.targetAdmissionIssue).toBeUndefined();
	return candidate.nextDoc;
}

/** Every archive entry's name and bytes, in archive order. */
function entries(ccz: Buffer): [string, string][] {
	return new AdmZip(ccz)
		.getEntries()
		.map((entry) => [entry.entryName, entry.getData().toString("base64")]);
}

it("emits the same HQ body and .ccz bytes but for the version with placementsToHold applied", {
	timeout: 60_000,
}, () => {
	const census = { total: 0, held: 0, queryRepeats: 0 };
	assertGenerated(
		fc.property(blueprintDocArbitrary, (doc) => {
			rebuildFieldParent(doc);
			census.total++;
			const holds = placementsToHold(doc);
			if (holds.length === 0) return;
			census.held++;
			if (holds.some((hold) => hold.target === "query-repeat"))
				census.queryRepeats++;
			const held = holding(doc);
			expect(placementsToHold(held)).toEqual([]);

			const before = emit(doc);
			const after = emit(held);
			expect(after.hq).toBe(before.hq);
			expect(entries(after.ccz)).toEqual(entries(before.ccz));
			expect(after.ccz.equals(before.ccz)).toBe(true);
		}),
		{ seed: 20261102, numRuns: 60 },
	);
	expect(census.total).toBe(60);
	expect(census.held).toBeGreaterThan(20);
	expect(census.queryRepeats).toBeGreaterThan(3);
});

it("emits the same HQ body and .ccz bytes for an advanced menu with its kind and case actions held", {
	timeout: 60_000,
}, () => {
	const census = { total: 0, kinds: 0, actions: 0 };
	assertGenerated(
		fc.property(advancedDocArbitrary, (doc) => {
			census.total++;
			const holds = placementsToHold(doc);
			if (holds.length === 0) return;
			const kinds = holds.filter((hold) => hold.target === "module-kind");
			if (kinds.length > 0) census.kinds++;
			if (
				holds.some(
					(hold) =>
						hold.target === "case-operation" &&
						hold.placement.kind === "advanced",
				)
			)
				census.actions++;
			// A menu's kind is held before any change its forms keep.
			for (const kind of kinds) {
				const firstOfMenu = holds.findIndex(
					(hold) =>
						hold.target !== "module-kind" &&
						hold.target !== "query-repeat" &&
						(doc.formOrder[kind.moduleUuid] ?? []).includes(hold.formUuid),
				);
				if (firstOfMenu !== -1)
					expect(holds.indexOf(kind)).toBeLessThan(firstOfMenu);
			}
			const held = holding(doc);
			expect(placementsToHold(held)).toEqual([]);

			const before = emit(doc);
			const after = emit(held);
			expect(after.hq).toBe(before.hq);
			expect(entries(after.ccz)).toEqual(entries(before.ccz));
			expect(after.ccz.equals(before.ccz)).toBe(true);
		}),
		{ seed: 20261102, numRuns: 30 },
	);
	expect(census.total).toBe(30);
	expect(census.kinds).toBeGreaterThan(10);
	expect(census.actions).toBeGreaterThan(10);
});

it("emits the same HQ body and .ccz bytes for every admitted emission fixture with its placements held", {
	// Two emissions of each of the hundred-odd fixtures: about a second and a
	// half alone, past five while the suite shares the cores.
	timeout: 60_000,
}, () => {
	const census = { saveToCase: 0, ownClose: 0 };
	for (const fixture of emissionFixtures()) {
		const { name, assets, doc } = fixture;
		const holds = placementsToHold(doc);
		if (holds.length === 0) continue;
		for (const hold of holds) {
			if (hold.target === "own-close") census.ownClose++;
			if (
				hold.target === "case-operation" &&
				hold.placement.kind === "save-to-case"
			)
				census.saveToCase++;
		}
		const held = holding(doc);
		expect(placementsToHold(held), name).toEqual([]);
		const before = emit(doc, assets ?? manifestFor(doc));
		const after = emit(held, assets ?? manifestFor(held));
		expect(after.hq, name).toBe(before.hq);
		expect(entries(after.ccz), name).toEqual(entries(before.ccz));
		expect(after.ccz.equals(before.ccz), name).toBe(true);
	}
	expect(census.saveToCase).toBeGreaterThan(5);
	expect(census.ownClose).toBeGreaterThan(0);
});
