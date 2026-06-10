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
	reachableCaseTypes,
	toReachableIndex,
	type Uuid,
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
 * Walk a field subtree (rooted at `parentUuid`) and collect every valid
 * `/data/...` path that XPath expressions may reference. The prefix is
 * extended by each container's `id` as the walk recurses.
 */
export function collectValidPaths(
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
 * Collect case-property names saved to a given case type across the whole
 * app. Walks modules with the target case type AND any parent module whose
 * case type is the parent of the target (child-case creation lives on the
 * parent module's fields via a non-matching `case_property_on`).
 *
 * The per-field filter (`field.case_property_on === caseType`) ensures only
 * properties targeting the requested type are collected, even when walking
 * a parent module whose own fields save to its primary type.
 */
export function collectCaseProperties(
	doc: BlueprintDoc,
	moduleCaseType: string | undefined,
): Set<string> | undefined {
	if (!moduleCaseType) return undefined;
	const props = new Set<string>();

	// Which module caseTypes to walk: the target + its parent (if any).
	const moduleTypes = new Set([moduleCaseType]);
	const ct = doc.caseTypes?.find((c) => c.name === moduleCaseType);
	if (ct?.parent_type) moduleTypes.add(ct.parent_type);

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod.caseType || !moduleTypes.has(mod.caseType)) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			collectFromTree(doc, formUuid, moduleCaseType, props);
		}
	}
	return props.size > 0 ? props : undefined;
}

function collectFromTree(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	moduleCaseType: string,
	props: Set<string>,
): void {
	const order = doc.fieldOrder[parentUuid] ?? [];
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		const casePropertyOf = (field as { case_property_on?: string })
			.case_property_on;
		if (casePropertyOf === moduleCaseType) props.add(field.id);
		if (doc.fieldOrder[uuid] !== undefined) {
			collectFromTree(doc, uuid, moduleCaseType, props);
		}
	}
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
): DeepValidationError[] {
	const errors: DeepValidationError[] = [];

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		// The case types every form in this module can READ (own + ancestors),
		// keyed by name. Built once per module from `doc.caseTypes`; the
		// per-form accept map below narrows it by form type. Reads from the
		// case-type records — the same authoritative source the editor's lint
		// context uses — so authoring and deep validation agree on `#<type>/<prop>`.
		const caseTypeIndex = mod.caseType
			? toReachableIndex(reachableCaseTypes(mod.caseType, doc.caseTypes ?? []))
			: undefined;

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
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
			// the app is in Connect mode). The validator runs on in-progress
			// docs that may not yet have ids filled, so it must NOT route
			// through the emit-time `buildConnectSlugMap` (which asserts ids
			// are present) — it reads `form.connect` and guards each valid-path
			// arm on the id being set. An id-less block simply contributes no
			// valid path; the connect-id format/length rules in `rules/form.ts`
			// and the app-wide `CONNECT_ID_DUPLICATE` rule in `rules/app.ts`
			// carry the authoring signal for a bad or colliding explicit id.
			const connect = doc.connectType ? form.connect : undefined;

			// Expose Connect data paths so XPath expressions can reference them.
			// Each arm gates on the id being present (a wire node only exists
			// once the id is set; an id-less block is filled at the source
			// before export).
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
				validateTreeProse(tree, caseTypeProps, isRegistrationForm, loc, errors);
			}

			// Connect-block XPath expressions. The expressions themselves
			// (`user_score`, `entity_id`, `entity_name`) are id-independent, so
			// reading them off the doc via the expression accessor matches the
			// resolved config. Each entry carries a TYPED `ConnectXPathSlot`,
			// not a prose label.
			if (connect) {
				const connectXPaths: Array<[ConnectXPathSlot, string]> = [];
				for (const slot of CONNECT_XPATH_SLOT_IDS) {
					const expr = formExpressionSource(form, slot);
					if (expr) connectXPaths.push([slot, expr]);
				}
				for (const [slot, expr] of connectXPaths) {
					for (const error of validateXPath(
						expr,
						validPaths,
						caseTypeProps,
						isRegistrationForm,
					)) {
						errors.push({ ...loc, kind: "connect-xpath", slot, error });
					}
				}
			}

			// Cycle detection runs on the engine's `FieldTreeNode` shape — the
			// same rose tree we already built. The cycle (a list of field ids)
			// travels structured; the runner formats it.
			const dag = new TriggerDag();
			for (const cycle of dag.reportCycles(tree)) {
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
		for (const { slot, text } of expressionSurfaceReads(node.field, "xpath")) {
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
				pushFieldError(node.field, slot, error);
			}
		}
		if (node.children) {
			validateTreeXPath(
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
		for (const { slot, text } of expressionSurfaceReads(field, "prose")) {
			scan(field, slot, text);
		}
		if (node.children) {
			validateTreeProse(
				node.children,
				caseTypeProps,
				isRegistrationForm,
				loc,
				errors,
			);
		}
	}
}
