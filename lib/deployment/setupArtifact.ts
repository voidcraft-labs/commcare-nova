// lib/deployment/setupArtifact.ts
//
// What Nova will create on a CommCare HQ project space, and what a person
// still has to set up there by hand.
//
// **It is regenerated from the document on every read and never stored.**
// That is the load-bearing property: a stored copy would go stale the
// first time somebody renamed a worker property, and an author following
// stale instructions would configure the target wrongly and have no way
// to tell. Nothing here is persisted, cached, or versioned.
//
// **Every section is target-aware.** The project space slug appears in
// each URL and in the prose, because "go to your project's Organization
// Levels page" is not an instruction somebody can follow and
// `https://www.commcarehq.org/a/rhi-bihar/settings/locations/location_types/`
// is.
//
// **It never claims a prerequisite was installed.** Most sections here
// exist precisely because CommCare HQ exposes no API-key path for them:
// the user-data schema and organization levels are session-only HTML
// forms (`users/views/mobile/custom_data_fields.py::UserFieldsView`,
// `locations/views.py::LocationTypesView`), automations have no REST
// resource at all, and building and releasing sit behind
// `require_can_edit_apps`.
//
// Lookup tables are the first one that flipped, and they show the shape
// the rest take when their drivers ship: the same artifact, one section
// rewritten from an instruction into a RECORD of what Nova did, never a
// second document and never a capability flag. It still states what a
// person cannot see for themselves — which tables Nova owns there — so
// the section remains worth reading after the work is done.

