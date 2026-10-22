/**
 * Validation runner — single entry point for structured blueprint validation.
 *
 * Walks the normalized `BlueprintDoc` once, running scope-appropriate rules
 * at the app, module, form, and field levels, then runs deep XPath
 * validation. Returns structured `ValidationError[]` keyed by uuid.
 *
 * Every run receives an explicit lookup-definition context. The immutable
 * production extractor registry covers every authored carrier;
 * the argument remains required so no carrier can inherit a silent
 * skip/default at an old call site.
 *
 * Asset-context media rules (existence / ready / kind-match) need data
 * the doc alone can't carry: the resolved media-asset rows for the assets
 * the doc references. Callers that have those (the SA validation loop)
 * pass a manifest through `RunValidationOptions`; callers that don't
 * (the bulk of tests, the test oracles, the fuzz harness) omit the
 * options and the asset-context group is skipped. Doc-structural rules
 * — including `imageMapValueUnique` — fire either way; they live in
 * MODULE_RULES.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	type LookupReferenceExtractorRegistry,
	type LookupValidationContext,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { ValidationError, ValidationErrorCode } from "./errors";
import { validationError } from "./errors";
import {
	type FormLogicFinding,
	presentFormLogicFinding,
} from "./formLogicFindings";
import {
	type ProseSurface,
	scopeHasForm,
	scopeHasModule,
	type ValidationScope,
	validateBlueprintDeep,
} from "./index";
import { validateLookupReferences } from "./lookupReferences";
import { lookupTypeIndex } from "./lookupTypeContext";
import { APP_RULES } from "./rules/app";
import { runFieldRules } from "./rules/field";
import { entryPlanContext, runFormRules } from "./rules/form";
import { MEDIA_ASSET_RULES } from "./rules/media";
import { MODULE_RULES } from "./rules/module";
import { parentSelectionConflicts } from "./rules/parentSelection";

/** Optional context for a validation run. */
export interface RunValidationOptions {
	/**
	 * Resolved media-asset manifest — every `MediaAssetId` the doc
	 * references that the loader was willing to return, mapped to its
	 * loaded media-asset row. Built by the caller from
	 * `collectAssetRefs(doc)` + `loadAssetsByIds(projectId, ...)`. When
	 * supplied, the asset-context media rules run; when omitted, the
	 * rules are skipped silently. The manifest is the single slot the
	 * rules need, so "ran the media group" and "didn't" are the only
	 * two states — no half-supplied state is representable.
	 */
	readonly mediaAssets?: ReadonlyMap<string, MediaAssetRecord>;
	/**
	 * Restrict the entity walks to a scope (see `ValidationScope`).
	 * App-level rules and the asset-context media rules always run in
	 * full — see `errorWithinScope` for the resulting equivalence law.
	 * Omitted = full run.
	 */
	readonly scope?: ValidationScope;
	/**
	 * Explicit extractor seam for synthetic pure tests. Production callers omit
	 * it and use the immutable production registry.
	 */
	readonly lookupReferenceExtractors?: LookupReferenceExtractorRegistry;
	/**
	 * Activation flags for explicitly caller-owned vocabulary gates.
	 * Omitted = inactive — every gate emits.
	 */
}

/**
 * Codes whose producing rules run in FULL on every run, scoped or not, so
 * a scope never filters them:
 *
 *   - the `APP_RULES` products — app rules are cheap, their findings span
 *     entities (reserved case-type names, form-link cycles, cross-form
 *     case-property writer disagreement), and several anchor their
 *     location at whichever site happened to be walked first, so scoping
 *     them would make findings flicker with entity order;
 *   - the asset-context media rules — manifest-gated boundary rules that
 *     never run on the commit path (no caller passes both a manifest and
 *     a scope today), kept scope-exempt so the law below stays total;
 *   - `MEDIA_EXPORT_TOO_LARGE` — produced by the media-validation entry
 *     point (`lib/export/boundaryValidation.ts`), never by `runValidation`;
 *     listed so the filter is total over every code a boundary caller
 *     can see.
 *
 * Everything else attributes to the walk that produced it: module rules
 * emit module-anchored locations (`moduleUuid`, no `formUuid`); form
 * rules, field rules, and the deep XPath walk emit form-anchored
 * locations (`formUuid` always present).
 */
