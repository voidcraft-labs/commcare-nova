/**
 * What a person and a model read about an identity move. The plausible
 * failures: a subject named by a uuid or not the way the builder names it,
 * a reason worded by the wrong owner, a query repeat's nested or group
 * reason naming the wrong question, and a sentence that drops what the move
 * changes in CommCare HQ's exports.
 */
import { describe, expect, it } from "vitest";
import {
	identityMoveReport,
	identityMoveSentence,
	identitySubjectName,
} from "@/lib/doc/identityMoveCopy";
import type { IdentityMove } from "@/lib/doc/identityMoves";
import { describeCaseOperation } from "@/lib/domain/caseOperationDescription";
import {
	DISCHARGE,
	FOLLOWUP,
	isOwn,
	moveFixture,
	operationOf,
	PATIENTS,
	U,
} from "./placementMoveFixture";

const EXPORTS =
	"From your next publish, CommCare HQ's exports show these answers under new columns.";

describe("identityMoveSentence", () => {
	const doc = moveFixture();
	const own = operationOf(doc, FOLLOWUP, isOwn).uuid;

	it("names a case change as the builder does and words its reason by the placement's sentence", () => {
		const move: IdentityMove = {
			subject: {
				kind: "case-operation",
				formUuid: FOLLOWUP,
				operationUuid: own,
			},
			from: "case-management",
			to: "save-to-case",
			reason: {
				source: "case-placement",
				reason: { reason: "value-computed" },
			},
		};
		expect(identityMoveSentence(doc, move)).toBe(
			`“Follow-up visit”: ${describeCaseOperation(doc, FOLLOWUP, own)} moves from Case Management to Save to Case. One of its values is now a calculation, which Case Management can't save. ${EXPORTS}`,
		);
		expect(identityMoveReport(doc, move)).toEqual({
			subject: move.subject,
			sentence: identityMoveSentence(doc, move),
		});
	});

	it("names an own close by its form", () => {
		expect(
			identityMoveSentence(doc, {
				subject: { kind: "own-close", formUuid: DISCHARGE },
				from: "save-to-case",
				to: "case-management",
				reason: { source: "case-placement", reason: { reason: "block-shape" } },
			}),
		).toBe(
			`“Discharge”: closing its case moves from Save to Case to Case Management. Its condition, or the answer its case id comes from, changed, which changes where Save to Case keeps it. ${EXPORTS}`,
		);
	});

	it("names a query repeat by its label and each of its reasons by the question it names", () => {
		const subject = {
			kind: "query-repeat",
			formUuid: FOLLOWUP,
			fieldUuid: U("visits"),
		} as const;
		const sentences = [
			{ kind: "nested", repeatUuid: U("rounds") },
			{ kind: "query-reads-answers" },
			{ kind: "row-condition" },
			{ kind: "ancestor-condition-changes", groupUuid: U("extra") },
		].map((need) =>
			identityMoveSentence(doc, {
				subject,
				from: "rows-set-when-opened",
				to: "rows-follow-query",
				reason: {
					source: "query-repeat",
					reason: need,
				} as IdentityMove["reason"],
			}),
		);
		const lead =
			"“Follow-up visit”, “Visits” moves from rows set when the form opens to rows that follow the cases found.";
		expect(sentences).toEqual([
			`${lead} It now sits inside “rounds”. ${EXPORTS}`,
			`${lead} Its query now reads an answer. ${EXPORTS}`,
			`${lead} It now shows on a condition. ${EXPORTS}`,
			`${lead} “extra” around it now shows on a condition that can change while the form is filled in. ${EXPORTS}`,
		]);
		for (const sentence of sentences) expect(sentence).not.toMatch(/—/);
	});

	it("names a menu by its name", () => {
		expect(
			identitySubjectName(doc, { kind: "module-kind", moduleUuid: PATIENTS }),
		).toBe("“Patients”");
	});
});
