import { describe, expect, it } from "vitest";
import {
	DEPLOYMENT_NOTICE_REASONS,
	DOCUMENT_NOTICE_REASONS,
	MIGRATION_NOTICE_CUTOVERS,
	migrationNoticeCutoverSchema,
	migrationNoticeEntriesSchema,
	migrationNoticeEntrySchema,
	orderNoticeEntries,
} from "../migrationNotice";
import { noticeLead } from "../migrationNoticeCopy";

const DEPLOYMENT_ID = "01992000-0000-7000-8000-000000000011";

/** One real entry per reason, in the stored shape. */
const REAL_ENTRIES = {
	"unsaved-assistant-work-discarded": {
		kind: "document",
		reason: "unsaved-assistant-work-discarded",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
	},
	"ccz-needs-project-space": {
		kind: "document",
		reason: "ccz-needs-project-space",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
	},
	"question-renamed": {
		kind: "document",
		reason: "question-renamed",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e1",
			nameAtMigration: "notes",
		},
		detail: { form: "Intake", kind: "question", from: "_notes", to: "notes" },
	},
	"case-operation-renamed": {
		kind: "document",
		reason: "case-operation-renamed",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Intake",
		},
		detail: { from: "instance", to: "q_instance" },
	},
	"connect-block-renamed": {
		kind: "document",
		reason: "connect-block-renamed",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Intake",
		},
		detail: { block: "task", from: "task", to: "q_task" },
	},
	"connect-task-moved-to-own-form": {
		kind: "document",
		reason: "connect-task-moved-to-own-form",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Intake",
		},
		detail: { task: "follow_up", newForm: "Follow-up task" },
	},
	"entry-point-renamed": {
		kind: "document",
		reason: "entry-point-renamed",
		entity: {
			type: "entryPoint",
			uuid: "01992000-0000-7000-8000-0000000000f1",
			nameAtMigration: "intake",
		},
		detail: { from: "intake_", to: "intake" },
	},
	"option-value-split": {
		kind: "document",
		reason: "option-value-split",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Intake",
		},
		detail: {
			question: "consent",
			value: "yes",
			to: "yes_2",
			keptLabel: "Yes",
			label: "Yes, today",
		},
	},
	"empty-form-label-added": {
		kind: "document",
		reason: "empty-form-label-added",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Intake",
		},
	},
	"session-read-removed": {
		kind: "document",
		reason: "session-read-removed",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e1",
			nameAtMigration: "notes",
		},
		detail: { form: "Intake", datum: "case_id_new" },
	},
	"id-mapping-entry-removed": {
		kind: "document",
		reason: "id-mapping-entry-removed",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: { menu: "Households", value: "a'b" },
	},
	"date-pattern-apostrophe-replaced": {
		kind: "document",
		reason: "date-pattern-apostrophe-replaced",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: { menu: "Households" },
	},
	"tile-order-rule-removed": {
		kind: "document",
		reason: "tile-order-rule-removed",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: { menu: "Households", shape: "calculated" },
	},
	"order-rule-removed-same-property": {
		kind: "document",
		reason: "order-rule-removed-same-property",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: { menu: "Households", kept: "Score" },
	},
	"order-rule-moved-to-first-column": {
		kind: "document",
		reason: "order-rule-moved-to-first-column",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: { menu: "Households", to: "Zone name" },
	},
	"tile-cell-defaults-set": {
		kind: "document",
		reason: "tile-cell-defaults-set",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a1",
			nameAtMigration: "Households",
		},
	},
	"case-list-order-changes": {
		kind: "document",
		reason: "case-list-order-changes",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a1",
			nameAtMigration: "Households",
		},
		detail: { cause: "id-mapping", column: "Zone name", kind: "id-mapping" },
	},
	"case-list-search-matches-hidden-fields": {
		kind: "document",
		reason: "case-list-search-matches-hidden-fields",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a1",
			nameAtMigration: "Households",
		},
	},
	"hidden-order-column-not-in-sort-menu": {
		kind: "document",
		reason: "hidden-order-column-not-in-sort-menu",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: { menu: "Households" },
	},
	"record-id-column-now-shows": {
		kind: "document",
		reason: "record-id-column-now-shows",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: { menu: "Households", kind: "plain" },
	},
	"option-label-filled": {
		kind: "document",
		reason: "option-label-filled",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Intake",
		},
		detail: { question: "Village", value: "north" },
	},
	"android-form-lists-setting-stored": {
		kind: "document",
		reason: "android-form-lists-setting-stored",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
		detail: { saved: "off", incomplete: "on" },
	},
	"lookup-tag-renamed": {
		kind: "document",
		reason: "lookup-tag-renamed",
		entity: {
			type: "lookupTable",
			uuid: "01992000-0000-7000-8000-0000000000c1",
			nameAtMigration: "Clinics",
		},
		detail: { from: "clinic_casedb_codes", to: "clinic_case_db_codes" },
	},
	"validation-now-enforced": {
		kind: "document",
		reason: "validation-now-enforced",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e1",
			nameAtMigration: "card_number",
		},
		detail: { form: "Intake", kind: "barcode" },
	},
	"local-archive-changes": {
		kind: "document",
		reason: "local-archive-changes",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
	},
	"follow-up-now-touches-case": {
		kind: "document",
		reason: "follow-up-now-touches-case",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Review",
		},
	},
	"linked-follow-up-now-writes-case": {
		kind: "document",
		reason: "linked-follow-up-now-writes-case",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Review",
		},
		detail: { source: "Intake" },
	},
	"close-moves-to-save-to-case": {
		kind: "document",
		reason: "close-moves-to-save-to-case",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b2",
			nameAtMigration: "Discharge",
		},
	},
	"case-name-now-checked": {
		kind: "document",
		reason: "case-name-now-checked",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b3",
			nameAtMigration: "Register",
		},
		detail: { question: "Full name" },
	},
	"media-slot-removed": {
		kind: "document",
		reason: "media-slot-removed",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e6",
			nameAtMigration: "address",
		},
		detail: { form: "Visit", slot: "hint", media: "image" },
	},
	"hidden-value-saves-blank": {
		kind: "document",
		reason: "hidden-value-saves-blank",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e5",
			nameAtMigration: "status_seed",
		},
		detail: { form: "Register", property: "visit_status" },
	},
	"search-button-text-changed": {
		kind: "document",
		reason: "search-button-text-changed",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a1",
			nameAtMigration: "Patients",
		},
		detail: { from: "Find a patient" },
	},
	"search-input-renamed": {
		kind: "document",
		reason: "search-input-renamed",
		entity: {
			type: "searchInput",
			uuid: "01992000-0000-7000-8000-0000000000d2",
			nameAtMigration: "_xpath_query_2",
		},
		detail: { menu: "Patients", from: "_xpath_query", to: "_xpath_query_2" },
	},
	"search-input-removed": {
		kind: "document",
		reason: "search-input-removed",
		entity: {
			type: "searchInput",
			uuid: "01992000-0000-7000-8000-0000000000d3",
			nameAtMigration: "include_closed",
		},
		detail: { menu: "Patients", expressions: "2" },
	},
	"time-comparison-never-true": {
		kind: "document",
		reason: "time-comparison-never-true",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e4",
			nameAtMigration: "late",
		},
		detail: { form: "Visit", comparison: "#form/start > '17:00'" },
	},
	"search-term-matches-nothing": {
		kind: "document",
		reason: "search-term-matches-nothing",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a1",
			nameAtMigration: "Patients",
		},
		detail: { term: "date_opened is blank" },
	},
	"hidden-from-menu-set": {
		kind: "document",
		reason: "hidden-from-menu-set",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a2",
			nameAtMigration: "Archive",
		},
	},
	"after-submit-destination-moved": {
		kind: "document",
		reason: "after-submit-destination-moved",
		entity: {
			type: "form",
			uuid: "01992000-0000-7000-8000-0000000000b1",
			nameAtMigration: "Visit",
		},
		detail: {
			from: "previous",
			to: "module",
			cause: "multi-select-menu",
			menu: "Batches",
		},
	},
	"lookup-choices-order-changes": {
		kind: "document",
		reason: "lookup-choices-order-changes",
		entity: {
			type: "searchInput",
			uuid: "01992000-0000-7000-8000-0000000000d1",
			nameAtMigration: "Clinic",
		},
		detail: { menu: "Patients" },
	},
	"survey-menu-takes-case-type": {
		kind: "document",
		reason: "survey-menu-takes-case-type",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a3",
			nameAtMigration: "Surveys",
		},
		detail: { caseType: "household" },
	},
	"setting-changes-at-next-publish": {
		...deploymentEntry("setting-changes-at-next-publish"),
		detail: { setting: "incomplete", readers: "android-and-webapps" },
	},
	"next-publish-asks-more": {
		...deploymentEntry("next-publish-asks-more"),
		detail: {
			planFeatures: "worker-records",
			settings: "flat-location-fixture",
		},
	},
	"commcare-version-below-floor": {
		...deploymentEntry("commcare-version-below-floor"),
		detail: { version: "2.53.0" },
	},
	"logo-upload-in-hq": deploymentEntry("logo-upload-in-hq"),
	"settings-unknown-unreadable": deploymentEntry("settings-unknown-unreadable"),
	"worker-settings-reset-at-next-publish": deploymentEntry(
		"worker-settings-reset-at-next-publish",
	),
	"deep-links-need-republish": deploymentEntry("deep-links-need-republish"),
	"hq-app-deleted": deploymentEntry("hq-app-deleted"),
	"data-paths-move-once": deploymentEntry("data-paths-move-once"),
	"hq-app-not-nova-made": deploymentEntry("hq-app-not-nova-made"),
	"ids-change-once-unreadable": deploymentEntry("ids-change-once-unreadable"),
	"menu-id-changes-once": {
		...deploymentEntry("menu-id-changes-once"),
		entities: [
			{
				type: "module",
				uuid: "01992000-0000-7000-8000-0000000000a1",
				nameAtMigration: "Register",
			},
		],
	},
	"form-ids-change-once": {
		...deploymentEntry("form-ids-change-once"),
		entities: [
			{
				type: "form",
				uuid: "01992000-0000-7000-8000-0000000000b1",
				nameAtMigration: "Visit",
			},
		],
	},
	"next-publish-overwrites-hq-edits": deploymentEntry(
		"next-publish-overwrites-hq-edits",
	),
	"next-publish-asks-before-overwriting": {
		...deploymentEntry("next-publish-asks-before-overwriting"),
		entities: [
			{
				type: "lookupTable",
				uuid: "01992000-0000-7000-8000-0000000000c1",
				nameAtMigration: "Clinics",
			},
		],
	},
	"lookup-table-content-unsupported": {
		...deploymentEntry("lookup-table-content-unsupported"),
		entities: [
			{
				type: "lookupTable",
				uuid: "01992000-0000-7000-8000-0000000000c1",
				nameAtMigration: "Clinics",
			},
		],
		detail: { holds: "field-properties,owned-rows" },
	},
	"case-property-rules-removed": {
		kind: "document",
		reason: "case-property-rules-removed",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
		detail: {
			caseType: "patient",
			property: "age",
			rules: "required,validation",
		},
	},
	"expressions-follow-choices": {
		kind: "document",
		reason: "expressions-follow-choices",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
		detail: { count: "14" },
	},
	"expressions-respelled": {
		kind: "document",
		reason: "expressions-respelled",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
		detail: { count: "3" },
	},
	"case-property-declared": {
		kind: "document",
		reason: "case-property-declared",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
		detail: {
			caseType: "household",
			property: "village_code",
			dataType: "text",
			form: "Visit",
		},
	},
	"repeat-read-takes-first-row": {
		kind: "document",
		reason: "repeat-read-takes-first-row",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e1",
			nameAtMigration: "Summary",
		},
		detail: { form: "Visit", question: "Child name", repeat: "Children" },
	},
	"search-today-is-workers-day": {
		kind: "document",
		reason: "search-today-is-workers-day",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a1",
			nameAtMigration: "Patients",
		},
	},
	"search-date-time-equality-matches": {
		kind: "document",
		reason: "search-date-time-equality-matches",
		entity: {
			type: "module",
			uuid: "01992000-0000-7000-8000-0000000000a1",
			nameAtMigration: "Patients",
		},
	},
	"date-time-comparison-compares-moments": {
		kind: "document",
		reason: "date-time-comparison-compares-moments",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e1",
			nameAtMigration: "Follow-up due",
		},
		detail: { form: "Visit", target: "xform" },
	},
	"case-property-type-now-known": {
		kind: "document",
		reason: "case-property-type-now-known",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
		detail: {
			caseType: "visit",
			property: "next_due",
			dataType: "date",
			parked: "2",
		},
	},
	"expressions-sent-at-next-publish": deploymentEntry(
		"expressions-sent-at-next-publish",
	),
	"platforms-declared": {
		kind: "document",
		reason: "platforms-declared",
		entity: { type: "app", nameAtMigration: "Clinic visits" },
		detail: {
			runsOn: "web-apps",
			causes: "search-first,search-field-single-date",
			split: "1",
		},
	},
	"datetime-question-split": {
		kind: "document",
		reason: "datetime-question-split",
		entity: {
			type: "field",
			uuid: "01992000-0000-7000-8000-0000000000e1",
			nameAtMigration: "Visit time",
		},
		detail: { form: "Visit", date: "visit_time_date", time: "visit_time_time" },
	},
	"media-not-played-removed": {
		kind: "document",
		reason: "media-not-played-removed",
		entity: {
			type: "caseListColumn",
			uuid: "01992000-0000-7000-8000-0000000000c9",
			nameAtMigration: "Zone",
		},
		detail: {
			module: "Patients",
			carrier: "image-map-row",
			row: "north",
			media: "image",
			file: "north.ico",
			cause: "android",
		},
	},
	"next-publish-asks-web-apps": {
		...deploymentEntry("next-publish-asks-web-apps"),
		detail: { to: "off" },
	},
} as const;

