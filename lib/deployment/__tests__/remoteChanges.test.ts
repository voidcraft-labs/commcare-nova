/**
 * The drift verdict and every sentence a change becomes. Pure.
 *
 * The plausible failures: a sentence that says "last published" of an app
 * Nova brought in and never published, a brought-in date in the server's
 * day rather than the reader's, a reference read off the baseline's
 * `observedAt`, which a refresh moves, where the app was brought in, an
 * origin or a reference kind that reaches no sentence, and an em dash or an
 * ellipsis in a string a person reads.
 */
import { describe, expect, it } from "vitest";
import type {
	DriftDateOptions,
	DriftReference,
} from "@/lib/publish/driftReference";
import * as driftReferenceModule from "@/lib/publish/driftReference";
import * as hqAppClaimsModule from "@/lib/publish/hqAppClaims";
import { hqChangedBringInMessage } from "@/lib/publish/hqChangesCopy";
import { adoptionRecordedFeaturesLine } from "@/lib/publish/planFeatures";
import * as stopPublishingModule from "@/lib/publish/stopPublishing";
import {
	type WebAppsChange,
	webAppsChangeMessage,
} from "@/lib/publish/webApps";
import * as appRemoteChangeModule from "../appRemoteChange";
import { appRemoteChange } from "../appRemoteChange";
import {
	hqDiscardDigest,
	normalizeHqAppSource,
	removedHqFiles,
} from "../hqSourceBaseline";
import * as remoteChangesModule from "../remoteChanges";
import {
	BASELINE_UNKNOWN_SENTENCE,
	baselineUnknownSentence,
	boundedParts,
	decideRemoteChanges,
	describeAppChange,
	describeLookupChange,
	describePlaceChange,
	driftReferenceOf,
	HQ_CHANGED_MESSAGE,
	HQ_CHANGES_CONFIRMED_DETAIL,
	HQ_CHANGES_NONE_DETAIL,
	hqChangedMessage,
	hqChangesConfirmedDetail,
	hqChangesNoneDetail,
} from "../remoteChanges";
import type { AppBaseline, DeploymentRemoteChange } from "../types";

function change(
	novaResourceId: string,
	observedDigest: string,
	overrides: Partial<DeploymentRemoteChange> = {},
): DeploymentRemoteChange {
	return {
		kind: "lookup-table",
		novaResourceId,
		name: novaResourceId,
		identity: novaResourceId,
		parts: ["Its rows changed in CommCare HQ."],
		note: null,
		observedDigest,
		baselineKnown: true,
		since: { kind: "published" },
		canBringIn: false,
		...overrides,
	};
}

describe("decideRemoteChanges", () => {
	const districts = change("districts", "a".repeat(64));
	const app = change("app", "b".repeat(64), {
		kind: "app",
		parts: [],
		baselineKnown: false,
	});

	it("proceeds when nothing differs, whatever discards it is given", () => {
		expect(decideRemoteChanges({ observed: [], discards: [] })).toEqual({
			proceed: true,
			confirmed: [],
		});
		expect(
			decideRemoteChanges({
				observed: [],
				discards: [
					{
						kind: "app",
						novaResourceId: "app",
						observedDigest: "b".repeat(64),
					},
				],
			}),
		).toEqual({ proceed: true, confirmed: [] });
	});

	it("refuses a change nobody confirmed, an unread baseline included", () => {
		expect(
			decideRemoteChanges({ observed: [districts, app], discards: [] }),
		).toEqual({ proceed: false, remoteChanges: [districts, app] });
	});

	it("proceeds only when every change is confirmed for the digest shown", () => {
		const confirmDistricts = {
			kind: "lookup-table" as const,
			novaResourceId: "districts",
			observedDigest: "a".repeat(64),
		};
		expect(
			decideRemoteChanges({
				observed: [districts],
				discards: [confirmDistricts],
			}),
		).toEqual({ proceed: true, confirmed: [districts] });
		/* One of several still unconfirmed stops all of them. */
		expect(
			decideRemoteChanges({
				observed: [districts, app],
				discards: [confirmDistricts],
			}),
		).toEqual({ proceed: false, remoteChanges: [districts, app] });
	});

	it("refuses a discard of an older digest, listing the change with the one HQ holds now", () => {
		expect(
			decideRemoteChanges({
				observed: [districts],
				discards: [
					{
						kind: "lookup-table",
						novaResourceId: "districts",
						observedDigest: "c".repeat(64),
					},
				],
			}),
		).toEqual({ proceed: false, remoteChanges: [districts] });
		/* The same id under another kind is another resource. */
		expect(
			decideRemoteChanges({
				observed: [districts],
				discards: [
					{
						kind: "location",
						novaResourceId: "districts",
						observedDigest: "a".repeat(64),
					},
				],
			}),
		).toEqual({ proceed: false, remoteChanges: [districts] });
	});
});

