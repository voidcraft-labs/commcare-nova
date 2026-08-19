/**
 * The setup artifact.
 *
 * Three properties are the reason it exists, and each is asserted here:
 * it is target-aware (real URLs on the real project space), it never
 * claims Nova installed a prerequisite, and it says nothing about content
 * the app does not have.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { resolvePreviewDeploymentTarget } from "../previewTarget";
import { buildSetupArtifact } from "../setupArtifact";
import type { DeploymentRecord } from "../types";

function baseDoc() {
	const { fieldParent: _fieldParent, ...doc } = buildDoc({
		appName: "Vaccine Tracker",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							},
						],
					},
				],
			},
		],
	});
	return doc as never;
}

function artifact(overrides: Record<string, unknown> = {}) {
	return buildSetupArtifact({
		doc: baseDoc(),
		server: "production",
		domain: "rhi-bihar",
		hqAppId: "hq-abc",
		locations: [],
		...overrides,
	});
}

describe("target awareness", () => {
	it("names the real project space in every URL", () => {
		const result = artifact();
		for (const section of result.sections) {
			if (section.url === null) continue;
			expect(section.url).toContain("/a/rhi-bihar/");
		}
	});

	it("points at the server the deployment is actually on", () => {
		const india = artifact({ server: "india" });
		const release = india.sections.find((s) => s.id === "build-and-release");
		expect(release?.url).toContain("https://india.commcarehq.org/");
	});

	it("links the app's own releases screen once there is an app id", () => {
		expect(
			artifact().sections.find((s) => s.id === "build-and-release")?.url,
		).toBe("https://www.commcarehq.org/a/rhi-bihar/apps/view/hq-abc/releases/");
		expect(
			artifact({ hqAppId: null }).sections.find(
				(s) => s.id === "build-and-release",
			)?.url,
		).toBeNull();
	});
});

describe("only what the app actually has", () => {
	it("omits worker information when the app declares none", () => {
		expect(artifact().sections.some((s) => s.id === "worker-data")).toBe(false);
	});

	it("omits Project data when the app reads no lookup tables", () => {
		expect(artifact().sections.some((s) => s.id === "lookup-tables")).toBe(
			false,
		);
	});

	it("omits organization when the app has no levels", () => {
		expect(artifact().sections.some((s) => s.id === "organization")).toBe(
			false,
		);
	});

	it("omits place information when the app models none", () => {
		expect(artifact().sections.some((s) => s.id === "place-data")).toBe(false);
	});

	it("omits places when the app has none, whatever its levels say", () => {
		expect(artifact().sections.some((s) => s.id === "places")).toBe(false);
	});

	it("always carries the two that are true of every published app", () => {
		const ids = artifact().sections.map((s) => s.id);
		expect(ids).toContain("build-and-release");
		expect(ids).toContain("web-apps");
	});
});

describe("Project data, the first section that is a record", () => {
	/* Every other section tells somebody what to do on the project space.
	 * This one says what Nova already did there, which is the shape each
	 * section takes as its push driver ships. */
	function withTables(
		tables: readonly {
			name: string;
			tag: string;
			pushed: boolean;
			adopted: boolean;
		}[],
	) {
		return artifact({ lookupTables: tables });
	}

	it("names each table the way both Nova and CommCare HQ do", () => {
		const section = withTables([
			{ name: "Districts", tag: "districts", pushed: true, adopted: false },
		]).sections.find((s) => s.id === "lookup-tables");
		expect(section?.title).toBe("Project data");
		expect(section?.steps[0]?.text).toBe("Districts (districts)");
		expect(section?.url).toBe(
			"https://www.commcarehq.org/a/rhi-bihar/fixtures/",
		);
	});

	it("says whether the table is there yet, in the present tense", () => {
		const section = withTables([
			{ name: "Districts", tag: "districts", pushed: true, adopted: false },
			{ name: "Statuses", tag: "statuses", pushed: false, adopted: false },
		]).sections.find((s) => s.id === "lookup-tables");
		expect(section?.steps[0]?.detail[0]).toContain("Nova keeps this");
		expect(section?.steps[1]?.detail[0]).toContain("the next time you publish");
	});

	it("says so when somebody took an existing table over", () => {
		const section = withTables([
			{ name: "Districts", tag: "districts", pushed: true, adopted: true },
		]).sections.find((s) => s.id === "lookup-tables");
		expect(section?.steps[0]?.detail.join(" ")).toContain("You chose to use");
	});

	it("warns that publishing overwrites, and that a rename leaves the old one", () => {
		const section = withTables([
			{ name: "Districts", tag: "districts", pushed: true, adopted: false },
		]).sections.find((s) => s.id === "lookup-tables");
		expect(section?.caveats.join(" ")).toContain("overwritten");
		expect(section?.caveats.join(" ")).toContain("The old one stays");
	});

	it("comes first, because the data goes on before the app", () => {
		const ids = withTables([
			{ name: "Districts", tag: "districts", pushed: true, adopted: false },
		]).sections.map((s) => s.id);
		expect(ids[0]).toBe("lookup-tables");
	});
});

