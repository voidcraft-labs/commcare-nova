import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type Automation,
	automationMessageText,
	type CaseOperation,
	type CaseOperationWrite,
	type Column,
	type Field,
	type Module,
	NEW_APP_SETTINGS,
	plainColumn,
} from "@/lib/domain";
import {
	formField,
	literal,
	prop,
	type RelationStep,
	term,
} from "@/lib/domain/expression";
import { type ProsePart, proseText } from "@/lib/domain/prose";
import {
	decodeProjectSpaceCompatibilityReport,
	encodeProjectSpaceCompatibilityReport,
	linkWriteDestinations,
	linkWriteIsShown,
	projectSpaceCompatibilityForDownload,
	projectSpaceCompatibilityForTarget,
	projectSpaceCompatibilityProbePlan,
	requiredProjectSpaceCapabilities,
	sameTypeChildReasons,
} from "../projectSpaceCompatibility";
import { domainFeatureFlag } from "../surface/gates";
import { childCreate, own, placementFixture, read } from "./placementFixture";

// These tests project authored feature facts over a whole document; target
// support is supplied by probes.
type CompatibilityInput = Parameters<
	typeof projectSpaceCompatibilityProbePlan
>[0];
/* A Connect app runs only on Android, so every Connect document declares it. */
const ANDROID_ONLY = { ...NEW_APP_SETTINGS, runsOnlyOn: "android" } as const;

function doc(overrides: Partial<CompatibilityInput> = {}): CompatibilityInput {
	return {
		...buildDoc(),
		connectType: null,
		modules: {},
		forms: {},
		fields: {},
		formOrder: {},
		...overrides,
	};
}

function module(overrides: Partial<Module> = {}): Module {
	return {
		uuid: testUuid("module-patients"),
		id: "patients",
		name: "Patients",
		caseType: "patient",
		/* A case list alone has cases, so its list and search reach HQ. */
		caseListMenuItem: {},
		caseListConfig: {
			columns: [],
			listColumnOrder: [],
			detailColumnOrder: [],
			searchInputs: [],
		},
		...overrides,
	};
}

