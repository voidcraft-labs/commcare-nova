import { describe, expect, it } from "vitest";
import {
	DEPLOYMENT_NOTICE_REASONS,
	DOCUMENT_NOTICE_REASONS,
	migrationNoticeEntriesSchema,
	migrationNoticeEntrySchema,
} from "../migrationNotice";

const DEPLOYMENT_ID = "01992000-0000-7000-8000-000000000011";

/** One real entry per reason, as the cutover writes it. */
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
	"setting-changes-at-next-publish": {
		...deploymentEntry("setting-changes-at-next-publish"),
		detail: { setting: "incomplete", readers: "android-and-webapps" },
	},
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
