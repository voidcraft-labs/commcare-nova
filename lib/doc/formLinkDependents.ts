/**
 * What removing a form or a module means for the after-submit links that
 * point INTO it — the decision every remove surface consults before it
 * builds its batch (`useBlueprintMutations.removeForm` / `removeModule`,
 * the SA/MCP `removeForm` / `removeModule` tools).
 *
 * The answer is a REFUSAL that names the links, never a cascade. Two
 * reasons. A cascade can itself fail the gate: dropping the link that was a
 * form's terminal "otherwise" re-exposes `FORM_LINK_NO_FALLBACK` on a form
 * the author never touched, so the batch would bounce with a finding about
 * the wrong entity. And a cascade quietly rewrites where OTHER forms send
 * people after submit, which is a behavior change nobody asked for; naming
 * the links puts the choice (retarget or remove) with the person. This is
 * the `userMutations.ts` custom-property pattern: refuse while something
 * still references the thing, say exactly what.
 *
 * Links that live ON the removed entity are not dependents — they leave
 * with it (a removed module takes its forms' links; a removed form takes
 * its own, self-links included).
 */

import type { BlueprintDoc, FormLink, Uuid } from "@/lib/domain";

/** One link that would dangle: the form it lives on and the link itself. */
export interface FormLinkDependent {
	readonly formUuid: Uuid;
	readonly formName: string;
	readonly moduleName: string;
	readonly linkUuid: Uuid;
}

export type FormLinkDependentsPlan =
	/** Nothing outside the removed subtree links into it. */
	| { readonly kind: "none" }
	/**
	 * Links outside the removed subtree point into it — the batch must not
	 * run. `message` names every link and the repair for the SA (tool names
	 * intact); `userMessage` is the same frame in the builder's voice.
	 */
	| {
			readonly kind: "blocked";
			readonly dependents: readonly FormLinkDependent[];
			readonly message: string;
			readonly userMessage: string;
	  };

export type FormLinkRemovalTarget =
	| { readonly kind: "form"; readonly formUuid: Uuid }
	| { readonly kind: "module"; readonly moduleUuid: Uuid };

/**
 * The links that would dangle if `target` were removed, in document order.
 */
export function formLinkDependentsOnRemove(
	doc: BlueprintDoc,
	target: FormLinkRemovalTarget,
): FormLinkDependent[] {
	const removedForms = new Set<Uuid>(
		target.kind === "form"
			? [target.formUuid]
			: (doc.formOrder[target.moduleUuid] ?? []),
	);
	const removedModule =
		target.kind === "module" ? target.moduleUuid : undefined;
	const pointsIn = (link: FormLink): boolean => {
		if (link.target.type === "form") {
			return (
				removedForms.has(link.target.formUuid) ||
				link.target.moduleUuid === removedModule
			);
		}
		return link.target.moduleUuid === removedModule;
	};

	const dependents: FormLinkDependent[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (removedForms.has(formUuid)) continue;
			const form = doc.forms[formUuid];
			for (const link of form?.formLinks ?? []) {
				if (!pointsIn(link)) continue;
				dependents.push({
					formUuid,
					formName: form?.name ?? String(formUuid),
					moduleName: mod.name,
					linkUuid: link.uuid,
				});
			}
		}
	}
	return dependents;
}

/**
 * The refusal, or `none`, for removing `target`. The removed entity's own
 * name frames the message; an unknown target is `none` (the caller's
 * missing-entity branch owns that case).
 */
export function planFormLinkDependentsOnRemove(
	doc: BlueprintDoc,
	target: FormLinkRemovalTarget,
): FormLinkDependentsPlan {
	const dependents = formLinkDependentsOnRemove(doc, target);
	if (dependents.length === 0) return { kind: "none" };

	const removedName =
		target.kind === "form"
			? doc.forms[target.formUuid]?.name
			: doc.modules[target.moduleUuid]?.name;
	const noun = target.kind === "form" ? "form" : "module";
	const subject =
		removedName === undefined ? `this ${noun}` : `${noun} "${removedName}"`;

	// One entry per SOURCE form in the SA message (a form with two links into
	// the target is still one place to fix), every link uuid listed so the
	// repair is addressable.
	const bySource = new Map<Uuid, FormLinkDependent[]>();
	for (const dependent of dependents) {
		const held = bySource.get(dependent.formUuid) ?? [];
		held.push(dependent);
		bySource.set(dependent.formUuid, held);
	}
	const references = [...bySource.values()].map((links) => {
		const first = links[0];
		const linkIds = links.map((link) => link.linkUuid).join(", ");
		return `"${first.formName}" in "${first.moduleName}" (form ${first.formUuid}; link${links.length === 1 ? "" : "s"} ${linkIds})`;
	});
	const sourceNames = [...bySource.values()].map(
		(links) => `"${links[0].formName}"`,
	);
	const sourceList =
		sourceNames.length === 1
			? sourceNames[0]
			: `${sourceNames.slice(0, -1).join(", ")} and ${sourceNames.at(-1)}`;

	const message =
		`Cannot remove ${subject}: ${dependents.length === 1 ? "an after-submit link points" : `${dependents.length} after-submit links point`} at it from ${references.join("; ")}. ` +
		`Point ${dependents.length === 1 ? "that link" : "those links"} somewhere else with update_form_link, or remove ${dependents.length === 1 ? "it" : "them"} with remove_form_link, then remove the ${noun}.`;
	const userMessage =
		`${removedName === undefined ? `This ${noun}` : `"${removedName}"`} can't be removed yet: ${sourceList} ${sourceNames.length === 1 ? "sends" : "send"} people to it after submit. ` +
		`Point ${dependents.length === 1 ? "that link" : "those links"} somewhere else, or remove ${dependents.length === 1 ? "it" : "them"}, then try again.`;

	return { kind: "blocked", dependents, message, userMessage };
}