describe("the sentences", () => {
	it("says each app part", () => {
		expect(
			describeAppChange({
				kind: "form",
				menu: 0,
				form: 1,
				name: "Register",
				menuName: "Patients",
			}),
		).toBe("The form “Register” in the menu “Patients”");
		expect(describeAppChange({ kind: "menu", menu: 0, name: "Patients" })).toBe(
			"The menu “Patients”",
		);
		expect(describeAppChange({ kind: "menu-list" })).toBe("The list of menus");
		expect(describeAppChange({ kind: "name" })).toBe("The app's name");
		expect(describeAppChange({ kind: "languages" })).toBe(
			"The app's languages",
		);
		expect(describeAppChange({ kind: "settings" })).toBe(
			"A setting this app writes",
		);
		expect(describeAppChange({ kind: "text" })).toBe("Text this app writes");
		expect(describeAppChange({ kind: "media", count: 1 })).toBe(
			"A picture or sound this app publishes",
		);
		expect(describeAppChange({ kind: "media", count: 3 })).toBe(
			"3 pictures or sounds this app publishes",
		);
	});

	it("says each table part", () => {
		expect(describeLookupChange({ kind: "definition" }, "districts")).toBe(
			"Its columns changed in CommCare HQ.",
		);
		expect(describeLookupChange({ kind: "rows" }, "districts")).toBe(
			"Its rows changed in CommCare HQ.",
		);
		expect(describeLookupChange({ kind: "deleted" }, "districts")).toBe(
			"CommCare HQ no longer has this table. Publishing makes it again.",
		);
		expect(
			describeLookupChange({ kind: "renamed", tag: "areas" }, "districts"),
		).toBe(
			"This table now has the tag “areas” in CommCare HQ. Publishing makes a new table under “districts” and leaves that one where it is.",
		);
	});

	it("says each place part", () => {
		expect(describePlaceChange({ kind: "name" })).toBe("Its name changed.");
		expect(describePlaceChange({ kind: "site-code" })).toBe(
			"Its site code changed.",
		);
		expect(describePlaceChange({ kind: "level" })).toBe("Its level changed.");
		expect(describePlaceChange({ kind: "parent" })).toBe(
			"It moved under another place.",
		);
		expect(describePlaceChange({ kind: "coordinates" })).toBe(
			"Its coordinates changed.",
		);
		expect(describePlaceChange({ kind: "information" })).toBe(
			"Its place information changed.",
		);
		expect(describePlaceChange({ kind: "missing" })).toBe(
			"CommCare HQ no longer lists this place. It was archived or deleted there. Publishing makes it again if it was deleted. If it was archived, CommCare HQ refuses the publish while the place stays archived there.",
		);
	});

	it("keeps 20 lines whole and counts the rest past them", () => {
		const lines = (count: number) =>
			Array.from({ length: count }, (_, index) => `Line ${index + 1}`);
		expect(boundedParts(lines(20))).toEqual(lines(20));
		expect(boundedParts(lines(21))).toEqual([...lines(19), "and 2 more"]);
	});
});

const BROUGHT_IN_AT = "2026-11-10T23:30:00.000Z";
const PUBLISHED: DriftReference = { kind: "published" };
const BROUGHT_IN: DriftReference = { kind: "brought-in", at: BROUGHT_IN_AT };
const CHANGES_BROUGHT_IN: DriftReference = { kind: "changes-brought-in" };
const AUCKLAND = { locale: "en-GB", timeZone: "Pacific/Auckland" } as const;

