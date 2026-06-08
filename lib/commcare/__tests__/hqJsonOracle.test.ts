/**
 * Unit tests for the HQ import-JSON oracle (`validator/hqJsonOracle.ts`).
 *
 * Each test pins one invariant against a hand-built `HqApplication` fixture — a
 * minimal clean app the corresponding check passes, and a mutated copy that
 * trips exactly the check under test. Because every wrap-fatal enum / `doc_type`
 * slot `expandDoc` fills comes from a hardcoded shell constant, a factory, or a
 * closed lookup table, the property fuzzer (`hqJsonOracle.fuzz.test.ts`) can
 * NEVER reach a bad value — so these negatives are the only thing standing
 * between a future shell/factory/table edit that drifts a slot out of `choices=`
 * and a silent regression. Every `HQJSON_*` code gets a dedicated negative here;
 * the fuzzer proves the emitter never produces one.
 *
 * The CCHQ `models.py::symbol` each check mirrors is cited in `hqJsonOracle.ts`;
 * the test names restate the import-visible symptom.
 *
 * Fixtures are built two ways. The clean baseline runs a real `expandDoc` of a
 * minimal valid `BlueprintDoc` (proving the oracle accepts genuine emitter
 * output, not just a hand-built shell). The negatives build the smallest
 * `HqApplication` via the same shell factories the emitter uses, then mutate one
 * slot to the bad value — type-cast where the slot's TS type is narrower than the
 * runtime shape CCHQ would reject. The cast is the point: it stands in for the
 * exact emitter regression (a shell/factory edit producing an off-`choices=`
 * value) the check exists to catch.
 */

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	applicationShell,
	detailColumn,
	detailPair,
	emptyFormActions,
	formShell,
	type HqApplication,
	type HqModule,
	moduleShell,
	type OpenSubCaseAction,
} from "@/lib/commcare";
import { expandDoc } from "@/lib/commcare/expander";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";

// ── Fixture builders ───────────────────────────────────────────────

/** Pull just the error codes for terse assertions. */
function codes(
	errors: ReturnType<typeof validateHqJson>,
): ValidationErrorCode[] {
	return errors.map((e) => e.code);
}

/**
 * The smallest valid `HqApplication`: one `Module` carrying one case-bearing
 * `Form` whose actions open a case (an active condition) with one subcase, plus
 * one short-detail column. Built straight from the emitter's shell factories so
 * every enum slot starts at its emitted value. Each negative test deep-mutates a
 * fresh copy of this baseline.
 */
function baselineApp(): HqApplication {
	const actions = emptyFormActions();
	// Activate the open-case condition so the condition check has a non-`never`
	// value to validate, and add a subcase so the relationship + subcase-condition
	// + subcase-update_mode checks run on a real entry.
	actions.open_case.condition = {
		type: "always",
		question: null,
		answer: null,
		operator: null,
		doc_type: "FormActionCondition",
	};
	actions.update_case.condition = {
		type: "if",
		question: "/data/q",
		answer: "yes",
		operator: "=",
		doc_type: "FormActionCondition",
	};
	actions.update_case.update = {
		notes: { question_path: "/data/notes", update_mode: "always" },
	};
	const subcase: OpenSubCaseAction = {
		doc_type: "OpenSubCaseAction",
		case_type: "visit",
		name_update: { question_path: "/data/child_name", update_mode: "always" },
		reference_id: "",
		case_properties: {
			detail: { question_path: "/data/detail", update_mode: "edit" },
		},
		repeat_context: "",
		relationship: "child",
		close_condition: {
			type: "never",
			question: null,
			answer: null,
			operator: null,
			doc_type: "FormActionCondition",
		},
		condition: {
			type: "always",
			question: null,
			answer: null,
			operator: null,
			doc_type: "FormActionCondition",
		},
	};
	actions.subcases = [subcase];

	const form = formShell(
		"form-unique-id",
		"Registration",
		"http://openrosa.org/formdesigner/abc",
		"none",
		actions,
		{},
	);

	const detail = detailPair(
		[detailColumn("name", "Name")],
		[detailColumn("name", "Name")],
	);
	const module = moduleShell(
		"module-unique-id",
		"Patients",
		"patient",
		[form],
		detail,
	);

	return applicationShell("Clinic", [module], {});
}

/** The single module of a baseline app (every negative reaches into it). */
function moduleOf(app: HqApplication): HqModule {
	return app.modules[0];
}

// ── Clean baseline ─────────────────────────────────────────────────

