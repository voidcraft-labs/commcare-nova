/** Admitted document -> setup guidance. Proves the projection and its lifetime;
 * it does not claim that following these instructions executed anything on HQ. */
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	automationMessageText,
	type BlueprintDoc,
	blueprintDocSchema,
	type LevelAddressBook,
	type LevelCaseFlow,
	type OrganizationLevel,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import {
	previewProjectSpace,
	resolvePreviewDeploymentTarget,
} from "../previewTarget";
import {
	buildSetupArtifact,
	type SetupArtifact,
	type SetupArtifactInput,
} from "../setupArtifact";
import type {
	DeploymentPhase,
	DeploymentRecord,
	DeploymentState,
} from "../types";

const STATE = testUuid("setup-state"),
	DISTRICT = testUuid("setup-district"),
	CLINIC = testUuid("setup-clinic");
const PARTNER = testUuid("setup-partner"),
	MODULE = testUuid("setup-module");
const WORKER_A = testUuid("setup-worker-a"),
	WORKER_B = testUuid("setup-worker-b");
const PROPERTY_A = testUuid("setup-place-a"),
	PROPERTY_B = testUuid("setup-place-b");
const AUTOMATION_A = testUuid("setup-automation-a"),
	AUTOMATION_B = testUuid("setup-automation-b");

function baseDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Vaccine Tracker",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							},
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}

