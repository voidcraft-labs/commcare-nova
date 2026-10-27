import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type AppMigrationNotice,
	migrationNoticeEntrySchema,
	type NoticeEntityRef,
} from "@/lib/notices/migrationNotice";
import type { NoticeRenderContext } from "@/lib/notices/migrationNoticeCopy";
import {
	appNoticeChipLabel,
	noticeDialogSections,
	noticeEntityDestination,
	withoutDismissed,
} from "../appNoticeModel";

const NAMES: NoticeRenderContext = { nameOf: () => null };

function deployment(server: string, domain: string, deploymentId: string) {
	return migrationNoticeEntrySchema.parse({
		kind: "deployment",
		reason: "deep-links-need-republish",
		deployment: { deploymentId, server, domain },
	});
}

function documentEntry(name: string) {
	return migrationNoticeEntrySchema.parse({
		kind: "document",
		reason: "unsaved-assistant-work-discarded",
		entity: { type: "app", nameAtMigration: name },
	});
}

function notice(
	id: string,
	entries: AppMigrationNotice["entries"],
): AppMigrationNotice {
	return {
		id,
		cutover: "hq-round-trip-emission",
		createdAt: "2026-10-06T09:00:00.000Z",
		entries,
	};
}

describe("noticeDialogSections", () => {
	it("puts deployment entries first, by server then domain, then document entries", () => {
		const [section] = noticeDialogSections(
			[
				notice("n1", [
					documentEntry("first"),
					deployment("eu", "alpha", "01992000-0000-7000-8000-000000000001"),
					deployment(
						"production",
						"zeta",
						"01992000-0000-7000-8000-000000000002",
					),
					documentEntry("second"),
					deployment(
						"production",
						"beta",
						"01992000-0000-7000-8000-000000000003",
					),
				]),
			],
			NAMES,
		);
		expect(
			section?.groups.map((group) =>
				group.kind === "deployment" ? group.heading : group.reason,
			),
		).toEqual([
			"At the next publish to beta",
			"At the next publish to zeta",
			"At the next publish to alpha",
			"unsaved-assistant-work-discarded",
		]);
		expect(section?.groups.at(-1)?.lines).toHaveLength(2);
	});

	it("keeps two project spaces of one name on two servers apart", () => {
		const [section] = noticeDialogSections(
			[
				notice("n1", [
					deployment(
						"india",
						"field-ops",
						"01992000-0000-7000-8000-000000000001",
					),
					deployment(
						"production",
						"field-ops",
						"01992000-0000-7000-8000-000000000002",
					),
				]),
			],
			NAMES,
		);
		expect(section?.groups).toHaveLength(2);
	});

	it("groups both cutovers' notices, each in its own section with its own lines in order", () => {
		const expressions: AppMigrationNotice = {
			id: "expressions",
			cutover: "hq-round-trip-expressions",
			createdAt: "2026-10-21T09:00:00.000Z",
			entries: [
				migrationNoticeEntrySchema.parse({
					kind: "document",
					reason: "case-property-type-now-known",
					entity: { type: "app", nameAtMigration: "Clinic visits" },
					detail: { caseType: "visit", property: "next_due", dataType: "date" },
				}),
				migrationNoticeEntrySchema.parse({
					kind: "deployment",
					reason: "expressions-sent-at-next-publish",
					deployment: {
						deploymentId: "01992000-0000-7000-8000-000000000001",
						server: "production",
						domain: "field-ops",
					},
				}),
				migrationNoticeEntrySchema.parse({
					kind: "document",
					reason: "expressions-respelled",
					entity: { type: "app", nameAtMigration: "Clinic visits" },
					detail: { count: "2" },
				}),
				migrationNoticeEntrySchema.parse({
					kind: "document",
					reason: "case-property-rules-removed",
					entity: { type: "app", nameAtMigration: "Clinic visits" },
					detail: { caseType: "patient", property: "age", rules: "required" },
				}),
				migrationNoticeEntrySchema.parse({
					kind: "document",
					reason: "case-property-rules-removed",
					entity: { type: "app", nameAtMigration: "Clinic visits" },
					detail: {
						caseType: "patient",
						property: "weight",
						rules: "validation",
					},
				}),
				deployment(
					"production",
					"field-ops",
					"01992000-0000-7000-8000-000000000001",
				),
			],
		};
		const sections = noticeDialogSections(
			[expressions, notice("emission", [documentEntry("a")])],
			NAMES,
		);
		expect(
			sections.map((section) => [section.noticeId, section.cutover]),
		).toEqual([
			["expressions", "hq-round-trip-expressions"],
			["emission", "hq-round-trip-emission"],
		]);
		const [first, second] = sections;
		expect(
			first?.groups.map((group) =>
				group.kind === "deployment" ? group.heading : group.reason,
			),
		).toEqual([
			"At the next publish to field-ops",
			"case-property-rules-removed",
			"expressions-respelled",
			"case-property-type-now-known",
		]);
		expect(first?.groups[0]?.lines.map((line) => line.text)).toEqual([
			"The next publish to field-ops sends these expression changes once, so CommCare HQ keeps a new version of each form and menu they touch. Data already collected stays as it is.",
			"Links to field-ops that you already shared keep working. New ones are ready after the next publish there.",
		]);
		expect(
			first?.groups[1]?.lines.map((line) => line.text.split(":")[0]),
		).toEqual(["patient, age", "patient, weight"]);
		expect(
			second?.groups.map((group) =>
				group.kind === "deployment" ? group.heading : group.reason,
			),
		).toEqual(["unsaved-assistant-work-discarded"]);
	});

	it("groups three cutovers' notices, the platforms notice's Web Apps question before its confirmations and its lines in step order", () => {
		const field = "01992000-0000-7000-8000-0000000000e1";
		const fieldOps = {
			deploymentId: "01992000-0000-7000-8000-000000000001",
			server: "production",
			domain: "field-ops",
		} as const;
		const platforms: AppMigrationNotice = {
			id: "platforms",
			cutover: "hq-round-trip-platforms",
			createdAt: "2026-11-02T09:00:00.000Z",
			entries: [
				migrationNoticeEntrySchema.parse({
					kind: "document",
					reason: "datetime-question-split",
					entity: { type: "field", uuid: field, nameAtMigration: "Visit time" },
					detail: {
						form: "Visit",
						date: "visit_time_date",
						time: "visit_time_time",
					},
				}),
				migrationNoticeEntrySchema.parse({
					kind: "deployment",
					reason: "next-publish-asks-more",
					deployment: fieldOps,
					detail: { planFeatures: "web-apps" },
				}),
				migrationNoticeEntrySchema.parse({
					kind: "document",
					reason: "platforms-declared",
					entity: { type: "app", nameAtMigration: "Clinic visits" },
					detail: { runsOn: "web-apps", causes: "search-first", split: "1" },
				}),
				migrationNoticeEntrySchema.parse({
					kind: "deployment",
					reason: "next-publish-asks-web-apps",
					deployment: fieldOps,
					detail: { to: "on" },
				}),
			],
		};
		const expressions: AppMigrationNotice = {
			id: "expressions",
			cutover: "hq-round-trip-expressions",
			createdAt: "2026-10-21T09:00:00.000Z",
			entries: [
				migrationNoticeEntrySchema.parse({
					kind: "document",
					reason: "expressions-respelled",
					entity: { type: "app", nameAtMigration: "Clinic visits" },
					detail: { count: "2" },
				}),
			],
		};
		const sections = noticeDialogSections(
			[platforms, expressions, notice("emission", [documentEntry("a")])],
			NAMES,
		);
		expect(
			sections.map((section) => [section.noticeId, section.cutover]),
		).toEqual([
			["platforms", "hq-round-trip-platforms"],
			["expressions", "hq-round-trip-expressions"],
			["emission", "hq-round-trip-emission"],
		]);
		const [first] = sections;
		expect(
			first?.groups.map((group) =>
				group.kind === "deployment" ? group.heading : group.reason,
			),
		).toEqual([
			"At the next publish to field-ops",
			"platforms-declared",
			"datetime-question-split",
		]);
		expect(first?.groups[0]?.lines.map((line) => line.text)).toEqual([
			"This app runs in Web Apps, and its Web App setting on field-ops is off. The next publish there asks you before turning it on, so workers there can open it in Web Apps from the next version Web Apps serves.",
			"The next publish to field-ops asks you to confirm what the project space has: Web-Based Apps (CloudCare).",
		]);
	});

	it("gives one section per notice, in the order the store returns them", () => {
		const sections = noticeDialogSections(
			[
				notice("newer", [documentEntry("a")]),
				notice("older", [documentEntry("b")]),
			],
			NAMES,
		);
		expect(sections.map((section) => section.noticeId)).toEqual([
			"newer",
			"older",
		]);
	});
});

