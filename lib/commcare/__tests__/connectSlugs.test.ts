/**
 * Connect-id validity, autofill, and the wire-emit resolver.
 *
 * A connect id (`learn_module.id` / `assessment.id` / `deliver_unit.id` /
 * `task.id`) becomes an XForm element name and a CommCare Connect DB slug
 * (tightest column `varchar(50)`), so it must be a legal XML element name
 * AND within 50 chars AND unique across the app. The redesign forces all
 * three correct at the SOURCE:
 *  - `connectIdError(id)` — the format/length verdict (shared by the UI
 *    commit guard and the validator's connect-id rules).
 *  - `connectIdConflictError(id, existingIds)` — the contextual uniqueness
 *    verdict for an explicit set.
 *  - `deriveConnectId(name, existingIds)` — the creation-time autofill:
 *    snake → cap → suffix-uniquify, always producing a valid, unique id.
 *  - `buildConnectSlugMap(doc)` — the emit-time resolver, now a typed
 *    pass-through: it asserts each block's id is set (the source-
 *    correctness invariant) and narrows the type, with NO cap / dedup /
 *    fallback (those moved to the source helpers above).
 *
 * These tests cover each helper directly plus the resolver end-to-end
 * through `expandDoc` (wire-surface consistency) and `runValidation` (the
 * valid-path set).
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	buildConnectSlugMap,
	CONNECT_SLUG_MAX_LENGTH,
	connectIdConflictError,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { BlueprintDoc, Uuid } from "@/lib/domain";

// ── Fixture helpers ──────────────────────────────────────────────────

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

describe("buildConnectSlugMap — typed pass-through (no transform)", () => {
	// The resolver does NOT cap, dedup, or fall back. Connect ids are forced
	// valid + unique + within-length at the SOURCE (creation autofill via
	// `deriveConnectId`, the field/tool guards via `connectIdError` +
	// `connectIdConflictError`, and the validate-time backfill). So the
	// resolver only narrows `id` from `string | undefined` to `string` and
	// passes the stored id through verbatim.

	it("passes a valid stored id through unchanged", () => {
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
									id: "intro_module",
									name: "Intro",
									description: "Intro",
									time_estimate: 30,
								},
								assessment: { id: "intro_quiz", user_score: "100" },
							},
						},
					],
				},
			],
		});
		const config = buildConnectSlugMap(doc).get(onlyFormUuid(doc));
		// Ids are returned exactly as stored — no slicing, no suffixing.
		expect(config?.learn_module?.id).toBe("intro_module");
		expect(config?.assessment?.id).toBe("intro_quiz");
	});

	it("passes every kind's id through across deliver + learn", () => {
		const learn = buildDoc({
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
									id: "lm_id",
									name: "L",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
		const deliver = buildDoc({
			connectType: "deliver",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							connect: {
								deliver_unit: { id: "du_id", name: "V" },
								task: { id: "task_id", name: "T", description: "x" },
							},
						},
					],
				},
			],
		});
		expect(
			buildConnectSlugMap(learn).get(onlyFormUuid(learn))?.learn_module?.id,
		).toBe("lm_id");
		const dConfig = buildConnectSlugMap(deliver).get(onlyFormUuid(deliver));
		expect(dConfig?.deliver_unit?.id).toBe("du_id");
		expect(dConfig?.task?.id).toBe("task_id");
	});

	it("throws an invariant violation if a block reaches it with no id", () => {
		// Source-correctness should make this unreachable. If it ever fires,
		// an entry point skipped enforcement — the resolver refuses to invent
		// an id rather than silently paper over the gap.
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
								// id deliberately omitted to simulate the broken state.
								learn_module: {
									name: "Intro",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
		expect(() => buildConnectSlugMap(doc)).toThrow(/no id/i);
	});

	it("throws on a present-but-over-length id (it does NOT cap)", () => {
		// The resolver is the emit invariant: a valid id or a loud throw. An
		// over-length id is NOT silently capped here — that would corrupt the
		// wire. Source-enforcement keeps ids ≤50; this is the tripwire that
		// catches any gap before it reaches CommCare.
		const overLength = "a".repeat(CONNECT_SLUG_MAX_LENGTH + 10);
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
									id: overLength,
									name: "Intro",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
		// The thrown message cites the offending id and the length reason.
		expect(() => buildConnectSlugMap(doc)).toThrow(overLength);
		expect(() => buildConnectSlugMap(doc)).toThrow(
			String(CONNECT_SLUG_MAX_LENGTH),
		);
	});

	it("throws on a present-but-bad-character id (it does NOT sanitize)", () => {
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
								deliver_unit: { id: "bad id", name: "V" },
							},
						},
					],
				},
			],
		});
		expect(() => buildConnectSlugMap(doc)).toThrow(/bad id/);
	});

	it("throws on a duplicate id across two forms (citing both sites + the id)", () => {
		// The emit invariant covers uniqueness, not just per-id validity. Two
		// distinct blocks sharing an id would collide on Connect's `(app, slug)`
		// key / produce duplicate XForm element names — so the resolver fails
		// loud if a duplicate somehow reaches emission (the source guards +
		// validator should catch it first).
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training A",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: "shared_slug",
									name: "A",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
				{
					name: "Training B",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: "shared_slug",
									name: "B",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
		expect(() => buildConnectSlugMap(doc)).toThrow(/shared_slug/);
		expect(() => buildConnectSlugMap(doc)).toThrow(/duplicate/i);
	});

	it("skips a cross-mode block (deliver_unit on a learn app) — no throw", () => {
		// The connect schema isn't mode-discriminated, so a learn app can carry
		// a stray deliver_unit block. The defaulter only fills the matching
		// mode's blocks; the resolver must agree — process only blocks matching
		// `connectType`, so a cross-mode (and possibly id-less) block neither
		// emits nor trips the invariant.
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
									id: "intro_module",
									name: "Intro",
									description: "x",
									time_estimate: 5,
								},
								// Stray cross-mode block, id-less — must be ignored.
								deliver_unit: { name: "Stray" },
							},
						},
					],
				},
			],
		});
		const config = buildConnectSlugMap(doc).get(onlyFormUuid(doc));
		expect(config?.learn_module?.id).toBe("intro_module");
		// The cross-mode deliver_unit is not emitted.
		expect(config?.deliver_unit).toBeUndefined();
	});

	it("produces NO map entry for a form whose connect holds only a cross-mode stray", () => {
		// A learn form carrying ONLY a stray deliver_unit has nothing to emit.
		// The contract is `map.get(formUuid) === undefined` means "nothing to
		// emit" — so a present-but-empty `{}` entry would be a contract
		// violation (a future consumer doing `if (map.get(f)) emitWrapper()`
		// would emit a spurious empty wrapper).
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							// No live (learn) kind — only a cross-mode stray.
							connect: { deliver_unit: { id: "stray", name: "Stray" } },
						},
					],
				},
			],
		});
		expect(buildConnectSlugMap(doc).get(onlyFormUuid(doc))).toBeUndefined();
	});
});

describe("buildConnectSlugMap — purity / idempotence", () => {
	it("is pure — the same doc yields identical resolved ids on every call", () => {
		// The resolver is a pure pass-through over already-valid ids, so two
		// calls on the same doc return identical results. (Ids are forced
		// valid at the source; the resolver never transforms — it just
		// narrows the type.)
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
									id: "module_one",
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
									id: "module_two",
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

	// Note: id-less blocks are filled at the source (`enforceConnectIds` on
	// the SA tools, `dedupeRestoredConnectIds` on the UI seed/restore), so
	// they never reach the resolver id-less in normal flow — the autofill +
	// uniqueness behavior is covered by the `deriveConnectId` tests below
	// and the per-tool enforcement tests, the validator's
	// `CONNECT_ID_MISSING` backstop covers a doc that skipped enforcement,
	// and the resolver's invariant-throw on a blank id is covered by the
	// pass-through describe above.
});

// ── End-to-end through expandDoc — wire-surface consistency ──────────

describe("Connect id — end-to-end XForm consistency", () => {
	// The resolver passes the stored id through; the XForm builder must use
	// that one id at every site (wrapper element, `id=` attr, bind nodeset)
	// so they all agree. Ids are valid by construction at the source, so
	// these use a normal stored id — no capping is involved.
	const learnDoc = buildDoc({
		appName: "Learn",
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
								id: "intro_module",
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

	it("emits the stored id identically in the wrapper element, the id= attribute, and the bind nodeset", () => {
		const xml = firstXForm(learnDoc);
		const id = buildConnectSlugMap(learnDoc).get(onlyFormUuid(learnDoc))
			?.learn_module?.id as string;
		expect(id).toBe("intro_module");

		// Wrapper element opens + closes with the id.
		expect(xml).toContain(`<${id} vellum:role="ConnectLearnModule">`);
		expect(xml).toContain(`</${id}>`);
		// The Connect-namespaced inner element carries the id= attr.
		expect(xml).toContain(
			`<module xmlns="http://commcareconnect.com/data/v1/learn" id="${id}">`,
		);
		// The bind nodeset references the same data path.
		expect(xml).toContain(
			`<bind vellum:nodeset="#form/${id}" nodeset="/data/${id}"/>`,
		);
	});

	it("agrees between the XForm bind and the case-references load map for a deliver_unit", () => {
		// `entity_id` carries a `#case/` hashtag so it surfaces in the
		// case-references load map. The load-map key and the XForm bind
		// nodeset must reference the SAME id, or the runtime would preload
		// into a node the form never declares.
		const doc = buildDoc({
			appName: "Deliver",
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
									id: "vendor_visit",
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

		const id = buildConnectSlugMap(doc).get(onlyFormUuid(doc))?.deliver_unit
			?.id as string;
		const expandedForm = expandDoc(doc).modules[0].forms[0];
		const load = expandedForm.case_references_data.load;

		// The load map keys on the same id as the bind.
		expect(load[`/data/${id}/deliver/entity_id`]).toEqual([
			"#case/beneficiary_id",
		]);
	});

	it("throws (not silently corrupts) when an over-length id reaches expandDoc", () => {
		// The emit boundary: a doc carrying an over-length connect id makes
		// `expandDoc` throw via `narrowId`, so the compile/upload routes catch
		// it and return a clean error instead of shipping a corrupt wire.
		const doc = buildDoc({
			appName: "Over-length id",
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
									id: "a".repeat(CONNECT_SLUG_MAX_LENGTH + 10),
									name: "Intro",
									description: "x",
									time_estimate: 5,
								},
							},
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		expect(() => expandDoc(doc)).toThrow(/invalid id/i);
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

// ── Validator valid-path set exposes the stored connect id ───────────
//
// `validateBlueprintDeep` exposes each Connect block's data path so a user
// XPath may reference the Connect node. The path uses the block's stored id
// (the resolver passes it through), so a field referencing it validates
// clean — and a field referencing a path no block declares is caught.
// `task` is included because it's a wrapper-only bind like `learn_module`
// (`<bind nodeset="/data/<taskId>"/>`), so its path is a real wire node too.

describe("Connect id — validator valid-path set exposes the stored id", () => {
	const BOGUS_PATH = "/data/no_such_connect_node";

	/** A learn doc with one field whose `relevant` references `refPath`. */
	function learnDocReferencing(refPath: string): BlueprintDoc {
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
									id: "intro_module",
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

	/** A deliver doc with a task block + one field referencing `refPath`. */
	function taskDocReferencing(refPath: string): BlueprintDoc {
		return buildDoc({
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							connect: {
								task: { id: "visit_task", name: "Visit", description: "x" },
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

	const refErrors = (doc: BlueprintDoc) =>
		runValidation(doc).filter((e) => e.code === "INVALID_REF");

	it("validates clean when a field references the learn_module path", () => {
		expect(refErrors(learnDocReferencing("/data/intro_module"))).toEqual([]);
	});

	it("errors when a field references a path no connect block declares", () => {
		const errs = refErrors(learnDocReferencing(BOGUS_PATH));
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.some((e) => e.message.includes("no_such_connect_node"))).toBe(
			true,
		);
	});

	it("validates clean when a field references the task path", () => {
		expect(refErrors(taskDocReferencing("/data/visit_task"))).toEqual([]);
	});

	it("errors when a field references a bogus task path", () => {
		expect(refErrors(taskDocReferencing(BOGUS_PATH)).length).toBeGreaterThan(0);
	});
});

// ── connectIdError — single source of connect-id validity ──────────
//
// Returns a human-readable reason when an id is not a valid XML element
// name (`XML_ELEMENT_NAME_REGEX`) OR is over `CONNECT_SLUG_MAX_LENGTH`,
// else `null`. Shared by the field-level commit guard (`InlineField` via
// `LearnConfig`) and the validator's connect-id rules, so the two can
// never disagree about what counts as a valid id.

describe("connectIdError", () => {
	it("returns a reason for an id with illegal characters", () => {
		expect(connectIdError("2024 Intake")).not.toBeNull();
		expect(connectIdError("has space")).not.toBeNull();
		expect(connectIdError("1st_module")).not.toBeNull(); // leading digit
		expect(connectIdError("bad-dash")).not.toBeNull(); // hyphen illegal
	});

	it("returns a reason for an id over the length limit", () => {
		const tooLong = "a".repeat(CONNECT_SLUG_MAX_LENGTH + 1);
		const reason = connectIdError(tooLong);
		expect(reason).not.toBeNull();
		// Length reason names the limit so callers (and the validator) can
		// surface it.
		expect(reason).toContain(String(CONNECT_SLUG_MAX_LENGTH));
	});

	it("returns null for a valid id (legal chars, within length)", () => {
		expect(connectIdError("intake_2024")).toBeNull();
		expect(connectIdError("_leading_underscore")).toBeNull();
		expect(connectIdError("a".repeat(CONNECT_SLUG_MAX_LENGTH))).toBeNull();
	});
});

// ── deriveConnectId — autofill a valid, unique id from a name ──────────
//
// The "force correct at the source" autofill: the instant a connect block
// is created/enabled without an explicit id, it gets a valid, unique id
// derived from its name — STORED in the doc, not conjured at emit. Always
// a legal XML element name (`toSnakeId`), within the length limit (cap),
// and unique against the supplied existing ids (suffix-disambiguated).

describe("deriveConnectId", () => {
	it("snake-cases the name into a legal element name", () => {
		expect(deriveConnectId("Module 3 Intro", new Set())).toBe("module_3_intro");
		// Result is always a valid connect id (no error from the validity helper).
		expect(
			connectIdError(deriveConnectId("2024 Intake!", new Set())),
		).toBeNull();
	});

	it("caps the derived id at the length limit", () => {
		const longName = "Conducting the fifteen question seller interview module";
		const id = deriveConnectId(longName, new Set());
		expect(id.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		expect(connectIdError(id)).toBeNull();
	});

	it("uniquifies against existing ids with a numeric suffix", () => {
		const existing = new Set(["intro"]);
		const id = deriveConnectId("Intro", existing);
		expect(id).not.toBe("intro");
		expect(existing.has(id)).toBe(false);
	});

	it("cascades the suffix when multiple collisions exist", () => {
		const existing = new Set(["intro", "intro_2", "intro_3"]);
		const id = deriveConnectId("Intro", existing);
		expect(existing.has(id)).toBe(false);
		expect(id.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
	});

	it("keeps a suffixed id within the length cap by re-cutting the base", () => {
		// A name at the cap that collides must still produce a ≤50 id once a
		// suffix is appended — the base is re-cut to make room.
		const base = "a".repeat(CONNECT_SLUG_MAX_LENGTH);
		const existing = new Set([base]);
		const id = deriveConnectId("a".repeat(60), existing);
		expect(id.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		expect(id).not.toBe(base);
	});

	it("is deterministic — same name + same existing set yields the same id", () => {
		const existing = new Set(["intro"]);
		expect(deriveConnectId("Intro", new Set(existing))).toBe(
			deriveConnectId("Intro", new Set(existing)),
		);
	});
});

// ── connectIdConflictError — contextual uniqueness check ───────────────
//
// Connect ids must be unique across the whole app (every block's id lands
// in a per-table `(app, slug)` key, and co-located blocks share one
// `<data>` element scope). An EXPLICIT set (UI commit or tool) that
// duplicates an existing id is rejected — not silently renamed. The check
// is contextual, so it's separate from the format/length `connectIdError`.

describe("connectIdConflictError", () => {
	it("returns a reason when the id already exists in the set", () => {
		expect(connectIdConflictError("intro", new Set(["intro"]))).not.toBeNull();
	});

	it("returns null when the id is unique", () => {
		expect(connectIdConflictError("intro", new Set(["other"]))).toBeNull();
		expect(connectIdConflictError("intro", new Set())).toBeNull();
	});
});
