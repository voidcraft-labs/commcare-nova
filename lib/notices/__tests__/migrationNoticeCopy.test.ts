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

const DEPLOYMENT = {
	deploymentId: "01992000-0000-7000-8000-000000000011",
	server: "production",
	domain: "field-ops",
} as const;
const FORM_ENTITY = {
	type: "form",
	uuid: "01992000-0000-7000-8000-0000000000b1",
	nameAtMigration: "Visit",
} as const;

/** A deployment reason's entries, with entities and without any. */
function deploymentEntries(reason: string, entities: readonly unknown[]) {
	return {
		withDetail: {
			kind: "deployment",
			reason,
			deployment: DEPLOYMENT,
			entities,
		},
		bare: { kind: "deployment", reason, deployment: DEPLOYMENT },
	};
}

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
	"ccz-needs-project-space": {
		withDetail: {
			kind: "document",
			reason: "ccz-needs-project-space",
			entity: APP_ENTITY,
			detail: { deployments: "0" },
		},
		bare: {
			kind: "document",
			reason: "ccz-needs-project-space",
			entity: APP_ENTITY,
		},
	},
	"hq-app-deleted": deploymentEntries("hq-app-deleted", []),
	"hq-app-not-nova-made": deploymentEntries("hq-app-not-nova-made", []),
	"ids-change-once-unreadable": deploymentEntries(
		"ids-change-once-unreadable",
		[],
	),
	"menu-id-changes-once": deploymentEntries("menu-id-changes-once", [
		MODULE_ENTITY,
		FORM_ENTITY,
	]),
	"form-ids-change-once": deploymentEntries("form-ids-change-once", [
		FORM_ENTITY,
	]),
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

describe("the identity, gone app and download lines", () => {
	const deployment = (reason: string, entities?: readonly unknown[]) =>
		parsed({
			kind: "deployment",
			reason,
			deployment: DEPLOYMENT,
			...(entities && { entities }),
		});
	const register = {
		type: "module",
		uuid: MODULE_UUID,
		nameAtMigration: "Register",
	};
	const visit = { ...FORM_ENTITY, nameAtMigration: "Visit" };
	const followUp = {
		type: "form",
		uuid: "01992000-0000-7000-8000-0000000000b2",
		nameAtMigration: "Follow-up",
	};

	it("name each menu and form whose id changes, joined as a list, and the keyword sentences only where a form is among them", () => {
		expect(
			renderNoticeEntry(deployment("menu-id-changes-once", [register]), REMOVED)
				.text,
		).toBe(
			"At the next publish to field-ops, CommCare HQ gets new IDs for Register, once, because Nova couldn't match them to what that project space holds.",
		);
		const line = renderNoticeEntry(
			deployment("menu-id-changes-once", [register, visit, followUp]),
			REMOVED,
		);
		expect(line.text).toBe(
			"At the next publish to field-ops, CommCare HQ gets new IDs for Register, Visit and Follow-up, once, because Nova couldn't match them to what that project space holds. Forms submitted before then stay under each form's earlier ID in CommCare HQ. If an SMS keyword or a scheduled message opens one of these forms, you can point it at the form again in CommCare HQ once you release a build made after that publish.",
		);
		expect(
			line.parts.filter((part) => part.kind === "entity").map((p) => p.text),
		).toEqual(["Register", "Visit", "Follow-up"]);
		expect(
			renderNoticeEntry(
				deployment("form-ids-change-once", [visit, followUp]),
				REMOVED,
			).text,
		).toBe(
			"At the next publish to field-ops, the CommCare HQ IDs of Visit and Follow-up change once, because Nova couldn't read the ones that project space holds. Their submissions stay together. If an SMS keyword or a scheduled message opens one of these forms, you can point it at the form again in CommCare HQ once you release a build made after that publish.",
		);
	});

	it("say what the whole-app lines say", () => {
		expect(renderNoticeEntry(deployment("hq-app-deleted"), PRESENT).text).toBe(
			"The app Nova made on field-ops was deleted in CommCare HQ, so the next publish there makes a new app in its place. If it was deleted by mistake, you can restore it in CommCare HQ and then choose Check status for field-ops, and the next publish updates it again.",
		);
		expect(
			renderNoticeEntry(deployment("hq-app-not-nova-made"), PRESENT).text,
		).toBe(
			"The app on field-ops is a linked app in CommCare HQ, so Nova can't publish to it there. You can publish to another project space.",
		);
		expect(
			renderNoticeEntry(deployment("ids-change-once-unreadable"), PRESENT).text,
		).toBe(
			"Nova couldn't read the app on field-ops during this update, so the next publish there asks before it writes over that copy. Once you confirm, every menu and form of the app there gets a new ID in CommCare HQ, once. Forms submitted before then stay under each form's earlier ID in CommCare HQ. If an SMS keyword or a scheduled message opens one of its forms, you can point it at the form again in CommCare HQ once you release a build made after that publish.",
		);
		expect(
			renderNoticeEntry(
				parsed(ENTRIES["ccz-needs-project-space"].bare),
				PRESENT,
			).text,
		).toBe(
			"A CCZ of this app can be downloaded once the app is published to a project space. A CCZ downloaded earlier named no CommCare HQ server, so a phone that holds one cannot sign in or send forms with it.",
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
