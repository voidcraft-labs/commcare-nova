// lib/case-store/form-bridge/deriveFromForm.ts
//
// Pure form-to-case-store-operations derivation.
//
// A completed form in the running-app view implies a set of
// `CaseStore` operations: a registration form creates one or more
// cases, a followup form mutates the bound case (and may create
// child cases), a close form mutates and then closes the bound case,
// and a survey form has no case-store side effect.
//
// This file is the pure half of the form-bridge: it walks the
// blueprint's field tree for a single form, reads runtime values out
// of a `CompletedForm` snapshot, buckets fields by the case type
// they write to, and emits a typed `DerivedFormOps` discriminated
// union per form type. No I/O happens here — the I/O wrapper at
// `./writeThrough.ts` accepts a `CaseStore` and applies the derived
// operations.
//
// ## Why a fresh walk instead of reusing `lib/commcare/deriveCaseConfig`
//
// `lib/commcare/deriveCaseConfig.ts` produces wire-shape
// `DerivedCaseConfig` (CCHQ `OpenSubCaseAction` fodder, with
// `repeat_context` carrying the static repeat ancestor). The runtime
// path needs different output: one explicit `ChildInsertOp` per
// repeat instance, with the per-instance values plugged in. A repeat
// container also forces fanned-out walks (one walk per index) rather
// than a single static descriptor. Walking once at runtime — reading
// `CompletedForm.values` to count instances and to collect typed
// values — keeps the logic single-pass. The `lib/commcare` import
// boundary also restricts which surfaces may consume the build-time
// helper; the form-bridge lives outside that allowlist by design,
// because its concerns (case-store mutation) are orthogonal to the
// CCHQ wire-emission boundary.
//
// ## Field id = case property name
//
// The blueprint convention (see top-level `CLAUDE.md` § Data model)
// is that a field's `id` is the case property name it writes to.
// `case_property_on` names the case TYPE the field writes to. The
// walk uses both: `case_property_on === moduleCaseType` routes the
// value into the primary case's properties; any other value buckets
// the field into a child-case insert keyed by the destination case
// type.
//
// ## How values flow in
//
// `CompletedForm` mirrors `FormEngine.getValueSnapshot()`'s shape: a
// flat `Map<path, string>` keyed by XForm-style paths
// (`/data/<id>`, `/data/<group>/<child>`, `/data/<repeat>[N]/<child>`).
// Strings are coerced to typed JSON values per the bound case
// type's `data_type` declarations before they land in the derived
// op's `properties` JSONB document.

import type {
	BlueprintDoc,
	CaseProperty,
	CasePropertyDataType,
	CaseType,
	Field,
	FormType,
	Uuid,
} from "@/lib/domain";
import { casePropertyDataTypes } from "@/lib/domain";
import type { JsonObject, JsonValue } from "../sql/database";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * Snapshot of a completed form's runtime state, projected into the
 * shape the form-bridge consumes.
 *
 * `values` matches `FormEngine.getValueSnapshot().values`: a flat
 * `Map<XFormPath, string>` keyed by paths the engine maintains
 * (`/data/<id>`, `/data/<group>/<child>`, `/data/<repeat>[N]/<child>`).
 * Every leaf field's value lives at one entry; structural containers
 * (group / repeat) carry no value of their own.
 *
 * `caseId` is the bound case the form operates on. Required for
 * followup and close (the form preview's nav stack carries it through
 * `PreviewScreen.form.caseId`); ignored by registration / survey.
 * The form-bridge surfaces a typed throw when the form type requires
 * a `caseId` and none was supplied — this catches a Plan 7 wiring
 * regression at the boundary rather than at the SQL layer.
 */
export interface CompletedForm {
	/** Flat path → value map (the XForm engine's value shape). */
	readonly values: ReadonlyMap<string, string>;
	/**
	 * The bound case for followup / close forms. Set from the
	 * preview's nav stack; absent for registration / survey.
	 */
	readonly caseId?: string;
}

