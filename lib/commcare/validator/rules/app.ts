/**
 * App-level validation rules.
 *
 * Each rule receives the normalized `BlueprintDoc` and returns validation
 * errors. App-scope rules span multiple modules — duplicate-module-name
 * detection, child-case-type coverage, form-link cycle detection.
 */

import { parseXPathExpressionWithIssues } from "@/lib/commcare/xpath";
import {
	authoredBlueprintIdentities,
	type BlueprintAuthoredIdentityKind,
	type BlueprintDoc,
	blueprintTopologyIssues,
	collectTranslationUnits,
	deriveCaseWriteInventory,
	isConnectLearnConfig,
	projectXPath,
	translationValueIntegrityIssue,
	type Uuid,
	xpathPrintContext,
} from "@/lib/domain";
import { proseTemplateSurvivesTiptapRoundTrip } from "@/lib/tiptap/proseTemplateCodec";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { type ValidationError, validationError } from "../errors";
import { RESERVED_CASE_TYPE_NAMES } from "../reservedNamespaces";
import { AUTOMATION_RULES } from "./automations";
import { fieldKindMatchesPropertyType } from "./fieldKindMatchesPropertyType";
import { ORGANIZATION_RULES } from "./organization";
import { USER_RULES } from "./users";

function closedBlueprintTopology(doc: BlueprintDoc): ValidationError[] {
	return blueprintTopologyIssues(doc).map((issue) =>
		validationError(
			"BLUEPRINT_TOPOLOGY_INVALID",
			"app",
			`The app document has invalid membership topology. ${issue.message}`,
			{},
			{ path: issue.path.join(".") },
		),
	);
}

/**
 * Every authorable Blueprint object shares one identity namespace. Nested
 * options, columns, Search inputs, and operations are first-class addresses,
 * so a collision would make the meaning of a UUID depend on which tool or AST
 * leaf happened to consume it.
 */
function globallyUniqueEntityUuids(doc: BlueprintDoc): ValidationError[] {
	const byUuid = new Map<
		string,
		Array<{ kind: BlueprintAuthoredIdentityKind; label: string }>
	>();
	for (const identity of authoredBlueprintIdentities(doc)) {
		const members = byUuid.get(identity.uuid) ?? [];
		members.push({ kind: identity.kind, label: identity.kind });
		byUuid.set(identity.uuid, members);
	}

	const errors: ValidationError[] = [];
	for (const [uuid, members] of byUuid) {
		if (members.length < 2) continue;
		const kinds = members.map(({ label }) => label).join(", ");
		for (const member of members) {
			errors.push(
				validationError(
					"BLUEPRINT_ENTITY_UUID_DUPLICATE",
					"app",
					`Two authored app objects share the stable identity "${uuid}" (${kinds}). Give every module, form, field, select option, case-list column, Search input, case operation, worker-information property, role, persona, automation, and automation child its own identity.`,
					{},
					{ entityUuid: uuid, entityKind: member.kind },
				),
			);
		}
	}
	return errors;
}

function canonicalCasePropertyDefaults(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const printContext = xpathPrintContext(doc);
	const userProperties = Object.values(doc.userProperties ?? {});
	const resolveUserProperty = (slug: string): Uuid | undefined => {
		const matches = userProperties.filter(
			(property) => property?.slug === slug,
		);
		return matches.length === 1 ? matches[0]?.uuid : undefined;
	};
	const flag = (
		caseType: string,
		property: string,
		slot: string,
		reason: string,
	): void => {
		errors.push(
			validationError(
				"CASE_PROPERTY_REFERENCE_INVALID",
				"app",
				`Case property "${caseType}.${property}" has a noncanonical ${slot} default. ${reason}`,
				{},
				{ caseType, property, slot },
			),
		);
	};

	for (const caseType of doc.caseTypes ?? []) {
		for (const property of caseType.properties) {
			for (const [slot, expression] of [
				["required", property.required],
				["validation", property.validation],
			] as const) {
				if (expression === undefined) continue;
				if (
					expression.parts.some(
						(part) => part.kind === "field-ref" || part.kind === "path-ref",
					)
				) {
					flag(
						caseType.name,
						property.name,
						slot,
						"Catalog defaults cannot read a form answer; put that reference on the field-specific override.",
					);
					continue;
				}
				const projection = projectXPath(expression, printContext);
				if (!projection.ok) {
					flag(
						caseType.name,
						property.name,
						slot,
						"The XPath contains an unresolved authored reference.",
					);
					continue;
				}
				const source = projection.text;
				const parsed = parseXPathExpressionWithIssues(
					source,
					() => undefined,
					resolveUserProperty,
				);
				// Canonicalized comparison: admission may have re-serialized
				// the stored AST with sorted object keys, and key order is
				// not part of the identity being proved here.
				if (
					parsed.issues.length > 0 ||
					canonicalJsonText(parsed.expression) !== canonicalJsonText(expression)
				) {
					flag(
						caseType.name,
						property.name,
						slot,
						"The XPath must parse and print to the identical identity AST, with every custom worker reference stored by UUID.",
					);
				}
			}

			for (const [slot, template] of [
				["label", property.label],
				["hint", property.hint],
				["validation_msg", property.validation_msg],
				...(property.options ?? []).map(
					(option, index) => [`options[${index}].label`, option.label] as const,
				),
			] as const) {
				if (template === undefined) continue;
				const hasExternalUserCollision = template.parts.some(
					(part) =>
						part.kind === "user-ref" &&
						userProperties.some(
							(property) =>
								property?.slug.toLowerCase() === part.property.toLowerCase(),
						),
				);
				if (
					!proseTemplateSurvivesTiptapRoundTrip(template) ||
					template.parts.some((part) => part.kind === "field-ref") ||
					hasExternalUserCollision
				) {
					flag(
						caseType.name,
						property.name,
						slot,
						"Catalog text must survive the reference editor round trip, cannot read a form answer, and must store Nova-owned worker information by UUID.",
					);
				}
			}
		}
	}
	return errors;
}

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
			`Your app needs at least one module. It's the menu entry users tap to reach a form or case list. Add a module, or, if you're removing your last one, add another first.`,
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

