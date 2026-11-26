import type { Field, FieldKind } from "./fields";
import { ownRecordValue } from "./records";
import type { Uuid } from "./uuid";

/**
 * Where each answer stands in the submitted form.
 *
 * Worker screens follow `fieldOrder`. A question's answer stands under its
 * screen parent unless the question names another group to hold it
 * (`submissionPlacement.parent`). Nova keeps no position of its own for a
 * submitted value: the order is the one CommCare HQ's form designer writes
 * and keeps on every save (Vellum `form.js::dataTree`, reading the question
 * tree its parser makes, `parser.js::parseControlTree`), so no save there
 * reorders what Nova sends.
 *
 * - A group's own answers come first, in screen order, then each answer
 *   placed into it from elsewhere, in the order the questions stand on
 *   screen across the whole form (`dataTree` collects every placed question
 *   on its walk and appends them after the walk).
 * - Where a group shows a question whose answer is placed elsewhere before
 *   another question whose answer stays, the form designer's parser moves
 *   the group's values that have no question (Hidden Values, Connect blocks)
 *   after its questions (`parseControlTree::merge`, the `fixOrder` union), so
 *   they are submitted after the group's own questions there.
 *
 * `screenOrder` is the screen order the form designer's question tree then
 * holds, the one a form read from CommCare HQ arrives in.
 */
export interface SubmissionLayout {
	readonly children: ReadonlyMap<Uuid, readonly Uuid[]>;
	readonly parents: ReadonlyMap<Uuid, Uuid>;
	readonly controlParents: ReadonlyMap<Uuid, Uuid>;
	readonly independent: boolean;
	readonly problems: ReadonlyMap<Uuid, string>;
}

/** Kinds with no question on screen: their value stands where they stand on screen. */
export function submitsWithoutQuestion(kind: FieldKind): boolean {
	return (
		kind === "hidden" || kind === "connect_activity" || kind === "case_change"
	);
}

const CONTAINER_KINDS: ReadonlySet<FieldKind> = new Set([
	"group",
	"section",
	"repeat",
]);

export const PLACEMENT_PROBLEMS = {
	notAGroup: "Choose a group in this form to hold the submitted value.",
	formRoot:
		"A question inside a group can't save its answer at the top level of the form: CommCare HQ's form designer reports that answer as invalid every time it opens the form. You can choose a group to hold the answer, or move the question out of its group on screen.",
	withoutQuestion:
		"A value with no question on screen is saved where it stands in the form. You can move it there instead.",
	group:
		"A group's answers stay under the group's own place: CommCare HQ's form designer can't save a group whose answers stand under another group. You can place each question's answer instead.",
	repeat: "Keep the submitted value and its question in the same repeat entry.",
} as const;

