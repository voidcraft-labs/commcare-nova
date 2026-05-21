/**
 * Connect slug capping + app-wide deduplication.
 *
 * Every per-form `connect` block carries an id (`learn_module.id`,
 * `assessment.id`, `deliver_unit.id`, `task.id`) that CommCare Connect
 * ingests at opportunity-init and writes into a slug column. The tightest
 * of those columns — `LearnModule.slug` / `Task.slug` — is a Django
 * `SlugField()` with no `max_length`, i.e. Postgres `varchar(50)`
 * (`commcare-connect/.../opportunity/models.py::LearnModule.slug`). The
 * insert (`opportunity/tasks.py::create_learn_modules_and_deliver_units`)
 * goes through `update_or_create(slug=block.id, ...)`, which bypasses
 * Django field validation, so an over-length id reaches Postgres raw and
 * raises `value too long for type character varying(50)` → HTTP 500.
 *
 * `buildConnectSlugMap` is the single home for "what id this block puts on
 * the wire": it applies the empty-id fallback, caps to {@link CONNECT_SLUG_MAX_LENGTH},
 * and disambiguates collisions so two distinct blocks never share a slug
 * (the `(app, slug)` unique constraint would otherwise collapse two rows
 * into one). The three wire consumers — XForm builder, case-references
 * load map, and the validator's valid-path set — all read this map so the
 * wrapper element, the `id=` attribute, the bind nodesets, and the load
 * map agree on one capped id.
 *
 * These tests exercise the helper directly (length / dedup / determinism)
 * and end-to-end through `expandDoc` (consistency across every wire
 * surface). The end-to-end path is the production verification surface —
 * it runs the expander integration, not just the unit.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	buildConnectSlugMap,
	CONNECT_SLUG_MAX_LENGTH,
} from "@/lib/commcare/connectSlugs";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { BlueprintDoc, Uuid } from "@/lib/domain";

// ── Fixture helpers ──────────────────────────────────────────────────
//
// A 60-character snake id (the shape `toSnakeId` mints from a long form
// name) — comfortably past the 50-char cap so truncation must engage.
const LONG_ID_60 =
	"module_three_conducting_the_fifteen_question_seller_intervie";

/** The first (only) attachment XForm XML from an expanded doc. */
function firstXForm(doc: BlueprintDoc): string {
	const hq = expandDoc(doc);
	return Object.values(hq._attachments)[0] as string;
}

/** The single form's HQ uuid, for indexing the slug map by form. */
function onlyFormUuid(doc: BlueprintDoc): Uuid {
	const moduleUuid = doc.moduleOrder[0];
	return doc.formOrder[moduleUuid][0];
}

describe("buildConnectSlugMap — per-kind length cap", () => {
	it("caps a learn_module id derived from a long name to ≤50 chars", () => {
		// LONG_ID_60 is 60 chars; the live overflow was 52 chars against
		// varchar(50). The emitted slug must be ≤50.
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: LONG_ID_60,
									name: "Intro",
									description: "Intro",
									time_estimate: 30,
								},
							},
						},
					],
				},
			],
		});

		const slugMap = buildConnectSlugMap(doc);
		const config = slugMap.get(onlyFormUuid(doc));
		const id = config?.learn_module?.id;
		expect(id).toBeDefined();
		expect((id as string).length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		expect(CONNECT_SLUG_MAX_LENGTH).toBe(50);
	});

	it("caps an assessment id to ≤50 chars", () => {
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Quiz",
							type: "survey",
							connect: {
								assessment: {
									id: `${LONG_ID_60}_assessment_extra_padding_to_exceed_limit`,
									user_score: "100",
								},
							},
						},
					],
				},
			],
		});

		const id = buildConnectSlugMap(doc).get(onlyFormUuid(doc))?.assessment?.id;
		expect(id).toBeDefined();
		expect((id as string).length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
	});

	it("caps a deliver_unit id to ≤50 chars", () => {
		const doc = buildDoc({
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							connect: {
								deliver_unit: { id: LONG_ID_60, name: "Visit" },
							},
						},
					],
				},
			],
		});

		const id = buildConnectSlugMap(doc).get(onlyFormUuid(doc))?.deliver_unit
			?.id;
		expect(id).toBeDefined();
		expect((id as string).length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
	});

	it("caps a task id to ≤50 chars", () => {
		const doc = buildDoc({
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							connect: {
								deliver_unit: { id: "du", name: "Visit" },
								task: {
									id: `${LONG_ID_60}_task_extra_padding_well_past_fifty`,
									name: "Task",
									description: "Task",
								},
							},
						},
					],
				},
			],
		});

		const id = buildConnectSlugMap(doc).get(onlyFormUuid(doc))?.task?.id;
		expect(id).toBeDefined();
		expect((id as string).length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
	});
});

