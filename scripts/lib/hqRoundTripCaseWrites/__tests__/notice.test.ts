/**
 * The case-writes cutover's notice entries: each builder's entry is one the
 * row's schema accepts and its reason's renderer reads by the keys the
 * builder spells, a long name is cut in `nameAtMigration` and left out of
 * `detail`, and `entriesForApp` collects one app's lines as the writer
 * stores them.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain/uuid";
import {
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
	NOTICE_TEXT_MAX,
} from "@/lib/notices/migrationNotice";
import { renderNoticeEntry } from "@/lib/notices/migrationNoticeCopy";
import {
	afterSubmitDestinationDropped,
	captureSavesLink,
	caseAttachmentsStop,
	deepLinksNeedRepublish,
	entriesForApp,
	formBecameCloseForm,
	formDataPathsMove,
	formLinkDatumsDropped,
	formLinkGoesToMenu,
	formLinkOtherwiseSet,
	formLinkRemoved,
	formLinksConditionsWritten,
	formLinkTargetMoved,
	groupShowsOnePerScreen,
	loadTimeValueReadsCase,
	menuOpensOnSearch,
	moduleMadeAdvanced,
	nextPublishAsksMore,
	noticeText,
	placementsKeptUnread,
	repeatCountNodeRemoved,
	repeatCountWholeNumber,
	repeatRowsFollowQuery,
	startingValueReadsCase,
} from "../notice";

const module = {
	uuid: asUuid("00000000-0000-4000-8000-000000000001"),
	name: "Households",
};
const otherModule = {
	uuid: asUuid("00000000-0000-4000-8000-000000000002"),
	name: "Visits",
};
const form = {
	uuid: asUuid("00000000-0000-4000-8000-000000000003"),
	name: "Register household",
};
const field = {
	uuid: asUuid("00000000-0000-4000-8000-000000000004"),
	name: "household_photo",
};
const deployment = {
	deploymentId: "00000000-0000-4000-8000-000000000005",
	server: "production" as const,
	domain: "demo-space",
};

/** The line a member reads, with every entity gone from the document, so it
 *  names each by `nameAtMigration`. */
function rendered(entry: MigrationNoticeEntry): string {
	return renderNoticeEntry(entry, { nameOf: () => null }).text;
}

function parsed(entry: MigrationNoticeEntry): MigrationNoticeEntry {
	const [only] = migrationNoticeEntriesSchema.parse([entry]);
	return only as MigrationNoticeEntry;
}