/** The day the brought-in date names under each reader's options. */
const DAYS: readonly {
	readonly reader: string;
	readonly options: DriftDateOptions | undefined;
	readonly day: string;
}[] = [
	{ reader: "the default", options: undefined, day: "10 November 2026" },
	{
		reader: "a reader in Auckland",
		options: AUCKLAND,
		day: "11 November 2026",
	},
	{
		reader: "an unknown zone",
		options: { locale: "en-GB", timeZone: "Mars/Olympus_Mons" },
		day: "10 November 2026",
	},
	{
		reader: "a locale Intl refuses",
		options: { locale: "not a locale!", timeZone: "UTC" },
		day: "10 November 2026",
	},
];

/** One sentence function's three arms, the brought-in arm taking the day. */
interface SentenceRow {
	readonly name: string;
	readonly say: (since: DriftReference, options?: DriftDateOptions) => string;
	readonly published: string;
	readonly broughtIn: (day: string) => string;
	readonly changesBroughtIn: string;
}

const appChange = (since: DriftReference) => ({
	kind: "app" as const,
	since,
	canBringIn: false,
});
const tableChange = {
	kind: "lookup-table" as const,
	since: PUBLISHED,
	canBringIn: false,
};
const WEB_APPS_ON_REST =
	"This app runs in Web Apps, so publishing turns it back on, and workers there can open it in Web Apps from the next version Web Apps serves, usually the next one you release. Where a project space's plan doesn't include Web Apps, saving the app's settings in CommCare HQ turns it off.";
const WEB_APPS_OFF_REST =
	"This app runs on Android only, so publishing turns it back off, and from the next version Web Apps serves, nobody there can open the app in Web Apps.";
const webAppsMoved = (to: boolean, since: DriftReference): WebAppsChange => ({
	from: !to,
	to,
	changedInHq: true,
	since,
});

const SENTENCES: readonly SentenceRow[] = [
	{
		name: "hqChangedMessage, the app listed alone",
		say: (since, options) => hqChangedMessage([appChange(since)], options),
		published: HQ_CHANGED_MESSAGE,
		broughtIn: (day) =>
			`Something in this app isn't the same in CommCare HQ as when Nova brought it in on ${day}, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.`,
		changesBroughtIn:
			"Something in this app isn't the same in CommCare HQ as when Nova last brought in changes from it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.",
	},
	{
		name: "baselineUnknownSentence",
		say: baselineUnknownSentence,
		published: BASELINE_UNKNOWN_SENTENCE,
		broughtIn: (day) =>
			`Nova couldn't confirm what CommCare HQ held when it brought this app in on ${day}, so it can't tell whether anything changed.`,
		changesBroughtIn:
			"Nova couldn't confirm what CommCare HQ held when it last brought in changes from it, so it can't tell whether anything changed.",
	},
	{
		name: "hqChangesConfirmedDetail",
		say: hqChangesConfirmedDetail,
		published: HQ_CHANGES_CONFIRMED_DETAIL,
		broughtIn: (day) =>
			`You chose to publish over what changed in CommCare HQ since Nova brought this app in on ${day}.`,
		changesBroughtIn:
			"You chose to publish over what changed in CommCare HQ since Nova last brought in changes from it.",
	},
	{
		name: "hqChangesNoneDetail",
		say: hqChangesNoneDetail,
		published: HQ_CHANGES_NONE_DETAIL,
		broughtIn: (day) =>
			`Nothing in this app has changed in CommCare HQ since Nova brought it in on ${day}.`,
		changesBroughtIn:
			"Nothing in this app has changed in CommCare HQ since Nova last brought in changes from it.",
	},
	{
		name: "webAppsChangeMessage, to on",
		say: (since, options) =>
			webAppsChangeMessage("alpha", webAppsMoved(true, since), options),
		published: `Someone turned this app's Web App setting off in CommCare HQ since Nova last published it to “alpha”. ${WEB_APPS_ON_REST}`,
		broughtIn: (day) =>
			`Someone turned this app's Web App setting off in CommCare HQ since Nova brought it in from “alpha” on ${day}. ${WEB_APPS_ON_REST}`,
		changesBroughtIn: `Someone turned this app's Web App setting off in CommCare HQ since Nova last brought in changes from “alpha”. ${WEB_APPS_ON_REST}`,
	},
	{
		name: "webAppsChangeMessage, to off",
		say: (since, options) =>
			webAppsChangeMessage("alpha", webAppsMoved(false, since), options),
		published: `Someone turned this app's Web App setting on in CommCare HQ since Nova last published it to “alpha”. ${WEB_APPS_OFF_REST}`,
		broughtIn: (day) =>
			`Someone turned this app's Web App setting on in CommCare HQ since Nova brought it in from “alpha” on ${day}. ${WEB_APPS_OFF_REST}`,
		changesBroughtIn: `Someone turned this app's Web App setting on in CommCare HQ since Nova last brought in changes from “alpha”. ${WEB_APPS_OFF_REST}`,
	},
];

