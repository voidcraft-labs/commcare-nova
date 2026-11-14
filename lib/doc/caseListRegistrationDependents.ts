/**
 * What removing a form or a module means for the case lists that always
 * offer one of its forms: the decision every remove surface consults beside
 * the link dependents (`formLinkDependents.ts`) before it builds its batch
 * (`useBlueprintMutations.removeForm` / `removeModule`, the SA/MCP
 * `removeForm` / `removeModule` tools).
 *
 * The answer is a REFUSAL that names each list, never a cascade: a list
 * that stops offering its Register button changes what workers can do from
 * it, so the person (or the agent) clears each offer first and then removes
 * the form. The reducers still drop a slot whose form a committed removal
 * takes, so a replayed removal leaves no dangling identity.
 *
 * A list inside the removed module is not a dependent: it leaves with the
 * module. A list that offers its form after an empty search holds a form of
 * its own module, so it leaves with that form too.
 */

import {
	alwaysOfferedRegistrationOf,
	type BlueprintDoc,
	type Uuid,
} from "@/lib/domain";
import type { FormLinkRemovalTarget } from "./formLinkDependents";
import type { Mutation } from "./types";

/** One case list that would stop offering a removed form. */
export interface CaseListRegistrationDependent {
	readonly hostModuleUuid: Uuid;
	readonly hostModuleName: string;
	readonly formUuid: Uuid;
	readonly formName: string;
}

export type CaseListRegistrationDependentsPlan =
	| { readonly kind: "none" }
	| {
			readonly kind: "blocked";
			readonly dependents: readonly CaseListRegistrationDependent[];
			/** The agent's sentence, tool names intact. */
			readonly message: string;
			/** The same refusal in the builder's voice. */
			readonly userMessage: string;
	  };

/** `a`, `a and b`, `a, b and c`. */
export function listWithAnd(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The case lists outside the removed subtree whose `always` arm names a
 *  removed form, in `moduleOrder`. */
export function caseListRegistrationDependentsOnRemove(
	doc: BlueprintDoc,
	target: FormLinkRemovalTarget,
): CaseListRegistrationDependent[] {
	const removedForms = new Set<Uuid>(
		target.kind === "form"
			? [target.formUuid]
			: (doc.formOrder[target.moduleUuid] ?? []),
	);
	const dependents: CaseListRegistrationDependent[] = [];
	for (const hostModuleUuid of doc.moduleOrder) {
		if (target.kind === "module" && hostModuleUuid === target.moduleUuid)
			continue;
		const slot = alwaysOfferedRegistrationOf(doc, hostModuleUuid);
		if (slot === undefined || !removedForms.has(slot.formUuid)) continue;
		const host = doc.modules[hostModuleUuid];
		dependents.push({
			hostModuleUuid,
			hostModuleName: host?.name ?? "",
			formUuid: slot.formUuid,
			formName: doc.forms[slot.formUuid]?.name ?? "",
		});
	}
	return dependents;
}

/**
 * The refusal, or `none`, for removing `target`. One sentence per offered
 * form, naming every list that offers it.
 */
export function planCaseListRegistrationDependentsOnRemove(
	doc: BlueprintDoc,
	target: FormLinkRemovalTarget,
): CaseListRegistrationDependentsPlan {
	const dependents = caseListRegistrationDependentsOnRemove(doc, target);
	if (dependents.length === 0) return { kind: "none" };
	const byForm = new Map<Uuid, CaseListRegistrationDependent[]>();
	for (const dependent of dependents) {
		const held = byForm.get(dependent.formUuid) ?? [];
		held.push(dependent);
		byForm.set(dependent.formUuid, held);
	}
	const groups = [...byForm.values()];
	const userMessage = groups
		.map((hosts) => {
			const names = hosts.map((host) => host.hostModuleName);
			const where =
				names.length === 1
					? `on ${names[0]}'s case list`
					: `on the case lists of ${listWithAnd(names)}`;
			return `${hosts[0].formName} is offered ${where}. You can stop offering it there, and then remove it.`;
		})
		.join(" ");
	const message = groups
		.map((hosts) => {
			const names = hosts.map((host) => `"${host.hostModuleName}"`);
			const offers =
				names.length === 1
					? `${names[0]} offers from its case list`
					: `${listWithAnd(names)} offer from their case lists`;
			return `Form "${hosts[0].formName}" is the registration ${offers} (register_from_case_list on update_module). You can set that to null on each menu that offers it, and then remove the form.`;
		})
		.join(" ");
	return { kind: "blocked", dependents, message, userMessage };
}

/**
 * The batch behind "Stop offering it" on that refusal, read from `doc` when
 * the person presses it: each named list's offer cleared where the list
 * still offers the form the refusal named. A list given another form since
 * offers one the refusal never named, and keeps it.
 */
export function stopOfferingDependentsMutations(
	doc: Pick<BlueprintDoc, "modules">,
	dependents: readonly CaseListRegistrationDependent[],
): Mutation[] {
	const mutations: Mutation[] = [];
	const cleared = new Set<Uuid>();
	for (const { hostModuleUuid, formUuid } of dependents) {
		if (cleared.has(hostModuleUuid)) continue;
		if (alwaysOfferedRegistrationOf(doc, hostModuleUuid)?.formUuid !== formUuid)
			continue;
		cleared.add(hostModuleUuid);
		mutations.push({
			kind: "updateModule",
			uuid: hostModuleUuid,
			patch: { caseListRegistrationForm: null },
		});
	}
	return mutations;
}