describe("never claims a prerequisite was installed", () => {
	it("says who has to make the version and release it", () => {
		const release = artifact().sections.find(
			(s) => s.id === "build-and-release",
		);
		expect(release?.caveats.join(" ")).toMatch(/signed-in person/i);
		expect(release?.caveats.join(" ")).toMatch(/not an API key/i);
	});

	it("sends the reader to the Web App setting, not to a second publish", () => {
		// `cloudcare_enabled` is initialized at import from the project's
		// privilege, but it is an ordinary editable app setting after that
		// (`commcare-app-settings.yml` id `cloudcare_enabled`, name "Web
		// App"). Telling somebody to publish again would leave a duplicate
		// app on their project space to achieve what a checkbox does.
		const webApps = artifact().sections.find((s) => s.id === "web-apps");
		const text = JSON.stringify(webApps);
		expect(text).toContain("“Web App”");
		expect(text).toMatch(/do not need to publish again/i);
		expect(text).not.toMatch(/publish again once/i);
	});
});

describe("preview target resolution", () => {
	function deployment(state: string, domain: string, resumePhase = null) {
		return { state, domain, resumePhase } as unknown as Pick<
			DeploymentRecord,
			"state" | "resumePhase" | "domain"
		>;
	}

	it("names a project space once one deployment reached uploaded", () => {
		expect(
			resolvePreviewDeploymentTarget([deployment("uploaded", "acme")]),
		).toEqual({ kind: "known", domain: "acme" });
	});

	it("says nothing while the app is on no project space", () => {
		expect(
			resolvePreviewDeploymentTarget([deployment("preflight", "acme")]),
		).toEqual({ kind: "none" });
	});

	it("never counts a deployment refused before its app got there", () => {
		expect(
			resolvePreviewDeploymentTarget([
				deployment("incomplete", "acme", "upload" as never),
			]),
		).toEqual({ kind: "none" });
	});

	it("keeps naming the space when a LATER phase failed", () => {
		// A probe that could not be checked did not undo the upload, and
		// withdrawing `commcare_project` would change what expressions
		// evaluate to for a reason that has nothing to do with the app.
		expect(
			resolvePreviewDeploymentTarget([
				deployment("incomplete", "acme", "probe" as never),
			]),
		).toEqual({ kind: "known", domain: "acme" });
	});

	it("refuses to choose between two real answers", () => {
		expect(
			resolvePreviewDeploymentTarget([
				deployment("runnable", "acme"),
				deployment("uploaded", "beta"),
			]).kind,
		).toBe("ambiguous");
	});
});

/**
 * The two document-derived sections, actually generated.
 *
 * These exist because the first version of the organization section named
 * five controls that are not on CommCare HQ's page, and nothing caught it:
 * the suite only asserted the section was OMITTED for an app with no
 * levels. A section whose whole value is "followable instructions with the
 * values filled in" has to be checked against the page it describes.
 */
