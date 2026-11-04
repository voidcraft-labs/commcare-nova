/**
 * The builder offers a choice exactly where the gate admits it.
 *
 * Contract: at every site where the builder offers a platform feature, it
 * disables a choice when `platformRefusal(feature, declaredPlatforms(doc))`
 * is defined and offers it otherwise; the commit gate refuses the batch that site
 * dispatches when the declaration can't run it. This holds the two together
 * at the batches the builder actually sends (the table-to-gate parity per
 * feature is `lib/commcare/validator/__tests__/platformAvailability.test.ts`'s),
 * for each declaration, and holds each site's line to the two-sentence
 * picker line the platform table writes for its feature. A site wired to the
 * wrong feature, or a gate change the table does not carry, fails here.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	availableLookupContext,
	DESTINATIONS_LOOKUP,
} from "@/lib/__tests__/lookupFixtures";
import {
	caseListRegistrationMutations,
	formsReadSearchOnMutations,
} from "@/lib/doc/caseListRegistrationForm";
import { caseSearchConfigPatchMutations } from "@/lib/doc/caseSearchConfigPatchMutations";
import { planCaseSelectionChange } from "@/lib/doc/caseSelectionMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppSettings,
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	declaredPlatforms,
	type Platform,
	type PlatformFeatureId,
	platformPickerLine,
	platformRefusal,
} from "@/lib/domain/platforms";

const MODULE = testUuid("offer-parity-module");
const VISIT = testUuid("offer-parity-visit");
const REGISTER = testUuid("offer-parity-register");
const NAME_INPUT = testUuid("offer-parity-name-input");
const NEW_INPUT = testUuid("offer-parity-new-input");
const NEW_FIELD = testUuid("offer-parity-new-field");

const LOOKUPS = availableLookupContext([DESTINATIONS_LOOKUP.definition]);

const DECLARATIONS: readonly (Platform | undefined)[] = [
	undefined,
	"web-apps",
	"android",
];

function settings(runsOnlyOn: Platform | undefined): AppSettings {
	return runsOnlyOn === undefined
		? NEW_APP_SETTINGS
		: { ...NEW_APP_SETTINGS, runsOnlyOn };
}

/** A searchable case list with a follow-up form and, unless left out, a
 *  registration form: content every declaration runs. A module whose
 *  registration form stays on its menu can't have its forms read the search,
 *  so that switch is judged without one. */
function searchableApp(
	runsOnlyOn: Platform | undefined,
	registration: boolean,
	workflow?: "skipToResults",
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(NAME_INPUT, "name", "Name", "text", "case_name"),
	];
	return buildDoc({
		appName: "Offer parity",
		appSettings: settings(runsOnlyOn),
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "dob", label: "Date of birth", data_type: "date" },
					{ name: "destination", label: "Destination" },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: workflow === undefined ? {} : { workflow },
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
					...(registration
						? [
								{
									uuid: REGISTER,
									name: "Register",
									type: "registration" as const,
									fields: [
										f({
											kind: "text",
											id: "case_name",
											label: "Name",
											caseWrite: {
												caseType: "patient",
												property: "case_name",
											},
										}),
									],
								},
							]
						: []),
				],
			},
		],
	});
}

interface OfferingSite {
	readonly name: string;
	readonly feature: PlatformFeatureId;
	/** Whether the app holds a registration form on its menu. */
	readonly registration?: false;
	/** The workflow the module's search holds before the choice, which every
	 *  declaration runs; absent is search first. */
	readonly from?: "skipToResults";
	readonly batch: (doc: BlueprintDoc) => readonly Mutation[];
}

/** The Search settings' workflow choice: the per-setting batch its fieldset
 *  commits for one value, `null` being Search first. */
function workflowChoice(
	doc: BlueprintDoc,
	workflow: "listFirst" | "skipToResults" | null,
): readonly Mutation[] {
	const current = doc.modules[MODULE]?.caseSearchConfig ?? {};
	if ("searchActionEnabled" in current)
		throw new Error("The module's search is owner-only.");
	const { workflow: _workflow, ...rest } = current;
	return caseSearchConfigPatchMutations(MODULE, current, {
		...rest,
		...(workflow !== null && { workflow }),
		...(workflow === "listFirst"
			? {}
			: current.formsReadSearch !== undefined && {
					formsReadSearch: current.formsReadSearch,
				}),
	});
}