describe("drift sentences by what a change is measured against", () => {
	it.each(SENTENCES)("$name says each kind of reference", (row) => {
		expect(row.say(PUBLISHED)).toBe(row.published);
		expect(row.say(CHANGES_BROUGHT_IN)).toBe(row.changesBroughtIn);
		for (const { options, day } of DAYS) {
			expect(row.say(BROUGHT_IN, options)).toBe(row.broughtIn(day));
		}
	});

	it("names the reader's day, not the server's", () => {
		expect(baselineUnknownSentence(BROUGHT_IN, AUCKLAND)).toContain(
			"11 November 2026",
		);
		expect(baselineUnknownSentence(BROUGHT_IN)).toContain("10 November 2026");
	});

	it("says the read of both kinds where the brought-in app is listed beside a table", () => {
		const both =
			"Something this app publishes isn't the same in CommCare HQ as when Nova last read it there, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.";
		expect(hqChangedMessage([appChange(BROUGHT_IN), tableChange])).toBe(both);
		expect(hqChangedMessage([tableChange, appChange(CHANGES_BROUGHT_IN)])).toBe(
			both,
		);
		/* Every change measured against a publish: today's message. */
		expect(hqChangedMessage([appChange(PUBLISHED), tableChange])).toBe(
			HQ_CHANGED_MESSAGE,
		);
		expect(hqChangedMessage([tableChange])).toBe(HQ_CHANGED_MESSAGE);
	});

	it("leads with the bring-in headline where the app's change can be brought in", () => {
		const headlines = [
			{
				since: PUBLISHED,
				text: "Something in this app changed in CommCare HQ since Nova last published it, so Nova stopped before sending anything. Here's what changed.",
			},
			{
				since: BROUGHT_IN,
				text: "Something in this app changed in CommCare HQ since Nova brought it in on 11 November 2026, so Nova stopped before sending anything. Here's what changed.",
			},
			{
				since: CHANGES_BROUGHT_IN,
				text: "Something in this app changed in CommCare HQ since Nova last brought in changes from it, so Nova stopped before sending anything. Here's what changed.",
			},
		] as const;
		for (const { since, text } of headlines) {
			const app = { kind: "app" as const, since, canBringIn: true };
			expect(hqChangedMessage([app], AUCKLAND)).toBe(text);
			expect(hqChangedMessage([tableChange, app], AUCKLAND)).toBe(
				`${text} The lookup tables and places listed below keep their own choice.`,
			);
			expect(hqChangedBringInMessage(since, false, AUCKLAND)).toBe(text);
		}
	});
});

