/**
 * fast-check arbitrary that generates schema-valid `BlueprintDoc`s for the
 * XForm oracle fuzzer.
 *
 * The totality claim the fuzzer proves is scoped to SCHEMA-VALID docs — a doc
 * the domain validator (`runValidation`) accepts. So this arbitrary is
 * CONSTRUCTIVE, not filtered: rather than generate arbitrary shapes and
 * `fc.pre` away the invalid ones (which starves the run), it builds docs that
 * are valid by construction — globally-unique ids from a single minter (which
 * makes the sibling-uniqueness CommCare requires trivially hold),
 * registration forms that always carry a `case_name` field, selects with ≥2
 * options, XPath drawn from a verified-valid palette, etc. The fuzz test still
 * asserts `runValidation(doc).length === 0` at the top of every property body:
 * if this arbitrary ever slips and emits an invalid doc, that assertion fails
 * LOUD as a generator bug, not a silent skip.
 *
 * It exercises the surfaces the oracle's invariants touch: all field kinds,
 * nested groups + repeats (all three repeat modes, incl. query_bound's
 * model-iteration markup), selects with duplicate option values (legal —
 * CommCare only requires the value be present), labels/hints with XML special
 * chars (`<`, `&`, markdown), relevant/constraint/calculate XPath, and the
 * four form types (registration / followup / close / survey).
 */

import * as fc from "fast-check";
import {
	asUuid,
	type BlueprintDoc,
	type CaseType,
	type Field,
	type Form,
	type Module,
	plainColumn,
	type Uuid,
} from "@/lib/domain";

// ── Stable id minting ──────────────────────────────────────────────

/**
 * A monotonic minter for globally-unique entity UUIDs (React keys, map keys).
 * UUIDs must be globally unique regardless of the semantic-id strategy below;
 * the doc model keys every map on uuid.
 */
class IdMinter {
	private n = 0;
	uuid(prefix: string): Uuid {
		this.n += 1;
		return asUuid(`${prefix}-${this.n.toString(36)}`);
	}
}

/**
 * Semantic ids (the XForm node name / case-property key) are drawn from a tiny
 * fixed pool, NOT minted globally-unique. This is deliberate and load-bearing:
 *
 * CommCare requires SIBLING ids unique but allows COUSINS (fields under
 * different parents) to SHARE an id. The emitter relies on that — it
 * distinguishes same-id cousins by per-level path arithmetic (`/data/a/x` vs
 * `/data/b/x`), the `childParentPath` `/item` rewrite for query_bound repeats,
 * and the itext-key forward-threading (a `<text id="a-x-label">` vs
 * `<text id="b-x-label">`). A generator that mints globally-unique ids never
 * produces a same-id cousin pair, so a bug in any of that path/itext arithmetic
 * is INVISIBLE to it. Drawing ids from a small pool makes cousin collisions
 * frequent, which is the whole point of this gap closure.
 *
 * `pickSiblingId(index)` returns `pool[index]` — siblings of one parent get
 * distinct pool tokens (the caller passes a monotonic per-parent index, capped
 * to the children count which never exceeds the pool size), so sibling
 * uniqueness holds; cousins under different parents reuse the same tokens at
 * the same index, so they collide. The pool tokens are legal XML element names.
 */
const SIBLING_ID_POOL = ["a", "b", "c", "d", "e", "f", "g"] as const;

function pickSiblingId(index: number): string {
	// The child-count bounds in the arbitrary (≤3 random children, +2 injected
	// case fields at the form root → ≤5 siblings) stay under the pool size, so a
	// modulo is never reached in practice; it's a defensive belt so a future
	// bound bump can't silently produce a duplicate sibling id.
	return SIBLING_ID_POOL[index % SIBLING_ID_POOL.length];
}

// ── Palettes ───────────────────────────────────────────────────────

/**
 * Leaf field kinds (everything except the structural `group`/`repeat`). Each
 * lowers to a single `<bind>` + body control, so they exercise the control-ref
 * and bind-nodeset PATH invariants directly.
 */