describe("the chip and dismissal", () => {
	it("counts undismissed notices and says nothing with none", () => {
		const notices = [
			notice("a", [documentEntry("a")]),
			notice("b", [documentEntry("b")]),
		];
		expect(appNoticeChipLabel(notices)).toBe("2 updates to review");
		expect(appNoticeChipLabel(withoutDismissed(notices, ["a"]))).toBe(
			"1 update to review",
		);
		expect(
			appNoticeChipLabel(withoutDismissed(notices, ["a", "b"])),
		).toBeNull();
	});

	it("keeps this member's dismissals over a later server read that adds a notice", () => {
		const dismissed = ["a"];
		const first = [notice("a", [documentEntry("a")])];
		expect(withoutDismissed(first, dismissed)).toEqual([]);

		const later = [
			notice("c", [documentEntry("c")]),
			notice("a", [documentEntry("a")]),
		];
		expect(withoutDismissed(later, dismissed).map((shown) => shown.id)).toEqual(
			["c"],
		);
		expect(appNoticeChipLabel(withoutDismissed(later, dismissed))).toBe(
			"1 update to review",
		);
	});
});

describe("noticeEntityDestination", () => {
	const doc = buildDoc({
		appName: "Clinic visits",
		modules: [
			{
				name: "Patients",
				forms: [
					{
						name: "Register",
						type: "survey",
						fields: [f({ id: "full_name", kind: "text", label: "Full name" })],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = moduleUuid ? doc.formOrder[moduleUuid]?.[0] : undefined;
	const fieldUuid = formUuid ? doc.fieldOrder[formUuid]?.[0] : undefined;
	const ref = (type: NoticeEntityRef["type"], uuid?: string) =>
		({ type, uuid, nameAtMigration: "x" }) as NoticeEntityRef;

	it("opens a module, a form and a field where they are", () => {
		expect(noticeEntityDestination(doc, ref("module", moduleUuid))).toEqual({
			kind: "module",
			moduleUuid,
		});
		expect(noticeEntityDestination(doc, ref("form", formUuid))).toEqual({
			kind: "form",
			moduleUuid,
			formUuid,
		});
		expect(noticeEntityDestination(doc, ref("field", fieldUuid))).toEqual({
			kind: "form",
			moduleUuid,
			formUuid,
			fieldUuid,
		});
	});

	it("opens nothing for the app itself or an entity that is gone", () => {
		expect(noticeEntityDestination(doc, ref("app"))).toBeNull();
		expect(
			noticeEntityDestination(
				doc,
				ref("form", "01992000-0000-7000-8000-0000000000ff"),
			),
		).toBeNull();
	});
});
