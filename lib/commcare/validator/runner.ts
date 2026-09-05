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

import {
	authoredXPathCarriers,
	xpathCarrierAllowedInstanceIds,
} from "@/lib/commcare/xpath/carriers";
import { analyzeXPathInstanceCompatibility } from "@/lib/commcare/xpath/compatibility";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	type LookupReferenceExtractorRegistry,
	type LookupValidationContext,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, formLinkDestination } from "@/lib/domain";
import type { ValidationError, ValidationErrorCode } from "./errors";
import { validationError } from "./errors";
import {
	type ConnectXPathSlot,
	type FormLinkXPathSlot,
	type ProseSurface,
	scopeHasForm,
	scopeHasModule,
	type ValidationScope,
	validateBlueprintDeep,
	type XPathSurface,
} from "./index";
import { validateLookupReferences } from "./lookupReferences";
import { lookupTypeIndex } from "./lookupTypeContext";
import { APP_RULES } from "./rules/app";
import { runFieldRules } from "./rules/field";
import { runFormRules } from "./rules/form";
import { MEDIA_ASSET_RULES } from "./rules/media";
import { MODULE_RULES } from "./rules/module";
import type { XPathError } from "./xpathValidator";

/** Optional context for a validation run. */
export interface RunValidationOptions {
	/**
	 * Resolved media-asset manifest — every `MediaAssetId` the doc
	 * references that the loader was willing to return, mapped to its
	 * loaded media-asset row. Built by the caller from
	 * `collectAssetRefs(doc)` + `loadAssetsByIds(owner, ...)`. When
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
	"NO_MODULES",
	"EMPTY_APP_NAME",
	"RESERVED_CASE_TYPE_NAME",
	"CASE_PROPERTY_OPTION_VALUE_INVALID",
	"CASE_PROPERTY_XPATH_INCOMPATIBLE",
	"XPATH_INSTANCE_UNAVAILABLE",
	"MISSING_CHILD_CASE_MODULE",
	"FORM_LINK_CIRCULAR",
	"CONNECT_ID_DUPLICATE",
	"CONNECT_NO_PARTICIPATING_FORMS",
	"FIELD_KIND_PROPERTY_TYPE_MISMATCH",
	"FIELD_KIND_WRITERS_DISAGREE",
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
	errors.push(...validateXPathCarrierInstances(doc));

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
			errors.push(...runFormRules(doc, formUuid, moduleUuid, lookupTables));
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

	errors.push(
		...validateLookupReferences(
			doc,
			lookupContext,
			options?.lookupReferenceExtractors ??
				PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		),
	);

	errors.push(...runDeepValidation(doc, scope));

	return errors;
}

/** Raw XPath may name Core's stable structural instances. Lookup expressions
 * remain typed because their wire names are mutable projections, not identity. */
function validateXPathCarrierInstances(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const carrier of authoredXPathCarriers(doc)) {
		for (const finding of analyzeXPathInstanceCompatibility(
			carrier.source,
			carrier.profile,
			xpathCarrierAllowedInstanceIds(carrier.profile),
		)) {
			errors.push(
				validationError(
					"XPATH_INSTANCE_UNAVAILABLE",
					"app",
					`An authored XPath carrier references a secondary instance that this app does not declare. ${finding.detail}`,
					{},
					{
						path: carrier.path,
						slot: carrier.slot,
						profile: carrier.profile,
					},
				),
			);
		}
	}
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
	scope?: ValidationScope,
): ValidationError[] {
	return validateBlueprintDeep(doc, scope).map((deep): ValidationError => {
		switch (deep.kind) {
			case "field-xpath":
				return validationError(
					deep.error.code,
					"field",
					humanizeXPathError(
						deep.error,
						`Field "${deep.fieldId}" in "${deep.formName}" (${SURFACE_LABELS[deep.surface]})`,
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

			case "field-prose":
				return validationError(
					deep.error.code,
					"field",
					humanizeXPathError(
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
				return validationError(
					deep.error.code,
					"form",
					humanizeXPathError(
						deep.error,
						`"${deep.formName}" in "${deep.moduleName}" (${CONNECT_SLOT_LABELS[deep.slot]})`,
					),
					{
						moduleUuid: deep.moduleUuid,
						moduleName: deep.moduleName,
						formUuid: deep.formUuid,
						formName: deep.formName,
					},
				);

			case "form-link-xpath": {
				// Name the link by where it goes — "the link to “Visit”" is
				// something a person can find; "form link 3" is not once links
				// are reordered. Position is the fallback for a dangling target.
				const linkNumber = (deep.indices[0] ?? 0) + 1;
				const datumNumber = (deep.indices[1] ?? 0) + 1;
				const link =
					deep.linkUuid === undefined
						? undefined
						: doc.forms[deep.formUuid]?.formLinks?.find(
								(candidate) => candidate.uuid === deep.linkUuid,
							);
				const destination =
					link === undefined
						? undefined
						: formLinkDestination(doc, link.target);
				const linkLabel =
					destination === undefined
						? `form link ${linkNumber}`
						: destination.kind === "form"
							? `the link to "${destination.name}"`
							: `the link to the "${destination.name}" module`;
				const carrier =
					deep.slot === "form_link_condition"
						? `${linkLabel}, ${FORM_LINK_SLOT_LABELS[deep.slot]}`
						: `${linkLabel}, value ${datumNumber} ${FORM_LINK_SLOT_LABELS[deep.slot]}`;
				return validationError(
					deep.error.code,
					"form",
					humanizeXPathError(
						deep.error,
						`"${deep.formName}" in "${deep.moduleName}" (${carrier})`,
					),
					{
						moduleUuid: deep.moduleUuid,
						moduleName: deep.moduleName,
						formUuid: deep.formUuid,
						formName: deep.formName,
					},
					{
						...(deep.linkUuid !== undefined && { linkUuid: deep.linkUuid }),
						...(destination !== undefined && {
							destination: destination.name,
							destinationKind: destination.kind,
						}),
					},
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
	});
}

/**
 * User-facing label for each XPath surface a field can carry. Typed as a
 * total `Record<XPathSurface, …>`, so adding a surface to the deep walk
 * forces a label here — the compiler is the reminder.
 */
const SURFACE_LABELS: Record<XPathSurface, string> = {
	relevant: "display condition",
	validate: "validation rule",
	calculate: "calculated value",
	default_value: "default value",
	required: "required condition",
	repeat_count: "repeat count",
	ids_query: "data source query",
};

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

/** User-facing label for each Connect-block XPath slot. */
const CONNECT_SLOT_LABELS: Record<ConnectXPathSlot, string> = {
	assessment_user_score: "Connect assessment user_score",
	deliver_entity_id: "Connect deliver entity_id",
	deliver_entity_name: "Connect deliver entity_name",
};

// Exhaustiveness tripwire for the registry-derived form-link XPath union.
const FORM_LINK_SLOT_LABELS: Record<FormLinkXPathSlot, string> = {
	form_link_condition: "condition",
	form_link_datum_xpath: "XPath",
};

/**
 * Build the "did you mean" clause for an INVALID_REF that has leaf-matched
 * suggestions. The validator resolves field paths as `/data/...`; the SA
 * authors them as `#form/...`, so we present the suggestions in that
 * vocabulary — directly copy-pasteable. One match reads as a single
 * suggestion; several (cousins sharing a leaf id across groups) list all so
 * the SA picks the right one. Returns `undefined` when there's nothing to
 * suggest, so the caller falls back to the generic typo guidance.
 */
function suggestionHint(
	suggestions: readonly string[] | undefined,
): string | undefined {
	if (!suggestions || suggestions.length === 0) return undefined;
	const formPaths = suggestions.map(
		(p) => `\`#form/${p.replace(/^\/data\//, "")}\``,
	);
	if (formPaths.length === 1) {
		return `A field with that id exists at ${formPaths[0]}. Did you mean that? A \`#form/...\` reference must include every group the field is nested in, not just the field's id.`;
	}
	return `Fields with that id exist at ${formPaths.join(", ")}. Did you mean one of these? A \`#form/...\` reference must include every group the field is nested in, not just the field's id.`;
}

/**
 * Render a typed `XPathError` into a helpful, human-friendly message.
 * Dispatch is on the typed `code` — never on parsing `error.message`. The
 * terse `error.message` already carries the specific identifier (the bad
 * path, the unknown function name), so embedding it as the detail keeps the
 * message specific without re-extracting anything. `where` is the
 * caller-built location prefix (`Field "x" in "Form" (display condition)`).
 */
function humanizeXPathError(error: XPathError, where: string): string {
	switch (error.code) {
		case "XPATH_SYNTAX":
			return `${where} has a syntax error: ${error.message}. Check for unbalanced parentheses, missing operators, or stray characters.`;

		case "XPATH_UNBOUND_VARIABLE":
		case "XPATH_UNSUPPORTED_UNION":
		case "XPATH_UNSUPPORTED_DESCENDANT":
		case "XPATH_UNSUPPORTED_FILTER":
		case "XPATH_UNSUPPORTED_AXIS":
		case "XPATH_UNSUPPORTED_NODE_TEST":
		case "XPATH_UNSUPPORTED_PATH":
			return `${where} uses XPath that CommCare cannot run: ${error.message}`;

		case "XPATH_CARRIER_CONTEXT_UNAVAILABLE":
			return `${where} depends on an XPath context that isn't available after the form closes: ${error.message}`;

		case "XPATH_FUNCTION_UNAVAILABLE":
		case "XPATH_FUNCTION_SIGNATURE_UNAVAILABLE":
		case "XPATH_FUNCTION_CONTEXT_UNAVAILABLE":
			return `${where} uses XPath that Nova Preview cannot run faithfully: ${error.message}`;

		case "UNKNOWN_FUNCTION":
			return `${where} calls a function that isn't a recognized CommCare function: ${error.message}. Function names are case-sensitive. Check for a typo or the wrong case.`;

		case "WRONG_ARITY":
			return `${where} calls a function with the wrong number of arguments: ${error.message}.`;

		case "INVALID_REF": {
			// The slot's stored shape changes what the repair IS — see
			// `XPathError.storedRef`. A dangling identity reference must not
			// present its printed text as a path: the text is the internal id
			// of a field that's gone, not something a person can look up, so
			// the message names the carrier and slot (`where`) instead.
			if (error.storedRef === "dangling-identity") {
				return `${where} references a field that no longer exists in this form. The expression tracks the exact field it pointed at, and that field is gone. If this change is what removes it, the expression has to let go of it first. Edit that expression to drop the reference or point it at an existing field, then retry this change.`;
			}
			// When an existing field shares the unknown ref's leaf id, the SA
			// almost certainly wrote the bare id and dropped the field's group
			// path — point at the real path(s) in the SA's own `#form/...`
			// vocabulary (the validator resolved them as `/data/...`). This is
			// the dominant authoring mistake: `#form/consent` for a field that
			// lives at `#form/consent_grp/consent`.
			const hint = suggestionHint(error.suggestions);
			if (hint) {
				return `${where} has a reference that doesn't exist in this form: ${error.message}. ${hint}`;
			}
			return `${where} has a reference that doesn't exist in this form: ${error.message}. Check for a typo in the field id, or whether the field was renamed or removed.`;
		}

		case "INVALID_CASE_REF":
			return `${where} references a case property that doesn't exist on this case type: ${error.message}. Check for a typo, or make sure a field's case destination saves to that property.`;

		case "INVALID_SEARCH_REF":
			return `${where} ${error.message}`;

		case "PROSE_EDITOR_ROUND_TRIP_LOSS":
			return `${where} contains text or a reference that Nova's editor cannot preserve. Rewrite this text using plain text and supported reference parts.`;

		case "TYPE_ERROR":
			return `${where} has a type mismatch: ${error.message}. This will likely produce unexpected results at runtime.`;
	}
}