const LEAF_KINDS = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"geopoint",
	"image",
	"audio",
	"video",
	"barcode",
	"signature",
	"label",
	"secret",
] as const;

/**
 * Leaf kinds that legally carry a `validate` constraint — the field-rule
 * `VALIDATION_ON_NON_INPUT_KIND` rejects it on any other kind. Mirrors
 * `lib/commcare/constants.ts::VALIDATABLE_KINDS`; kept local so the generator
 * stays a self-contained test fixture rather than importing the wire-emission
 * boundary's internals.
 */
const VALIDATABLE_KINDS = new Set<string>([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
]);

/**
 * XPath expressions known to parse cleanly AND to type-check against the
 * domain validator without needing a specific referenced field — every one is
 * self-contained (literals, function calls, comparisons over functions). They
 * land on the `relevant` / `constraint` / `calculate` ANY-expression surfaces
 * and on `repeat_count` (which must be either a path or a hoistable expression).
 */
const SAFE_BOOLEAN_XPATH = [
	"true()",
	"false()",
	"1 = 1",
	"string-length('x') > 0",
] as const;

const SAFE_VALUE_XPATH = [
	"'hello'",
	"now()",
	"today()",
	"concat('a', 'b')",
	"42",
] as const;

/** Count expressions for `count_bound` repeats: a literal (hoisted) or a
 *  function call (hoisted). Both must survive the emitter's hoist path. */
const SAFE_COUNT_XPATH = ["3", "1 + 2", "count(/data)"] as const;

/**
 * Type-matched `default_value` per validatable kind. The domain validator
 * type-checks `default_value` against the field's declared type (a string
 * literal on an `int` field is a `FIELD_KIND_PROPERTY_TYPE_MISMATCH`), so the
 * generator can't hand every kind the same string — it picks the type-correct
 * default here. Each value lowers to a `<setvalue event="xforms-ready">`, so
 * this is what pushes the setvalue ref-PATH / value-parse / event invariants
 * through the emitter for EVERY validatable kind, not just `text`.
 */
const DEFAULT_VALUE_BY_KIND: Record<string, string> = {
	text: "'hello'",
	int: "42",
	decimal: "3.14",
	date: "today()",
	time: "'12:00'",
	datetime: "now()",
	single_select: "'a'",
	multi_select: "'a'",
};

/**
 * Label fragments that stress the itext-escaping path: XML metacharacters that
 * MUST be escaped (`<`, `&`, `>`), markdown syntax, and a hashtag reference
 * (which lowers to an `<output>` — exercising the output value-parse invariant).
 */
const SPICY_LABELS = [
	"Plain label",
	"Weight < 2kg & rising",
	"Enter <country> > <region>",
	"**Bold** _italic_ text",
	"Tom & Jerry",
	"Score: #form/intro",
	"100% sure?",
	"a < b > c & d",
] as const;

// ── Field generation ───────────────────────────────────────────────

/**
 * The accumulator a single form-tree build threads: the flat `fields` map and
 * `fieldOrder` adjacency the normalized doc needs, plus the minter.
 */
interface FieldBuildCtx {
	readonly minter: IdMinter;
	readonly fields: Record<Uuid, Field>;
	readonly fieldOrder: Record<Uuid, Uuid[]>;
}

/**
 * Build one field (possibly a container with children) under `parentUuid`,
 * appending it to the build context. Nesting depth is bounded by the arbitrary
 * (`fieldSpecArb(depth)`), so this lowering simply walks the finished spec.
 * Returns nothing — the field lands in `ctx` by side effect, matching the
 * normalized doc's flat-map shape.
 *
 * `id` is the field's semantic id, assigned by the CALLER from the sibling
 * pool (`pickSiblingId`) so siblings stay unique and cousins can collide — see
 * `SIBLING_ID_POOL`. A container recursively assigns its own children's ids the
 * same way, so cousin collisions occur at every nesting level.
 */
