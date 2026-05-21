/**
 * App-level validation rules.
 *
 * Each rule receives the normalized `BlueprintDoc` and returns validation
 * errors. App-scope rules span multiple modules — duplicate-module-name
 * detection, child-case-type coverage, form-link cycle detection.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";
import { fieldKindMatchesPropertyType } from "./fieldKindMatchesPropertyType";

function emptyAppName(doc: BlueprintDoc): ValidationError[] {
	if (doc.appName?.trim()) return [];
	return [
		validationError(
			"EMPTY_APP_NAME",
			"app",
			`Your app needs a name. CommCare uses this as the display title on devices, so pick something users will recognize.`,
			{},
		),
	];
}

function duplicateModuleNames(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const seen = new Map<string, number>();

	for (let i = 0; i < doc.moduleOrder.length; i++) {
		const mod = doc.modules[doc.moduleOrder[i]];
		const prev = seen.get(mod.name);
		if (prev !== undefined) {
			errors.push(
				validationError(
					"DUPLICATE_MODULE_NAME",
					"app",
					`Module "${mod.name}" appears twice (modules ${prev + 1} and ${i + 1}). Each module needs a unique name because CommCare uses it to build the navigation menu — duplicate names would make two menu items indistinguishable.`,
					{ moduleUuid: mod.uuid, moduleName: mod.name },
				),
			);
		} else {
			seen.set(mod.name, i);
		}
	}
	return errors;
}

function childCaseTypeMissingModule(doc: BlueprintDoc): ValidationError[] {
	if (!doc.caseTypes) return [];
	const errors: ValidationError[] = [];
	const moduleCaseTypes = new Set(
		doc.moduleOrder
			.map((uuid) => doc.modules[uuid].caseType)
			.filter((v): v is string => Boolean(v)),
	);

	for (const ct of doc.caseTypes) {
		if (ct.parent_type && !moduleCaseTypes.has(ct.name)) {
			errors.push(
				validationError(
					"MISSING_CHILD_CASE_MODULE",
					"app",
					`The child case type "${ct.name}" (child of "${ct.parent_type}") is created by forms but has no module to display it. CommCare requires every case type to have a module — add one with case_type "${ct.name}" and configure its case list columns so users can see these cases.`,
					{},
					{ caseType: ct.name },
				),
			);
		}
	}
	return errors;
}

/**
 * Detect circular form links: A→B→A, possibly through longer chains.
 *
 * Builds a uuid-keyed adjacency map over form → target-form edges (module
 * targets can't form cycles — they navigate to a menu, not a form) and
 * runs DFS from every form that has outgoing edges. Returns each cycle
 * once, keyed by the form it started from.
 */
function circularFormLinks(doc: BlueprintDoc): ValidationError[] {
	const adj = new Map<Uuid, Set<Uuid>>();
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form.formLinks?.length) continue;
			const targets = new Set<Uuid>();
			for (const link of form.formLinks) {
				if (link.target.type === "form") {
					targets.add(link.target.formUuid);
				}
			}
			if (targets.size > 0) adj.set(formUuid, targets);
		}
	}

	const cycles: Array<{ chain: Uuid[]; startUuid: Uuid }> = [];
	for (const startUuid of adj.keys()) {
		const visited = new Set<Uuid>();
		const stack: Array<{ uuid: Uuid; chain: Uuid[] }> = [
			{ uuid: startUuid, chain: [startUuid] },
		];
		while (stack.length > 0) {
			const popped = stack.pop();
			if (!popped) break;
			const { uuid, chain } = popped;
			const targets = adj.get(uuid);
			if (!targets) continue;
			for (const target of targets) {
				if (target === startUuid) {
					cycles.push({ chain: [...chain, target], startUuid });
				} else if (!visited.has(target)) {
					visited.add(target);
					stack.push({ uuid: target, chain: [...chain, target] });
				}
			}
		}
	}

	return cycles.map(({ chain, startUuid }) => {
		const formNames = chain.map(
			(uuid) => doc.forms[uuid]?.name ?? String(uuid),
		);
		const path = formNames.join(" → ");
		const startForm = doc.forms[startUuid];
		return validationError(
			"FORM_LINK_CIRCULAR",
			"app",
			`Circular form link detected: ${path}.\n\n` +
				`"${startForm?.name ?? startUuid}" eventually links back to itself through a chain of form links. ` +
				`After form submission, CommCare evaluates links in sequence — a cycle means ` +
				`the user would be trapped in an infinite loop of form submissions.\n\n` +
				`Break the cycle by changing one of the links in the chain to target a module menu instead of a form.`,
			{},
		);
	});
}

/**
 * Connect ids must be unique across the whole app.
 *
 * A connect id (`learn_module` / `assessment` / `deliver_unit` / `task`)
 * becomes both a per-kind DB slug key (`(app, slug)`) on the Connect side
 * and an XForm element name; two blocks sharing one id collide on either.
 * The scope is flat app-wide (every connect id on every form, regardless of
 * kind), matching the source guards (`enforceConnectIds` /
 * `connectIdConflictError`) and the emit tripwire in `buildConnectSlugMap` —
 * one shared notion of "taken" everywhere.
 *
 * Only kinds matching the app's `connectType` are scanned, so the rule
 * agrees with the resolver/defaulter, which only ever process matching-mode
 * blocks (a stray cross-mode block is never emitted, so it can't collide on
 * the wire). App-scope because the collision spans forms; this is the
 * surface that gives the user a fixable error before export.
 */
function duplicateConnectIds(doc: BlueprintDoc): ValidationError[] {
	if (!doc.connectType) return [];
	const errors: ValidationError[] = [];

	// The kinds that are real for this mode, paired with a human label.
	const liveKinds: ReadonlyArray<{
		kind: "learn_module" | "assessment" | "deliver_unit" | "task";
		label: string;
	}> =
		doc.connectType === "learn"
			? [
					{ kind: "learn_module", label: "learn-module" },
					{ kind: "assessment", label: "assessment" },
				]
			: [
					{ kind: "deliver_unit", label: "deliver-unit" },
					{ kind: "task", label: "task" },
				];

	// First occurrence of each id (in document order) wins; every later
	// occurrence is the duplicate that gets flagged.
	const firstSite = new Map<string, string>();
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const connect = form?.connect;
			if (!connect) continue;
			for (const { kind, label } of liveKinds) {
				const id = connect[kind]?.id;
				if (!id) continue;
				const site = `"${form.name}" (${label})`;
				const prior = firstSite.get(id);
				if (prior) {
					errors.push(
						validationError(
							"CONNECT_ID_DUPLICATE",
							"app",
							`Connect id "${id}" is used by two blocks — ${prior} and ${site}. Each Connect id must be unique across the app: it becomes the block's database slug and its XForm element name, so a shared id collapses the two blocks into one. Rename one of them.`,
							{ moduleUuid, formUuid, formName: form.name },
							{ connectId: id },
						),
					);
				} else {
					firstSite.set(id, site);
				}
			}
		}
	}
	return errors;
}

export const APP_RULES = [
	emptyAppName,
	duplicateModuleNames,
	childCaseTypeMissingModule,
	circularFormLinks,
	duplicateConnectIds,
	// Cross-form rule — multi-writer disagreement detection requires the
	// full app's writer set, so the rule is app-scoped rather than
	// module-scoped.
	fieldKindMatchesPropertyType,
];
