// components/builder/navigation/endOfFormNavigationModel.ts
//
// Everything the end-of-form navigation screen decides before it renders
// anything: the rows, the "Otherwise" destination, and which gestures the
// commit gate would refuse.
//
// It is pure and separately tested because the interesting rule is not
// visual. Links are EXCLUSIVE — link i fires on its own condition and on
// none of its predecessors' — so a link sitting below an unconditional
// one can never fire, and the gate refuses that document
// (`FORM_LINK_UNREACHABLE`). Stated as a property of the whole sequence
// it is one sentence: **at most one unconditional link, and it must be
// last.** Every affordance here derives from that sentence rather than
// from a second copy of the reasoning.
//
// ## Why the last link is not a row
//
// A terminal unconditional link IS the exhaustive `else` on the wire: its
// guard is the negation of every earlier condition, and its presence
// suppresses the post-submit fallback entirely. Showing it as a row
// beside an "Otherwise" line would tell the author there are two
// fallbacks where the wire has one, so it is lifted into `otherwise` and
// the two spellings of "where this lands when nothing matched" become one
// control.
//
// ## Why the broken arrangement still renders as rows
//
// A document that already carries an unconditional link mid-list cannot
// be committed, but it can be OPENED — imported content, or a peer's
// edit landing under the screen. Lifting nothing in that case and marking
// every stranded row is what lets an author see the problem and fix it,
// rather than meeting a lifted "Otherwise" that silently disagrees with
// what the app actually does.

import {
	type BlueprintDoc,
	type FormLink,
	isUnconditionalFormLink,
	orderedFormLinks,
	type PostSubmitDestination,
	type Uuid,
} from "@/lib/domain";

/** Where "Otherwise" sends a worker. */
export type OtherwiseDestination =
	| { readonly kind: "link"; readonly link: FormLink; readonly label: string }
	| {
			readonly kind: "post-submit";
			readonly destination: PostSubmitDestination;
	  };

export interface LinkRow {
	readonly uuid: Uuid;
	/** 1-based position among the rows the author sees. */
	readonly position: number;
	readonly link: FormLink;
	/** The destination's own name, or a plain statement that it is gone. */
	readonly destinationLabel: string;
	readonly destinationMissing: boolean;
	/** Set when nothing could ever reach this row, phrased for the author. */
	readonly unreachableBecause?: string;
	/**
	 * The reorder affordances. Absent means the row is already at that end
	 * and the control is not offered; present with a `refusal` means the
	 * control is offered and disabled, saying why — a keyboard reorder
	 * that silently bounces off the commit gate is a failure of the
	 * surface, not a safety net working.
	 */
	readonly moveUp?: MoveAffordance;
	readonly moveDown?: MoveAffordance;
}

export interface MoveAffordance {
	/** The uuid to land before; `undefined` moves to the end. */
	readonly beforeUuid?: Uuid;
	readonly refusal?: string;
}

export interface EndOfFormNavigationModel {
	readonly rows: readonly LinkRow[];
	readonly otherwise: OtherwiseDestination;
}

/**
 * What removing a destination changes beyond removing it. Stated once on
 * the screen rather than per row, because it is the same sentence every
 * time.
 */
export const END_OF_FORM_REMOVAL_CONSEQUENCE =
	"Removing a destination also stops the ones below it from excluding its condition, so they may start applying to more submissions.";

/** The destination a link names, in the author's own words. */
export function destinationLabel(
	doc: BlueprintDoc,
	link: FormLink,
): { readonly label: string; readonly missing: boolean } {
	const target = link.target;
	const mod = doc.modules[target.moduleUuid];
	if (target.type === "module") {
		return mod === undefined
			? { label: "a menu that is no longer in the app", missing: true }
			: { label: mod.name, missing: false };
	}
	const form = doc.forms[target.formUuid];
	return form === undefined
		? { label: "a form that is no longer in the app", missing: true }
		: { label: form.name, missing: false };
}

/**
 * The first link this sequence strands, if any — the one legality
 * question every reorder affordance asks, phrased over an arbitrary
 * candidate order so a gesture can be tested before it happens.
 */
