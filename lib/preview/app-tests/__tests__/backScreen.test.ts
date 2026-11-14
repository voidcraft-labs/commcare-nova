/**
 * Back to a form opens a fresh entry of it. A case list's Register launch
 * belongs to the one entry it opened, so the form Back reopens carries no
 * launch and routes after submit as a form opened any other way does, as
 * the browser's Preview ends the launch at any location off its path.
 */

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import { appTestBackScreen } from "../navigation";
import type { AppTestScreen } from "../types";

const HOST = testUuid("back-register-host");
const FORM_MODULE = testUuid("back-register-form-module");
const FORM = testUuid("back-register-form");

it("reopens a launched form as a fresh entry the Register launch no longer reaches", () => {
	const entryCases: CaseDatabaseSnapshot = { rows: [], indices: [] };
	const deviceCases: CaseDatabaseSnapshot = { rows: [], indices: [] };
	const launched: AppTestScreen = {
		kind: "form",
		moduleUuid: FORM_MODULE,
		formUuid: FORM,
		caseIds: [],
		entryCases,
		caseListRegistrationLaunch: { hostModuleUuid: HOST },
	};
	const reopened = appTestBackScreen(launched, deviceCases);
	expect(reopened).toEqual({
		kind: "form",
		moduleUuid: FORM_MODULE,
		formUuid: FORM,
		caseIds: [],
		entryCases: deviceCases,
	});
	expect(reopened.kind === "form" && reopened.entryCases).toBe(deviceCases);
});

it("returns to any other screen as it was", () => {
	const records: AppTestScreen = { kind: "records", moduleUuid: HOST };
	expect(appTestBackScreen(records, { rows: [], indices: [] })).toBe(records);
});
