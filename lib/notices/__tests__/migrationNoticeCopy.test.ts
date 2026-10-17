import { describe, expect, it } from "vitest";
import {
	DEPLOYMENT_NOTICE_REASONS,
	DOCUMENT_NOTICE_REASONS,
	type KeyReaderNotice,
	MIGRATION_NOTICE_CUTOVERS,
	type MigrationNoticeEntry,
	type MigrationNoticeReason,
	migrationNoticeEntrySchema,
	type NoticeEntityRef,
} from "../migrationNotice";
import {
	entityPart,
	keyReaderNoticeLine,
	MCP_NOTICE_DISMISSED,
	MIGRATION_NOTICE_LEADS,
	NOTICE_DIALOG_BUTTON,
	NOTICE_DIALOG_TITLE,
	type NoticeRenderContext,
	noticeChipLabel,
	noticeDaySpan,
	noticeLead,
	PUBLISHING_CARD_NOTICE_LEAD,
	projectSpaceGroupHeading,
	renderNoticeEntry,
} from "../migrationNoticeCopy";

const UTC_GB = { locale: "en-GB", timeZone: "UTC" } as const;

const MODULE_UUID = "01992000-0000-7000-8000-0000000000a1";
const APP_ENTITY = { type: "app", nameAtMigration: "Clinic visits" } as const;
const MODULE_ENTITY = {
	type: "module",
	uuid: MODULE_UUID,
	nameAtMigration: "Patients",
} as const;

/** Each reason's entry, built with its details and with none. */
const ENTRIES: Record<
	MigrationNoticeReason,
	{ readonly withDetail: unknown; readonly bare: unknown }
> = {
	"unsaved-assistant-work-discarded": {
		withDetail: {
			kind: "document",
			reason: "unsaved-assistant-work-discarded",
			entity: APP_ENTITY,
			detail: { workspaces: "1" },
		},
		bare: {
			kind: "document",
			reason: "unsaved-assistant-work-discarded",
			entity: APP_ENTITY,
		},
	},
	"deep-links-need-republish": {
		withDetail: {
			kind: "deployment",
			reason: "deep-links-need-republish",
			deployment: {
				deploymentId: "01992000-0000-7000-8000-000000000011",
				server: "production",
				domain: "field-ops",
			},
			entities: [MODULE_ENTITY],
			detail: { links: "2" },
		},
		bare: {
			kind: "deployment",
			reason: "deep-links-need-republish",
			deployment: {
				deploymentId: "01992000-0000-7000-8000-000000000011",
				server: "production",
				domain: "field-ops",
			},
		},
	},
};

const PRESENT: NoticeRenderContext = {
	nameOf: (entity) =>
		entity.type === "app" ? "Clinic visits today" : "Patients today",
};
const REMOVED: NoticeRenderContext = { nameOf: () => null };

function parsed(raw: unknown): MigrationNoticeEntry {
	return migrationNoticeEntrySchema.parse(raw);
}

function assertVoice(text: string) {
	expect(text).not.toMatch(/—/);
	expect(text).not.toMatch(/…|\.\.\./);
}

describe("the reason renderers", () => {
	it("cover every reason of both enums", () => {
		expect(Object.keys(ENTRIES).sort()).toEqual(
			[...DOCUMENT_NOTICE_REASONS, ...DEPLOYMENT_NOTICE_REASONS].sort(),
		);
	});

	it("render every reason with and without details, present and removed, as text equal to its parts", () => {
		for (const { withDetail, bare } of Object.values(ENTRIES)) {
			for (const raw of [withDetail, bare]) {
				for (const ctx of [PRESENT, REMOVED]) {
					const line = renderNoticeEntry(parsed(raw), ctx);
					expect(line.text.length).toBeGreaterThan(0);
					expect(line.text).toBe(line.parts.map((part) => part.text).join(""));
					assertVoice(line.text);
				}
			}
		}
	});

	it("say what this pull request's two reasons say", () => {
		expect(
			renderNoticeEntry(
				parsed(ENTRIES["unsaved-assistant-work-discarded"].bare),
				PRESENT,
			).text,
		).toBe(
			"Changes the assistant was still working on here were not saved before this update. The saved app is unchanged. Ask again to pick the work back up.",
		);
		expect(
			renderNoticeEntry(
				parsed(ENTRIES["deep-links-need-republish"].bare),
				PRESENT,
			).text,
		).toBe(
			"Links to field-ops that you already shared keep working. New ones are ready after the next publish there.",
		);
	});
});