describe("HQ-JSON oracle — clean baseline", () => {
	it("a hand-built minimal app passes clean", () => {
		expect(validateHqJson(baselineApp())).toEqual([]);
	});

	it("a real expandDoc of a minimal valid doc passes clean", () => {
		// A registration form that opens a `patient` case (active open-case
		// action) plus a child `visit` case (subcase) — exercises the condition,
		// update_mode, and subcase-relationship slots through genuine emitter
		// output, not a hand-built shell.
		const doc = buildDoc({
			caseTypes: [
				{ name: "patient", properties: [], parent_type: undefined },
				{ name: "visit", properties: [], parent_type: "patient" },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [],
						searchInputs: [],
					},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								},
								{
									kind: "text",
									id: "notes",
									label: "Notes",
									case_property_on: "patient",
								},
							],
						},
					],
				},
				{
					name: "Visits",
					caseType: "visit",
					caseListConfig: { columns: [], searchInputs: [] },
					forms: [
						{
							name: "Visit",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "case_name",
									label: "Visit name",
									case_property_on: "visit",
								},
							],
						},
					],
				},
			],
		});

		expect(validateHqJson(expandDoc(doc))).toEqual([]);
	});
});

// ── Application-level doc_type ──────────────────────────────────────

describe("HQ-JSON oracle — application doc_type", () => {
	it("flags an application doc_type that isn't 'Application'", () => {
		const app = baselineApp();
		// `get_correct_app_class` can't pick the wrap class for a non-Application
		// doc_type, so the import fails before any module is read.
		(app as { doc_type: string }).doc_type = "RemoteApp";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_DOC_TYPE");
	});
});

// ── Module / form doc_type dispatch ─────────────────────────────────

describe("HQ-JSON oracle — doc_type dispatch", () => {
	it("flags a module doc_type outside the ModuleBase.wrap dispatch set", () => {
		const app = baselineApp();
		(moduleOf(app) as { doc_type: string }).doc_type = "BogusModule";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_MODULE_DOC_TYPE");
	});

	it("flags a form doc_type outside the FormBase.wrap dispatch set", () => {
		const app = baselineApp();
		(moduleOf(app).forms[0] as { doc_type: string }).doc_type = "BogusForm";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_FORM_DOC_TYPE");
	});
});

// ── Form choices: requires + post_form_workflow ─────────────────────

describe("HQ-JSON oracle — form choice slots", () => {
	it("flags a form requires value outside the choice list", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].requires = "always";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_FORM_REQUIRES");
	});

	it("flags a post_form_workflow value outside ALL_WORKFLOWS", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].post_form_workflow = "home";
		expect(codes(validateHqJson(app))).toContain(
			"HQJSON_BAD_POST_FORM_WORKFLOW",
		);
	});
});

// ── Condition choices: type + operator ──────────────────────────────

describe("HQ-JSON oracle — condition choice slots", () => {
	it("flags a condition type outside {if, always, never}", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.open_case.condition.type =
			"maybe" as "always";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_CONDITION_TYPE");
	});

	it("flags a non-null condition operator outside the choice list", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.update_case.condition.operator = "~=";
		expect(codes(validateHqJson(app))).toContain(
			"HQJSON_BAD_CONDITION_OPERATOR",
		);
	});

	it("does NOT flag a null operator (the always/never factory default)", () => {
		// The clean baseline's open/close conditions emit a null operator; the
		// oracle must treat null as the absent state jsonobject leaves at default.
		expect(codes(validateHqJson(baselineApp()))).not.toContain(
			"HQJSON_BAD_CONDITION_OPERATOR",
		);
	});
});

// ── update_mode choices (update map + subcase) ──────────────────────

describe("HQ-JSON oracle — update_mode choice slot", () => {
	it("flags an update_mode in the update-case map outside {always, edit}", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.update_case.update.notes.update_mode =
			"sometimes";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_UPDATE_MODE");
	});

	it("flags an update_mode on a subcase name_update outside the choice list", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.subcases[0].name_update.update_mode =
			"never";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_UPDATE_MODE");
	});
});

// ── subcase relationship choice ─────────────────────────────────────

describe("HQ-JSON oracle — subcase relationship choice slot", () => {
	it("flags a subcase relationship outside {child, extension}", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.subcases[0].relationship = "sibling";
		expect(codes(validateHqJson(app))).toContain(
			"HQJSON_BAD_SUBCASE_RELATIONSHIP",
		);
	});
});

// ── detail display choice ───────────────────────────────────────────

describe("HQ-JSON oracle — detail display choice slot", () => {
	it("flags a case detail display outside {short, long}", () => {
		const app = baselineApp();
		moduleOf(app).case_details.short.display = "medium" as "short";
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_DETAIL_DISPLAY");
	});
});

// ── finite-number column slots ──────────────────────────────────────

describe("HQ-JSON oracle — column finite-number slots", () => {
	it("flags a non-finite late_flag (NaN serializes to null at import)", () => {
		const app = baselineApp();
		moduleOf(app).case_details.short.columns[0].late_flag = Number.NaN;
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_TYPE");
	});

	it("flags a non-finite time_ago_interval (Infinity from a bad divisor)", () => {
		const app = baselineApp();
		moduleOf(app).case_details.long.columns[0].time_ago_interval =
			Number.POSITIVE_INFINITY;
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_TYPE");
	});
});

