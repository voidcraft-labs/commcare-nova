/**
 * fast-check arbitrary that generates schema-valid `BlueprintDoc`s for the
 * SUITE oracle fuzzer.
 *
 * Suite validity is about MODULE-level configuration and CROSS-MODULE
 * references — the surfaces the XForm-oracle generator (`xformDocArbitrary.ts`)
 * deliberately holds fixed (it hardcodes `caseListColumns=["case_name"]` and
 * never emits a `caseSearchConfig`). This generator builds on that generator's
 * field/form-tree machinery (imported, not forked — the XForm fuzzer keeps its
 * own generator unchanged) and layers the module-level variation the suite
 * emitter's cross-reference checks need:
 *
 *   - **1–4 modules per app** — exercises multi-module menu→command resolution
 *     and the per-module detail-id namespace (`m{N}_case_short` etc.).
 *   - **Typed case-type properties** — each module declares a pool of
 *     properties of varied `data_type`s (text / int / decimal / date /
 *     datetime / single_select), so columns reference real typed properties and
 *     the sort-comparator derivation exercises every `SortType` arm.
 *   - **A mix of all six column kinds** — plain / date / phone / id-mapping /
 *     interval / calculated. Date columns target date-typed properties; the
 *     rest target the appropriately-typed pool entry. Calculated columns carry
 *     a `concat`/`prop` expression that resolves.
 *   - **Per-column sort directives** on a subset of columns, with unique
 *     priorities — exercises `<sort>` order/direction/type emission (the
 *     silently-tolerated category) across the multi-key path.
 *   - **Optional `caseSearchConfig`** with a mix of simple-arm and advanced-arm
 *     search inputs spanning all five `SearchInputType` widget kinds, an
 *     optional filter, and the `defaultSearch` shape (filter present, zero
 *     inputs) — exercises `<remote-request>` / `<query>` / `<prompt>` /
 *     instance accumulation / `<stack>` rewind.
 *   - **Parent→child module pairs** — a child module whose case type declares
 *     the parent module's type as `parent_type`, with a registration form
 *     creating the child case — exercises the cross-module case relationship
 *     and the `MISSING_CHILD_CASE_MODULE` validator gate.
 *
 * Like the XForm generator, this is CONSTRUCTIVE (valid by construction), and
 * the fuzz test re-asserts `runValidation(doc).length === 0` at the top of every
 * property body so a generator slip fails loud as a generator bug, not a silent
 * skip.
 */