describe("buildConnectSlugMap — app-wide collision disambiguation", () => {
	/**
	 * Build a learn doc with N forms (each its own module), every form's
	 * `learn_module.id` set to a >50-char id that shares the same 50-char
	 * prefix. Distinct blocks that truncate to the same prefix must NOT
	 * collide into one slug — Connect keys `LearnModule` on `(app, slug)`,
	 * so a collision would `update_or_create` the second block onto the
	 * first row and silently drop a module.
	 */
	function collidingLearnDoc(rawIds: string[]): BlueprintDoc {
		return buildDoc({
			connectType: "learn",
			modules: rawIds.map((rawId, i) => ({
				name: `Module ${i}`,
				forms: [
					{
						name: `Lesson ${i}`,
						type: "survey" as const,
						connect: {
							learn_module: {
								id: rawId,
								name: `Lesson ${i}`,
								description: "x",
								time_estimate: 30,
							},
						},
					},
				],
			})),
		});
	}

	it("gives two blocks that truncate to the same prefix distinct slugs", () => {
		// Both ids share the first 55 chars, diverging only past the cap —
		// naive truncation would map both to the identical 50-char prefix.
		const doc = collidingLearnDoc([
			`${"a".repeat(55)}_first`,
			`${"a".repeat(55)}_second`,
		]);
		const slugMap = buildConnectSlugMap(doc);

		const ids = doc.moduleOrder.map(
			(m) => slugMap.get(doc.formOrder[m][0])?.learn_module?.id,
		);
		expect(ids[0]).toBeDefined();
		expect(ids[1]).toBeDefined();
		expect(ids[0]).not.toBe(ids[1]);
		for (const id of ids) {
			expect((id as string).length).toBeLessThanOrEqual(
				CONNECT_SLUG_MAX_LENGTH,
			);
		}
	});

	it("keeps every slug ≤50 even when three+ blocks collide on one prefix", () => {
		// Three collisions force the disambiguation counter past single
		// digits' worth of headroom checks — guards the off-by-one where a
		// suffix pushes the result back over 50.
		const prefix = "b".repeat(60);
		const doc = collidingLearnDoc([
			`${prefix}_one`,
			`${prefix}_two`,
			`${prefix}_three`,
			`${prefix}_four`,
		]);
		const slugMap = buildConnectSlugMap(doc);

		const ids = doc.moduleOrder.map(
			(m) => slugMap.get(doc.formOrder[m][0])?.learn_module?.id as string,
		);
		// All four distinct.
		expect(new Set(ids).size).toBe(4);
		// All four within the cap.
		for (const id of ids) {
			expect(id.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		}
	});

	it("allows cross-kind slug sharing on DIFFERENT forms — distinct DB tables, distinct XForms", () => {
		// A `learn_module` on one form and an `assessment` on another form
		// land in different DB tables (LearnModule vs Assessment) AND
		// different XForm `<data>` blocks, so an identical slug is harmless.
		// Per-kind dedup is app-wide; it must not reach across kinds to force
		// these apart.
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: "shared_slug",
									name: "L",
									description: "x",
									time_estimate: 30,
								},
							},
						},
						{
							name: "Quiz",
							type: "survey",
							connect: { assessment: { id: "shared_slug", user_score: "100" } },
						},
					],
				},
			],
		});

		const slugMap = buildConnectSlugMap(doc);
		const formUuids = doc.formOrder[doc.moduleOrder[0]];
		// Different forms → cross-kind equality is preserved.
		expect(slugMap.get(formUuids[0])?.learn_module?.id).toBe("shared_slug");
		expect(slugMap.get(formUuids[1])?.assessment?.id).toBe("shared_slug");
	});

	it("disambiguates two co-located blocks on the SAME form (learn_module + assessment)", () => {
		// learn_module and assessment ride in the same form's `<data>` block,
		// and the slug IS the XForm element name. A combined teach+test form
		// is a first-class pattern, and the cap creates the collision: a
		// combined module's assessment id starts with its learn_module id, so
		// both truncate to the same 50-char prefix. Two sibling elements with
		// the same name + the same `/data/<slug>` bind would be malformed
		// XForm — so co-located blocks must get distinct slugs even though
		// they're different kinds.
		const prefix = "a".repeat(55);
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: `${prefix}_lm`,
									name: "L",
									description: "x",
									time_estimate: 30,
								},
								assessment: { id: `${prefix}_as`, user_score: "100" },
							},
						},
					],
				},
			],
		});

		const config = buildConnectSlugMap(doc).get(onlyFormUuid(doc));
		const lmId = config?.learn_module?.id as string;
		const asId = config?.assessment?.id as string;
		expect(lmId).not.toBe(asId);
		expect(lmId.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		expect(asId.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
	});

	it("disambiguates two co-located blocks on the SAME form (deliver_unit + task)", () => {
		// Same constraint for the deliver-app pair: deliver_unit + task on one
		// form is first-class, and the cap can collide their slugs.
		const prefix = "d".repeat(55);
		const doc = buildDoc({
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							connect: {
								deliver_unit: { id: `${prefix}_du`, name: "V" },
								task: { id: `${prefix}_tk`, name: "T", description: "x" },
							},
						},
					],
				},
			],
		});

		const config = buildConnectSlugMap(doc).get(onlyFormUuid(doc));
		const duId = config?.deliver_unit?.id as string;
		const taskId = config?.task?.id as string;
		expect(duId).not.toBe(taskId);
		expect(duId.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		expect(taskId.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
	});

	it("emits distinct sibling element names for co-located blocks in one form's XForm", () => {
		// End-to-end guard: the disambiguated slugs must surface as distinct
		// XForm element names + distinct bind nodesets in the same form. Two
		// `<slug vellum:role=...>` siblings sharing a name would be invalid.
		const prefix = "e".repeat(55);
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: `${prefix}_lm`,
									name: "L",
									description: "x",
									time_estimate: 30,
								},
								assessment: { id: `${prefix}_as`, user_score: "100" },
							},
						},
					],
				},
			],
		});

		const config = buildConnectSlugMap(doc).get(onlyFormUuid(doc));
		const lmId = config?.learn_module?.id as string;
		const asId = config?.assessment?.id as string;
		const xml = firstXForm(doc);

		// Both wrappers present, under their own (distinct) names.
		expect(xml).toContain(`<${lmId} vellum:role="ConnectLearnModule">`);
		expect(xml).toContain(`<${asId} vellum:role="ConnectAssessment">`);
		// The bind nodesets are distinct too.
		expect(xml).toContain(`nodeset="/data/${lmId}"`);
		expect(xml).toContain(`/data/${asId}/assessment/user_score`);
	});
});