export function submissionLayout(
	form: Uuid,
	fields: Readonly<Record<string, Field>>,
	controlOrder: Readonly<Record<string, readonly Uuid[]>>,
): SubmissionLayout {
	const controlParents = new Map<Uuid, Uuid>();
	const walk: Uuid[] = [];
	const visit = (parent: Uuid): void => {
		for (const uuid of ownRecordValue(controlOrder, parent) ?? []) {
			const field = ownRecordValue(fields, uuid);
			if (field === undefined || controlParents.has(uuid)) continue;
			controlParents.set(uuid, parent);
			walk.push(uuid);
			if (Object.hasOwn(controlOrder, uuid)) visit(uuid);
		}
	};
	visit(form);
	const order = (parent: Uuid): Uuid[] =>
		(ownRecordValue(controlOrder, parent) ?? []).filter((uuid) =>
			controlParents.has(uuid),
		);

	const problems = new Map<Uuid, string>();
	const placedIn = new Map<Uuid, Uuid>();
	for (const uuid of walk) {
		const field = fields[uuid];
		const placement = field.submissionPlacement;
		if (placement === undefined) continue;
		const parent = placement.parent;
		if (parent === controlParents.get(uuid)) continue;
		if (submitsWithoutQuestion(field.kind))
			problems.set(uuid, PLACEMENT_PROBLEMS.withoutQuestion);
		else if (CONTAINER_KINDS.has(field.kind))
			problems.set(uuid, PLACEMENT_PROBLEMS.group);
		else if (parent === form) problems.set(uuid, PLACEMENT_PROBLEMS.formRoot);
		else if (
			!controlParents.has(parent) ||
			!CONTAINER_KINDS.has(fields[parent]?.kind)
		)
			problems.set(uuid, PLACEMENT_PROBLEMS.notAGroup);
		else placedIn.set(uuid, parent);
	}

	// The form designer keeps a value inside its question's repeat entry
	// (`baseSpecs.js::dataParent.validationFunc`). A group's answers stand
	// under it, so a group's place on screen is its place in the submission.
	const repeatOf = (start: Uuid): Uuid => {
		for (let at: Uuid | undefined = start; at !== undefined; ) {
			if (at === form) return form;
			if (fields[at]?.kind === "repeat") return at;
			at = controlParents.get(at);
		}
		return form;
	};
	for (const [uuid, parent] of [...placedIn])
		if (repeatOf(controlParents.get(uuid) ?? form) !== repeatOf(parent)) {
			problems.set(uuid, PLACEMENT_PROBLEMS.repeat);
			placedIn.delete(uuid);
		}
	const containers = [form, ...walk].filter(
		(uuid) => uuid === form || Object.hasOwn(controlOrder, uuid),
	);
	if (placedIn.size === 0)
		return {
			children: new Map(containers.map((parent) => [parent, order(parent)])),
			parents: controlParents,
			controlParents,
			independent: false,
			problems,
		};

	const parents = new Map(controlParents);
	for (const [uuid, parent] of placedIn) parents.set(uuid, parent);
	const children = new Map<Uuid, readonly Uuid[]>();
	for (const parent of containers) {
		const own = order(parent);
		const stays = (uuid: Uuid) => !placedIn.has(uuid);
		const question = (uuid: Uuid) => !submitsWithoutQuestion(fields[uuid].kind);
		const firstAway = own.findIndex((uuid) => !stays(uuid));
		const reordered =
			firstAway !== -1 &&
			own.slice(firstAway + 1).some((uuid) => stays(uuid) && question(uuid));
		const base = reordered
			? [
					...own.filter((uuid) => stays(uuid) && question(uuid)),
					...own.filter((uuid) => !question(uuid)),
				]
			: own.filter(stays);
		const arrived = walk.filter((uuid) => placedIn.get(uuid) === parent);
		children.set(parent, [...base, ...arrived]);
	}
	return { children, parents, controlParents, independent: true, problems };
}

/**
 * The screen order the form designer's question tree holds for a form
 * whose answers are laid out as `submissionLayout` lays them out: a
 * group's questions in screen order, then, where its submitted values
 * follow its questions (`submissionLayout`'s second rule), its values with
 * no question; elsewhere its questions and values in screen order with the
 * questions whose answers stand elsewhere last (the parser appends each to
 * its group as it reads the body, after the group's own data nodes). A form
 * read from CommCare HQ arrives in this order, and an export prints the same
 * bytes for either order.
 */
export function designerScreenOrder(
	form: Uuid,
	fields: Readonly<Record<string, Field>>,
	controlOrder: Readonly<Record<string, readonly Uuid[]>>,
): ReadonlyMap<Uuid, readonly Uuid[]> {
	const layout = submissionLayout(form, fields, controlOrder);
	const orders = new Map<Uuid, readonly Uuid[]>();
	for (const parent of [form, ...layout.controlParents.keys()]) {
		if (parent !== form && !Object.hasOwn(controlOrder, parent)) continue;
		const own = (ownRecordValue(controlOrder, parent) ?? []).filter((uuid) =>
			layout.controlParents.has(uuid),
		);
		if (!layout.independent) {
			orders.set(parent, own);
			continue;
		}
		const away = (uuid: Uuid) =>
			layout.parents.get(uuid) !== layout.controlParents.get(uuid);
		const question = (uuid: Uuid) => !submitsWithoutQuestion(fields[uuid].kind);
		const firstAway = own.findIndex(away);
		const reordered =
			firstAway !== -1 &&
			own.slice(firstAway + 1).some((uuid) => !away(uuid) && question(uuid));
		orders.set(
			parent,
			reordered
				? [...own.filter(question), ...own.filter((uuid) => !question(uuid))]
				: [
						...own.filter((uuid) => !away(uuid)),
						...own.filter((uuid) => away(uuid)),
					],
		);
	}
	return orders;
}
