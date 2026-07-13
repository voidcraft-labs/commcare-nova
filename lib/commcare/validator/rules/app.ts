/**
 * App-level validation rules.
 *
 * Each rule receives the normalized `BlueprintDoc` and returns validation
 * errors. App-scope rules span multiple modules — duplicate-module-name
 * detection, child-case-type coverage, form-link cycle detection.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";
import { RESERVED_CASE_TYPE_NAMES } from "../reservedNamespaces";
import { fieldKindMatchesPropertyType } from "./fieldKindMatchesPropertyType";

function noModules(doc: BlueprintDoc): ValidationError[] {
	// CommCare HQ rejects an application with no modules at build time
	// (commcare-hq app_manager/helpers/validators.py::ApplicationValidator
	// `_check_modules`) — a module is what produces a navigation menu entry,
	// so a moduleless app has nothing to open. Nova never PERSISTS a moduleless
	// app, but a human does meet this finding: the commit gate raises it when
	// they try to remove the app's last module, so the message is written for
	// that remove-path context, not only for export.
	if (doc.moduleOrder.length > 0) return [];
	// Shown both when an app has no modules yet AND when the user tries to remove
	// its last one, so the wording can't just say "add a module" — that reads
	// backwards for a delete. State the rule, then give the remove-path guidance.
	return [
		validationError(
			"NO_MODULES",
			"app",
			`Your app needs at least one module — it's the menu entry users tap to reach a form or case list. Add a module, or, if you're removing your last one, add another first.`,
			{},
		),
	];
}

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

/**
 * Reject a case type named after a reserved reference namespace
 * (`form` / `user` / `case` / `parent`, case-insensitive). Such a name
 * collides with the hashtag system: `#user/<prop>` always resolves to
 * CommCare's built-in user case (the wire resolves the flat namespace first),
 * so the validator would accept `#user/x` as the project's `user` type while
 * the emitter silently points it at the wrong case — a wrong emit with no
 * authoring signal. The reserved set is shared with `checkCaseHashtag`'s
 * resolution skip-set (`reservedNamespaces.ts`) so the two can't drift. Scans
 * every module's `caseType` AND the case-type catalog so a child type declared
 * only in `doc.caseTypes` is caught too; each offending name is reported once.
 */
function reservedCaseTypeName(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const flagged = new Set<string>();

	const flag = (name: string, location: ValidationError["location"]): void => {
		const lower = name.toLowerCase();
		if (!RESERVED_CASE_TYPE_NAMES.has(lower)) return;
		if (flagged.has(lower)) return;
		flagged.add(lower);
		errors.push(
			validationError(
				"RESERVED_CASE_TYPE_NAME",
				"app",
				`Case type "${name}" collides with a reserved reference namespace. CommCare's hashtag system reserves #form/, #user/, #case/, and #parent/ — "#${name}/<property>" would resolve to the built-in "${lower}" namespace, not this case type. Rename it to something project-specific (e.g. "${name}_record").`,
				location,
				{ caseType: name },
			),
		);
	};

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod.caseType) {
			flag(mod.caseType, { moduleUuid, moduleName: mod.name });
		}
	}
	for (const ct of doc.caseTypes ?? []) {
		flag(ct.name, {});
	}
	return errors;
}

/**
 * Every case type that forms actually WRITE (`case_property_on`) needs a
 * module of its own — a cross-type writer creates cases, and a created
 * case with no module has no case list to appear in, so it is invisible
 * to every user. Keyed on WRITERS, not on the catalog: a planned record
 * (committed by `generateSchema` ahead of its module) is legal on its
 * own — the finding fires only once a form would create cases nobody can
 * open. This is also what sequences a build: a case type's own module
 * must land before any other module's forms create cases of it. The code
 * keeps its historical name (finding identity is stable across the gate
 * and the legacy-repair judgments); child buckets are how cross-type
 * writers normally arise, but a written standalone type without a module
 * is the same defect and fires too.
 */