describe("projectSpaceCompatibilityProbePlan", () => {
	it("needs no special support for a plain case list", () => {
		const patient = module();
		expect(
			projectSpaceCompatibilityProbePlan(
				doc({ modules: { [patient.uuid]: patient } }),
			),
		).toEqual({ capabilities: [], advisories: [] });
	});

	it("checks only base Search for a zero-input Search", () => {
		const patient = module({ caseSearchConfig: {} });
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities).toHaveLength(1);
		expect(plan.capabilities[0]?.capability.id).toBe("case-search");
		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
		]);
		expect(plan.capabilities[0]?.runtimeProbes).toEqual(["case-search"]);
		expect(plan.capabilities[0]?.featureFlags[0]?.namespace).toBe("domain");
		expect(plan.advisories[0]?.advisory.id).toBe("large-search-performance");
	});

	it("adds advanced Search only for a field starting value", () => {
		const nameColumn = plainColumn(
			testUuid("column-name-default"),
			"name",
			"Name",
		);
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [nameColumn],
				listColumnOrder: [nameColumn.uuid],
				detailColumnOrder: [nameColumn.uuid],
				searchInputs: [
					{
						uuid: testUuid("search-name-default"),
						kind: "simple",
						type: "text",
						name: "name",
						label: "Name",
						property: "name",
						default: term(literal("Ada")),
					},
				],
			},
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
			"advanced-case-search",
		]);
		expect(plan.capabilities[0]?.capability.reasons).toContain(
			"A Search field starts with a suggested value.",
		);
	});

	it("requires advanced Search for a field Nova matches by its own filter, which HQ's editor offers only under it", () => {
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [],
				listColumnOrder: [],
				detailColumnOrder: [],
				searchInputs: [
					{
						uuid: testUuid("search-advanced-query"),
						kind: "advanced",
						type: "text",
						name: "query",
						label: "Query",
						predicate: { kind: "match-all" },
					},
				],
			},
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
			"advanced-case-search",
		]);
		expect(plan.capabilities[0]?.capability.reasons).toContain(
			"A Search field is matched by a rule Nova writes.",
		);
	});

	it("checks only base Search for an ordinary exact input", () => {
		const nameColumn = plainColumn(testUuid("column-name"), "name", "Name", {
			sort: { direction: "asc", priority: 0 },
		});
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [nameColumn],
				listColumnOrder: [nameColumn.uuid],
				detailColumnOrder: [nameColumn.uuid],
				searchInputs: [
					{
						uuid: testUuid("search-name-exact"),
						kind: "simple",
						type: "text",
						name: "name",
						label: "Name",
						property: "name",
					},
				],
			},
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
		]);
	});

	it("does not require advanced Search for an ineffective match-all filter", () => {
		const nameColumn = plainColumn(
			testUuid("column-name-match-all"),
			"name",
			"Name",
		);
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [nameColumn],
				listColumnOrder: [nameColumn.uuid],
				detailColumnOrder: [nameColumn.uuid],
				filter: { kind: "match-all" },
				searchInputs: [
					{
						uuid: testUuid("search-name-match-all"),
						kind: "simple",
						type: "text",
						name: "name",
						label: "Name",
						property: "name",
					},
				],
			},
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
		]);
	});

	it("does not mistake owner-only case availability for Search", () => {
		const patient = module({
			caseSearchConfig: {
				searchActionEnabled: false,
				excludedOwnerIds: term(literal("owner-1")),
			},
		});
		expect(
			requiredProjectSpaceCapabilities(
				doc({ modules: { [patient.uuid]: patient } }),
			),
		).toEqual([]);
	});

	it("derives CommCare Connect from the app mode", () => {
		expect(
			requiredProjectSpaceCapabilities(
				doc({ connectType: "learn", appSettings: ANDROID_ONLY }),
			).map((capability) => capability.id),
		).toEqual(["commcare-connect"]);
	});

	it("derives CommCare Connect from alert content", () => {
		const alert: Automation = {
			uuid: testUuid("connect-alert"),
			kind: "conditional-alert",
			name: "Send opportunity",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: testUuid("connect-owner"), kind: "owner" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("connect-event"),
						minutesToWait: 0,
						content: {
							kind: "connect-message",
							message: automationMessageText("A new opportunity is ready"),
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		};

		expect(
			requiredProjectSpaceCapabilities(
				doc({ automations: { [alert.uuid]: alert } }),
			).map((capability) => capability.id),
		).toEqual(["commcare-connect"]);
	});

	it("requires registration after an empty search only for a lowered case list registration form", () => {
		const formUuid = testUuid("form-register");
		const registration = {
			uuid: formUuid,
			id: "register",
			name: "Register patient",
			type: "registration" as const,
		};
		const host = module({
			caseSearchConfig: { formsReadSearch: true },
			caseListRegistrationForm: { kind: "after-empty-search", formUuid },
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({
				modules: { [host.uuid]: host },
				forms: { [formUuid]: registration },
				formOrder: { [host.uuid]: [formUuid] },
			}),
		);
		const capability = plan.capabilities.find(
			(item) => item.capability.id === "registration-after-empty-search",
		);
		expect(capability?.capability.reasons).toEqual([
			"A search that finds nothing offers to register a new case.",
		]);
		expect(capability?.featureFlags.map((flag) => flag.id)).toEqual([
			"no-matches-registration",
		]);
		expect(capability?.runtimeProbes).toEqual([]);

		// The same slot on a module whose forms don't read the search is a
		// validator finding, not a lowered Register action.
		const browse = module({
			caseListRegistrationForm: { kind: "after-empty-search", formUuid },
		});
		expect(
			requiredProjectSpaceCapabilities(
				doc({
					modules: { [browse.uuid]: browse },
					forms: { [formUuid]: registration },
					formOrder: { [browse.uuid]: [formUuid] },
				}),
			).map((item) => item.id),
		).not.toContain("registration-after-empty-search");
	});

	describe("a captured file's link", () => {
		// Every capture's case write is a link to the submitted file, held
		// as a case operation's write whose value is `capture-link`. No
		// export writes a case attachment, so the only thing a link asks of
		// the project space is to be opened, where something shows it.
		const householdModuleUuid = testUuid("module-households");
		const patientModuleUuid = testUuid("module-patients");
		const visitUuid = testUuid("form-visit");
		const photoUuid = testUuid("field-photo");
		const noteUuid = testUuid("field-note");
		const copyUuid = testUuid("field-photo-copy");
		const columnUuid = testUuid("column-photo");
		const caseTypes = [
			{ name: "household", properties: [] },
			{ name: "patient", parent_type: "household", properties: [] },
		];
		const parentVia: [RelationStep] = [{ identifier: "parent" }];
		const linkWrite = (via?: typeof parentVia): CaseOperationWrite => ({
			property: "photo",
			value: term({ kind: "capture-link", field: photoUuid }),
			...(via === undefined ? {} : { via }),
		});
		const listOf = (columns: Column[]) => ({
			columns,
			listColumnOrder: columns.map((column) => column.uuid),
			detailColumnOrder: columns.map((column) => column.uuid),
			searchInputs: [],
		});
		/** A follow-up on a patient that saves the photo's link, with the
		 *  columns each module shows and any further questions. */
		const linkDoc = (
			options: {
				readonly via?: typeof parentVia;
				readonly patientColumns?: Column[];
				readonly householdColumns?: Column[];
				readonly fields?: readonly Field[];
			} = {},
		): CompatibilityInput => {
			const households = module({
				uuid: householdModuleUuid,
				id: "households",
				name: "Households",
				caseType: "household",
				caseListConfig: listOf(options.householdColumns ?? []),
			});
			const patients = module({
				uuid: patientModuleUuid,
				caseListMenuItem: undefined,
				caseListConfig: listOf(options.patientColumns ?? []),
			});
			const photo: Field = {
				uuid: photoUuid,
				id: "photo",
				kind: "image",
				label: proseText("Photo"),
			};
			const extra = options.fields ?? [];
			return doc({
				caseTypes,
				modules: { [households.uuid]: households, [patients.uuid]: patients },
				moduleOrder: [households.uuid, patients.uuid],
				forms: {
					[visitUuid]: {
						uuid: visitUuid,
						id: "visit",
						name: "Visit",
						type: "followup",
						caseOperations: [
							{
								uuid: testUuid("operation-own"),
								id: "own",
								action: "own",
								writes: [linkWrite(options.via)],
							},
						],
					},
				},
				formOrder: {
					[households.uuid]: [],
					[patients.uuid]: [visitUuid],
				},
				fields: Object.fromEntries(
					[photo, ...extra].map((field) => [field.uuid, field]),
				),
				fieldOrder: {
					[visitUuid]: [photoUuid, ...extra.map((field) => field.uuid)],
				},
			});
		};
		const capabilityIds = (input: CompatibilityInput) =>
			requiredProjectSpaceCapabilities(input).map((item) => item.id);
		const PATIENT = { caseType: "patient", property: "photo" };
		const HOUSEHOLD = { caseType: "household", property: "photo" };

		it("lands each link write on its operation's case, or the ancestor its via reaches", () => {
			expect(linkWriteDestinations(linkDoc())).toEqual([PATIENT]);
			expect(linkWriteDestinations(linkDoc({ via: parentVia }))).toEqual([
				HOUSEHOLD,
			]);
		});

		it("asks nothing where nothing shows it", () => {
			const input = linkDoc({
				// A column of another case type naming the same property shows
				// that type's value, not the link.
				householdColumns: [plainColumn(columnUuid, "photo", "Photo")],
			});
			expect(linkWriteIsShown(input, PATIENT)).toBe(false);
			expect(capabilityIds(input)).toEqual([]);
		});

		it("asks for links to captured files where a plain column shows it", () => {
			const input = linkDoc({
				patientColumns: [plainColumn(columnUuid, "photo", "Photo")],
			});
			expect(linkWriteIsShown(input, PATIENT)).toBe(true);
			const plan = projectSpaceCompatibilityProbePlan(input);
			expect(plan.capabilities.map((item) => item.capability.id)).toEqual([
				"attachment-links",
			]);
			expect(plan.capabilities[0]?.capability.reasons).toEqual([
				"The app shows a link to a captured file in a case list, its details or a form.",
			]);
			expect(
				plan.capabilities.flatMap((item) =>
					item.featureFlags.map((flag) => flag.id),
				),
			).toEqual(["attachment-links"]);
		});

		it("asks where a child menu's calculated column shows a link saved on its parent", () => {
			const input = linkDoc({
				via: parentVia,
				patientColumns: [
					{
						uuid: columnUuid,
						kind: "calculated",
						header: "Household photo",
						expression: term(
							prop("patient", "photo", { kind: "ancestor", via: parentVia }),
						),
					},
				],
			});
			expect(linkWriteIsShown(input, HOUSEHOLD)).toBe(true);
			expect(capabilityIds(input)).toEqual(["attachment-links"]);
			// The same column reading the patient's own property shows
			// another value.
			const own = linkDoc({
				via: parentVia,
				patientColumns: [
					{
						uuid: columnUuid,
						kind: "calculated",
						header: "Photo",
						expression: term(prop("patient", "photo")),
					},
				],
			});
			expect(linkWriteIsShown(own, HOUSEHOLD)).toBe(false);
		});

		it("asks where a form's prose prints the link, directly or through a question that reads it", () => {
			const note = (part: ProsePart): Field => ({
				uuid: noteUuid,
				id: "note",
				kind: "label",
				label: { parts: [{ kind: "text", text: "Open the photo: " }, part] },
			});
			const copy: Field = {
				uuid: copyUuid,
				id: "photo_link",
				kind: "hidden",
				default_value: term({
					kind: "form-case",
					caseType: "patient",
					property: "photo",
				}),
			};

			const printed = linkDoc({
				fields: [
					note({ kind: "case-ref", caseType: "patient", property: "photo" }),
				],
			});
			expect(linkWriteIsShown(printed, PATIENT)).toBe(true);
			expect(capabilityIds(printed)).toEqual(["attachment-links"]);

			const throughQuestion = linkDoc({
				fields: [copy, note({ kind: "field-ref", uuid: copyUuid })],
			});
			expect(linkWriteIsShown(throughQuestion, PATIENT)).toBe(true);

			// A question that reads the link, and no prose that prints it.
			expect(linkWriteIsShown(linkDoc({ fields: [copy] }), PATIENT)).toBe(
				false,
			);
		});

		it("asks nothing for a column hidden from both screens", () => {
			const input = linkDoc({
				patientColumns: [
					plainColumn(columnUuid, "photo", "Photo", {
						visibleInList: false,
						visibleInDetail: false,
					}),
				],
			});
			expect(linkWriteIsShown(input, PATIENT)).toBe(false);
			expect(capabilityIds(input)).toEqual([]);
		});
	});

	describe("saving only answers that changed", () => {
		const formUuid = testUuid("form-update");
		const answerUuid = testUuid("field-weight");
		const updateDoc = (onlyIfChanged: boolean): CompatibilityInput => {
			const patients = module({ caseListMenuItem: undefined });
			return doc({
				modules: { [patients.uuid]: patients },
				moduleOrder: [patients.uuid],
				forms: {
					[formUuid]: {
						uuid: formUuid,
						id: "update",
						name: "Update",
						type: "followup",
						caseOperations: [
							{
								uuid: testUuid("operation-own"),
								id: "own",
								action: "own",
								writes: [
									{
										property: "weight",
										value: term(formField(answerUuid)),
										...(onlyIfChanged ? { onlyIfChanged: true as const } : {}),
									},
								],
							},
						],
					},
				},
				formOrder: { [patients.uuid]: [formUuid] },
				fields: {
					[answerUuid]: {
						uuid: answerUuid,
						id: "weight",
						kind: "decimal",
						label: proseText("Weight"),
					},
				},
				fieldOrder: { [formUuid]: [answerUuid] },
			});
		};

		it("asks for the setting exactly where a write saves only a changed answer", () => {
			expect(requiredProjectSpaceCapabilities(updateDoc(false))).toEqual([]);
			const [capability, ...rest] = projectSpaceCompatibilityProbePlan(
				updateDoc(true),
			).capabilities;
			expect(rest).toEqual([]);
			expect(capability?.capability.id).toBe("save-only-edited-answers");
			expect(capability?.capability.label).toBe(
				"Save only answers that changed",
			);
			expect(capability?.capability.reasons).toEqual([
				"A form saves an answer to a case only when the worker changed it.",
			]);
			const gate = domainFeatureFlag("SAVE_ONLY_EDITED_FORM_FIELDS");
			expect(capability?.featureFlags).toEqual([
				{
					id: "save-only-edited-answers",
					slug: gate.slug,
					namespace: gate.namespace,
				},
			]);
			expect(capability?.runtimeProbes).toEqual([]);
		});

		it("stops a publish to a project space without it, and keeps the capability through the public report", () => {
			const report = projectSpaceCompatibilityForTarget(
				"clinic-space",
				projectSpaceCompatibilityProbePlan(updateDoc(true)).capabilities.map(
					(plan) => ({
						capability: plan.capability,
						state: "missing" as const,
					}),
				),
				[],
			);
			expect(report.status).toBe("blocked");
			expect(report.blockers.map((blocker) => blocker.id)).toEqual([
				"save-only-edited-answers",
			]);
			expect(
				decodeProjectSpaceCompatibilityReport(
					encodeProjectSpaceCompatibilityReport(report),
				),
			).toEqual(report);
		});
	});
});

