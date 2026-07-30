/**
 * `assignDraftConnectIds` is the manager's in-flight id scope: it must assign
 * each participating sub-config the id its current draft proposes — including
 * drafts seeded from complete live or session-stashed configurations. Every
 * explicit id is kept verbatim and reserved before an empty id derives from
 * its display-name fallback; collisions stay visible for the app-wide gate.
 * Pure function, no React.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { assignDraftConnectIds, EMPTY_DRAFT } from "../ConnectEnableDialog";
import { hasDraftConnectParticipant } from "../ConnectManagerDialog";

const FORM_1 = testUuid("connect-form-1");
const FORM_2 = testUuid("connect-form-2");
const FORMS = [
	{ formUuid: FORM_1, moduleName: "Clients", formName: "Register Client" },
	{ formUuid: FORM_2, moduleName: "Clients", formName: "Edit Client" },
];

describe("assignDraftConnectIds", () => {
	it("disambiguates two blank same-module learn modules (no display drift)", () => {
		const drafts = {
			[FORM_1]: { ...EMPTY_DRAFT, learnOn: true },
			[FORM_2]: { ...EMPTY_DRAFT, learnOn: true },
		};
		expect(assignDraftConnectIds(FORMS, drafts, "learn")).toEqual([
			{ formUuid: FORM_1, kind: "learn_module", id: "clients" },
			{ formUuid: FORM_2, kind: "learn_module", id: "clients_2" },
		]);
	});

	it("preserves duplicate explicit ids so the validity guard can refuse them", () => {
		const drafts = {
			[FORM_1]: { ...EMPTY_DRAFT, deliverOn: true, deliverId: "visit" },
			[FORM_2]: { ...EMPTY_DRAFT, deliverOn: true, deliverId: "visit" },
		};
		expect(
			assignDraftConnectIds(FORMS, drafts, "deliver").map((i) => i.id),
		).toEqual(["visit", "visit"]);
	});

	it("reserves a later explicit id before an earlier blank derives", () => {
		const drafts = {
			[FORM_1]: { ...EMPTY_DRAFT, learnOn: true },
			[FORM_2]: { ...EMPTY_DRAFT, learnOn: true, learnId: "clients" },
		};
		expect(
			assignDraftConnectIds(FORMS, drafts, "learn").map((i) => i.id),
		).toEqual(["clients_2", "clients"]);
	});

	it("disambiguates colliding same-form blank sections", () => {
		const form = {
			formUuid: FORM_1,
			moduleName: "Care",
			formName: "!!!",
		};
		const drafts = {
			[FORM_1]: {
				...EMPTY_DRAFT,
				learnOn: true,
				assessmentOn: true,
			},
		};
		expect(
			assignDraftConnectIds([form], drafts, "learn").map((i) => i.id),
		).toEqual(["care", "care_2"]);
	});

	it("lets a later same-form explicit id beat an earlier blank section", () => {
		const form = {
			formUuid: FORM_1,
			moduleName: "Care",
			formName: "!!!",
		};
		const drafts = {
			[FORM_1]: {
				...EMPTY_DRAFT,
				learnOn: true,
				assessmentOn: true,
				assessmentId: "care",
			},
		};
		expect(
			assignDraftConnectIds([form], drafts, "learn").map((i) => i.id),
		).toEqual(["care_2", "care"]);
	});

	it("derives around committed ids outside the dialog target set", () => {
		const drafts = {
			[FORM_1]: { ...EMPTY_DRAFT, learnOn: true },
		};
		expect(
			assignDraftConnectIds([FORMS[0]], drafts, "learn", [
				{ formUuid: FORM_2, kind: "assessment", id: "clients" },
			]).map((i) => i.id),
		).toEqual(["clients", "clients_2"]);
	});

	it("preserves whitespace bytes as an invalid explicit buffer", () => {
		const drafts = {
			[FORM_1]: { ...EMPTY_DRAFT, deliverOn: true, deliverId: " visit " },
		};
		expect(assignDraftConnectIds([FORMS[0]], drafts, "deliver")).toEqual([
			{ formUuid: FORM_1, kind: "deliver_unit", id: " visit " },
		]);
	});

	it("ignores off sub-configs and the other mode's kinds", () => {
		const drafts = {
			[FORM_1]: {
				...EMPTY_DRAFT,
				learnOn: true,
				deliverOn: true,
				deliverId: "visit",
			},
		};
		// mode === "learn" → only the learn_module is assigned; the stray deliver
		// block (off-mode) contributes nothing to the scope.
		expect(assignDraftConnectIds([FORMS[0]], drafts, "learn")).toEqual([
			{ formUuid: FORM_1, kind: "learn_module", id: "clients" },
		]);
	});

	it("derives per-form assessment ids from '<module> <form>'", () => {
		const drafts = { [FORM_1]: { ...EMPTY_DRAFT, assessmentOn: true } };
		expect(assignDraftConnectIds([FORMS[0]], drafts, "learn")).toEqual([
			{
				formUuid: FORM_1,
				kind: "assessment",
				id: "clients_register_client",
			},
		]);
	});

	it("assigns learn_module before assessment within a form (commit order)", () => {
		const drafts = {
			[FORM_1]: { ...EMPTY_DRAFT, learnOn: true, assessmentOn: true },
		};
		expect(
			assignDraftConnectIds([FORMS[0]], drafts, "learn").map((i) => i.kind),
		).toEqual(["learn_module", "assessment"]);
	});
});

describe("Connect manager participant admission", () => {
	it("withholds apply for an app with no forms", () => {
		expect(hasDraftConnectParticipant([], {}, "learn")).toBe(false);
	});

	it("admits exactly when at least one live form draft participates", () => {
		expect(
			hasDraftConnectParticipant(
				[{ formUuid: FORM_1 }, { formUuid: FORM_2 }],
				{
					[FORM_1]: { ...EMPTY_DRAFT },
					[FORM_2]: { ...EMPTY_DRAFT, assessmentOn: true },
				},
				"learn",
			),
		).toBe(true);
	});
});