function firstStranding(
	ordered: readonly FormLink[],
): { readonly covering: FormLink; readonly stranded: FormLink } | undefined {
	for (let index = 0; index < ordered.length - 1; index++) {
		if (!isUnconditionalFormLink(ordered[index])) continue;
		return { covering: ordered[index], stranded: ordered[index + 1] };
	}
	return undefined;
}

/** The sequence after moving `uuid` to sit before `beforeUuid` (or last). */
function reordered(
	ordered: readonly FormLink[],
	uuid: Uuid,
	beforeUuid: Uuid | undefined,
): FormLink[] {
	const moving = ordered.find((link) => link.uuid === uuid);
	if (moving === undefined) return [...ordered];
	const rest = ordered.filter((link) => link.uuid !== uuid);
	const at =
		beforeUuid === undefined
			? rest.length
			: rest.findIndex((link) => link.uuid === beforeUuid);
	if (at < 0) return [...ordered];
	return [...rest.slice(0, at), moving, ...rest.slice(at)];
}

function moveRefusal(
	doc: BlueprintDoc,
	ordered: readonly FormLink[],
	uuid: Uuid,
	beforeUuid: Uuid | undefined,
): string | undefined {
	const stranding = firstStranding(reordered(ordered, uuid, beforeUuid));
	if (stranding === undefined) return undefined;
	const covering = destinationLabel(doc, stranding.covering).label;
	const blocked = destinationLabel(doc, stranding.stranded).label;
	return `This would put "${blocked}" below "${covering}", which has no condition and so always applies — nobody would ever reach it. Give "${covering}" a condition first.`;
}

function unreachableBecause(
	doc: BlueprintDoc,
	rows: readonly FormLink[],
	index: number,
): string | undefined {
	for (let above = 0; above < index; above++) {
		if (!isUnconditionalFormLink(rows[above])) continue;
		const covering = destinationLabel(doc, rows[above]).label;
		return `"${covering}" above has no condition and so always applies, so nobody reaches this. Give "${covering}" a condition, or move this above it.`;
	}
	return undefined;
}

/** Derive the whole screen from the form. */
export function endOfFormNavigationModel(
	doc: BlueprintDoc,
	form: {
		readonly formLinks?: readonly FormLink[];
		readonly postSubmit?: PostSubmitDestination;
	},
	defaultDestination: PostSubmitDestination,
): EndOfFormNavigationModel {
	const ordered = orderedFormLinks(form);
	const last = ordered.at(-1);
	/* Lift only the WELL-FORMED terminal case. An unconditional link
	 * anywhere else means the document is already refused, and hiding one
	 * of its links inside an "Otherwise" control would hide the problem. */
	const terminal =
		last !== undefined &&
		isUnconditionalFormLink(last) &&
		firstStranding(ordered) === undefined
			? last
			: undefined;
	const listed =
		terminal === undefined ? ordered : ordered.slice(0, ordered.length - 1);

	const rows = listed.map((link, index) => {
		const { label, missing } = destinationLabel(doc, link);
		const upBefore = listed[index - 1]?.uuid;
		/* Moving down lands before whatever currently follows the NEXT row —
		 * or, at the bottom of the listed block, before the terminal link so
		 * the exhaustive `else` stays last. Undefined means the end. */
		const downBefore = listed[index + 2]?.uuid ?? terminal?.uuid;
		const affordance = (beforeUuid: Uuid | undefined): MoveAffordance => {
			const refusal = moveRefusal(doc, ordered, link.uuid, beforeUuid);
			return {
				...(beforeUuid !== undefined && { beforeUuid }),
				...(refusal !== undefined && { refusal }),
			};
		};
		const unreachable = unreachableBecause(doc, listed, index);
		return {
			uuid: link.uuid,
			position: index + 1,
			link,
			destinationLabel: label,
			destinationMissing: missing,
			...(unreachable !== undefined && { unreachableBecause: unreachable }),
			...(upBefore !== undefined && { moveUp: affordance(upBefore) }),
			...(index < listed.length - 1 && { moveDown: affordance(downBefore) }),
		} satisfies LinkRow;
	});

	return {
		rows,
		otherwise:
			terminal === undefined
				? {
						kind: "post-submit",
						destination: form.postSubmit ?? defaultDestination,
					}
				: {
						kind: "link",
						link: terminal,
						label: destinationLabel(doc, terminal).label,
					},
	};
}
