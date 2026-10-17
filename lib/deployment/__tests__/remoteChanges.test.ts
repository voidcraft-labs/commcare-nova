/** The drift verdict and every sentence a change becomes. Pure. */
import { describe, expect, it } from "vitest";
import {
	boundedParts,
	decideRemoteChanges,
	describeAppChange,
	describeLookupChange,
	describePlaceChange,
} from "../remoteChanges";
import type { DeploymentRemoteChange } from "../types";

function change(
	novaResourceId: string,
	observedDigest: string,
	overrides: Partial<DeploymentRemoteChange> = {},
): DeploymentRemoteChange {
	return {
		kind: "lookup-table",
		novaResourceId,
		name: novaResourceId,
		identity: novaResourceId,
		parts: ["Its rows changed in CommCare HQ."],
		note: null,
		observedDigest,
		baselineKnown: true,
		...overrides,
	};
}

describe("decideRemoteChanges", () => {
	const districts = change("districts", "a".repeat(64));
	const app = change("app", "b".repeat(64), {
		kind: "app",
		parts: [],
		baselineKnown: false,
	});

	it("proceeds when nothing differs, whatever discards it is given", () => {
		expect(decideRemoteChanges({ observed: [], discards: [] })).toEqual({
			proceed: true,
			confirmed: [],
		});
		expect(
			decideRemoteChanges({
				observed: [],
				discards: [
					{
						kind: "app",
						novaResourceId: "app",
						observedDigest: "b".repeat(64),
					},
				],
			}),
		).toEqual({ proceed: true, confirmed: [] });
	});

	it("refuses a change nobody confirmed, an unread baseline included", () => {
		expect(
			decideRemoteChanges({ observed: [districts, app], discards: [] }),
		).toEqual({ proceed: false, remoteChanges: [districts, app] });
	});

	it("proceeds only when every change is confirmed for the digest shown", () => {
		const confirmDistricts = {
			kind: "lookup-table" as const,
			novaResourceId: "districts",
			observedDigest: "a".repeat(64),
		};
		expect(
			decideRemoteChanges({
				observed: [districts],
				discards: [confirmDistricts],
			}),
		).toEqual({ proceed: true, confirmed: [districts] });
		/* One of several still unconfirmed stops all of them. */
		expect(
			decideRemoteChanges({
				observed: [districts, app],
				discards: [confirmDistricts],
			}),
		).toEqual({ proceed: false, remoteChanges: [districts, app] });
	});

	it("refuses a discard of an older digest, listing the change with the one HQ holds now", () => {
		expect(
			decideRemoteChanges({
				observed: [districts],
				discards: [
					{
						kind: "lookup-table",
						novaResourceId: "districts",
						observedDigest: "c".repeat(64),
					},
				],
			}),
		).toEqual({ proceed: false, remoteChanges: [districts] });
		/* The same id under another kind is another resource. */
		expect(
			decideRemoteChanges({
				observed: [districts],
				discards: [
					{
						kind: "location",
						novaResourceId: "districts",
						observedDigest: "a".repeat(64),
					},
				],
			}),
		).toEqual({ proceed: false, remoteChanges: [districts] });
	});
});

describe("the sentences", () => {
	it("says each app part", () => {
		expect(
			describeAppChange({
				kind: "form",
				menu: 0,
				form: 1,
				name: "Register",
				menuName: "Patients",
			}),
		).toBe("The form “Register” in the menu “Patients”");
		expect(describeAppChange({ kind: "menu", menu: 0, name: "Patients" })).toBe(
			"The menu “Patients”",
		);
		expect(describeAppChange({ kind: "menu-list" })).toBe("The list of menus");
		expect(describeAppChange({ kind: "name" })).toBe("The app's name");
		expect(describeAppChange({ kind: "languages" })).toBe(
			"The app's languages",
		);
		expect(describeAppChange({ kind: "settings" })).toBe(
			"A setting this app writes",
		);
		expect(describeAppChange({ kind: "text" })).toBe("Text this app writes");
	});

	it("says each table part", () => {
		expect(describeLookupChange({ kind: "definition" }, "districts")).toBe(
			"Its columns changed in CommCare HQ.",
		);
		expect(describeLookupChange({ kind: "rows" }, "districts")).toBe(
			"Its rows changed in CommCare HQ.",
		);
		expect(describeLookupChange({ kind: "deleted" }, "districts")).toBe(
			"CommCare HQ no longer has this table. Publishing makes it again.",
		);
		expect(
			describeLookupChange({ kind: "renamed", tag: "areas" }, "districts"),
		).toBe(
			"This table now has the tag “areas” in CommCare HQ. Publishing makes a new table under “districts” and leaves that one where it is.",
		);
	});

	it("says each place part", () => {
		expect(describePlaceChange({ kind: "name" })).toBe("Its name changed.");
		expect(describePlaceChange({ kind: "site-code" })).toBe(
			"Its site code changed.",
		);
		expect(describePlaceChange({ kind: "level" })).toBe("Its level changed.");
		expect(describePlaceChange({ kind: "parent" })).toBe(
			"It moved under another place.",
		);
		expect(describePlaceChange({ kind: "coordinates" })).toBe(
			"Its coordinates changed.",
		);
		expect(describePlaceChange({ kind: "information" })).toBe(
			"Its place information changed.",
		);
		expect(describePlaceChange({ kind: "missing" })).toBe(
			"CommCare HQ no longer lists this place. It was archived or deleted there. Publishing makes it again if it was deleted. If it was archived, CommCare HQ refuses the publish while the place stays archived there.",
		);
	});

	it("keeps 20 lines whole and counts the rest past them", () => {
		const lines = (count: number) =>
			Array.from({ length: count }, (_, index) => `Line ${index + 1}`);
		expect(boundedParts(lines(20))).toEqual(lines(20));
		expect(boundedParts(lines(21))).toEqual([...lines(19), "and 2 more"]);
	});
});
