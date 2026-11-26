/**
 * The words a person reads about an identity move: what moves, from where
 * to where, why, and what it changes in CommCare HQ. Each reason is worded
 * by its owner's sentence, through a switch over its source that fails to
 * compile where a source has no copy. The builder's dialog, the SA and MCP
 * tool results and `saveWork` all read these sentences.
 */

import type {
	IdentityMove,
	IdentityMoveReport,
	IdentityMoveSubject,
} from "@/lib/doc/identityMoves";
import type { ModuleKindMoveReason } from "@/lib/doc/moduleKindMoves";
import {
	type BlueprintDoc,
	ownRecordValue,
	projectProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import { describeCaseOperation } from "@/lib/domain/caseOperationDescription";
import {
	advancedKindBlockerSentence,
	placementIneligibilitySentence,
	placementLabelWords,
} from "@/lib/domain/placementCopy";

/** What the move changes, said after every move. */
const EXPORT_COLUMNS_SENTENCE =
	"From your next publish, CommCare HQ's exports show these answers under new columns.";

/** What a menu's move also changes where the menu selects a parent case. */
const CHOSEN_CASES_RENAMED_SENTENCE =
	"Its forms also read the cases chosen through its parent case under new names.";

const quoted = (words: string): string => `“${words}”`;

/** Why a menu's kind moves, in one sentence: a blocker's is the one the
 *  gate's `HELD_PLACEMENT_INEXPRESSIBLE` finding for the menu reads too,
 *  and a move to an advanced menu says what now needs one, as module
 *  settings' **In CommCare HQ** row does (`moduleAdvancedKindLine`). */
function moduleKindMoveReasonSentence(reason: ModuleKindMoveReason): string {
	switch (reason) {
		case "list-entry-change":
			return "Its list now chooses records in a way only an advanced menu can: the worker’s own record, or a single match opened automatically.";
		case "form-entry-change":
			return "A form in it now opens with its own cases or values, which only an advanced menu can do.";
		case "advanced-change":
			return "A form in it now saves a case change only an advanced menu can.";
		default:
			return advancedKindBlockerSentence(reason);
	}
}

function formWords(doc: BlueprintDoc, formUuid: Uuid): string {
	return ownRecordValue(doc.forms, formUuid)?.name ?? "";
}

/** A field as a person reads it: its label, or its id where it has none. */
function fieldWords(doc: BlueprintDoc, fieldUuid: Uuid): string {
	const field = ownRecordValue(doc.fields, fieldUuid);
	if (field === undefined) return "";
	const label =
		"label" in field && field.label !== undefined
			? projectProseTemplate(field.label, doc).text.trim()
			: "";
	return label.length > 0 ? label : field.id;
}

/** The subject of a move, named as the builder names it. */
export function identitySubjectName(
	doc: BlueprintDoc,
	subject: IdentityMoveSubject,
): string {
	switch (subject.kind) {
		case "case-operation":
			return `${quoted(formWords(doc, subject.formUuid))}: ${describeCaseOperation(doc, subject.formUuid, subject.operationUuid)}`;
		case "form-selection": {
			const row = formCaseSelections(doc, subject.formUuid).find(
				(choice) => choice.uuid === subject.selectionUuid,
			);
			return row
				? `${quoted(formWords(doc, subject.formUuid))}, ${quoted(row.name)}`
				: `${quoted(formWords(doc, subject.formUuid))}, an opening record`;
		}
		case "own-close":
			return `${quoted(formWords(doc, subject.formUuid))}: closing its case`;
		case "submitted-question":
		case "query-repeat":
			return `${quoted(formWords(doc, subject.formUuid))}, ${quoted(fieldWords(doc, subject.fieldUuid))}`;
		case "module-kind":
			return quoted(
				ownRecordValue(doc.modules, subject.moduleUuid)?.name ?? "",
			);
		default: {
			const _exhaustive: never = subject;
			return _exhaustive;
		}
	}
}

/** Why the subject can no longer stay where it is, in one sentence. */
export function identityMoveReasonSentence(
	doc: BlueprintDoc,
	move: IdentityMove,
): string {
	const { reason } = move;
	switch (reason.source) {
		case "submitted-question":
			return "Future submissions will store this answer at its new address.";
		case "case-placement":
			return placementIneligibilitySentence(reason.reason.reason);
		case "form-selection":
			return reason.nextTag
				? `From your next publish, the form opens this record under the saved name ${quoted(reason.nextTag)}. Earlier versions used ${quoted(reason.previousTag)}.`
				: `From your next publish, the form will stop opening the record it kept under the saved name ${quoted(reason.previousTag)}.`;
		case "query-timing":
			return reason.timing === "on-open"
				? "You chose to keep the records found when the form opens."
				: "You chose to follow changes to the records found during entry.";
		case "query-repeat": {
			const need = reason.reason;
			switch (need.kind) {
				case "nested":
					return `It now sits inside ${quoted(fieldWords(doc, need.repeatUuid))}.`;
				case "query-reads-answers":
					return "Its query now reads an answer.";
				case "row-condition":
					return "It now shows on a condition.";
				case "ancestor-condition-changes":
					return `${quoted(fieldWords(doc, need.groupUuid))} around it now shows on a condition that can change while the form is filled in.`;
				default: {
					const _exhaustive: never = need;
					return _exhaustive;
				}
			}
		}
		case "module-kind":
			return moduleKindMoveReasonSentence(reason.reason);
		default: {
			const _exhaustive: never = reason;
			return _exhaustive;
		}
	}
}

/** Whether the move renames the session values a menu's forms read the
 *  cases chosen through its parent case by. */
export function identityMoveRenamesChosenCases(move: IdentityMove): boolean {
	return move.reason.source === "module-kind" && move.reason.chosenCasesRenamed;
}

/** The actual worker-visible change when a published narrowed menu item becomes advanced. */
export function caseListMoveSentence(move: IdentityMove): string {
	return move.reason.source === "module-kind" && move.reason.expandsCaseList
		? " Its case list menu item will show every open record of this type available to the worker. Forms will keep their own selection filters."
		: "";
}

/** The whole statement of one move, as a tool result says it. */
export function identityMoveSentence(
	doc: BlueprintDoc,
	move: IdentityMove,
): string {
	if (move.subject.kind === "form-selection")
		return `${identitySubjectName(doc, move.subject)}. ${identityMoveReasonSentence(doc, move)}`;
	const renamed = identityMoveRenamesChosenCases(move)
		? ` ${CHOSEN_CASES_RENAMED_SENTENCE}`
		: "";
	return `${identitySubjectName(doc, move.subject)} moves from ${placementLabelWords(move.from)} to ${placementLabelWords(move.to)}. ${identityMoveReasonSentence(doc, move)}${renamed}${caseListMoveSentence(move)} ${EXPORT_COLUMNS_SENTENCE}`;
}

/** One move as a tool result carries it. */
export function identityMoveReport(
	doc: BlueprintDoc,
	move: IdentityMove,
): IdentityMoveReport {
	return { subject: move.subject, sentence: identityMoveSentence(doc, move) };
}
