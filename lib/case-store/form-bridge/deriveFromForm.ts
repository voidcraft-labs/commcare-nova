// lib/case-store/form-bridge/deriveFromForm.ts
//
// Pure half of the form-bridge: walks the blueprint's field tree
// for one form, reads runtime values out of a `CompletedForm`
// snapshot, buckets fields by destination case type, and emits a
// typed `DerivedFormOps` discriminated union. No I/O — the I/O
// wrapper lives at `./writeThrough.ts`.
//
// ## Why a fresh walk instead of reusing `lib/commcare/deriveCaseConfig`
//
// `lib/commcare/deriveCaseConfig.ts` produces build-time
// `DerivedCaseConfig` (CCHQ wire-emission fodder, with
// `repeat_context` as a static ancestor). The runtime path needs
// different output: one explicit `ChildInsertOp` per repeat
// instance with per-instance values plugged in, and the walk fans
// out across instances rather than emitting a single static
// descriptor. The `lib/commcare` import boundary also keeps the
// form-bridge outside CCHQ's wire-emission concerns by design.
//
// ## Field id = case property name
//
// Project-wide convention (top-level `CLAUDE.md` § Data model): a
// field's `id` IS the case property name it writes to.
// `case_property_on` names the case TYPE.
// `case_property_on === moduleCaseType` routes into the primary
// case; any other value buckets into a child-case insert keyed by
// the destination case type.
//
// ## How values flow in
//
// `CompletedForm` mirrors `FormEngine.getValueSnapshot()`: a flat
// `Map<path, string>` keyed by XForm-style paths. Strings coerce
// to typed JSON values per the destination case-type's `data_type`
// declarations before landing in the derived op's `properties`
// JSONB document.

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
import {
	compilerBugMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import type { JsonObject, JsonValue } from "../sql/database";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * Snapshot of a completed form's runtime state. `values` matches
 * `FormEngine.getValueSnapshot().values` — a flat
 * `Map<XFormPath, string>`. `caseId` is set from the preview's nav
 * stack for followup / close; absent for registration / survey.
 * The form-bridge surfaces a typed throw when the form type
 * requires `caseId` and none was supplied, so the diagnostic
 * points at the consumer wiring rather than at a downstream NULL
 * violation against `cases.case_id`.
 */
export interface CompletedForm {
	readonly values: ReadonlyMap<string, string>;
	readonly caseId?: string;
}

/**
 * The properties patch one form completion contributes to one
 * case. The form-bridge always emits the parsed-and-typed object
 * form so consumers don't re-parse.
 */
export type DerivedProperties = JsonObject;

/**
 * One child-case insert.
 *
 * `parentCaseId` resolves on the derivation side for followup /
 * close (the bound `caseId` IS the parent) but NOT for registration
 * — the parent's id is generated at write time, so the I/O wrapper
 * threads it from the primary insert's return.
 *
 * `caseName` is walked off the field with `id: "case_name"` (the
 * platform-required scalar routed to `cases.case_name`).
 *
 * **`caseName` invariant:** when defined, non-empty. The walk's
 * empty-string short-circuit covers this structurally; consumers
 * trust the non-empty contract.
 */
export interface ChildInsertOp {
	readonly caseType: string;
	readonly caseName?: string;
	readonly properties: DerivedProperties;
	readonly parentCaseId?: string;
}

/**
 * The primary case write a registration form implies. Registration
 * ALWAYS creates a case row, so an empty `properties` is still a
 * valid op (unlike followup, which short-circuits the UPDATE when
 * both `properties` AND `caseName` are empty).
 *
 * **`caseName` invariant:** see `ChildInsertOp.caseName`.
 */
export interface PrimaryRegistrationOp {
	readonly caseType: string;
	readonly caseName?: string;
	readonly properties: DerivedProperties;
}

/**
 * The primary case write a followup or close form implies.
 * `properties` may be empty AND `caseName` may be absent — a close
 * form whose only action is setting `closed_on` carries no scalar
 * writes. The I/O wrapper short-circuits the underlying `update`
 * when both are empty.
 *
 * `caseType` is diagnostic-only — followup / close already know the
 * row's case type from the bound caseId's row. When the caller
 * doesn't pass `moduleCaseType`, the field is `undefined` rather
 * than silently coerced to `""`.
 *
 * **`caseName` invariant:** when defined, non-empty. The I/O
 * wrapper passes the value straight through to `CaseStore.update`
 * without re-checking, so this invariant is the load-bearing
 * guarantee against the database CHECK constraint.
 */
export interface PrimaryUpdateOp {
	readonly caseType: string | undefined;
	readonly caseName?: string;
	readonly properties: DerivedProperties;
}

/**
 * The full set of `CaseStore` operations one completed form
 * implies. Discriminated by `kind` matching `FormType` — the type
 * checker forces consumers to reason about the survey arm
 * explicitly.
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
 * than the full preview state keeps the function pure.
 *
 * `moduleCaseType` is the owning module's case type. The caller
 * resolves it from the blueprint and passes it in — `deriveFromForm`
 * does not scan modules itself. Optional for survey forms and for
 * modules without a configured case type; the walk still runs in
 * the latter case and any field whose `case_property_on` doesn't
 * match buckets into a child case as usual.
 */
export interface DeriveFromFormArgs {
	readonly blueprint: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly formType: FormType;
	readonly moduleCaseType?: string;
	readonly completedForm: CompletedForm;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Derive the case-store operations a completed form implies. Pure.
 *
 * Registration forms emit children without `parent_case_id` — the
 * I/O wrapper threads the primary's generated id. Followup / close
 * emit children with `parent_case_id` set to the bound `caseId`.
 * Throws when followup / close arrives without `completedForm.caseId`.
 */
export function deriveFromForm(args: DeriveFromFormArgs): DerivedFormOps {
	if (args.formType === "survey") {
		return { kind: "survey" };
	}

	// Surfacing the missing-caseId invariant here turns a consumer
	// wiring slip into a clear throw at the form-bridge boundary
	// instead of a downstream NULL violation against `cases.case_id`.
	if (
		(args.formType === "followup" || args.formType === "close") &&
		args.completedForm.caseId === undefined
	) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.deriveFromForm",
				invariant: `form type \`${args.formType}\` requires \`completedForm.caseId\`, but none was supplied`,
				detail:
					"Followup and close forms operate on a bound case; the running-app view's nav stack carries the bound case id through `PreviewScreen.form.caseId`. Reaching this throw means the consumer wired `completedForm` without threading the bound id from the nav stack.\n\nHint: confirm the form-bridge consumer extracts `caseId` from the running-app preview state before invoking `deriveFromForm` for non-registration / non-survey forms.",
			}),
		);
	}

	const caseTypeLookup = buildCaseTypeLookup(args.blueprint.caseTypes);

	const walkResult = walkFormFields({
		blueprint: args.blueprint,
		formUuid: args.formUuid,
		moduleCaseType: args.moduleCaseType,
		values: args.completedForm.values,
		caseTypeLookup,
	});

	const children = buildChildOps({
		buckets: walkResult.childBuckets,
		// Followup / close children inherit the bound caseId as
		// parent. Registration leaves it unset; writeThrough fills
		// it in from the primary insert's generated id.
		parentCaseIdForChildren:
			args.formType === "followup" || args.formType === "close"
				? args.completedForm.caseId
				: undefined,
	});

	if (args.formType === "registration") {
		// Registration must declare a moduleCaseType — the form is
		// creating a case OF that type. The blueprint validator's
		// `NO_CASE_TYPE` rule already rejects modules without one,
		// so reaching this throw means an unvalidated blueprint
		// bypassed validation.
		if (args.moduleCaseType === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.deriveFromForm",
					invariant: `registration form \`${args.formUuid}\` reached the form-bridge without a \`moduleCaseType\``,
					detail:
						"A registration form creates a case OF the module's case type, so the case-type slot is required to derive the `insert` operation. The blueprint validator's `NO_CASE_TYPE` rule already rejects modules without a configured case type, so reaching this throw means a registration form was carried through validation without being routed through the validator.\n\nHint: confirm the consumer derives `moduleCaseType` from the form's parent module before invoking the bridge; an unvalidated blueprint that bypassed `NO_CASE_TYPE` is the structural cause.",
				}),
			);
		}
		// Spread `caseName` only when defined so `Object.keys` sees
		// no slot for an absent name — same shape every other "absent
		// vs explicit" boundary in the bridge follows.
		return {
			kind: "registration",
			primary: {
				caseType: args.moduleCaseType,
				properties: walkResult.primaryProperties,
				...(walkResult.primaryCaseName !== undefined
					? { caseName: walkResult.primaryCaseName }
					: {}),
			},
			children,
		};
	}

	// Followup / close: caseId presence guarded at the top; the
	// type narrowing here is the structural pin. Unreachable in
	// practice — the guard filters this case out — but the throw
	// keeps the narrowing honest if the upstream guard ever
	// regresses.
	const caseId = args.completedForm.caseId;
	if (caseId === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.deriveFromForm",
				invariant:
					"`caseId` narrowing failed after the followup/close form-type guard",
				detail:
					"The function's top-of-body guard rejects undefined `caseId` for followup/close forms before reaching this branch. Reaching this throw means the upstream guard regressed; restore the early-throw branch.",
			}),
		);
	}
	const primary: PrimaryUpdateOp = {
		caseType: args.moduleCaseType,
		properties: walkResult.primaryProperties,
		...(walkResult.primaryCaseName !== undefined
			? { caseName: walkResult.primaryCaseName }
			: {}),
	};
	if (args.formType === "followup") {
		return { kind: "followup", caseId, primary, children };
	}
	return { kind: "close", caseId, primary, children };
}

