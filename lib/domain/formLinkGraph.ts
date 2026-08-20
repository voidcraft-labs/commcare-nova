import type { BlueprintDoc } from "./blueprint";
import type { FormLinkTarget } from "./forms";
import type { Uuid } from "./uuid";

/**
 * The form-to-form graph that after-submit links draw.
 *
 * One adjacency, read by the validator's cycle rule and by every authoring
 * surface that has to answer "would pointing this link at X lead back here?"
 * before offering X. A module target is a leaf: landing on a module's form
 * list hands control back to the person, so it never continues a chain.
 */
export type FormLinkAdjacency = ReadonlyMap<Uuid, ReadonlySet<Uuid>>;

/**
 * Optionally retarget one link while reading the graph, so a picker can ask
 * about a destination before the document holds it.
 */
export interface FormLinkOverride {
	readonly formUuid: Uuid;
	/** The link being edited; absent when the link does not exist yet. */
	readonly linkUuid?: Uuid;
	readonly target: FormLinkTarget;
}

export function formLinkAdjacency(
	doc: BlueprintDoc,
	override?: FormLinkOverride,
): FormLinkAdjacency {
	const adjacency = new Map<Uuid, Set<Uuid>>();
	const add = (from: Uuid, target: FormLinkTarget): void => {
		if (target.type !== "form") return;
		const targets = adjacency.get(from) ?? new Set<Uuid>();
		targets.add(target.formUuid);
		adjacency.set(from, targets);
	};
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			for (const link of form?.formLinks ?? []) {
				if (
					override !== undefined &&
					override.formUuid === formUuid &&
					override.linkUuid === link.uuid
				) {
					continue;
				}
				add(formUuid, link.target);
			}
		}
	}
	if (override !== undefined) add(override.formUuid, override.target);
	return adjacency;
}

/**
 * The chain of forms `from` reaches `to` through, inclusive at both ends,
 * or `undefined` when it does not reach it. `from === to` answers the
 * self-loop question through the graph like any other cycle: a form that
 * links to itself returns `[from, from]`.
 */
export function formLinkPath(
	adjacency: FormLinkAdjacency,
	from: Uuid,
	to: Uuid,
): readonly Uuid[] | undefined {
	const visited = new Set<Uuid>();
	const stack: Array<{ readonly uuid: Uuid; readonly chain: Uuid[] }> = [
		{ uuid: from, chain: [from] },
	];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		for (const next of adjacency.get(current.uuid) ?? []) {
			const chain = [...current.chain, next];
			if (next === to) return chain;
			if (!visited.has(next)) {
				visited.add(next);
				stack.push({ uuid: next, chain });
			}
		}
	}
	return undefined;
}

/**
 * The entity a link lands on, named for a person: the target form, or the
 * target module when the link opens its form list. `undefined` when the
 * target no longer exists — the caller names the link by position then.
 */
export function formLinkDestination(
	doc: BlueprintDoc,
	target: FormLinkTarget,
): { readonly kind: "form" | "module"; readonly name: string } | undefined {
	if (target.type === "form") {
		const form = doc.forms[target.formUuid];
		return form === undefined ? undefined : { kind: "form", name: form.name };
	}
	const mod = doc.modules[target.moduleUuid];
	return mod === undefined ? undefined : { kind: "module", name: mod.name };
}

/** Whether `from` reaches `to` through after-submit links. */
export function formLinkReaches(
	doc: BlueprintDoc,
	from: Uuid,
	to: Uuid,
	override?: FormLinkOverride,
): boolean {
	return formLinkPath(formLinkAdjacency(doc, override), from, to) !== undefined;
}
