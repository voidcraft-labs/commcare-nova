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
import { caseOperationTargetTypeAfter } from "@/lib/doc/caseOperationIntents";
import { caseOperationMoveVerdicts } from "@/lib/doc/caseOperationReview";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type LookupColumnId,
	type LookupTableId,
	orderedCaseOperations,
} from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";
import {
	buildCaseChangesBlueprint,
	CASE_CHANGES_SEED,
} from "./caseChangesSeed";

const doc = buildCaseChangesBlueprint();
const { formUuid, operations, ids } = CASE_CHANGES_SEED;
const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;

describe("the case-changes smoke fixture", () => {
	it("installs a valid app", () => {
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("lists its changes in the order the journey reads them", () => {
		expect(
			orderedCaseOperations(doc.forms[formUuid] ?? {}).map((op) => op.id),
		).toEqual([ids.create, ids.retype, ids.note, ids.file]);
	});

	it("projects both the unchanged session type and the earlier create's retype", () => {
		expect(
			caseOperationTargetTypeAfter(
				orderedCaseOperations(doc.forms[formUuid] ?? {}),
				{ kind: "session" },
				CASE_CHANGES_SEED.caseType,
			),
		).toBe("patient");
		expect(
			caseOperationTargetTypeAfter(
				orderedCaseOperations(doc.forms[formUuid] ?? {}),
				{ kind: "op", opUuid: operations.create },
				CASE_CHANGES_SEED.caseType,
			),
		).toBe(CASE_CHANGES_SEED.archivedCaseType);
	});

	it("can install one valid dormant lookup carrier for the browser journey", () => {
		const withLookup = buildCaseChangesBlueprint("test-app", {
			tableId: TABLE,
			columnId: COLUMN,
		});
		expect(
			runValidation(withLookup, {
				kind: "available",
				projectId: "smoke-project",
				projectRevision: parseLookupRevision("1"),
				definitions: [
					{
						id: TABLE,
						name: "Smoke flags",
						tag: "smoke_flags",
						definitionRevision: parseLookupRevision("1"),
						columns: [
							{
								id: COLUMN,
								wireName: "status",
								label: "Status",
								dataType: "text",
							},
						],
					},
				],
			}),
		).toEqual([]);
		expect(
			orderedCaseOperations(withLookup.forms[formUuid] ?? {}).map(
				(operation) => operation.id,
			),
		).toEqual([ids.create, ids.retype, ids.note, ids.file, ids.dormant]);
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