describe("buildConnectSlugMap — purity / idempotence", () => {
	it("is pure — the same doc yields identical slugs on every call", () => {
		// The property that matters is purity: one CCZ resolves to one set of
		// slugs, so an idempotent opp-init retry over the same uploaded app
		// claims the same `(app, slug)` rows. Cross-edit stability is NOT a
		// goal — every Nova upload creates a brand-new HQ app (HQ has no
		// atomic update API), so there's no same-app re-sync of edited content
		// for slugs to stay stable across. Two colliding ids run the
		// disambiguation path, where any non-purity would hide.
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "M1",
					forms: [
						{
							name: "F1",
							type: "survey",
							connect: {
								learn_module: {
									id: `${"c".repeat(55)}_x`,
									name: "F1",
									description: "x",
									time_estimate: 30,
								},
							},
						},
					],
				},
				{
					name: "M2",
					forms: [
						{
							name: "F2",
							type: "survey",
							connect: {
								learn_module: {
									id: `${"c".repeat(55)}_y`,
									name: "F2",
									description: "x",
									time_estimate: 30,
								},
							},
						},
					],
				},
			],
		});

		const learnIds = (
			map: ReadonlyMap<Uuid, { learn_module?: { id: string } }>,
		) =>
			doc.moduleOrder.map(
				(m) => map.get(doc.formOrder[m][0])?.learn_module?.id,
			);
		expect(learnIds(buildConnectSlugMap(doc))).toEqual(
			learnIds(buildConnectSlugMap(doc)),
		);
	});
});