import * as fc from "fast-check";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	type CaseListConfig,
	type CaseProperty,
	type CaseSearchConfig,
	type CaseType,
	type Column,
	calculatedColumn,
	dateColumn,
	type Field,
	type Form,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	type Module,
	phoneColumn,
	plainColumn,
	type SearchInputDef,
	type SearchInputType,
	simpleSearchInputDef,
	startsWithMode,
	type Uuid,
} from "@/lib/domain";
import {
	concat,
	eq,
	input,
	literal,
	prop,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import {
	buildField,
	type FieldBuildCtx,
	type FieldGenSpec,
	fieldSpecArb,
	IdMinter,
	pickSiblingId,
} from "./xformDocArbitrary";

// ── Typed case-property pool ───────────────────────────────────────

/**
 * The fixed pool of typed case properties every module declares. Columns +
 * search inputs reference these by name, so each column kind can target a
 * property of the right `data_type` (the validator gates date columns to date-
 * shaped properties, range modes to ordered types, etc.). Keeping the pool
 * fixed (rather than generating property names) means a column's `field`
 * reference always resolves — the `CASE_LIST_COLUMN_UNKNOWN_FIELD` rule can't
 * trip on a typo.
 *
 * `case_name` is CommCare-standard (not declared here) and always available.
 */
const PROPERTY_POOL: ReadonlyArray<{
	readonly name: string;
	readonly dataType: CaseProperty["data_type"];
}> = [
	{ name: "full_name", dataType: "text" },
	{ name: "age", dataType: "int" },
	{ name: "weight", dataType: "decimal" },
	{ name: "visit_date", dataType: "date" },
	{ name: "last_seen", dataType: "datetime" },
	{ name: "phone_number", dataType: "text" },
	{ name: "status_code", dataType: "single_select" },
];

/** The declared `CaseProperty[]` form of the pool, shared by every case type. */
function poolProperties(): CaseProperty[] {
	return PROPERTY_POOL.map((p) => ({
		name: p.name,
		label: p.name,
		data_type: p.dataType,
	}));
}

const TEXT_PROPS = PROPERTY_POOL.filter((p) => p.dataType === "text").map(
	(p) => p.name,
);
const DATE_PROPS = PROPERTY_POOL.filter(
	(p) => p.dataType === "date" || p.dataType === "datetime",
).map((p) => p.name);

// ── Column generation ──────────────────────────────────────────────

/**
 * A column spec the assembler lowers to a `Column` (assigning the uuid + sort
 * priority deterministically). Kept as a plain spec so id minting + priority
 * assignment happen in one pass, like the field-tree builder.
 */
type ColumnGenSpec =
	| { kind: "plain"; field: string }
	| { kind: "date"; field: string }
	| { kind: "phone"; field: string }
	| { kind: "id-mapping"; field: string }
	| { kind: "interval"; field: string }
	| { kind: "calculated" };

/**
 * Generate a single column spec. Date columns draw a date-shaped property;
 * interval columns also need a date-shaped property (the wire computes a day
 * delta off it); the rest draw any pool property.
 */
const columnSpecArb: fc.Arbitrary<ColumnGenSpec> = fc.oneof(
	fc
		.constantFrom(...TEXT_PROPS, "full_name", "age")
		.map((field): ColumnGenSpec => ({ kind: "plain", field })),
	fc.constantFrom(...DATE_PROPS).map(
		(field): ColumnGenSpec => ({
			kind: "date",
			field,
		}),
	),
	fc.constantFrom(...TEXT_PROPS).map(
		(field): ColumnGenSpec => ({
			kind: "phone",
			field,
		}),
	),
	fc.constantFrom("status_code").map(
		(field): ColumnGenSpec => ({
			kind: "id-mapping",
			field,
		}),
	),
	fc.constantFrom(...DATE_PROPS).map(
		(field): ColumnGenSpec => ({
			kind: "interval",
			field,
		}),
	),
	fc.constant<ColumnGenSpec>({ kind: "calculated" }),
);

/**
 * Lower a column spec to a `Column`, assigning the column's uuid and — when
 * `sortPriority` is non-null — a sort directive at that priority. The
 * priorities the assembler hands in are unique within the module (the sort-
 * priority-uniqueness validator rule), so the lowering simply attaches them.
 */
function lowerColumn(
	minter: IdMinter,
	spec: ColumnGenSpec,
	sortPriority: number | null,
	caseType: string,
): Column {
	const uuid = minter.uuid("col");
	const sortSlot =
		sortPriority !== null
			? {
					sort: {
						direction:
							sortPriority % 2 === 0 ? ("asc" as const) : ("desc" as const),
						priority: sortPriority,
					},
				}
			: {};

	switch (spec.kind) {
		case "plain":
			return plainColumn(uuid, spec.field, spec.field, sortSlot);
		case "date":
			return dateColumn(uuid, spec.field, spec.field, "%Y-%m-%d", sortSlot);
		case "phone":
			return phoneColumn(uuid, spec.field, spec.field, sortSlot);
		case "id-mapping":
			return idMappingColumn(
				uuid,
				spec.field,
				spec.field,
				[idMappingEntry("a", "Active"), idMappingEntry("i", "Inactive")],
				sortSlot,
			);
		case "interval":
			// `intervalColumn(uuid, field, header, threshold, unit, display, text,
			// slots)` — `display: "flag"` exercises the LateFlag wire arm, `text`
			// is the overdue label.
			return intervalColumn(
				uuid,
				spec.field,
				spec.field,
				3,
				"days",
				"flag",
				"Overdue",
				sortSlot,
			);
		case "calculated":
			// `concat(prop(caseType, 'full_name'), ' ')` resolves to text — a clean
			// calc-column expression the type checker accepts. The property
			// reference must be scoped to the current case type (self-scope) or the
			// `CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR` rule rejects it.
			return calculatedColumn(
				uuid,
				"Computed",
				concat(term(prop(caseType, "full_name")), term(literal(" "))),
				sortSlot,
			);
	}
}

// ── Search-input generation ────────────────────────────────────────

/**
 * A search-input spec the assembler lowers to a `SearchInputDef`. Simple-arm
 * specs carry a `(type, property)` shape with a wire-default mode; the advanced
 * arm carries a `when-input-present`-wrapped predicate (the validator's
 * `searchInputRefUsesWhenInputPresent` rule requires the envelope).
 */
type SearchInputGenSpec =
	| { arm: "simple"; type: SearchInputType; property: string }
	| { arm: "simple-startswith"; property: string }
	| { arm: "advanced" };

/**
 * Generate one search-input spec. The simple arm spans every `SearchInputType`
 * widget kind against a type-compatible property (text/barcode → text props;
 * date → date prop; select → the select prop; date-range → date prop). The
 * `simple-startswith` arm exercises the `_xpath_query` + `exclude="true()"`
 * routing (a non-`exact` mode). The advanced arm exercises the verbatim-
 * predicate path with an `input(...)` reference.
 */
const searchInputSpecArb: fc.Arbitrary<SearchInputGenSpec> = fc.oneof(
	fc.constantFrom(...TEXT_PROPS).map(
		(property): SearchInputGenSpec => ({
			arm: "simple",
			type: "text",
			property,
		}),
	),
	// The `select` widget type is intentionally absent: the validator's
	// `searchInputSelectWidgetNotSupported` rule rejects it because Nova's wire
	// `<prompt>` has no `<itemset>` slot, so CCHQ-core's `QueryPrompt.isSelect()`
	// would fall back to a text input. A `select`-typed search input is not a
	// schema-valid shape today; generating one would only trip the generator's
	// own validity guard, not exercise the suite emitter.
	fc.constantFrom(...DATE_PROPS).map(
		(property): SearchInputGenSpec => ({
			arm: "simple",
			type: "date",
			property,
		}),
	),
	fc.constantFrom(...DATE_PROPS).map(
		(property): SearchInputGenSpec => ({
			arm: "simple",
			type: "date-range",
			property,
		}),
	),
	fc.constantFrom(...TEXT_PROPS).map(
		(property): SearchInputGenSpec => ({
			arm: "simple",
			type: "barcode",
			property,
		}),
	),
	fc.constantFrom(...TEXT_PROPS).map(
		(property): SearchInputGenSpec => ({
			arm: "simple-startswith",
			property,
		}),
	),
	fc.constant<SearchInputGenSpec>({ arm: "advanced" }),
);

/**
 * Lower a search-input spec to a `SearchInputDef`, minting its uuid. Simple-arm
 * inputs name the prompt after the targeted property (`name === property`):
 * the `searchInputViaModeCompatibility` rule requires this for the `range` mode
 * the `date-range` widget defaults to, and it keeps every simple arm on the
 * bare-prompt or self-via route the validator accepts. The advanced arm uses a
 * unique `search_{index}` name (its predicate references `input(name)`
 * internally, so the name only has to be module-unique). The caller dedups
 * simple-arm specs by property so two prompt keys never collide.
 */
function lowerSearchInput(
	minter: IdMinter,
	spec: SearchInputGenSpec,
	index: number,
	caseType: string,
): SearchInputDef {
	const uuid = minter.uuid("si");
	switch (spec.arm) {
		case "simple":
			// Prompt key === targeted property: the only simple-arm shape `range`
			// (the date-range default) admits, and a clean self-match for the
			// others.
			return simpleSearchInputDef(
				uuid,
				spec.property,
				spec.property,
				spec.type,
				spec.property,
			);
		case "simple-startswith":
			// `starts-with` is a text-only mode that routes through `_xpath_query`
			// with `exclude="true()"` — exercises the simple-arm derivation path.
			// Name === property keeps the prompt key matched while the explicit
			// predicate carries the prefix comparison.
			return simpleSearchInputDef(
				uuid,
				spec.property,
				spec.property,
				"text",
				spec.property,
				{ mode: startsWithMode() },
			);
		case "advanced": {
			// A `when-input-present`-wrapped equality against a text property: the
			// canonical advanced shape the validator accepts (the bare `input(...)`
			// ref must sit inside the envelope). The advanced arm's name is
			// index-keyed since its predicate references its own `input(name)`.
			const name = `adv_${index}`;
			// `whenInput(inputRef, clause)` — the first arg is a `SearchInputRef`
			// (`input(name)`), not a bare string. The envelope gates the inner
			// comparison on the input being present so the bare `input(...)` ref
			// inside the clause passes `searchInputRefUsesWhenInputPresent`.
			return advancedSearchInputDef(
				uuid,
				name,
				name,
				"text",
				whenInput(
					input(name),
					eq(term(prop(caseType, "full_name")), term(input(name))),
				),
			);
		}
	}
}

// ── Module + form + doc assembly ───────────────────────────────────

/**
 * Per-module spec: the case-bearing form trees, the column specs, how many of
 * the columns sort, and whether a `caseSearchConfig` is present (and in what
 * shape). `isChild` marks a module whose case type declares the previous
 * module's type as parent — assembled into a parent→child pair.
 */
interface ModuleGenSpec {
	readonly forms: ReadonlyArray<{
		readonly type: "registration" | "followup" | "close" | "survey";
		readonly fields: FieldGenSpec[];
	}>;
	readonly columns: ColumnGenSpec[];
	readonly sortCount: number;
	readonly filter: boolean;
	readonly searchConfig:
		| { present: false }
		| {
				present: true;
				inputs: SearchInputGenSpec[];
				/** `defaultSearch` shape — filter present, zero inputs. */
				defaultSearch: boolean;
				title: boolean;
				excludedOwners: boolean;
		  };
	readonly isChild: boolean;
}

interface DocGenSpec {
	readonly modules: ModuleGenSpec[];
}

const FORM_TYPE_ARB = fc.constantFrom(
	"registration" as const,
	"followup" as const,
	"close" as const,
	"survey" as const,
);

const moduleGenSpecArb: fc.Arbitrary<ModuleGenSpec> = fc.record({
	forms: fc.array(
		fc.record({
			type: FORM_TYPE_ARB,
			// ≥1 random field per form: survey forms get no injected case fields, so
			// a zero-field survey would trip `EMPTY_FORM`. Case-bearing forms always
			// carry the injected `case_name` + `full_name` on top of these.
			fields: fc.array(fieldSpecArb(2), { minLength: 1, maxLength: 3 }),
		}),
		{ minLength: 1, maxLength: 2 },
	),
	columns: fc.array(columnSpecArb, { minLength: 1, maxLength: 5 }),
	sortCount: fc.nat({ max: 4 }),
	filter: fc.boolean(),
	searchConfig: fc.oneof(
		{ weight: 2, arbitrary: fc.constant({ present: false as const }) },
		{
			weight: 1,
			arbitrary: fc.record({
				present: fc.constant(true as const),
				inputs: fc.array(searchInputSpecArb, { minLength: 0, maxLength: 3 }),
				defaultSearch: fc.boolean(),
				title: fc.boolean(),
				excludedOwners: fc.boolean(),
			}),
		},
	),
	isChild: fc.boolean(),
});

const docGenSpecArb: fc.Arbitrary<DocGenSpec> = fc.record({
	modules: fc.array(moduleGenSpecArb, { minLength: 1, maxLength: 4 }),
});

/**
 * Distinct case-type names per module index. A child module's case type is
 * distinct from its parent's; the parent link is wired by setting
 * `parent_type` on the child case type.
 */
const CASE_TYPE_NAMES = ["patient", "household", "visit", "service"] as const;

/** Lower a `DocGenSpec` into a fully-normalized, schema-valid `BlueprintDoc`. */
function lowerToDoc(spec: DocGenSpec): BlueprintDoc {
	const minter = new IdMinter();
	const modules: Record<Uuid, Module> = {};
	const forms: Record<Uuid, Form> = {};
	const fields: Record<Uuid, Field> = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: Record<Uuid, Uuid[]> = {};
	const fieldOrder: Record<Uuid, Uuid[]> = {};
	const caseTypes: CaseType[] = [];

	spec.modules.forEach((modSpec, mIdx) => {
		const caseTypeName = CASE_TYPE_NAMES[mIdx % CASE_TYPE_NAMES.length];
		// A child module (only when there's a prior module to parent to) declares
		// the previous module's case type as its parent. Otherwise it's a root
		// case type.
		const parentType =
			modSpec.isChild && mIdx > 0
				? CASE_TYPE_NAMES[(mIdx - 1) % CASE_TYPE_NAMES.length]
				: undefined;

		caseTypes.push({
			name: caseTypeName,
			properties: poolProperties(),
			...(parentType !== undefined && parentType !== caseTypeName
				? { parent_type: parentType }
				: {}),
		});

		const moduleUuid = minter.uuid("mod");
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];

		// Columns. Assign sort priorities to the first `sortCount` columns (capped
		// to the column count) — unique priorities 0..k-1 satisfy the sort-
		// priority-uniqueness rule.
		const sortCount = Math.min(modSpec.sortCount, modSpec.columns.length);
		const columns: Column[] = modSpec.columns.map((colSpec, i) =>
			lowerColumn(minter, colSpec, i < sortCount ? i : null, caseTypeName),
		);

		// Search inputs — present only on the non-default-search shape. Simple-arm
		// inputs name their prompt after the targeted property, so two simple
		// inputs against the same property would collide on name
		// (`CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME`). Dedup simple-arm specs by
		// property before lowering; advanced-arm specs carry index-keyed names and
		// never collide.
		const searchInputs: SearchInputDef[] = [];
		if (modSpec.searchConfig.present && !modSpec.searchConfig.defaultSearch) {
			const seenProperties = new Set<string>();
			modSpec.searchConfig.inputs.forEach((si, i) => {
				if (si.arm === "simple" || si.arm === "simple-startswith") {
					if (seenProperties.has(si.property)) return;
					seenProperties.add(si.property);
				}
				searchInputs.push(lowerSearchInput(minter, si, i, caseTypeName));
			});
		}

		// Filter — a clean always-on equality the type checker accepts, scoped to
		// the module's case type. A `caseSearchConfig` requires at least one
		// searchable surface (`CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE`): a filter
		// OR ≥1 search input. Force the filter on whenever search is present and
		// no input would otherwise fill that role — that's exactly the
		// `defaultSearch` shape (search button, zero inputs, filter narrows the
		// result set).
		const searchNeedsFilter =
			modSpec.searchConfig.present && searchInputs.length === 0;
		const filter =
			modSpec.filter || searchNeedsFilter
				? eq(term(prop(caseTypeName, "age")), literal(18))
				: undefined;

		const caseListConfig: CaseListConfig = {
			columns,
			searchInputs,
			...(filter !== undefined ? { filter } : {}),
		};

		const caseSearchConfig: CaseSearchConfig | undefined = modSpec.searchConfig
			.present
			? {
					...(modSpec.searchConfig.title
						? { searchScreenTitle: "Find a case" }
						: {}),
					...(modSpec.searchConfig.excludedOwners
						? { excludedOwnerIds: term(literal("owner-1 owner-2")) }
						: {}),
				}
			: undefined;

		modules[moduleUuid] = {
			uuid: moduleUuid,
			id: `m${mIdx}`,
			name: `Module ${mIdx}`,
			caseType: caseTypeName,
			caseListConfig,
			...(caseSearchConfig !== undefined ? { caseSearchConfig } : {}),
		};

		// Forms. Case-bearing forms inject `case_name` + a saved property so they
		// satisfy NO_CASE_NAME_FIELD + REGISTRATION_NO_CASE_PROPS.
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

			if (formSpec.type !== "survey") {
				const caseNameUuid = minter.uuid("fld");
				fieldOrder[formUuid].push(caseNameUuid);
				fields[caseNameUuid] = {
					uuid: caseNameUuid,
					kind: "text",
					id: "case_name",
					label: "Case name",
					case_property_on: caseTypeName,
				} as Field;

				const propUuid = minter.uuid("fld");
				fieldOrder[formUuid].push(propUuid);
				fields[propUuid] = {
					uuid: propUuid,
					kind: "text",
					// A reserved id outside the sibling pool so it never collides with
					// a pool-assigned random root sibling. Saves to the pool's
					// `full_name` text property so calc-column / search references
					// against it resolve to a real writer.
					id: "full_name",
					label: "Full name",
					case_property_on: caseTypeName,
				} as Field;
			}

			// Random root fields draw ids from the sibling pool — same cousin-
			// collision coverage the XForm generator relies on. Not wired to
			// `case_property_on` (see the XForm generator's note on the tension
			// between cousin id-sharing and id-as-property).
			formSpec.fields.forEach((fieldSpec, i) => {
				buildField(ctx, formUuid, pickSiblingId(i), fieldSpec);
			});
		});
	});

	return {
		appId: "suite-fuzz-app",
		appName: "Suite Fuzz App",
		connectType: null,
		caseTypes,
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
		// fieldParent is rebuilt by the caller via rebuildFieldParent.
		fieldParent: {},
	};
}

