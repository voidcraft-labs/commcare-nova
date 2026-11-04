/**
 * What removing a form or a module means for the after-submit links that
 * point INTO it: the decision every remove surface consults before it
 * builds its batch (`useBlueprintMutations.removeForm` / `removeModule`,
 * the SA/MCP `removeForm` / `removeModule` tools). A form's otherwise link
 * is a link like its destinations: one that points in is a dependent too.
 *
 * The answer is a REFUSAL that names the links, never a cascade. A cascade
 * quietly rewrites where OTHER forms send people after submit, which is a
 * behavior change nobody asked for, and removing a destination can take a
 * form's otherwise or its after-submit with it; naming the links puts the
 * choice (retarget or remove) with the person. This is the
 * `userMutations.ts` custom-property pattern: refuse while something still
 * references the thing, say exactly what.
 *
 * Links that live ON the removed entity are not dependents: they leave
 * with it (a removed module takes its forms' links; a removed form takes
 * its own, a link that starts it again included).
 */

import {
	type BlueprintDoc,
	type FormLinkTarget,
	formLinkEntries,
	type Uuid,
} from "@/lib/domain";

/** One link that would dangle: the form it lives on and the link itself. */
export interface FormLinkDependent {
	readonly formUuid: Uuid;
	readonly formName: string;
	readonly moduleName: string;
	readonly linkUuid: Uuid;
	/** A destination, or the form's otherwise link. */
	readonly role: "destination" | "otherwise";
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
	/* `this-form` names the link's own form, which stays. */
	const pointsIn = (target: FormLinkTarget): boolean => {
		if (target.type === "this-form") return false;
		if (target.type === "form") {
			return (
				removedForms.has(target.formUuid) || target.moduleUuid === removedModule
			);
		}
		return target.moduleUuid === removedModule;
	};

	const dependents: FormLinkDependent[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (removedForms.has(formUuid)) continue;
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			for (const entry of formLinkEntries(form)) {
				if (!pointsIn(entry.link.target)) continue;
				dependents.push({
					formUuid,
					formName: form.name,
					moduleName: mod.name,
					linkUuid: entry.link.uuid,
					role: entry.role,
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
		const linkIds = links
			.map((link) =>
				link.role === "otherwise"
					? `${link.linkUuid} (its otherwise)`
					: link.linkUuid,
			)
			.join(", ");
		return `"${first.formName}" in "${first.moduleName}" (form ${first.formUuid}; link${links.length === 1 ? "" : "s"} ${linkIds})`;
	});
	const sourceNames = [...bySource.values()].map(
		(links) => `"${links[0].formName}"`,
	);
	const sourceList =
		sourceNames.length === 1
			? sourceNames[0]
			: `${sourceNames.slice(0, -1).join(", ")} and ${sourceNames.at(-1)}`;

	// A destination is repaired with the link tools, an otherwise link with
	// set_form_otherwise, so the repair names the tools each link needs.
	const one = dependents.length === 1;
	const roles = new Set(dependents.map((dependent) => dependent.role));
	const destinationRepair =
		"point it somewhere else with update_form_link, or remove it with remove_form_link";
	const otherwiseRepair =
		"point it somewhere else with set_form_otherwise, or clear it with set_form_otherwise null";
	const repair =
		roles.size === 2
			? `for a destination, ${destinationRepair}; for an otherwise link, ${otherwiseRepair}`
			: `for ${one ? "that link" : "each of those links"}, ${roles.has("otherwise") ? otherwiseRepair : destinationRepair}`;
	const message =
		`Cannot remove ${subject}: ${one ? "an after-submit link points" : `${dependents.length} after-submit links point`} at it from ${references.join("; ")}. ` +
		`${repair.charAt(0).toUpperCase()}${repair.slice(1)}, then remove the ${noun}.`;
	const userMessage =
		`${removedName === undefined ? `This ${noun}` : `"${removedName}"`} can't be removed yet: ${sourceList} ${sourceNames.length === 1 ? "sends" : "send"} people to it after submit. ` +
		`Point ${dependents.length === 1 ? "that link" : "those links"} somewhere else, or remove ${dependents.length === 1 ? "it" : "them"}, then try again.`;

	return { kind: "blocked", dependents, message, userMessage };
}