describe("document lines", () => {
	const cases: readonly {
		readonly name: string;
		readonly entry: MigrationNoticeEntry;
		readonly expected: MigrationNoticeEntry;
		readonly reads: readonly string[];
	}[] = [
		{
			name: "capture-saves-link",
			entry: captureSavesLink(field, { form: form.name, property: "photo" }),
			expected: {
				kind: "document",
				reason: "capture-saves-link",
				entity: {
					type: "field",
					uuid: field.uuid,
					nameAtMigration: field.name,
				},
				detail: { form: form.name, property: "photo" },
			},
			reads: [form.name, field.name, "in photo"],
		},
		{
			name: "form-became-close-form",
			entry: formBecameCloseForm(form),
			expected: {
				kind: "document",
				reason: "form-became-close-form",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
			},
			reads: [`${form.name} is now a close form`],
		},
		{
			name: "form-links-conditions-written",
			entry: formLinksConditionsWritten(form, 2),
			expected: {
				kind: "document",
				reason: "form-links-conditions-written",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { links: "2" },
			},
			reads: ["2 of its after-submit destinations"],
		},
		{
			name: "form-link-otherwise-set, a named destination",
			entry: formLinkOtherwiseSet(form, { to: "Visits" }),
			expected: {
				kind: "document",
				reason: "form-link-otherwise-set",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { to: "Visits" },
			},
			reads: ["workers now go to Visits"],
		},
		{
			name: "form-link-otherwise-set, a built-in place it replaced",
			entry: formLinkOtherwiseSet(form, {
				toDestination: "module",
				from: "previous",
			}),
			expected: {
				kind: "document",
				reason: "form-link-otherwise-set",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { toDestination: "module", from: "previous" },
			},
			reads: ["this form's menu", "the screen before the form"],
		},
		{
			name: "after-submit-destination-dropped",
			entry: afterSubmitDestinationDropped(form),
			expected: {
				kind: "document",
				reason: "after-submit-destination-dropped",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
			},
			reads: ["its After submit setting never ran"],
		},
		{
			name: "form-link-target-moved",
			entry: formLinkTargetMoved(form, { from: "Follow up", to: "Visits" }),
			expected: {
				kind: "document",
				reason: "form-link-target-moved",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { from: "Follow up", to: "Visits" },
			},
			reads: ["its destination Follow up now opens Visits, which holds it"],
		},
		{
			name: "form-link-target-moved, carried-not-a-case",
			entry: formLinkTargetMoved(form, {
				from: "Follow up",
				to: "Visits",
				cause: "carried-not-a-case",
			}),
			expected: {
				kind: "document",
				reason: "form-link-target-moved",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: {
					from: "Follow up",
					to: "Visits",
					cause: "carried-not-a-case",
				},
			},
			reads: ["isn't a case Follow up can open"],
		},
		{
			name: "form-link-removed",
			entry: formLinkRemoved(form, "Referrals"),
			expected: {
				kind: "document",
				reason: "form-link-removed",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { to: "Referrals" },
			},
			reads: ["its destination Referrals is gone"],
		},
		{
			name: "form-link-datums-dropped",
			entry: formLinkDatumsDropped(form, "Visits"),
			expected: {
				kind: "document",
				reason: "form-link-datums-dropped",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { to: "Visits" },
			},
			reads: ["its destination Visits no longer carries cases"],
		},
		{
			name: "module-made-advanced",
			entry: moduleMadeAdvanced(module, "household"),
			expected: {
				kind: "document",
				reason: "module-made-advanced",
				entity: {
					type: "module",
					uuid: module.uuid,
					nameAtMigration: module.name,
				},
				detail: { caseType: "household" },
			},
			reads: ["Households' forms now create each new household case"],
		},
		{
			name: "form-link-goes-to-menu",
			entry: formLinkGoesToMenu(form, { to: "Visits", caseType: "visit" }),
			expected: {
				kind: "document",
				reason: "form-link-goes-to-menu",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { to: "Visits", caseType: "visit" },
			},
			reads: ["workers now go to Visits and choose the new visit case there"],
		},
		{
			name: "form-link-goes-to-menu, the app home",
			entry: formLinkGoesToMenu(form, { caseType: "visit" }),
			expected: {
				kind: "document",
				reason: "form-link-goes-to-menu",
				entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
				detail: { caseType: "visit" },
			},
			reads: ["workers now go to the app home and open the new visit case"],
		},
		{
			name: "starting-value-reads-case",
			entry: startingValueReadsCase(field, {
				form: form.name,
				property: "age",
			}),
			expected: {
				kind: "document",
				reason: "starting-value-reads-case",
				entity: {
					type: "field",
					uuid: field.uuid,
					nameAtMigration: field.name,
				},
				detail: { form: form.name, property: "age" },
			},
			reads: [form.name, "now reads the case's age"],
		},
		{
			name: "load-time-value-reads-case",
			entry: loadTimeValueReadsCase(field, { form: form.name, reads: "age" }),
			expected: {
				kind: "document",
				reason: "load-time-value-reads-case",
				entity: {
					type: "field",
					uuid: field.uuid,
					nameAtMigration: field.name,
				},
				detail: { form: form.name, reads: "age" },
			},
			reads: ["it now reads age after age takes the case's value"],
		},
		{
			name: "menu-opens-on-search",
			entry: menuOpensOnSearch(module, "results"),
			expected: {
				kind: "document",
				reason: "menu-opens-on-search",
				entity: {
					type: "module",
					uuid: module.uuid,
					nameAtMigration: module.name,
				},
				detail: { opensOn: "results" },
			},
			reads: ["now opens on the cases its search finds"],
		},
		{
			name: "repeat-rows-follow-query",
			entry: repeatRowsFollowQuery(field, form.name),
			expected: {
				kind: "document",
				reason: "repeat-rows-follow-query",
				entity: {
					type: "field",
					uuid: field.uuid,
					nameAtMigration: field.name,
				},
				detail: { form: form.name },
			},
			reads: [form.name, "its rows now follow its query"],
		},
		{
			name: "repeat-count-whole-number",
			entry: repeatCountWholeNumber(field, form.name),
			expected: {
				kind: "document",
				reason: "repeat-count-whole-number",
				entity: {
					type: "field",
					uuid: field.uuid,
					nameAtMigration: field.name,
				},
				detail: { form: form.name },
			},
			reads: [form.name, "int(...)"],
		},
		{
			name: "repeat-count-node-removed",
			entry: repeatCountNodeRemoved(field, {
				form: form.name,
				hidden: "member_count",
			}),
			expected: {
				kind: "document",
				reason: "repeat-count-node-removed",
				entity: {
					type: "field",
					uuid: field.uuid,
					nameAtMigration: field.name,
				},
				detail: { form: form.name, hidden: "member_count" },
			},
			reads: ["straight from member_count"],
		},
		{
			name: "group-shows-one-per-screen",
			entry: groupShowsOnePerScreen(field, form.name),
			expected: {
				kind: "document",
				reason: "group-shows-one-per-screen",
				entity: {
					type: "field",
					uuid: field.uuid,
					nameAtMigration: field.name,
				},
				detail: { form: form.name },
			},
			reads: [form.name, "one per screen"],
		},
	];

	it.each(cases)(
		"$name: the schema accepts it and its renderer reads it",
		({ entry, expected, reads }) => {
			expect(parsed(entry)).toEqual(expected);
			const line = rendered(entry);
			for (const words of reads) expect(line).toContain(words);
		},
	);
});