describe("buildConnectSlugMap — empty / absent handling", () => {
	it("returns no entry for a form that carries no connect block", () => {
		const doc = buildDoc({
			connectType: "learn",
			modules: [{ name: "M", forms: [{ name: "F", type: "survey" }] }],
		});
		expect(buildConnectSlugMap(doc).get(onlyFormUuid(doc))).toBeUndefined();
	});

	it("returns an empty map when the app is not in Connect mode", () => {
		const doc = buildDoc({
			connectType: null,
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							connect: {
								learn_module: {
									id: "intro",
									name: "F",
									description: "x",
									time_estimate: 30,
								},
							},
						},
					],
				},
			],
		});
		expect(buildConnectSlugMap(doc).size).toBe(0);
	});

	// An id-less block resolves to the SAME name-derived id the validate-time
	// derivation (`deriveConnectDefaults`) would mint — learn_module /
	// deliver_unit from the module slug, assessment / task from
	// `<module>_<form>`. Mirroring keeps the wire fallback consistent with
	// the doc-layer default and makes the authoring placeholder
	// ("Defaults from module name") truthful. A bare static sentinel here
	// would diverge: `deriveConnectDefaults` fills via `??=` (nullish only),
	// so a cleared-to-empty id reaches the resolver and must still produce a
	// meaningful name slug.
	it.each([
		{
			kind: "learn_module" as const,
			connectType: "learn" as const,
			block: { name: "F", description: "x", time_estimate: 30 },
			expected: "training", // toSnakeId("Training")
		},
		{
			kind: "assessment" as const,
			connectType: "learn" as const,
			block: { user_score: "100" },
			expected: "training_lesson", // toSnakeId("Training") + "_" + toSnakeId("Lesson")
		},
		{
			kind: "deliver_unit" as const,
			connectType: "deliver" as const,
			block: { name: "F" },
			expected: "training",
		},
		{
			kind: "task" as const,
			connectType: "deliver" as const,
			block: { name: "F", description: "x" },
			expected: "training_lesson",
		},
	])("derives an id-less $kind from the module/form name (not a static sentinel)", ({
		kind,
		connectType,
		block,
		expected,
	}) => {
		const doc = buildDoc({
			connectType,
			modules: [
				{
					name: "Training",
					forms: [
						{ name: "Lesson", type: "survey", connect: { [kind]: block } },
					],
				},
			],
		});
		const config = buildConnectSlugMap(doc).get(onlyFormUuid(doc));
		expect((config as Record<string, { id: string }>)[kind].id).toBe(expected);
	});

	it("gives two id-less learn_modules on different forms distinct name-derived slugs", () => {
		// The realistic "enabled learn on several forms, never named the ids"
		// shape. Both id-less blocks flow through the name-derived fallback;
		// when the module names collide (here, identical) the app-wide
		// per-kind dedup must still split them so two distinct modules don't
		// collapse onto one `(app, slug)` row.
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson A",
							type: "survey",
							connect: {
								learn_module: {
									name: "Lesson A",
									description: "x",
									time_estimate: 30,
								},
							},
						},
					],
				},
				{
					name: "Training",
					forms: [
						{
							name: "Lesson B",
							type: "survey",
							connect: {
								learn_module: {
									name: "Lesson B",
									description: "x",
									time_estimate: 30,
								},
							},
						},
					],
				},
			],
		});

		const slugMap = buildConnectSlugMap(doc);
		const ids = doc.moduleOrder.map(
			(m) => slugMap.get(doc.formOrder[m][0])?.learn_module?.id as string,
		);
		expect(ids[0]).not.toBe(ids[1]);
		expect(new Set(ids).size).toBe(2);
		for (const id of ids) {
			expect(id.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		}
	});
});

// ── End-to-end through expandDoc — wire-surface consistency ──────────

