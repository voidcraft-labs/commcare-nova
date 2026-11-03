// components/builder/case-operations/ownWriteMenuModel.ts
//
// The overflow menu of one write of the form's own case, as pure state.
//
// Only the own arm's writes may walk `via` to a case above the form's case or
// keep only a changed answer (`CASE_WRITE_VIA_INVALID`),
// and only on a form that loads its case: a follow-up or a
// close form. So this model answers for exactly that row and nothing else.
// It offers the same two gestures a question's Saves to row does, with the
// same reasons: the ancestor chains of
// `editor/fields/caseWriteRowModel.ts::ancestorCaseWriteChoices`, and Save
// only if changed with that row's disabled reasons. Each gesture is one
// complete own operation the caller commits through `planCaseOperationUpdate`
// (`useCaseOperations().update`), and each is offered by the gate's verdict
// over that exact operation.

import {
	type AncestorCaseWriteChoice,
	KEPT_IN_SAVE_TO_CASE_REASON,
	SAVE_ONLY_IF_CHANGED_LABEL,
	SAVE_ONLY_IF_CHANGED_LINE,
} from "@/components/builder/editor/fields/caseWriteRowModel";
import type { CasePlacementHome } from "@/lib/doc/casePlacements";
import {
	type CaseOperationWrite,
	type CaseWriteVia,
	type Form,
	humanizeId,
	type OwnCaseOperation,
} from "@/lib/domain";

export type OwnWriteVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/** One place the write can save to: this form's case or a case above it. */
export interface OwnWriteDestinationItem {
	readonly label: string;
	/** The write saves here now. */
	readonly current: boolean;
	/** Why it can't move here; absent where it can, or where it already is. */
	readonly disabledReason?: string;
	/** The whole own operation the move commits. */
	readonly next: OwnCaseOperation;
}

export interface OwnWriteMenu {
	readonly above: {
		readonly label: string;
		/** This form's case first, then each chain above it, nearest first. */
		readonly items: readonly OwnWriteDestinationItem[];
		/** Why no case above it can be offered at all. */
		readonly unavailableReason?: string;
	};
	readonly onlyIfChanged: {
		readonly label: string;
		readonly line: string;
		readonly on: boolean;
		readonly disabledReason?: string;
		readonly next: OwnCaseOperation;
	};
}

export const SAVE_TO_CASE_ABOVE_LABEL = "Save to a case above it";
export const THIS_FORMS_CASE_LABEL = "This form's case";
export const NO_CASE_ABOVE_REASON =
	"No case type in this app is above this form's case type, so there is no case above it to save to.";

/** The forms whose own case is loaded, so a case above it is known. */
const LOADS_ITS_CASE: ReadonlySet<Form["type"]> = new Set([
	"followup",
	"close",
]);

interface OwnWriteMenuInput {
	readonly formType: Form["type"];
	readonly own: OwnCaseOperation;
	readonly writeIndex: number;
	readonly ancestors: readonly AncestorCaseWriteChoice[];
	/** Where CommCare HQ keeps the own change (`formCasePlacementView`). */
	readonly ownHome: CasePlacementHome | undefined;
	/** The gate's verdict over one complete own operation. */
	readonly verdict: (operation: OwnCaseOperation) => OwnWriteVerdict;
}

function sameVia(
	a: CaseWriteVia | undefined,
	b: CaseWriteVia | undefined,
): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function withWrite(
	own: OwnCaseOperation,
	writeIndex: number,
	write: CaseOperationWrite,
): OwnCaseOperation {
	return {
		...own,
		writes: (own.writes ?? []).map((candidate, index) =>
			index === writeIndex ? write : candidate,
		),
	};
}

/** The write with `via` set, or without it for this form's case. */
function writeVia(
	write: CaseOperationWrite,
	via: CaseWriteVia | undefined,
): CaseOperationWrite {
	const { via: _drop, ...rest } = write;
	return via === undefined ? rest : { ...rest, via };
}

/** The write with Save only if changed turned the other way. */
function writeToggled(write: CaseOperationWrite): CaseOperationWrite {
	const { onlyIfChanged, ...rest } = write;
	return onlyIfChanged ? rest : { ...rest, onlyIfChanged: true };
}

/**
 * The overflow menu of the own arm's write at `writeIndex`, or `undefined`
 * where the row offers neither gesture: a registration's or a survey's form,
 * or an index the operation does not hold.
 */
export function ownWriteMenu(
	input: OwnWriteMenuInput,
): OwnWriteMenu | undefined {
	const { formType, own, writeIndex, ancestors, ownHome, verdict } = input;
	const write = own.writes?.[writeIndex];
	if (write === undefined || !LOADS_ITS_CASE.has(formType)) return undefined;

	const destination = (
		label: string,
		via: CaseWriteVia | undefined,
	): OwnWriteDestinationItem => {
		const next = withWrite(own, writeIndex, writeVia(write, via));
		const current = sameVia(write.via, via);
		if (current) return { label, current, next };
		const answer = verdict(next);
		return answer.ok
			? { label, current, next }
			: { label, current, disabledReason: answer.reason, next };
	};
	const items =
		ancestors.length === 0
			? []
			: [
					destination(THIS_FORMS_CASE_LABEL, undefined),
					...ancestors.map((choice) => destination(choice.label, choice.via)),
				];

	const toggled = withWrite(own, writeIndex, writeToggled(write));
	const on = write.onlyIfChanged === true;
	let disabledReason: string | undefined;
	if (!on) {
		if (ownHome === "save-to-case")
			disabledReason = KEPT_IN_SAVE_TO_CASE_REASON;
		else {
			const answer = verdict(toggled);
			if (!answer.ok) disabledReason = answer.reason;
		}
	}

	return {
		above: {
			label: SAVE_TO_CASE_ABOVE_LABEL,
			items,
			...(items.length === 0 && { unavailableReason: NO_CASE_ABOVE_REASON }),
		},
		onlyIfChanged: {
			label: SAVE_ONLY_IF_CHANGED_LABEL,
			line: SAVE_ONLY_IF_CHANGED_LINE,
			on,
			...(disabledReason !== undefined && { disabledReason }),
			next: toggled,
		},
	};
}

/** Where a write through `via` saves, as the write's row says it:
 *  `Saves onto the household it belongs to`, or `above it` for more steps. */
export function viaDestinationLine(
	caseType: string,
	via: CaseWriteVia,
): string {
	const label = humanizeId(caseType) || caseType;
	const words = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
	return via.length === 1
		? `Saves onto the ${words} it belongs to.`
		: `Saves onto the ${words} above it.`;
}

/** The properties of the operation's own destination case that it already
 *  writes, which the add-a-write picker leaves out. A write that saves to a
 *  case above it (`via`, the own arm's alone) is a different write key, so
 *  the same-named property of the destination stays offered beside it. */
export function destinationWrittenProperties(operation: {
	readonly writes?: readonly CaseOperationWrite[];
}): ReadonlySet<string> {
	return new Set(
		(operation.writes ?? [])
			.filter((write) => write.via === undefined)
			.map((write) => write.property),
	);
}