function buildField(
	ctx: FieldBuildCtx,
	parentUuid: Uuid,
	id: string,
	spec: FieldGenSpec,
): void {
	const uuid = ctx.minter.uuid("fld");
	ctx.fieldOrder[parentUuid].push(uuid);

	if (spec.kind === "select") {
		const kind = spec.single ? "single_select" : "multi_select";
		ctx.fields[uuid] = {
			uuid,
			kind,
			id,
			label: spec.label,
			options: spec.options,
			// Selects are validatable kinds; a type-matched `'a'` default exercises
			// the setvalue path for the select shape too.
			...(spec.wantsDefault
				? { default_value: DEFAULT_VALUE_BY_KIND[kind] }
				: {}),
		} as Field;
		return;
	}

	if (spec.kind === "hidden") {
		// hidden MUST carry a value (calculate/default) — HIDDEN_NO_VALUE.
		ctx.fields[uuid] = {
			uuid,
			kind: "hidden",
			id,
			calculate: spec.calculate,
		} as Field;
		return;
	}

	if (spec.kind === "group") {
		ctx.fields[uuid] = {
			uuid,
			kind: "group",
			id,
			label: spec.label,
		} as Field;
		ctx.fieldOrder[uuid] = [];
		spec.children.forEach((childSpec, i) => {
			buildField(ctx, uuid, pickSiblingId(i), childSpec);
		});
		return;
	}

	if (spec.kind === "repeat") {
		const base = { uuid, kind: "repeat" as const, id, label: spec.label };
		let field: Field;
		if (spec.mode === "user_controlled") {
			field = { ...base, repeat_mode: "user_controlled" } as Field;
		} else if (spec.mode === "count_bound") {
			field = {
				...base,
				repeat_mode: "count_bound",
				repeat_count: spec.count,
			} as Field;
		} else {
			field = {
				...base,
				repeat_mode: "query_bound",
				data_source: { ids_query: spec.idsQuery },
			} as Field;
		}
		ctx.fields[uuid] = field;
		ctx.fieldOrder[uuid] = [];
		spec.children.forEach((childSpec, i) => {
			buildField(ctx, uuid, pickSiblingId(i), childSpec);
		});
		return;
	}

	// Leaf kind. Layer the optional XPath surfaces on. Each is gated on the
	// kind that legally carries it so the doc stays schema-valid:
	//   - relevant / required / hint — any input kind.
	//   - validate (+ validate_msg) — only VALIDATABLE_KINDS (the
	//     VALIDATION_ON_NON_INPUT_KIND rule rejects it elsewhere); a boolean
	//     constraint over the node value type-checks for every such kind.
	//   - default_value — every validatable kind, drawing the type-correct
	//     literal from DEFAULT_VALUE_BY_KIND (the validator type-checks
	//     `default_value` against the field type, so the value can't be shared
	//     across kinds).
	// These surfaces matter to the oracle: `validate` lowers to a `constraint=`
	// ANY-expression bind + a `jr:constraintMsg` itext entry; `default_value`
	// lowers to a `<setvalue event="xforms-ready">` (exercising the setvalue
	// ref-PATH / value-parse / event invariants through the emitter, not just
	// hand-built fixtures).
	const validatable = VALIDATABLE_KINDS.has(spec.kind);
	const typedDefault = spec.wantsDefault
		? DEFAULT_VALUE_BY_KIND[spec.kind]
		: undefined;
	ctx.fields[uuid] = {
		uuid,
		kind: spec.kind,
		id,
		label: spec.label,
		...(spec.relevant ? { relevant: spec.relevant } : {}),
		...(spec.required ? { required: spec.required } : {}),
		...(spec.hint ? { hint: spec.hint } : {}),
		...(validatable && spec.validate
			? { validate: spec.validate, validate_msg: spec.validateMsg }
			: {}),
		// `default_value` is type-matched per kind (DEFAULT_VALUE_BY_KIND); a
		// kind with no entry simply gets none.
		...(typedDefault ? { default_value: typedDefault } : {}),
	} as Field;
}