/**
 * Per-destination-case-type bucket of field reads. One bucket per
 * `(case_type, repeat-instance-key)` pair so a registration form
 * whose `child_visit` repeat carries three iterations produces
 * three separate child-case ops, not one merged op. The empty
 * string keys the bucket for fields outside any repeat.
 *
 * `caseName` is mutable because the walk encounters the
 * `case_name`-id field at most once per bucket. The slot stays
 * separate from `properties` because `case_name` routes to the
 * `cases.case_name` column, not the JSONB document.
 *
 * **`caseName` invariant:** when defined, non-empty. The walk's
 * `if (rawValue === "") continue` short-circuit covers this
 * structurally; downstream `applyChildInserts` trusts the
 * non-empty contract. The DB CHECK constraint is the load-bearing
 * fallback if the walk's guard ever regresses.
 */
interface FieldBucket {
	readonly caseType: string;
	readonly repeatInstanceKey: string;
	readonly properties: JsonObject;
	caseName?: string;
}

interface WalkResult {
	readonly primaryProperties: JsonObject;
	/**
	 * **Invariant:** when defined, non-empty. Same empty-string
	 * short-circuit covers this; `applyPrimaryUpdate` /
	 * `applyPrimaryRegistration` trust the non-empty contract.
	 */
	readonly primaryCaseName: string | undefined;
	readonly childBuckets: ReadonlyArray<FieldBucket>;
}