describe("project-space compatibility reports", () => {
	it("keeps an unknown destination semantic and not checked", () => {
		const report = projectSpaceCompatibilityForDownload(
			doc({ connectType: "deliver", appSettings: ANDROID_ONLY }),
		);
		expect(report.status).toBe("not_checked");
		expect(report.required_capabilities).toMatchObject([
			{ id: "commcare-connect", state: "not_checked" },
		]);
		expect(report.blockers).toEqual([]);
		expect(report.message).toContain("Choose a project space");
	});

	it("blocks missing and unverified required capabilities", () => {
		const uses = requiredProjectSpaceCapabilities(
			doc({ connectType: "learn", appSettings: ANDROID_ONLY }),
		);
		const report = projectSpaceCompatibilityForTarget(
			"clinic-space",
			[{ capability: uses[0], state: "unverified" }],
			[],
		);
		expect(report.status).toBe("blocked");
		expect(report.blockers).toMatchObject([
			{ id: "commcare-connect", state: "unverified" },
		]);
		expect(report.message).toContain("Nothing has been sent");
	});

	it("keeps a connected-account permission failure semantic and actionable", () => {
		const patient = module({ caseSearchConfig: {} });
		const uses = requiredProjectSpaceCapabilities(
			doc({ modules: { [patient.uuid]: patient } }),
		);
		const report = projectSpaceCompatibilityForTarget(
			"clinic-space",
			[
				{
					capability: uses[0],
					state: "unverified",
					issue: "connected-account-permission",
				},
			],
			[],
		);

		expect(report.blockers).toMatchObject([
			{
				id: "case-search",
				state: "unverified",
				issue: "connected-account-permission",
			},
		]);
		expect(report.message).toContain("Mobile App Access");
		expect(report.message).not.toContain("access_mobile_endpoints");
		expect(
			decodeProjectSpaceCompatibilityReport(
				encodeProjectSpaceCompatibilityReport(report),
			),
		).toEqual(report);
	});

	it("keeps a missing optimization advisory non-blocking", () => {
		const patient = module({ caseSearchConfig: {} });
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);
		const report = projectSpaceCompatibilityForTarget(
			"clinic-space",
			[{ capability: plan.capabilities[0].capability, state: "available" }],
			[{ advisory: plan.advisories[0].advisory, state: "missing" }],
		);

		expect(report.status).toBe("ready");
		expect(report.blockers).toEqual([]);
		expect(report.advisories).toMatchObject([
			{
				id: "large-search-performance",
				state: "missing",
				title: "Large searches may open more slowly",
			},
		]);
	});

	it("never serializes private flags, namespaces, or raw probe arrays", () => {
		const report = projectSpaceCompatibilityForDownload(
			doc({ connectType: "learn", appSettings: ANDROID_ONLY }),
		);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("commcare_connect");
		expect(serialized).not.toContain("search_claim");
		expect(serialized).not.toContain("NAMESPACE_DOMAIN");
		expect(serialized).not.toContain("required_flags");
	});

	it("rejects malformed headers and round-trips the public contract", () => {
		expect(
			decodeProjectSpaceCompatibilityReport(encodeURIComponent("{}")),
		).toBeUndefined();
		const report = projectSpaceCompatibilityForDownload(
			doc({ connectType: "learn", appSettings: ANDROID_ONLY }),
		);
		expect(
			decodeProjectSpaceCompatibilityReport(
				encodeProjectSpaceCompatibilityReport(report),
			),
		).toEqual(report);
	});
});