// ── Field generation spec (the arbitrary's intermediate shape) ─────

/**
 * A declarative spec the arbitrary produces and `buildField` lowers. Keeping
 * the arbitrary's output a plain data spec (not a `Field` directly) lets the
 * id minting + normalized-map insertion happen in one deterministic pass,
 * which is where sibling-id uniqueness is enforced.
 */
type FieldGenSpec =
	| {
			kind: (typeof LEAF_KINDS)[number];
			label: string;
			relevant?: string;
			required?: string;
			hint?: string;
			validate?: string;
			validateMsg?: string;
			/** When set, attach the kind's type-matched `default_value`. */
			wantsDefault?: boolean;
	  }
	| {
			kind: "select";
			single: boolean;
			label: string;
			options: ReadonlyArray<{ value: string; label: string }>;
			/** When set, attach the select's type-matched `default_value`. */
			wantsDefault?: boolean;
	  }
	| { kind: "hidden"; calculate: string }
	| { kind: "group"; label: string; children: FieldGenSpec[] }
	| (
			| {
					kind: "repeat";
					mode: "user_controlled";
					label: string;
					children: FieldGenSpec[];
			  }
			| {
					kind: "repeat";
					mode: "count_bound";
					label: string;
					count: string;
					children: FieldGenSpec[];
			  }
			| {
					kind: "repeat";
					mode: "query_bound";
					label: string;
					idsQuery: string;
					children: FieldGenSpec[];
			  }
	  );

const labelArb = fc.constantFrom(...SPICY_LABELS);

const leafSpecArb: fc.Arbitrary<FieldGenSpec> = fc.record(
	{
		kind: fc.constantFrom(...LEAF_KINDS),
		label: labelArb,
		relevant: fc.option(fc.constantFrom(...SAFE_BOOLEAN_XPATH), {
			nil: undefined,
		}),
		required: fc.option(fc.constantFrom(...SAFE_BOOLEAN_XPATH), {
			nil: undefined,
		}),
		hint: fc.option(labelArb, { nil: undefined }),
		// `validate` is a boolean constraint over the node value; `validateMsg`
		// is the paired itext message. `buildField` only attaches them on a
		// VALIDATABLE_KIND, so generating them on every leaf is safe — they're
		// dropped on the kinds that can't carry them.
		validate: fc.option(fc.constantFrom(...SAFE_BOOLEAN_XPATH), {
			nil: undefined,
		}),
		validateMsg: fc.option(labelArb, { nil: undefined }),
		// When true, `buildField` attaches the kind's type-matched default
		// (DEFAULT_VALUE_BY_KIND) — exercising the `<setvalue>` path for every
		// validatable kind, not just `text`.
		wantsDefault: fc.boolean(),
	},
	{ requiredKeys: ["kind", "label"] },
);

const selectSpecArb: fc.Arbitrary<FieldGenSpec> = fc
	.record({
		single: fc.boolean(),
		label: labelArb,
		// ≥2 options; option values are drawn from a small set so duplicates
		// occur naturally (legal in CommCare — only presence is required).
		options: fc.array(
			fc.record({
				value: fc.constantFrom("a", "b", "c", "yes", "no"),
				label: labelArb,
			}),
			{ minLength: 2, maxLength: 4 },
		),
		wantsDefault: fc.boolean(),
	})
	.map((r) => ({ kind: "select", ...r }));

const hiddenSpecArb: fc.Arbitrary<FieldGenSpec> = fc
	.constantFrom(...SAFE_VALUE_XPATH)
	.map((calculate) => ({ kind: "hidden", calculate }));

/**
 * A container (group or repeat) spec, recursive up to `depth`. Children draw
 * from leaf/select/hidden plus (when depth allows) nested containers.
 */
