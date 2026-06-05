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
 * chars (`<`, `&`, markdown), relevant/constraint/calculate XPath, the
 * four form types (registration / followup / close / survey), AND CommCare
 * Connect emission — a fraction of generated docs are Connect apps
 * (`connectType` "learn" / "deliver"), each form carrying a valid `connect`
 * block so the emitter's `buildConnectBlocks` path is exercised. The Connect
 * sub-config ids are minted globally-unique inline (the `runValidation`
 * guardrail does NOT run the validate-time autofill, so an id-less block would
 * trip the connect-id rules); the deliver `entity_id` / `entity_name` slots
 * are left unset on purpose so the wire-emit defaults in `builder.ts` run.
 */

import * as fc from "fast-check";
import {
	asUuid,
	type BlueprintDoc,
	type CaseType,
	type ConnectConfig,
	type ConnectType,
	type Field,
	type Form,
	type Media,
	type Module,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { type AssetId, asAssetId } from "@/lib/domain/multimedia";

// ── Stable id minting ──────────────────────────────────────────────

/**
 * A monotonic minter for globally-unique entity UUIDs (React keys, map keys).
 * UUIDs must be globally unique regardless of the semantic-id strategy below;
 * the doc model keys every map on uuid.
 */
export class IdMinter {
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

export function pickSiblingId(index: number): string {
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
	// barcode serializes as xsd:string (a scanned default the device can
	// overwrite); geopoint takes a "lat lon alt accuracy" string. Both lower
	// to a `<setvalue>` like the others — covering their setvalue path.
	barcode: "'CODE-123'",
	geopoint: "'0 0 0 0'",
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
export interface FieldBuildCtx {
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
export function buildField(
	ctx: FieldBuildCtx,
	parentUuid: Uuid,
	id: string,
	spec: FieldGenSpec,
): void {
	const uuid = ctx.minter.uuid("fld");
	ctx.fieldOrder[parentUuid].push(uuid);

	if (spec.kind === "select") {
		const kind = spec.single ? "single_select" : "multi_select";
		const labelMedia = buildMediaSlot(ctx.minter, spec.media?.label);
		// Selects don't carry the input-specific media slots (hint/help/
		// validate_msg media live on the input-field base); only label_media.
		// Per-option media is layered onto each option below.
		const options = spec.options.map((opt, idx) => {
			const optMedia = buildMediaSlot(ctx.minter, spec.optionMedia?.[idx]);
			return optMedia ? { ...opt, media: optMedia } : opt;
		});
		ctx.fields[uuid] = {
			uuid,
			kind,
			id,
			label: spec.label,
			options,
			// Selects are validatable kinds; a type-matched `'a'` default exercises
			// the setvalue path for the select shape too.
			...(spec.wantsDefault
				? { default_value: DEFAULT_VALUE_BY_KIND[kind] }
				: {}),
			...(labelMedia ? { label_media: labelMedia } : {}),
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

	// Media-slot lowering. The schema only carries `validate_msg_media` on
	// validatable kinds (via the `inputFieldBaseSchema` union), so the
	// validate_msg-slot is gated on `validatable` just like `validate_msg`.
	// The other slots (`label_media` / `hint_media` / `help_media`) live on
	// every input field, so they attach uniformly.
	const labelMedia = buildMediaSlot(ctx.minter, spec.media?.label);
	const hintMedia = buildMediaSlot(ctx.minter, spec.media?.hint);
	const helpMedia = buildMediaSlot(ctx.minter, spec.media?.help);
	const validateMsgMedia =
		validatable && spec.validate
			? buildMediaSlot(ctx.minter, spec.media?.validateMsg)
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
		...(labelMedia ? { label_media: labelMedia } : {}),
		...(hintMedia ? { hint_media: hintMedia } : {}),
		...(helpMedia ? { help_media: helpMedia } : {}),
		...(validateMsgMedia ? { validate_msg_media: validateMsgMedia } : {}),
	} as Field;
}

/**
 * Inject a repeat at the form root containing exactly one child case
 * `case_name` field. The injection drives the path-aware splice
 * algorithm in `xform/caseBlocks.ts::addCaseBlocks` across all three
 * repeat modes — the `nest=false` branch (single subcase per repeat)
 * fires for every injected shape, and `query_bound` exercises the
 * `/item` segment in both `findField`'s resolved path AND the bind
 * nodesets.
 *
 * The repeat id `children` and the child field id `case_name` are
 * OFF the sibling pool (`SIBLING_ID_POOL`), so they can't collide
 * with any random root-level pool field nor with cousins under
 * different forms.
 */
function injectSubcaseRepeat(
	ctx: FieldBuildCtx,
	formUuid: Uuid,
	spec: SubcaseShapeSpec,
): void {
	const repeatUuid = ctx.minter.uuid("fld");
	ctx.fieldOrder[formUuid].push(repeatUuid);
	const repeatBase = {
		uuid: repeatUuid,
		kind: "repeat" as const,
		id: "children",
		label: "Children",
	};
	let repeatField: Field;
	if (spec.mode === "user_controlled") {
		repeatField = { ...repeatBase, repeat_mode: "user_controlled" } as Field;
	} else if (spec.mode === "count_bound") {
		repeatField = {
			...repeatBase,
			repeat_mode: "count_bound",
			repeat_count: "3",
		} as Field;
	} else {
		repeatField = {
			...repeatBase,
			repeat_mode: "query_bound",
			data_source: {
				ids_query: `instance('casedb')/casedb/case[@case_type='${spec.childCaseType}']/@case_id`,
			},
		} as Field;
	}
	ctx.fields[repeatUuid] = repeatField;
	ctx.fieldOrder[repeatUuid] = [];

	// The single child field carries the new case_name source for the
	// derived child-case bucket. `case_property_on` matches the
	// childCaseType so deriveCaseConfig groups this field into a
	// (childCaseType, repeatUuid) bucket — distinct from any other
	// child-case bucket the doc carries.
	const childFieldUuid = ctx.minter.uuid("fld");
	ctx.fieldOrder[repeatUuid].push(childFieldUuid);
	ctx.fields[childFieldUuid] = {
		uuid: childFieldUuid,
		kind: "text",
		id: "case_name",
		label: "Child name",
		case_property_on: spec.childCaseType,
	} as Field;
}

// ── Field generation spec (the arbitrary's intermediate shape) ─────

/**
 * A declarative spec the arbitrary produces and `buildField` lowers. Keeping
 * the arbitrary's output a plain data spec (not a `Field` directly) lets the
 * id minting + normalized-map insertion happen in one deterministic pass,
 * which is where sibling-id uniqueness is enforced.
 */
/**
 * Optional media populations the lowering attaches to a field. Each `1` slot
 * means "emit a fresh `AssetId` here"; the lowering mints the id at build
 * time via the shared `IdMinter`, so every asset id is globally unique and
 * conforms to `uuidSchema`. Slots default to no media — leaving the doc
 * media-free is the common shape.
 */
export interface FieldMediaSpec {
	readonly label?: ReadonlyArray<"image" | "audio" | "video">;
	readonly hint?: ReadonlyArray<"image" | "audio" | "video">;
	readonly help?: ReadonlyArray<"image" | "audio" | "video">;
	readonly validateMsg?: ReadonlyArray<"image" | "audio" | "video">;
}

/**
 * Optional media population for each select option, parallel-indexed to
 * the spec's `options` array. Each present entry mints the listed slots.
 */
export type OptionMediaSpec = ReadonlyArray<
	ReadonlyArray<"image" | "audio" | "video"> | undefined
>;

export type FieldGenSpec =
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
			/** Optional `label_media`/`hint_media`/`help_media`/`validate_msg_media`
			 *  populations. Slot kinds drawn from `image`/`audio`/`video`. */
			media?: FieldMediaSpec;
	  }
	| {
			kind: "select";
			single: boolean;
			label: string;
			options: ReadonlyArray<{ value: string; label: string }>;
			/** When set, attach the select's type-matched `default_value`. */
			wantsDefault?: boolean;
			/** Optional `label_media` for the question itself. */
			media?: FieldMediaSpec;
			/** Per-option media, indexed parallel to `options`. */
			optionMedia?: OptionMediaSpec;
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

// ── Media spec generation ──────────────────────────────────────────

/**
 * Single-slot media kind palette. Each slot independently rolls "present
 * with kind K" or "absent", so a field can carry any combination
 * (image-only, image+audio, all three, none). The empty-slot result keeps
 * the doc media-free at the field by leaving the slot undefined — the
 * lowering only stamps a slot when at least one kind is present.
 */
const MEDIA_KIND_SET_ARB: fc.Arbitrary<
	ReadonlyArray<"image" | "audio" | "video"> | undefined
> = fc
	.tuple(fc.boolean(), fc.boolean(), fc.boolean())
	.map(([img, aud, vid]) => {
		const kinds: Array<"image" | "audio" | "video"> = [];
		if (img) kinds.push("image");
		if (aud) kinds.push("audio");
		if (vid) kinds.push("video");
		return kinds.length === 0 ? undefined : kinds;
	});

/**
 * Optional media population for a leaf field. Roughly half of leaves get
 * NO media populated at all (`undefined`); the other half rolls each of
 * the four message slots independently. Coverage skews to media-OFF docs
 * because that's the baseline most existing tests assume — the media-ON
 * mix is dense enough to exercise the manifest-resolution path in every
 * fuzz run while staying under the 500-run budget.
 */
const FIELD_MEDIA_SPEC_ARB: fc.Arbitrary<FieldMediaSpec | undefined> = fc.oneof(
	{ weight: 3, arbitrary: fc.constant(undefined) },
	{
		weight: 2,
		arbitrary: fc
			.record({
				label: MEDIA_KIND_SET_ARB,
				hint: MEDIA_KIND_SET_ARB,
				help: MEDIA_KIND_SET_ARB,
				validateMsg: MEDIA_KIND_SET_ARB,
			})
			.map((spec) => ({
				...(spec.label ? { label: spec.label } : {}),
				...(spec.hint ? { hint: spec.hint } : {}),
				...(spec.help ? { help: spec.help } : {}),
				...(spec.validateMsg ? { validateMsg: spec.validateMsg } : {}),
			})),
	},
);

/**
 * Mint a `Media` slot bundle from the requested kinds, drawing each id from
 * the shared `IdMinter`. Returns `undefined` when no kinds are requested so
 * the caller can omit the slot entirely (the schema treats the absent and
 * empty-object cases as identical, but undefined keeps the JSON shape clean).
 */
function buildMediaSlot(
	minter: IdMinter,
	kinds: ReadonlyArray<"image" | "audio" | "video"> | undefined,
): Media | undefined {
	if (!kinds || kinds.length === 0) return undefined;
	const slot: { image?: AssetId; audio?: AssetId; video?: AssetId } = {};
	for (const kind of kinds) {
		// AssetId is a branded plain-string (`assetIdSchema = z.string().min(1)`);
		// the minter emits ids of shape `<prefix>-<base36>` which satisfies the
		// non-empty constraint and brands cleanly via `asAssetId`.
		slot[kind] = asAssetId(minter.uuid(`media${kind[0]}`));
	}
	return slot;
}

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
		// Optional media populations for the four message slots. `buildField`
		// gates `validate_msg_media` on `validatable && validate` so the rolled
		// slot is dropped on non-validatable kinds and absent-validate cases.
		media: FIELD_MEDIA_SPEC_ARB,
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
		media: FIELD_MEDIA_SPEC_ARB,
	})
	.chain((r) =>
		// Roll per-option media in lockstep with the options array — each option
		// independently has a chance of carrying image/audio/video. Done in a
		// `chain` so the rolled length matches the options length exactly.
		fc
			.tuple(...r.options.map(() => MEDIA_KIND_SET_ARB))
			.map((perOption): FieldGenSpec => {
				const optionMedia = perOption.some((p) => p !== undefined)
					? perOption
					: undefined;
				return {
					kind: "select",
					...r,
					...(optionMedia ? { optionMedia } : {}),
				};
			}),
	);

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
		.map((r) => ({ kind: "group" as const, ...r }));

	const repeatArb: fc.Arbitrary<FieldGenSpec> = fc.oneof(
		fc.record({ label: labelArb, children }).map((r) => ({
			kind: "repeat" as const,
			mode: "user_controlled" as const,
			...r,
		})),
		fc
			.record({
				label: labelArb,
				count: fc.constantFrom(...SAFE_COUNT_XPATH),
				children,
			})
			.map((r) => ({
				kind: "repeat" as const,
				mode: "count_bound" as const,
				...r,
			})),
		fc
			.record({
				label: labelArb,
				idsQuery: fc.constantFrom(
					"instance('casedb')/casedb/case/@case_id",
					"/data",
				),
				children,
			})
			.map((r) => ({
				kind: "repeat" as const,
				mode: "query_bound" as const,
				...r,
			})),
	);

	return fc.oneof(groupArb, repeatArb);
}

/** Any field spec, leaf-biased; containers only when `depth > 0`. */
export function fieldSpecArb(depth: number): fc.Arbitrary<FieldGenSpec> {
	const leaves = fc.oneof(leafSpecArb, selectSpecArb, hiddenSpecArb);
	if (depth <= 0) return leaves;
	// Bias toward leaves so trees stay shallow and the run is fast, but reach
	// containers often enough to exercise repeat nesting heavily.
	return fc.oneof(
		{ weight: 3, arbitrary: leaves },
		{ weight: 2, arbitrary: containerSpecArb(depth) },
	);
}

// ── Connect config generation ──────────────────────────────────────

/**
 * Per-form Connect sub-config selection, mode-discriminated.
 *
 * A Connect app's `connectType` ("learn" / "deliver") picks which sub-config
 * kinds are LIVE — the emitter (`buildConnectSlugMap`) only ships blocks
 * matching the mode, and the validator's `CONNECT_MISSING_LEARN` /
 * `CONNECT_MISSING_DELIVER` rules require ≥1 live sub-config per form. So each
 * form on a Connect doc carries one of the legal shapes for its mode:
 *   - learn  → learn_module, assessment, or both;
 *   - deliver→ deliver_unit, task, or both.
 * Both kinds are independent (the "sub-configs are independent" contract), so
 * the "both" shape exercises two co-located blocks emitting as `<data>`
 * siblings — the case `buildConnectBlocks` lays out under one `<data>` parent.
 *
 * Scalar slots (name / description / time_estimate / user_score) are filled
 * here because the schema requires them and nothing auto-fills them on the
 * `runValidation` path. The deliver `entity_id` / `entity_name` are
 * deliberately omitted so the wire-emit defaults in `builder.ts` run.
 */
type ConnectFormSpec =
	| { connectType: "learn"; learnModule: boolean; assessment: boolean }
	| { connectType: "deliver"; deliverUnit: boolean; task: boolean };

/**
 * A "≥1 sub-config" boolean pair: at least one of the two flags is true, so
 * the form always satisfies the per-form Connect requirement. Drawn as one of
 * the three legal combinations (first-only, second-only, both).
 */
const subConfigPairArb = fc.constantFrom<[boolean, boolean]>(
	[true, false],
	[false, true],
	[true, true],
);

/** A learn-form sub-config selection (learn_module / assessment, ≥1). */
const learnFormArb: fc.Arbitrary<ConnectFormSpec> = subConfigPairArb.map(
	([learnModule, assessment]) => ({
		connectType: "learn",
		learnModule,
		assessment,
	}),
);

/** A deliver-form sub-config selection (deliver_unit / task, ≥1). */
const deliverFormArb: fc.Arbitrary<ConnectFormSpec> = subConfigPairArb.map(
	([deliverUnit, task]) => ({
		connectType: "deliver",
		deliverUnit,
		task,
	}),
);

/**
 * Build a per-form `ConnectConfig` from a selection, minting each present
 * sub-config a globally-unique id via the shared minter. The minter emits
 * `<prefix>-<base36>`; a hyphen is NOT a legal XML element-name char
 * (`XML_ELEMENT_NAME_REGEX`), and Connect ids become element names, so the
 * raw uuid is unusable here — we re-shape it with an underscore separator
 * (`cm_<n>`) which is legal and stays globally unique (the counter is shared
 * with the field/form/module minting, so no two ids ever collide app-wide).
 *
 * `entity_id` / `entity_name` are left unset on the deliver_unit on purpose:
 * that's the state the wire-emit default path in `builder.ts` fills, so
 * omitting them is what exercises it.
 */
function buildConnectConfig(
	minter: IdMinter,
	spec: ConnectFormSpec,
): ConnectConfig {
	// Re-shape a minted uuid into a legal XML element name: the minter joins
	// prefix + counter with a hyphen, but a Connect id must match
	// `XML_ELEMENT_NAME_REGEX` (no hyphens). Swap to an underscore; the counter
	// keeps it globally unique.
	const connectId = (prefix: string): string =>
		minter.uuid(prefix).replace("-", "_");

	const config: ConnectConfig = {};
	if (spec.connectType === "learn") {
		if (spec.learnModule) {
			config.learn_module = {
				id: connectId("cm"),
				name: "Learn module",
				description: "Learn module description",
				time_estimate: 30,
			};
		}
		if (spec.assessment) {
			config.assessment = {
				id: connectId("ca"),
				// A quoted literal: a valid XPath the bind emitter renders as
				// `calculate="'100'"` (a bare `100` would also parse, but a quoted
				// value mirrors how the SA pins a fixed score).
				user_score: "'100'",
			};
		}
		return config;
	}
	if (spec.deliverUnit) {
		config.deliver_unit = {
			id: connectId("cd"),
			name: "Deliver unit",
			// entity_id / entity_name omitted → wire-emit defaults run.
		};
	}
	if (spec.task) {
		config.task = {
			id: connectId("ct"),
			name: "Delivery task",
			description: "Delivery task description",
		};
	}
	return config;
}

// ── Form + module + doc assembly ───────────────────────────────────

export const FORM_TYPES = [
	"registration",
	"followup",
	"close",
	"survey",
] as const;

/**
 * The arbitrary's top-level shape: an app-level `connectType` plus a list of
 * modules, each with a case type and a list of forms (field-tree specs + an
 * optional per-form Connect selection). The doc is assembled deterministically
 * from this spec so id minting + normalization happen once.
 *
 * `connectType` is `null` for a plain app or "learn" / "deliver" for a Connect
 * app. When it's set, EVERY form carries a `connect` selection (`CONNECT_FORM`
 * requires a block on every form of a Connect app); when it's `null`, no form
 * carries one.
 */
/**
 * Per-form subcase injection — when present, lowers into a repeat at
 * the form root holding one cross-case-type field id'd `case_name`.
 * The wire emission exercises the path-aware splice algorithm in
 * `xform/caseBlocks.ts::addCaseBlocks` across all three repeat modes,
 * including the `query_bound` `/item` segment + the nest=false branch
 * where the `<case>` element splices DIRECTLY into the repeat with no
 * `<subcase_N>` wrapper. The fuzzer asserts validation is clean
 * (`PRIMARY_CASE_FIELD_IN_REPEAT` / `CHILD_CASE_NO_NAME_FIELD` both
 * pass — the injected child case bucket has its `case_name` source,
 * and no primary-case fields land inside the injected repeat).
 *
 * The injected child case type joins `caseTypes`. The field id
 * `case_name` is OFF the sibling pool, so it can't collide with any
 * random root-level pool field. The pool ids (a-g) don't include
 * `children`, so the injected repeat id can't collide either.
 *
 * Drawn for ~67% of registration forms (`fc.option`'s `freq: 3` sets
 * `P(nil) = 1/3`, so `P(value) ≈ 2/3`); survey/followup/close skip
 * the injection (deriveCaseConfig only emits subcase actions on forms
 * whose type carries case-management actions, and registration is the
 * canonical "register parent + N children" surface).
 */
type SubcaseShapeSpec = {
	mode: "user_controlled" | "count_bound" | "query_bound";
	childCaseType: string;
};

interface DocGenSpec {
	connectType: ConnectType | null;
	/** Whether the app carries an app-level logo. The id is minted at
	 *  lowering time so it shares the global IdMinter sequence. */
	hasLogo: boolean;
	modules: Array<{
		caseType: string;
		caseListColumns: readonly string[];
		/** Whether the module carries a menu-tile icon. */
		hasIcon: boolean;
		/** Whether the module carries an audio label for its menu tile. */
		hasAudioLabel: boolean;
		forms: Array<{
			type: (typeof FORM_TYPES)[number];
			fields: FieldGenSpec[];
			/** Whether the form carries a command-tile icon. */
			hasIcon: boolean;
			/** Whether the form carries an audio label for its command tile. */
			hasAudioLabel: boolean;
			/** Present iff the app is Connect-typed; the sub-config selection
			 *  for this form, always mode-matched to `connectType`. */
			connect?: ConnectFormSpec;
			/** Present iff the form is a registration form and the dice rolled
			 *  for subcase injection. The lowering builds the repeat + child
			 *  field; the child case type joins the doc's `caseTypes`. */
			subcase?: SubcaseShapeSpec;
		}>;
	}>;
}

/**
 * Subcase injection arbitrary — fast-check's `fc.option` with `freq: 3`
 * makes `P(nil) = 1/3`, so ~2/3 of registration forms carry an injected
 * subcase shape. Heavy coverage of the new repeat-context splice paths
 * is the trade for less diversity in non-subcase shapes — the oracle
 * benefits from frequent exercise of the new shape, and the rest of
 * the field-spec arbitrary still varies independently. Repeat-mode and
 * child-case-type drawn uniformly; the `idsQuery` for `query_bound`
 * matches the leaves the per-mode compiler tests use.
 */
const subcaseShapeArb: fc.Arbitrary<SubcaseShapeSpec | undefined> = fc.option(
	fc.record({
		mode: fc.constantFrom<SubcaseShapeSpec["mode"]>(
			"user_controlled",
			"count_bound",
			"query_bound",
		),
		childCaseType: fc.constantFrom("child", "child_visit", "child_followup"),
	}),
	{ freq: 3, nil: undefined },
);

/**
 * The form spec WITHOUT its Connect selection — the connect block is layered
 * on per-app-mode below, because its mode must match the app-level
 * `connectType` (a learn app's forms can't carry a deliver selection).
 */
const formCoreArb = fc.record({
	type: fc.constantFrom(...FORM_TYPES),
	fields: fc.array(fieldSpecArb(2), { minLength: 1, maxLength: 4 }),
	// Menu-tile media on a form's command. Independent booleans so the
	// generator covers icon-only, audio-only, both, and neither.
	hasIcon: fc.boolean(),
	hasAudioLabel: fc.boolean(),
	subcase: subcaseShapeArb,
});

const moduleCoreArb = fc.record({
	caseType: fc.constantFrom("patient", "household", "visit", "service"),
	caseListColumns: fc.constant(["case_name"]),
	forms: fc.array(formCoreArb, { minLength: 1, maxLength: 2 }),
	// Menu-tile media on a module's home tile. Same independent-boolean
	// shape as the form-level slots.
	hasIcon: fc.boolean(),
	hasAudioLabel: fc.boolean(),
});

/**
 * Roll the app-level Connect mode (one of null / learn / deliver), then layer a
 * mode-matched Connect selection onto every form when the app is Connect-typed.
 * Roughly two-thirds of generated docs end up Connect (learn or deliver), split
 * across both modes — enough to exercise `buildConnectBlocks` heavily while the
 * remaining third keeps the non-Connect structural coverage intact.
 */
const docGenSpecArb: fc.Arbitrary<DocGenSpec> = fc
	.record({
		connectType: fc.constantFrom<ConnectType | null>(null, "learn", "deliver"),
		modules: fc.array(moduleCoreArb, { minLength: 1, maxLength: 2 }),
		hasLogo: fc.boolean(),
	})
	.chain(({ connectType, modules, hasLogo }) => {
		// Non-Connect app: no form carries a connect block.
		if (connectType === null) {
			return fc.constant<DocGenSpec>({
				connectType: null,
				hasLogo,
				modules,
			});
		}
		// Connect app: draw one mode-matched selection per form. Collect every
		// form's selection arbitrary in document order, sample them as one
		// tuple, then redistribute back onto the module/form tree.
		const formArb = connectType === "learn" ? learnFormArb : deliverFormArb;
		const perFormArbs = modules.flatMap((m) => m.forms.map(() => formArb));
		return fc.tuple(...perFormArbs).map((selections) => {
			let cursor = 0;
			const withConnect = modules.map((m) => ({
				...m,
				forms: m.forms.map((form) => ({
					...form,
					connect: selections[cursor++],
				})),
			}));
			return { connectType, hasLogo, modules: withConnect };
		});
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
	// Track injected child case types separately — they're added to
	// caseTypes regardless of whether any module's primary case_type
	// matches. The subcase injection at the form level is what brings
	// them into the doc, not the module declaration.
	const injectedChildCaseTypes = new Set<string>();

	spec.modules.forEach((modSpec, mIdx) => {
		const moduleUuid = minter.uuid("mod");
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];
		caseTypeNames.add(modSpec.caseType);

		// Menu-tile media on the module's home tile. Each slot is independent;
		// the lowering mints an `AssetId` per requested slot via the shared
		// minter so every id is globally unique.
		const moduleIcon = modSpec.hasIcon
			? asAssetId(minter.uuid("modicon"))
			: undefined;
		const moduleAudio = modSpec.hasAudioLabel
			? asAssetId(minter.uuid("modaud"))
			: undefined;

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
			...(moduleIcon ? { icon: moduleIcon } : {}),
			...(moduleAudio ? { audioLabel: moduleAudio } : {}),
		};

		modSpec.forms.forEach((formSpec, fIdx) => {
			const formUuid = minter.uuid("frm");
			formOrder[moduleUuid].push(formUuid);
			fieldOrder[formUuid] = [];

			const formIcon = formSpec.hasIcon
				? asAssetId(minter.uuid("frmicon"))
				: undefined;
			const formAudio = formSpec.hasAudioLabel
				? asAssetId(minter.uuid("frmaud"))
				: undefined;

			forms[formUuid] = {
				uuid: formUuid,
				id: `f${mIdx}_${fIdx}`,
				name: `Form ${mIdx}-${fIdx}`,
				type: formSpec.type,
				// Connect apps carry a per-form `connect` block (every form, per
				// `CONNECT_FORM_MISSING_BLOCK`); ids are minted globally-unique
				// here so the `runValidation` guardrail — which does NOT run the
				// validate-time autofill — sees a complete, valid config.
				...(formSpec.connect
					? { connect: buildConnectConfig(minter, formSpec.connect) }
					: {}),
				...(formIcon ? { icon: formIcon } : {}),
				...(formAudio ? { audioLabel: formAudio } : {}),
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

			// Per-form subcase injection (registration forms only). When the
			// dice rolled for a subcase, build a repeat at the form root
			// containing one child case_name field. The repeat element id
			// `children` is OFF the sibling pool, so no collision with random
			// root fields. The child field id `case_name` is also off the
			// pool — and it's the SOLE child of the injected repeat, so
			// siblings can't collide either.
			if (formSpec.type === "registration" && formSpec.subcase) {
				injectedChildCaseTypes.add(formSpec.subcase.childCaseType);
				injectSubcaseRepeat(ctx, formUuid, formSpec.subcase);
			}
		});
	});

	const allCaseTypeNames = new Set([
		...caseTypeNames,
		...injectedChildCaseTypes,
	]);
	const caseTypes: CaseType[] = [...allCaseTypeNames].map((name) => ({
		name,
		properties: [{ name: "case_name", label: "Name" }],
	}));

	// App-level logo (web-apps banner). Single optional slot; minted late so
	// it doesn't collide with field-mint id sequencing.
	const logo = spec.hasLogo ? asAssetId(minter.uuid("logo")) : undefined;

	return {
		appId: "fuzz-app",
		appName: "Fuzz App",
		connectType: spec.connectType,
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
		...(logo ? { logo } : {}),
	};
}

/**
 * The public arbitrary: a normalized `BlueprintDoc`. `fieldParent` is left
 * empty here; the fuzz test calls `rebuildFieldParent` before validating, which
 * is the same bootstrap `buildDoc` performs.
 */
export const blueprintDocArbitrary: fc.Arbitrary<BlueprintDoc> =
	docGenSpecArb.map(lowerToDoc);

// ── Manifest synthesis ─────────────────────────────────────────────

/**
 * Per-slot conventions the fuzz manifest synthesizer follows. Image slots
 * resolve to a .png file; audio to .mp3; video to .mp4. The choice is
 * arbitrary (CommCare's installer is content-agnostic on extension; the
 * sniffed mimeType is what the validator gates on), but the wire path
 * carries the extension verbatim so the choice MUST be stable for the
 * synthesizer + the oracles to agree on the manifest's wire-path set.
 */
const SLOT_EXTENSION_BY_KIND: Record<
	"image" | "audio" | "video",
	{ readonly extension: string; readonly mimeType: string }
> = {
	image: { extension: ".png", mimeType: "image/png" },
	audio: { extension: ".mp3", mimeType: "audio/mpeg" },
	video: { extension: ".mp4", mimeType: "video/mp4" },
};

/**
 * The minimum manifest payload the wire emitters and oracles need.
 * Kept narrower than `ResolvedMediaAsset` so the fuzz harness doesn't
 * have to import + assemble the full storage shape.
 */
export interface FuzzMediaAsset {
	readonly assetId: AssetId;
	readonly wirePath: string;
	readonly kind: "image" | "audio" | "video";
	readonly mimeType: string;
	readonly contentHash: string;
	readonly extension: string;
}

/**
 * True when the doc carries at least one media reference that lowers to
 * an XForm `<value form="image|audio|video">jr://...` sibling — i.e. a
 * field message-slot bundle (`label_media` / `hint_media` / `help_media`
 * / `validate_msg_media`) or an option `media` bundle.
 *
 * This is the form-itext sub-population, deliberately NARROWER than
 * `hasMedia`: menu-style carriers (app logo, module/form icon +
 * audioLabel, image-map columns) emit into the suite + app_strings, not
 * into any form's itext, so they never feed the XForm oracle's
 * `XFORM_DANGLING_MEDIA_REF` resolution path. The XForm fuzz floors THIS
 * ratio (not `hasMedia`'s) so a drift in `FIELD_MEDIA_SPEC_ARB` toward
 * all-empty slots fails loud rather than turning the media-resolution
 * check into a silent no-op while menu media keeps `hasMedia` true.
 */
export function hasFormItextMedia(doc: BlueprintDoc): boolean {
	for (const ref of walkAssetRefs(doc)) {
		if (
			ref.location.kind === "field_media_bundle" ||
			ref.location.kind === "option_media"
		) {
			return true;
		}
	}
	return false;
}

/**
 * Build a deterministic manifest covering every `AssetId` the doc
 * references. Walks via `walkAssetRefs` (the same single-source-of-truth
 * walker the validator + manifest loader consume) so the fuzz manifest
 * matches the emitter's actual reference set 1:1.
 *
 * Each asset is assigned:
 *   - A deterministic `contentHash` (sha256-like 64-hex prefix derived
 *     from the asset id) so emit output is stable across runs.
 *   - An extension + mimeType matching its slot kind (the schema only
 *     gates `mediaKindMatches` when the validator is invoked WITH a
 *     manifest; the fuzz tests don't run that rule, so any sane pairing
 *     here is fine — the synthesizer just keeps the wire-path
 *     extensions sensible).
 *
 * Same-asset-id collisions across slots use the FIRST seen slot's kind —
 * one `AssetId` produces exactly one wire-path entry, which is the
 * shape the dedup bundler relies on.
 */
export function fuzzManifestFromDoc(
	doc: BlueprintDoc,
): Map<AssetId, FuzzMediaAsset> {
	const manifest = new Map<AssetId, FuzzMediaAsset>();
	for (const ref of walkAssetRefs(doc)) {
		const branded = asAssetId(ref.assetId);
		if (manifest.has(branded)) continue;
		const { extension, mimeType } = SLOT_EXTENSION_BY_KIND[ref.slotKind];
		// Deterministic 64-hex content hash derived from the asset id — same id
		// in two runs produces the same hash, which keeps emit output stable
		// for fuzz seed reproducibility.
		const contentHash = hashForAssetId(ref.assetId);
		const wirePath = `commcare/${contentHash}${extension}`;
		manifest.set(branded, {
			assetId: branded,
			wirePath,
			kind: ref.slotKind,
			mimeType,
			contentHash,
			extension,
		});
	}
	return manifest;
}

/**
 * Stable 64-hex hash for an asset id. Not a cryptographic hash — the
 * synthesizer just needs a deterministic, collision-resistant string with
 * the same shape as the real content hash so the emitter's wire path
 * format check (`/^[a-f0-9]{64}$/` on the schema side) is irrelevant
 * here (the validator doesn't run kind-matching during fuzz runs), but
 * a clean shape keeps emit output legible in golden-style diffs.
 */
function hashForAssetId(assetId: string): string {
	// Simple FNV-1a 32-bit hash folded out into 64 hex chars by repeating.
	// Deterministic + collision-resistant enough for fuzz coverage — the
	// per-asset uniqueness fast-check provides via the IdMinter is the actual
	// guarantee, this just pads it into a 64-char display.
	let h = 0x811c9dc5;
	for (let i = 0; i < assetId.length; i++) {
		h ^= assetId.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	const hex8 = (h >>> 0).toString(16).padStart(8, "0");
	return hex8.repeat(8);
}