describe("deployment lines", () => {
	const ref = {
		deploymentId: deployment.deploymentId,
		server: deployment.server,
		domain: deployment.domain,
	};

	it("deep-links-need-republish and placements-kept-unread carry no detail", () => {
		expect(parsed(deepLinksNeedRepublish(deployment))).toEqual({
			kind: "deployment",
			reason: "deep-links-need-republish",
			deployment: ref,
		});
		const kept = placementsKeptUnread(deployment);
		expect(parsed(kept)).toEqual({
			kind: "deployment",
			reason: "placements-kept-unread",
			deployment: ref,
		});
		expect(rendered(kept)).toContain(
			"Nova couldn't read the app demo-space last received",
		);
	});

	it("form-data-paths-move counts the forms and lists each cause once in the registry's order", () => {
		const entry = formDataPathsMove(deployment, {
			forms: 3,
			causes: ["own-close-moved", "module-made-advanced", "own-close-moved"],
		});
		expect(parsed(entry)).toEqual({
			kind: "deployment",
			reason: "form-data-paths-move",
			deployment: ref,
			detail: { forms: "3", causes: "module-made-advanced,own-close-moved" },
		});
		expect(rendered(entry)).toContain("moves where 3 forms of this app save");
		expect(rendered(entry)).toContain("as an advanced menu from then on");
	});

	it("case-attachments-stop counts the properties", () => {
		expect(parsed(caseAttachmentsStop(deployment, 2))).toEqual({
			kind: "deployment",
			reason: "case-attachments-stop",
			deployment: ref,
			detail: { properties: "2" },
		});
	});

	it("next-publish-asks-more names CommCare Supply, same-type links and plan features, or nothing", () => {
		const entry = nextPublishAsksMore(deployment, {
			commtrackOff: true,
			sameTypeChildLinks: true,
			planFeatures: ["advanced-case-actions", "child-cases"],
		});
		expect(entry).not.toBeNull();
		if (entry === null) return;
		expect(parsed(entry)).toEqual({
			kind: "deployment",
			reason: "next-publish-asks-more",
			deployment: ref,
			detail: {
				planFeatures: "child-cases,advanced-case-actions",
				settings: "commtrack-off",
				capabilities: "same-type-child-links",
			},
		});
		const line = rendered(entry);
		expect(line).toContain("CommCare Supply turned off");
		expect(line).toContain("Links between cases of the same type");
		expect(nextPublishAsksMore(deployment, {})).toBeNull();
		expect(
			nextPublishAsksMore(deployment, {
				commtrackOff: false,
				sameTypeChildLinks: false,
				planFeatures: [],
			}),
		).toBeNull();
	});
});