function containerSpecArb(depth: number): fc.Arbitrary<FieldGenSpec> {
	const childArb = fieldSpecArb(depth - 1);
	const children = fc.array(childArb, { minLength: 1, maxLength: 3 });
	const groupArb: fc.Arbitrary<FieldGenSpec> = fc
		.record({ label: labelArb, children })
		.map((r) => ({ kind: "group", ...r }));

	const repeatArb: fc.Arbitrary<FieldGenSpec> = fc.oneof(
		fc
			.record({ label: labelArb, children })
			.map((r) => ({ kind: "repeat", mode: "user_controlled" as const, ...r })),
		fc
			.record({
				label: labelArb,
				count: fc.constantFrom(...SAFE_COUNT_XPATH),
				children,
			})
			.map((r) => ({ kind: "repeat", mode: "count_bound" as const, ...r })),
		fc
			.record({
				label: labelArb,
				idsQuery: fc.constantFrom(
					"instance('casedb')/casedb/case/@case_id",
					"/data",
				),
				children,
			})
			.map((r) => ({ kind: "repeat", mode: "query_bound" as const, ...r })),
	);

	return fc.oneof(groupArb, repeatArb);
}

/** Any field spec, leaf-biased; containers only when `depth > 0`. */
function fieldSpecArb(depth: number): fc.Arbitrary<FieldGenSpec> {
	const leaves = fc.oneof(leafSpecArb, selectSpecArb, hiddenSpecArb);
	if (depth <= 0) return leaves;
	// Bias toward leaves so trees stay shallow and the run is fast, but reach
	// containers often enough to exercise repeat nesting heavily.
	return fc.oneof(
		{ weight: 3, arbitrary: leaves },
		{ weight: 2, arbitrary: containerSpecArb(depth) },
	);
}

// ── Form + module + doc assembly ───────────────────────────────────

const FORM_TYPES = ["registration", "followup", "close", "survey"] as const;

/**
 * The arbitrary's top-level shape: a list of modules, each with a case type, a
 * list of forms, and the field-tree specs for each form. The doc is assembled
 * deterministically from this spec so id minting + normalization happen once.
 */
interface DocGenSpec {
	modules: Array<{
		caseType: string;
		caseListColumns: string[];
		forms: Array<{
			type: (typeof FORM_TYPES)[number];
			fields: FieldGenSpec[];
		}>;
	}>;
}

const docGenSpecArb: fc.Arbitrary<DocGenSpec> = fc.record({
	modules: fc.array(
		fc.record({
			caseType: fc.constantFrom("patient", "household", "visit", "service"),
			caseListColumns: fc.constant(["case_name"]),
			forms: fc.array(
				fc.record({
					type: fc.constantFrom(...FORM_TYPES),
					fields: fc.array(fieldSpecArb(2), { minLength: 1, maxLength: 4 }),
				}),
				{ minLength: 1, maxLength: 2 },
			),
		}),
		{ minLength: 1, maxLength: 2 },
	),
});

/**
 * Lower a `DocGenSpec` into a fully normalized, SCHEMA-VALID `BlueprintDoc`.
 *
 * Case-bearing forms (registration/followup/close) get a guaranteed
 * `case_name` text field saving to the module's case type, plus every leaf
 * field wired to save a property on that type — this satisfies the
 * registration case-name requirement and gives the case list a real property
 * to show. Survey forms carry no case actions. The module always declares a
 * single `case_name` case-list column, satisfying MISSING_CASE_LIST_COLUMNS.
 */
