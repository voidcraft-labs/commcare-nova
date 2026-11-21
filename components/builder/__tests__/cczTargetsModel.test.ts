/**
 * The publish dialog's CCZ project spaces as a state model: a space the
 * read says has no CCZ is listed with its reason, is never picked for the
 * person, is never the target a download is sent for, and leaves the option
 * with nothing to choose where it is the only kind there is.
 */
import { describe, expect, it } from "vitest";
import type { DownloadTargetsView } from "@/lib/deployment/actions";
import {
	cczHasNoChoice,
	cczPickAfterRead,
	cczTargetRows,
	chosenCczTarget,
	type DownloadTargets,
} from "../cczTargetsModel";

const ELSEWHERE = {
	reason: "workers-sent-elsewhere",
	host: "relay.example.org",
} as const;
const CLINIC = {
	server: "india",
	domain: "clinic",
	unavailable: null,
} as const;
const DISTRICT = {
	server: "india",
	domain: "district",
	unavailable: ELSEWHERE,
} as const;
const TRAINING = {
	server: "production",
	domain: "training",
	unavailable: null,
} as const;

function view(
	targets: DownloadTargetsView["targets"],
	overrides: Partial<DownloadTargetsView> = {},
): DownloadTargetsView {
	return { targets, heldFromHq: [], webAppsOnly: false, ...overrides };
}
const ready = (targets: DownloadTargetsView["targets"]): DownloadTargets => ({
	type: "ready",
	view: view(targets),
});

describe("cczTargetRows", () => {
	it("lists every space the app is published to, a space with no CCZ with its reason", () => {
		expect(cczTargetRows(view([CLINIC, DISTRICT]))).toEqual([
			{ key: "india:clinic", label: "clinic on India", unavailableLine: null },
			{
				key: "india:district",
				label: "district on India",
				unavailableLine:
					"Its app in CommCare HQ has a custom base URL that sends phones to relay.example.org, so Nova doesn't make a CCZ for this project space. Workers can install the app from CommCare HQ.",
			},
		]);
	});
});

describe("cczPickAfterRead", () => {
	it("chooses the one space a CCZ can be made for, beside a space that has none", () => {
		expect(cczPickAfterRead(view([DISTRICT, CLINIC]), "")).toBe("india:clinic");
	});

	it("never chooses a space with no CCZ, even the only one", () => {
		expect(cczPickAfterRead(view([DISTRICT]), "")).toBe("");
	});

	it("drops a pick the read now says has no CCZ, and keeps one it still offers", () => {
		expect(
			cczPickAfterRead(view([DISTRICT, CLINIC, TRAINING]), "india:district"),
		).toBe("");
		expect(
			cczPickAfterRead(
				view([DISTRICT, CLINIC, TRAINING]),
				"production:training",
			),
		).toBe("production:training");
		expect(cczPickAfterRead(view([CLINIC, TRAINING]), "")).toBe("");
	});
});

describe("chosenCczTarget", () => {
	it("sends a download only for a space a CCZ can be made for", () => {
		const state = ready([CLINIC, DISTRICT]);
		expect(chosenCczTarget(state, "india:clinic")).toEqual(CLINIC);
		expect(chosenCczTarget(state, "india:district")).toBeNull();
		expect(chosenCczTarget(state, "")).toBeNull();
		expect(chosenCczTarget({ type: "loading" }, "india:clinic")).toBeNull();
	});
});

describe("cczHasNoChoice", () => {
	it("has nothing to choose where no space the app is published to can have a CCZ", () => {
		expect(cczHasNoChoice(ready([DISTRICT]))).toBe(true);
		expect(cczHasNoChoice(ready([DISTRICT, CLINIC]))).toBe(false);
	});

	it("has nothing to choose after a failed read, for an app published nowhere or one that runs in Web Apps only, and waits while loading", () => {
		expect(cczHasNoChoice({ type: "error", message: "No" })).toBe(true);
		expect(cczHasNoChoice(ready([]))).toBe(true);
		expect(
			cczHasNoChoice({
				type: "ready",
				view: view([], { webAppsOnly: true }),
			}),
		).toBe(true);
		expect(cczHasNoChoice({ type: "loading" })).toBe(false);
	});
});
