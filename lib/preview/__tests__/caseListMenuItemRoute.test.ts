/**
 * Where choosing a case from a case list menu entry lands, and what the
 * case's detail does first, per platform. Pure: the running case list and
 * App Tests both route by these, so Preview sending Android home from a
 * detail (where the device's Done returns to the list) fails here.
 */

import { describe, expect, it } from "vitest";
import {
	caseListMenuItemDetailAction,
	caseListMenuItemSelection,
} from "../caseListMenuItemRoute";
import { previewPlatformRules } from "../platform";
import { runtimeMessage } from "../runtimeMessages";

const WEB_APPS = previewPlatformRules("web-apps");
const ANDROID = previewPlatformRules("android");

describe("caseListMenuItemSelection", () => {
	it("steps back to the screen before the choice in Web Apps", () => {
		expect(caseListMenuItemSelection(WEB_APPS)).toEqual({ kind: "step-back" });
	});

	it("returns to the phone's home screen on Android", () => {
		expect(caseListMenuItemSelection(ANDROID)).toEqual({
			kind: "device-home",
		});
	});
});

describe("caseListMenuItemDetailAction", () => {
	it("continues from the detail in Web Apps, then takes the route", () => {
		expect(caseListMenuItemDetailAction(WEB_APPS)).toEqual({
			kind: "continue",
			message: "continue",
		});
	});

	it("shows Done on Android, which returns to the list with nothing chosen", () => {
		const action = caseListMenuItemDetailAction(ANDROID);
		expect(action).toEqual({ kind: "return-to-list", message: "detailDone" });
		expect(runtimeMessage("eng", action.message)).toBe("Done");
		expect(runtimeMessage("spa", action.message)).toBe("Listo");
	});
});