const SCOPE_EXEMPT_CODES: ReadonlySet<ValidationErrorCode> = new Set([
	"ENTRY_POINT_INVALID",
	// APP_RULES products.
	"CASE_PARENT_SELECTION_CONFLICT",
	"NO_MODULES",
	"EMPTY_APP_NAME",
	"APP_TEXT_UNREPRESENTABLE",
	"RESERVED_CASE_TYPE_NAME",
	"CASE_PROPERTY_OPTION_VALUE_INVALID",
	"MISSING_CHILD_CASE_MODULE",
	"FORM_LINK_CIRCULAR",
	"CONNECT_ID_DUPLICATE",
	"CONNECT_NO_PARTICIPATING_FORMS",
	"FIELD_KIND_PROPERTY_TYPE_MISMATCH",
	"FIELD_KIND_WRITERS_DISAGREE",
	"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
	"SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
	"BLUEPRINT_ENTITY_UUID_DUPLICATE",
	"AUTOMATION_INVALID",
	"TRANSLATION_UNIT_UNKNOWN",
	"TRANSLATION_VALUE_KIND_MISMATCH",
	"TRANSLATION_REQUIRED_CONTENT_BLANK",
	"TRANSLATION_PROTECTED_CONTENT_CHANGED",
	// User-property / role / persona rules are APP_RULES too.
	"USER_PROPERTY_SLUG_INVALID",
	"USER_PROPERTY_SLUG_DUPLICATE",
	"USER_PROPERTY_CHOICES_DUPLICATE",
	"USER_TYPE_NAME_DUPLICATE",
	"PERSONA_NAME_DUPLICATE",
	"PERSONA_USER_TYPE_UNKNOWN",
	"USER_DATA_UNKNOWN_PROPERTY",
	"USER_DATA_INVALID_CHOICE",
	"USER_PROPERTY_REFERENCE_UNKNOWN",
	"ORGANIZATION_LEVEL_CODE_DUPLICATE",
	"ORGANIZATION_LEVEL_NAME_DUPLICATE",
	"ORGANIZATION_LEVEL_PARENT_UNKNOWN",
	"ORGANIZATION_LEVEL_CYCLE",
	"ORGANIZATION_LEVEL_REFERENCE_UNKNOWN",
	"ORGANIZATION_LEVEL_CAP_NOT_BELOW",
	"ORGANIZATION_LEVEL_SCOPE_GAP",
	"ORGANIZATION_LEVEL_SCOPE_NOT_ANCESTOR",
	"ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT",
	"LOCATION_PROPERTY_SLUG_INVALID",
	"LOCATION_PROPERTY_SLUG_DUPLICATE",
	"LOCATION_PROPERTY_LEVEL_UNKNOWN",
	"LOCATION_PROPERTY_REQUIRED_CAPACITY",
	"PERSONA_LOCATION_PRIMARY_REPEATED",
	// Asset-context media rules + the export-budget aggregate guard.
	"MEDIA_ASSET_NOT_FOUND",
	"MEDIA_ASSET_NOT_READY",
	"MEDIA_KIND_MISMATCH",
	"MEDIA_EXPORT_TOO_LARGE",
	// Lookup validation always extracts the full doc. Context findings can span
	// carriers and are therefore scope-exempt just like app-wide rules.
	"LOOKUP_CONTEXT_UNAVAILABLE",
	"LOOKUP_TABLE_NOT_AVAILABLE",
	"LOOKUP_COLUMN_NOT_AVAILABLE",
	"LOOKUP_COLUMN_TYPE_MISMATCH",
]);

/**
 * The scoped-run ≡ full-run-filtered law: for every doc and scope,
 *
 *   runValidation(doc, context, { scope }) ≡
 *     runValidation(doc, context).filter((e) => errorWithinScope(e, scope))
 *
 * order-preserved (the property test pins this). This function is the
 * filter side of that law — attribution rides on which WALK produces a
 * code (see `SCOPE_EXEMPT_CODES`), then on the error's own location
 * uuids, which every module/form/field/deep finding carries.
 */
export function errorWithinScope(
	err: ValidationError,
	scope: ValidationScope,
): boolean {
	if (SCOPE_EXEMPT_CODES.has(err.code)) return true;
	const { moduleUuid, formUuid } = err.location;
	if (formUuid !== undefined && moduleUuid !== undefined) {
		return scopeHasForm(scope, moduleUuid, formUuid);
	}
	if (moduleUuid !== undefined) return scopeHasModule(scope, moduleUuid);
	// Unreachable for runner-produced errors (every non-exempt rule anchors
	// a module or form uuid — audited per rule file). Fail OPEN: an error a
	// gate can't attribute must never be silently dropped by a filter.
	return true;
}

