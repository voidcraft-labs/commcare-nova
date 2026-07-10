/**
 * Deep XPath validation — Lezer-based syntax, semantics, and reference checking.
 *
 * Operates directly on the normalized `BlueprintDoc`. Validates every XPath
 * expression on every field via a Lezer tree walk (syntax + semantics),
 * detects dependency cycles, and checks case-property references.
 *
 * Called by `runner.ts`, which maps the TYPED `DeepValidationError` union
 * below into the user-facing `ValidationError` shape. The two modules share
 * a typed contract — there is no prose serialization between them, so the
 * runner never re-parses a message to recover a code, a location, or which
 * surface failed.
 */

import {
	type BlueprintDoc,
	CONNECT_XPATH_SLOT_IDS,
	type ConnectXPathSlotId,
	caseRefAcceptMap,
	expressionSurfaceReads,
	type Field,
	type FieldProseSlotId,
	type FieldXPathSlotId,
	formExpressionSource,
	formExpressionValue,
	reachableCaseTypes,
	toReachableIndex,
	type Uuid,
	type XPathExpression,
} from "@/lib/domain";
import {
	buildFieldTree,
	type FieldTreeNode,
} from "@/lib/preview/engine/fieldTree";
import { TriggerDag } from "@/lib/preview/engine/triggerDag";
import { BARE_HASHTAG_PATTERN } from "../proseHashtags";
import {
	checkCaseHashtag,
	validateXPath,
	type XPathError,
} from "./xpathValidator";

/**
 * The XPath-bearing surfaces deep validation walks on a field — the
 * reference-slot registry's xpath projection, which the walk iterates via
 * `expressionSurfaceReads`. Each maps to a user-facing label at render time
 * (`runner.ts::SURFACE_LABELS`). Keeping this a closed union (not a bare
 * string) means a new registry slot can't enter the walk without the runner
 * being forced to give it a label.
 */
export type XPathSurface = FieldXPathSlotId;

/**
 * The Connect-block XPath slots (Connect mode only) — the registry's
 * `connect.*` form-slot projection. A closed union for the same reason as
 * `XPathSurface`: the runner owns the display label.
 */
export type ConnectXPathSlot = ConnectXPathSlotId;

/**
 * The PROSE surfaces deep validation scans for embedded `#<type>/<prop>`
 * hashtag refs — the registry's prose projection. These aren't XPath —
 * they're natural-language label / hint / help / validate-error text (plus
 * per-option labels on selects) that lower their inline hashtags to
 * `<output value>` at emit. A closed union for the same reason as
 * `XPathSurface`: the runner owns the display label.
 */
export type ProseSurface = FieldProseSlotId;

/**
 * A validation scope — which entities a scoped run walks. App-level rules
 * always run regardless of scope (they're cheap and their findings are
 * app-anchored); module rules run for modules in `moduleUuids`; form-level
 * work (form rules, field rules, deep XPath validation) runs for every form
 * of an in-scope module plus every form named directly in `formUuids`.
 *
 * An ABSENT scope means a full run. A PRESENT scope with empty/absent sets
 * is meaningful — it runs app rules only (e.g. a pure module reorder, which
 * can't change any module/form-level finding).
 *
 * Scopes are derived from mutation batches by `scopeOfMutations`; the
 * scoped-run ≡ full-run-filtered law is documented at
 * `runner.ts::errorWithinScope` and property-tested.
 */
export interface ValidationScope {
	readonly moduleUuids?: ReadonlySet<Uuid>;
	readonly formUuids?: ReadonlySet<Uuid>;
}

/** Whether a scope (or no scope) admits the module's module-level rules. */
export function scopeHasModule(
	scope: ValidationScope | undefined,
	moduleUuid: Uuid,
): boolean {
	return scope === undefined || (scope.moduleUuids?.has(moduleUuid) ?? false);
}

/**
 * Whether a scope (or no scope) admits a form's form-level work. A form is
 * in scope when its module is (module scope covers the module's whole
 * subtree) or when the form is named directly.
 */
