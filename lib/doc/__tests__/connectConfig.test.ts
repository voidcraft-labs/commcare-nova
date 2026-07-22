import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { describe, expect, it } from "vitest";
import {
	buildDoc,
	type FieldSpec,
	type FormSpec,
	f,
	xp,
} from "@/lib/__tests__/docHelpers";
import { connectIdError } from "@/lib/commcare/connectSlugs";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { AppConnectId } from "@/lib/doc/hooks/useAppConnectIds";
import { asUuid } from "@/lib/doc/types";
import type { ConnectConfig, ConnectType, Uuid } from "@/lib/domain";
import {
	dedupeRestoredConnectIds,
	type RestoredConnectIdContext,
} from "../connectConfig";

// ── dedupeRestoredConnectIds ─────────────────────────────────────────
//
// The UI restore/seed twin of the agent path's `enforceConnectIds`. A
// Connect toggle writes a whole config at once (re-enable from a stash,
// restore a sub-block from its ref, or seed a fresh pair), and this helper
// forces every id unique at the source before the write. Format/length were
// valid when stashed (or absent on a fresh seed) and can't drift, so only
// uniqueness is re-checked: a still-unique id is kept, a colliding one is
// suffixed from itself, an absent one is autofilled from the entity name.

const FORM_A = asUuid("form-a");
const FORM_B = asUuid("form-b");

describe("dedupeRestoredConnectIds", () => {
	// Module/form names feed the absent-id autofill: "Module A" snakes to
	// "module_a", the pair "Module A Form A" to "module_a_form_a".
	const ctx = (overrides: {
		formUuid?: Uuid;
		appConnectIds?: AppConnectId[];
	}): RestoredConnectIdContext => ({
		formUuid: overrides.formUuid ?? FORM_A,
		appConnectIds: overrides.appConnectIds ?? [],
		moduleName: "Module A",
		formName: "Form A",
	});

	it("suffixes a restored id that now collides with another form's id", () => {
		// The reachable bug: FORM_B took "intro" while FORM_A's learn_module
		// was toggled off. Restoring FORM_A must not write the duplicate — it
		// suffixes from the user's own slug ("intro" → "intro_2") rather than
		// replacing it wholesale.
		const result = dedupeRestoredConnectIds(
			{
				learn_module: {
					id: "intro",
					name: "Intro",
					description: "x",
					time_estimate: 5,
				},
			},
			ctx({
				appConnectIds: [
					{ formUuid: FORM_B, kind: "learn_module", id: "intro" },
				],
			}),
		);
		expect(result.learn_module?.id).toBe("intro_2");
		expect(connectIdError(result.learn_module?.id as string)).toBeNull();
	});

	it("keeps a restored id that is still unique (no work lost)", () => {
		// FORM_A's own "intro" must not read as a self-conflict — this form's
		// ids are excluded from the scope, so the restore keeps it verbatim
		// along with the block's other fields.
		const result = dedupeRestoredConnectIds(
			{
				learn_module: {
					id: "intro",
					name: "Intro",
					description: "keep me",
					time_estimate: 7,
				},
			},
			ctx({
				appConnectIds: [
					{ formUuid: FORM_A, kind: "learn_module", id: "intro" },
					{ formUuid: FORM_B, kind: "learn_module", id: "other" },
				],
			}),
		);
		expect(result.learn_module?.id).toBe("intro");
		expect(result.learn_module?.description).toBe("keep me");
		expect(result.learn_module?.time_estimate).toBe(7);
	});

	it("autofills an absent id from the entity name (the seed path)", () => {
		// The seed / fresh-enable path passes blocks with no id; the helper
		// fills them from the entity name exactly as creation-time autofill
		// does — module name for learn_module, "<module> <form>" for assessment.
		const result = dedupeRestoredConnectIds(
			{
				learn_module: { name: "L", description: "x", time_estimate: 5 },
				assessment: { user_score: xp("100") },
			},
			ctx({}),
		);
		expect(result.learn_module?.id).toBe("module_a");
		expect(result.assessment?.id).toBe("module_a_form_a");
	});

	it("autofills absent deliver_unit / task ids from module and pair names", () => {
		// Same autofill, the deliver-mode kinds: deliver_unit derives from the
		// module name, task from "<module> <form>".
		const result = dedupeRestoredConnectIds(
			{
				deliver_unit: { name: "Unit" },
				task: { name: "Task", description: "x" },
			},
			ctx({}),
		);
		expect(result.deliver_unit?.id).toBe("module_a");
		expect(result.task?.id).toBe("module_a_form_a");
	});

	it("heals a pre-existing cross-form duplicate on an untouched sibling block", () => {
		// Heal-on-touch: the base scope excludes ALL of this form's ids, so the
		// write re-checks every block in the config, not just the one being
		// restored. If a sibling carried an id that duplicated ANOTHER form's,
		// it's re-derived too — even though only one sub-toggle was nominally
		// touched. That state shouldn't reach a user (every writer forces ids
		// unique at the source), but if it ever did, the restore must heal it
		// rather than propagate the duplicate. Here FORM_A's still-enabled
		// assessment "other" duplicates FORM_B's learn_module "other".
		const result = dedupeRestoredConnectIds(
			{
				learn_module: {
					id: "intro",
					name: "Intro",
					description: "x",
					time_estimate: 5,
				},
				assessment: { id: "other", user_score: xp("100") },
			},
			ctx({
				appConnectIds: [
					{ formUuid: FORM_B, kind: "learn_module", id: "other" },
				],
			}),
		);
		expect(result.learn_module?.id).toBe("intro"); // unique → kept
		expect(result.assessment?.id).toBe("other_2"); // healed off FORM_B's "other"
	});

	it("disambiguates a duplicate shared across two blocks in one config", () => {
		// Two blocks in the same restored config share an id (shouldn't happen,
		// but the per-config accumulation must catch it): the first kind in
		// fixed order (learn_module) keeps it, the second (assessment) suffixes.
		const result = dedupeRestoredConnectIds(
			{
				learn_module: {
					id: "dup",
					name: "L",
					description: "x",
					time_estimate: 5,
				},
				assessment: { id: "dup", user_score: xp("100") },
			},
			ctx({}),
		);
		expect(result.learn_module?.id).toBe("dup");
		expect(result.assessment?.id).toBe("dup_2");
	});

	it("leaves a fully-unique multi-kind config untouched", () => {
		const result = dedupeRestoredConnectIds(
			{
				learn_module: {
					id: "lm",
					name: "L",
					description: "x",
					time_estimate: 5,
				},
				assessment: { id: "as", user_score: xp("100") },
			},
			ctx({}),
		);
		expect(result.learn_module?.id).toBe("lm");
		expect(result.assessment?.id).toBe("as");
	});
});