describe("driftReferenceOf", () => {
	const OBSERVED_AT = "2026-11-13T08:00:00.000Z";
	const ADOPTED = { adoptedAt: BROUGHT_IN_AT };
	type Origin = AppBaseline["origin"];
	type StoredOrigin = Extract<
		AppBaseline,
		{ origin: "unread" }
	>["storedOrigin"];

	function stored(origin: Exclude<Origin, "unread">): AppBaseline {
		return {
			origin,
			remoteAppId: "hq-app",
			source: {},
			sourceDigest: "a".repeat(64),
			ownership: {
				addOns: [],
				profileProperties: [],
				profileCustomProperties: [],
				autoGpsCapture: false,
			},
			observedAt: OBSERVED_AT,
			observedBy: "u1",
			novaRevision: 1,
			mediaFiles: null,
			sourceBytes: 2,
		};
	}
	function unread(storedOrigin: StoredOrigin): AppBaseline {
		return {
			origin: "unread",
			remoteAppId: "hq-app",
			observedAt: OBSERVED_AT,
			observedBy: "u1",
			storedOrigin,
			novaRevision: null,
			mediaFiles: null,
		};
	}

	/* `at` is the mapping's adoption, never the baseline's date, which a
	 * refresh of kept values moves. */
	const BY_ORIGIN = {
		create: PUBLISHED,
		push: PUBLISHED,
		cutover: PUBLISHED,
		read: BROUGHT_IN,
		changes: CHANGES_BROUGHT_IN,
	} as const satisfies Record<Exclude<Origin, "unread">, DriftReference>;
	const BY_STORED_ORIGIN = {
		create: PUBLISHED,
		push: PUBLISHED,
		cutover: PUBLISHED,
		read: BROUGHT_IN,
		changes: CHANGES_BROUGHT_IN,
		unread: PUBLISHED,
	} as const satisfies Record<StoredOrigin, DriftReference>;

	it.each(Object.entries(BY_ORIGIN))(
		"reads a baseline of origin %s",
		(origin, reference) => {
			expect(
				driftReferenceOf(stored(origin as keyof typeof BY_ORIGIN), ADOPTED),
			).toEqual(reference);
		},
	);

	it.each(Object.entries(BY_STORED_ORIGIN))(
		"reads an unread baseline whose row holds %s",
		(storedOrigin, reference) => {
			expect(
				driftReferenceOf(
					unread(storedOrigin as keyof typeof BY_STORED_ORIGIN),
					ADOPTED,
				),
			).toEqual(reference);
		},
	);

	it("reads no baseline as published", () => {
		expect(driftReferenceOf(null, ADOPTED)).toEqual(PUBLISHED);
		expect(driftReferenceOf(null, null)).toEqual(PUBLISHED);
	});

	it("falls back to the baseline's date only where the mapping holds no adoption", () => {
		const fallback = { kind: "brought-in", at: OBSERVED_AT };
		expect(driftReferenceOf(stored("read"), { adoptedAt: null })).toEqual(
			fallback,
		);
		expect(driftReferenceOf(stored("read"), null)).toEqual(fallback);
		expect(driftReferenceOf(unread("read"), null)).toEqual(fallback);
	});
});

/**
 * Every string a person reads from the drift and stop-publishing copy, each
 * function called over every arm. A new function export fails the
 * completeness check until it is listed here.
 */
const SAMPLED_FUNCTIONS: Readonly<Record<string, () => readonly string[]>> = {
	baselineUnknownSentence: () => sampleArms(baselineUnknownSentence),
	hqChangesConfirmedDetail: () => sampleArms(hqChangesConfirmedDetail),
	hqChangesNoneDetail: () => sampleArms(hqChangesNoneDetail),
	hqChangedMessage: () =>
		[PUBLISHED, BROUGHT_IN, CHANGES_BROUGHT_IN].flatMap((since) =>
			[false, true].flatMap((canBringIn) => [
				hqChangedMessage([{ kind: "app", since, canBringIn }]),
				hqChangedMessage([{ kind: "app", since, canBringIn }, tableChange]),
			]),
		),
	lookupTableMadeAgainWarning: () => [
		remoteChangesModule.lookupTableMadeAgainWarning("districts"),
	],
	describeAppChange: () => [describeAppChange({ kind: "menu-list" })],
	describeLookupChange: () => [
		describeLookupChange({ kind: "renamed", tag: "areas" }, "districts"),
	],
	describePlaceChange: () => [describePlaceChange({ kind: "missing" })],
	boundedParts: () => boundedParts(["a", "b"]),
	/* A boolean, never read by a person. */
	fileDisclosureTruncated: () => [],
	appRemoteChange: () => sampleAppRemoteChange(),
	decideRemoteChanges: () => [],
	driftReferenceOf: () => [],
	driftDate: () => [driftReferenceModule.driftDate(BROUGHT_IN_AT)],
	viewerDriftDate: () => [],
	stopPublishingConfirmTitle: () => [
		stopPublishingModule.stopPublishingConfirmTitle("acme"),
	],
	stopPublishingConfirmBody: () => [
		stopPublishingModule.stopPublishingConfirmBody("acme"),
	],
	endedLine: () => [
		stopPublishingModule.endedLine(
			{ byName: "Ada", reason: "stopped", heldByAnotherApp: false },
			"10 November 2026",
		),
		stopPublishingModule.endedLine(
			{ byName: "Ada", reason: "stopped", heldByAnotherApp: true },
			"10 November 2026",
		),
		stopPublishingModule.endedLine(
			{ byName: "Ada", reason: "claimed-elsewhere", heldByAnotherApp: true },
			"10 November 2026",
		),
		stopPublishingModule.endedLine(
			{ byName: "Ada", reason: "claimed-elsewhere", heldByAnotherApp: false },
			"10 November 2026",
		),
	],
	restoredStoppedPublishing: () => [
		stopPublishingModule.restoredStoppedPublishing(["“acme”"]),
		stopPublishingModule.restoredStoppedPublishing(["“acme”", "“beta” (EU)"]),
	],
	adoptionRecordedFeaturesLine: () => [
		adoptionRecordedFeaturesLine(["Lookup tables", "Child cases"], "acme"),
	],
	webAppsChangeMessage: () => [
		...[true, false].flatMap((to) =>
			[PUBLISHED, BROUGHT_IN, CHANGES_BROUGHT_IN].map((since) =>
				webAppsChangeMessage("alpha", webAppsMoved(to, since)),
			),
		),
	],
};

