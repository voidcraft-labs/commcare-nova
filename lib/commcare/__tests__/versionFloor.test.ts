/**
 * How a target app's CommCare version, as HQ's source read serves
 * `build_spec.version`, stands against the floor a publish holds it to.
 * What HQ builds below the floor is the proof lane's
 * (`proof/hq/test_version_floor.py`).
 */
import { describe, expect, it } from "vitest";
import { COMMCARE_VERSION_FLOOR, compareToVersionFloor } from "../versionFloor";

describe("compareToVersionFloor", () => {
	it("holds the floor at 2.57", () => {
		expect(COMMCARE_VERSION_FLOOR).toEqual({ major: 2, minor: 57 });
	});

	it.each([
		["2.53.0", "below"],
		["2.57.0", "at-or-above"],
		["2.58.1", "at-or-above"],
		["2.57", "at-or-above"],
		["3.0.0", "at-or-above"],
		["1.99", "below"],
		["", "unreadable"],
		["latest", "unreadable"],
		["2", "unreadable"],
		["2.57.0.1", "unreadable"],
	] as const)("reads %j as %s", (version, expected) => {
		expect(compareToVersionFloor(version)).toBe(expected);
	});
});