describe("Deep links capability", () => {
	it("requires verified target support only when an entry point is authored", () => {
		const mod = module({
			entryPoint: { uuid: testUuid("entry"), id: "patients" },
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [mod.uuid]: mod } }),
		);
		const capability = plan.capabilities.find(
			(p) => p.capability.id === "deep-links",
		);
		if (!capability) throw new Error("Missing Deep links requirement");
		expect(capability.featureFlags.map((f) => f.slug)).toEqual([
			"session_endpoints",
		]);
		expect(
			projectSpaceCompatibilityForTarget(
				"acme",
				[{ capability: capability.capability, state: "unverified" }],
				[],
			).status,
		).toBe("blocked");
		expect(
			requiredProjectSpaceCapabilities(doc()).some(
				(c) => c.id === "deep-links",
			),
		).toBe(false);
	});
});

describe("public report state and decoding boundaries", () => {
	const states = ["available", "missing", "unverified"] as const;
	for (const required of states)
		for (const advisory of states)
			it(`required ${required}, advisory ${advisory}`, () => {
				const patient = module({ caseSearchConfig: {} });
				const plan = projectSpaceCompatibilityProbePlan(
					doc({ modules: { [patient.uuid]: patient } }),
				);
				const report = projectSpaceCompatibilityForTarget(
					"clinic",
					[{ capability: plan.capabilities[0].capability, state: required }],
					[{ advisory: plan.advisories[0].advisory, state: advisory }],
				);
				expect(report.status).toBe(
					required === "available" ? "ready" : "blocked",
				);
				expect(report.blockers.map((b) => [b.id, b.state])).toEqual(
					required === "available" ? [] : [["case-search", required]],
				);
				expect(report.advisories.map((a) => a.state)).toEqual([advisory]);
				// Independent URI+JSON decoding owns the transport bytes, including Unicode.
				expect(
					JSON.parse(
						decodeURIComponent(
							encodeProjectSpaceCompatibilityReport({
								...report,
								message: "Café 雪 😀",
							}),
						),
					),
				).toEqual({ ...report, message: "Café 雪 😀" });
			});
	it.each([
		null,
		"",
		"%",
		"%E0%A4%A",
		"not-json",
		encodeURIComponent("null"),
		encodeURIComponent("[]"),
	])("ignores malformed header %s", (value) => {
		expect(decodeProjectSpaceCompatibilityReport(value)).toBeUndefined();
	});
	it("refuses inconsistent states, malformed nested checks and stale public definitions", () => {
		const patient = module({ caseSearchConfig: {} });
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);
		const ready = projectSpaceCompatibilityForTarget(
			"clinic",
			[{ capability: plan.capabilities[0].capability, state: "available" }],
			[{ advisory: plan.advisories[0].advisory, state: "missing" }],
		);
		const capability = ready.required_capabilities[0];
		const bad = [
			{ ...ready, status: "blocked" },
			{ ...ready, status: "not_needed" },
			{ ...ready, status: "not_checked" },
			{ ...ready, target_domain: null },
			{
				...ready,
				required_capabilities: [{ ...capability, state: "missing" }],
			},
			{ ...ready, required_capabilities: [{ ...capability, id: "unknown" }] },
			{
				...ready,
				required_capabilities: [{ ...capability, label: "Outdated label" }],
			},
			{ ...ready, required_capabilities: [{ ...capability, reasons: [1] }] },
			{
				...ready,
				required_capabilities: [{ ...capability, issue: "arbitrary" }],
			},
			{ ...ready, advisories: [{ ...ready.advisories[0], state: "unknown" }] },
			{ ...ready, blockers: [capability] },
			{ ...ready, docs_url: "https://other.example" },
		];
		for (const value of bad)
			expect(
				decodeProjectSpaceCompatibilityReport(
					encodeURIComponent(JSON.stringify(value)),
				),
			).toBeUndefined();
	});
});

