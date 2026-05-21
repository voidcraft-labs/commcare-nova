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

	it("dedups per-kind, not across kinds — a learn_module and a deliver_unit may share a slug", () => {
		// Different Connect kinds land in different DB tables (LearnModule
		// vs DeliverUnit) and different XForm data wrappers, so cross-kind
		// slug equality is harmless. Forcing them apart would be needless.
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
								assessment: { id: "shared_slug", user_score: "100" },
							},
						},
					],
				},
			],
		});

		const config = buildConnectSlugMap(doc).get(onlyFormUuid(doc));
		// Neither is over-length, so neither needs truncation; cross-kind
		// equality is preserved rather than disambiguated.
		expect(config?.learn_module?.id).toBe("shared_slug");
		expect(config?.assessment?.id).toBe("shared_slug");
	});
});

describe("buildConnectSlugMap — determinism", () => {
	it("produces identical slugs across repeated runs of the same doc", () => {
		// `update_or_create` keys on the slug, so the same input must always
		// map to the same slug — otherwise a re-upload would orphan the
		// prior row and re-create the module. Two colliding ids exercise the
		// disambiguation path, which is where non-determinism would hide.
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

	it("substitutes the empty-id fallback for a learn_module with no id", () => {
		// The wire-final id is never empty: an absent id falls back to the
		// stable per-kind sentinel before capping.
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							connect: {
								learn_module: {
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
		expect(
			buildConnectSlugMap(doc).get(onlyFormUuid(doc))?.learn_module?.id,
		).toBe("connect_learn");
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

// ── #5 lock-in — empty <user_score/> + value-in-bind ─────────────────
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