function deploymentEntry<const R extends string>(reason: R) {
	return {
		kind: "deployment",
		reason,
		deployment: {
			deploymentId: DEPLOYMENT_ID,
			server: "production",
			domain: "field-ops",
		},
	} as const;
}

describe("migrationNoticeEntrySchema", () => {
	it("accepts each reason's real entry", () => {
		expect(Object.keys(REAL_ENTRIES).sort()).toEqual(
			[...DOCUMENT_NOTICE_REASONS, ...DEPLOYMENT_NOTICE_REASONS].sort(),
		);
		for (const entry of Object.values(REAL_ENTRIES)) {
			expect(migrationNoticeEntrySchema.parse(entry)).toEqual(entry);
		}
	});

	it("refuses a reason it does not list, under either kind", () => {
		expect(
			migrationNoticeEntrySchema.safeParse({
				...REAL_ENTRIES["unsaved-assistant-work-discarded"],
				reason: "something-else",
			}).success,
		).toBe(false);
		expect(
			migrationNoticeEntrySchema.safeParse({
				...REAL_ENTRIES["unsaved-assistant-work-discarded"],
				reason: "deep-links-need-republish",
			}).success,
		).toBe(false);
	});

	it("refuses an extra key on the entry, its entity and its deployment", () => {
		const document = REAL_ENTRIES["unsaved-assistant-work-discarded"];
		const deployment = REAL_ENTRIES["deep-links-need-republish"];
		for (const candidate of [
			{ ...document, note: "x" },
			{ ...document, entity: { ...document.entity, path: "x" } },
			{ ...deployment, deployment: { ...deployment.deployment, appId: "x" } },
		]) {
			expect(migrationNoticeEntrySchema.safeParse(candidate).success).toBe(
				false,
			);
		}
	});

	it("refuses a server outside the catalog and a detail longer than 200 characters", () => {
		const deployment = REAL_ENTRIES["deep-links-need-republish"];
		expect(
			migrationNoticeEntrySchema.safeParse({
				...deployment,
				deployment: { ...deployment.deployment, server: "staging" },
			}).success,
		).toBe(false);
		expect(
			migrationNoticeEntrySchema.safeParse({
				...deployment,
				detail: { why: "x".repeat(201) },
			}).success,
		).toBe(false);
	});

	it("refuses a notice with no entries", () => {
		expect(migrationNoticeEntriesSchema.safeParse([]).success).toBe(false);
	});
});