/**
 * Run all validation rules on a `BlueprintDoc`.
 * Returns structured errors — `errorToString()` renders a human-readable form.
 *
 * When `options.mediaAssets` is supplied, the asset-context media
 * rules run after the doc-structural rules. They surface only the
 * issues the structural rules can't see (a referenced asset doesn't
 * exist, is still uploading, or its kind doesn't match the slot).
 */
export function runValidation(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
	options?: RunValidationOptions,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const scope = options?.scope;
	const lookupTables = lookupTypeIndex(lookupContext);

	// App rules always run — see SCOPE_EXEMPT_CODES for why.
	for (const rule of APP_RULES) {
		errors.push(...rule(doc));
	}

	const entryPlan = entryPlanContext(doc);
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const inModuleScope = scopeHasModule(scope, moduleUuid);

		// The scope filter restricts WHICH entities are walked — the perf
		// point is skipping the work, not post-filtering its output.
		if (inModuleScope) {
			for (const rule of MODULE_RULES) {
				errors.push(...rule(mod, moduleUuid, doc, lookupTables));
			}
		}

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (!scopeHasForm(scope, moduleUuid, formUuid)) {
				continue;
			}
			errors.push(
				...runFormRules(doc, formUuid, moduleUuid, entryPlan, lookupTables),
			);
			const order = doc.fieldOrder[formUuid] ?? [];
			if (order.length > 0) {
				errors.push(
					...runFieldRules(doc, formUuid, {
						formName: doc.forms[formUuid].name,
						moduleName: mod.name,
						moduleUuid,
						formUuid,
					}),
				);
			}
		}
	}

	// Media asset-context rules — single-arm gate on the options
	// payload. The manifest is the only thing the rules need; its
	// presence both gates the group and provides the data. Deliberately
	// scope-exempt (see SCOPE_EXEMPT_CODES).
	if (options?.mediaAssets) {
		for (const rule of MEDIA_ASSET_RULES) {
			errors.push(...rule(doc, options.mediaAssets));
		}
	}

	const lookupFindings = validateLookupReferences(
		doc,
		lookupContext,
		options?.lookupReferenceExtractors ??
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
	);
	errors.push(...lookupFindings);
	if (lookupFindings.length === 0)
		errors.push(...parentSelectionConflicts(doc, lookupContext));

	errors.push(...runDeepValidation(doc, scope, lookupTables));

	return errors;
}

/**
 * Project the TYPED `DeepValidationError`s from `validateBlueprintDeep` into
 * user-facing `ValidationError`s. A `switch` on the discriminant — every
 * code, location, and surface arrives typed, so there is no prose to parse,
 * no code to re-infer from a message, and no name→uuid lookup to redo. (The
 * muddled cycle message this once produced came entirely from regex-decoding
 * our own error strings: the cycle line matched the general form-label
 * pattern first and got humanized as an XPath label error. With a typed
 * union that whole failure mode is unrepresentable.)
 */
