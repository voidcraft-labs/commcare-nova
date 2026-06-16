/**
 * `assignDraftConnectIds` is the manager's in-flight id scope: it must assign
 * each participating sub-config the SAME id the commit's
 * `dedupeRestoredConnectIds` will — a free explicit id kept verbatim, a
 * collision (explicit or derived) suffixed — so the editor's seed + inline
 * guard never diverge from what's stored. Pure function, no React.
 */
import { describe, expect, it } from "vitest";
import { assignDraftConnectIds, EMPTY_DRAFT } from "../ConnectEnableDialog";

const FORMS = [
	{ formUuid: "f1", moduleName: "Clients", formName: "Register Client" },
	{ formUuid: "f2", moduleName: "Clients", formName: "Edit Client" },
];

describe("assignDraftConnectIds", () => {
	it("disambiguates two blank same-module learn modules (no display drift)", () => {
		const drafts = {
			f1: { ...EMPTY_DRAFT, learnOn: true },
			f2: { ...EMPTY_DRAFT, learnOn: true },
		};
		expect(assignDraftConnectIds(FORMS, drafts, "learn")).toEqual([
			{ formUuid: "f1", kind: "learn_module", id: "clients" },
			{ formUuid: "f2", kind: "learn_module", id: "clients_2" },
		]);
	});

	it("keeps a free explicit id and suffixes an explicit duplicate", () => {
		const drafts = {
			f1: { ...EMPTY_DRAFT, deliverOn: true, deliverId: "visit" },
			f2: { ...EMPTY_DRAFT, deliverOn: true, deliverId: "visit" },
		};
		expect(
			assignDraftConnectIds(FORMS, drafts, "deliver").map((i) => i.id),
		).toEqual(["visit", "visit_2"]);
	});

	it("ignores off sub-configs and the other mode's kinds", () => {
		const drafts = {
			f1: {
				...EMPTY_DRAFT,
				learnOn: true,
				deliverOn: true,
				deliverId: "visit",
			},
		};
		// mode === "learn" → only the learn_module is assigned; the stray deliver
		// block (off-mode) contributes nothing to the scope.
		expect(assignDraftConnectIds([FORMS[0]], drafts, "learn")).toEqual([
			{ formUuid: "f1", kind: "learn_module", id: "clients" },
		]);
	});

	it("derives per-form assessment ids from '<module> <form>'", () => {
		const drafts = { f1: { ...EMPTY_DRAFT, assessmentOn: true } };
		expect(assignDraftConnectIds([FORMS[0]], drafts, "learn")).toEqual([
			{ formUuid: "f1", kind: "assessment", id: "clients_register_client" },
		]);
	});

	it("assigns learn_module before assessment within a form (commit order)", () => {
		const drafts = {
			f1: { ...EMPTY_DRAFT, learnOn: true, assessmentOn: true },
		};
		expect(
			assignDraftConnectIds([FORMS[0]], drafts, "learn").map((i) => i.kind),
		).toEqual(["learn_module", "assessment"]);
	});
});
