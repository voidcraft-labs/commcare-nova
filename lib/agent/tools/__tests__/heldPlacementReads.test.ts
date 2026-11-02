/**
 * What the shared reads say about a published app's held places, through the
 * real tools and the authored read projection every client sees. The
 * plausible failures: a held place read the same as a planned one (so the
 * model cannot tell an edit would move it), and a stored hold leaking into a
 * read as a key no edit accepts.
 */

import { describe, expect, it } from "vitest";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { projectAuthoringRead } from "@/lib/agent/authoring/output";
import {
	DISCHARGE,
	FOLLOWUP,
	holdPlanned,
	holdVisits,
	moveFixture,
	PATIENTS,
	U,
} from "@/lib/doc/__tests__/placementMoveFixture";
import type { BlueprintDoc } from "@/lib/domain";
import { getCaseOperationsTool } from "../case-operations/getCaseOperations";
import { getFieldTool } from "../getField";

/** The app as a publish recorded it. The fixture holds placements by
 *  changing the document it planned them over, so the held app is a new
 *  document object: the placement plans are memoized per document. */
function published(): BlueprintDoc {
	const doc = holdVisits(moveFixture(), "model-iteration");
	for (const form of [FOLLOWUP, DISCHARGE]) holdPlanned(doc, form);
	return expectAdmittedDoc({ ...doc });
}

async function caseOperationsRead(doc: BlueprintDoc, formUuid: string) {
	const h = makeToolWorkspaceHarness(doc);
	const read = await h.runTool(getCaseOperationsTool, {
		moduleUuid: PATIENTS,
		formUuid,
	});
	return projectAuthoringRead({
		toolName: "getCaseOperations",
		data: read.data,
		doc,
	}) as {
		operations: Record<string, unknown>[];
		ownClose?: Record<string, unknown>;
	};
}

async function visitsRead(doc: BlueprintDoc) {
	const h = makeToolWorkspaceHarness(doc);
	const read = await h.runTool(getFieldTool, {
		moduleUuid: PATIENTS,
		formUuid: FOLLOWUP,
		fieldUuid: U("visits"),
	});
	return (
		projectAuthoringRead({ toolName: "getField", data: read.data, doc }) as {
			field: Record<string, unknown>;
		}
	).field;
}

describe("held places in the shared reads", () => {
	it("marks each held case change and a held own close as kept", async () => {
		const followUp = await caseOperationsRead(published(), FOLLOWUP);
		expect(followUp.operations.length).toBeGreaterThan(0);
		for (const operation of followUp.operations) {
			expect(operation.placementKept).toBe(true);
			// The stored hold itself is no input an edit takes.
			expect(operation.placement).toMatch(/^(case management|save to case)$/);
		}
		const discharge = await caseOperationsRead(published(), DISCHARGE);
		expect(discharge.ownClose).toEqual({
			placement: "save to case",
			placementKept: true,
		});
	});

	it("reads an unpublished app's places without the mark", async () => {
		const followUp = await caseOperationsRead(moveFixture(), FOLLOWUP);
		for (const operation of followUp.operations)
			expect(operation).not.toHaveProperty("placementKept");
		const discharge = await caseOperationsRead(moveFixture(), DISCHARGE);
		expect(discharge.ownClose).toEqual({ placement: "save to case" });
	});

	it("marks a held query repeat's rows as kept, and leaves the hold out", async () => {
		const held = await visitsRead(published());
		expect(held).toMatchObject({ rows: "set-when-opened", rowsKept: true });
		expect(held).not.toHaveProperty("placement");
		const planned = await visitsRead(moveFixture());
		expect(planned).toMatchObject({ rows: "set-when-opened" });
		expect(planned).not.toHaveProperty("rowsKept");
	});
});