import { buildAutomationSetupGuide } from "@/lib/automations/setupGuidance";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import type { BlueprintDoc, OrganizationLevel } from "@/lib/domain";
import {
	orderedLocationProperties,
	organizationLevelsOf,
	ownRecordValue,
	userPropertiesOf,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";

type SetupArtifactSectionId =
	| "lookup-tables"
	| "worker-data"
	| "organization"
	| "place-data"
	| "places"
	| "automations"
	| "build-and-release"
	| "web-apps";

/**
 * One instruction.
 *
 * `detail` lines belong to the step above them. They are a separate slot
 * rather than an indent convention because both renderers have to know the
 * difference: text numbering would count them, and a DOM list would give
 * each one its own number and show the leading spaces.
 */
export interface SetupArtifactStep {
	/**
	 * Stable identity for this step.
	 *
	 * A real id rather than a list position, for the same reason everything
	 * else in Nova is: two organization levels can produce identical detail
	 * lines, and a renderer keyed on position or text would confuse them.
	 * It is the authored UUID wherever one exists.
	 */
	readonly id: string;
	readonly text: string;
	readonly detail: readonly string[];
}

export interface SetupArtifactSection {
	readonly id: SetupArtifactSectionId;
	readonly title: string;
	/** Why this section exists, in the author's words. */
	readonly summary: string;
	/** The exact page on the target project space, when there is one. */
	readonly url: string | null;
	readonly steps: readonly SetupArtifactStep[];
	readonly caveats: readonly string[];
}

function step(
	id: string,
	text: string,
	detail: readonly string[] = [],
): SetupArtifactStep {
	return { id, text, detail };
}

export interface SetupArtifact {
	readonly server: CommCareServer;
	readonly domain: string;
	/** The CommCare HQ app id, once one exists. */
	readonly hqAppId: string | null;
	readonly sections: readonly SetupArtifactSection[];
}

export interface SetupArtifactInput {
	readonly doc: BlueprintDoc;
	readonly server: CommCareServer;
	readonly domain: string;
	readonly hqAppId: string | null;
	/** App-scoped places, for naming the ones an automation refers to. */
	readonly locations: readonly StoredLocation[];
	/**
	 * The lookup tables this app reads, and whether they are on the target
	 * yet. Absent when the caller has no deployment to speak for — the
	 * artifact then simply omits the section rather than guessing.
	 */
	readonly lookupTables?: readonly SetupArtifactLookupTable[];
	/**
	 * Which of this app's places the target already holds, keyed by the
	 * place's Nova uuid. Absent when the caller has no deployment to speak
	 * for, and the places section then says what a publish WILL do rather
	 * than what it has done.
	 */
	readonly pushedPlaces?: ReadonlyMap<string, { readonly adopted: boolean }>;
}

function hqBase(server: CommCareServer): string {
	return COMMCARE_SERVERS[server].baseUrl;
}

/**
 * How a level's case flow reads on CommCare HQ's Organization Levels page.
 *
 * The labels here are the ones actually on that page
 * (`locations/templates/locations/location_types.html`), not Nova's
 * vocabulary and not the model field names. An instruction naming a
 * control the reader cannot find is not an instruction.
 */
function levelCaseFlowSteps(
	level: OrganizationLevel,
	levelName: (uuid: string) => string,
): string[] {
	const steps: string[] = [];
	const flow = level.caseFlow;
	steps.push(
		flow.ownsCases ? "Tick “Owns Cases”." : "Leave “Owns Cases” unticked.",
	);
	// "Has Users" and "View Child Data to Level" sit behind a domain
	// toggle, so the instruction has to say what to do when they are not
	// on the page rather than sending somebody hunting.
	//
	// A new level arrives with "Has Users" TICKED: `locations/models.py`
	// declares `has_users = BooleanField(default=True)` and
	// `locations/js/location_types.js` seeds a new row's
	// `has_users_setting` to true ("new loc types default to true"), then
	// posts `has_users` on every save whether or not the column is on the
	// page. So the work is in unticking it, and a hidden column means the
	// level is saved allowing workers, which is why the no-workers arm
	// cannot say "nothing to do".
	steps.push(
		flow.workers === "assigned"
			? "Leave “Has Users” ticked; it arrives ticked. If you cannot see that column, nothing to do: CommCare HQ allows workers here anyway."
			: "Untick “Has Users”; it arrives ticked. If you cannot see that column, this project space does not have the restore-file location toggle, and CommCare HQ will allow workers to be assigned here even though your app does not put any here.",
	);
	if (flow.workers === "none") {
		steps.push(
			"CommCare HQ locks “Has Users” on once workers are already assigned to a place at this level. If it will not untick, move those workers first.",
		);
	}
	if (flow.workers === "assigned") {
		switch (flow.descendantCases.kind) {
			case "none":
				steps.push("Leave “View Child Data” unticked.");
				break;
			case "all":
				steps.push(
					"Tick “View Child Data” and leave “View Child Data to Level” unset, so workers here receive cases from every place below them.",
				);
				break;
			case "down-to":
				steps.push(
					`Tick “View Child Data” and set “View Child Data to Level” to “${levelName(flow.descendantCases.levelUuid)}”. If you cannot see that second column, this project does not have the restore-file location toggle and the limit cannot be set.`,
				);
				break;
		}
	}
	return steps;
}

/** How a level's address book reads on the same page. */
function levelAddressBookSteps(
	level: OrganizationLevel,
	levelName: (uuid: string) => string,
): string[] {
	const book = level.addressBook;
	// The four arms map onto CommCare HQ's five sync-settings dials. Each
	// one traces cleanly through
	// `locations/sql_templates/get_location_fixture_ids.sql`, whose own
	// header comment then lists the combinations it calls ambiguous or
	// logically inconsistent. Nova's closed union is what keeps those
	// unauthorable, most sharply `include_only` together with
	// `expand_from_root`, which yields NO locations at all (the include-only
	// arm matches on `loc_id = loc.id`, and `expand_from_root` sets `loc_id`
	// to NULL), and which a person filling this page in by hand can reach.
	//
	// There is no "expand from root" checkbox: `location_types.js` puts a
	// synthetic *root* entry into the "Level to expand from" dropdown and
	// derives `expand_from_root` from whether it is selected.
	const alsoTop = (uuid: string | undefined): string[] =>
		uuid === undefined
			? []
			: [
					`Set “Include without expanding” to “${levelName(uuid)}”, so workers here also carry the top of the organization down to that rung.`,
				];
	const expandTo = (uuid: string | undefined): string[] =>
		uuid === undefined
			? []
			: [
					`Set “Level to expand to” to “${levelName(uuid)}” to stop descending there.`,
				];
	switch (book.reach) {
		case "own-branch":
			return [
				"Leave “Level to expand from” unset, so workers carry their own place, everything under it, and the chain above it.",
				...expandTo(book.downToLevelUuid),
				...alsoTop(book.alsoIncludeTopDownToLevelUuid),
			];
		case "own-branch-limited":
			return [
				`Set “Include only” to exactly these levels: ${book.levelUuids
					.map((uuid) => `“${levelName(uuid)}”`)
					.join(", ")}.`,
				/* "Include only" sits between the other two dials in the query's
				 * precedence, and loses to one while silently beating the other:
				 * the depth column takes `expand_to_id` first, so a level with
				 * "Level to expand to" set never reaches the include-only arm at
				 * all; and the expand-from column is guarded by
				 * `NOT EXISTS (… include_only …)`, so "Level to expand from" is
				 * ignored outright. Both are settings a reader would believe had
				 * taken effect. */
				"Leave “Level to expand to” and “Level to expand from” unset. CommCare HQ ignores “Include only” when the first is set, and ignores the second when “Include only” is set. Either way one of them silently does nothing.",
				...alsoTop(book.alsoIncludeTopDownToLevelUuid),
			];
		case "shared-branch":
			return [
				`Set “Level to expand from” to “${levelName(book.fromLevelUuid)}”, so the branch a worker carries starts there rather than at their own place and they can name their siblings.`,
				...expandTo(book.downToLevelUuid),
			];
		case "whole-organization":
			return [
				"Set “Level to expand from” to “root”, so workers here carry the whole organization.",
				...expandTo(book.downToLevelUuid),
			];
	}
}

function organizationSection(
	input: SetupArtifactInput,
): SetupArtifactSection | null {
	const levels = Object.values(organizationLevelsOf(input.doc));
	if (levels.length === 0) return null;
	const byUuid = organizationLevelsOf(input.doc);
	const levelName = (uuid: string): string =>
		ownRecordValue(byUuid, uuid)?.name ?? "the level with that id";

	// Parents before children, so the page can be filled top down:
	// CommCare HQ needs a parent level to exist before anything names it.
	const ordered: OrganizationLevel[] = [];
	const remaining = [...levels];
	while (remaining.length > 0) {
		const index = remaining.findIndex(
			(level) =>
				level.parentLevelUuid === undefined ||
				ordered.some((done) => done.uuid === level.parentLevelUuid),
		);
		if (index === -1) {
			ordered.push(...remaining);
			break;
		}
		const [next] = remaining.splice(index, 1);
		if (next !== undefined) ordered.push(next);
	}

	const steps = ordered.map((level) => {
		const parent =
			level.parentLevelUuid === undefined
				? "no parent, so it is a top level"
				: `parent “${levelName(level.parentLevelUuid)}”`;
		return step(
			level.uuid,
			`Add a level named “${level.name}” with “Type Code” “${level.code}” and ${parent}.`,
			[
				...levelCaseFlowSteps(level, levelName),
				...levelAddressBookSteps(level, levelName),
			],
		);
	});

	/* The three gates on this page answer differently, and the caveat below
	 * says which is which. `locations/views.py::LocationTypesView.dispatch`
	 * runs `can_edit_location_types` before `require_can_edit_locations`:
	 * the first checks `edit_apps` and raises a bare `Http404`, the second
	 * lands in `users/decorators.py::require_permission_raw`, whose non-ajax
	 * denial is `PermissionDenied`, a 403 and not a 404. The paid-feature gate
	 * inside `locations_access_required` uses `requires_privilege_raise404`,
	 * so it reads as a 404 too. */
	return {
		id: "organization",
		title: "Organization levels",
		summary: `The rungs of your organization. Create these on “${input.domain}” before you add any places, because every place names the level it stands at.`,
		url: `${hqBase(input.server)}/a/${input.domain}/settings/locations/location_types/`,
		steps: [
			step(
				"advanced-mode",
				"Tick “Advanced mode” at the top of the page first. Type Code, both expand settings, Include only, Include without expanding, and the user settings are hidden until you do.",
			),
			...steps,
		],
		caveats: [
			"Two levels cannot share a Type Code. CommCare HQ checks that as you type and refuses to save a duplicate.",
			"This page is the only way to define levels. CommCare HQ's location API cannot write them, and reads back only the name, code, parent, and two of the settings below, so Nova can neither create these for you nor check that you got them right.",
			"Saving this page replaces the whole list. A level you leave out is removed, and if that level still has places in it, CommCare HQ abandons the ENTIRE save with only a warning at the top of the page, so none of your other changes land either. Add to what is there rather than starting over.",
			"If you cannot open this page, what CommCare HQ says tells you which thing to fix. A page-not-found means either the project space does not have the paid Locations feature (ask support@dimagi.com), or your account lacks the “edit apps” permission. A permission-denied means you have “edit apps” but not “edit locations”. Either way the address is right, so ask whoever administers the project space rather than hunting for the page.",
		],
	};
}

function workerDataSection(
	input: SetupArtifactInput,
): SetupArtifactSection | null {
	const properties = Object.values(userPropertiesOf(input.doc));
	if (properties.length === 0) return null;
	const steps = properties.map((property) => {
		const detail = [
			property.required === true
				? "Tick Required, and under “Required for” choose Mobile Workers."
				: "Leave Required unticked.",
		];
		if (property.choices !== undefined && property.choices.length > 0) {
			/* The column is "Choices" on most projects and "Validation" on one
			 * with the regex-validation feature, where the choices box appears
			 * only after choosing "Choices" from a None / Choices / Regex
			 * group. Naming both spellings costs a clause and saves a hunt. */
			detail.push(
				`Set its choices to exactly: ${property.choices.map((choice) => `“${choice}”`).join(", ")}. If that column reads “Validation” rather than “Choices”, choose “Choices” first to get the list.`,
			);
		}
		return step(
			property.uuid,
			`Add a field with “User Property” “${property.slug}” and label “${property.label}”.`,
			detail,
		);
	});
	return {
		id: "worker-data",
		title: "Worker information",
		summary: `The information your workers carry. Create one field per row on “${input.domain}” so the app can read them and so you can fill them in when you create workers.`,
		url: `${hqBase(input.server)}/a/${input.domain}/settings/users/user_data/`,
		steps,
		caveats: [
			"Required always means required for mobile workers here. Nova creates mobile workers only, so web users are unaffected.",
			"Property names are what the app reads. Changing one on CommCare HQ without changing it in Nova will make the app read a blank value.",
			"CommCare HQ has no API for this page, so Nova cannot create these fields for you and cannot tell whether they already exist.",
		],
	};
}

function automationsSection(
	input: SetupArtifactInput,
): SetupArtifactSection | null {
	const automations = Object.values(input.doc.automations ?? {});
	if (automations.length === 0) return null;
	const base = hqBase(input.server);
	const steps: SetupArtifactStep[] = [];
	const caveats = new Set<string>();
	for (const automation of automations) {
		const guide = buildAutomationSetupGuide(
			input.doc,
			automation,
			input.locations,
		);
		steps.push(
			step(
				automation.uuid,
				`${guide.title}. Requires ${guide.requiredPlan}. Create it at ${
					automation.kind === "case-update"
						? `${base}/a/${input.domain}/data/edit/automatic_updates/`
						: `${base}/a/${input.domain}/messaging/conditional/`
				}`,
				guide.steps,
			),
		);
		for (const caveat of guide.caveats) caveats.add(caveat);
	}
	return {
		id: "automations",
		title: "Automations",
		summary: `The rules that run on their own. CommCare HQ has no API for these, so each one is created by hand on “${input.domain}”. Changing an automation in Nova does not change one you already made there.`,
		url: null,
		steps,
		caveats: [...caveats],
	};
}

function buildAndReleaseSection(
	input: SetupArtifactInput,
): SetupArtifactSection {
	const base = hqBase(input.server);
	const releases =
		input.hqAppId === null
			? null
			: `${base}/a/${input.domain}/apps/view/${input.hqAppId}/releases/`;
	return {
		id: "build-and-release",
		title: "Make a version and release it",
		summary:
			"Nova puts the app on your project space. Turning it into something workers can open is two clicks there, and only a signed-in person can make them.",
		url: releases,
		steps: [
			step("open-releases", "Open the app's Releases screen on CommCare HQ."),
			step(
				"make-version",
				"Choose Make new version, and wait for it to finish.",
			),
			step("release", "Star the new version to release it."),
		],
		caveats: [
			"CommCare HQ only lets a signed-in person do this. Its build and release pages accept a browser session and not an API key, so Nova watches for it rather than doing it.",
			"CommCare HQ validates the app again while it builds. If it reports errors there, they are about the version you just published, so fix them in Nova and publish again.",
			"Web Apps serves the released version, so an app with a version but no released one still opens as whatever was released before.",
		],
	};
}

function webAppsSection(input: SetupArtifactInput): SetupArtifactSection {
	return {
		id: "web-apps",
		title: "Web Apps availability",
		summary: `Whether “${input.domain}” can open this app in a browser at all.`,
		url: `${hqBase(input.server)}/a/${input.domain}/cloudcare/apps/v2/`,
		steps: [
			step(
				"check-listed",
				"Open Web Apps on the project space and check the app is listed.",
			),
			step(
				"enable-web-app",
				"If it is not listed, open the app's Settings on CommCare HQ and tick “Web App”.",
				[
					"CommCare HQ sets that box when the app is created, from whether the project had Web Apps at that moment, so an app published before the feature was on starts with it off.",
					"You do not need to publish again. It is an ordinary app setting you can change at any time.",
				],
			),
		],
		caveats: [
			"Nova cannot read that setting back, so it reports what it can see: a released version that serves its install file. If the app still does not appear in Web Apps, the “Web App” setting is the first thing to check.",
		],
	};
}

/** One lookup table this app reads, and where it stands on the target. */
export interface SetupArtifactLookupTable {
	/** The name a person sees in Nova. */
	readonly name: string;
	/** The name CommCare HQ shows, and the one the app looks up at runtime. */
	readonly tag: string;
	/** Whether the project space already holds Nova's copy of it. */
	readonly pushed: boolean;
	/** True when Nova took over a table it did not create. */
	readonly adopted: boolean;
}

/**
 * What Nova put on the project space, and what a person should know about
 * it.
 *
 * Unlike its neighbours this is a record rather than an instruction, so it
 * carries no numbered steps to follow — but it is not decoration. It is
 * the only place an author can see that Nova now owns a table on somebody
 * else's server, which is exactly the fact they will want when a
 * colleague asks why `districts` changed.
 */
function lookupTablesSection(
	input: SetupArtifactInput,
): SetupArtifactSection | null {
	const tables = input.lookupTables ?? [];
	if (tables.length === 0) return null;
	const steps = tables.map((table) => ({
		id: table.tag,
		text: `${table.name} (${table.tag})`,
		detail: [
			table.pushed
				? `Nova keeps this on “${input.domain}”, replacing its rows whenever you publish.`
				: `Nova will put this on “${input.domain}” the next time you publish.`,
			...(table.adopted
				? [
						"You chose to use the table already on that project space rather than a new one, so publishing replaces its rows.",
					]
				: []),
		],
	}));
	return {
		id: "lookup-tables",
		title: "Project data",
		summary: `The lookup tables this app reads. Nova puts these on “${input.domain}” before it sends the app, because the app looks them up by name while somebody is using it.`,
		url: `${hqBase(input.server)}/a/${input.domain}/fixtures/`,
		steps,
		caveats: [
			"Publishing replaces the rows of these tables on CommCare HQ with the rows in Nova. Anything edited there is overwritten.",
			"Renaming a table in Project data makes a new one on CommCare HQ. The old one stays where it is, so nothing anybody else built on it breaks.",
		],
	};
}

/**
 * The custom fields a place can carry, which only CommCare HQ can define.
 *
 * Nova SENDS these values with every place, and `custom_data_fields`
 * decides what happens to each one: a slug this project space defines is
 * a proper field, and one it does not is kept as loose data nothing can
 * validate or filter on. A field this page marks required with no value
 * on a place refuses that whole batch, which is the failure this section
 * exists to prevent rather than explain afterwards.
 *
 * There is no REST resource for the definition — `LocationFieldsView` is
 * a session-authenticated page — so this stays an instruction however much
 * else Nova can drive.
 */
function placeDataSection(
	input: SetupArtifactInput,
): SetupArtifactSection | null {
	const properties = orderedLocationProperties(input.doc);
	if (properties.length === 0) return null;
	const steps = properties.map((property) =>
		step(
			property.uuid,
			`Add a field labelled “${property.label}” with “Property Name” “${property.slug}”.`,
			[
				property.required === true
					? "Tick Required, so CommCare HQ holds every place to it the way Nova does."
					: "Leave Required unticked.",
				...(property.choices === undefined || property.choices.length === 0
					? []
					: [
							`Set its accepted values to exactly these, one per line: ${property.choices.join(", ")}.`,
						]),
			],
		),
	);
	return {
		id: "place-data",
		title: "Place information",
		summary: `The extra information your places carry. Add these on “${input.domain}” before you publish, so the values Nova sends land in real fields rather than as loose data.`,
		url: `${hqBase(input.server)}/a/${input.domain}/settings/locations/fields/`,
		steps,
		caveats: [
			"A Property Name has to match exactly. CommCare HQ keeps a value whose name it does not recognize, but nothing there can validate or filter on it.",
			"A field marked required here with no value on one of your places makes CommCare HQ refuse that whole group of places, so fill the value in first or leave the field optional.",
			"This page is the only way to define these. CommCare HQ's location API cannot write them, so Nova can neither create them for you nor check that you got them right.",
		],
	};
}

/**
 * The places Nova put on the project space.
 *
 * A record rather than an instruction, and the only section that is: Nova
 * creates and updates every one of these itself. What it is for is the
 * two facts a person cannot see from either side alone — how much of
 * their organization is over there, and which of those places Nova took
 * over rather than made.
 *
 * Summarized by level rather than listed. A tree runs to thousands of
 * places, and the level codes are what a person compares against the
 * Organization Levels page anyway.
 */
function placesSection(input: SetupArtifactInput): SetupArtifactSection | null {
	const levels = organizationLevelsOf(input.doc);
	const live = input.locations.filter(
		(location) => location.archivedAt === null,
	);
	if (live.length === 0) return null;
	const byLevel = new Map<string, { total: number; pushed: number }>();
	let adopted = 0;
	for (const place of live) {
		const levelName = ownRecordValue(levels, place.levelUuid)?.name ?? "Places";
		const tally = byLevel.get(levelName) ?? { total: 0, pushed: 0 };
		tally.total += 1;
		const pushedPlace = input.pushedPlaces?.get(place.id);
		if (pushedPlace !== undefined) {
			tally.pushed += 1;
			if (pushedPlace.adopted) adopted += 1;
		}
		byLevel.set(levelName, tally);
	}
	const steps = [...byLevel.entries()].map(([levelName, tally]) =>
		step(levelName, `${levelName}: ${countOf(tally.total, "place")}`, [
			tally.pushed === tally.total
				? `All of these are on “${input.domain}”.`
				: tally.pushed === 0
					? `Nova will put these on “${input.domain}” the next time you publish.`
					: `${tally.pushed} of these are on “${input.domain}”; Nova sends the rest the next time you publish.`,
		]),
	);
	return {
		id: "places",
		title: "Places",
		summary: `The places in your organization. Nova creates and updates these on “${input.domain}” itself, parents first, before it sends the app.`,
		url: `${hqBase(input.server)}/a/${input.domain}/settings/locations/list/`,
		steps,
		caveats: [
			...(adopted === 0
				? []
				: [
						`You chose to use ${countOf(adopted, "place")} that “${input.domain}” already had rather than new ones, so publishing keeps ${adopted === 1 ? "it" : "them"} in step with Nova.`,
					]),
			"Archiving a place in Nova stops Nova sending it, and leaves the one on CommCare HQ exactly where it is. Archive it there too if you want it out of the way, and note that its site code stays reserved either way.",
			"A place's site code is set once in Nova, because it is what CommCare HQ matches on. Renaming a place is free; the code follows it around.",
		],
	};
}

/** "1 place" / "12 places". */
function countOf(count: number, noun: string): string {
	return count === 1
		? `1 ${noun}`
		: `${count.toLocaleString("en-US")} ${noun}s`;
}

/**
 * Build the artifact for one target.
 *
 * Sections appear only when the app actually has that content, so an app
 * with no organization does not get a page of instructions about levels it
 * does not have. The last two always appear once there is somewhere to
 * apply them, because they are true of every published app.
 *
 * Project data comes first because that is the order things happen in: the
 * tables go on the project space before the app does.
 */
export function buildSetupArtifact(input: SetupArtifactInput): SetupArtifact {
	const sections = [
		lookupTablesSection(input),
		workerDataSection(input),
		organizationSection(input),
		placeDataSection(input),
		placesSection(input),
		automationsSection(input),
		buildAndReleaseSection(input),
		webAppsSection(input),
	].filter((section): section is SetupArtifactSection => section !== null);
	return {
		server: input.server,
		domain: input.domain,
		hqAppId: input.hqAppId,
		sections,
	};
}
