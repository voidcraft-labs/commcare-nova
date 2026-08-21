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

import { parseXPathExpressionWithIssues } from "@/lib/commcare/xpath";
import {
	type BlueprintDoc,
	CONNECT_XPATH_SLOT_IDS,
	type ConnectXPathSlotId,
	caseRefAcceptMap,
	expressionSurfaceReads,
	type Field,
	type FieldProseSlotId,
	type FieldXPathSlotId,
	FORM_LINK_XPATH_SLOT_IDS,
	type FormLinkXPathSlotId,
	fieldPathResolver,
	fieldRegistry,
	formExpressionSource,
	formExpressionSourceEntries,
	formExpressionValue,
	isConnectLearnConfig,
	type ProseTemplate,
	projectXPath,
	reachableCaseTypes,
	toReachableIndex,
	type Uuid,
	type XPathExpression,
	xpathPrintContext,
} from "@/lib/domain";
import {
	buildFieldTree,
	type FieldTreeNode,
} from "@/lib/preview/engine/fieldTree";
import { TriggerDag } from "@/lib/preview/engine/triggerDag";
import { proseTemplateSurvivesTiptapRoundTrip } from "@/lib/tiptap/proseTemplateCodec";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import {
	checkCaseHashtag,
	SESSION_FORM_READ_MESSAGE,
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

/** Form-link XPath carriers — condition and per-datum XPath. */
export type FormLinkXPathSlot = FormLinkXPathSlotId;

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
 * A validation scope — which entities a scoped diagnostic run walks. App-level rules
 * always run regardless of scope (they're cheap and their findings are
 * app-anchored); module rules run for modules in `moduleUuids`; form-level
 * work (form rules, field rules, deep XPath validation) runs for every form
 * of an in-scope module plus every form named directly in `formUuids`.
 *
 * An ABSENT scope means a full run. A PRESENT scope with empty/absent sets
 * is meaningful — it runs app rules only (e.g. a pure module reorder, which
 * can't change any module/form-level finding).
 *
 * The commit gate never supplies this option; it always validates the complete
 * candidate. The scoped-run ≡ full-run-filtered law is documented at
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
 *   - `cycle` — a dependency cycle among authored field expressions in one
 *     form, including defaults and lookup-choice filters.
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
	| (DeepLocation & {
			kind: "form-link-xpath";
			slot: FormLinkXPathSlot;
			indices: readonly number[];
			/** The link the slot belongs to; absent only when the index is stale. */
			linkUuid?: Uuid;
			error: XPathError;
	  })
	| (DeepLocation & { kind: "cycle"; cycle: readonly string[] });

/**
 * Classify an INVALID_REF whose identity leaf no longer resolves, so the
 * runner can render the repair that actually fixes it
 * (`XPathError.storedRef`). A dangling identity has an internal diagnostic
 * projection using its bare uuid (`#form/<uuid>` / `/data/<uuid>`) —
 * `"dangling-identity"`:
 *     the printed text is an internal id, not a path a person can look
 *     up, so the runner must not present it as one.
 *
 * A failing ref matching neither keeps the generic prose. The dangling
 * check needs no doc resolution: a resolved leaf prints its current path,
 * so a bare UUID spelling exists exactly when resolution failed.
 */
function classifyStoredRef(
	expr: XPathExpression | undefined,
	failingRef: string | undefined,
): "dangling-identity" | undefined {
	if (expr === undefined || failingRef === undefined) return undefined;
	for (const part of expr.parts) {
		if (part.kind === "field-ref" || part.kind === "path-ref") {
			if (
				failingRef === `/data/${part.uuid}` ||
				failingRef === `#form/${part.uuid}`
			) {
				return "dangling-identity";
			}
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

/** A session-scoped slot (an after-submit link) has no form paths to read. */
const SESSION_VALID_PATHS: Set<string> = new Set();

function canonicalXPathError(
	doc: BlueprintDoc,
	formUuid: Uuid,
	text: string,
	expr: XPathExpression | undefined,
	validPaths: ReadonlySet<string>,
): XPathError | undefined {
	if (expr === undefined) {
		return {
			code: "INVALID_REF",
			message: "This expression is not stored as Nova's canonical XPath AST.",
		};
	}
	const projection = projectXPath(expr, xpathPrintContext(doc));
	if (!projection.ok) {
		const danglingField = projection.unresolved.some(
			(part) => part.kind === "field-ref" || part.kind === "path-ref",
		);
		return {
			code: "INVALID_REF",
			message: "An identity-backed reference no longer resolves in this app.",
			...(danglingField && { storedRef: "dangling-identity" as const }),
		};
	}
	const userProperties = Object.values(doc.userProperties ?? {});
	const parsed = parseXPathExpressionWithIssues(
		text,
		fieldPathResolver(doc, formUuid),
		(slug) => {
			const matches = userProperties.filter(
				(property) => property?.slug === slug,
			);
			return matches.length === 1 ? matches[0]?.uuid : undefined;
		},
	);
	/**
	 * Connect injects wrapper/session nodes that are real `/data/...` paths on
	 * the emitted form but are not Nova-owned field entities. Their external
	 * wire name is therefore the identity: there is deliberately no UUID leaf
	 * to store. Admit only an exact path already present in this form's
	 * validator-owned path catalog. Ordinary field paths never reach this arm
	 * because the form resolver turns them into `field-ref` / `path-ref`
	 * identities first.
	 */
	const externalPath = (source: string): string | undefined =>
		source.startsWith("/data/")
			? source
			: source.startsWith("#form/")
				? `/data/${source.slice("#form/".length)}`
				: undefined;
	const issue = parsed.issues.find((candidate) => {
		if (candidate.kind !== "unresolved-reference") return true;
		const path = externalPath(candidate.source);
		return path === undefined || !validPaths.has(path);
	});
	if (issue !== undefined) {
		const ref =
			issue.kind === "unresolved-reference"
				? externalPath(issue.source)
				: undefined;
		const leaf = ref?.slice(ref.lastIndexOf("/") + 1);
		const suggestions =
			ref === undefined || leaf === undefined
				? []
				: [...validPaths]
						.filter(
							(path) =>
								path !== ref && path.slice(path.lastIndexOf("/") + 1) === leaf,
						)
						.sort();
		return {
			code: issue.kind === "syntax" ? "XPATH_SYNTAX" : "INVALID_REF",
			message:
				issue.kind === "syntax"
					? `Syntax error near "${issue.source}"`
					: `Reference "${issue.source}" must resolve to one canonical identity in this form.`,
			position: issue.from,
			...(ref !== undefined && { ref }),
			...(suggestions.length > 0 && { suggestions }),
		};
	}
	// AST identity is structural: mutation admission re-serializes stored
	// values with sorted object keys, so the stored part and the freshly
	// parsed part may spell the same identity in different key orders
	// (`case-ref` is the one XPath arm whose sorted order differs from its
	// schema order). Both sides canonicalize before comparison; the printed
	// TEXT comparison below stays byte-exact.
	if (
		canonicalJsonText(parsed.expression) !== canonicalJsonText(expr) ||
		projectXPath(parsed.expression, xpathPrintContext(doc)).text !== text
	) {
		return {
			code: "INVALID_REF",
			message:
				"This expression does not survive Nova's canonical identity parse and print round trip.",
		};
	}
	return undefined;
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

function collectTreeFieldUuids(nodes: readonly FieldTreeNode[]): Set<Uuid> {
	const uuids = new Set<Uuid>();
	const visit = (entries: readonly FieldTreeNode[]) => {
		for (const node of entries) {
			uuids.add(node.field.uuid);
			if (node.children) visit(node.children);
		}
	};
	visit(nodes);
	return uuids;
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
			? toReachableIndex(
					reachableCaseTypes(mod.caseType, doc.caseTypes ?? []),
					doc,
				)
			: undefined;

		for (const formUuid of scopedForms) {
			const form = doc.forms[formUuid];
			const tree = buildFieldTree(formUuid, doc.fields, doc.fieldOrder);

			// Mirror `caseTypePropsForValidation`'s form-type-narrowing rule:
			// a registration form exposes only the own type's `case_id`, a survey
			// form exposes nothing (it loads no case), and followup / close forms
			// expose each reachable type's full property set.
			const isRegistrationForm = form.type === "registration";
			const caseTypeProps = caseTypeIndex
				? caseRefAcceptMap(caseTypeIndex, form.type)
				: undefined;
			const sessionCaseTypeProps = caseTypeIndex
				? caseRefAcceptMap(caseTypeIndex, form.type, "session")
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
			const validFieldUuids = collectTreeFieldUuids(tree);

			// The form's complete Connect config, only when the app is in
			// Connect mode.
			const connect = doc.connectType ? form.connect : undefined;

			// Expose Connect data paths so XPath expressions can reference them.
			if (connect) {
				if (isConnectLearnConfig(connect)) {
					if (connect.learn_module) {
						validPaths.add(`/data/${connect.learn_module.id}`);
					}
					if (connect.assessment) {
						validPaths.add(
							`/data/${connect.assessment.id}/assessment/user_score`,
						);
					}
				} else {
					if (connect.deliver_unit) {
						const duId = connect.deliver_unit.id;
						validPaths.add(`/data/${duId}/deliver/entity_id`);
						validPaths.add(`/data/${duId}/deliver/entity_name`);
					}
					if (connect.task) {
						validPaths.add(`/data/${connect.task.id}`);
					}
				}
			}

			// Form-link condition and datum XPath are canonical authored carriers
			// just like field and Connect expressions. They fan out over arrays,
			// so preserve their indices for an actionable form-level finding.
			for (const slot of FORM_LINK_XPATH_SLOT_IDS) {
				for (const read of formExpressionSourceEntries(form, slot, doc)) {
					const linkUuid = form.formLinks?.[read.indices[0] ?? -1]?.uuid;
					if (read.text.trim().length === 0) {
						if (slot === "form_link_datum_xpath") {
							errors.push({
								...loc,
								kind: "form-link-xpath",
								slot,
								indices: read.indices,
								...(linkUuid !== undefined && { linkUuid }),
								error: {
									code: "XPATH_SYNTAX",
									message: "A form-link datum XPath must not be empty",
									position: 0,
								},
							});
						}
						continue;
					}
					const formLocalReference = read.expr?.parts.find(
						(part) => part.kind === "field-ref" || part.kind === "path-ref",
					);
					if (formLocalReference !== undefined) {
						errors.push({
							...loc,
							kind: "form-link-xpath",
							slot,
							indices: read.indices,
							...(linkUuid !== undefined && { linkUuid }),
							error: {
								code: "INVALID_REF",
								message: SESSION_FORM_READ_MESSAGE,
							},
						});
						continue;
					}
					const canonicalError = canonicalXPathError(
						doc,
						formUuid,
						read.text,
						read.expr,
						SESSION_VALID_PATHS,
					);
					if (canonicalError !== undefined) {
						errors.push({
							...loc,
							kind: "form-link-xpath",
							slot,
							indices: read.indices,
							...(linkUuid !== undefined && { linkUuid }),
							error: canonicalError,
						});
						continue;
					}
					// Session scope: no form paths, no context node, and the
					// accept set of a link (a registration form's new case exists
					// by the time its links run, so no narrowing applies there).
					for (const error of validateXPath(
						read.text,
						SESSION_VALID_PATHS,
						sessionCaseTypeProps,
						false,
						"session",
					)) {
						errors.push({
							...loc,
							kind: "form-link-xpath",
							slot,
							indices: read.indices,
							...(linkUuid !== undefined && { linkUuid }),
							error: withStoredRef(error, read.expr),
						});
					}
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
			// live. Field/custom-worker identities are validated even on a
			// survey form; an empty case map simply admits no case refs.
			validateTreeProse(
				doc,
				tree,
				validPaths,
				validFieldUuids,
				caseTypeProps ?? new Map(),
				isRegistrationForm,
				loc,
				errors,
			);

			// Connect-block XPath expressions. The expressions themselves
			// (`user_score`, `entity_id`, `entity_name`) are id-independent, so
			// reading them off the doc via the expression accessor matches the
			// resolved config. Each entry carries a TYPED `ConnectXPathSlot`,
			// not a prose label.
			if (connect) {
				for (const slot of CONNECT_XPATH_SLOT_IDS) {
					const expr = formExpressionValue(form, slot);
					const text =
						expr === undefined
							? formExpressionSource(form, slot, doc)
							: projectXPath(expr, xpathPrintContext(doc)).text;
					if (!text) continue;
					const canonicalError = canonicalXPathError(
						doc,
						formUuid,
						text,
						expr,
						validPaths,
					);
					if (canonicalError !== undefined) {
						errors.push({
							...loc,
							kind: "connect-xpath",
							slot,
							error: canonicalError,
						});
						continue;
					}
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
			// same rose tree we already built. `reportCycles` adds authoring-only
			// default/filter dependencies without changing Preview's incremental
			// runtime DAG. The cycle (a list of field ids) travels structured;
			// the runner formats it.
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
			const canonicalError = canonicalXPathError(
				doc,
				loc.formUuid,
				text,
				expr,
				validPaths,
			);
			if (canonicalError !== undefined) {
				pushFieldError(node.field, slot, withStoredRef(canonicalError, expr));
				continue;
			}
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
 * Recursively validate the typed parts in every canonical prose template.
 * Literal text is inert even when it looks like a hashtag reference.
 */
function validateTreeProse(
	doc: BlueprintDoc,
	nodes: FieldTreeNode[],
	validPaths: Set<string>,
	validFieldUuids: Set<Uuid>,
	caseTypeProps: Map<string, Set<string>>,
	isRegistrationForm: boolean,
	loc: DeepLocation,
	errors: DeepValidationError[],
): void {
	const scan = (
		field: Field,
		surface: ProseSurface,
		template: ProseTemplate | undefined,
	): void => {
		if (!template) return;
		if (!proseTemplateSurvivesTiptapRoundTrip(template)) {
			errors.push({
				...loc,
				kind: "field-prose",
				fieldUuid: field.uuid,
				fieldId: field.id,
				surface,
				error: {
					code: "PROSE_EDITOR_ROUND_TRIP_LOSS",
					message:
						"This text changes when Nova's reference editor reads and writes it",
				},
			});
			return;
		}
		const print = xpathPrintContext(doc);
		for (const [partIndex, part] of template.parts.entries()) {
			let error: XPathError | undefined;
			switch (part.kind) {
				case "text":
					break;
				case "field-ref": {
					const path = print.fieldPathSegments(part.uuid);
					const ref = path ? `/data/${path.join("/")}` : `/data/${part.uuid}`;
					const target = doc.fields[part.uuid];
					if (
						!path ||
						!validPaths.has(ref) ||
						!validFieldUuids.has(part.uuid) ||
						target === undefined ||
						fieldRegistry[target.kind].isStructural
					) {
						error = {
							code: "INVALID_REF",
							message: `Unknown form field reference: ${ref}`,
							position: partIndex,
							ref,
							storedRef: "dangling-identity",
						};
					}
					break;
				}
				case "case-ref": {
					const refText = `#${part.caseType}/${part.property}`;
					const message = checkCaseHashtag(
						refText,
						part.caseType,
						part.property,
						caseTypeProps,
						isRegistrationForm,
						"prose",
					);
					if (message) {
						error = {
							code: "INVALID_CASE_REF",
							message,
							position: partIndex,
						};
					}
					break;
				}
				case "user-property-ref":
					if (doc.userProperties?.[part.userPropertyUuid] === undefined) {
						error = {
							code: "INVALID_REF",
							message: `Unknown worker information reference: ${part.userPropertyUuid}`,
							position: partIndex,
							ref: part.userPropertyUuid,
							storedRef: "dangling-identity",
						};
					}
					break;
				case "user-ref":
					if (
						Object.values(doc.userProperties ?? {}).some(
							(property) =>
								property?.slug.toLowerCase() === part.property.toLowerCase(),
						)
					) {
						error = {
							code: "INVALID_REF",
							message:
								"This worker information name belongs to the app and must use its stable identity-backed reference.",
							position: partIndex,
							ref: `#user/${part.property}`,
						};
					}
					break;
				default: {
					const _exhaustive: never = part;
					break;
				}
			}
			if (error) {
				errors.push({
					...loc,
					kind: "field-prose",
					fieldUuid: field.uuid,
					fieldId: field.id,
					surface,
					error,
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
		for (const { slot, template } of expressionSurfaceReads(
			field,
			"prose",
			doc,
		)) {
			scan(field, slot, template);
		}
		if (node.children) {
			validateTreeProse(
				doc,
				node.children,
				validPaths,
				validFieldUuids,
				caseTypeProps,
				isRegistrationForm,
				loc,
				errors,
			);
		}
	}
}