// ── Multimedia map shape regression ─────────────────────────────────

describe("HQ-JSON oracle — multimedia_map shape", () => {
	it("flags a multimedia_map key missing the jr://file/ prefix", () => {
		const app = baselineApp();
		// A bare path with no `jr://file/` prefix — CCHQ's media_resources
		// raises MediaResourceError on the next suite regeneration. This is
		// exactly the shape an earlier Segment-3 emit bug produced before
		// CR-4 caught it.
		app.multimedia_map["commcare/aaa.png"] = {
			multimedia_id: "aaa",
			media_type: "CommCareImage",
			version: 1,
		};
		expect(codes(validateHqJson(app))).toContain(
			"HQJSON_BAD_MULTIMEDIA_MAP_KEY",
		);
	});

	it("flags an unknown multimedia_map media_type", () => {
		const app = baselineApp();
		app.multimedia_map["jr://file/commcare/aaa.png"] = {
			multimedia_id: "aaa",
			media_type: "CommCareTypo",
			version: 1,
		};
		expect(codes(validateHqJson(app))).toContain(
			"HQJSON_BAD_MULTIMEDIA_MAP_MEDIA_TYPE",
		);
	});

	it("accepts every live CommCare media class name", () => {
		const app = baselineApp();
		app.multimedia_map["jr://file/commcare/img.png"] = {
			multimedia_id: "1",
			media_type: "CommCareImage",
			version: 1,
		};
		app.multimedia_map["jr://file/commcare/aud.mp3"] = {
			multimedia_id: "2",
			media_type: "CommCareAudio",
			version: 1,
		};
		app.multimedia_map["jr://file/commcare/vid.mp4"] = {
			multimedia_id: "3",
			media_type: "CommCareVideo",
			version: 1,
		};
		expect(validateHqJson(app)).toEqual([]);
	});
});

// ── Nav media dict shape ───────────────────────────────────────────

describe("HQ-JSON oracle — nav media dict shape", () => {
	it("flags a module media_image value missing the jr://file/ prefix", () => {
		const app = baselineApp();
		moduleOf(app).media_image = { en: "commcare/no-prefix.png" };
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_NAV_MEDIA_VALUE");
	});

	it("flags a module media_audio value missing the prefix", () => {
		const app = baselineApp();
		moduleOf(app).media_audio = { en: "/audio/no-prefix.mp3" };
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_NAV_MEDIA_VALUE");
	});

	it("flags a form media_image value missing the prefix", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].media_image = { en: "no-prefix" };
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_NAV_MEDIA_VALUE");
	});

	it("flags a case-list media_image value missing the prefix", () => {
		const app = baselineApp();
		moduleOf(app).case_list.media_image = { en: "no-prefix" };
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_NAV_MEDIA_VALUE");
	});

	it("accepts well-formed jr://file/ media values across all carriers", () => {
		const app = baselineApp();
		moduleOf(app).media_image = { en: "jr://file/commcare/m-icon.png" };
		moduleOf(app).media_audio = { en: "jr://file/commcare/m-audio.mp3" };
		moduleOf(app).forms[0].media_image = {
			en: "jr://file/commcare/f-icon.png",
		};
		moduleOf(app).case_list.media_image = {
			en: "jr://file/commcare/cl-icon.png",
		};
		expect(validateHqJson(app)).toEqual([]);
	});

	it("accepts an empty media dict (no carrier media)", () => {
		// The baseline app already emits `media_image: {}` / `media_audio: {}` —
		// the empty-dict shape every shell produces by default. The clean
		// baseline test (above) proves this passes, but pin it explicitly so a
		// future emitter change that drops the empty default is caught.
		const app = baselineApp();
		expect(moduleOf(app).media_image).toEqual({});
		expect(validateHqJson(app)).toEqual([]);
	});
});

// ── Logo refs shape ────────────────────────────────────────────────

describe("HQ-JSON oracle — logo_refs shape", () => {
	it("flags a logo_refs path missing the jr://file/ prefix", () => {
		const app = baselineApp();
		app.logo_refs = {
			hq_logo_web_apps: { path: "commcare/no-prefix.png" },
		};
		expect(codes(validateHqJson(app))).toContain("HQJSON_BAD_LOGO_REF");
	});

	it("accepts a well-formed jr://file/ logo path", () => {
		const app = baselineApp();
		app.logo_refs = {
			hq_logo_web_apps: { path: "jr://file/commcare/logo.png" },
		};
		expect(validateHqJson(app)).toEqual([]);
	});

	it("accepts an empty logo_refs (no logo configured)", () => {
		const app = baselineApp();
		expect(app.logo_refs).toEqual({});
		expect(validateHqJson(app)).toEqual([]);
	});
});
