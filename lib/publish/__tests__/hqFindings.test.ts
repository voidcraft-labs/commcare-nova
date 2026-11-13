/**
 * The finding type's own rules: a circumstance finding is made only by
 * `circumstanceFinding`, whose types refuse a detail its code's row does not
 * allow and which fills the standing from that row; a finding's name is cut
 * to its bound; and Nova's own faults stay `not-yet` with no owner.
 */

import { describe, expect, it } from "vitest";
import {
	CIRCUMSTANCE_STANDINGS,
	circumstanceFinding,
	cutFindingName,
	FINDING_NAME_MAX_LENGTH,
	type HqPlace,
	NOVA_FAULT_CIRCUMSTANCES,
	READ_CIRCUMSTANCES,
	type StopCircumstance,
} from "../hqFindings";

const place: HqPlace = { kind: "app" };

describe("circumstanceFinding", () => {
	it("refuses, at compile time, a detail the code's row does not allow", () => {
		// The row of `too-large` holds no name.
		// @ts-expect-error a name on a code whose row holds none
		circumstanceFinding("too-large", place, { name: "x" });
		// The row of `unrecognized` holds `name: "line"`, so a name is required.
		// @ts-expect-error a missing name on a code whose row holds one
		circumstanceFinding("unrecognized", place, {});
		circumstanceFinding("key-not-accepted", place, {
			// @ts-expect-error a claim on a code other than already-in-nova
			claim: { kind: "open", appId: "a", appName: "Visits" },
		});
		circumstanceFinding("unrecognized", place, {
			name: "x",
			// @ts-expect-error a reason on a code other than no-platform-runs-everything
			reason: "split-refused",
		});

		// The shapes each row allows compile.
		circumstanceFinding("too-large", place, {});
		circumstanceFinding("already-in-nova", place, {
			claim: { kind: "open", appId: "a", appName: "Visits" },
		});
		circumstanceFinding("no-platform-runs-everything", place, {
			name: "“Date and time questions”, which Web Apps can't run",
			reason: "split-refused",
		});
	});

	it("holds the standing of its code's row, for every code", () => {
		for (const code of READ_CIRCUMSTANCES) {
			const row: { readonly standing: string; readonly name?: string } =
				CIRCUMSTANCE_STANDINGS[code];
			const detail = row.name === undefined ? {} : { name: "regions" };
			const finding = circumstanceFinding(code, place, detail as never);
			expect(finding).toEqual({
				code,
				standing: CIRCUMSTANCE_STANDINGS[code].standing,
				place,
				subject: null,
				detail,
			});
		}
	});

	it("cuts the name it is given", () => {
		const finding = circumstanceFinding("unrecognized", place, {
			name: "k".repeat(FINDING_NAME_MAX_LENGTH + 40),
		});
		expect(finding.detail.name).toBe(
			`${"k".repeat(FINDING_NAME_MAX_LENGTH - 1)}…`,
		);
	});
});

describe("cutFindingName", () => {
	it("returns a name of 200 characters or fewer unchanged", () => {
		const name = "n".repeat(FINDING_NAME_MAX_LENGTH);
		expect(cutFindingName(name)).toBe(name);
		expect(cutFindingName("")).toBe("");
	});

	it("cuts a longer name to 200 characters, the last one …", () => {
		const cut = cutFindingName("n".repeat(FINDING_NAME_MAX_LENGTH + 1));
		expect(Array.from(cut)).toHaveLength(FINDING_NAME_MAX_LENGTH);
		expect(cut.endsWith("…")).toBe(true);
		expect(cut.slice(0, -1)).toBe("n".repeat(FINDING_NAME_MAX_LENGTH - 1));
	});

	it("counts a character outside the Basic Multilingual Plane as one, and never splits it", () => {
		const name = "😀".repeat(FINDING_NAME_MAX_LENGTH + 1);
		const cut = cutFindingName(name);
		expect(Array.from(cut)).toEqual([
			...Array.from("😀".repeat(FINDING_NAME_MAX_LENGTH - 1)),
			"…",
		]);
		expect(cutFindingName("😀".repeat(FINDING_NAME_MAX_LENGTH))).toBe(
			"😀".repeat(FINDING_NAME_MAX_LENGTH),
		);
	});
});

describe("the circumstance table", () => {
	it("holds each of Nova's own faults as not-yet with no owner", () => {
		for (const code of NOVA_FAULT_CIRCUMSTANCES) {
			const row: { readonly standing: string; readonly owner?: string } =
				CIRCUMSTANCE_STANDINGS[code];
			expect(row.standing).toBe("not-yet");
			expect(row.owner).toBeUndefined();
		}
	});

	it("names as stops exactly the codes whose row is a stop", () => {
		const stops: Record<StopCircumstance, true> = {
			"not-connected": true,
			"key-not-accepted": true,
			"key-cannot-reach-space": true,
			"plan-lacks-api-access": true,
			"api-cut-off": true,
			"not-a-member": true,
			"cannot-edit-apps": true,
			"cannot-access-apis": true,
			"cannot-read-organization": true,
			"app-gone": true,
			"app-deleted": true,
			"linked-app": true,
			"remote-app": true,
			"rate-limited": true,
			"hq-unavailable": true,
			"hq-gateway-refused": true,
			"browser-only": true,
			"changed-while-reading": true,
			"already-in-nova": true,
		};
		expect(
			READ_CIRCUMSTANCES.filter(
				(code) => CIRCUMSTANCE_STANDINGS[code].standing === "stop",
			),
		).toEqual(Object.keys(stops));
	});
});