describe("the cutovers that write notices", () => {
	it("are the emission, the expressions and the platforms cutovers, each with its own lead", () => {
		expect(MIGRATION_NOTICE_CUTOVERS).toEqual([
			"hq-round-trip-emission",
			"hq-round-trip-expressions",
			"hq-round-trip-platforms",
		]);
		expect(migrationNoticeCutoverSchema.safeParse("other").success).toBe(false);
		const day = { locale: "en-GB", timeZone: "UTC" } as const;
		expect(
			noticeLead("hq-round-trip-emission", "2026-10-06T09:00:00.000Z", day),
		).toBe(
			"Nova changed how it writes apps for CommCare HQ on 6 October. Here is what that means for this app.",
		);
		expect(
			noticeLead("hq-round-trip-expressions", "2026-10-21T09:00:00.000Z", day),
		).toBe(
			"Nova changed how it stores and checks expressions on 21 October. Here is what that means for this app.",
		);
		expect(
			noticeLead("hq-round-trip-platforms", "2026-11-02T09:00:00.000Z", day),
		).toBe(
			"On 2 November, Nova started recording where each app runs: in Web Apps, on Android, or both. Here is what that means for this app.",
		);
	});
});

describe("the reasons' order", () => {
	const at = (reason: string) =>
		(DOCUMENT_NOTICE_REASONS as readonly string[]).indexOf(reason);

	it("puts the expressions cutover's step reasons after the emission cutover's, in step order, before lookup-tag-renamed", () => {
		expect(
			DOCUMENT_NOTICE_REASONS.slice(
				at("android-form-lists-setting-stored"),
				at("lookup-tag-renamed") + 1,
			),
		).toEqual([
			"android-form-lists-setting-stored",
			"case-property-rules-removed",
			"expressions-follow-choices",
			"expressions-respelled",
			"case-property-declared",
			"repeat-read-takes-first-row",
			"platforms-declared",
			"datetime-question-split",
			"media-not-played-removed",
			"lookup-tag-renamed",
		]);
	});

	it("puts the platforms cutover's step reasons in step order after the expressions cutover's, and its Web Apps question between the drift check and the confirmations", () => {
		expect(
			DOCUMENT_NOTICE_REASONS.slice(
				at("repeat-read-takes-first-row"),
				at("lookup-tag-renamed") + 1,
			),
		).toEqual([
			"repeat-read-takes-first-row",
			"platforms-declared",
			"datetime-question-split",
			"media-not-played-removed",
			"lookup-tag-renamed",
		]);
		const deployment = DEPLOYMENT_NOTICE_REASONS as readonly string[];
		expect(
			deployment.slice(
				deployment.indexOf("next-publish-asks-before-overwriting"),
				deployment.indexOf("next-publish-asks-more") + 1,
			),
		).toEqual([
			"next-publish-asks-before-overwriting",
			"next-publish-asks-web-apps",
			"next-publish-asks-more",
		]);
	});

	it("puts each reason for a change that writes nothing at its place", () => {
		expect(
			DOCUMENT_NOTICE_REASONS.slice(
				at("case-list-search-matches-hidden-fields"),
				at("hidden-order-column-not-in-sort-menu") + 1,
			),
		).toEqual([
			"case-list-search-matches-hidden-fields",
			"search-today-is-workers-day",
			"search-date-time-equality-matches",
			"hidden-order-column-not-in-sort-menu",
		]);
		expect(
			DOCUMENT_NOTICE_REASONS.slice(
				at("case-name-now-checked"),
				at("unsaved-assistant-work-discarded") + 1,
			),
		).toEqual([
			"case-name-now-checked",
			"date-time-comparison-compares-moments",
			"case-property-type-now-known",
			"unsaved-assistant-work-discarded",
		]);
		const deployment = DEPLOYMENT_NOTICE_REASONS as readonly string[];
		expect(
			deployment.slice(
				deployment.indexOf("data-paths-move-once"),
				deployment.indexOf("deep-links-need-republish") + 1,
			),
		).toEqual([
			"data-paths-move-once",
			"expressions-sent-at-next-publish",
			"deep-links-need-republish",
		]);
	});

	it("orders a notice's real entries by those lists, deployment entries first", () => {
		const entries = migrationNoticeEntriesSchema.parse([
			REAL_ENTRIES["case-property-type-now-known"],
			REAL_ENTRIES["repeat-read-takes-first-row"],
			REAL_ENTRIES["deep-links-need-republish"],
			REAL_ENTRIES["case-property-rules-removed"],
			REAL_ENTRIES["expressions-sent-at-next-publish"],
		]);
		expect(orderNoticeEntries(entries).map((entry) => entry.reason)).toEqual([
			"expressions-sent-at-next-publish",
			"deep-links-need-republish",
			"case-property-rules-removed",
			"repeat-read-takes-first-row",
			"case-property-type-now-known",
		]);
	});

	it("orders a platforms notice's entries: its Web Apps question before the confirmations, its document lines in step order", () => {
		const entries = migrationNoticeEntriesSchema.parse([
			REAL_ENTRIES["media-not-played-removed"],
			REAL_ENTRIES["next-publish-asks-more"],
			REAL_ENTRIES["datetime-question-split"],
			REAL_ENTRIES["deep-links-need-republish"],
			REAL_ENTRIES["next-publish-asks-web-apps"],
			REAL_ENTRIES["platforms-declared"],
		]);
		expect(orderNoticeEntries(entries).map((entry) => entry.reason)).toEqual([
			"deep-links-need-republish",
			"next-publish-asks-web-apps",
			"next-publish-asks-more",
			"platforms-declared",
			"datetime-question-split",
			"media-not-played-removed",
		]);
	});
});
