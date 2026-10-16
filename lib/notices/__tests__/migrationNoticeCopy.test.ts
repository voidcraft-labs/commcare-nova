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

const FIELD_ENTITY = {
	type: "field",
	uuid: "01992000-0000-7000-8000-0000000000e1",
	nameAtMigration: "Card number",
} as const;

const LOOKUP_ENTITY = {
	type: "lookupTable",
	uuid: "01992000-0000-7000-8000-0000000000c1",
	nameAtMigration: "Clinics",
} as const;
const LOCATION_ENTITY = {
	type: "location",
	uuid: "01992000-0000-7000-8000-0000000000d1",
	nameAtMigration: "District 4",
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
	"option-label-filled": {
		withDetail: {
			kind: "document",
			reason: "option-label-filled",
			entity: FORM_ENTITY,
			detail: { question: "Village", value: "north" },
		},
		bare: {
			kind: "document",
			reason: "option-label-filled",
			entity: FORM_ENTITY,
		},
	},
	"android-form-lists-setting-stored": {
		withDetail: {
			kind: "document",
			reason: "android-form-lists-setting-stored",
			entity: APP_ENTITY,
			detail: { saved: "off", incomplete: "on" },
		},
		bare: {
			kind: "document",
			reason: "android-form-lists-setting-stored",
			entity: APP_ENTITY,
		},
	},
	"validation-now-enforced": {
		withDetail: {
			kind: "document",
			reason: "validation-now-enforced",
			entity: FIELD_ENTITY,
			detail: { form: "Intake", kind: "barcode" },
		},
		bare: {
			kind: "document",
			reason: "validation-now-enforced",
			entity: FIELD_ENTITY,
		},
	},
	"local-archive-changes": {
		withDetail: {
			kind: "document",
			reason: "local-archive-changes",
			entity: APP_ENTITY,
			detail: { apps: "1" },
		},
		bare: {
			kind: "document",
			reason: "local-archive-changes",
			entity: APP_ENTITY,
		},
	},
	"follow-up-now-touches-case": {
		withDetail: {
			kind: "document",
			reason: "follow-up-now-touches-case",
			entity: FORM_ENTITY,
			detail: { menu: "Patients" },
		},
		bare: {
			kind: "document",
			reason: "follow-up-now-touches-case",
			entity: FORM_ENTITY,
		},
	},
	"linked-follow-up-now-writes-case": {
		withDetail: {
			kind: "document",
			reason: "linked-follow-up-now-writes-case",
			entity: FORM_ENTITY,
			detail: { source: "Intake" },
		},
		bare: {
			kind: "document",
			reason: "linked-follow-up-now-writes-case",
			entity: FORM_ENTITY,
		},
	},
	"close-moves-to-save-to-case": {
		withDetail: {
			kind: "document",
			reason: "close-moves-to-save-to-case",
			entity: FORM_ENTITY,
			detail: { menu: "Patients" },
		},
		bare: {
			kind: "document",
			reason: "close-moves-to-save-to-case",
			entity: FORM_ENTITY,
		},
	},
	"case-name-now-checked": {
		withDetail: {
			kind: "document",
			reason: "case-name-now-checked",
			entity: FORM_ENTITY,
			detail: { question: "Full name" },
		},
		bare: {
			kind: "document",
			reason: "case-name-now-checked",
			entity: FORM_ENTITY,
		},
	},
	"setting-changes-at-next-publish": {
		withDetail: {
			kind: "deployment",
			reason: "setting-changes-at-next-publish",
			deployment: DEPLOYMENT,
			detail: { setting: "saved", readers: "android" },
		},
		bare: {
			kind: "deployment",
			reason: "setting-changes-at-next-publish",
			deployment: DEPLOYMENT,
		},
	},
	"settings-unknown-unreadable": deploymentEntries(
		"settings-unknown-unreadable",
		[],
	),
	"worker-settings-reset-at-next-publish": deploymentEntries(
		"worker-settings-reset-at-next-publish",
		[],
	),
	"hq-app-deleted": deploymentEntries("hq-app-deleted", []),
	"data-paths-move-once": deploymentEntries("data-paths-move-once", []),
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
	"next-publish-overwrites-hq-edits": deploymentEntries(
		"next-publish-overwrites-hq-edits",
		[],
	),
	"next-publish-asks-before-overwriting": deploymentEntries(
		"next-publish-asks-before-overwriting",
		[LOOKUP_ENTITY, LOCATION_ENTITY],
	),
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
			renderNoticeEntry(deployment("data-paths-move-once"), PRESENT).text,
		).toBe(
			"The next publish to field-ops moves the form data that Nova adds to each form to new names, once. Form exports in CommCare HQ show those columns under the new names from then on.",
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

describe("the lines about what the next publish writes over", () => {
	const deployment = (reason: string, entities?: readonly unknown[]) =>
		parsed({
			kind: "deployment",
			reason,
			deployment: DEPLOYMENT,
			...(entities && { entities }),
		});

	it("say the next publish replaces edits made in CommCare HQ before the update", () => {
		expect(
			renderNoticeEntry(deployment("next-publish-overwrites-hq-edits"), PRESENT)
				.text,
		).toBe(
			"The next publish to field-ops replaces any change made to this app in CommCare HQ before this update, without asking. For a change made there after this update, Nova asks first.",
		);
	});

	it("name the app where its own read failed, and each table and place otherwise", () => {
		expect(
			renderNoticeEntry(
				deployment("next-publish-asks-before-overwriting"),
				PRESENT,
			).text,
		).toBe(
			"Nova couldn't read this app on field-ops, so the next publish there asks before it writes over what CommCare HQ holds.",
		);
		const line = renderNoticeEntry(
			deployment("next-publish-asks-before-overwriting", [
				LOOKUP_ENTITY,
				LOCATION_ENTITY,
			]),
			REMOVED,
		);
		expect(line.text).toBe(
			"Nova couldn't read Clinics and District 4 on field-ops, so the next publish there asks before it writes over them.",
		);
		expect(
			line.parts.filter((part) => part.kind === "entity").map((p) => p.text),
		).toEqual(["Clinics", "District 4"]);
	});
});

describe("the form-list, validation and download lines", () => {
	const document = (reason: string, entity: unknown, detail?: object) =>
		parsed({ kind: "document", reason, entity, ...(detail && { detail }) });
	const deployment = (reason: string, detail?: object) =>
		parsed({
			kind: "deployment",
			reason,
			deployment: DEPLOYMENT,
			...(detail && { detail }),
		});

	it("states both stored form-list settings, naming the readers of each", () => {
		expect(
			renderNoticeEntry(
				document("android-form-lists-setting-stored", APP_ENTITY, {
					saved: "off",
					incomplete: "on",
				}),
				PRESENT,
			).text,
		).toBe(
			"This app now states whether workers see saved forms and incomplete forms on their home screen: saved forms off, incomplete forms on. Android reads both settings, and Web Apps reads the incomplete forms one. Nova kept each list on wherever a project space of this app shows it today. They are yours to change in App settings.",
		);
	});

	it("names the form, the question and the value a choice with no label now shows", () => {
		const line = renderNoticeEntry(
			document("option-label-filled", FORM_ENTITY, {
				question: "Village",
				value: "north",
			}),
			REMOVED,
		);
		expect(line.text).toBe(
			"Visit: the choice with the value north in Village had no label, so it now shows its value. Give it the wording you want workers to read.",
		);
		expect(
			line.parts.filter((part) => part.kind === "entity").map((p) => p.text),
		).toEqual(["Visit"]);
	});

	it("names the form and the question whose validation now runs, by its kind", () => {
		const line = renderNoticeEntry(
			document("validation-now-enforced", FIELD_ENTITY, {
				form: "Intake",
				kind: "barcode",
			}),
			REMOVED,
		);
		expect(line.text).toBe(
			"Intake, Card number: its validation now runs on this barcode question. Workers see its message when an answer doesn't pass.",
		);
		expect(
			line.parts.filter((part) => part.kind === "entity").map((p) => p.text),
		).toEqual(["Card number"]);
		expect(
			renderNoticeEntry(
				document("validation-now-enforced", FIELD_ENTITY, {
					form: "Intake",
					kind: "secret",
				}),
				REMOVED,
			).text,
		).toContain("on this secret question.");
	});

	it("says what a downloaded file now needs, the same for every app", () => {
		const connect = { ...APP_ENTITY, nameAtMigration: "Deliveries" };
		for (const entity of [APP_ENTITY, connect]) {
			expect(
				renderNoticeEntry(document("local-archive-changes", entity), PRESENT)
					.text,
			).toBe(
				"A CommCare file downloaded from Nova now needs CommCare 2.57 or later.",
			);
		}
	});

	it("says what each case-write change means for its form", () => {
		const form = (name: string) => ({ ...FORM_ENTITY, nameAtMigration: name });
		expect(
			renderNoticeEntry(
				document("follow-up-now-touches-case", form("Review")),
				REMOVED,
			).text,
		).toBe(
			"Review: submitting it now updates its case's last-modified date, even when nothing changes. Case update rules and data forwarding in CommCare HQ see that.",
		);
		const linked = renderNoticeEntry(
			document("linked-follow-up-now-writes-case", form("Review"), {
				source: "Intake",
			}),
			REMOVED,
		);
		expect(linked.text).toBe(
			"Review, when Intake opens it: submitting it now updates the case that link names. If the link's case value is empty, Android can't save the form, and if it names no case, CommCare HQ creates one. The value is yours to change in Intake's link.",
		);
		expect(
			linked.parts.filter((part) => part.kind === "entity").map((p) => p.text),
		).toEqual(["Review"]);
		expect(
			renderNoticeEntry(
				document("close-moves-to-save-to-case", form("Discharge")),
				REMOVED,
			).text,
		).toBe(
			"Discharge: its close is now written as a case change in the form. CommCare HQ shows no close on its Case Management tab, and the next publish asks about one more plan feature.",
		);
		expect(
			renderNoticeEntry(
				document("case-name-now-checked", form("Register"), {
					question: "Full name",
				}),
				REMOVED,
			).text,
		).toBe(
			"Register: workers now see a message when the case name from Full name is blank or longer than 255 characters. CommCare can't save a case with a name like that.",
		);
	});

	it("says which list workers gain at the next publish, and on which readers", () => {
		expect(
			renderNoticeEntry(
				deployment("setting-changes-at-next-publish", {
					setting: "saved",
					readers: "android",
				}),
				PRESENT,
			).text,
		).toBe(
			"Workers on field-ops will see saved forms on Android after the next publish there. They don't today, and another project space of this app shows them. You can turn them off in App settings.",
		);
		expect(
			renderNoticeEntry(
				deployment("setting-changes-at-next-publish", {
					setting: "incomplete",
					readers: "android",
				}),
				PRESENT,
			).text,
		).toBe(
			"Workers on field-ops will see incomplete forms on Android after the next publish there, as they already do in Web Apps. You can turn them off in App settings.",
		);
		expect(
			renderNoticeEntry(
				deployment("setting-changes-at-next-publish", {
					setting: "incomplete",
					readers: "android-and-webapps",
				}),
				PRESENT,
			).text,
		).toBe(
			"Workers on field-ops will see incomplete forms on Android and in Web Apps after the next publish there. They don't today, and another project space of this app shows them. You can turn them off in App settings.",
		);
	});

	it("says what the next publish does where the settings could not be read, and which worker settings it resets", () => {
		expect(
			renderNoticeEntry(deployment("settings-unknown-unreadable"), PRESENT)
				.text,
		).toBe(
			"Nova couldn't read field-ops, so it could not tell whether workers see saved and incomplete forms there. The next publish there sets them to this app's settings. They are yours to change in App settings.",
		);
		expect(
			renderNoticeEntry(
				deployment("worker-settings-reset-at-next-publish"),
				PRESENT,
			).text,
		).toBe(
			"After the next publish to field-ops, each app update resets three of a worker's own settings: fuzzy search, automatic updates and text to speech.",
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
