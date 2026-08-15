/**
 * Shared add-path normalization for the SA's field-add tools.
 *
 * Both `addFields` (batch) and `addField` (single) walk this pipeline
 * before emitting `addField` mutations:
 *
 *   1. **`stripEmpty`** — batch-only. Normalizes the in-batch `parentUuid`
 *      (absent → `null`, the "insert at form level" sentinel the batch
 *      handler reads) and defensively collapses any empty string / empty
 *      array the SA sends to absence. The single-field `addField` path has
 *      no in-batch parent to resolve and skips this step.
 *   2. **`applyDefaults`** — both surfaces. Case-type property defaulting
 *      seeds only intrinsic field shape (`kind`, canonical `label`, and
 *      choice `options`) wherever the payload left it unset. Form-context
 *      behavior (`hint`, `required`, and `validate`) is authored on the field
 *      itself. Case preload is NOT seeded here — it's emitted structurally at
 *      the wire layer (`xform/caseBlocks.ts`).
 *   3. **`flatFieldToField`** — both surfaces. Per-kind
 *      `fieldSchema.safeParse` validation + domain `Field` assembly,
 *      returning a tagged success/reason result.
 *
 * Vocabulary is domain-side (`kind`, `validate`, `validate_msg`,
 * `caseWrite`); there is no CommCare → domain translation inside the agent.
 */
import type { z } from "zod";
import type {
	CaseType,
	Field,
	FieldKind,
	SelectOptionsSource,
	Uuid,
} from "@/lib/domain";
import {
	fieldKindDeclaresKey,
	fieldKinds,
	fieldSchema,
	isProseTemplate,
	pickFieldKeysForKind,
	proseTemplateIsEmpty,
	uuidSchema,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import type { ProjectedOptionsSource } from "./toolSchemaGenerator";
import type { addFieldsItemSchema } from "./toolSchemas";

/** Narrow a possibly-unknown kind string to a `FieldKind` before asking the
 *  per-kind key sets about it — an SA-supplied bad kind would otherwise blow
 *  up `fieldKindDeclaresKey`'s lookup (and is caught later by the field parse). */
function isFieldKind(kind: unknown): kind is FieldKind {
	return (
		typeof kind === "string" && (fieldKinds as readonly string[]).includes(kind)
	);
}

/** A catalog default should fill a slot the SA left unset — treating `null`,
 *  an empty string, or an empty array as "unset" too (on the add path they
 *  all mean "nothing here"; the batch path's `stripEmpty` already collapses
 *  them), so both add paths seed identically. */
function isUnset(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === "" ||
		(isProseTemplate(value) && proseTemplateIsEmpty(value)) ||
		(Array.isArray(value) && value.length === 0)
	);
}

type CaseTypes = CaseType[] | null;

// ── Flat input shape ─────────────────────────────────────────────────

/**
 * The flat field shape this pipeline operates on — every key any kind
 * might carry, all optional but `id`/`kind`. It IS the inferred type of
 * the `addFields` tool item (`addFieldsItemSchema`): the tool input and
 * the processing shape are one, so a validated item flows through
 * `stripEmpty` / `applyDefaults` / `flatFieldToField` with no bridge.
 * `parentUuid` is an optional stable container identity (omitted = "insert at
 * the form's top level").
 */
export type FlatField = z.infer<typeof addFieldsItemSchema>;

/** Add-tool field shape after every authorable option has its final UUID. */
export type PreparedFlatField = Omit<FlatField, "optionsSource"> & {
	optionsSource?: SelectOptionsSource | null;
};

/**
 * Convert the one machine-authored select-source projection to persisted
 * domain state. This is the sole `optionUuid` -> `uuid` bridge: callers invoke
 * it once before collision/admission checks and carry the returned object
 * through mutation assembly unchanged.
 */
export function prepareToolOptionsSource(
	source: ProjectedOptionsSource,
): SelectOptionsSource {
	if (source.kind === "lookup") return source;
	return {
		kind: "inline",
		options: source.options.map(({ optionUuid, ...option }) => ({
			...option,
			uuid: optionUuid ?? uuidSchema.parse(crypto.randomUUID()),
		})),
	};
}

/**
 * Establish the stored select-source shape at the tool boundary.
 *
 * `optionUuid` is the machine-facing creation/address slot; the document stores
 * that identity as `uuid`. A missing creation UUID is minted once here, before
 * collision checks and field assembly.
 */
export function prepareFlatFieldIdentities(
	field: FlatField,
): PreparedFlatField {
	const source = field.optionsSource;
	if (source == null || source.kind === "lookup") {
		return field as PreparedFlatField;
	}
	return {
		...field,
		optionsSource: prepareToolOptionsSource(source),
	};
}

// ── Sentinel collapse ────────────────────────────────────────────────

