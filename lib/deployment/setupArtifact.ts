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
// **It never claims a prerequisite was installed.** Each section here
// exists precisely because CommCare HQ exposes no API-key path for it:
// the user-data schema and organization levels are session-only HTML
// forms (`users/views/mobile/custom_data_fields.py::UserFieldsView`,
// `locations/views.py::LocationTypesView`), automations have no REST
// resource at all, and building and releasing sit behind
// `require_can_edit_apps`. When a push driver ships for one of these, its
// section becomes a record of what Nova did rather than an instruction —
// the same artifact, one section rewritten, not a second document.

import { buildAutomationSetupGuide } from "@/lib/automations/setupGuidance";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import type { BlueprintDoc, OrganizationLevel } from "@/lib/domain";
import {
	organizationLevelsOf,
	ownRecordValue,
	userPropertiesOf,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";

type SetupArtifactSectionId =
	| "worker-data"
	| "organization"
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
}

function hqBase(server: CommCareServer): string {
	return COMMCARE_SERVERS[server].baseUrl;
}

/**
 * How a level's case flow reads on CommCare HQ's Organization Levels page.
 *
 * The labels here are the ones actually on that page
 * (`locations/templates/locations/location_types.html`), not Nova's
 * vocabulary and not the model field names — an instruction naming a
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
	steps.push(
		flow.workers === "assigned"
			? "Tick “Has Users”. If you cannot see that column, this project does not have the restore-file location toggle and workers can be assigned here anyway."
			: "Leave “Has Users” unticked. If you cannot see that column, nothing to do.",
	);
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
	// The four arms map onto CommCare HQ's five sync-settings dials. Only
	// these four combinations are named by
	// `locations/sql_templates/get_location_fixture_ids.sql`; the rest are
	// states that query calls undefined, which is why Nova has no way to
	// author them and this projection has no way to describe them.
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
					.join(
						", ",
					)}. Leave “Level to expand to” unset, because CommCare HQ ignores “Include only” whenever it is set.`,
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

	// Parents before children, so the page can be filled top down —
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
			"Organization level codes are permanent on CommCare HQ. The names can change later; the codes cannot, because they become part of how every place is addressed.",
			"This page is the only way to define levels. CommCare HQ's location API can read them but not write them, so Nova cannot create them for you.",
			"Saving this page replaces the whole list. A level you leave out is removed, so add to what is there rather than starting over.",
			"Locations need the paid Locations feature on the project. Ask support@dimagi.com if the page is not available.",
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
			detail.push(
				`Set its choices to exactly: ${property.choices.map((choice) => `“${choice}”`).join(", ")}.`,
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

/**
 * Build the artifact for one target.
 *
 * Sections appear only when the app actually has that content, so an app
 * with no organization does not get a page of instructions about levels it
 * does not have. The last two always appear once there is somewhere to
 * apply them, because they are true of every published app.
 */
export function buildSetupArtifact(input: SetupArtifactInput): SetupArtifact {
	const sections = [
		workerDataSection(input),
		organizationSection(input),
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