/**
 * Walk the form tree once, emitting one bucket per destination
 * case type. Container kinds (group / repeat) recurse without
 * contributing values.
 *
 * Repeat traversal fans out into one bucket per runtime instance.
 * The instance count is derived from the values map by counting
 * distinct `[N]/...` prefixes — same shape `FormEngine.getRepeatCount`
 * returns. A repeat with zero instances emits zero child ops.
 */
function walkFormFields(args: {
	blueprint: BlueprintDoc;
	formUuid: Uuid;
	moduleCaseType: string | undefined;
	values: ReadonlyMap<string, string>;
	caseTypeLookup: ReadonlyMap<string, CaseType>;
}): WalkResult {
	const primaryProperties: JsonObject = {};
	let primaryCaseName: string | undefined;

	// Encounter-ordered so derived ops are deterministic per
	// `(blueprint, completed-form)` pair.
	const childBuckets: FieldBucket[] = [];

	// Composite key `<caseType>::<repeatInstanceKey>` so multiple
	// fields contributing to the same child-case write coalesce.
	const childBucketIndex = new Map<string, FieldBucket>();

	const requireBucket = (
		caseType: string,
		repeatInstanceKey: string,
	): FieldBucket => {
		const key = `${caseType}::${repeatInstanceKey}`;
		const existing = childBucketIndex.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const created: FieldBucket = {
			caseType,
			repeatInstanceKey,
			properties: {},
		};
		childBucketIndex.set(key, created);
		childBuckets.push(created);
		return created;
	};

	const walk = (parentUuid: Uuid, pathPrefix: string): void => {
		const childOrder = args.blueprint.fieldOrder[parentUuid] ?? [];
		for (const fieldUuid of childOrder) {
			const field = args.blueprint.fields[fieldUuid];
			if (!field) continue;
			const fieldPath = `${pathPrefix}/${field.id}`;
			const casePropertyOn = readCasePropertyOn(field);

			// Groups recurse with the same path prefix; repeats fan
			// out one walk per runtime instance.
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

			// A field without `case_property_on` is display-only or
			// calculation-only — skip without recording.
			if (casePropertyOn === undefined) continue;

			// `FormEngine.getValueSnapshot()` filters empty values out
			// at `formEngine.ts:644` (`if (state.value) values.set(...)`),
			// so the snapshot never carries explicit `""` for cleared
			// leaves. The `?? ""` handles the absent-key case; the
			// `=== ""` is defensive belt-and-suspenders for any future
			// engine variant. Both converge on omitting the property
			// from the JSONB document — the only shape that passes
			// AJV validation (`""` fails `format: date` / `time` /
			// `date-time` / geopoint patterns) AND aligns with
			// Postgres-strict `is-null` ("absent" ≡ "not present").
			const rawValue = args.values.get(fieldPath) ?? "";
			if (rawValue === "") continue;

			const isPrimaryBucket =
				args.moduleCaseType !== undefined &&
				casePropertyOn === args.moduleCaseType;

			// `case_name` routes to the top-level column, not the
			// JSONB document. Keyed on `field.id` (project convention:
			// field id IS the case property name) rather than
			// `case_property_on` (which names the destination case
			// TYPE). The string passes through as-is — `text NOT NULL`
			// at the column means the property's `data_type` is
			// irrelevant to the column write.
			if (field.id === "case_name") {
				if (isPrimaryBucket) {
					primaryCaseName = rawValue;
				} else {
					const repeatInstanceKey = nearestRepeatInstanceKey(pathPrefix);
					const bucket = requireBucket(casePropertyOn, repeatInstanceKey);
					bucket.caseName = rawValue;
				}
				continue;
			}

			const property = lookupCaseProperty({
				caseTypeLookup: args.caseTypeLookup,
				caseType: casePropertyOn,
				propertyName: field.id,
			});
			const coerced = coerceValueForProperty({
				raw: rawValue,
				property,
			});

			if (isPrimaryBucket) {
				primaryProperties[field.id] = coerced;
				continue;
			}

			// Child-case bucket: a repeat ancestor's instance key
			// buckets per-iteration writes; outside any repeat the
			// empty key collapses to one bucket per type.
			const repeatInstanceKey = nearestRepeatInstanceKey(pathPrefix);
			const bucket = requireBucket(casePropertyOn, repeatInstanceKey);
			bucket.properties[field.id] = coerced;
		}
	};

	walk(args.formUuid, "/data");

	return { primaryProperties, primaryCaseName, childBuckets };
}

