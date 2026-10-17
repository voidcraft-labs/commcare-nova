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
	"deep-links-need-republish": {
		kind: "deployment",
		reason: "deep-links-need-republish",
		deployment: {
			deploymentId: DEPLOYMENT_ID,
			server: "production",
			domain: "field-ops",
		},
	},
} as const;

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
