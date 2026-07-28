// components/builder/case-operations/operationSentence.ts
//
// How one case operation reads to a person.
//
// This is a DISPLAY PROJECTION and nothing else. It forks no semantics:
// the action, the target, the multiplicity, and the facets it names are
// read straight off the stored operation, and the legality of every one
// of them is decided by the validator and the planners. If this file
// ever seems to know something the operation does not say, that is the
// bug — the same discipline the display-condition summary printer keeps.
//
// The vocabulary is deliberately intent-level. CommCare calls this
// "Save to Case" and the wire calls it a case block; an author is told
// what the submission DOES ("Create a referral case", "Close the case
// this form opened"). Nova's own docs research is explicit that HQ's
// failure here is presenting a system-level construct at question-level
// scope, with no screen showing what a submission does to the case
// universe. The list of these sentences IS that screen, so a row that
// reads as an AST node name defeats the whole surface.

import { type CaseOperation, humanizeId, type Uuid } from "@/lib/domain";

/** What the row needs from outside the operation to read naturally. */
export interface OperationSentenceContext {
	/** Human name of an earlier operation, by uuid — for an `op` target. */
	readonly operationName: (uuid: Uuid) => string | undefined;
	/** Human label of a repeat field, by uuid — for `forEach`. */
	readonly repeatLabel: (uuid: Uuid) => string | undefined;
	/** Human label of a form field, by uuid — for a keyed create. */
	readonly fieldLabel: (uuid: Uuid) => string | undefined;
}

export interface OperationSentence {
	/** The lead clause: what happens to which case. */
	readonly lead: string;
	/**
	 * Qualifying clauses in reading order — multiplicity, then what else
	 * the operation sets. Rendered as quiet trailing detail.
	 */
	readonly details: readonly string[];
}

function quoted(name: string): string {
	return `“${name}”`;
}

/** `humanizeId` returns a standalone label with an initial capital. Inside a
 * sentence, case types are common-noun phrases, so lower only that initial
 * letter while retaining the humanized separators.
 *
 * Exported because every author-facing sentence about a case type on these
 * surfaces has to agree: the row, the heading, the section descriptions, and
 * the pickers all spell one stored `archived_referral` the same way, and a
 * second local copy is how the wire spelling leaks back into prose. */
export function caseTypePhrase(name: string): string {
	const label = humanizeId(name);
	return `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** A saved property's name as a STANDALONE label — a card heading, a picker
 * item, the subject of its own line.
 *
 * The same reason `caseTypePhrase` exists, one dimension over: the picker
 * offers "Visit outcome", so the card it lands and the blocker line that names
 * it later must not read `visit_outcome`. Every author-facing spelling of a
 * property on these surfaces comes from here or from `casePropertyPhrase`, so
 * the wire spelling has one place it can leak from rather than four. */
export function casePropertyLabel(name: string): string {
	return humanizeId(name);
}

/** The same name folded INTO a sentence ("the value it saves to visit
 * outcome"), where an initial capital would read as a proper noun. Exactly the
 * `humanizeId` → `caseTypePhrase` relationship, for properties. */
export function casePropertyPhrase(name: string): string {
	const label = casePropertyLabel(name);
	return `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** The case this operation acts on, in the author's terms. */
function targetPhrase(
	operation: CaseOperation,
	context: OperationSentenceContext,
): string {
	/* Case types are stored as identifiers, but this is an author-facing
	 * sentence. The picker and the rest of the builder use the same projection,
	 * so `archived_referral` reads as "archived referral" without weakening the
	 * stable stored identity. */
	const type = caseTypePhrase(operation.caseType);
	switch (operation.target.kind) {
		case "new": {
			const keyField =
				operation.target.idFrom === undefined
					? undefined
					: context.fieldLabel(operation.target.idFrom);
			return keyField === undefined
				? `a new ${type} case`
				: `a new ${type} case, keyed by ${quoted(keyField)}`;
		}
		case "session":
			return "the case this form opened";
		case "op": {
			const producer = context.operationName(operation.target.opUuid);
			return producer === undefined
				? `the ${type} case made earlier in this form`
				: `the ${type} case from ${quoted(producer)}`;
		}
		case "expression":
			return `a ${type} case found by a calculation`;
	}
}

/**
 * `create` reads as an outcome, the others as an action on an existing
 * case. Splitting on the action rather than templating one sentence is
 * what keeps "Create a new visit case" from becoming the stilted
 * "Create the case: a new visit case".
 */
function leadClause(
	operation: CaseOperation,
	context: OperationSentenceContext,
): string {
	const target = targetPhrase(operation, context);
	switch (operation.action) {
		case "create":
			return `Create ${target}`;
		case "update":
			return `Update ${target}`;
		case "close":
			return `Close ${target}`;
	}
}

export function operationSentence(
	operation: CaseOperation,
	context: OperationSentenceContext,
): OperationSentence {
	const details: string[] = [];

	if (operation.forEach !== undefined) {
		const label = context.repeatLabel(operation.forEach.repeat);
		details.push(
			label === undefined
				? "once for each entry in a repeating section"
				: `once for each ${quoted(label)} entry`,
		);
	}

	// Facets, in the order the wire applies them, so an author reading the
	// row top to bottom reads the same order the runtime will.
	if (operation.rename !== undefined) details.push("gives it a new name");
	if (operation.retype !== undefined) {
		details.push(`changes its type to ${caseTypePhrase(operation.retype)}`);
	}
	if (operation.owner !== undefined) details.push("sets who owns it");

	const writeCount = operation.writes?.length ?? 0;
	if (writeCount > 0) {
		details.push(
			writeCount === 1 ? "saves 1 property" : `saves ${writeCount} properties`,
		);
	}

	const links = operation.links ?? [];
	const unlinks = links.filter((link) => link.target === null).length;
	const relinks = links.length - unlinks;
	if (relinks > 0) {
		details.push(
			relinks === 1 ? "links it to another case" : `adds ${relinks} links`,
		);
	}
	if (unlinks > 0) {
		details.push(unlinks === 1 ? "removes a link" : `removes ${unlinks} links`);
	}

	return { lead: leadClause(operation, context), details };
}

/**
 * The whole row as one string, for an accessible name and for any
 * surface that needs the sentence without the row's layout.
 */
export function operationSentenceText(sentence: OperationSentence): string {
	return sentence.details.length === 0
		? sentence.lead
		: `${sentence.lead} — ${sentence.details.join(", ")}`;
}