/* A basic child of its own menu's case type keeps its parent link only where
 * the project space leaves HQ's same-type flag off, so the plan asks for that
 * flag off and names each such child for the person. */
describe("Links between cases of the same type", () => {
	const twin = (formType: Parameters<typeof childCreate>[1]): CaseOperation =>
		({
			...childCreate("twin", formType),
			caseType: "patient",
		}) as CaseOperation;

	it("names a registration's and a follow-up's same-type child", () => {
		const registers = placementFixture("registration", {
			operations: (t) => [own({ name: read("name") }), twin(t)],
		});
		expect(sameTypeChildReasons(registers.doc)).toEqual([
			"Under test makes a patient case linked to the patient case it registers.",
		]);
		const worksOn = placementFixture("followup", {
			operations: (t) => [own(), twin(t)],
		});
		expect(sameTypeChildReasons(worksOn.doc)).toEqual([
			"Under test makes a patient case linked to the patient case it works on.",
		]);
	});

	it("plans the capability with the flag it needs off", () => {
		const { doc } = placementFixture("followup", {
			operations: (t) => [own(), twin(t)],
		});
		const plans = projectSpaceCompatibilityProbePlan(doc).capabilities.filter(
			(plan) => plan.capability.id === "same-type-child-links",
		);
		expect(plans).toEqual([
			{
				capability: expect.objectContaining({
					id: "same-type-child-links",
					reasons: [
						"Under test makes a patient case linked to the patient case it works on.",
					],
				}),
				featureFlags: [],
				featureFlagsOff: [
					{
						id: "same-type-links-dropped",
						slug: domainFeatureFlag("DONT_INDEX_SAME_CASETYPE").slug,
						namespace: "domain",
					},
				],
				runtimeProbes: [],
			},
		]);
	});

	it("asks nothing for a child of another type", () => {
		const { doc } = placementFixture("followup", {
			operations: (t) => [own(), childCreate("kid", t)],
		});
		expect(sameTypeChildReasons(doc)).toEqual([]);
		expect(
			requiredProjectSpaceCapabilities(doc).map((use) => use.id),
		).not.toContain("same-type-child-links");
	});
});