/**
 * The properties patch one form completion contributes to one case.
 * Plain `JsonObject` because `CaseStore.insert` / `update` accept
 * `JsonObject | string` — the form-bridge always emits the object
 * form (parsed-and-typed) so consumers don't re-parse.
 */
export type DerivedProperties = JsonObject;

/**
 * One child-case insert derived from a single form completion.
 *
 * `parent_case_id` is OPTIONAL. The pure derivation can resolve it
 * for followup / close forms (the bound `caseId` IS the parent), but
 * NOT for registration forms — the parent's `case_id` is generated
 * by Postgres at write time, so the I/O wrapper threads it after
 * the primary insert returns. A `parent_case_id` of `undefined` here
 * means "writeThrough fills this in with the primary case's
 * generated id"; an explicit value means "use this id directly."
 */
export interface ChildInsertOp {
	/** The destination case type (the field's `case_property_on`). */
	readonly caseType: string;
	/** The typed property document for the child case. */
	readonly properties: DerivedProperties;
	/**
	 * The child's parent case id. Absent for registration-driven
	 * children (writeThrough threads the primary's generated id);
	 * set to the bound `caseId` for followup / close.
	 */
	readonly parentCaseId?: string;
}

/**
 * The primary case write a registration form implies.
 *
 * `properties` is the typed JSONB document. Registration ALWAYS
 * creates a case row, so an empty `properties` is still a valid op
 * shape (the resulting case has only the auto-stamped columns) —
 * unlike followup, which short-circuits when `properties` is empty.
 */
export interface PrimaryRegistrationOp {
	/** The case type the form's module owns. */
	readonly caseType: string;
	/** The typed property document for the new case. */
	readonly properties: DerivedProperties;
}

/**
 * The primary case write a followup or close form implies.
 *
 * `properties` MAY be empty: a close form whose only action is
 * setting `closed_on` carries no property writes. The I/O wrapper
 * skips the underlying `update` call when this is empty so an
 * unnecessary round-trip doesn't fire against Postgres.
 */
export interface PrimaryUpdateOp {
	/** The case type for diagnostic surfacing — not written to the row. */
	readonly caseType: string;
	/** Properties the form mutated. Empty when the form had no primary writes. */
	readonly properties: DerivedProperties;
}

/**
 * The full set of `CaseStore` operations one completed form implies.
 * Discriminated by `kind` (matching `FormType`) so consumers can
 * exhaust-switch on the four arms and the type checker forces the
 * caller to reason about the survey arm explicitly.
 */
export type DerivedFormOps =
	| {
			readonly kind: "registration";
			readonly primary: PrimaryRegistrationOp;
			readonly children: ReadonlyArray<ChildInsertOp>;
	  }
	| {
			readonly kind: "followup";
			readonly caseId: string;
			readonly primary: PrimaryUpdateOp;
			readonly children: ReadonlyArray<ChildInsertOp>;
	  }
	| {
			readonly kind: "close";
			readonly caseId: string;
			readonly primary: PrimaryUpdateOp;
			readonly children: ReadonlyArray<ChildInsertOp>;
	  }
	| { readonly kind: "survey" };

/**
 * Arguments to `deriveFromForm`. Threading individual fields rather
 * than the full preview state keeps the function pure: every input
 * is a stable read off the prospective blueprint plus the runtime
 * snapshot, no implicit globals.
 */