// ── XForm Export ─────────────────────────────────────────────────────

/**
 * Minimal domain doc carrying one survey form with the supplied Connect
 * config + optional fields. Used exclusively for `expandDoc` assertions
 * — the XForm export tests only care about the emitted Connect blocks,
 * so the field content is irrelevant beyond what each sub-test names.
 */
function makeConnectExpandDoc(
	connectType: ConnectType,
	connect: ConnectConfig | undefined,
	formName: string,
	fields: FieldSpec[] = [],
) {
	return buildDoc({
		appName: "Connect Test App",
		connectType,
		modules: [
			{
				name: "Main",
				forms: [
					{
						name: formName,
						type: "survey",
						connect,
						fields,
					},
				],
			},
		],
	});
}

describe("Connect XForm export", () => {
	it("generates correct learn module data block", () => {
		const doc = makeConnectExpandDoc(
			"learn",
			{
				learn_module: {
					id: "main",
					name: "ILC Module",
					description: "Training for ILC",
					time_estimate: 5,
				},
			},
			"ILC Training",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		// The stored id is the wire element name — the resolver passes it
		// through verbatim (ids are valid by construction at the source).
		expect(xml).toContain('<main vellum:role="ConnectLearnModule">');
		expect(xml).toContain('xmlns="http://commcareconnect.com/data/v1/learn"');
		expect(xml).toContain("<name>ILC Module</name>");
		expect(xml).toContain("<description>Training for ILC</description>");
		expect(xml).toContain("<time_estimate>5</time_estimate>");
		expect(xml).toContain("</main>");
	});

	it("generates correct assessment block with calculate bind", () => {
		const doc = makeConnectExpandDoc(
			"learn",
			{
				learn_module: {
					id: "main",
					name: "Test",
					description: "Test",
					time_estimate: 1,
				},
				assessment: { id: "main_ilc_training", user_score: xp("100") },
			},
			"ILC Training",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain(
			'<main_ilc_training vellum:role="ConnectAssessment">',
		);
		expect(xml).toContain("<user_score/>");
		expect(xml).toContain(
			'nodeset="/data/main_ilc_training/assessment/user_score" calculate="100"',
		);
	});

	it("generates correct deliver unit block with XPath binds", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					id: "main",
					name: "Weekly Report",
					entity_id: xp("concat('user', '-', today())"),
					entity_name: xp("'test_user'"),
				},
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('<main vellum:role="ConnectDeliverUnit">');
		expect(xml).toContain(
			'<deliver xmlns="http://commcareconnect.com/data/v1/learn"',
		);
		expect(xml).toContain("<name>Weekly Report</name>");
		expect(xml).toContain("<entity_id/>");
		expect(xml).toContain("<entity_name/>");
		expect(xml).toContain('nodeset="/data/main/deliver/entity_id"');
		expect(xml).toContain('nodeset="/data/main/deliver/entity_name"');
	});

	it("generates task block", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					id: "main",
					name: "Unit",
					entity_id: xp("'id'"),
					entity_name: xp("'name'"),
				},
				task: {
					id: "main_weekly_report",
					name: "Delivery Task",
					description: "Complete the delivery",
				},
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('<main_weekly_report vellum:role="ConnectTask">');
		expect(xml).toContain("<name>Delivery Task</name>");
		expect(xml).toContain("<description>Complete the delivery</description>");
	});

	it("includes secondary instances when Connect XPaths reference session data", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					id: "main",
					name: "Unit",
					entity_id: xp("concat(#user/username, '-', today())"),
					entity_name: xp("#user/username"),
				},
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('id="commcaresession"');
	});

	it("does not emit Connect blocks when connect is absent", () => {
		const doc = makeConnectExpandDoc("learn", undefined, "ILC Training");
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).not.toContain("commcareconnect.com");
		expect(xml).not.toContain("connect_learn");
	});
});