function lowerToDoc(spec: DocGenSpec): BlueprintDoc {
	const minter = new IdMinter();
	const modules: Record<Uuid, Module> = {};
	const forms: Record<Uuid, Form> = {};
	const fields: Record<Uuid, Field> = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: Record<Uuid, Uuid[]> = {};
	const fieldOrder: Record<Uuid, Uuid[]> = {};
	const caseTypeNames = new Set<string>();

	spec.modules.forEach((modSpec, mIdx) => {
		const moduleUuid = minter.uuid("mod");
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];
		caseTypeNames.add(modSpec.caseType);

		modules[moduleUuid] = {
			uuid: moduleUuid,
			id: `m${mIdx}`,
			name: `Module ${mIdx}`,
			caseType: modSpec.caseType,
			caseListConfig: {
				columns: modSpec.caseListColumns.map((field) =>
					plainColumn(minter.uuid("col"), field, field),
				),
				searchInputs: [],
			},
		};

		modSpec.forms.forEach((formSpec, fIdx) => {
			const formUuid = minter.uuid("frm");
			formOrder[moduleUuid].push(formUuid);
			fieldOrder[formUuid] = [];

			forms[formUuid] = {
				uuid: formUuid,
				id: `f${mIdx}_${fIdx}`,
				name: `Form ${mIdx}-${fIdx}`,
				type: formSpec.type,
			};

			const ctx: FieldBuildCtx = { minter, fields, fieldOrder };

			// Case-bearing forms need a case_name field (NO_CASE_NAME_FIELD) AND
			// at least one real case property (REGISTRATION_NO_CASE_PROPS — the
			// name doesn't count as a saved property). Inject both first so every
			// case-bearing form is valid regardless of what random fields follow.
			if (formSpec.type !== "survey") {
				const caseNameUuid = minter.uuid("fld");
				fieldOrder[formUuid].push(caseNameUuid);
				fields[caseNameUuid] = {
					uuid: caseNameUuid,
					kind: "text",
					id: "case_name",
					label: "Case name",
					case_property_on: modSpec.caseType,
				} as Field;

				const propUuid = minter.uuid("fld");
				fieldOrder[formUuid].push(propUuid);
				fields[propUuid] = {
					uuid: propUuid,
					kind: "int",
					// A fixed reserved id OUTSIDE `SIBLING_ID_POOL` so it never
					// collides with a pool-assigned random root sibling.
					id: "saved_prop",
					label: "A saved property",
					case_property_on: modSpec.caseType,
				} as Field;
			}

			// Random root fields draw ids from the sibling pool. Cousins under
			// DIFFERENT forms / containers reuse the same tokens at the same
			// index, producing the same-id cousin pairs the emitter's path +
			// itext arithmetic must disambiguate.
			//
			// NOTE — case-block injection coverage. We deliberately do NOT wire
			// random fields to `case_property_on` here. Nova derives case-property
			// WRITERS from `field.id` matching a case-property name (a field's id
			// IS the case-property name it saves to), so wiring a pool-id root
			// field (say `c`) retroactively makes EVERY
			// same-id cousin a derived writer of property `c` — including media-kind
			// cousins inside a group/repeat, which then trip `MEDIA_CASE_PROPERTY`.
			// Cousin id-sharing (the load-bearing gap closure) and id-as-property
			// are fundamentally in tension; random wiring can't be made safe without
			// renaming fields off the pool, which would defeat the cousin coverage.
			// The always-injected `case_name` + `saved_prop` already drive
			// `<case><create>` + `<case><update>` injection on EVERY case-bearing
			// form, and the `compileCcz` fuzz property exercises the post-injection
			// oracle re-check; the injected `<bind .../update/X>` markup is
			// kind-independent, so richer wiring adds no oracle coverage.
			formSpec.fields.forEach((fieldSpec, i) => {
				buildField(ctx, formUuid, pickSiblingId(i), fieldSpec);
			});
		});
	});

	const caseTypes: CaseType[] = [...caseTypeNames].map((name) => ({
		name,
		properties: [{ name: "case_name", label: "Name" }],
	}));

	return {
		appId: "fuzz-app",
		appName: "Fuzz App",
		connectType: null,
		caseTypes,
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
		// fieldParent is rebuilt by the caller via rebuildFieldParent — the
		// fuzz test owns that step so this stays a pure lowering.
		fieldParent: {},
	};
}

/**
 * The public arbitrary: a normalized `BlueprintDoc`. `fieldParent` is left
 * empty here; the fuzz test calls `rebuildFieldParent` before validating, which
 * is the same bootstrap `buildDoc` performs.
 */
export const blueprintDocArbitrary: fc.Arbitrary<BlueprintDoc> =
	docGenSpecArb.map(lowerToDoc);