/**
 * Collapse empty values to absence:
 *   - `null`       → drop the key entirely (on the add path null means
 *                    "nothing here", same as omission)
 *   - empty string → drop
 *   - empty array  → drop
 *
 * `parentUuid` is special-cased: missing becomes `null` (rather
 * than just being dropped) so the downstream "no parent = form level"
 * logic reads an explicit value. The SA usually omits `parentUuid`, which
 * lands here as `undefined` → `null`.
 *
 * Batch-path only — the `addFields` tool runs its input through this
 * before `applyDefaults`. `addField` (single) feeds `applyDefaults`
 * directly.
 *
 * Input is typed as `FlatField` (the wide processing shape); output is
 * `Partial<FlatField>` because any non-required key may be absent after
 * the collapse.
 */
export function stripEmpty(q: PreparedFlatField): Partial<PreparedFlatField> & {
	parentUuid?: Uuid | null;
} {
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(q)) {
		if (v === null) continue;
		if (v === "") continue;
		if (Array.isArray(v) && v.length === 0) continue;
		result[k] = v;
	}
	if (result.parentUuid === undefined) result.parentUuid = null;
	return result as Partial<PreparedFlatField> & {
		parentUuid?: Uuid | null;
	};
}

// ── Data-model defaults ──────────────────────────────────────────────

/**
 * Apply case-type defaults to a flat field. When `caseWrite` is set, its
 *      matching case type and property metadata seed any unset keys on
 *      the field:
 *        - `kind` from `property.data_type` (defaulting to "text")
 *        - canonical `label` and choice `options` verbatim
 *
 * A catalog property's `hint`, `required`, `validation`, and
 * `validation_msg` do not seed a form field. Supporting copy, answer
 * requiredness, and validation belong to the workflow context and can
 * legitimately differ between registration and later editing forms that
 * write the same property.
 *
 * Case preload is NOT seeded here. A case-loading form's primary properties
 * are read back from the case at the wire layer — `xform/caseBlocks.ts`
 * lowers the derived `case_preload` action into `<setvalue>` reads from
 * `casedb`. Stamping a case-preload `default_value` here was a redundant
 * second channel for the same effect; the structural preload owns it.
 */
export function applyDefaults<E extends object = object>(
	q: Partial<PreparedFlatField> & E,
	caseTypes: CaseTypes,
): Partial<PreparedFlatField> & E {
	const result = { ...q };

	if (result.caseWrite && caseTypes) {
		const ct = caseTypes.find((c) => c.name === result.caseWrite?.caseType);
		const prop = ct?.properties.find(
			(p) => p.name === result.caseWrite?.property,
		);
		if (prop) {
			// Seed the kind first — every other default depends on knowing it.
			result.kind ??= prop.data_type ?? "text";
			const kind = result.kind;

			// A catalog default applies only when (a) the field left the slot
			// unset — and `""` / `[]` count as unset, so the single- and
			// batch-add paths (the latter pre-collapses empties via
			// `stripEmpty`) seed IDENTICALLY — AND (b) the resolved kind's
			// schema actually DECLARES the slot. Without (b), a computed
			// `hidden` field that writes to a property declared as a select
			// would inherit that property's `options` / `label`, and the
			// strict per-kind schema in `flatFieldToField` would then reject
			// the whole field (the kind doesn't carry those keys).
			const declares = (key: string): boolean =>
				isFieldKind(kind) ? fieldKindDeclaresKey(kind, key) : true;

			if (declares("label") && isUnset(result.label)) {
				result.label = prop.label;
			}
			if (declares("optionsSource") && isUnset(result.optionsSource)) {
				const options = prop.options?.map((option) => ({
					...option,
					uuid: uuidSchema.parse(crypto.randomUUID()),
				}));
				if (options !== undefined) {
					result.optionsSource = { kind: "inline", options };
				}
			}
		}
	}

	return result;
}

// ── Flat → Field assembly ────────────────────────────────────────────

/**
 * Outcome of assembling a flat payload into a domain `Field`: the built
 * field, or a human-readable `reason` the assembly failed. Callers surface
 * the reason (single-add error, batch skip note) so a failure is
 * diagnosable rather than a generic "missing a required property".
 */
export type FlatFieldResult =
	| { ok: true; field: Field }
	| { ok: false; reason: string };

/**
 * Reduce a `fieldSchema` parse error to the specific reason(s) it failed,
 * digging through the union machinery. `fieldSchema` is a union of two
 * discriminated unions, so the genuinely-useful issue is nested inside an
 * `invalid_union`'s per-branch `errors`; the top-level issue is just a
 * generic "Invalid input" and the wrong-branch attempts say "No matching
 * discriminator". Skip that noise and surface the real leaf messages.
 */