describe("entityPart", () => {
	const entity = MODULE_ENTITY as unknown as NoticeEntityRef;

	it("names an entity that exists by its name today", () => {
		expect(entityPart(entity, PRESENT)).toEqual({
			kind: "entity",
			entity,
			text: "Patients today",
			exists: true,
		});
	});

	it("names a removed entity by the name it had when the cutover ran", () => {
		expect(entityPart(entity, REMOVED)).toEqual({
			kind: "entity",
			entity,
			text: "Patients",
			exists: false,
		});
	});
});

describe("the dialog, the chip and the card", () => {
	it("has a lead for every known cutover, naming the notice's day", () => {
		expect(Object.keys(MIGRATION_NOTICE_LEADS).sort()).toEqual(
			[...MIGRATION_NOTICE_CUTOVERS].sort(),
		);
		expect(
			noticeLead("hq-round-trip-emission", "2026-10-06T09:00:00.000Z", UTC_GB),
		).toBe(
			"Nova changed how it writes apps for CommCare HQ on 6 October. Here is what that means for this app.",
		);
	});

	it("names the day in the viewer's own time zone", () => {
		expect(
			noticeLead("hq-round-trip-emission", "2026-10-06T23:30:00.000Z", {
				locale: "en-GB",
				timeZone: "Asia/Kolkata",
			}),
		).toContain("on 7 October.");
	});

	it("counts notices on the chip", () => {
		expect(noticeChipLabel(1)).toBe("1 update to review");
		expect(noticeChipLabel(2)).toBe("2 updates to review");
	});

	it("keeps every fixed sentence in Nova's voice", () => {
		for (const sentence of [
			NOTICE_DIALOG_TITLE,
			NOTICE_DIALOG_BUTTON,
			PUBLISHING_CARD_NOTICE_LEAD,
			MCP_NOTICE_DISMISSED,
			projectSpaceGroupHeading("field-ops"),
		]) {
			assertVoice(sentence);
		}
		expect(projectSpaceGroupHeading("field-ops")).toBe(
			"At the next publish to field-ops",
		);
	});
});

describe("the home line", () => {
	const row = (
		domain: string,
		firstUsedAt: string,
		lastUsedAt: string,
	): KeyReaderNotice => ({
		cutover: "hq-round-trip-emission",
		server: "production",
		domain,
		firstUsedAt,
		lastUsedAt,
	});

	it("names one project space used on one day", () => {
		expect(
			keyReaderNoticeLine(
				[
					row(
						"field-ops",
						"2026-10-06T01:00:00.000Z",
						"2026-10-06T02:00:00.000Z",
					),
				],
				UTC_GB,
			),
		).toBe(
			"Nova read field-ops on CommCare HQ with your saved key on 6 October, to keep its apps' IDs steady through an update.",
		);
	});

	it("counts the other project spaces and spans the least first use to the greatest last use", () => {
		expect(
			keyReaderNoticeLine(
				[
					row(
						"field-ops",
						"2026-10-06T22:00:00.000Z",
						"2026-10-06T23:00:00.000Z",
					),
					row(
						"district",
						"2026-10-06T23:10:00.000Z",
						"2026-10-07T00:20:00.000Z",
					),
					row(
						"clinics",
						"2026-10-06T23:30:00.000Z",
						"2026-10-06T23:40:00.000Z",
					),
				],
				UTC_GB,
			),
		).toBe(
			"Nova read field-ops and 2 more project spaces on CommCare HQ with your saved key between 6 and 7 October, to keep their apps' IDs steady through an update.",
		);
		expect(
			keyReaderNoticeLine(
				[
					row(
						"field-ops",
						"2026-10-06T01:00:00.000Z",
						"2026-10-06T02:00:00.000Z",
					),
					row(
						"district",
						"2026-10-06T03:00:00.000Z",
						"2026-10-06T04:00:00.000Z",
					),
				],
				UTC_GB,
			),
		).toContain("field-ops and 1 more project space on CommCare HQ");
	});

	it("reads a run across midnight by the viewer's own zone", () => {
		const across = [
			row("field-ops", "2026-10-06T23:30:00.000Z", "2026-10-07T00:30:00.000Z"),
		];
		expect(keyReaderNoticeLine(across, UTC_GB)).toContain(
			"between 6 and 7 October",
		);
		expect(
			keyReaderNoticeLine(across, {
				locale: "en-GB",
				timeZone: "Asia/Kolkata",
			}),
		).toContain("on 7 October");
	});

	it("names both months across a month's end, in the viewer's locale order", () => {
		expect(
			noticeDaySpan(
				"2026-10-31T23:00:00.000Z",
				"2026-11-01T01:00:00.000Z",
				UTC_GB,
			),
		).toBe("between 31 October and 1 November");
		expect(
			noticeDaySpan("2026-10-06T10:00:00.000Z", "2026-10-07T10:00:00.000Z", {
				locale: "en-US",
				timeZone: "UTC",
			}),
		).toBe("between October 6 and 7");
	});
});