describe("Connect slug cap — end-to-end XForm consistency", () => {
	const longLearnDoc = buildDoc({
		appName: "LongLearn",
		connectType: "learn",
		modules: [
			{
				name: "Training",
				forms: [
					{
						name: "Lesson",
						type: "survey",
						connect: {
							learn_module: {
								id: LONG_ID_60,
								name: "Intro",
								description: "Intro",
								time_estimate: 30,
							},
						},
						fields: [f({ kind: "text", id: "feedback", label: "Feedback" })],
					},
				],
			},
		],
	});

	it("emits the capped id identically in the wrapper element, the id= attribute, and the bind nodeset", () => {
		const xml = firstXForm(longLearnDoc);
		const cappedId = buildConnectSlugMap(longLearnDoc).get(
			onlyFormUuid(longLearnDoc),
		)?.learn_module?.id as string;

		expect(cappedId.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		// The original 60-char id must NOT appear anywhere on the wire.
		expect(xml).not.toContain(LONG_ID_60);
		// Wrapper element opens + closes with the capped id.
		expect(xml).toContain(`<${cappedId} vellum:role="ConnectLearnModule">`);
		expect(xml).toContain(`</${cappedId}>`);
		// The Connect-namespaced inner element carries the capped id= attr.
		expect(xml).toContain(
			`<module xmlns="http://commcareconnect.com/data/v1/learn" id="${cappedId}">`,
		);
		// The bind nodeset references the capped data path.
		expect(xml).toContain(
			`<bind vellum:nodeset="#form/${cappedId}" nodeset="/data/${cappedId}"/>`,
		);
	});

	it("agrees between the XForm bind and the case-references load map for a deliver_unit", () => {
		// `entity_id` carries a `#case/` hashtag so it surfaces in the
		// case-references load map. The load-map key and the XForm bind
		// nodeset must reference the SAME capped id, or the runtime would
		// preload into a node the form never declares.
		const doc = buildDoc({
			appName: "DeliverLong",
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					caseType: "visit",
					forms: [
						{
							name: "Visit",
							type: "followup",
							connect: {
								deliver_unit: {
									id: LONG_ID_60,
									name: "Visit",
									entity_id: "#case/beneficiary_id",
								},
							},
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
		});

		const cappedId = buildConnectSlugMap(doc).get(onlyFormUuid(doc))
			?.deliver_unit?.id as string;
		const expandedForm = expandDoc(doc).modules[0].forms[0];
		const load = expandedForm.case_references_data.load;

		// The load map keys on the capped id, matching the bind.
		expect(load[`/data/${cappedId}/deliver/entity_id`]).toEqual([
			"#case/beneficiary_id",
		]);
		// No load-map key references the original over-length id.
		expect(Object.keys(load).some((k) => k.includes(LONG_ID_60))).toBe(false);
	});
});

// ── Empty <user_score/> + value-in-bind ──────────────────────────────
//
// Separate but adjacent to the slug cap: the assessment block deliberately
// emits an EMPTY `<user_score/>` data node and carries the computed value
// in a `<bind … calculate="…">`, NOT as element text. This is how
// CommCare reads a calculated value. The test pins the intent so a future
// change that inlines the value into the element (`<user_score>100</…>`)
// trips immediately.

describe("Connect assessment — user_score value lives in the bind, not the element", () => {
	const quizDoc = buildDoc({
		appName: "Quiz",
		connectType: "learn",
		modules: [
			{
				name: "Training",
				forms: [
					{
						name: "Quiz",
						type: "survey",
						connect: {
							assessment: {
								id: "intro_assessment",
								user_score: "42",
							},
						},
						fields: [f({ kind: "text", id: "answer", label: "Answer" })],
					},
				],
			},
		],
	});

	it("emits an empty <user_score/> element and a separate calculate bind", () => {
		const xml = firstXForm(quizDoc);

		// The data node is empty — value does NOT live as element text.
		expect(xml).toContain("<user_score/>");
		expect(xml).not.toContain("<user_score>42</user_score>");
		// The value lives in the bind's calculate attribute.
		expect(xml).toContain(
			'<bind nodeset="/data/intro_assessment/assessment/user_score" calculate="42"/>',
		);
	});
});

// ── Validator valid-path set tracks the capped id ────────────────────
//
// `validateBlueprintDeep` exposes each Connect block's data path so a
// user XPath may reference the Connect node. That path must use the SAME
// capped id the XForm emits, or a field referencing the (real, capped)
// node would be rejected — and a field referencing the uncapped raw path
// (the node the wire never produces) must be caught. This locks the
// validator as one of the wire surfaces kept in lockstep with the cap.

describe("Connect slug cap — validator valid-path set uses the capped id", () => {
	/** A learn doc with a long-id module + one field whose `relevant`
	 *  references `refPath`. Survey form so no case wiring is needed. */
	function docReferencing(refPath: string): BlueprintDoc {
		return buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: LONG_ID_60,
									name: "Intro",
									description: "Intro",
									time_estimate: 30,
								},
							},
							fields: [
								f({
									kind: "text",
									id: "note",
									label: "Note",
									relevant: `${refPath} = 'x'`,
								}),
							],
						},
					],
				},
			],
		});
	}

	/** The wire-final capped id for the long-id learn_module in this doc. */
	function cappedLearnId(doc: BlueprintDoc): string {
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		return buildConnectSlugMap(doc).get(formUuid)?.learn_module?.id as string;
	}

	it("validates clean when a field references the capped Connect path", () => {
		const cappedId = cappedLearnId(docReferencing("/data/placeholder"));
		const doc = docReferencing(`/data/${cappedId}`);
		const refErrors = runValidation(doc).filter(
			(e) => e.code === "INVALID_REF",
		);
		expect(refErrors).toEqual([]);
	});

	it("errors when a field references the raw uncapped 60-char path", () => {
		const doc = docReferencing(`/data/${LONG_ID_60}`);
		const refErrors = runValidation(doc).filter(
			(e) => e.code === "INVALID_REF",
		);
		// The raw path is not a node the wire emits, so it's an unknown ref.
		expect(refErrors.length).toBeGreaterThan(0);
		expect(refErrors.some((e) => e.message.includes(LONG_ID_60))).toBe(true);
	});
});