function remoteAppInput(fileCount: number) {
	const current = normalizeHqAppSource({
		doc_type: "Application",
		modules: [],
		_attachments: {},
		multimedia_map: Object.fromEntries(
			Array.from({ length: fileCount }, (_, i) => [
				`jr://file/commcare/image/photo-${i}.png`,
				i === 0
					? { media_type: "CommCareImage" }
					: { media_type: "CommCareImage", multimedia_id: `file${i}` },
			]),
		),
	});
	if ("malformed" in current) throw new Error(current.malformed);
	return {
		authority: {
			actor: "editor",
			role: "editor",
			project: "project",
			app: "app",
			server: "production" as const,
			domain: "acme",
			remoteApp: "remote",
			deployment: "deployment",
			claim: "claim",
			reviewGeneration: null,
			headSeq: 1,
			remoteRevision: 2,
			baseline: null,
		},
		appName: "Care",
		novaAppId: "app",
		remoteAppId: "remote",
		since: PUBLISHED,
		languageNames: "target" as const,
		mediaChanged: 0,
		published: [],
		current,
	};
}

/**
 * Every line and note `appRemoteChange` builds: a removed file with and
 * without its CommCare HQ file id, a list too long to show whole with and
 * without a usable pair, and a first and a next publish's required review.
 */
function sampleAppRemoteChange(): readonly string[] {
	const changes = [
		appRemoteChange({
			...remoteAppInput(2),
			baseline: null,
			canBringIn: true,
		}),
		...[true, false].map((canBringIn) =>
			appRemoteChange({
				...remoteAppInput(21),
				baseline: null,
				canBringIn,
			}),
		),
		...[true, false].flatMap((canBringIn) =>
			[undefined, []].map((unverifiedNextChanges) =>
				appRemoteChange({
					...remoteAppInput(0),
					baseline: {
						origin: "unread",
						mediaFiles: null,
						firstPublishReview: "required",
						...(unverifiedNextChanges && { unverifiedNextChanges }),
					},
					canBringIn,
				}),
			),
		),
	];
	return changes.flatMap((change) => {
		if (!change) throw new Error("Each sampled input is a change.");
		return [...change.parts, ...(change.note === null ? [] : [change.note])];
	});
}

function sampleArms(
	say: (since: DriftReference, options?: DriftDateOptions) => string,
): readonly string[] {
	return [PUBLISHED, BROUGHT_IN, CHANGES_BROUGHT_IN].map((since) => say(since));
}

