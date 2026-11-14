/**
 * The kept list's state model: how its date reads, and what one press of
 * Refresh from CommCare HQ leaves on the card. The card draws only what
 * these return, so a wrong date, a refreshed list reported unchanged, or a
 * failure shown as news is caught here.
 */

import { describe, expect, it } from "vitest";
import type {
	KeptRefreshView,
	RefreshedDeploymentView,
} from "@/lib/deployment/actions";
import type { DeploymentKept } from "@/lib/deployment/types";
import { keptRefreshSentence } from "@/lib/publish/keptValues";
import {
	keptDateText,
	keptLabelsChanged,
	keptRefreshNotice,
} from "../keptListModel";

const SHOWN: DeploymentKept = {
	labels: ["fuzzy-search"],
	observedAt: "2026-11-10T12:00:00.000Z",
};
const NOW = new Date("2026-11-13T12:00:00.000Z");
const CONTEXT = { now: NOW, space: "clinic", locale: "en-GB" } as const;

/** A refreshed record carrying `kept`; the card reads nothing else of it here. */
function refreshedView(kept: DeploymentKept | null): RefreshedDeploymentView {
	return { kept } as unknown as RefreshedDeploymentView;
}

describe("keptDateText", () => {
	it("gives the day and month in the reader's locale within the current year", () => {
		expect(keptDateText(SHOWN.observedAt, NOW, "en-GB")).toBe("10 November");
	});

	it("adds the year where the date is in another year", () => {
		expect(keptDateText("2025-11-10T12:00:00.000Z", NOW, "en-GB")).toBe(
			"10 November 2025",
		);
	});
});

describe("keptLabelsChanged", () => {
	it("is false for the same labels in the same order", () => {
		expect(
			keptLabelsChanged(SHOWN, { ...SHOWN, observedAt: NOW.toISOString() }),
		).toBe(false);
	});

	it("is true for a label added, one removed, and the same labels reordered", () => {
		expect(
			keptLabelsChanged(SHOWN, {
				...SHOWN,
				labels: ["fuzzy-search", "required-question-asterisk"],
			}),
		).toBe(true);
		expect(keptLabelsChanged(SHOWN, { ...SHOWN, labels: [] })).toBe(true);
		expect(
			keptLabelsChanged(
				{ ...SHOWN, labels: ["fuzzy-search", "text-to-speech"] },
				{ ...SHOWN, labels: ["text-to-speech", "fuzzy-search"] },
			),
		).toBe(true);
	});

	it("reads a list that is gone as empty", () => {
		expect(keptLabelsChanged({ ...SHOWN, labels: [] }, null)).toBe(false);
		expect(keptLabelsChanged(SHOWN, null)).toBe(true);
	});
});

describe("keptRefreshNotice", () => {
	it("says the list was updated and hands back the record where the read changed it", () => {
		const view = refreshedView({
			labels: ["fuzzy-search", "required-question-asterisk"],
			observedAt: NOW.toISOString(),
		});
		const notice = keptRefreshNotice(
			{ success: true, data: { kind: "refreshed", deployment: view } },
			SHOWN,
			CONTEXT,
		);
		expect(notice).toEqual({
			sentence: "Updated. This is what CommCare HQ holds now.",
			failed: false,
			view,
		});
	});

	it("says nothing changed where the refreshed list names the same settings", () => {
		const view = refreshedView({ ...SHOWN, observedAt: NOW.toISOString() });
		expect(
			keptRefreshNotice(
				{ success: true, data: { kind: "refreshed", deployment: view } },
				SHOWN,
				CONTEXT,
			),
		).toEqual({
			sentence: "Nothing has changed. This is still what CommCare HQ holds.",
			failed: false,
			view,
		});
	});

	it("hands back the record a publish left where the read was superseded", () => {
		const view = refreshedView(SHOWN);
		const notice = keptRefreshNotice(
			{ success: true, data: { kind: "superseded", deployment: view } },
			SHOWN,
			CONTEXT,
		);
		expect(notice.view).toBe(view);
		expect(notice.failed).toBe(false);
	});

	it.each([
		["changed-in-hq", false],
		["no-baseline", false],
		["app-gone", true],
		["unreadable", true],
		["key-not-accepted", true],
		["no-permission", true],
		["unavailable", true],
	] as const)(
		"words %s with the shown list's date and keeps the record the card holds",
		(kind, failed) => {
			const data = { kind } as KeptRefreshView;
			expect(
				keptRefreshNotice({ success: true, data }, SHOWN, CONTEXT),
			).toEqual({
				sentence: keptRefreshSentence(
					{ kind, listChanged: false },
					{ date: "10 November", space: "clinic" },
				),
				failed,
				view: null,
			});
		},
	);

	it("shows a raised sentence as it came, as a failure", () => {
		const message =
			"CommCare HQ isn't connected on your account, so Nova can't read these again. You can add your API key in Settings, then refresh.";
		expect(
			keptRefreshNotice(
				{ success: false, code: "invalid_input", message },
				SHOWN,
				CONTEXT,
			),
		).toEqual({ sentence: message, failed: true, view: null });
	});
});