describe("organization levels", () => {
	const state = testUuid("11111111");
	const district = testUuid("22222222");

	function withLevels(): never {
		const doc = baseDoc() as Record<string, unknown>;
		doc.organizationLevels = {
			[state]: {
				uuid: state,
				code: "state",
				name: "State",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "whole-organization" },
			},
			[district]: {
				uuid: district,
				code: "district",
				name: "District",
				parentLevelUuid: state,
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "all" },
				},
				addressBook: { reach: "own-branch" },
			},
		};
		doc.organizationLevelOrder = [district, state];
		return doc as never;
	}

	function section() {
		const result = artifact({ doc: withLevels() });
		const found = result.sections.find((s) => s.id === "organization");
		if (found === undefined) throw new Error("organization section missing");
		return found;
	}

	it("tells the reader to turn on Advanced mode first", () => {
		// Six of the eight controls carry `visible: advanced_mode`, so every
		// instruction below is unfollowable until this one is done.
		expect(section().steps[0]?.text).toMatch(/advanced mode/i);
	});

	it("orders parents before children, because a child names its parent", () => {
		const names = section()
			.steps.map((s) => s.text)
			.filter((text) => text.includes("Add a level"));
		expect(names[0]).toContain("“State”");
		expect(names[1]).toContain("“District”");
		expect(names[1]).toContain("parent “State”");
	});

	it("names the controls CommCare HQ actually shows", () => {
		const text = JSON.stringify(section().steps);
		// From `locations/templates/locations/location_types.html`.
		expect(text).toContain("Type Code");
		expect(text).toContain("Owns Cases");
		expect(text).toContain("Has Users");
		expect(text).toContain("View Child Data");
		expect(text).toContain("Level to expand from");
		// Names Nova uses internally, and CommCare HQ does not show.
		expect(text).not.toContain("Location has users");
		expect(text).not.toContain("Location shares cases");
		expect(text).not.toContain("organization level code");
	});

	it("never asks for an Expand from root checkbox, which does not exist", () => {
		// `location_types.js` puts a synthetic *root* entry in the "Level to
		// expand from" dropdown and derives `expand_from_root` from it.
		const text = JSON.stringify(section().steps);
		expect(text).not.toMatch(/tick “expand from root”/i);
		expect(text).toContain("“Level to expand from” to “root”");
	});

	it("warns when a control sits behind a project toggle", () => {
		// "Has Users" and "View Child Data to Level" are wrapped in
		// `{% if request|toggle_enabled:"USH_RESTORE_FILE_LOCATION_CASE_SYNC_RESTRICTION" %}`.
		const detail = section()
			.steps.flatMap((s) => s.detail)
			.join(" ");
		expect(detail).toMatch(/cannot see that column/i);
	});

	it("tells the reader to UNTICK Has Users, because it arrives ticked", () => {
		/* `locations/models.py`: `has_users = BooleanField(default=True)`,
		 * and `location_types.js` seeds a new row's `has_users_setting` to
		 * true ("new loc types default to true") and posts it on every save.
		 * "Tick Has Users" for a level that holds workers would be busywork;
		 * "leave it unticked" for one that does not is simply wrong. */
		const detail = JSON.stringify(section().steps);
		expect(detail).toContain("Untick “Has Users”; it arrives ticked");
		expect(detail).not.toMatch(/leave “has users” unticked/i);
		expect(detail).not.toMatch(/tick “has users”\./i);
	});

	it("does not promise a hidden Has Users column means nothing to do", () => {
		/* The column being absent does not make the setting absent: the JS
		 * posts `has_users` whether or not it is rendered, so the level is
		 * saved allowing workers. For a level that HOLDS workers that is
		 * harmless and "nothing to do" is true; for one that does not, it is
		 * exactly the wrong thing to say, and that is the arm asserted here
		 * (“State”, whose `caseFlow.workers` is `none`). */
		const noWorkers = section().steps.find((step) =>
			step.text.includes("“State”"),
		);
		const detail = (noWorkers?.detail ?? []).join(" ");
		expect(detail).not.toMatch(/nothing to do/i);
		expect(detail).toContain("will allow workers to be assigned here");
	});

	it("tells an Include-only level to leave BOTH expand dials unset", () => {
		/* `get_location_fixture_ids.sql` puts "Include only" between the other
		 * two dials, losing to one and silently beating the other: the depth
		 * column takes `expand_to_id` first, so include-only never reaches its
		 * `-3` arm when "Level to expand to" is set; and the expand-from column
		 * is guarded by `NOT EXISTS (… include_only …)`, so "Level to expand
		 * from" is discarded. A reader who set either would believe it took
		 * effect. */
		const doc = baseDoc() as Record<string, unknown>;
		doc.organizationLevels = {
			[state]: {
				uuid: state,
				code: "state",
				name: "State",
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "none" },
				},
				addressBook: { reach: "own-branch-limited", levelUuids: [state] },
			},
		};
		doc.organizationLevelOrder = [state];
		const limited = artifact({ doc: doc as never }).sections.find(
			(s) => s.id === "organization",
		);
		const detail = JSON.stringify(limited?.steps);
		expect(detail).toContain("Set “Include only” to exactly these levels");
		expect(detail).toContain(
			"Leave “Level to expand to” and “Level to expand from” unset",
		);
	});

	it("warns that a level with places aborts the WHOLE save, not just itself", () => {
		/* `views.py::remove_old_location_types` returns False on the first
		 * omitted level that still has locations, and `post` then returns
		 * `self.get(...)` before a single `_mk_loctype` runs — so every other
		 * edit on the page is silently lost behind one warning banner. */
		const caveats = section().caveats.join(" ");
		expect(caveats).toMatch(/abandons the ENTIRE save/i);
	});

	it("does not claim all three ways in are refused alike, because two answers exist", () => {
		/* `locations/views.py::LocationTypesView.dispatch` stacks three
		 * gates, and they do NOT answer the same way. Two raise `Http404`:
		 * `permissions.py::locations_access_required` via
		 * `requires_privilege_raise404(privileges.LOCATIONS)`, and
		 * `::can_edit_location_types`, whose `user_can_edit_location_types`
		 * checks `edit_apps` and raises a bare `Http404`. The third,
		 * `::require_can_edit_locations`, goes through
		 * `users/decorators.py::require_permission_raw`, whose non-ajax
		 * denial is `PermissionDenied` — a 403. Decorators run top down, so
		 * the `edit_apps` 404 fires first and the 403 is only reachable with
		 * `edit_apps` but not `edit_locations`. Saying "all three answer
		 * with a page-not-found" sends somebody looking for a missing
		 * feature when their account is one permission short. */
		const caveats = section().caveats.join(" ");
		expect(caveats).toMatch(/page-not-found/i);
		expect(caveats).toMatch(/permission-denied/i);
		expect(caveats).toContain("edit apps");
		expect(caveats).toContain("edit locations");
		expect(caveats).not.toMatch(/answers all three the same way/i);
	});

	it("does not claim the location API can read these settings back", () => {
		/* `locations/resources/v0_5.py::LocationTypeResource.Meta.fields` is
		 * exactly id, domain, name, code, parent_type, administrative,
		 * shares_cases, view_descendants — none of the expand_*, include_*,
		 * or has_users fields this section configures. */
		const caveats = section().caveats.join(" ");
		expect(caveats).not.toMatch(/can read them but not write/i);
		expect(caveats).toContain("cannot write them");
	});

	it("does not claim a level's Type Code is permanent, because it is not", () => {
		/* `location_types.html` renders Type Code as a plain editable input
		 * with no `disable` binding, and `views.py::_mk_loctype` writes
		 * `loc_type.code = unicode_slug(code)` on every save. Only
		 * uniqueness is enforced. */
		const caveats = section().caveats.join(" ");
		expect(caveats).not.toMatch(/permanent|cannot change|codes cannot/i);
		expect(caveats).toContain("Two levels cannot share a Type Code");
	});
});