function runDeepValidation(
	doc: BlueprintDoc,
	scope: ValidationScope | undefined,
	lookupTables: import("./lookupTypeContext").LookupTypeIndex,
): ValidationError[] {
	return validateBlueprintDeep(doc, scope, lookupTables).map(
		(deep): ValidationError => {
			switch (deep.kind) {
				case "field-xpath":
					return presentFormLogicFinding(
						doc,
						{ entity: "field", uuid: deep.fieldUuid, slot: deep.surface },
						deep.error,
					);
				case "field-prose":
					if (deep.error.slot !== undefined)
						return presentFormLogicFinding(doc, deep.error.slot, deep.error);
					return validationError(
						deep.error.code,
						"field",
						humanizeFormLogicFinding(
							deep.error,
							`Field "${deep.fieldId}" in "${deep.formName}" (${PROSE_SURFACE_LABELS[deep.surface]})`,
						),
						{
							moduleUuid: deep.moduleUuid,
							moduleName: deep.moduleName,
							formUuid: deep.formUuid,
							formName: deep.formName,
							fieldUuid: deep.fieldUuid,
							fieldId: deep.fieldId,
							field: deep.surface,
						},
					);

				case "connect-xpath":
					return presentFormLogicFinding(
						doc,
						{ entity: "form", uuid: deep.formUuid, slot: deep.slot },
						deep.error,
					);
				case "form-link-xpath": {
					const link = doc.forms[deep.formUuid].formLinks?.[deep.indices[0]];
					if (link === undefined)
						throw new Error("A form-link finding lost its owning link.");
					if (deep.slot === "form_link_condition")
						return presentFormLogicFinding(
							doc,
							{
								entity: "form",
								uuid: deep.formUuid,
								slot: deep.slot,
								member: { linkUuid: link.uuid },
							},
							deep.error,
						);
					const datum = link.datums?.[deep.indices[1]];
					if (datum === undefined)
						throw new Error("A form-link finding lost its owning datum.");
					return presentFormLogicFinding(
						doc,
						{
							entity: "form",
							uuid: deep.formUuid,
							slot: deep.slot,
							member: { linkUuid: link.uuid, datum: datum.name },
						},
						deep.error,
					);
				}
				case "cycle": {
					/* The loop, one edge per sentence. Each consecutive pair in
					 * `cycle` is one dependency edge (the later node depends on the
					 * earlier one), so the reading names the authored reference on
					 * every edge that has one. The edge a container's relevance
					 * cascade draws has NO authored reference: the device
					 * re-evaluates everything inside a group or repeat when its
					 * display condition changes, so that step is named by its
					 * containment instead of sending the author hunting for a
					 * reference that is not written anywhere. */
					if (deep.countFeedback !== undefined) {
						return validationError(
							"CYCLE",
							"form",
							`The count for ${deep.countFeedback} depends on rows it creates (${deep.cycle.join(" → ")}). This can keep adding rows during entry. Use a count that is independent of those rows.`,
							{
								moduleUuid: deep.moduleUuid,
								moduleName: deep.moduleName,
								formUuid: deep.formUuid,
								formName: deep.formName,
							},
							{ loop: deep.cycle.join(" → ") },
						);
					}
					const cascade = deep.cascade;
					const steps: string[] = [];
					for (let i = 0; i + 1 < deep.cycle.length; i++) {
						const from = deep.cycle[i];
						const to = deep.cycle[i + 1];
						if (from === undefined || to === undefined) continue;
						steps.push(
							cascade !== undefined &&
								cascade.container === from &&
								cascade.descendant === to
								? `${to} is inside the ${cascade.containerKind} ${from}, so it follows that ${cascade.containerKind}'s display condition`
								: `${to} reads ${from}`,
						);
					}
					const loop = `${steps.join("; ")}.`;
					const explanation =
						cascade === undefined
							? "These field expressions reference each other in a loop, so their values or choices can never settle. Break the cycle by removing one of the references."
							: `Whether the ${cascade.containerKind} ${cascade.container} shows therefore depends on ${cascade.descendant}, a value inside it that its own display condition controls, and CommCare refuses to install a form with this loop. Move ${cascade.descendant} out of the ${cascade.containerKind}, or change one of the references above so nothing inside the ${cascade.containerKind} feeds its display condition.`;
					return validationError(
						"CYCLE",
						"form",
						`"${deep.formName}" in "${deep.moduleName}" has a circular dependency: ${loop} ${explanation}`,
						{
							moduleUuid: deep.moduleUuid,
							moduleName: deep.moduleName,
							formUuid: deep.formUuid,
							formName: deep.formName,
						},
						{
							loop,
							...(cascade !== undefined && {
								container: cascade.container,
								containerKind: cascade.containerKind,
								descendant: cascade.descendant,
							}),
						},
					);
				}

				default: {
					// Exhaustiveness tripwire: if a new `DeepValidationError` kind is
					// added, `deep` is no longer `never` here and this fails to
					// compile — forcing a matching projection above.
					const unreachable: never = deep;
					throw new Error(
						`Unhandled deep validation error: ${JSON.stringify(unreachable)}`,
					);
				}
			}
		},
	);
}

/**
 * User-facing label for each PROSE surface a field can carry. Typed as a
 * total `Record<ProseSurface, …>`, so adding a prose surface to the deep
 * scan forces a label here — the compiler is the reminder.
 */
const PROSE_SURFACE_LABELS: Record<ProseSurface, string> = {
	label: "label",
	hint: "hint",
	help: "help text",
	validate_msg: "validation message",
	option_label: "answer option label",
};

function humanizeFormLogicFinding(
	error: FormLogicFinding,
	where: string,
	_scope: "form" | "session" = "form",
): string {
	return `${where}: ${error.message}`;
}