export function scopeHasForm(
	scope: ValidationScope | undefined,
	moduleUuid: Uuid,
	formUuid: Uuid,
): boolean {
	return (
		scopeHasModule(scope, moduleUuid) ||
		(scope?.formUuids?.has(formUuid) ?? false)
	);
}

/**
 * The location every deep error carries — resolved DURING the walk from the
 * uuid-indexed doc, never re-derived afterward by matching a name. Both the
 * module/form uuids AND their display names travel together so the runner
 * needs no second lookup.
 */
interface DeepLocation {
	moduleUuid: Uuid;
	moduleName: string;
	formUuid: Uuid;
	formName: string;
}

/**
 * A single deep-validation finding, fully typed. Three shapes:
 *   - `field-xpath` — an XPath error on a specific field surface; carries the
 *     field's uuid + id, the `surface`, and the underlying typed `XPathError`.
 *   - `connect-xpath` — an XPath error in a Connect-block slot.
 *   - `cycle` — a dependency cycle among calculated fields in one form.
 * The runner switches on `kind` and projects each into a `ValidationError`.
 */
export type DeepValidationError =
	| (DeepLocation & {
			kind: "field-xpath";
			fieldUuid: Uuid;
			fieldId: string;
			surface: XPathSurface;
			error: XPathError;
	  })
	| (DeepLocation & {
			kind: "field-prose";
			fieldUuid: Uuid;
			fieldId: string;
			surface: ProseSurface;
			error: XPathError;
	  })
	| (DeepLocation & {
			kind: "connect-xpath";
			slot: ConnectXPathSlot;
			error: XPathError;
	  })
	| (DeepLocation & { kind: "cycle"; cycle: readonly string[] });

/**
 * Classify how an INVALID_REF's failing `/data/...` reference is STORED
 * in the slot's expression AST, so the runner can render the repair that
 * actually fixes it (`XPathError.storedRef`). The match is exact against
 * each leaf's printed expansion:
 *
 *   - a raw `#form/...` leaf (plain text the migration could not
 *     re-resolve) expands to `/data/<segments>` — `"raw-text"`: the
 *     reference doesn't follow its field through renames, and
 *     re-committing the expression is the repair;
 *   - an identity leaf whose target no longer resolves prints the bare
 *     uuid (`#form/<uuid>` / `/data/<uuid>` — the printer's total
 *     fallback), expanding to `/data/<uuid>` — `"dangling-identity"`:
 *     the printed text is an internal id, not a path a person can look
 *     up, so the runner must not present it as one.
 *
 * A failing ref matching neither (a typo'd reference, a cross-form
 * path) classifies as `undefined` and keeps the generic prose. The
 * dangling check needs no doc resolution: a RESOLVED leaf prints its
 * segments, so the bare-uuid expansion exists exactly when resolution
 * failed.
 */
function classifyStoredRef(
	expr: XPathExpression | undefined,
	failingRef: string | undefined,
): "raw-text" | "dangling-identity" | undefined {
	if (expr === undefined || failingRef === undefined) return undefined;
	for (const part of expr.parts) {
		if (part.kind === "raw-ref" && part.namespace === "form") {
			if (failingRef === `/data/${part.segments.join("/")}`) {
				return "raw-text";
			}
		}
		if (part.kind === "field-ref" || part.kind === "path-ref") {
			if (failingRef === `/data/${part.uuid}`) return "dangling-identity";
		}
	}
	return undefined;
}

/** Stamp `storedRef` onto an INVALID_REF the slot's stored AST can
 *  explain; every other error passes through untouched. */
function withStoredRef(
	error: XPathError,
	expr: XPathExpression | undefined,
): XPathError {
	if (error.code !== "INVALID_REF") return error;
	const storedRef = classifyStoredRef(expr, error.ref);
	return storedRef === undefined ? error : { ...error, storedRef };
}

/**
 * Walk a field subtree (rooted at `parentUuid`) and collect every valid
 * `/data/...` path that XPath expressions may reference. The prefix is
 * extended by each container's `id` as the walk recurses.
 */