const SITES: readonly OfferingSite[] = [
	{
		name: "the insertion menu's Date/Time",
		feature: "datetime-question",
		batch: () => [
			{
				kind: "addField",
				parentUuid: VISIT,
				field: {
					kind: "datetime",
					uuid: NEW_FIELD,
					id: "new_datetime",
					label: proseText("New Date/Time"),
				},
				after: null,
			} as Mutation,
		],
	},
	{
		name: "Results' Several cases",
		feature: "several-cases",
		batch: (doc) => {
			const module = doc.modules[MODULE];
			if (module === undefined) throw new Error("The module is missing.");
			const plan = planCaseSelectionChange(module, {
				kind: "multiple",
				maximum: 100,
			});
			if (!plan.ok) throw new Error("The module has no case list.");
			return plan.mutations;
		},
	},
	{
		name: "the workflow's Search first",
		feature: "search-first",
		from: "skipToResults",
		batch: (doc) => workflowChoice(doc, null),
	},
	{
		name: "the workflow's Results first",
		feature: "skip-to-results",
		batch: (doc) => workflowChoice(doc, "skipToResults"),
	},
	{
		name: "the workflow's Case list first",
		feature: "list-first",
		batch: (doc) => workflowChoice(doc, "listFirst"),
	},
	{
		name: "the Search settings' Forms read the search",
		feature: "forms-read-search",
		registration: false,
		batch: (doc) => formsReadSearchOnMutations(doc, MODULE),
	},
	{
		name: "the Search field's Date picker",
		feature: "search-field-single-date",
		batch: () => [
			{
				kind: "addSearchInput",
				moduleUuid: MODULE,
				searchInput: simpleSearchInputDef(
					NEW_INPUT,
					"dob",
					"Date of birth",
					"date",
					"dob",
				),
			},
		],
	},
	{
		name: "the Search field's Multiple choice",
		feature: "search-field-multiple-choice",
		batch: () => [
			{
				kind: "addSearchInput",
				moduleUuid: MODULE,
				searchInput: simpleSearchInputDef(
					NEW_INPUT,
					"destination",
					"Destination",
					"multi-select",
					"destination",
					{ options: DESTINATIONS_LOOKUP.optionsSource },
				),
			},
		],
	},
	{
		name: "the registration offer after an empty search",
		feature: "forms-read-search",
		batch: (doc) => caseListRegistrationMutations(doc, MODULE, REGISTER, {}),
	},
	{
		name: "the case list menu item switch beside forms",
		feature: "case-list-menu-item",
		batch: () => [{ kind: "setCaseListMenuItem", uuid: MODULE, item: {} }],
	},
];

/** The platform table's picker line for each feature an offering site withholds. */
const PICKER_LINES: Partial<Record<PlatformFeatureId, string>> = {
	"datetime-question":
		"Not available in Web Apps. You can ask for a date and a time as two questions, or change where this app runs in App settings.",
	"several-cases":
		"Not available on Android. You can change where this app runs in App settings.",
	"forms-read-search":
		"Not available on Android. You can change where this app runs in App settings.",
	"list-first":
		"Not available in Web Apps. You can open this menu on Search first, which Android still opens on its case list, or change where this app runs in App settings.",
	"search-field-single-date":
		"Not available on Android. You can change where this app runs in App settings.",
	"search-field-multiple-choice":
		"Not available on Android. You can change where this app runs in App settings.",
	"connect-app":
		"Not available for a Connect app. You can turn off Connect, then choose this.",
};

describe("each offering site withholds exactly what the gate refuses", () => {
	for (const site of SITES)
		for (const runsOnlyOn of DECLARATIONS)
			it(`${site.name}, in an app that runs ${runsOnlyOn ?? "on both"}`, () => {
				const doc = searchableApp(
					runsOnlyOn,
					site.registration !== false,
					site.from,
				);
				expect(mutationCommitVerdict(doc, [], LOOKUPS).ok).toBe(true);
				const refusal = platformRefusal(site.feature, declaredPlatforms(doc));
				const verdict = mutationCommitVerdict(doc, site.batch(doc), LOOKUPS);
				expect(verdict.ok).toBe(refusal === undefined);
				if (refusal !== undefined)
					expect(platformPickerLine(refusal)).toBe(PICKER_LINES[site.feature]);
			});
});

describe("the platform section withholds a choice from a Connect app exactly where the gate refuses it", () => {
	function connectApp(): BlueprintDoc {
		return buildDoc({
			appName: "Connect parity",
			appSettings: settings("android"),
			connectType: "learn",
			modules: [
				{
					uuid: MODULE,
					name: "Learning",
					forms: [
						{
							uuid: VISIT,
							name: "Lesson",
							type: "survey",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
							connect: {
								learn_module: {
									id: "lesson",
									name: "Lesson",
									description: "The first lesson",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
	}

	for (const choice of DECLARATIONS)
		it(`the choice of ${choice ?? "both platforms"}`, () => {
			const doc = connectApp();
			expect(mutationCommitVerdict(doc, [], LOOKUPS).ok).toBe(true);
			const platforms = declaredPlatforms({ appSettings: settings(choice) });
			const refusal = platformRefusal("connect-app", platforms);
			const verdict = mutationCommitVerdict(
				doc,
				[{ kind: "setAppSettings", settings: { runsOnlyOn: choice ?? null } }],
				LOOKUPS,
			);
			// The current declaration is no change, and the gate admits the
			// unchanged app.
			expect(verdict.ok).toBe(refusal === undefined);
			if (refusal !== undefined)
				expect(platformPickerLine(refusal)).toBe(PICKER_LINES["connect-app"]);
		});
});