/**
 * The public arbitrary: a normalized `BlueprintDoc` with rich module-level
 * configuration. `fieldParent` is left empty; the fuzz test calls
 * `rebuildFieldParent` before validating, the same bootstrap `buildDoc` runs.
 */
export const suiteDocArbitrary: fc.Arbitrary<BlueprintDoc> =
	docGenSpecArb.map(lowerToDoc);

// ── Census instrumentation ─────────────────────────────────────────
//
// The fuzz test asserts minimum coverage thresholds after the run — a
// generator that never produces multi-module / case-search / child-case /
// sort docs proves nothing about the cross-reference checks. These predicates
// classify a doc for the census the fuzz test accumulates.

/** Count the modules in a doc. */
export function moduleCount(doc: BlueprintDoc): number {
	return doc.moduleOrder.length;
}

/** Whether any module carries a `caseSearchConfig` (drives `<remote-request>`). */
export function hasCaseSearch(doc: BlueprintDoc): boolean {
	return Object.values(doc.modules).some(
		(m) => m.caseSearchConfig !== undefined,
	);
}

/** Whether any case type declares a `parent_type` (parent→child pair). */
export function hasChildCase(doc: BlueprintDoc): boolean {
	return (doc.caseTypes ?? []).some((ct) => ct.parent_type !== undefined);
}

/** Whether any module's case list carries at least one sorted column. */
export function hasSort(doc: BlueprintDoc): boolean {
	return Object.values(doc.modules).some((m) =>
		(m.caseListConfig?.columns ?? []).some((c) => c.sort !== undefined),
	);
}
