// e2e/lib/caseChangesSeed.test.ts
//
// The smoke journey asserts a refusal and a successful move. Both are
// facts about the SEEDED document, not about the browser — so they are
// pinned here, where a failure names the fixture instead of surfacing as
// a mystery Playwright timeout on CI.
//
// It also proves the fixture is a valid app. A seed that installs an
// invalid blueprint would still render, and the journey would then be
// asserting against a document Nova would never have let an author
// build.

import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { caseOperationMoveVerdicts } from "@/lib/doc/caseOperationReview";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { orderedCaseOperations } from "@/lib/domain";
import {
	buildCaseChangesBlueprint,
	CASE_CHANGES_SEED,
} from "./caseChangesSeed";

const doc = buildCaseChangesBlueprint();
const { formUuid, operations, ids } = CASE_CHANGES_SEED;

describe("the case-changes smoke fixture", () => {
	it("installs a valid app", () => {
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("lists its three changes in the order the journey reads them", () => {
		expect(
			orderedCaseOperations(doc.forms[formUuid] ?? {}).map((op) => op.id),
		).toEqual([ids.create, ids.note, ids.file]);
	});

	it("refuses moving the consumer ahead of the create it consumes", () => {
		// What the journey's Home keypress hits, and why the refusal has a
		// name to say.
		const verdict = caseOperationMoveVerdicts(
			doc,
			formUuid,
			operations.file,
		).get(0);
		expect(verdict).toEqual({
			ok: false,
			reason: "dependent-reference",
			// The moved operation is the one whose reference would break, which
			// is why the copy names what it DEPENDS on rather than naming it back.
			blockingUuids: [operations.file],
		});
	});

	it("still allows moving the change nothing depends on", () => {
		// The journey's second half: the same keyboard path moves what it may.
		expect(
			caseOperationMoveVerdicts(doc, formUuid, operations.note).get(0),
		).toEqual({ ok: true });
	});
});
