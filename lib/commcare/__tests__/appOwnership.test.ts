/** The ownership descriptor names exactly the overlay keys a body writes. Pure. */
import { expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { appOwnershipOf } from "../appOwnership";
import { expandAppShell } from "../expander";

it("names the add-ons a shell sets, no profile key, and its Auto Capture Location", () => {
	const shell = expandAppShell(buildDoc({ appName: "Visits" }));
	expect(Object.keys(shell.add_ons).length).toBeGreaterThan(0);
	expect(appOwnershipOf(shell)).toEqual({
		addOns: Object.keys(shell.add_ons).sort(),
		profileProperties: [],
		profileCustomProperties: [],
		autoGpsCapture: true,
	});
});

it("names the profile keys and add-ons an update body carries, and nothing it leaves out", () => {
	expect(
		appOwnershipOf({
			auto_gps_capture: false,
			add_ons: { subcases: true, calc_xpaths: true },
			profile: {
				properties: { "cc-autoup-freq": "freq-daily" },
				custom_properties: { "cc-sync-after-form": "true" },
			},
		}),
	).toEqual({
		addOns: ["calc_xpaths", "subcases"],
		profileProperties: ["cc-autoup-freq"],
		profileCustomProperties: ["cc-sync-after-form"],
		autoGpsCapture: true,
	});
	const { auto_gps_capture: _omitted, ...withoutGps } = {
		auto_gps_capture: false,
		add_ons: {},
	};
	expect(
		appOwnershipOf(withoutGps as Parameters<typeof appOwnershipOf>[0]),
	).toEqual({
		addOns: [],
		profileProperties: [],
		profileCustomProperties: [],
		autoGpsCapture: false,
	});
});
