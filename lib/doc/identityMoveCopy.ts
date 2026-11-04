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
import {
	type BlueprintDoc,
	ownRecordValue,
	projectProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { describeCaseOperation } from "@/lib/domain/caseOperationDescription";
import {
	placementIneligibilitySentence,
	placementLabelWords,
} from "@/lib/domain/placementCopy";

/** What the move changes, said after every move. */
const EXPORT_COLUMNS_SENTENCE =
	"From your next publish, CommCare HQ's exports show these answers under new columns.";

const quoted = (words: string): string => `“${words}”`;

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
		case "own-close":
			return `${quoted(formWords(doc, subject.formUuid))}: closing its case`;
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
		case "case-placement":
			return placementIneligibilitySentence(reason.reason.reason);
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
		default: {
			const _exhaustive: never = reason;
			return _exhaustive;
		}
	}
}

/** The whole statement of one move, as a tool result says it. */
export function identityMoveSentence(
	doc: BlueprintDoc,
	move: IdentityMove,
): string {
	return `${identitySubjectName(doc, move.subject)} moves from ${placementLabelWords(move.from)} to ${placementLabelWords(move.to)}. ${identityMoveReasonSentence(doc, move)} ${EXPORT_COLUMNS_SENTENCE}`;
}

/** One move as a tool result carries it. */
export function identityMoveReport(
	doc: BlueprintDoc,
	move: IdentityMove,
): IdentityMoveReport {
	return { subject: move.subject, sentence: identityMoveSentence(doc, move) };
}