function collectValidPaths(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	prefix = "/data",
): Set<string> {
	const paths = new Set<string>();
	const order = doc.fieldOrder[parentUuid] ?? [];
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		const path = `${prefix}/${field.id}`;
		paths.add(path);
		// Container kinds (group, repeat) carry a fieldOrder entry — recurse
		// under their semantic `id` segment.
		if (doc.fieldOrder[uuid] !== undefined) {
			for (const p of collectValidPaths(doc, uuid, path)) paths.add(p);
		}
	}
	return paths;
}

/**
 * Deep validation: walks every form, builds the valid path set + per-case-type
 * accept map per form, validates every XPath expression, and runs cycle
 * detection via `TriggerDag`. Returns a flat array of TYPED
 * `DeepValidationError`s — `runner.ts` projects each into the user-facing
 * `ValidationError` shape by switching on `kind`, never by parsing prose.
 */
export function validateBlueprintDeep(
	doc: BlueprintDoc,
	scope?: ValidationScope,
): DeepValidationError[] {
	const errors: DeepValidationError[] = [];

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		// Scope filter — restrict WHICH forms are walked, never post-filter
		// findings (the deep walk's Lezer parses are the expensive part, so
		// skipping the walk is the point). A module fully in scope walks all
		// its forms; otherwise only the directly-named forms are walked.
		const allForms = doc.formOrder[moduleUuid] ?? [];
		const scopedForms = scopeHasModule(scope, moduleUuid)
			? allForms
			: allForms.filter((formUuid) => scope?.formUuids?.has(formUuid) ?? false);
		if (scopedForms.length === 0) continue;

		// The case types every form in this module can READ (own + ancestors),
		// keyed by name. Built once per module from `doc.caseTypes`; the
		// per-form accept map below narrows it by form type. Reads from the
		// case-type records — the same authoritative source the editor's lint
		// context uses — so authoring and deep validation agree on `#<type>/<prop>`.
		const caseTypeIndex = mod.caseType
			? toReachableIndex(reachableCaseTypes(mod.caseType, doc.caseTypes ?? []))
			: undefined;

		for (const formUuid of scopedForms) {
			const form = doc.forms[formUuid];
			const tree = buildFieldTree(formUuid, doc.fields, doc.fieldOrder);
			if (tree.length === 0) continue;

			// Mirror `caseTypePropsForValidation`'s form-type-narrowing rule:
			// a registration form exposes only the own type's `case_id`, a survey
			// form exposes nothing (it loads no case), and followup / close forms
			// expose each reachable type's full property set.
			const isRegistrationForm = form.type === "registration";
			const caseTypeProps = caseTypeIndex
				? caseRefAcceptMap(caseTypeIndex, form.type)
				: undefined;

			// The uuid-anchored location every finding in this form carries.
			// Built once here from the indices we're already iterating, so no
			// downstream code re-resolves a uuid from a name.
			const loc: DeepLocation = {
				moduleUuid,
				moduleName: mod.name,
				formUuid,
				formName: form.name,
			};

			const validPaths = collectValidPaths(doc, formUuid);

			// The form's connect config, read directly from the doc (only when
			// the app is in Connect mode). The validator runs on docs that may
			// carry an id-less block (a doc that skipped the source
			// enforcement), so it must NOT route through the emit-time
			// `buildConnectSlugMap` (which THROWS on a missing id) — it reads
			// `form.connect` and guards each valid-path arm on the id being
			// set. An id-less block simply contributes no valid path; the
			// connect-id rules in `rules/form.ts` carry the authoring signal
			// (`CONNECT_ID_MISSING` for the unset id itself, format/length for
			// a bad explicit one) and the app-wide `CONNECT_ID_DUPLICATE` rule
			// in `rules/app.ts` covers collisions.
			const connect = doc.connectType ? form.connect : undefined;

			// Expose Connect data paths so XPath expressions can reference them.
			// Each arm gates on the id being present — a wire node only exists
			// once the id is set.
			if (connect) {
				if (connect.learn_module?.id) {
					validPaths.add(`/data/${connect.learn_module.id}`);
				}
				if (connect.assessment?.id) {
					validPaths.add(
						`/data/${connect.assessment.id}/assessment/user_score`,
					);
				}
				if (connect.deliver_unit?.id) {
					const duId = connect.deliver_unit.id;
					validPaths.add(`/data/${duId}/deliver/entity_id`);
					validPaths.add(`/data/${duId}/deliver/entity_name`);
				}
				if (connect.task?.id) {
					// Wrapper-only bind, like learn_module — the XForm emits
					// `<bind nodeset="/data/<taskId>"/>` with no child paths.
					validPaths.add(`/data/${connect.task.id}`);
				}
			}

			// Per-field XPath validation — recursive walk over the tree.
			validateTreeXPath(
				doc,
				tree,
				validPaths,
				caseTypeProps,
				isRegistrationForm,
				loc,
				errors,
			);

			// Per-field PROSE validation — the deep validator's XPath walk
			// never visits label / hint / help / validate_msg / option
			// labels, so an unreachable or typo'd `#<type>/<prop>` ref in
			// prose (`#mothre/code`, a child-type `#child/name`) ships
			// unflagged — the emitter correctly leaves it as literal text
			// (no wire break), but the author gets no signal. Reuse the SAME
			// per-form accept map and `checkCaseHashtag` rule the XPath pass
			// uses, so prose and XPath can never disagree on which refs are
			// live. Skipped when the form has no reachable case type.
			if (caseTypeProps) {
				validateTreeProse(
					doc,
					tree,
					caseTypeProps,
					isRegistrationForm,
					loc,
					errors,
				);
			}

			// Connect-block XPath expressions. The expressions themselves
			// (`user_score`, `entity_id`, `entity_name`) are id-independent, so
			// reading them off the doc via the expression accessor matches the
			// resolved config. Each entry carries a TYPED `ConnectXPathSlot`,
			// not a prose label.
			if (connect) {
				for (const slot of CONNECT_XPATH_SLOT_IDS) {
					const text = formExpressionSource(form, slot, doc);
					if (!text) continue;
					const expr = formExpressionValue(form, slot);
					for (const error of validateXPath(
						text,
						validPaths,
						caseTypeProps,
						isRegistrationForm,
					)) {
						errors.push({
							...loc,
							kind: "connect-xpath",
							slot,
							error: withStoredRef(error, expr),
						});
					}
				}
			}

			// Cycle detection runs on the engine's `FieldTreeNode` shape — the
			// same rose tree we already built. The cycle (a list of field ids)
			// travels structured; the runner formats it.
			const dag = new TriggerDag();
			for (const cycle of dag.reportCycles(tree, doc)) {
				errors.push({ ...loc, kind: "cycle", cycle });
			}
		}
	}

	return errors;
}

