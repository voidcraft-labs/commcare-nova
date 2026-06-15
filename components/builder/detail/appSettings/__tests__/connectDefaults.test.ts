/**
 * The Connect manager's "you left a field blank, so we used the default"
 * detection: `collectBlankDefaults` flags exactly the optional slots a user
 * CLEARED on a participating sub-config (ids + the XPath slots), and
 * `resolveDefaultValue` lowers each to the value that actually ran — an id's
 * autofilled slug read back from the committed doc, an XPath slot's wire
 * default. An untouched seeded value (a filled id, the default XPath text)
 * must NOT be flagged: only genuine blanks default. Pure functions, no React.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ASSESSMENT_USER_SCORE,
	DEFAULT_DELIVER_ENTITY_ID,
	DEFAULT_DELIVER_ENTITY_NAME,
} from "@/lib/doc/connectConfig";
import type { BlueprintDoc } from "@/lib/domain";
import { EMPTY_DRAFT } from "../ConnectEnableDialog";
import {
	collectBlankDefaults,
	type FormRow,
	resolveDefaultValue,
} from "../ConnectManagerDialog";

const FORM: FormRow = {
	formUuid: "f1",
	formName: "Register Client",
	moduleName: "Clients",
};
const draftFor =
	(draft: typeof EMPTY_DRAFT) =>
	(_formUuid: string): typeof EMPTY_DRAFT =>
		draft;

describe("collectBlankDefaults", () => {
	it("flags a blanked assessment id and user_score, with the right defaults", () => {
		const draft = {
			...EMPTY_DRAFT,
			assessmentOn: true,
			assessmentId: "",
			userScoreText: "",
		};
		const blanks = collectBlankDefaults([FORM], draftFor(draft), "learn");
		expect(blanks).toEqual([
			{
				formUuid: "f1",
				formName: "Register Client",
				kind: "assessment",
				label: "Assessment ID",
			},
			{
				formUuid: "f1",
				formName: "Register Client",
				kind: "assessment",
				label: "User Score",
				xpathDefault: DEFAULT_ASSESSMENT_USER_SCORE,
			},
		]);
	});

	it("does NOT flag a filled id or a default XPath buffer left untouched", () => {
		// EMPTY_DRAFT seeds userScoreText with the default already; a filled id
		// and the seeded default are the common case — nothing was blanked.
		const draft = {
			...EMPTY_DRAFT,
			assessmentOn: true,
			assessmentId: "quiz",
			userScoreText: DEFAULT_ASSESSMENT_USER_SCORE,
		};
		expect(collectBlankDefaults([FORM], draftFor(draft), "learn")).toEqual([]);
	});

	it("ignores a form that doesn't participate", () => {
		expect(
			collectBlankDefaults([FORM], draftFor(EMPTY_DRAFT), "learn"),
		).toEqual([]);
	});

	it("flags blanked deliver id + entity slots with their wire defaults", () => {
		const draft = {
			...EMPTY_DRAFT,
			deliverOn: true,
			deliverName: "Home Visit",
			deliverId: "",
			entityIdText: "",
			entityNameText: "",
		};
		const blanks = collectBlankDefaults([FORM], draftFor(draft), "deliver");
		expect(blanks.map((b) => b.label)).toEqual([
			"Deliver Unit ID",
			"Entity ID",
			"Entity Name",
		]);
		expect(blanks[1]?.xpathDefault).toBe(DEFAULT_DELIVER_ENTITY_ID);
		expect(blanks[2]?.xpathDefault).toBe(DEFAULT_DELIVER_ENTITY_NAME);
	});
});

describe("resolveDefaultValue", () => {
	const idBlank = {
		formUuid: "f1",
		formName: "Register Client",
		kind: "assessment" as const,
		label: "Assessment ID",
	};

	it("reads an id's autofilled slug back from the committed doc", () => {
		const doc = {
			forms: { f1: { connect: { assessment: { id: "register_client" } } } },
		} as unknown as BlueprintDoc;
		expect(resolveDefaultValue(doc, idBlank)).toBe("register_client");
	});

	it("returns the wire default for an XPath slot without touching the doc", () => {
		const doc = { forms: {} } as unknown as BlueprintDoc;
		expect(
			resolveDefaultValue(doc, {
				...idBlank,
				label: "User Score",
				xpathDefault: DEFAULT_ASSESSMENT_USER_SCORE,
			}),
		).toBe(DEFAULT_ASSESSMENT_USER_SCORE);
	});
});
