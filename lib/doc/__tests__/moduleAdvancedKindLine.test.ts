/**
 * The line module settings' In CommCare HQ row reads, over documents the
 * commit gate admits. The plausible failures: a line on a menu CommCare HQ
 * receives as an ordinary one; a carried create's line naming the wrong
 * form or case type, or the held line hidden behind it; and a line
 * disagreeing with the kind the emitter writes.
 */
import { describe, expect, it } from "vitest";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { moduleAdvancedKindLine } from "@/lib/doc/moduleKindMoves";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import {
	carryVisit,
	HOUSEHOLDS,
	kindFixture,
	publishedAdvanced,
	VISITS,
} from "./moduleKindMoveFixture";
import { refusalCodes } from "./placementMoveFixture";

const HELD_LINE =
	"CommCare HQ keeps this as an advanced menu, as your published app has it.";

function applied(doc: BlueprintDoc, edit: readonly Mutation[]): BlueprintDoc {
	expect(refusalCodes(doc, edit)).toEqual([]);
	return prepareMutationCandidate(doc, admitMutationBatch([...edit])).nextDoc;
}

describe("moduleAdvancedKindLine", () => {
	it("says nothing of a menu CommCare HQ receives as an ordinary one", () => {
		const doc = kindFixture();
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("basic");
		expect(moduleAdvancedKindLine(doc, HOUSEHOLDS)).toBeUndefined();
	});

	it("says a held menu stays advanced as the published app has it", () => {
		const doc = publishedAdvanced(kindFixture(), HOUSEHOLDS);
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		expect(moduleAdvancedKindLine(doc, HOUSEHOLDS)).toBe(HELD_LINE);
		expect(moduleAdvancedKindLine(doc, VISITS)).toBeUndefined();
	});

	it("names the form and the case type of a create a link after submit carries", () => {
		const doc = applied(kindFixture(), carryVisit());
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		expect(moduleAdvancedKindLine(doc, HOUSEHOLDS)).toBe(
			"CommCare HQ shows this as an advanced menu, because “Household visit” has a link after submit that opens the new visit case it creates, which only an advanced menu can hand on.",
		);
	});

	it("gives the held kind first where a carried create also needs the menu advanced", () => {
		const doc = applied(
			publishedAdvanced(kindFixture(), HOUSEHOLDS),
			carryVisit(),
		);
		expect(moduleAdvancedKindLine(doc, HOUSEHOLDS)).toBe(HELD_LINE);
	});
});