/**
 * Build `ChildInsertOp[]` from accumulated buckets, preserving
 * encounter order. A bucket containing only a `caseName` is
 * legitimate (the child has a display name and platform defaults
 * for everything else), so the empty-bucket skip tests both
 * `properties` and `caseName`.
 */
function buildChildOps(args: {
	buckets: ReadonlyArray<FieldBucket>;
	parentCaseIdForChildren: string | undefined;
}): ReadonlyArray<ChildInsertOp> {
	const ops: ChildInsertOp[] = [];
	for (const bucket of args.buckets) {
		// `walkFormFields` only creates buckets when a contributing
		// field lands in them, so this skip is defensive against an
		// upstream bug.
		if (
			Object.keys(bucket.properties).length === 0 &&
			bucket.caseName === undefined
		) {
			continue;
		}
		ops.push({
			caseType: bucket.caseType,
			properties: bucket.properties,
			...(bucket.caseName !== undefined ? { caseName: bucket.caseName } : {}),
			...(args.parentCaseIdForChildren !== undefined
				? { parentCaseId: args.parentCaseIdForChildren }
				: {}),
		});
	}
	return ops;
}

/**
 * Build a `name → CaseType` lookup. A `null` `caseTypes` (app
 * shells without case types declared) produces an empty lookup;
 * the walk emits no primary or child writes.
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
 * Resolve a `CaseProperty` for `(caseType, propertyName)`.
 * `undefined` falls back to the text default at the coercion
 * layer — surface the value verbatim rather than drop it.
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
 * Read `case_property_on` off a field generically. The property
 * lives on `inputFieldBaseSchema` only (text / int / select / etc.);
 * reading through the discriminated union without per-kind
 * narrowing avoids N×M branching. Forked from
 * `lib/commcare/fieldProps.ts`'s `readFieldString` to respect the
 * `lib/commcare` import-boundary.
 */