/** Every target overlay must address a live unit and preserve typed tokens. */
function validTranslationOverlays(doc: BlueprintDoc): ValidationError[] {
	if (doc.localization === undefined) return [];
	const units = new Map(
		collectTranslationUnits(doc).map((unit) => [unit.id, unit]),
	);
	const errors: ValidationError[] = [];
	for (const [language, entries] of Object.entries(
		doc.localization.translations,
	)) {
		for (const [unitId, entry] of Object.entries(entries)) {
			const unit = units.get(unitId);
			if (unit === undefined) {
				errors.push(
					validationError(
						"TRANSLATION_UNIT_UNKNOWN",
						"app",
						`The ${language} translation refers to content that no longer exists. Remove the orphaned translation and try again.`,
						{},
						{ language, unitId },
					),
				);
				continue;
			}
			const issue = translationValueIntegrityIssue(unit, entry.value);
			if (issue === "value-kind") {
				errors.push(
					validationError(
						"TRANSLATION_VALUE_KIND_MISMATCH",
						"app",
						`The ${language} translation for ${unit.breadcrumb.join(" → ")} has the wrong value type. Keep reference-capable content structured and plain text plain.`,
						{},
						{ language, unitId, role: unit.role },
					),
				);
				continue;
			}
			if (issue === "blank-content") {
				errors.push(
					validationError(
						"TRANSLATION_REQUIRED_CONTENT_BLANK",
						"app",
						`The ${language} translation for ${unit.breadcrumb.join(" → ")} cannot be blank. Enter the worker-facing text and try again.`,
						{},
						{ language, unitId, role: unit.role },
					),
				);
				continue;
			}
			if (
				issue === "protected-content" &&
				entry.sourceFingerprint === unit.sourceFingerprint
			) {
				errors.push(
					validationError(
						"TRANSLATION_PROTECTED_CONTENT_CHANGED",
						"app",
						`The ${language} translation for ${unit.breadcrumb.join(" → ")} changed a protected app reference. Translate only the surrounding words; every reference token must remain exactly once.`,
						{},
						{ language, unitId, role: unit.role },
					),
				);
			}
		}
	}
	return errors;
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
				`Case type "${name}" collides with a reserved reference namespace. CommCare's hashtag system reserves #form/, #user/, #case/, and #parent/: "#${name}/<property>" would resolve to the built-in "${lower}" namespace, not this case type. Rename it to something project-specific (for example "${name}_record").`,
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
 * Every direct-child case type that canonical form inventories actually emit
 * needs a module of its own — a child bucket creates cases, and a created
 * case with no module has no case list to appear in, so it is invisible
 * to every user. Keyed on WRITERS, not on the catalog: a planned record
 * (committed by `generateSchema` ahead of its module) is legal on its
 * own — the finding fires only once a form would create cases nobody can
 * open. This is also what sequences a build: a case type's own module
 * must land before any other module's forms create cases of it. The code
 * consumes emitted buckets rather than interpreting field annotations again:
 * survey/module-less writers are no-action admission failures, and invalid
 * sibling/ancestor/unrelated destinations never become child creates.
 */
function childCaseTypeMissingModule(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const moduleCaseTypes = new Set(
		doc.moduleOrder
			.map((uuid) => doc.modules[uuid].caseType)
			.filter((v): v is string => Boolean(v)),
	);

	const writtenTypes = new Set<string>();
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const inventory = deriveCaseWriteInventory(
				doc,
				formUuid,
				module,
				form.type,
			);
			for (const bucket of inventory.buckets) {
				if (bucket.kind === "child") writtenTypes.add(bucket.caseType);
			}
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
				`Cases of type "${written}"${parent ? ` (child of "${parent}")` : ""} are created by forms, but there is no module to display them. CommCare requires every case type to have a module. Add one with case_type "${written}" (a case-list-only module is enough) and configure its case list columns so users can see these cases.`,
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
				`After form submission, CommCare evaluates links in sequence, a cycle means ` +
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
 * A separate form rule rejects a dormant block or a block whose family does
 * not match the app mode. This rule therefore runs only for an enabled mode
 * and inventories every final stored block; app scope gives the user a
 * fixable error before export when the collision spans forms.
 */
function duplicateConnectIds(doc: BlueprintDoc): ValidationError[] {
	if (!doc.connectType) return [];
	const errors: ValidationError[] = [];

	// First occurrence of each id (in document order) wins; every later
	// occurrence is the duplicate that gets flagged.
	const firstSite = new Map<string, string>();
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const connect = form?.connect;
			if (!connect) continue;
			const blocks = isConnectLearnConfig(connect)
				? [
						{ block: connect.learn_module, label: "learn-module" },
						{ block: connect.assessment, label: "assessment" },
					]
				: [
						{ block: connect.deliver_unit, label: "deliver-unit" },
						{ block: connect.task, label: "task" },
					];
			for (const { block, label } of blocks) {
				if (block === undefined) continue;
				const id = block.id;
				const site = `"${form.name}" (${label})`;
				const prior = firstSite.get(id);
				if (prior) {
					errors.push(
						validationError(
							"CONNECT_ID_DUPLICATE",
							"app",
							`Connect id "${id}" is used by two blocks: ${prior} and ${site}. Each Connect id must be unique across the app: it becomes the block's database slug and its XForm element name, so a shared id collapses the two blocks into one. Rename one of them.`,
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
 * The floor binds immediately. Connect mode and the complete nonempty
 * participant set are configured in one atomic target-state command, so a
 * mode-only intermediate is neither needed nor valid.
 */
function connectNoParticipatingForms(doc: BlueprintDoc): ValidationError[] {
	if (!doc.connectType) return [];
	const isLearn = doc.connectType === "learn";
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const connect = doc.forms[formUuid]?.connect;
			if (!connect) continue;
			const participates = isLearn
				? isConnectLearnConfig(connect)
				: !isConnectLearnConfig(connect);
			if (participates) return [];
		}
	}
	const detail = isLearn
		? "no form carries a learn module or an assessment, so there is nothing for workers to complete and learning progress can never move"
		: "no form carries a deliver unit or a task, so there is nothing payable to deliver";
	const fix = isLearn
		? "Configure the complete target with at least one participating form (a learn_module for educational content, an assessment for a quiz, or both)"
		: "Configure the complete target with at least one participating form (a deliver_unit, and optionally a task)";
	return [
		validationError(
			"CONNECT_NO_PARTICIPATING_FORMS",
			"app",
			`This is a Connect ${doc.connectType} app, but ${detail}. A Connect app needs at least one participating form, a form without a connect block simply stays out of Connect, which is fine for the rest. ${fix} through configureConnect/configure_connect, or turn Connect off there with mode null.`,
			{},
		),
	];
}

export const APP_RULES = [
	closedBlueprintTopology,
	globallyUniqueEntityUuids,
	canonicalCasePropertyDefaults,
	noModules,
	emptyAppName,
	validTranslationOverlays,
	reservedCaseTypeName,
	childCaseTypeMissingModule,
	circularFormLinks,
	duplicateConnectIds,
	connectNoParticipatingForms,
	// Cross-form rule — multi-writer disagreement detection requires the
	// full app's writer set, so the rule is app-scoped rather than
	// module-scoped.
	fieldKindMatchesPropertyType,
	// Who runs the app: the user-data property catalog, the roles built on
	// it, and the personas that act as those roles. App-scoped because none
	// of the three belongs to a module or a form.
	...USER_RULES,
	...ORGANIZATION_RULES,
	...AUTOMATION_RULES,
];