function level(
	uuid: OrganizationLevel["uuid"],
	code: string,
	name: string,
	parentLevelUuid?: OrganizationLevel["uuid"],
): OrganizationLevel {
	return {
		uuid,
		code,
		name,
		...(parentLevelUuid ? { parentLevelUuid } : {}),
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
}
function organizationDoc(): BlueprintDoc {
	const doc = baseDoc();
	// Storage order deliberately disagrees with both dependency and authored order.
	doc.organizationLevels = {
		[CLINIC]: level(CLINIC, "clinic", "Clinic", DISTRICT),
		[DISTRICT]: level(DISTRICT, "district", "District", STATE),
		[STATE]: level(STATE, "state", "State"),
		[PARTNER]: level(PARTNER, "partner", "Partner"),
	};
	doc.organizationLevelOrder = [PARTNER, CLINIC, DISTRICT, STATE];
	return doc;
}
function place(
	id: string,
	levelUuid: string,
	parentId: StoredLocation["parentId"] = null,
): StoredLocation {
	return {
		id: testUuid(id),
		levelUuid,
		parentId,
		siteCode: id,
		name: id,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: "a0",
	};
}
function artifact(overrides: Partial<SetupArtifactInput> = {}): SetupArtifact {
	const input: SetupArtifactInput = {
		doc: baseDoc(),
		server: "production",
		domain: "rhi-bihar",
		hqAppId: "hq-abc",
		locations: [],
		...overrides,
	};
	blueprintDocSchema.parse(toPersistableDoc(input.doc));
	expect(runValidation(input.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const before = structuredClone(input);
	const result = buildSetupArtifact(input);
	expect(input).toEqual(before);
	return result;
}
function section(
	result: SetupArtifact,
	id: SetupArtifact["sections"][number]["id"],
) {
	const found = result.sections.find((item) => item.id === id);
	if (!found) throw new Error(`Missing setup section: ${id}`);
	return found;
}
function district(doc: BlueprintDoc) {
	const found = doc.organizationLevels?.[DISTRICT];
	if (!found) throw new Error("Missing District");
	return found;
}

it.each([
	["production", "www.commcarehq.org"],
	["india", "india.commcarehq.org"],
	["eu", "eu.commcarehq.org"],
] as const)(
	"targets the selected %s deployment and omits every absent optional section",
	(server, host) => {
		const result = artifact({ server });
		expect({
			server: result.server,
			domain: result.domain,
			hqAppId: result.hqAppId,
		}).toEqual({ server, domain: "rhi-bihar", hqAppId: "hq-abc" });
		expect(result.sections.map(({ id, url }) => ({ id, url }))).toEqual([
			{
				id: "build-and-release",
				url: `https://${host}/a/rhi-bihar/apps/view/hq-abc/releases/`,
			},
			{ id: "web-apps", url: `https://${host}/a/rhi-bihar/cloudcare/apps/v2/` },
		]);
		expect(
			section(artifact({ server, hqAppId: null }), "build-and-release").url,
		).toBeNull();
	},
);

it("keeps manual build, release and Web App setup explicit", () => {
	const result = artifact(),
		build = section(result, "build-and-release"),
		web = section(result, "web-apps");
	expect(build.steps).toEqual([
		{
			id: "open-releases",
			text: "Open the app's Releases screen on CommCare HQ.",
			detail: [],
		},
		{
			id: "make-version",
			text: "Choose Make new version, and wait for it to finish.",
			detail: [],
		},
		{ id: "release", text: "Star the new version to release it.", detail: [] },
	]);
	expect(build.caveats).toContain(
		"CommCare HQ only lets a signed-in person do this. Its build and release pages accept a browser session and not an API key, so Nova watches for it rather than doing it.",
	);
	expect(web.steps.map(({ id }) => id)).toEqual([
		"check-listed",
		"enable-web-app",
	]);
	expect(web.steps[1]?.text).toBe(
		"If it is not listed, open the app's Settings on CommCare HQ and tick “Web App”.",
	);
	expect(web.steps[1]?.detail).toContain(
		"You do not need to publish again. It is an ordinary app setting you can change at any time.",
	);
});

it("reports exact table ownership and push status before the app instructions", () => {
	const result = artifact({
		lookupTables: [
			{ name: "Districts", tag: "districts", pushed: true, adopted: false },
			{ name: "Statuses", tag: "statuses", pushed: false, adopted: false },
			{ name: "Clinics", tag: "clinics", pushed: true, adopted: true },
		],
	});
	expect(result.sections.map(({ id }) => id)).toEqual([
		"lookup-tables",
		"build-and-release",
		"web-apps",
	]);
	const tables = section(result, "lookup-tables");
	expect(tables.title).toBe("Project data");
	expect(tables.url).toBe("https://www.commcarehq.org/a/rhi-bihar/fixtures/");
	expect(tables.steps).toEqual([
		{
			id: "districts",
			text: "Districts (districts)",
			detail: [
				"Nova keeps this on “rhi-bihar”, replacing its rows whenever you publish.",
			],
		},
		{
			id: "statuses",
			text: "Statuses (statuses)",
			detail: ["Nova will put this on “rhi-bihar” the next time you publish."],
		},
		{
			id: "clinics",
			text: "Clinics (clinics)",
			detail: [
				"Nova keeps this on “rhi-bihar”, replacing its rows whenever you publish.",
				"You chose to use the table already on that project space rather than a new one, so publishing replaces its rows.",
			],
		},
	]);
	expect(tables.caveats).toEqual([
		"Publishing replaces the rows of these tables on CommCare HQ with the rows in Nova. Anything edited there is overwritten.",
		"Renaming a table in Project data makes a new one on CommCare HQ. The old one stays where it is, so nothing anybody else built on it breaks.",
	]);
});

it("orders parents before children and respects authored order between available branches", () => {
	const org = section(artifact({ doc: organizationDoc() }), "organization");
	expect(org.url).toBe(
		"https://www.commcarehq.org/a/rhi-bihar/settings/locations/location_types/",
	);
	expect(org.steps.map(({ id }) => id)).toEqual([
		"advanced-mode",
		PARTNER,
		STATE,
		DISTRICT,
		CLINIC,
	]);
	expect(org.steps[0]?.text).toBe(
		"Tick “Advanced mode” at the top of the page first. Type Code, both expand settings, Include only, Include without expanding, and the user settings are hidden until you do.",
	);
	expect(org.steps[3]?.text).toBe(
		"Add a level named “District” with “Type Code” “district” and parent “State”.",
	);
	// Current HQ LocationTypesView and location_types.html: distinct access
	// refusals, editable unique codes, whole-list replacement, incomplete API reads.
	expect(org.caveats).toEqual([
		"Two levels cannot share a Type Code. CommCare HQ checks that as you type and refuses to save a duplicate.",
		"This page is the only way to define levels. CommCare HQ's location API cannot write them, and reads back only the name, code, parent, and two of the settings below, so Nova can neither create these for you nor check that you got them right.",
		"Saving this page replaces the whole list. A level you leave out is removed, and if that level still has places in it, CommCare HQ abandons the ENTIRE save with only a warning at the top of the page, so none of your other changes land either. Add to what is there rather than starting over.",
		"If you cannot open this page, what CommCare HQ says tells you which thing to fix. A page-not-found means either the project space does not have the paid Locations feature (ask support@dimagi.com), or your account lacks the “edit apps” permission. A permission-denied means you have “edit apps” but not “edit locations”. Either way the address is right, so ask whoever administers the project space rather than hunting for the page.",
	]);
});

const flowCases: {
	label: string;
	flow: LevelCaseFlow;
	ownership: string;
	descendants: string[];
}[] = [
	{
		label: "structural",
		flow: { workers: "none", ownsCases: false },
		ownership: "Leave “Owns Cases” unticked.",
		descendants: [],
	},
	{
		label: "queue",
		flow: { workers: "none", ownsCases: true },
		ownership: "Tick “Owns Cases”.",
		descendants: [],
	},
	{
		label: "own cases",
		flow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		ownership: "Tick “Owns Cases”.",
		descendants: ["Leave “View Child Data” unticked."],
	},
	{
		label: "oversight",
		flow: {
			workers: "assigned",
			ownsCases: false,
			descendantCases: { kind: "all" },
		},
		ownership: "Leave “Owns Cases” unticked.",
		descendants: [
			"Tick “View Child Data” and leave “View Child Data to Level” unset, so workers here receive cases from every place below them.",
		],
	},
	{
		label: "bounded descendants",
		flow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "down-to", levelUuid: CLINIC },
		},
		ownership: "Tick “Owns Cases”.",
		descendants: [
			"Tick “View Child Data” and set “View Child Data to Level” to “Clinic”. If you cannot see that second column, this project does not have the restore-file location toggle and the limit cannot be set.",
		],
	},
];
it.each(flowCases)(
	"projects $label case flow independently of the address book",
	({ flow, ownership, descendants }) => {
		const doc = organizationDoc();
		district(doc).caseFlow = flow;
		const step = section(artifact({ doc }), "organization").steps.find(
			({ id }) => id === DISTRICT,
		);
		expect(step?.detail).toEqual([
			ownership,
			...(flow.workers === "none"
				? [
						"Untick “Has Users”; it arrives ticked. If you cannot see that column, this project space does not have the restore-file location toggle, and CommCare HQ will allow workers to be assigned here even though your app does not put any here.",
						"CommCare HQ locks “Has Users” on once workers are already assigned to a place at this level. If it will not untick, move those workers first.",
					]
				: [
						"Leave “Has Users” ticked; it arrives ticked. If you cannot see that column, nothing to do: CommCare HQ allows workers here anyway.",
					]),
			...descendants,
			"Leave “Level to expand from” unset, so workers carry their own place, everything under it, and the chain above it.",
		]);
	},
);

const bookCases: { label: string; book: LevelAddressBook; detail: string[] }[] =
	[
		{
			label: "own branch",
			book: {
				reach: "own-branch",
				downToLevelUuid: CLINIC,
				alsoIncludeTopDownToLevelUuid: STATE,
			},
			detail: [
				"Leave “Level to expand from” unset, so workers carry their own place, everything under it, and the chain above it.",
				"Set “Level to expand to” to “Clinic” to stop descending there.",
				"Set “Include without expanding” to “State”, so workers here also carry the top of the organization down to that rung.",
			],
		},
		{
			label: "limited branch",
			book: {
				reach: "own-branch-limited",
				levelUuids: [DISTRICT, CLINIC],
				alsoIncludeTopDownToLevelUuid: STATE,
			},
			detail: [
				"Set “Include only” to exactly these levels: “District”, “Clinic”.",
				"Leave “Level to expand to” and “Level to expand from” unset. CommCare HQ ignores “Include only” when the first is set, and ignores the second when “Include only” is set. Either way one of them silently does nothing.",
				"Set “Include without expanding” to “State”, so workers here also carry the top of the organization down to that rung.",
			],
		},
		{
			label: "shared branch",
			book: {
				reach: "shared-branch",
				fromLevelUuid: STATE,
				downToLevelUuid: CLINIC,
			},
			detail: [
				"Set “Level to expand from” to “State”, so the branch a worker carries starts there rather than at their own place and they can name their siblings.",
				"Set “Level to expand to” to “Clinic” to stop descending there.",
			],
		},
		{
			label: "whole organization",
			book: { reach: "whole-organization", downToLevelUuid: CLINIC },
			detail: [
				"Set “Level to expand from” to “root”, so workers here carry the whole organization.",
				"Set “Level to expand to” to “Clinic” to stop descending there.",
			],
		},
	];
it.each(bookCases)(
	"projects the $label address book with exact named levels and controls",
	({ book, detail }) => {
		const doc = organizationDoc();
		district(doc).addressBook = book;
		const step = section(artifact({ doc }), "organization").steps.find(
			({ id }) => id === DISTRICT,
		);
		expect(step?.detail).toEqual([
			"Tick “Owns Cases”.",
			"Leave “Has Users” ticked; it arrives ticked. If you cannot see that column, nothing to do: CommCare HQ allows workers here anyway.",
			"Leave “View Child Data” unticked.",
			...detail,
		]);
	},
);

it("regenerates ordered worker and place fields with current names, choices, requiredness and stable identities", () => {
	const doc = baseDoc();
	doc.userProperties = {
		[WORKER_A]: {
			uuid: WORKER_A,
			slug: "area",
			label: "Area",
			choices: ["North", "South"],
			required: true,
		},
		[WORKER_B]: { uuid: WORKER_B, slug: "team", label: "Team" },
	};
	doc.userPropertyOrder = [WORKER_B, WORKER_A];
	doc.locationProperties = {
		[PROPERTY_A]: {
			uuid: PROPERTY_A,
			slug: "size",
			label: "Size",
			choices: ["small", "large"],
			required: true,
		},
		[PROPERTY_B]: { uuid: PROPERTY_B, slug: "zone", label: "Zone" },
	};
	doc.locationPropertyOrder = [PROPERTY_B, PROPERTY_A];
	const first = artifact({ doc });
	expect(first.sections.map(({ id }) => id)).toEqual([
		"worker-data",
		"place-data",
		"build-and-release",
		"web-apps",
	]);
	expect(section(first, "worker-data").steps).toEqual([
		{
			id: WORKER_B,
			text: "Add a field with “User Property” “team” and label “Team”.",
			detail: ["Leave Required unticked."],
		},
		{
			id: WORKER_A,
			text: "Add a field with “User Property” “area” and label “Area”.",
			detail: [
				"Tick Required, and under “Required for” choose Mobile Workers.",
				"Set its choices to exactly: “North”, “South”. If that column reads “Validation” rather than “Choices”, choose “Choices” first to get the list.",
			],
		},
	]);
	expect(section(first, "place-data").steps).toEqual([
		{
			id: PROPERTY_B,
			text: "Add a field labelled “Zone” with “Property Name” “zone”.",
			detail: ["Leave Required unticked."],
		},
		{
			id: PROPERTY_A,
			text: "Add a field labelled “Size” with “Property Name” “size”.",
			detail: [
				"Tick Required, so CommCare HQ holds every place to it the way Nova does.",
				"Set its accepted values to exactly these, one per line: small, large.",
			],
		},
	]);
	expect(section(first, "worker-data").url).toBe(
		"https://www.commcarehq.org/a/rhi-bihar/settings/users/user_data/",
	);
	expect(section(first, "place-data").url).toBe(
		"https://www.commcarehq.org/a/rhi-bihar/settings/locations/fields/",
	);
	expect(section(first, "place-data").caveats).toContain(
		"A field marked required here with no value on one of your places makes CommCare HQ refuse that whole group of places, so fill the value in first or leave the field optional.",
	);
	doc.userProperties[WORKER_A] = {
		uuid: WORKER_A,
		slug: "region",
		label: "Region",
	};
	doc.userPropertyOrder = [WORKER_A, WORKER_B];
	doc.locationProperties[PROPERTY_A] = {
		uuid: PROPERTY_A,
		slug: "capacity",
		label: "Capacity",
	};
	doc.locationPropertyOrder = [PROPERTY_A, PROPERTY_B];
	const next = artifact({ doc });
	expect(section(next, "worker-data").steps[0]).toEqual({
		id: WORKER_A,
		text: "Add a field with “User Property” “region” and label “Region”.",
		detail: ["Leave Required unticked."],
	});
	expect(section(next, "place-data").steps[0]).toEqual({
		id: PROPERTY_A,
		text: "Add a field labelled “Capacity” with “Property Name” “capacity”.",
		detail: ["Leave Required unticked."],
	});
	expect(section(first, "worker-data").steps[1]?.text).toContain("“Area”");
});

it("summarizes live places by stable level identity through partial pushes, adoption and a rename", () => {
	const doc = organizationDoc();
	const root = place("state-place", STATE),
		child = place("district-place", DISTRICT, root.id);
	const archived = {
		...place("archived-place", STATE),
		archivedAt: new Date("2026-09-01"),
	};
	const locations = [child, root, archived, place("other-state", STATE)];
	const pushedPlaces = new Map([
		[root.id, { adopted: true }],
		[archived.id, { adopted: true }],
		[child.id, { adopted: false }],
	]);
	const first = section(artifact({ doc, locations, pushedPlaces }), "places");
	expect(first.url).toBe(
		"https://www.commcarehq.org/a/rhi-bihar/settings/locations/list/",
	);
	expect(first.steps).toEqual([
		{
			id: STATE,
			text: "State: 2 places",
			detail: [
				"1 of these are on “rhi-bihar”; Nova sends the rest the next time you publish.",
			],
		},
		{
			id: DISTRICT,
			text: "District: 1 place",
			detail: ["All of these are on “rhi-bihar”."],
		},
	]);
	expect(first.caveats[0]).toBe(
		"You chose to use 1 place that “rhi-bihar” already had rather than new ones, so publishing keeps it in step with Nova.",
	);
	expect(first.caveats).toContain(
		"Archiving a place in Nova stops Nova sending it, and leaves the one on CommCare HQ exactly where it is. Archive it there too if you want it out of the way, and note that its site code stays reserved either way.",
	);
	const state = doc.organizationLevels?.[STATE];
	if (!state) throw new Error("Missing State");
	state.name = "Province";
	const next = section(artifact({ doc, locations }), "places");
	expect(next.steps).toEqual([
		{
			id: STATE,
			text: "Province: 2 places",
			detail: ["Nova will put these on “rhi-bihar” the next time you publish."],
		},
		{
			id: DISTRICT,
			text: "District: 1 place",
			detail: ["Nova will put these on “rhi-bihar” the next time you publish."],
		},
	]);
	expect(next.caveats).toHaveLength(2);
	expect(
		artifact({ doc, locations: [archived] }).sections.map(({ id }) => id),
	).toEqual(["organization", "build-and-release", "web-apps"]);
});

it("regenerates automations in authored order and includes deep-link setup only while a destination exists", () => {
	const doc = baseDoc();
	doc.automations = {
		[AUTOMATION_A]: {
			uuid: AUTOMATION_A,
			kind: "case-update",
			name: "Close old patients",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [],
			closeCase: true,
			serverModifiedBoundaryDays: 30,
		},
		[AUTOMATION_B]: {
			uuid: AUTOMATION_B,
			kind: "conditional-alert",
			name: "Remind patients",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: testUuid("setup-recipient"), kind: "self" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("setup-event"),
						minutesToWait: 0,
						content: {
							kind: "sms",
							message: automationMessageText("Please visit the clinic"),
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		},
	};
	doc.automationOrder = [AUTOMATION_B, AUTOMATION_A];
	doc.modules[MODULE].entryPoint = {
		uuid: testUuid("setup-entry"),
		id: "patients",
	};
	const result = artifact({ doc, server: "eu" });
	expect(result.sections.map(({ id }) => id)).toEqual([
		"automations",
		"build-and-release",
		"web-apps",
		"deep-links",
	]);
	const rules = section(result, "automations");
	expect(rules.url).toBeNull();
	expect(rules.steps.map(({ id }) => id)).toEqual([AUTOMATION_B, AUTOMATION_A]);
	expect(rules.steps[0]?.text).toContain(
		"https://eu.commcarehq.org/a/rhi-bihar/messaging/conditional/",
	);
	expect(rules.steps[0]?.detail).toContain(
		'Immediate event 1: wait 0 minutes after the previous event, then send SMS message "Please visit the clinic".',
	);
	expect(rules.steps[1]?.text).toContain(
		"https://eu.commcarehq.org/a/rhi-bihar/data/edit/automatic_updates/",
	);
	expect(rules.steps[1]?.detail).toContain("Turn on Close case.");
	expect(rules.summary).toContain(
		"Changing an automation in Nova does not change one you already made there.",
	);
	expect(new Set(rules.caveats).size).toBe(rules.caveats.length);
	expect(section(result, "deep-links").steps.map(({ id }) => id)).toEqual([
		"enable-deep-links",
		"release-links",
	]);
	doc.automations[AUTOMATION_A].name = "Close retired patients";
	doc.automationOrder = [AUTOMATION_A, AUTOMATION_B];
	delete doc.modules[MODULE].entryPoint;
	const next = artifact({ doc });
	expect(section(next, "automations").steps[0]?.text).toContain(
		"Close retired patients",
	);
	expect(next.sections.map(({ id }) => id)).toEqual([
		"automations",
		"build-and-release",
		"web-apps",
	]);
});

type PreviewRecord = Pick<DeploymentRecord, "state" | "resumePhase" | "domain">;
const deployment = (
	state: DeploymentState,
	domain = "acme",
	resumePhase: DeploymentPhase | null = null,
): PreviewRecord => ({ state, domain, resumePhase });
it("names only unambiguous uploaded targets and projects absence as an absent session value", () => {
	for (const state of ["preflight", "resources"] as const)
		expect(resolvePreviewDeploymentTarget([deployment(state)])).toEqual({
			kind: "none",
		});
	for (const state of ["uploaded", "built", "released", "runnable"] as const)
		expect(resolvePreviewDeploymentTarget([deployment(state)])).toEqual({
			kind: "known",
			domain: "acme",
		});
	for (const phase of ["preflight", "resources", "upload"] as const)
		expect(
			resolvePreviewDeploymentTarget([deployment("incomplete", "acme", phase)]),
		).toEqual({ kind: "none" });
	for (const phase of ["build", "release", "probe"] as const)
		expect(
			resolvePreviewDeploymentTarget([deployment("incomplete", "acme", phase)]),
		).toEqual({ kind: "known", domain: "acme" });
	expect(resolvePreviewDeploymentTarget([])).toEqual({ kind: "none" });
	expect(
		resolvePreviewDeploymentTarget([
			deployment("runnable"),
			deployment("uploaded"),
			deployment("preflight", "beta"),
		]),
	).toEqual({ kind: "known", domain: "acme" });
	const ambiguous = resolvePreviewDeploymentTarget([
		deployment("runnable"),
		deployment("uploaded", "beta"),
		deployment("released"),
	]);
	expect(ambiguous).toEqual({ kind: "ambiguous", domains: ["acme", "beta"] });
	expect(previewProjectSpace(ambiguous)).toBeNull();
	expect(previewProjectSpace({ kind: "none" })).toBeNull();
	expect(previewProjectSpace({ kind: "known", domain: "acme" })).toBe("acme");
});