describe("place information", () => {
	/* Nova SENDS these values with every place. A slug the project space
	 * defines becomes a real field; one it does not is kept as loose data
	 * nothing can validate or filter on, and a field marked required with
	 * no value refuses the whole batch. There is no REST resource for the
	 * definition, so this stays an instruction. */
	const population = testUuid("33333333");

	function withProperties(): never {
		const doc = baseDoc() as Record<string, unknown>;
		doc.locationProperties = {
			[population]: {
				uuid: population,
				slug: "population",
				label: "Population",
				required: true,
				choices: ["small", "large"],
			},
		};
		doc.locationPropertyOrder = [population];
		return doc as never;
	}

	function section() {
		const found = artifact({ doc: withProperties() }).sections.find(
			(s) => s.id === "place-data",
		);
		if (found === undefined) throw new Error("place-data section missing");
		return found;
	}

	it("points at the location fields page on the real project space", () => {
		expect(section().url).toBe(
			"https://www.commcarehq.org/a/rhi-bihar/settings/locations/fields/",
		);
	});

	it("names the slug CommCare HQ has to match exactly", () => {
		expect(section().steps[0]?.text).toContain("“population”");
		expect(section().steps[0]?.detail[0]).toMatch(/tick required/i);
		expect(section().steps[0]?.detail[1]).toContain("small, large");
	});

	it("warns that a required field with no value refuses the whole batch", () => {
		expect(section().caveats.join(" ")).toMatch(/whole group of places/i);
	});
});