/**
 * Recursively validate every XPath expression on every field in the
 * provided rose tree, pushing a TYPED `field-xpath` `DeepValidationError`
 * per finding — the field's uuid + id, which `surface` failed, and the
 * underlying `XPathError` all travel structured to the runner.
 */
function validateTreeXPath(
	doc: BlueprintDoc,
	nodes: FieldTreeNode[],
	validPaths: Set<string>,
	caseTypeProps: Map<string, Set<string>> | undefined,
	isRegistrationForm: boolean,
	loc: DeepLocation,
	errors: DeepValidationError[],
): void {
	// Small helper so every push site reads the same: the surface + the
	// field identity are the only things that vary per call.
	const pushFieldError = (
		field: Field,
		surface: XPathSurface,
		error: XPathError,
	): void => {
		errors.push({
			...loc,
			kind: "field-xpath",
			fieldUuid: field.uuid,
			fieldId: field.id,
			surface,
			error,
		});
	};

	for (const node of nodes) {
		// The registry's per-kind xpath projection (narrowed by
		// `repeat_mode` for repeats) drives the walk, so a new
		// expression-bearing slot enters validation by being registered,
		// never by extending a hand-rolled key list here.
		for (const { slot, text, expr } of expressionSurfaceReads(
			node.field,
			"xpath",
			doc,
		)) {
			// Blank-skip policy is per slot: empty `repeat_count` /
			// `ids_query` values (including whitespace-only — hence trim)
			// are caught by `EMPTY_REPEAT_COUNT` / `EMPTY_IDS_QUERY` at the
			// field-rule layer, so skipping them here avoids
			// double-reporting a single empty value. The flat slots have no
			// empty-rule twin and keep the plain emptiness check.
			const blank =
				slot === "repeat_count" || slot === "ids_query"
					? text.trim().length === 0
					: text.length === 0;
			if (blank) continue;
			for (const error of validateXPath(
				text,
				validPaths,
				caseTypeProps,
				isRegistrationForm,
			)) {
				pushFieldError(node.field, slot, withStoredRef(error, expr));
			}
		}
		if (node.children) {
			validateTreeXPath(
				doc,
				node.children,
				validPaths,
				caseTypeProps,
				isRegistrationForm,
				loc,
				errors,
			);
		}
	}
}