// ── Validation ──────────────────────────────────────────────────────

/**
 * Build a one-module, one-form BlueprintDoc carrying the supplied Connect
 * config. Mirrors `makeConnectExpandDoc` but sized for the validator:
 * the validator reads the form's metadata + connect block, not the
 * field content, so tests inline minimal field sets where needed.
 */
function makeConnectValidationDoc(
	connectType: ConnectType,
	connect: ConnectConfig | undefined,
	formName = "Form",
	extraFields: FormSpec["fields"] = [],
) {
	return buildDoc({
		appName: "Connect Test App",
		connectType,
		modules: [
			{
				name: "Main",
				forms: [
					{
						name: formName,
						type: "survey",
						connect,
						fields: extraFields,
					},
				],
			},
		],
	});
}

describe("Connect validation", () => {
	it("validates learn form with neither learn_module nor assessment", () => {
		const doc = makeConnectValidationDoc("learn", {});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_LEARN")).toBe(true);
	});

	it("passes validation for learn form with only assessment", () => {
		const doc = makeConnectValidationDoc("learn", {
			assessment: { user_score: xp("100") },
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_LEARN")).toBe(false);
	});

	it("validates deliver form missing both deliver_unit and task", () => {
		const doc = makeConnectValidationDoc("deliver", {});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_DELIVER")).toBe(true);
	});

	it("passes validation for deliver form with only task", () => {
		const doc = makeConnectValidationDoc("deliver", {
			task: { name: "Delivery Task", description: "Complete the delivery" },
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_DELIVER")).toBe(
			false,
		);
	});

	it("passes validation for well-formed learn config", () => {
		// Ids are present, as every source path leaves them (creation/update
		// tool autofill, UI seed/restore) — an id-less block is itself a
		// finding (CONNECT_ID_MISSING), covered in validationRules.test.ts.
		const doc = makeConnectValidationDoc(
			"learn",
			{
				learn_module: {
					id: "module",
					name: "Module",
					description: "Desc",
					time_estimate: 5,
				},
				assessment: { id: "module_quiz", user_score: xp("100") },
			},
			"Form",
			[f({ kind: "text", id: "q", label: "Q" })],
		);
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors).toHaveLength(0);
	});

	it("passes validation for well-formed deliver config", () => {
		const doc = makeConnectValidationDoc(
			"deliver",
			{
				deliver_unit: {
					id: "unit",
					name: "Unit",
					entity_id: xp("concat('user', '-', today())"),
					entity_name: xp("'test_user'"),
				},
			},
			"Form",
			[f({ kind: "text", id: "q", label: "Q" })],
		);
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors).toHaveLength(0);
	});
});
