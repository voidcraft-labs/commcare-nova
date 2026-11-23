/**
 * An owner rule of an app brought in from CommCare HQ that the places
 * CommCare HQ holds cannot satisfy is asked of the person, named by its level
 * and the zero or two places it met, and never settled by choosing a place;
 * the one explicit rule Nova offers gives those cases to the worker who fills
 * in the form, and the document under it holds no rule the places refuse.
 */

import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqLocation } from "@/lib/commcare/hq/locations";
import {
	LOCATION_LEVELS,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/domain";
import { managedPlacesOwnerRules, workerOwnerMutations } from "../ownerRules";
import { planManagedPlaces } from "../places";
import {
	keptOwnerRuleChoices,
	type ReviewOwnerRule,
	resolveOwnerRuleChoices,
} from "../reviewTypes";

function place(
	siteCode: string,
	locationTypeCode: string,
	parentLocationId: string | null,
): HqLocation {
	return {
		locationId: `hq-${siteCode}`,
		name: siteCode.toUpperCase(),
		siteCode,
		locationTypeCode,
		parentLocationId,
		latitude: null,
		longitude: null,
		values: {},
	};
}

const planOf = (hqPlaces: readonly HqLocation[]) =>
	planManagedPlaces({
		hqPlaces,
		levels: LOCATION_LEVELS,
		properties: [],
		mode: "birth",
	});

// Regions own cases, districts do not, clinics do: a case a region owns
// goes to the clinic below it.
const doc = locationOwnerFixture("multirung");
const regionTree = [
	place("east", "region", null),
	place("east-lakes", "district", "hq-east"),
];
const twoClinics = planOf([
	...regionTree,
	place("east-a", "clinic", "hq-east-lakes"),
	place("east-b", "clinic", "hq-east-lakes"),
]);
const clinic = LOCATION_LEVELS.find((level) => level.code === "clinic");

function owners(of: BlueprintDoc): number {
	return Object.values(of.forms)
		.flatMap((form) => form.caseOperations ?? [])
		.filter((operation) => operation.owner !== undefined).length;
}

describe("managedPlacesOwnerRules", () => {
	it("asks about a rule with two places at its level below one owner, naming both", () => {
		expect(twoClinics.findings).toEqual([]);
		expect(managedPlacesOwnerRules(doc, twoClinics)).toEqual([
			{
				level: "clinic",
				levelName: clinic?.name,
				conflict: {
					kind: "two-places",
					source: "EAST",
					places: ["EAST-A", "EAST-B"],
				},
				forms: ["Transfer"],
			},
		]);
	});

	it("asks about a rule with no place at its level below an owner", () => {
		expect(managedPlacesOwnerRules(doc, planOf(regionTree))).toEqual([
			{
				level: "clinic",
				levelName: clinic?.name,
				conflict: { kind: "no-place", source: "EAST" },
				forms: ["Transfer"],
			},
		]);
	});

	it("asks nothing where one place stands at the level below each owner", () => {
		const oneClinic = planOf([
			...regionTree,
			place("east-a", "clinic", "hq-east-lakes"),
		]);
		expect(managedPlacesOwnerRules(doc, oneClinic)).toEqual([]);
	});

	it("asks nothing of an app with no owner rule at a level", () => {
		expect(
			managedPlacesOwnerRules(
				locationOwnerFixture("plain"),
				planOf(regionTree),
			),
		).toEqual([]);
	});
});

describe("workerOwnerMutations", () => {
	it("gives a case the rule changes to the worker who fills in the form, so the places ask nothing", () => {
		expect(owners(doc)).toBeGreaterThan(0);
		const answered = produce(doc, (draft) => {
			applyMutations(draft, workerOwnerMutations(doc, ["clinic"]));
		});
		expect(managedPlacesOwnerRules(answered, twoClinics)).toEqual([]);
		/* The rule's case is one the form changes, which keeps its owner where
		 * the form says none: the form now sets it to the submitting worker. */
		const form = parseDocument(
			new AdmZip(
				compileCcz(expandDoc(answered), answered.appName, answered, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			).readAsText("modules-0/forms-0.xml"),
			{ xmlMode: true },
		);
		const owner = findAll(
			(node) =>
				node.name === "bind" &&
				node.attribs.nodeset ===
					"/data/nova_operations/transfer/case/update/owner_id",
			form.children.filter(isTag),
		);
		expect(owner.map((node) => node.attribs.calculate)).toEqual([
			"replace(/data/meta/userID, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')",
		]);
	});

	it("changes nothing for no level, or for a level no rule names", () => {
		expect(workerOwnerMutations(doc, [])).toEqual([]);
		expect(workerOwnerMutations(doc, ["region"])).toEqual([]);
	});
});

describe("owner-rule answers", () => {
	const questions = managedPlacesOwnerRules(doc, twoClinics);

	it("hold where every question has the offered answer", () => {
		expect(resolveOwnerRuleChoices(questions, { clinic: "worker" })).toEqual({
			ok: true,
			levels: ["clinic"],
		});
		expect(resolveOwnerRuleChoices([], {})).toEqual({ ok: true, levels: [] });
	});

	it("are missing where a question has no answer", () => {
		expect(resolveOwnerRuleChoices(questions, {})).toEqual({
			ok: false,
			missing: ["clinic"],
			notOffered: [],
		});
	});

	it("are not offered for a level the review does not ask about, or an answer it does not offer", () => {
		expect(
			resolveOwnerRuleChoices(questions, {
				clinic: "worker",
				region: "worker",
			}),
		).toEqual({ ok: false, missing: [], notOffered: ["region"] });
		expect(resolveOwnerRuleChoices(questions, { clinic: "east-a" })).toEqual({
			ok: false,
			missing: [],
			notOffered: ["clinic"],
		});
	});

	it("are kept for a review that came back only where it asks the very question", () => {
		const same = keptOwnerRuleChoices(questions, questions, {
			clinic: "worker",
		});
		expect(same).toEqual({ choices: { clinic: "worker" }, dropped: false });
		const moved: ReviewOwnerRule[] = questions.map((question) => ({
			...question,
			conflict: { kind: "no-place", source: "EAST" },
		}));
		expect(
			keptOwnerRuleChoices(questions, moved, { clinic: "worker" }),
		).toEqual({ choices: {}, dropped: true });
	});
});