function childCaseTypeMissingModule(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const moduleCaseTypes = new Set(
		doc.moduleOrder
			.map((uuid) => doc.modules[uuid].caseType)
			.filter((v): v is string => Boolean(v)),
	);

	// Every case type any form field writes, walking each form's field
	// tree (groups/repeats nest writers).
	const writtenTypes = new Set<string>();
	const walk = (parentUuid: string): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;
			const target = (field as unknown as Record<string, unknown>)
				.case_property_on;
			if (typeof target === "string" && target.length > 0) {
				writtenTypes.add(target);
			}
			if (doc.fieldOrder[fieldUuid] !== undefined) walk(fieldUuid);
		}
	};
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			walk(formUuid);
		}
	}

	for (const written of writtenTypes) {
		if (moduleCaseTypes.has(written)) continue;
		const parent = doc.caseTypes?.find(
			(ct) => ct.name === written,
		)?.parent_type;
		errors.push(
			validationError(
				"MISSING_CHILD_CASE_MODULE",
				"app",
				`Cases of type "${written}"${parent ? ` (child of "${parent}")` : ""} are created by forms, but there is no module to display them. CommCare requires every case type to have a module — add one with case_type "${written}" (a case-list-only module is enough) and configure its case list columns so users can see these cases.`,
				{},
				{ caseType: written },
			),
		);
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

/**
 * A Connect app needs at least one PARTICIPATING form — one whose connect
 * block carries a sub-config of the app's mode family (learn →
 * learn_module / assessment; deliver → deliver_unit / task).
 *
 * Participation is per form and optional: CommCare Connect's ingestion is
 * coverage-blind (`commcare_connect/opportunity/app_xml.py::extract_modules`
 * scans each form for connect-namespace blocks and silently skips forms
 * without them), and `opportunity/tasks.py::
 * create_learn_modules_and_deliver_units` upserts whatever was found with
 * no coverage validation — so a blockless form is simply auxiliary, never
 * an error. What Connect cannot survive is ZERO participation: learn
 * progress is a percentage over the ingested learn-module rows
 * (`opportunity/models.py::OpportunityAccess.learn_progress`) and payment
 * groups submissions by the ingested deliver units, so an app contributing
 * no rows of its mode produces an opportunity that can never progress or
 * pay. That floor is this rule.
 *
 * An app with no forms at all stays clean: an empty Connect app is the
 * documented starting state of a Connect build (`updateApp` flips
 * `connect_type` first, then each creation lands participating forms with
 * their blocks), so the floor only binds once forms exist.
 */
function connectNoParticipatingForms(doc: BlueprintDoc): ValidationError[] {
	if (!doc.connectType) return [];
	const isLearn = doc.connectType === "learn";
	let formCount = 0;
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			formCount++;
			const connect = doc.forms[formUuid]?.connect;
			if (!connect) continue;
			const participates = isLearn
				? connect.learn_module || connect.assessment
				: connect.deliver_unit || connect.task;
			if (participates) return [];
		}
	}
	if (formCount === 0) return [];
	const detail = isLearn
		? "no form carries a learn module or an assessment, so there is nothing for workers to complete and learning progress can never move"
		: "no form carries a deliver unit or a task, so there is nothing payable to deliver";
	const fix = isLearn
		? "Give at least one form a connect block (a learn_module for educational content, an assessment for a quiz, or both — via the form's Connect settings or update_form)"
		: "Give at least one form a connect block (a deliver_unit, and optionally a task — via the form's Connect settings or update_form)";
	return [
		validationError(
			"CONNECT_NO_PARTICIPATING_FORMS",
			"app",
			`This is a Connect ${doc.connectType} app, but ${detail}. A Connect app needs at least one participating form — a form without a connect block simply stays out of Connect, which is fine for the rest. ${fix}, or turn Connect off for the whole app (App Settings, or update_app with connect_type null).`,
			{},
		),
	];
}

export const APP_RULES = [
	noModules,
	emptyAppName,
	reservedCaseTypeName,
	childCaseTypeMissingModule,
	circularFormLinks,
	duplicateConnectIds,
	connectNoParticipatingForms,
	// Cross-form rule — multi-writer disagreement detection requires the
	// full app's writer set, so the rule is app-scoped rather than
	// module-scoped.
	fieldKindMatchesPropertyType,
];
