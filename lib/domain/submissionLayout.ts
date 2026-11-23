import type { Field } from "./fields";
import { ownRecordValue } from "./records";
import type { Uuid } from "./uuid";

/** Worker screens follow fieldOrder. Submitted values follow it too until
 * an author places a value independently. An explicit position counts the
 * siblings in the submitted group, including questions with no screen. */
export interface SubmissionLayout {
	readonly children: ReadonlyMap<Uuid, readonly Uuid[]>;
	readonly parents: ReadonlyMap<Uuid, Uuid>;
	readonly controlParents: ReadonlyMap<Uuid, Uuid>;
	readonly independent: boolean;
	readonly problems: ReadonlyMap<Uuid, string>;
}

export function submissionLayout(
	form: Uuid,
	fields: Readonly<Record<string, Field>>,
	controlOrder: Readonly<Record<string, readonly Uuid[]>>,
): SubmissionLayout {
	const controlParents = new Map<Uuid, Uuid>();
	const order = new Map<Uuid, readonly Uuid[]>();
	const visit = (parent: Uuid): void => {
		const children = ownRecordValue(controlOrder, parent) ?? [];
		order.set(parent, [...children]);
		for (const uuid of children) {
			const field = ownRecordValue(fields, uuid);
			if (field === undefined || controlParents.has(uuid)) continue;
			controlParents.set(uuid, parent);
			if (Object.hasOwn(controlOrder, uuid)) visit(uuid);
		}
	};
	visit(form);
	const placed = [...controlParents.keys()].flatMap((uuid) => {
		const placement = fields[uuid].submissionPlacement;
		return placement === undefined ? [] : [{ uuid, ...placement }];
	});
	const problems = new Map<Uuid, string>();
	if (placed.length === 0)
		return {
			children: order,
			parents: controlParents,
			controlParents,
			independent: false,
			problems,
		};

	const parents = new Map(controlParents);
	const children = new Map(order);
	const byParent = new Map<Uuid, typeof placed>();
	const affected = new Set<Uuid>();
	for (const entry of placed) {
		const { uuid, parent } = entry;
		const old = controlParents.get(uuid);
		if (old !== undefined) affected.add(old);
		affected.add(parent);
		parents.set(uuid, parent);
		const candidates = byParent.get(parent) ?? [];
		candidates.push(entry);
		byParent.set(parent, candidates);
		const target = fields[parent];
		if (
			parent !== form &&
			(!controlParents.has(parent) ||
				(target?.kind !== "group" &&
					target?.kind !== "section" &&
					target?.kind !== "repeat"))
		)
			problems.set(
				uuid,
				"Choose a group in this form to hold the submitted value.",
			);
	}
	for (const parent of affected) {
		const unplaced = (order.get(parent) ?? []).filter(
			(uuid) => fields[uuid]?.submissionPlacement === undefined,
		);
		const ranked = (byParent.get(parent) ?? []).sort(
			(a, b) => a.position - b.position,
		);
		const siblings: Uuid[] = [];
		let next = 0;
		for (const [i, entry] of ranked.entries()) {
			if (ranked[i - 1]?.position === entry.position)
				problems.set(
					entry.uuid,
					"Two submitted values share a position. Choose the value this one should follow.",
				);
			while (next < unplaced.length && siblings.length < entry.position)
				siblings.push(unplaced[next++]);
			siblings.push(entry.uuid);
		}
		children.set(parent, siblings.concat(unplaced.slice(next)));
	}

	// Find the enclosing repeat in each tree. Memoize entire chains so
	// validating a large group and all of its descendants is linear.
	const enclosing = (ancestry: ReadonlyMap<Uuid, Uuid>) => {
		const known = new Map<Uuid, Uuid | undefined>([[form, form]]);
		return (uuid: Uuid): Uuid | undefined => {
			const path = new Set<Uuid>();
			let at: Uuid | undefined = uuid;
			while (at !== undefined && !known.has(at) && !path.has(at)) {
				path.add(at);
				at = ancestry.get(at);
			}
			let owner = at === undefined ? undefined : known.get(at);
			for (const step of [...path].reverse()) {
				if (owner !== undefined && fields[step]?.kind === "repeat")
					owner = step;
				known.set(step, owner);
			}
			return known.get(uuid);
		};
	};
	const controlRepeat = enclosing(controlParents);
	const submittedRepeat = enclosing(parents);
	for (const [uuid, parent] of parents) {
		const original = controlParents.get(uuid);
		if (original === undefined || problems.has(uuid)) continue;
		const owner = submittedRepeat(parent);
		if (owner === undefined)
			problems.set(
				uuid,
				"Choose a submitted group that leads back to the form. A group cannot hold itself or one of its parents.",
			);
		else if (owner !== controlRepeat(original))
			problems.set(
				uuid,
				"Keep the submitted value and its question in the same repeat entry.",
			);
	}
	return { children, parents, controlParents, independent: true, problems };
}