/**
 * Match an embedded Nova hashtag ref inside PROSE using the SAME pattern the
 * XForm builder's lowering pass consumes (`BARE_HASHTAG_PATTERN`), so emission
 * and validation can't drift on what counts as a prose hashtag. Own global
 * instance (the shared pattern carries no `/g`); `/g` is safe with `matchAll`
 * (it clones, never mutating `lastIndex`).
 */
const PROSE_HASHTAG_RE = new RegExp(BARE_HASHTAG_PATTERN, "g");

/**
 * Recursively scan every PROSE surface (label / hint / help / validate_msg +
 * per-option labels) for embedded `#<type>/<prop>` case refs, pushing a TYPED
 * `field-prose` `DeepValidationError` per ref the form can't read. Runs the
 * SAME `checkCaseHashtag` rule against the SAME per-form accept map the XPath
 * pass uses, with the LENIENT `surface: "prose"` policy: a ref is flagged only
 * when its namespace is a reachable case type AND the property is invalid on
 * it. An unreachable / innocent prose token is left alone — exactly as the
 * emitter ships it as literal text (`xform/builder.ts::buildLabelNodes`).
 */
function validateTreeProse(
	doc: BlueprintDoc,
	nodes: FieldTreeNode[],
	caseTypeProps: Map<string, Set<string>>,
	isRegistrationForm: boolean,
	loc: DeepLocation,
	errors: DeepValidationError[],
): void {
	const scan = (
		field: Field,
		surface: ProseSurface,
		text: string | undefined,
	): void => {
		if (!text) return;
		for (const match of text.matchAll(PROSE_HASHTAG_RE)) {
			const refText = match[0];
			const slashIdx = refText.indexOf("/");
			const ns = refText.slice(1, slashIdx);
			const rest = refText.slice(slashIdx + 1);
			const message = checkCaseHashtag(
				refText,
				ns,
				rest,
				caseTypeProps,
				isRegistrationForm,
				"prose",
			);
			if (message) {
				errors.push({
					...loc,
					kind: "field-prose",
					fieldUuid: field.uuid,
					fieldId: field.id,
					surface,
					error: { code: "INVALID_CASE_REF", message, position: match.index },
				});
			}
		}
	};

	for (const node of nodes) {
		const field = node.field;
		// The registry's per-kind prose projection drives the walk —
		// including the fan-out `option_label` slot, whose per-option
		// labels lower to itext just like a field label, so an embedded
		// case ref there must resolve too.
		for (const { slot, text } of expressionSurfaceReads(field, "prose", doc)) {
			scan(field, slot, text);
		}
		if (node.children) {
			validateTreeProse(
				doc,
				node.children,
				caseTypeProps,
				isRegistrationForm,
				loc,
				errors,
			);
		}
	}
}
