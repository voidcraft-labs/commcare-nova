/**
 * The kept list's state model: how its date reads, and what one press of
 * Refresh from CommCare HQ leaves on the card. The card draws only what
 * these return, so a wrong date, a refreshed list reported unchanged (a
 * moved value under a label it listed before included), or a failure shown
 * as news is caught here.
 */

import { describe, expect, it } from "vitest";
import type {
	KeptRefreshView,
	RefreshedDeploymentView,
} from "@/lib/deployment/actions";
import type { DeploymentKept } from "@/lib/deployment/types";
import {
	KEPT_REFRESH_NOT_REACHED,
	keptListUnreadSentence,
	keptRefreshSentence,
} from "@/lib/publish/keptValues";
import {
	keptDateText,
	keptNoticeApplies,
	keptRefreshNotice,
	keptRefreshNotReached,
	refreshedViewToShow,
} from "../keptListModel";

const SHOWN: DeploymentKept = {
	labels: ["fuzzy-search"],
	valuesDigest: "a".repeat(64),
	observedAt: "2026-11-10T12:00:00.000Z",
};
const NOW = new Date("2026-11-13T12:00:00.000Z");
const CONTEXT = { now: NOW, space: "clinic", locale: "en-GB" } as const;

/** A refreshed record carrying `kept`; the card reads nothing else of it here. */
function refreshedView(
	kept: RefreshedDeploymentView["kept"],
): RefreshedDeploymentView {
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

describe("keptRefreshNotice", () => {
	it("says the list was updated and hands back the record where the read changed it", () => {
		const kept: DeploymentKept = {
			labels: ["fuzzy-search", "required-question-asterisk"],
			valuesDigest: "b".repeat(64),
			observedAt: NOW.toISOString(),
		};
		const view = refreshedView(kept);
		const notice = keptRefreshNotice(
			{ success: true, data: { kind: "refreshed", deployment: view } },
			SHOWN,
			CONTEXT,
		);
		expect(notice).toEqual({
			sentence: "Updated. This is what CommCare HQ holds now.",
			failed: false,
			view,
			kept,
		});
	});

	it("says the list was updated where a value moved under the same labels", () => {
		const kept = {
			...SHOWN,
			valuesDigest: "b".repeat(64),
			observedAt: NOW.toISOString(),
		};
		const view = refreshedView(kept);
		expect(
			keptRefreshNotice(
				{ success: true, data: { kind: "refreshed", deployment: view } },
				SHOWN,
				CONTEXT,
			).sentence,
		).toBe("Updated. This is what CommCare HQ holds now.");
	});

	it("says nothing changed where the refreshed list names the same settings over the same values", () => {
		const kept = { ...SHOWN, observedAt: NOW.toISOString() };
		const view = refreshedView(kept);
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
			kept,
		});
	});

	it("hands back the record a publish left where the read was superseded, speaking of its list", () => {
		const view = refreshedView(SHOWN);
		const notice = keptRefreshNotice(
			{ success: true, data: { kind: "superseded", deployment: view } },
			SHOWN,
			CONTEXT,
		);
		expect(notice.view).toBe(view);
		expect(notice.failed).toBe(false);
		/* A publish that could not read the app back leaves no list, and the
		 * sentence still speaks of that record. */
		const unread = keptRefreshNotice(
			{
				success: true,
				data: { kind: "superseded", deployment: refreshedView(null) },
			},
			SHOWN,
			CONTEXT,
		);
		expect(unread.kept).toBeNull();
		expect(keptNoticeApplies(unread, null)).toBe(true);
	});

	it.each([
		["changed-in-hq", false],
		["no-baseline", false],
		["app-gone", true],
		["unreadable", true],
		["too-large", true],
		["browser-only", true],
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
					{ kind, changed: false },
					{ date: "10 November", space: "clinic" },
				),
				failed,
				view: null,
				kept: SHOWN,
			});
		},
	);

	it.each(["refreshed", "superseded"] as const)(
		"keeps the list it shows, dated as it was, where a %s read landed and its list could not be read",
		(kind) => {
			const notice = keptRefreshNotice(
				{
					success: true,
					data: { kind, deployment: refreshedView("unread") },
				},
				SHOWN,
				CONTEXT,
			);
			expect(notice).toEqual({
				sentence: keptListUnreadSentence("10 November"),
				failed: false,
				view: { kept: SHOWN },
				kept: SHOWN,
			});
			/* The card holds the list the sentence speaks of, so it shows. */
			expect(keptNoticeApplies(notice, notice.view?.kept ?? null)).toBe(true);
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
		).toEqual({ sentence: message, failed: true, view: null, kept: SHOWN });
	});

	it("says the server could not be reached where the request never answered, inviting another try", () => {
		expect(keptRefreshNotReached(SHOWN)).toEqual({
			sentence: KEPT_REFRESH_NOT_REACHED,
			failed: true,
			view: null,
			kept: SHOWN,
		});
	});
});

describe("keptNoticeApplies", () => {
	const notice = keptRefreshNotice(
		{ success: true, data: { kind: "unavailable" } },
		SHOWN,
		CONTEXT,
	);

	it("keeps the sentence while the card holds the list it speaks of, however the record was read again", () => {
		expect(keptNoticeApplies(notice, SHOWN)).toBe(true);
		expect(
			keptNoticeApplies(notice, { ...SHOWN, labels: [...SHOWN.labels] }),
		).toBe(true);
	});

	it("retires the sentence once a publish or a reload moves the list: its date, its settings, its values, or the list itself", () => {
		expect(
			keptNoticeApplies(notice, { ...SHOWN, observedAt: NOW.toISOString() }),
		).toBe(false);
		expect(keptNoticeApplies(notice, { ...SHOWN, labels: [] })).toBe(false);
		expect(
			keptNoticeApplies(notice, { ...SHOWN, valuesDigest: "b".repeat(64) }),
		).toBe(false);
		expect(keptNoticeApplies(notice, null)).toBe(false);
		const forNoList = { ...notice, kept: null };
		expect(keptNoticeApplies(forNoList, SHOWN)).toBe(false);
	});
});

describe("refreshedViewToShow", () => {
	it("keeps the list the card shows where the refresh landed and its list could not be read", () => {
		expect(refreshedViewToShow(refreshedView("unread"), SHOWN).kept).toBe(
			SHOWN,
		);
		expect(refreshedViewToShow(refreshedView("unread"), null).kept).toBeNull();
	});

	it("takes the refresh's own answer otherwise, an answer of no list included", () => {
		const kept = { ...SHOWN, valuesDigest: "b".repeat(64) };
		expect(refreshedViewToShow(refreshedView(kept), SHOWN).kept).toBe(kept);
		expect(refreshedViewToShow(refreshedView(null), SHOWN).kept).toBeNull();
	});
});