export interface DeriveFromFormArgs {
	/** The prospective blueprint state — case type definitions live here. */
	readonly blueprint: BlueprintDoc;
	/** The form whose completion is being projected. */
	readonly formUuid: Uuid;
	/** The form type, read off `blueprint.forms[formUuid].type`. */
	readonly formType: FormType;
	/**
	 * The owning module's case type (the value of `Module.caseType`
	 * for the module whose `formOrder` contains `formUuid`). The
	 * caller resolves this from the blueprint — the form-bridge does
	 * not scan modules itself, because Plan 7's eventual integration
	 * surface already has the module in hand. Passing it in keeps
	 * `deriveFromForm` free of module-scanning logic.
	 *
	 * Optional for survey forms (which have no module case type) and
	 * for forms in modules without a configured case type — the walk
	 * still runs, and any field whose `case_property_on` does not
	 * match buckets into a child case as usual.
	 */
	readonly moduleCaseType?: string;
	/** The runtime snapshot of values the user filled in. */
	readonly completedForm: CompletedForm;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Derive the case-store operations a completed form implies. Pure —
 * no I/O, no mutation of the inputs.
 *
 * The walk visits every field under `formUuid`. Container kinds
 * (group / repeat) recurse without contributing values; leaf fields
 * with `case_property_on` set are routed by the destination case
 * type:
 *
 *   - `case_property_on === moduleCaseType` → primary case property.
 *     For registration: lands in `primary.properties`. For followup
 *     / close: lands in `primary.properties` as the patch payload.
 *   - Any other value → child case property bucketed by case type.
 *     One `ChildInsertOp` per (repeat instance × destination type).
 *
 * Survey forms short-circuit to `{ kind: "survey" }` with no walk.
 * Registration forms emit children without `parent_case_id` (the
 * I/O wrapper threads the primary's generated id); followup / close
 * forms emit children with `parent_case_id` set to the bound
 * `caseId` because the parent already exists.
 *
 * Throws when followup / close is supplied without
 * `completedForm.caseId` — the form's bound case is required for
 * the underlying `CaseStore.update` / `close` call, and surfacing
 * the absence here points the diagnostic at the consumer wiring
 * rather than at a downstream NULL violation.
 */
export function deriveFromForm(args: DeriveFromFormArgs): DerivedFormOps {
	if (args.formType === "survey") {
		return { kind: "survey" };
	}

	// Followup / close MUST carry a bound case; registration must NOT
	// (registration's case is the one being created). Surfacing both
	// invariants here turns a Plan 7 wiring regression into a clear
	// throw at the form-bridge boundary instead of a downstream NULL
	// violation against the cases table.
	if (
		(args.formType === "followup" || args.formType === "close") &&
		args.completedForm.caseId === undefined
	) {
		throw new Error(
			`deriveFromForm: form type "${args.formType}" requires completedForm.caseId, ` +
				`but none was supplied. Followup and close forms operate on a bound case ` +
				`whose id flows from the preview's nav stack; the form-bridge cannot ` +
				`derive an update / close operation without it.`,
		);
	}

	// Build the case-type lookup once. The runtime walk reads the
	// destination case type's `properties[]` to coerce string values
	// into typed JSON; the lookup keys by `case_type` name and the
	// blueprint guarantees uniqueness.
	const caseTypeLookup = buildCaseTypeLookup(args.blueprint.caseTypes);

	// Walk the form tree, accumulating one `FieldBucket` per
	// destination case type. The primary bucket — when
	// `moduleCaseType` is defined — collects fields whose
	// `case_property_on` matches the module's case type; named
	// buckets collect fields whose `case_property_on` points
	// elsewhere.
	const walkResult = walkFormFields({
		blueprint: args.blueprint,
		formUuid: args.formUuid,
		moduleCaseType: args.moduleCaseType,
		values: args.completedForm.values,
		caseTypeLookup,
	});

	const children = buildChildOps({
		buckets: walkResult.childBuckets,
		caseTypeLookup,
		// For followup / close, the bound `caseId` is the parent of
		// any newly-inserted child cases. Registration leaves the
		// parent unset; writeThrough fills it in after the primary
		// insert returns the generated id.
		parentCaseIdForChildren:
			args.formType === "followup" || args.formType === "close"
				? args.completedForm.caseId
				: undefined,
	});

	if (args.formType === "registration") {
		// Registration must declare a moduleCaseType — the form is
		// creating a case OF that type. A registration form in a
		// module without a configured case type is a blueprint state
		// the validator rules already block (NO_CASE_TYPE), so
		// surfacing it here turns a misuse into a clear throw.
		if (args.moduleCaseType === undefined) {
			throw new Error(
				`deriveFromForm: registration form ${args.formUuid} requires a ` +
					`moduleCaseType (the case type the form's module creates). ` +
					`The form-bridge cannot derive an insert operation without it.`,
			);
		}
		return {
			kind: "registration",
			primary: {
				caseType: args.moduleCaseType,
				properties: walkResult.primaryProperties,
			},
			children,
		};
	}

	// Followup / close: caseId presence guarded above; the type
	// narrowing here is the structural pin.
	const caseId = args.completedForm.caseId;
	if (caseId === undefined) {
		// Unreachable — guarded above. Defensive throw keeps the
		// narrowing honest for downstream use.
		throw new Error(
			"deriveFromForm: caseId narrowing failed after form-type guard.",
		);
	}
	const primary: PrimaryUpdateOp = {
		caseType: args.moduleCaseType ?? "",
		properties: walkResult.primaryProperties,
	};
	if (args.formType === "followup") {
		return { kind: "followup", caseId, primary, children };
	}
	return { kind: "close", caseId, primary, children };
}

// ---------------------------------------------------------------
// Internal walk
// ---------------------------------------------------------------

/**
 * Per-destination-case-type bucket of contributing field reads. One
 * bucket per `(case_type, repeat-instance-key)` pair so a registration
 * form whose `child_visit` repeat carries three iterations produces
 * three separate child-case ops, not one merged op.
 *
 * `repeatInstanceKey` is the path of the repeat container's instance
 * (e.g. `/data/visits[0]`, `/data/visits[1]`); the empty string keys
 * the bucket for fields outside any repeat. Field walks within a
 * repeat thread the current instance path and bucket on it.
 */
interface FieldBucket {
	readonly caseType: string;
	readonly repeatInstanceKey: string;
	readonly properties: JsonObject;
}

interface WalkResult {
	/** The primary case's accumulated property writes. */
	readonly primaryProperties: JsonObject;
	/** Per-(child-type, repeat-instance) buckets, deterministic order. */
	readonly childBuckets: ReadonlyArray<FieldBucket>;
}

/**
 * Walk the form tree once, emitting one bucket per destination case
 * type. Container kinds (group / repeat) recurse without
 * contributing values; leaf fields with `case_property_on` set are
 * routed into the primary or a named child bucket.
 *
 * Repeat traversal: a repeat container with `case_property_on`-bearing
 * descendants fans out into one bucket per runtime instance. The
 * runtime instance count is derived from the `CompletedForm.values`
 * map by counting distinct `[N]/...` prefixes that fall under the
 * repeat's path. A repeat with zero instances (the form engine
 * always starts with `[0]`, so this is the empty-state UI not the
 * persisted snapshot) emits zero child ops for its descendants.
 */
function walkFormFields(args: {
	blueprint: BlueprintDoc;
	formUuid: Uuid;
	moduleCaseType: string | undefined;
	values: ReadonlyMap<string, string>;
	caseTypeLookup: ReadonlyMap<string, CaseType>;
}): WalkResult {
	const primaryProperties: JsonObject = {};

	// `childBuckets` is ordered by encounter so derived ops are
	// deterministic per blueprint × completed-form input pair. Tests
	// rely on the order; runtime callers don't.
	const childBuckets: FieldBucket[] = [];

	// Bucket lookup: composite key `<caseType>::<repeatInstanceKey>`
	// matches a single bucket so multiple fields contributing to the
	// same child-case write coalesce into one ChildInsertOp.
	const childBucketIndex = new Map<string, FieldBucket>();

	const requireBucket = (
		caseType: string,
		repeatInstanceKey: string,
	): JsonObject => {
		const key = `${caseType}::${repeatInstanceKey}`;
		const existing = childBucketIndex.get(key);
		if (existing !== undefined) {
			return existing.properties;
		}
		const created: FieldBucket = {
			caseType,
			repeatInstanceKey,
			properties: {},
		};
		childBucketIndex.set(key, created);
		childBuckets.push(created);
		return created.properties;
	};

	const walk = (parentUuid: Uuid, pathPrefix: string): void => {
		const childOrder = args.blueprint.fieldOrder[parentUuid] ?? [];
		for (const fieldUuid of childOrder) {
			const field = args.blueprint.fields[fieldUuid];
			if (!field) continue;
			const fieldPath = `${pathPrefix}/${field.id}`;
			const casePropertyOn = readCasePropertyOn(field);

			// Container kinds: groups recurse with the same path
			// prefix; repeats fan out one walk per runtime instance.
			if (field.kind === "group") {
				walk(fieldUuid as Uuid, fieldPath);
				continue;
			}
			if (field.kind === "repeat") {
				const instanceCount = countRepeatInstances({
					values: args.values,
					repeatPath: fieldPath,
				});
				for (let i = 0; i < instanceCount; i++) {
					walk(fieldUuid as Uuid, `${fieldPath}[${i}]`);
				}
				continue;
			}

			// Leaf field. A field without `case_property_on` carries
			// no case-store side effect — it's a display-only or
			// calculation-only field. Skip without recording.
			if (casePropertyOn === undefined) continue;

			// Read the value at the leaf's path. The form engine
			// seeds every leaf path with the empty string on init,
			// so a literal empty value either means "the user
			// cleared / never touched the field" or "the leaf is a
			// pre-`getValueSnapshot` read." Both shapes converge on
			// the same wire semantic: omit the property from the
			// JSONB document entirely. This makes the JSON Schema
			// validator pass (every property is `optional` so an
			// absent key is valid), and Postgres-strict null/blank
			// distinguishes "key absent" (matches `is-null`) from
			// "key present with empty string" (matches `is-blank` but
			// NOT `is-null`). Storing empty strings would also fail
			// ajv-formats validation on `date` / `time` / `datetime`
			// / `geopoint` properties — the format keywords reject
			// the empty string.
			const rawValue = args.values.get(fieldPath) ?? "";
			if (rawValue === "") continue;

			const property = lookupCaseProperty({
				caseTypeLookup: args.caseTypeLookup,
				caseType: casePropertyOn,
				propertyName: field.id,
			});
			const coerced = coerceValueForProperty({
				raw: rawValue,
				property,
			});

			if (
				args.moduleCaseType !== undefined &&
				casePropertyOn === args.moduleCaseType
			) {
				// Primary case bucket. The field's `id` IS the case
				// property name (project-wide convention; see top-level
				// CLAUDE.md § Data model).
				primaryProperties[field.id] = coerced;
				continue;
			}

			// Child-case bucket. Composite key on (caseType,
			// nearest-repeat-instance-path) — a repeat ancestor's
			// instance key buckets per-iteration writes; outside any
			// repeat the empty key collapses to one bucket per type.
			const repeatInstanceKey = nearestRepeatInstanceKey(pathPrefix);
			const bucket = requireBucket(casePropertyOn, repeatInstanceKey);
			bucket[field.id] = coerced;
		}
	};

	walk(args.formUuid, "/data");

	return { primaryProperties, childBuckets };
}

/**
 * Build the typed `ChildInsertOp[]` from accumulated buckets.
 * Bucket order (per `walkFormFields`) is deterministic by encounter;
 * the resulting op list preserves it.
 */
function buildChildOps(args: {
	buckets: ReadonlyArray<FieldBucket>;
	caseTypeLookup: ReadonlyMap<string, CaseType>;
	parentCaseIdForChildren: string | undefined;
}): ReadonlyArray<ChildInsertOp> {
	const ops: ChildInsertOp[] = [];
	for (const bucket of args.buckets) {
		// Skip empty buckets defensively — a bucket without
		// properties still produces a valid (if odd) insert, but the
		// pure walk only creates buckets when at least one property
		// landed in them, so an empty bucket is a corruption signal
		// rather than a normal path.
		if (Object.keys(bucket.properties).length === 0) continue;
		ops.push({
			caseType: bucket.caseType,
			properties: bucket.properties,
			...(args.parentCaseIdForChildren !== undefined
				? { parentCaseId: args.parentCaseIdForChildren }
				: {}),
		});
	}
	return ops;
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/**
 * Build a `name → CaseType` lookup. The blueprint's `caseTypes`
 * array is `null` for app shells without case types declared — that
 * shape produces an empty lookup and the walk emits no primary or
 * child writes.
 */
function buildCaseTypeLookup(
	caseTypes: ReadonlyArray<CaseType> | null,
): ReadonlyMap<string, CaseType> {
	const map = new Map<string, CaseType>();
	if (caseTypes === null) return map;
	for (const caseType of caseTypes) {
		map.set(caseType.name, caseType);
	}
	return map;
}

/**
 * Resolve a `CaseProperty` definition for the supplied case-type +
 * property name. Returns `undefined` when the case type is not
 * declared in the blueprint or the property is undeclared on it —
 * the coercion layer falls back to the text default for undeclared
 * property targets, surfacing the value verbatim rather than
 * dropping it on the floor.
 */
function lookupCaseProperty(args: {
	caseTypeLookup: ReadonlyMap<string, CaseType>;
	caseType: string;
	propertyName: string;
}): CaseProperty | undefined {
	const caseType = args.caseTypeLookup.get(args.caseType);
	if (caseType === undefined) return undefined;
	return caseType.properties.find((p) => p.name === args.propertyName);
}

/**
 * Read `case_property_on` off a field generically. Same shape as
 * `lib/commcare/fieldProps.ts`'s `readFieldString` — the property
 * lives on `inputFieldBaseSchema` only (text / int / select / etc.)
 * and reading it through the discriminated union without narrowing
 * per kind cascades N×M branching. Forking the helper here avoids
 * the `lib/commcare` import-boundary dependency while keeping the
 * single responsibility clear.
 */
function readCasePropertyOn(field: Field): string | undefined {
	const value = (field as unknown as Record<string, unknown>).case_property_on;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Count distinct repeat-instance indexes present in a value map.
 *
 * The form engine maintains every leaf path under a repeat as
 * `<repeatPath>[N]/<descendant>` for `N = 0..count-1`. Counting the
 * unique `[N]/` prefixes recovers the runtime instance count at
 * snapshot time without a separate cardinality channel — same shape
 * `FormEngine.getRepeatCount` returns, derived purely from the
 * snapshot.
 *
 * A repeat with zero matching entries returns 1 (the engine seeds
 * `[0]` on form init). Returning 1 in the empty case keeps fresh-
 * empty repeat instances participating in the walk; a repeat that
 * the user actively emptied via `removeRepeat` would have its `[0]`
 * paths reset to `DEFAULT_ENGINE_STATE` and the empty-string values
 * pass through coercion as empty strings, which is consistent with
 * the engine's emptied-row state.
 */
function countRepeatInstances(args: {
	values: ReadonlyMap<string, string>;
	repeatPath: string;
}): number {
	const seen = new Set<number>();
	const indexPattern = new RegExp(
		`^${escapeRegExp(args.repeatPath)}\\[(\\d+)\\]/`,
	);
	for (const path of args.values.keys()) {
		const match = path.match(indexPattern);
		if (match === null) continue;
		const index = Number.parseInt(match[1] ?? "", 10);
		if (Number.isFinite(index)) seen.add(index);
	}
	if (seen.size === 0) return 1;
	// `Math.max(...iterable)` over a Set of small ints; no realistic
	// argument-count concern at form scale.
	return Math.max(...seen) + 1;
}

/**
 * Escape a string for safe insertion into a `RegExp` literal pattern.
 * The form path can contain `[` and `]` (repeat indices) which carry
 * regex meaning; the caller's path comes from the blueprint's stable
 * `id` plus the recursive prefix and is otherwise alphanumeric, but
 * defensively escaping here keeps the pattern correct under any
 * future id-shape change.
 */
function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the nearest `<...>[N]` segment in a path prefix and return
 * the prefix up through that segment (e.g. `/data/visits[0]/notes`
 * → `/data/visits[0]`). Used to bucket child-case writes per repeat
 * instance: two fields under the same repeat instance share the
 * same instance key and merge into one bucket; fields in different
 * instances stay separate.
 *
 * Returns the empty string when no repeat-index segment is present
 * — the caller treats that as "no enclosing repeat" and bucketing
 * collapses to one bucket per child-case type for the form.
 */
function nearestRepeatInstanceKey(pathPrefix: string): string {
	// Search from the right so a nested repeat scenario (an inner
	// repeat under an outer repeat) keys on the innermost instance.
	// The blueprint validator forbids such nesting today (CCHQ wire
	// rejects nested repeats outside the query-bound shape), but
	// scoping to the innermost is the right answer for any future
	// authorial shape.
	const lastClose = pathPrefix.lastIndexOf("]");
	if (lastClose === -1) return "";
	return pathPrefix.slice(0, lastClose + 1);
}

// ---------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------

/**
 * Coerce the form engine's string value for one field into the typed
 * JSON value the case-store JSON Schema validator expects.
 *
 * The form engine stores every value as a `string` (XForm parity);
 * the JSON Schema generator (`lib/domain/predicate/jsonSchema.ts`)
 * emits typed constraints per `data_type`. The case-store's ajv
 * validator runs against the typed JSON Schema, so an `int` property
 * stored as a string `"42"` would fail validation. This helper does
 * the same per-`data_type` coercion the heuristic generator does on
 * the read side, mirrored here for the write side.
 *
 * Empty raw values are NEVER passed in — the walk omits empty
 * properties from the JSONB document entirely so the absence /
 * presence boundary in Postgres-strict semantics aligns with
 * "user submitted a value." The empty-input policy lives at the
 * walk site, not here.
 *
 * `data_type === undefined` (an undeclared property) falls back to
 * the text shape — the JSON Schema generator does the same fallback
 * (`text` arm of the switch).
 */
function coerceValueForProperty(args: {
	raw: string;
	property: CaseProperty | undefined;
}): JsonValue {
	const dataType: CasePropertyDataType =
		args.property?.data_type ?? ("text" as CasePropertyDataType);

	switch (dataType) {
		case "text":
		case "single_select":
		case "geopoint":
		case "date":
		case "time":
		case "datetime":
			// Pass-through string types. Date-formatted variants are
			// validated by ajv-formats against the schema's `format`
			// keyword; an invalid date string surfaces as an ajv
			// failure at insert time, where the JSON Schema validator
			// is the trust boundary.
			return args.raw;
		case "int": {
			const parsed = Number.parseInt(args.raw, 10);
			// `Number.parseInt` accepts non-numeric tails (e.g.
			// "12abc" → 12); guard with `Number.isInteger` against
			// the parsed result and `Number.isFinite` against NaN.
			// `Number.isInteger` matches the JSON Schema `integer`
			// keyword's contract. A non-numeric input falls through
			// as the raw string so ajv surfaces the type mismatch
			// at the trust boundary rather than silently coercing to
			// NaN or 0.
			return Number.isInteger(parsed) && Number.isFinite(parsed)
				? parsed
				: args.raw;
		}
		case "decimal": {
			const parsed = Number.parseFloat(args.raw);
			return Number.isFinite(parsed) ? parsed : args.raw;
		}
		case "multi_select":
			// XForm convention: multi-select values are space-
			// separated tokens in the bound node value. The case-
			// store JSON Schema models the same property as an array
			// of strings, so the form-bridge splits on whitespace
			// here. The empty-input case is handled by the walk
			// (omits the property entirely); a multi-select with
			// "single token" in the raw value still produces a
			// one-element array.
			return args.raw.split(/\s+/).filter((token) => token.length > 0);
		default: {
			// Exhaustive switch over `CasePropertyDataType`. A new
			// variant added to the enum surfaces as a `never`
			// assignment here, forcing the new case to be wired
			// through the coercion layer before the project compiles.
			const _exhaustive: never = dataType;
			throw new Error(
				`coerceValueForProperty: unhandled data_type "${String(_exhaustive)}". ` +
					`Known types: ${casePropertyDataTypes.join(", ")}.`,
			);
		}
	}
}