function readCasePropertyOn(field: Field): string | undefined {
	const value = (field as unknown as Record<string, unknown>).case_property_on;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Count distinct repeat-instance indexes present in a value map by
 * counting unique `[N]/` prefixes. A repeat with zero matching
 * entries returns 1 — the engine seeds `[0]` on form init, so
 * returning 1 keeps fresh-empty repeat instances participating in
 * the walk. A user-emptied repeat would have its `[0]` paths reset
 * to `DEFAULT_ENGINE_STATE` and pass through coercion as empties,
 * consistent with the engine's emptied-row state.
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
	return Math.max(...seen) + 1;
}

/** Escape a string for safe insertion into a `RegExp` literal pattern. */
function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the path prefix up through the nearest `<...>[N]` segment
 * (e.g. `/data/visits[0]/notes` → `/data/visits[0]`). Empty string
 * means "no enclosing repeat". Searches right-to-left so a nested
 * repeat keys on the innermost instance — the blueprint validator
 * forbids such nesting today, but innermost is the right answer
 * for any future authoring shape.
 */
function nearestRepeatInstanceKey(pathPrefix: string): string {
	const lastClose = pathPrefix.lastIndexOf("]");
	if (lastClose === -1) return "";
	return pathPrefix.slice(0, lastClose + 1);
}

/**
 * Coerce the form engine's string value into the typed JSON value
 * the case-store JSON Schema validator expects. The form engine
 * stores every value as a `string` (XForm parity); per-`data_type`
 * coercion mirrors what `jsonSchema.ts` and `HeuristicCaseGenerator`
 * do on the other side.
 *
 * Empty raw values never reach this function — the walk omits empty
 * properties from the JSONB document entirely so absence/presence
 * aligns with Postgres-strict semantics.
 */
function coerceValueForProperty(args: {
	raw: string;
	property: CaseProperty | undefined;
}): JsonValue {
	const dataType: CasePropertyDataType = args.property?.data_type ?? "text";

	switch (dataType) {
		case "text":
		case "single_select":
		case "geopoint":
		case "date":
		case "time":
		case "datetime":
			// Pass-through; ajv-formats validates against the
			// `format` keyword at insert time.
			return args.raw;
		case "int": {
			// `Number.parseInt` accepts non-numeric tails ("12abc" →
			// 12); guard with `Number.isInteger` + `Number.isFinite`
			// to match the JSON Schema `integer` keyword. A
			// non-numeric input falls through as the raw string so
			// ajv surfaces the type mismatch rather than silently
			// coercing to NaN or 0.
			const parsed = Number.parseInt(args.raw, 10);
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
			// separated tokens. The case-store JSON Schema models
			// the property as an array of strings.
			return args.raw.split(/\s+/).filter((token) => token.length > 0);
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				unhandledKindMessage({
					where: "case-store.coerceValueForProperty",
					family: "CasePropertyDataType",
					received: _exhaustive,
					knownKinds: [...casePropertyDataTypes],
				}),
			);
		}
	}
}