function describeFieldFailure(
	error: z.ZodError,
	kind: string | undefined,
): string {
	type Issue = {
		code?: string;
		message: string;
		path: PropertyKey[];
		errors?: Issue[][];
	};
	const leaves: string[] = [];
	const visit = (issues: readonly Issue[]): void => {
		for (const issue of issues) {
			if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
				for (const branch of issue.errors) visit(branch);
				continue;
			}
			if (/no matching discriminator|invalid input/i.test(issue.message)) {
				continue;
			}
			const path = issue.path.map(String).join(".");
			leaves.push(path ? `${path}: ${issue.message}` : issue.message);
		}
	};
	visit(error.issues as unknown as Issue[]);
	const detail = [...new Set(leaves)].join("; ");
	return detail || `the supplied values don't form a valid "${kind}" field`;
}

/**
 * Build a validated domain `Field` from an add-path flat payload.
 *
 * Two steps: reshape the SA-authoring shape into the domain shape (nested
 * `validate`/`repeat` → flat keys), then validate.
 * Before validating we FILTER the candidate to the kind's schema-declared
 * keys via `pickFieldKeysForKind` — the same projection `reconcileFieldForKind`
 * and the `updateField` reducer use. The per-kind schemas are `.strict()`,
 * so a stray key the kind doesn't declare would otherwise make the WHOLE
 * field fail to parse; filtering drops the stray key and keeps the field as
 * its valid subset. (The per-kind tool inputs already reject stray keys at
 * the boundary, so this is defense-in-depth for non-tool paths — catalog
 * seeding, or schema drift.)
 *
 * Returns `{ ok: true, field }`, or `{ ok: false, reason }` naming the
 * specific parse failure. After the per-kind tool input + kind-aware
 * `applyDefaults`, a valid payload always assembles — a failure here means
 * the generator and the domain schema have drifted (a code bug), which the
 * reason makes diagnosable. The `__tests__` fuzz over every kind asserts
 * this totality.
 *
 * Lives alongside `stripEmpty` + `applyDefaults` because the three helpers
 * form the shared add-path pipeline both `addFields` and `addField` walk.
 */
export function flatFieldToField(
	q: Partial<PreparedFlatField>,
	uuid: Uuid,
): FlatFieldResult {
	const candidate: Record<string, unknown> = {
		kind: q.kind,
		uuid,
		id: q.id,
		...(q.label !== undefined && q.label !== null && { label: q.label }),
		...(q.hint !== undefined && q.hint !== null && { hint: q.hint }),
		...(q.help !== undefined && q.help !== null && { help: q.help }),
		...(q.required !== undefined &&
			q.required !== null && { required: q.required }),
		...(q.relevant !== undefined &&
			q.relevant !== null && { relevant: q.relevant }),
		// Nested validate config: SA passes `validate: { expr, msg? }`;
		// the schema stores `validate` + `validate_msg`. Both are already
		// canonical structures at the SA/MCP boundary.
		...(q.validate && {
			validate: q.validate.expr,
			...(q.validate.msg !== undefined && {
				validate_msg: q.validate.msg,
			}),
		}),
		...(q.calculate !== undefined &&
			q.calculate !== null && { calculate: q.calculate }),
		...(q.default_value !== undefined &&
			q.default_value !== null && { default_value: q.default_value }),
		...(q.optionsSource != null && { optionsSource: q.optionsSource }),
		...(q.caseWrite != null && { caseWrite: q.caseWrite }),
		// Nested repeat config: the SA's `repeat` is discriminated on `mode`
		// (`count` exists only on count_bound, `ids_query` only on
		// query_bound); the domain schema discriminates over `repeat_mode`
		// with `repeat_count` (count_bound) or `data_source: { ids_query }`
		// (query_bound). Reshape here, unescaping XPath HTML entities on the
		// inner expressions. Mode is required inside the nested object so
		// there's no silent default — if the SA emits `kind: "repeat"`
		// without a `repeat` object, the candidate has no `repeat_mode` and
		// the domain parse rejects, surfacing the omission as a parse error
		// rather than a silent fallback.
		...(q.kind === "repeat" &&
			q.repeat && {
				repeat_mode: q.repeat.mode,
				...(q.repeat.mode === "count_bound" && {
					repeat_count: q.repeat.count,
				}),
				...(q.repeat.mode === "query_bound" && {
					data_source: {
						ids_query: q.repeat.ids_query,
					},
				}),
			}),
	};
	// Filter to the kind's declared keys before the strict parse, so a stray
	// key drops out rather than failing the whole field (see the doc comment).
	const kind = candidate.kind;
	const filtered = isFieldKind(kind)
		? pickFieldKeysForKind(candidate, kind)
		: candidate;
	const result = fieldSchema.safeParse(filtered);
	if (!result.success) {
		const reason = describeFieldFailure(result.error, q.kind);
		log.warn(
			`[flatFieldToField] could not assemble field id=${q.id} kind=${q.kind}: ${reason}`,
		);
		return { ok: false, reason };
	}
	return { ok: true, field: result.data };
}
