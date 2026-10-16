import { describe, expect, it } from "vitest";
import { COMMCARE_VERSION_FLOOR } from "@/lib/commcare/versionFloor";
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

const ENTRY_POINT_ENTITY = {
	type: "entryPoint",
	uuid: "01992000-0000-7000-8000-0000000000f1",
	nameAtMigration: "intake",
} as const;

const COLUMN_ENTITY = {
	type: "caseListColumn",
	uuid: "01992000-0000-7000-8000-0000000000c9",
	nameAtMigration: "Zone",
} as const;

const SEARCH_INPUT_ENTITY = {
	type: "searchInput",
	uuid: "01992000-0000-7000-8000-0000000000d1",
	nameAtMigration: "Clinic",
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

/** A document reason's entries, with details and without any. */
function documentEntries(
	reason: string,
	entity: unknown,
	detail: Record<string, string>,
) {
	return {
		withDetail: { kind: "document", reason, entity, detail },
		bare: { kind: "document", reason, entity },
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
	"question-renamed": documentEntries("question-renamed", FIELD_ENTITY, {
		form: "Intake",
		kind: "question",
		from: "_notes",
		to: "notes",
	}),
	"case-operation-renamed": documentEntries(
		"case-operation-renamed",
		FORM_ENTITY,
		{ from: "instance", to: "q_instance" },
	),
	"connect-block-renamed": documentEntries(
		"connect-block-renamed",
		FORM_ENTITY,
		{ block: "deliver_unit", from: "_1st_visit", to: "q1st_visit" },
	),
	"connect-task-moved-to-own-form": documentEntries(
		"connect-task-moved-to-own-form",
		FORM_ENTITY,
		{ task: "follow_up", newForm: "Follow-up task" },
	),
	"entry-point-renamed": documentEntries(
		"entry-point-renamed",
		ENTRY_POINT_ENTITY,
		{ from: "intake_", to: "intake" },
	),
	"option-value-split": documentEntries("option-value-split", FORM_ENTITY, {
		question: "consent",
		value: "yes",
		to: "yes_2",
		keptLabel: "Yes",
		label: "Yes, today",
	}),
	"empty-form-label-added": documentEntries(
		"empty-form-label-added",
		FORM_ENTITY,
		{},
	),
	"session-read-removed": documentEntries(
		"session-read-removed",
		FIELD_ENTITY,
		{ form: "Intake", datum: "case_id_new" },
	),
	"id-mapping-entry-removed": documentEntries(
		"id-mapping-entry-removed",
		COLUMN_ENTITY,
		{ menu: "Households", value: "a'b" },
	),
	"date-pattern-apostrophe-replaced": documentEntries(
		"date-pattern-apostrophe-replaced",
		COLUMN_ENTITY,
		{ menu: "Households" },
	),
	"tile-order-rule-removed": documentEntries(
		"tile-order-rule-removed",
		COLUMN_ENTITY,
		{ menu: "Households", shape: "case_id" },
	),
	"order-rule-removed-same-property": documentEntries(
		"order-rule-removed-same-property",
		COLUMN_ENTITY,
		{ menu: "Households", kept: "Score" },
	),
	"order-rule-moved-to-first-column": documentEntries(
		"order-rule-moved-to-first-column",
		COLUMN_ENTITY,
		{ menu: "Households", to: "Zone name" },
	),
	"tile-cell-defaults-set": documentEntries(
		"tile-cell-defaults-set",
		MODULE_ENTITY,
		{},
	),
	"case-list-order-changes": documentEntries(
		"case-list-order-changes",
		MODULE_ENTITY,
		{ cause: "unsorted", kind: "date" },
	),
	"case-list-search-matches-hidden-fields": documentEntries(
		"case-list-search-matches-hidden-fields",
		MODULE_ENTITY,
		{},
	),
	"hidden-order-column-not-in-sort-menu": documentEntries(
		"hidden-order-column-not-in-sort-menu",
		COLUMN_ENTITY,
		{ menu: "Households" },
	),
	"media-slot-removed": documentEntries("media-slot-removed", FIELD_ENTITY, {
		form: "Visit",
		slot: "hint",
		media: "image",
	}),
	"hidden-value-saves-blank": documentEntries(
		"hidden-value-saves-blank",
		FIELD_ENTITY,
		{ form: "Register", property: "visit_status" },
	),
	"search-button-text-changed": documentEntries(
		"search-button-text-changed",
		MODULE_ENTITY,
		{ from: "Find a patient" },
	),
	"search-input-renamed": documentEntries(
		"search-input-renamed",
		SEARCH_INPUT_ENTITY,
		{ menu: "Patients", from: "_xpath_query", to: "_xpath_query_2" },
	),
	"search-input-removed": documentEntries(
		"search-input-removed",
		SEARCH_INPUT_ENTITY,
		{ menu: "Patients", expressions: "2" },
	),
	"time-comparison-never-true": documentEntries(
		"time-comparison-never-true",
		FIELD_ENTITY,
		{ form: "Visit", comparison: "#form/start > '17:00'" },
	),
	"search-term-matches-nothing": documentEntries(
		"search-term-matches-nothing",
		MODULE_ENTITY,
		{ term: "date_opened is blank" },
	),
	"hidden-from-menu-set": documentEntries(
		"hidden-from-menu-set",
		FORM_ENTITY,
		{},
	),
	"after-submit-destination-moved": documentEntries(
		"after-submit-destination-moved",
		FORM_ENTITY,
		{ from: "module", to: "firstMenu", cause: "off-the-menu", menu: "Archive" },
	),
	"lookup-choices-order-changes": documentEntries(
		"lookup-choices-order-changes",
		SEARCH_INPUT_ENTITY,
		{ menu: "Patients" },
	),
	"lookup-tag-renamed": documentEntries("lookup-tag-renamed", LOOKUP_ENTITY, {
		from: "clinic_casedb_codes",
		to: "clinic_case_db_codes",
	}),
	"survey-menu-takes-case-type": documentEntries(
		"survey-menu-takes-case-type",
		MODULE_ENTITY,
		{ caseType: "household" },
	),
	"record-id-column-now-shows": documentEntries(
		"record-id-column-now-shows",
		COLUMN_ENTITY,
		{ menu: "Households", kind: "image-map" },
	),
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
	"next-publish-asks-more": {
		withDetail: {
			kind: "deployment",
			reason: "next-publish-asks-more",
			deployment: DEPLOYMENT,
			detail: {
				planFeatures: "worker-records,organization,data-forwarding",
				settings: "flat-location-fixture,connect-forwarder",
				capabilities: "case-search,case-tiles",
			},
		},
		bare: {
			kind: "deployment",
			reason: "next-publish-asks-more",
			deployment: DEPLOYMENT,
		},
	},
	"commcare-version-below-floor": {
		withDetail: {
			kind: "deployment",
			reason: "commcare-version-below-floor",
			deployment: DEPLOYMENT,
			detail: { version: "2.53.0" },
		},
		bare: {
			kind: "deployment",
			reason: "commcare-version-below-floor",
			deployment: DEPLOYMENT,
		},
	},
	"logo-upload-in-hq": deploymentEntries("logo-upload-in-hq", []),
	"settings-unknown-unreadable": deploymentEntries(
		"settings-unknown-unreadable",
		[],
	),
	"worker-settings-reset-at-next-publish": deploymentEntries(
		"worker-settings-reset-at-next-publish",
		[],
	),
	"lookup-table-content-unsupported": {
		withDetail: {
			kind: "deployment",
			reason: "lookup-table-content-unsupported",
			deployment: DEPLOYMENT,
			entities: [LOOKUP_ENTITY],
			detail: { holds: "field-properties,row-attributes,owned-rows" },
		},
		bare: {
			kind: "deployment",
			reason: "lookup-table-content-unsupported",
			deployment: DEPLOYMENT,
		},
	},
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

describe("the lines about what the next publish checks", () => {
	const deployment = (reason: string, detail?: object) =>
		parsed({
			kind: "deployment",
			reason,
			deployment: DEPLOYMENT,
			...(detail && { detail }),
		});

	it("names each plan feature, setting and capability the next publish asks about, in every surface's order", () => {
		// A stored `next-publish-asks-more` entry holds each list
		// comma-joined: plan feature ids, the two settings, capability ids.
		expect(
			renderNoticeEntry(
				deployment("next-publish-asks-more", {
					planFeatures: "lookup-tables,worker-records",
					capabilities: "related-case-search,case-tiles",
				}),
				PRESENT,
			).text,
		).toBe(
			"The next publish to field-ops asks you to confirm what the project space has: Worker records (user cases), Lookup Tables, Search across related cases and Case tiles.",
		);
	});

	it("says why it asks about the flat location list, and that phones get the list today whatever the setting says", () => {
		expect(
			renderNoticeEntry(
				deployment("next-publish-asks-more", {
					planFeatures: "organization",
					settings: "flat-location-fixture",
				}),
				PRESENT,
			).text,
		).toBe(
			"The next publish to field-ops asks you to confirm what the project space has: Locations and the flat location list. Phones and Web Apps both take the location list by field-ops' own setting from then on, so Nova asks whether it still sends it. Until that publish, phones get the list whatever that setting says, so places working on phones today don't show that it's on. It's on unless someone turned it off in the project space's Location Fixture settings.",
		);
	});

	it("says a Connect app's forms reach Connect only through data forwarding", () => {
		expect(
			renderNoticeEntry(
				deployment("next-publish-asks-more", {
					planFeatures: "data-forwarding",
					settings: "connect-forwarder",
				}),
				PRESENT,
			).text,
		).toBe(
			"The next publish to field-ops asks you to confirm what the project space has: Data Forwarding and a Connect forwarder. This app's forms reach CommCare Connect only through CommCare HQ's data forwarding, so Nova asks whether field-ops has Data Forwarding and a Connect forwarder.",
		);
	});

	it("leaves out an id Nova no longer knows", () => {
		expect(
			renderNoticeEntry(
				deployment("next-publish-asks-more", {
					planFeatures: "retired-feature,child-cases",
				}),
				PRESENT,
			).text,
		).toBe(
			"The next publish to field-ops asks you to confirm what the project space has: Child Cases.",
		);
	});

	it("names the version the app is set to and how to raise it", () => {
		expect(
			renderNoticeEntry(
				deployment("commcare-version-below-floor", { version: "2.53.0" }),
				PRESENT,
			).text,
		).toBe(
			"The app on field-ops is set to CommCare 2.53.0, and Nova's apps now need 2.57 or later. The next publish there waits until you raise its CommCare version in that app's settings in CommCare HQ. Phones on an older CommCare can no longer install or update the app after that. Saving that page also sets the app's other settings there, so the publish after it first shows you what changed.",
		);
	});

	it("names the floor every other surface names", () => {
		const { major, minor } = COMMCARE_VERSION_FLOOR;
		expect(
			renderNoticeEntry(
				deployment("commcare-version-below-floor", { version: "2.53.0" }),
				PRESENT,
			).text,
		).toContain(`now need ${major}.${minor} or later`);
	});

	it("says the logo is no longer sent and where it shows once added in HQ", () => {
		expect(
			renderNoticeEntry(deployment("logo-upload-in-hq"), PRESENT).text,
		).toBe(
			"From the next publish to field-ops, Nova doesn't send this app's logo with it. Apps built on CommCare HQ show the logo once it is added in that app's settings there; until then they carry none, and Web Apps shows its own icon. After that publish, Nova offers the logo to download.",
		);
	});
});

describe("the case list lines", () => {
	const document = (reason: string, entity: unknown, detail?: object) =>
		parsed({ kind: "document", reason, entity, ...(detail && { detail }) });
	const column = (name: string) => ({
		...COLUMN_ENTITY,
		nameAtMigration: name,
	});
	const menu = { ...MODULE_ENTITY, nameAtMigration: "Households" };
	const say = (raw: MigrationNoticeEntry) => renderNoticeEntry(raw, REMOVED);

	it("name the menu and the column each rewritten order rule, mapping and pattern belongs to", () => {
		const removed = say(
			document("id-mapping-entry-removed", column("Zone"), {
				menu: "Households",
				value: "a'b",
			}),
		);
		expect(removed.text).toBe(
			"Households, Zone: the mapping for a'b is gone. CommCare HQ's ID mapping can't hold that value, so cases with it now show nothing in this column.",
		);
		expect(
			removed.parts.filter((part) => part.kind === "entity").map((p) => p.text),
		).toEqual(["Zone"]);
		expect(
			say(
				document("date-pattern-apostrophe-replaced", column("Visited"), {
					menu: "Households",
				}),
			).text,
		).toBe(
			"Households, Visited: the date format's straight apostrophe is now a curved one (’). CommCare HQ's date column can't hold a straight one, and an app holding one could not be installed from CommCare HQ.",
		);
		expect(
			say(
				document("order-rule-removed-same-property", column("Score copy"), {
					menu: "Households",
					kept: "Score",
				}),
			).text,
		).toBe(
			"Households: removed the order rule on Score copy. It ordered by the same value as the rule on Score, and a list keeps one for each value. Apps installed from CommCare HQ followed the removed rule, so their order may change.",
		);
		expect(
			say(
				document("order-rule-moved-to-first-column", column("Zone"), {
					menu: "Households",
					to: "Zone name",
				}),
			).text,
		).toBe(
			"Households: the order rule on Zone moved to Zone name. CommCare gives an order rule to the first column with that value. Downloaded apps and Preview now order as apps installed from CommCare HQ do.",
		);
	});

	it("choose the tile order sentence by the shape the rule had", () => {
		expect(
			say(
				document("tile-order-rule-removed", column("Risk score"), {
					menu: "Households",
					shape: "calculated",
				}),
			).text,
		).toBe(
			"Households: the list no longer orders by Risk score. A tile list can't order by a calculation that isn't on the tile.",
		);
		expect(
			say(
				document("tile-order-rule-removed", column("Record ID"), {
					menu: "Households",
					shape: "case_id",
				}),
			).text,
		).toBe(
			"Households: the list no longer orders by Record ID. A tile list can't order by Record ID unless the column is on the tile.",
		);
	});

	it("say what a filled tile cell changes on each runtime", () => {
		expect(say(document("tile-cell-defaults-set", menu)).text).toBe(
			"Households: each tile cell now states its size and alignment. On Android, tile text is slightly smaller and an image sits at the start of its cell, not its centre. In Web Apps, tile text is larger: it no longer follows the list's size. In a right-to-left language, text that followed the reading direction now aligns left.",
		);
	});

	it("choose the order change sentence by its cause, naming the column for the first four", () => {
		const changes = (detail: object) =>
			say(document("case-list-order-changes", menu, detail)).text;
		expect(changes({ cause: "id-mapping", column: "Zone name" })).toBe(
			"Households: the list now orders Zone name by the order of its mapping table. Apps installed from CommCare HQ ordered it by label, and downloaded apps and Preview by the stored value. Where fuzzy search is on, a near miss of a label no longer finds its case in apps installed from CommCare HQ.",
		);
		expect(changes({ cause: "image-map", column: "Zone image" })).toBe(
			"Households: downloaded apps and Preview now order Zone image by the order of its image table, as apps installed from CommCare HQ already do.",
		);
		expect(changes({ cause: "interval", column: "Seen" })).toBe(
			"Households: downloaded apps and Preview now order Seen by the text it shows, not by its date, as apps installed from CommCare HQ already do.",
		);
		expect(changes({ cause: "option-label", column: "Level label" })).toBe(
			"Households: downloaded apps and Preview now order Level label by its labels, not by the stored values, as apps installed from CommCare HQ already do.",
		);
		expect(changes({ cause: "unsorted", kind: "plain" })).toBe(
			"Households: with no order rule, Preview now lists cases by the first column, as devices do.",
		);
		expect(changes({ cause: "unsorted", kind: "date" })).toBe(
			"Households: with no order rule, Preview now lists cases by the first column, as devices do. Downloaded apps now order that column by date, not by the text it shows.",
		);
	});

	it("say what a hidden field means for the list's search and for Android's Sort menu", () => {
		expect(
			say(document("case-list-search-matches-hidden-fields", menu)).text,
		).toBe(
			"Households: the list's search now also matches the fields hidden from Results.",
		);
		expect(
			say(
				document("hidden-order-column-not-in-sort-menu", column("Rank"), {
					menu: "Households",
				}),
			).text,
		).toBe(
			"Households: Android's Sort menu no longer offers Rank in a downloaded app, because the column is hidden. The list's own order still follows it.",
		);
	});

	it("say what a Record ID column shows after the next publish, by its kind", () => {
		const shows = (kind: string) =>
			say(
				document("record-id-column-now-shows", column("Record ID"), {
					menu: "Households",
					kind,
				}),
			).text;
		expect(shows("plain")).toBe(
			"Households, Record ID: this column was blank in apps installed from CommCare HQ. After the next publish it shows each case's ID.",
		);
		expect(shows("phone")).toBe(shows("plain"));
		expect(shows("image-map")).toBe(
			"Households, Record ID: this column was blank in apps installed from CommCare HQ. After the next publish it shows the image mapped to each case's ID.",
		);
	});
});

describe("the menu, navigation and search lines", () => {
	const document = (
		reason: MigrationNoticeReason,
		entity: unknown,
		detail?: Record<string, string>,
	) =>
		parsed({
			kind: "document",
			reason,
			entity,
			...(detail !== undefined && { detail }),
		});
	const say = (entry: MigrationNoticeEntry) =>
		renderNoticeEntry(entry, REMOVED);
	const patients = { ...MODULE_ENTITY, nameAtMigration: "Patients" };
	const visit = { ...FORM_ENTITY, nameAtMigration: "Visit" };

	it("says the search button now reads CommCare HQ's own text, and what it read before", () => {
		expect(
			say(
				document("search-button-text-changed", patients, {
					from: "Find a patient",
				}),
			).text,
		).toBe(
			"Patients: the search button now reads “Search All Cases”. It read “Find a patient” before. CommCare HQ always shows its own text there.",
		);
	});

	it("names a renamed and a removed search input, and counts the expressions a removal emptied", () => {
		expect(
			say(
				document(
					"search-input-renamed",
					{ ...SEARCH_INPUT_ENTITY, nameAtMigration: "_xpath_query_2" },
					{ menu: "Patients", from: "_xpath_query", to: "_xpath_query_2" },
				),
			).text,
		).toBe(
			"Patients: the search input _xpath_query is now _xpath_query_2. CommCare reads the earlier name as part of the search itself.",
		);
		const removed = {
			...SEARCH_INPUT_ENTITY,
			nameAtMigration: "include_closed",
		};
		expect(
			say(
				document("search-input-removed", removed, {
					menu: "Patients",
					expressions: "2",
				}),
			).text,
		).toBe(
			"Patients: the search input include_closed was removed. CommCare reads that name as part of the search request, so it never searched a property. 2 expressions that read it now treat it as empty.",
		);
		expect(
			say(
				document("search-input-removed", removed, {
					menu: "Patients",
					expressions: "1",
				}),
			).text,
		).toContain("1 expression that read it now treats it as empty.");
		expect(
			say(
				document("search-input-removed", removed, {
					menu: "Patients",
					expressions: "0",
				}),
			).text,
		).toBe(
			"Patients: the search input include_closed was removed. CommCare reads that name as part of the search request, so it never searched a property.",
		);
	});

	it("says a module or a form is now off the menu, naming which", () => {
		expect(
			say(
				document("hidden-from-menu-set", {
					...MODULE_ENTITY,
					nameAtMigration: "Archive",
				}),
			).text,
		).toBe(
			"Archive: this module is now marked as not on the menu, because its display condition could never be true. Its settings show what can still open it.",
		);
		expect(say(document("hidden-from-menu-set", visit)).text).toBe(
			"Visit: this form is now marked as not on the menu, because its display condition could never be true. Its settings show what can still open it.",
		);
	});

	it("chooses the moved destination's sentence by its cause", () => {
		expect(
			say(
				document("after-submit-destination-moved", visit, {
					from: "previous",
					to: "module",
					cause: "multi-select-menu",
					menu: "Batches",
				}),
			).text,
		).toBe(
			"Visit: after submitting, workers now go back to this module's case list. It was set to the previous screen, which CommCare HQ doesn't offer in a module that selects several cases.",
		);
		expect(
			say(
				document("after-submit-destination-moved", visit, {
					from: "module",
					to: "firstMenu",
					cause: "multi-select-parent",
					menu: "One sample",
				}),
			).text,
		).toBe(
			"Visit: after submitting, workers now go to the app's first menu (First menu in its settings). It was set to its module, which CommCare HQ doesn't offer in a module under one that selects several cases.",
		);
		expect(
			say(
				document("after-submit-destination-moved", visit, {
					from: "previous",
					to: "firstMenu",
					cause: "off-the-menu",
					menu: "Archive",
				}),
			).text,
		).toBe(
			"Visit: after submitting, workers now go to the app's first menu (First menu in its settings). It was set to the previous screen, and Archive is now off the menu, so there is no screen of it to go back to.",
		);
	});

	it("says a lookup question's choices now follow their labels, and a survey module shows its case type", () => {
		expect(
			say(
				document("lookup-choices-order-changes", SEARCH_INPUT_ENTITY, {
					menu: "Patients",
				}),
			).text,
		).toBe(
			"Patients, Clinic: its choices are now listed by label, not in the table's row order.",
		);
		expect(
			say(
				document(
					"survey-menu-takes-case-type",
					{ ...MODULE_ENTITY, nameAtMigration: "Surveys" },
					{ caseType: "household" },
				),
			).text,
		).toBe(
			"Surveys: CommCare HQ shows this module's case type, household, from the next publish.",
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

describe("the identifier and form content lines", () => {
	/* Each entity reads by the name it had when the cutover ran. */
	const SAME: NoticeRenderContext = {
		nameOf: (entity) => entity.nameAtMigration,
	};
	const render = (raw: unknown) => renderNoticeEntry(parsed(raw), SAME).text;
	const field = (nameAtMigration: string) => ({
		...FIELD_ENTITY,
		nameAtMigration,
	});
	const form = (nameAtMigration: string) => ({
		...FORM_ENTITY,
		nameAtMigration,
	});
	const app = { type: "app", nameAtMigration: "Clinic visits" } as const;
	const doc = (
		reason: string,
		entity: unknown,
		detail?: Record<string, string>,
	) => ({ kind: "document", reason, entity, ...(detail && { detail }) });

	it("say a renamed question moves its export column, and a renamed container moves the questions inside it", () => {
		expect(
			render(
				doc("question-renamed", field("notes"), {
					form: "Intake",
					kind: "question",
					from: "_notes",
					to: "notes",
				}),
			),
		).toBe(
			"Intake: the question _notes is now notes, because CommCare HQ's form builder can't keep the old ID. Submissions use the new name from your next publish. In CommCare HQ, a form export column or report that reads _notes stops filling and a new notes column starts.",
		);
		expect(
			render(
				doc("question-renamed", field("q_Meta"), {
					form: "Intake",
					kind: "repeat",
					from: "Meta",
					to: "q_Meta",
				}),
			),
		).toBe(
			"Intake: the repeat Meta is now q_Meta, because CommCare HQ's form builder can't keep the old ID. Every question inside it moves with it, so submissions use the new paths from your next publish. In CommCare HQ, a form export column or report that reads a question under Meta stops filling and a new column starts.",
		);
	});

	it("say a renamed case change moves its place in each submission", () => {
		expect(
			render(
				doc("case-operation-renamed", form("Visit"), {
					from: "instance",
					to: "q_instance",
				}),
			),
		).toBe(
			"Visit: the case change instance is now q_instance. Its place in each submission moves with the name from your next publish.",
		);
	});

	it("say what CommCare Connect does with each kind of renamed block", () => {
		const block = (kind: string, from: string, to: string) =>
			render(
				doc("connect-block-renamed", form("Visit"), { block: kind, from, to }),
			);
		expect(block("deliver_unit", "_1st_visit", "q1st_visit")).toBe(
			"Visit: the deliver unit _1st_visit is now q1st_visit. CommCare Connect reads it as a new deliver unit and turns away each delivery until an opportunity manager adds q1st_visit to a payment unit. It helps to ask them to do that before your next publish: CommCare HQ doesn't send a turned-away delivery again, so deliveries made in between stay unpaid.",
		);
		expect(block("learn_module", "_basics", "basics")).toBe(
			"Visit: the learn module _basics is now basics. CommCare Connect reads it as a second module and keeps the old one, so a learner who had not finished the course before this stays short of finished. A learner who had finished stays finished.",
		);
		expect(block("assessment", "XMLquiz", "qXMLquiz")).toBe(
			"Visit: the assessment XMLquiz is now qXMLquiz. CommCare Connect keeps no record under an assessment's ID, so scoring is unchanged.",
		);
		expect(block("task", "task", "q_task")).toBe(
			"Visit: CommCare Connect could not receive this form while its block was called task. Forms sent before this change are not in CommCare Connect, and CommCare HQ's retries of them keep failing, because each still carries the old name. The task task is now q_task. CommCare Connect reads it as a new task type. A task assigned under task is never completed by this form, and CommCare Connect rejects that worker's deliveries while it stays assigned.",
		);
	});

	it("say a task moved to a form of its own keeps its ID", () => {
		expect(
			render(
				doc("connect-task-moved-to-own-form", form("Home visit"), {
					task: "follow_up",
					newForm: "Follow up",
				}),
			),
		).toBe(
			"Home visit: its task follow_up is now in a form of its own, Follow up, in the same menu. CommCare Connect turned away the visit in a form that also completed a task the worker was assigned. The task keeps its ID, so tasks already assigned are completed by the new form from your next publish.",
		);
	});

	it("say a renamed deep link breaks links shared with the old ID", () => {
		expect(
			render(
				doc("entry-point-renamed", ENTRY_POINT_ENTITY, {
					from: "intake_",
					to: "intake",
				}),
			),
		).toBe(
			"The deep link intake_ is now intake. Links shared with the old ID stop working after your next publish.",
		);
	});

	it("say which choice keeps a shared value, for a question and for a case property's own list", () => {
		const detail = {
			value: "yes",
			to: "yes_2",
			keptLabel: "Yes",
			label: "Yes, today",
		};
		expect(
			render(
				doc("option-value-split", form("Intake"), {
					...detail,
					question: "consent",
				}),
			),
		).toBe(
			"Intake, consent: the choices Yes and Yes, today both stored yes. Yes, today now stores yes_2. Answers saved before this show as Yes.",
		);
		expect(
			render(
				doc("option-value-split", app, {
					...detail,
					caseType: "patient",
					property: "consent",
				}),
			),
		).toBe(
			"patient, consent: the choices Yes and Yes, today both stored yes. Yes, today now stores yes_2. Values saved before this show as Yes.",
		);
	});

	it("say an empty form gained a label, and a session read that never had a value reads nothing", () => {
		expect(render(doc("empty-form-label-added", form("Visit")))).toBe(
			"Visit had no questions, and CommCare HQ won't build a form like that. It now has one label to replace with your first question.",
		);
		expect(
			render(
				doc("session-read-removed", field("parent_name"), {
					form: "Visit",
					datum: "case_id_new_child_0",
				}),
			),
		).toBe(
			"Visit, parent_name: it read case_id_new_child_0 from the session, which no menu of this app supplies, so the form could not open. It now reads nothing there, and the form opens. You can set what it should read.",
		);
	});
});

describe("the removed media slot line", () => {
	const SAME: NoticeRenderContext = {
		nameOf: (entity) => entity.nameAtMigration,
	};
	const render = (detail?: Record<string, string>) =>
		renderNoticeEntry(
			migrationNoticeEntrySchema.parse({
				kind: "document",
				reason: "media-slot-removed",
				entity: { ...FIELD_ENTITY, nameAtMigration: "address" },
				...(detail && { detail }),
			}),
			SAME,
		).text;

	it.each([
		["hint", "image", "the image on its hint"],
		["validation-message", "audio", "the audio on its validation message"],
		["group-title", "video", "the video on its group title"],
		["repeat-title", "image", "the image on its repeat title"],
	])("names the %s's %s", (slot, media, says) => {
		expect(render({ form: "Visit", slot, media })).toBe(
			`Visit, address: ${says} was removed. No CommCare app shows media there, so workers see no change. The file is still in your media library.`,
		);
	});

	it("still reads as a sentence with no detail", () => {
		expect(render()).toBe(
			"address: the media on its message was removed. No CommCare app shows media there, so workers see no change. The file is still in your media library.",
		);
	});
});

describe("the hidden value and time comparison lines", () => {
	const SAME: NoticeRenderContext = {
		nameOf: (entity) => entity.nameAtMigration,
	};
	const render = (raw: unknown) => renderNoticeEntry(parsed(raw), SAME).text;
	const field = (nameAtMigration: string) => ({
		...FIELD_ENTITY,
		nameAtMigration,
	});
	const doc = (
		reason: string,
		entity: unknown,
		detail?: Record<string, string>,
	) => ({ kind: "document", reason, entity, ...(detail && { detail }) });

	it("say a hidden value with no value saves its property blank", () => {
		expect(
			render(
				doc("hidden-value-saves-blank", field("status_seed"), {
					form: "Register",
					property: "visit_status",
				}),
			),
		).toBe(
			"Register: status_seed has no value, so each submission saves visit_status blank. This is unchanged; Nova now says so where you set it.",
		);
	});

	it("say a time comparison now reads as never true, on a field, a menu and a case property's rule", () => {
		expect(
			render(
				doc("time-comparison-never-true", field("late"), {
					form: "Visit",
					comparison: "#form/start > '17:00'",
				}),
			),
		).toBe(
			"Visit, late: “#form/start > '17:00'” compares a time of day with before or after, which is never true on a device. It now reads as never true everywhere, Preview included.",
		);
		expect(
			render(
				doc("time-comparison-never-true", MODULE_ENTITY, {
					comparison: "visit_time > 08:00",
				}),
			),
		).toBe(
			"Patients: “visit_time > 08:00” compares a time of day with before or after, which is never true on a device. It now reads as never true everywhere, Preview included.",
		);
		expect(
			render(
				doc("time-comparison-never-true", APP_ENTITY, {
					comparison: "#patient/visit_time > '08:00'",
					caseType: "patient",
					property: "visit_time",
				}),
			),
		).toBe(
			"Clinic visits, the rule of visit_time: “#patient/visit_time > '08:00'” compares a time of day with before or after, which is never true on a device. It now reads as never true everywhere, Preview included.",
		);
	});

	it("say a search term HQ can't run now matches nothing", () => {
		expect(
			render(
				doc("search-term-matches-nothing", MODULE_ENTITY, {
					term: "date_opened is blank",
				}),
			),
		).toBe(
			"Patients: “date_opened is blank” is a check CommCare's search can't run. It now matches nothing, where the search failed before.",
		);
	});
});

describe("the lines about lookup tables", () => {
	it("name a renamed table with both tags and the word that made CommCare read it as its own data", () => {
		const line = renderNoticeEntry(
			parsed(ENTRIES["lookup-tag-renamed"].withDetail),
			REMOVED,
		);
		expect(line.text).toBe(
			"The lookup table Clinics now has the export tag clinic_case_db_codes in place of clinic_casedb_codes. CommCare treats a tag holding \"casedb\" as its own case data, so this app couldn't read the table. Where this app is published, the next publish adds the table under the new tag and leaves the old one in CommCare HQ, since Nova can't rename or remove a table there.",
		);
		expect(
			line.parts.filter((part) => part.kind === "entity").map((p) => p.text),
		).toEqual(["Clinics"]);
		expect(
			renderNoticeEntry(
				parsed({
					kind: "document",
					reason: "lookup-tag-renamed",
					entity: LOOKUP_ENTITY,
					detail: { from: "stock_ledgerdb", to: "stock_ledger_db" },
				}),
				REMOVED,
			).text,
		).toBe(
			"The lookup table Clinics now has the export tag stock_ledger_db in place of stock_ledgerdb. CommCare treats a tag holding \"ledgerdb\" as its own ledger data, so this app couldn't read the table. Where this app is published, the next publish adds the table under the new tag and leaves the old one in CommCare HQ, since Nova can't rename or remove a table there.",
		);
	});

	it("name a table HQ holds content in that Nova can't keep, and what it holds", () => {
		expect(
			renderNoticeEntry(
				parsed(ENTRIES["lookup-table-content-unsupported"].withDetail),
				REMOVED,
			).text,
		).toBe(
			"The table Clinics on field-ops holds field properties, row attributes and rows limited to certain users, which Nova can't keep. The next publish there stops before it sends anything. Giving the table a new export tag in Project data lets Nova publish its own table and leave that one as it is.",
		);
		expect(
			renderNoticeEntry(
				parsed({
					kind: "deployment",
					reason: "lookup-table-content-unsupported",
					deployment: DEPLOYMENT,
					entities: [LOOKUP_ENTITY],
					detail: { holds: "owned-rows" },
				}),
				REMOVED,
			).text,
		).toBe(
			"The table Clinics on field-ops holds rows limited to certain users, which Nova can't keep. The next publish there stops before it sends anything. Giving the table a new export tag in Project data lets Nova publish its own table and leave that one as it is.",
		);
	});
});