describe("places, the section that is purely a record", () => {
	const state = testUuid("11111111");
	const colorado = testUuid("44444444");
	const boulder = testUuid("55555555");

	function withLevel(): never {
		const doc = baseDoc() as Record<string, unknown>;
		doc.organizationLevels = {
			[state]: {
				uuid: state,
				code: "state",
				name: "State",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
		};
		doc.organizationLevelOrder = [state];
		return doc as never;
	}

	function place(over: Record<string, unknown> = {}) {
		return {
			id: colorado,
			levelUuid: state,
			parentId: null,
			siteCode: "colorado",
			name: "Colorado",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			archivedAt: null,
			orderKey: "a0",
			...over,
		} as never;
	}

	function section(overrides: Record<string, unknown> = {}) {
		const found = artifact({
			doc: withLevel(),
			locations: [place()],
			...overrides,
		}).sections.find((s) => s.id === "places");
		if (found === undefined) throw new Error("places section missing");
		return found;
	}

	it("counts by level rather than listing a tree of thousands", () => {
		const found = section({
			locations: [
				place(),
				place({ id: boulder, siteCode: "boulder", name: "Boulder" }),
			],
		});
		expect(found.steps).toHaveLength(1);
		expect(found.steps[0]?.text).toBe("State: 2 places");
	});

	it("says what a publish WILL do while nothing has been pushed", () => {
		expect(section().steps[0]?.detail[0]).toMatch(/next time you publish/i);
	});

	it("says what is already there once the ledger names it", () => {
		const found = section({
			pushedPlaces: new Map([[colorado, { adopted: false }]]),
		});
		expect(found.steps[0]?.detail[0]).toContain("All of these are on");
	});

	it("says so when somebody took an existing place over", () => {
		const found = section({
			pushedPlaces: new Map([[colorado, { adopted: true }]]),
		});
		expect(found.caveats[0]).toMatch(/already had rather than new ones/i);
	});

	it("warns that archiving in Nova leaves the place on CommCare HQ", () => {
		// v0.6 exposes no archive and no delete, and `validate_site_code`
		// counts archived rows, so the code stays reserved either way.
		expect(section().caveats.join(" ")).toMatch(/site code stays reserved/i);
	});

	it("leaves an archived place out of the count entirely", () => {
		expect(
			artifact({
				doc: withLevel(),
				locations: [place({ archivedAt: new Date() })],
			}).sections.some((s) => s.id === "places"),
		).toBe(false);
	});
});

describe("worker information", () => {
	const block = testUuid("33333333");

	function withProperty(required: boolean): never {
		const doc = baseDoc() as Record<string, unknown>;
		doc.userProperties = {
			[block]: {
				uuid: block,
				slug: "block",
				label: "Block",
				...(required ? { required: true } : {}),
				choices: ["North", "South"],
			},
		};
		doc.userPropertyOrder = [block];
		return doc as never;
	}

	function section(required: boolean) {
		const result = artifact({ doc: withProperty(required) });
		const found = result.sections.find((s) => s.id === "worker-data");
		if (found === undefined) throw new Error("worker-data section missing");
		return found;
	}

	it("names the column CommCare HQ shows, and carries the exact values", () => {
		const first = section(false).steps[0];
		expect(first?.text).toContain("“User Property” “block”");
		expect(first?.text).toContain("“Block”");
		expect(first?.detail.join(" ")).toContain("“North”, “South”");
	});

	it("says Mobile Workers for a required property, because Nova makes only those", () => {
		expect(section(true).steps[0]?.detail.join(" ")).toMatch(
			/Required for.*Mobile Workers/i,
		);
		expect(section(false).steps[0]?.detail.join(" ")).toMatch(
			/Leave Required unticked/i,
		);
	});
});
