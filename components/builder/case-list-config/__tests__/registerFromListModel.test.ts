/**
 * The "Register from this list" setting's model: the whole slot each change
 * writes, the After registering helpers for the host's shape, the note that
 * names the form's own after-submit, and the form's "Also offered on" line.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { AlwaysOfferedRegistration } from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import {
	afterRegisteringHelpers,
	alsoOfferedOnLine,
	ownAfterSubmitNote,
	shownRegisterRefusal,
	slotWith,
} from "../canvas/registerFromListModel";

const FORM = testUuid("register");
const OTHER_FORM = testUuid("register-newborn");
const ICON = asMediaAssetId(testUuid("icon"));

describe("slotWith", () => {
	it("starts a first offer back on the list, with nothing else stored", () => {
		expect(slotWith(undefined, FORM, {})).toEqual({
			kind: "always",
			formUuid: FORM,
			afterSubmit: "case-list",
		});
	});

	it("keeps the stored label, media and return when another form is chosen", () => {
		const stored: AlwaysOfferedRegistration = {
			kind: "always",
			formUuid: FORM,
			label: "New patient",
			icon: ICON,
			afterSubmit: "new-case",
		};
		expect(slotWith(stored, OTHER_FORM, {})).toEqual({
			...stored,
			formUuid: OTHER_FORM,
		});
	});

	it("stores no empty label or media: clearing one leaves the slot absent", () => {
		const stored: AlwaysOfferedRegistration = {
			kind: "always",
			formUuid: FORM,
			label: "New patient",
			icon: ICON,
			afterSubmit: "case-list",
		};
		expect(slotWith(stored, FORM, { label: "   ", icon: undefined })).toEqual({
			kind: "always",
			formUuid: FORM,
			afterSubmit: "case-list",
		});
	});
});

describe("afterRegisteringHelpers", () => {
	it("says the list for a case-first host and its forms for a forms-first one", () => {
		expect(
			afterRegisteringHelpers({
				hostName: "Patients",
				bare: false,
				caseFirst: true,
			})["case-list"],
		).toBe("The worker returns to the list, where the new case now shows.");
		expect(
			afterRegisteringHelpers({
				hostName: "Patients",
				bare: false,
				caseFirst: false,
			})["case-list"],
		).toBe("The worker returns to Patients, where they choose a form.");
	});

	it("says a bare case list has no forms to go on to", () => {
		expect(
			afterRegisteringHelpers({
				hostName: "Patients",
				bare: true,
				caseFirst: false,
			})["new-case"],
		).toBe(
			"This list has no forms to go on to, so the worker returns to the list.",
		);
	});
});

describe("ownAfterSubmitNote", () => {
	it("names the form's own destination and offers its After submit", () => {
		expect(
			ownAfterSubmitNote({
				formUuid: FORM,
				formModuleUuid: testUuid("registration"),
				formName: "Register patient",
				destination: "firstMenu",
			}),
		).toEqual({
			text: "Register patient has its own After submit (First menu), so it goes there from this list too. You can set Register patient's After submit to Home to use the choice above.",
			buttonLabel: "Open Register patient's After submit",
		});
		expect(ownAfterSubmitNote(undefined)).toBeUndefined();
	});
});

describe("alsoOfferedOnLine", () => {
	it("names one list, two lists, and more", () => {
		expect(alsoOfferedOnLine(["Patients"])).toBe(
			"Also offered on Patients's case list",
		);
		expect(alsoOfferedOnLine(["Patients", "Visits"])).toBe(
			"Also offered on the case lists of Patients and Visits",
		);
		expect(alsoOfferedOnLine(["Patients", "Visits", "Clinics"])).toBe(
			"Also offered on the case lists of Patients, Visits and Clinics",
		);
	});
});

describe("shownRegisterRefusal", () => {
	const HOST = testUuid("host-list");
	const OTHER_HOST = testUuid("other-list");
	const revision = {};
	const held = {
		message: "Visits can't offer this form.",
		moduleUuid: HOST,
		revision,
	};

	it("shows a refusal on the case list and document it answered", () => {
		expect(shownRegisterRefusal(held, HOST, revision)).toBe(held.message);
	});

	it("leaves it behind on another case list", () => {
		expect(shownRegisterRefusal(held, OTHER_HOST, revision)).toBeUndefined();
	});

	it("leaves it behind once the document changes, as after an undo or a peer's edit", () => {
		expect(shownRegisterRefusal(held, HOST, {})).toBeUndefined();
	});
});