describe("a removed-file change", () => {
	it("names each file by its path, invites the review a long list needs, and asks for the first publish's review", () => {
		const lines = sampleAppRemoteChange();
		expect(lines).toContain(
			"Publishing removes the reference to “commcare/image/photo-0.png” from the app in CommCare HQ. This app doesn't use it.",
		);
		expect(lines).toContain(
			"Publishing removes the file “commcare/image/photo-1.png” from the app in CommCare HQ. This app doesn't use it.",
		);
		for (const line of [
			"You can review the complete list of files before publishing here.",
			"You can review what the first publish would change in this project space.",
			"You can review what the next publish would change in this project space.",
			"You can review changes from CommCare HQ before publishing here.",
		])
			expect(lines).toContain(line);
		expect(lines.join(" ")).not.toMatch(/jr:\/\/|file1”/);
	});
	it.each([
		{ files: 19, location: false, media: 0, hidden: false, overflow: false },
		{ files: 18, location: true, media: 1, hidden: false, overflow: true },
		{ files: 19, location: true, media: 0, hidden: true, overflow: true },
		{ files: 20, location: false, media: 0, hidden: true, overflow: true },
	])(
		"requires full review when the summary hides a file ($files files, location $location, media $media)",
		({ files, location, media, hidden, overflow }) => {
			const legacyLanguageRemoval =
				"Publishing would remove Ganda (lug) from this app in CommCare HQ.";
			const fixture = remoteAppInput(files);
			const input = {
				...fixture,
				baseline: {
					origin: "cutover" as const,
					source: fixture.current.normalized,
					ownership: {
						addOns: [],
						profileProperties: [],
						profileCustomProperties: [],
						autoGpsCapture: false,
					},
					mediaFiles: null,
				},
				canBringIn: true,
				locationChange: location
					? "Automatic location for every form will change from on to off"
					: undefined,
				mediaChanged: media,
				legacyLanguageRemoval,
			};
			const shown = appRemoteChange(input);
			if (!shown) throw new Error("Expected the app's change");
			expect(shown.parts[0]).toBe(legacyLanguageRemoval);
			expect(
				shown.parts.filter((line) => line.startsWith("Publishing removes ")),
			).toHaveLength(hidden ? 18 : files);
			if (overflow) expect(shown.parts.at(-1)).toBe("and 2 more");
			expect(shown.requiresReview).toBe(hidden ? true : undefined);
			const discard = {
				kind: shown.kind,
				novaResourceId: shown.novaResourceId,
				observedDigest: shown.observedDigest,
			};
			expect(
				decideRemoteChanges({ observed: [shown], discards: [discard] }).proceed,
			).toBe(!hidden);
			if (hidden) {
				const removed = removedHqFiles(input.current.normalized, {
					published: input.published,
					recorded: null,
				});
				const complete = {
					...discard,
					observedDigest: hqDiscardDigest(
						input.authority,
						input.current.digest,
						removed,
						"complete",
					),
				};
				const reviewed = appRemoteChange({ ...input, discards: [complete] });
				if (!reviewed) throw new Error("Expected the reviewed change");
				expect(reviewed.parts).toEqual(shown.parts);
				expect(reviewed.observedDigest).toBe(complete.observedDigest);
				expect(
					decideRemoteChanges({ observed: [reviewed], discards: [complete] })
						.proceed,
				).toBe(true);
			}
		},
	);
});

describe("the copy", () => {
	const modules = {
		remoteChanges: remoteChangesModule,
		appRemoteChange: appRemoteChangeModule,
		driftReference: driftReferenceModule,
		stopPublishing: stopPublishingModule,
		hqAppClaims: hqAppClaimsModule,
	};

	it("holds no em dash and no ellipsis in any string it exports or builds", () => {
		const strings: string[] = [];
		for (const [moduleName, exports] of Object.entries(modules)) {
			for (const [name, value] of Object.entries(exports)) {
				if (typeof value === "string") {
					strings.push(value);
				} else if (typeof value === "function") {
					const sample = SAMPLED_FUNCTIONS[name];
					expect(
						sample,
						`${moduleName}.${name} is a function this test does not call; list it in SAMPLED_FUNCTIONS`,
					).toBeDefined();
					strings.push(...(sample?.() ?? []));
				}
			}
		}
		strings.push(...(SAMPLED_FUNCTIONS.adoptionRecordedFeaturesLine?.() ?? []));
		strings.push(...(SAMPLED_FUNCTIONS.webAppsChangeMessage?.() ?? []));
		expect(strings.length).toBeGreaterThan(30);
		for (const text of strings) {
			expect(text).not.toMatch(/\u2014|\u2026|\.\.\./);
		}
	});
});