describe("a name longer than an entry keeps", () => {
	const long = "x".repeat(NOTICE_TEXT_MAX + 1);

	it("is cut in nameAtMigration and left out of detail", () => {
		const entry = startingValueReadsCase(
			{ uuid: field.uuid, name: long },
			{ form: long, property: "age" },
		);
		expect(parsed(entry)).toEqual({
			kind: "document",
			reason: "starting-value-reads-case",
			entity: {
				type: "field",
				uuid: field.uuid,
				nameAtMigration: "x".repeat(NOTICE_TEXT_MAX),
			},
			detail: { property: "age" },
		});
	});

	it("leaves no detail at all where every value is a long name", () => {
		const entry = formLinkRemoved(form, long);
		expect(parsed(entry)).toEqual({
			kind: "document",
			reason: "form-link-removed",
			entity: { type: "form", uuid: form.uuid, nameAtMigration: form.name },
		});
		expect(rendered(entry)).toContain("one of its destinations is gone");
	});

	it("keeps a name of exactly the length an entry keeps", () => {
		const exact = "y".repeat(NOTICE_TEXT_MAX);
		expect(parsed(formLinkDatumsDropped(form, exact))).toMatchObject({
			detail: { to: exact },
		});
	});

	it("is cut between code points, a lone surrogate replaced", () => {
		const astral = "😀".repeat(NOTICE_TEXT_MAX);
		const cut = noticeText(astral);
		expect(cut.length).toBe(NOTICE_TEXT_MAX);
		expect(cut).toBe("😀".repeat(NOTICE_TEXT_MAX / 2));
		expect(noticeText("a\uD800b")).toBe("a�b");
		expect(noticeText(undefined)).toBe("");
	});
});

describe("entriesForApp", () => {
	const app = { appName: "Household survey" };

	it("stores deployment lines, then document lines, then the discarded-work line", () => {
		const deep = deepLinksNeedRepublish(deployment);
		const closed = formBecameCloseForm(form);
		const entries = entriesForApp({
			...app,
			deployments: [deep],
			documents: [closed],
			discardsPrivateWork: true,
		});
		expect(entries).toEqual([
			deep,
			closed,
			{
				kind: "document",
				reason: "unsaved-assistant-work-discarded",
				entity: { type: "app", nameAtMigration: app.appName },
			},
		]);
		expect(migrationNoticeEntriesSchema.safeParse(entries).success).toBe(true);
	});

	it("writes unsaved-assistant-work-discarded exactly when private work was discarded", () => {
		const discarded = (flag: boolean) =>
			entriesForApp({
				...app,
				deployments: [],
				documents: [formBecameCloseForm(form)],
				discardsPrivateWork: flag,
			}).filter((entry) => entry.reason === "unsaved-assistant-work-discarded");
		expect(discarded(true)).toHaveLength(1);
		expect(discarded(false)).toHaveLength(0);
		expect(
			entriesForApp({
				...app,
				deployments: [],
				documents: [],
				discardsPrivateWork: true,
			}),
		).toHaveLength(1);
	});

	it("refuses a step's own discarded-work line", () => {
		expect(() =>
			entriesForApp({
				...app,
				deployments: [],
				documents: [
					{
						kind: "document",
						reason: "unsaved-assistant-work-discarded",
						entity: { type: "app", nameAtMigration: app.appName },
					},
				],
				discardsPrivateWork: false,
			}),
		).toThrow(/discardsPrivateWork/);
	});

	it("keeps one module-made-advanced per module and one of each repeated line", () => {
		const entries = entriesForApp({
			...app,
			deployments: [
				deepLinksNeedRepublish(deployment),
				deepLinksNeedRepublish(deployment),
			],
			documents: [
				moduleMadeAdvanced(module, "household"),
				moduleMadeAdvanced(module, "member"),
				moduleMadeAdvanced(otherModule, "visit"),
				formBecameCloseForm(form),
				formBecameCloseForm(form),
			],
			discardsPrivateWork: false,
		});
		expect(entries.map((entry) => entry.reason)).toEqual([
			"deep-links-need-republish",
			"module-made-advanced",
			"module-made-advanced",
			"form-became-close-form",
		]);
		expect(entries[1]).toMatchObject({
			entity: { uuid: module.uuid },
			detail: { caseType: "household" },
		});
		expect(entries[2]).toMatchObject({ entity: { uuid: otherModule.uuid } });
	});

	it("is empty where the app gets no notice row", () => {
		expect(
			entriesForApp({
				...app,
				deployments: [],
				documents: [],
				discardsPrivateWork: false,
			}),
		).toEqual([]);
	});
});
