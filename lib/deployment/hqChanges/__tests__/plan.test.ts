/**
 * The plan of a change made in CommCare HQ, case by case.
 *
 * Contract: `planHqChanges` answers each arm of `HqChangePlan` where its
 * step decides it, and `planFromDocuments` takes each case of the round
 * trip whose outcome is decided as that case says: what a reading cannot
 * say of the worker setup, a translation's source or the case catalog is
 * never taken from it; Nova's spelling of a menu or form that no longer
 * fits the change takes the reader's, and nothing else moves; a change
 * Nova also made is no change of Nova's to lose; a rename made in Nova
 * holds the take back. Every reading is the production reader's, over
 * Nova's own emission of a document the production gate admits, through
 * the identity map of the document Nova published, as a review reads the
 * baseline and the app now; the one hand-built pair is the reworded
 * source, which Nova's own emission cannot print.
 *
 * Plausible failure: a narrowing rule that lets a reading's silence or its
 * own spelling remove or relabel what Nova holds; a respelling that reaches
 * past the menu or form CommCare HQ changed; a list that names what the
 * take keeps or misses what it removes.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { expandDoc } from "@/lib/commcare/expander";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import { readHqApp } from "@/lib/commcare/reader";
import {
	hydrated,
	publishedCorpus,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { retainedSourceBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { printSlotUnder } from "@/lib/commcare/reader/expressions/readExpression";
import {
	matchingResolver,
	mintingResolver,
} from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { caseListRegistrationMutations } from "@/lib/doc/caseListRegistrationForm";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { documentDifferences } from "@/lib/doc/documentDifferences";
import { parseFormExpressionForSlot } from "@/lib/doc/expressionText";
import { planFieldRemoval } from "@/lib/doc/fieldRemovalMutations";
import { planKindConversion } from "@/lib/doc/kindConversionCascade";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { Automation, BlueprintDoc, FieldKind, Uuid } from "@/lib/domain";
import { advancedSearchInputDef } from "@/lib/domain";
import {
	dateAdd,
	double,
	eq,
	input,
	prop,
	term,
	today,
	whenInput,
} from "@/lib/domain/expression";
import { formField, isBlank, not } from "@/lib/domain/expression/builders";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import type { Expression } from "@/lib/domain/expression/types";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	makeTranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain/localization";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import {
	localizeTranslationUnit,
	snapshotTranslationUnits,
} from "@/lib/domain/translationUnits";
import { normalizeHqAppSource } from "../../hqSourceBaseline";
import {
	acceptanceInput,
	navigationBaseRead,
} from "../../reading/__tests__/acceptanceInput";
import {
	mediaIndex,
	readBackInput,
	servedExport,
} from "../../reading/__tests__/novaReading";
import { acceptReading } from "../../reading/acceptance";
import { narrowDeclarationsByMedia } from "../../reading/projectData/media";
import { readBackDifferences } from "../../reading/readBack";
import {
	alignedFromSource,
	inStoredKeyOrder,
	sourceFromBaseline,
} from "../baselineSource";
import {
	planFromDocuments,
	planHqChanges,
	stillOmitsHiddenStartingAnswer,
	touchedBy,
} from "../plan";
import type { HqChangeReadings } from "../readings";
import { withHeadUnsent } from "../reference";
import { committed, readingOf } from "./hqChangeReadings";

// ── The app ──────────────────────────────────────────────────────────

const APP_ID = "plan-visits";
const VILLAGE = testUuid("plan-village");
const DISTRICT = testUuid("plan-district");
const ROLE = testUuid("plan-role");
const PERSONA = testUuid("plan-persona");
const PATIENTS = "plan-patients";
const REGISTER = "plan-register";
const VISIT = "plan-visit";
const NOTE = "plan-note";
const HOME = "plan-home";
const TEMP = "plan-temp";
const HOUSEHOLDS = "plan-households";
const WEIGHT = "plan-weight";

/**
 * A clinic: a menu of patients whose registration saves a name and a note
 * and asks the worker's village, and whose visit saves a temperature the
 * catalog does not declare; a worker property read by a question and one
 * nothing reads; a role and a persona with values for it.
 */
function visits(options: { readonly households?: boolean } = {}): BlueprintDoc {
	return buildDoc(
		{
			appId: APP_ID,
			appName: "Visits",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "visit_note", label: "Visit note", data_type: "text" },
						{ name: "risk", label: "Risk level" },
						{ name: "weight", label: "Weight", data_type: "int" },
					],
				},
			],
			modules: [
				{
					uuid: PATIENTS,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: REGISTER,
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									uuid: NOTE,
									kind: "text",
									id: "note",
									label: "Note",
									caseWrite: { caseType: "patient", property: "visit_note" },
								}),
								f({
									uuid: HOME,
									kind: "text",
									id: "home",
									label: "Home",
									default_value: "#user/village",
								}),
							],
						},
						{
							uuid: VISIT,
							name: "Visit",
							type: "followup",
							fields: [
								f({
									uuid: TEMP,
									kind: "int",
									id: "temp",
									label: "Temperature",
									caseWrite: { caseType: "patient", property: "temp" },
								}),
								f({
									uuid: WEIGHT,
									kind: "int",
									id: "weight",
									label: "Weight",
									caseWrite: { caseType: "patient", property: "weight" },
								}),
								f({ kind: "text", id: "comment", label: "Comment" }),
							],
						},
					],
				},
				...(options.households === true
					? [
							{
								uuid: HOUSEHOLDS,
								name: "Households",
								caseType: "household",
								caseListConfig: caseListConfig([
									{ field: "case_name", header: "Name" },
								]),
								forms: [
									{
										name: "Household visit",
										type: "followup" as const,
										fields: [f({ kind: "text", id: "seen", label: "Seen" })],
									},
								],
							},
						]
					: []),
			],
		},
		(doc) => {
			doc.userProperties = {
				[VILLAGE]: {
					uuid: VILLAGE,
					slug: "village",
					label: "Home village",
					required: true,
					choices: ["north", "south"],
				},
				[DISTRICT]: { uuid: DISTRICT, slug: "district", label: "District" },
			};
			doc.userPropertyOrder = [VILLAGE, DISTRICT];
			doc.userTypes = {
				[ROLE]: { uuid: ROLE, name: "Nurse", values: { [VILLAGE]: "north" } },
			};
			doc.userTypeOrder = [ROLE];
			doc.personas = {
				[PERSONA]: {
					uuid: PERSONA,
					name: "Asha",
					userTypeUuid: ROLE,
					values: { [VILLAGE]: "south" },
				},
			};
			doc.personaOrder = [PERSONA];
		},
	);
}

const id = (key: string) => testUuid(key) as Uuid;

/** `doc` with a question removed as the builder removes one: its saves stopped first. */
function without(doc: BlueprintDoc, ...keys: readonly string[]): BlueprintDoc {
	return keys.reduce((current, key) => {
		const plan = planFieldRemoval(current, id(key));
		if (!plan.ok) throw new Error(plan.message);
		return committed(current, plan.mutations);
	}, doc);
}

/** `doc` with a question of another kind, as the builder converts one. */
function converted(
	doc: BlueprintDoc,
	key: string,
	toKind: FieldKind,
): BlueprintDoc {
	const field = doc.fields[id(key)];
	if (field === undefined) throw new Error(`No question ${key}.`);
	const plan = planKindConversion({ doc, field, toKind });
	if (!plan.ok)
		throw new Error(`The conversion is blocked by ${plan.blocker.id}.`);
	return committed(doc, plan.mutations);
}

/** The plan of CommCare HQ's app becoming `theirs`, published from `ref`, with Nova at `now`. */
async function planOf(
	ref: BlueprintDoc,
	theirs: BlueprintDoc,
	options: {
		readonly now?: BlueprintDoc;
		readonly renamesSince?: Parameters<
			typeof planFromDocuments
		>[0]["renamesSince"];
	} = {},
) {
	return planFromDocuments({
		ref,
		now: options.now ?? ref,
		base: await readingOf(ref, ref),
		theirs: await readingOf(theirs, ref),
		renamesSince: options.renamesSince ?? [],
	});
}

function changesOf(
	plan: Awaited<ReturnType<typeof planOf>>,
): Extract<typeof plan, { kind: "changes" }> {
	if (plan.kind !== "changes")
		throw new Error(
			`The plan is ${plan.kind}${plan.kind === "differs" ? `: ${plan.signature}` : ""}.`,
		);
	return plan;
}

function catalogOf(doc: BlueprintDoc, caseType: string) {
	return doc.caseTypes?.find((type) => type.name === caseType)?.properties;
}

/** The app the target commits to: the batch replayed over the head through the gate. */
function admitted(now: BlueprintDoc, batch: readonly Mutation[]) {
	return mutationCommitVerdict(
		now,
		admitMutationBatch(JSON.parse(JSON.stringify(batch))),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
}

// ── The arms of a plan ───────────────────────────────────────────────

/* Each case reads a retained CommCare HQ source through the production reader
 * twice and judges it with acceptance, seconds of work the first case also
 * pays the reader's warm-up for. */
it("keeps a starting answer left behind by an earlier adoption pending across an unrelated HQ edit", async () => {
	const field = testUuid("historical-start");
	const withStart = buildDoc({
		appId: APP_ID,
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: field,
								id: "stage",
								kind: "hidden",
								calculate: "'current'",
								default_value: "'first'",
							}),
						],
					},
				],
			},
		],
	});
	const reference = produce(withStart, (draft) => {
		const stage = draft.fields[field];
		if (stage?.kind !== "hidden") throw new Error("Missing hidden field");
		delete stage.default_value;
	});
	const renamed = produce(withStart, (draft) => {
		draft.appName = "Renamed at HQ";
	});
	const source = await readingOf(withStart, reference);
	const now = await readingOf(renamed, reference);
	const plan = planFromDocuments({
		ref: reference,
		now: reference,
		base: source,
		theirs: now,
		renamesSince: [],
	});
	const { target } = changesOf(plan);
	expect(target.appName).toBe(renamed.appName);
	expect(stillOmitsHiddenStartingAnswer(source, reference, now, target)).toBe(
		true,
	);
	const restored = produce(target, (draft) => {
		const stage = draft.fields[field];
		const prior = withStart.fields[field];
		if (stage?.kind !== "hidden" || prior?.kind !== "hidden")
			throw new Error("Missing hidden field");
		stage.default_value = prior.default_value;
	});
	expect(stillOmitsHiddenStartingAnswer(source, reference, now, restored)).toBe(
		false,
	);
	expect(
		stillOmitsHiddenStartingAnswer(source, reference, reference, target),
	).toBe(false);
	expect(stillOmitsHiddenStartingAnswer(source, withStart, now, target)).toBe(
		false,
	);
});

describe("planHqChanges", { timeout: 30_000 }, () => {
	/**
	 * An app Nova brought in from CommCare HQ's retained source of the corpus
	 * document `navigation-base`, and the two readings a review then makes
	 * over CommCare HQ's retained answers: the base from the source as the
	 * birth's baseline stores it, the reading now from one bracketed read of
	 * the app with HQ's own question summary, the source changed as `body`
	 * changes it. Both through the app's identities under the ids CommCare
	 * HQ holds, as the birth records them.
	 */
	async function readings(
		body: (raw: Record<string, unknown>) => Record<string, unknown> = (one) =>
			one,
	): Promise<{ readonly ref: BlueprintDoc; readonly read: HqChangeReadings }> {
		const document = publishedCorpus().find(
			(one) => one.id === "navigation-base",
		);
		if (document === undefined)
			throw new Error("The corpus holds the document navigation-base.");
		const published = hydrated(document);
		const served = servedExport(published);
		const shared = {
			...(await readBackInput(published, served)),
			media: mediaIndex(served.assetOfPath),
		};
		const stored = normalizeHqAppSource(
			retainedSourceBody("navigation-base/app-source"),
		);
		if ("malformed" in stored)
			throw new Error("The retained source is malformed.");
		const baseSource = sourceFromBaseline(JSON.parse(stored.text));
		const modules = alignedFromSource(baseSource);

		// The birth: a first reading, under the declaration it proposes.
		const first = readHqApp({
			...shared,
			source: baseSource,
			modules,
			resolver: mintingResolver(shared.appId),
		});
		if (first.kind !== "read" || first.draft.declaration.kind !== "choices")
			throw new Error("The retained source does not read clean.");
		const proposed =
			first.draft.declaration.choices[first.draft.declaration.proposed];
		if (proposed === undefined) throw new Error("No choice is proposed.");
		const ref = committed(first.draft.doc, proposed.mutations);
		const identity = targetWireIdentity([
			...first.draft.identities.modules.map((menu) => ({
				entityKind: "module" as const,
				novaEntityUuid: menu.uuid,
				uniqueId: menu.uniqueId,
				xmlns: null,
			})),
			...first.draft.identities.forms.map((form) => ({
				entityKind: "form" as const,
				novaEntityUuid: form.uuid,
				uniqueId: null,
				xmlns: form.xmlns,
			})),
		]);
		const resolver = () =>
			matchingResolver(ref.appId, externalIdentityMap(ref, identity));

		const base = {
			...shared,
			source: baseSource,
			modules,
			resolver: resolver(),
		};
		const reading = await navigationBaseRead({ body });
		const now = {
			...shared,
			source: inStoredKeyOrder(reading.source),
			modules: reading.modules,
			resolver: resolver(),
		};
		const baseOutcome = readHqApp(base);
		if (baseOutcome.kind !== "read")
			throw new Error("The base reads to an account.");
		return {
			ref,
			read: {
				base: baseOutcome,
				now: readHqApp(now),
				inputs: { base, now },
				baseMediaClaims: [],
			},
		};
	}

	/** Acceptance of the reading now, as a review asks it, the files playing on `playsOn`. */
	function accepted(
		read: HqChangeReadings,
		playsOn: Parameters<typeof narrowDeclarationsByMedia>[1] = [
			"web-apps",
			"android",
		],
	) {
		if (read.now.kind !== "read")
			throw new Error("The reading now is an account.");
		const choices = narrowDeclarationsByMedia(
			read.now.draft.declaration,
			playsOn,
		);
		if (choices.kind !== "choices") throw new Error("No choice plays.");
		return acceptReading({
			...acceptanceInput(read.inputs.now, read.now),
			choices,
		});
	}

	const reference = (doc: BlueprintDoc) =>
		({
			kind: "ok",
			doc,
			identityDoc: doc,
			renamesSince: [],
			actors: [],
		}) as const;

	/** `raw` with its first menu named `name` in English. */
	const menuNamed =
		(name: string) =>
		(raw: Record<string, unknown>): Record<string, unknown> => {
			const modules = structuredClone(raw.modules) as {
				name: Record<string, string>;
			}[];
			const first = modules[0];
			if (first === undefined) throw new Error("The source holds no menu.");
			first.name = { ...first.name, en: name };
			return { ...raw, modules };
		};

	it("answers nothing where CommCare HQ's app reads as the published one", async () => {
		const { ref, read } = await readings();
		expect(
			planHqChanges({
				baseMediaFiles: [],
				reference: reference(ref),
				now: ref,
				readings: read,
				accepted: accepted(read),
			}),
		).toEqual({ kind: "nothing", publishChanges: [] });
	});

	it("answers the change, and what the next publish changes beside it", async () => {
		const { ref, read } = await readings(menuNamed("Clients"));
		const plan = planHqChanges({
			baseMediaFiles: [],
			reference: reference(ref),
			now: ref,
			readings: read,
			accepted: accepted(read),
		});
		expect(plan.kind === "differs" ? plan.signature : plan.kind).toBe(
			"changes",
		);
		if (plan.kind !== "changes") return;
		expect(plan.appliedTo).toBe("head");
		expect(plan.target.modules[ref.moduleOrder[0] as Uuid]?.name).toBe(
			"Clients",
		);
		expect(plan.publishChanges).toEqual([]);
		expect(admitted(ref, plan.batch).ok).toBe(true);
	});

	it("answers an account where CommCare HQ's app holds something Nova cannot hold", async () => {
		// A custom suite turned on in CommCare HQ: Nova writes every suite itself.
		const { ref, read } = await readings((raw) => ({
			...raw,
			use_custom_suite: true,
		}));
		expect(read.now.kind).toBe("account");
		const plan = planHqChanges({
			baseMediaFiles: [],
			reference: reference(ref),
			now: ref,
			readings: read,
			accepted: null,
		});
		expect(plan.kind).toBe("account");
		if (plan.kind === "account" && read.now.kind === "account")
			expect(plan.findings).toEqual(read.now.findings);
	});

	it("answers differs with acceptance's own check where acceptance failed", async () => {
		const { ref, read } = await readings();
		if (read.now.kind !== "read")
			throw new Error("The reading now is an account.");
		const failed = acceptReading({
			...acceptanceInput(read.inputs.now, read.now),
			settlements: [
				{
					artifact: "app",
					where: "nowhere",
					key: "no-hand-off",
					by: "finding",
				},
			],
		});
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(
			planHqChanges({
				baseMediaFiles: [],
				reference: reference(ref),
				now: ref,
				readings: read,
				accepted: failed,
			}),
		).toEqual({
			kind: "differs",
			check: failed.check,
			signature: failed.signature,
		});
	});

	it("holds the change where CommCare HQ's app runs on no platform the app declares", async () => {
		const { ref, read } = await readings();
		const runs = ref.appSettings.runsOnlyOn;
		const elsewhere = runs === "android" ? "web-apps" : "android";
		expect(
			planHqChanges({
				baseMediaFiles: [],
				reference: reference(ref),
				now: ref,
				readings: read,
				accepted: accepted(read, [elsewhere]),
			}),
		).toEqual({ kind: "held", reason: "runs-elsewhere" });
	});

	it("refuses a reference Nova could not build, naming the answer", async () => {
		const { ref, read } = await readings();
		expect(() =>
			planHqChanges({
				baseMediaFiles: [],
				reference: { kind: "nova-updated" } as unknown as ReturnType<
					typeof reference
				>,
				now: ref,
				readings: read,
				accepted: accepted(read),
			}),
		).toThrow(
			"Nova was asked to plan CommCare HQ's changes with no reference document. `loadReferenceDocument` answers `nova-updated` when it cannot build one, and the caller answers `unavailable` for it instead of planning.",
		);
	});
});

// ── What CommCare HQ's build never reads ─────────────────────────────

describe("an answer stored beside a yes/no condition", () => {
	it("is no change CommCare HQ made, since HQ's build never reads it", async () => {
		// HQ's own starter apps store `answer: "1"` beside `boolean_true`
		// (`xform.py::XForm.action_relevance` writes the question's path alone),
		// so a save there that changes only that answer builds the same app.
		const flag = testUuid("plan-close-flag");
		const ref = buildDoc({
			appId: APP_ID,
			appName: "Visits",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Close",
							type: "close",
							closeCondition: {
								kind: "term",
								term: { kind: "field", uuid: flag },
							},
							fields: [
								f({
									kind: "hidden",
									id: "flag",
									uuid: flag,
									calculate: {
										kind: "term",
										term: { kind: "literal", value: "x" },
									},
								}),
							],
						},
					],
				},
			],
		});
		const answerBeside =
			(answer: string) =>
			(body: Record<string, unknown>): void => {
				const close = (
					body.modules as {
						forms: { actions: { close_case: { condition: object } } }[];
					}[]
				)[0]?.forms[0]?.actions.close_case;
				if (close === undefined) throw new Error("The form closes its case.");
				close.condition = { ...close.condition, answer };
			};
		expect(
			planFromDocuments({
				ref,
				now: ref,
				base: await readingOf(ref, ref, undefined, answerBeside("1")),
				theirs: await readingOf(ref, ref, undefined, answerBeside("yes")),
				renamesSince: [],
			}),
		).toEqual({ kind: "nothing", publishChanges: [] });
	});
});

describe("Connect roles inferred from HQ activities", () => {
	it("adds the role of a new HQ activity alongside a role already selected in Nova, then keeps both after the activity is removed", async () => {
		const form = id("role-visit");
		const ref = buildDoc({
			appId: APP_ID,
			appName: "Visits",
			connectRoles: ["learn"],
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				runsOnlyOn: "android",
			},
			modules: [
				{
					name: "Visits",
					forms: [
						{
							uuid: form,
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		const delivered = committed(ref, [
			{ kind: "setConnectRoles", roles: ["learn", "deliver"] },
			{
				kind: "addField",
				parentUuid: form,
				field: {
					uuid: id("role-activity"),
					id: "visit",
					kind: "connect_activity",
					activity: { kind: "delivery", name: "Visit" },
				},
			},
		]);
		const first = changesOf(await planOf(ref, delivered));
		expect(first.target.connectRoles).toEqual(["learn", "deliver"]);
		const firstCommit = admitted(ref, first.batch);
		if (!firstCommit.ok) throw new Error(JSON.stringify(firstCommit.findings));
		const taken = firstCommit.nextDoc;
		const activity = Object.values(taken.fields).find(
			(field) => field.id === "visit",
		);
		if (activity?.kind !== "connect_activity")
			throw new Error("The reviewed activity was not added.");
		const removed = committed(taken, [
			{ kind: "removeField", uuid: activity.uuid },
		]);
		const second = changesOf(await planOf(taken, removed));
		expect(second.target.connectRoles).toEqual(["learn", "deliver"]);
		const secondCommit = admitted(taken, second.batch);
		if (!secondCommit.ok)
			throw new Error(JSON.stringify(secondCommit.findings));
		expect(secondCommit.nextDoc.fields[activity.uuid]).toBeUndefined();
	});
});

// ── The worker setup ─────────────────────────────────────────────────

describe("what a reading cannot say of the worker setup", () => {
	it("keeps a worker property and every value for it where CommCare HQ stops reading it", async () => {
		const ref = visits();
		const theirs = without(ref, HOME);
		const plan = changesOf(await planOf(ref, theirs));
		expect(plan.appliedTo).toBe("head");
		expect(plan.target.fields[id(HOME)]).toBeUndefined();
		expect(plan.target.userProperties).toEqual(ref.userProperties);
		expect(plan.target.userTypes).toEqual(ref.userTypes);
		expect(plan.target.personas).toEqual(ref.personas);
		expect(
			plan.batch.filter((mutation) => mutation.kind.includes("UserProperty")),
		).toEqual([]);
	});

	it("binds a slug CommCare HQ starts reading to the property Nova holds under it", async () => {
		const ref = visits();
		const theirs = committed(ref, [
			{
				kind: "addField",
				parentUuid: id(REGISTER),
				field: {
					uuid: id("plan-area"),
					id: "area",
					kind: "text",
					label: proseText("Area"),
					default_value: {
						kind: "term",
						term: { kind: "session-user-property", userPropertyUuid: DISTRICT },
					},
				},
			},
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(ref, theirs));
		expect(plan.target.userProperties).toEqual(ref.userProperties);
		expect(plan.target.userPropertyOrder).toEqual(ref.userPropertyOrder);
		expect(
			plan.batch.filter((mutation) => mutation.kind === "addUserProperty"),
		).toEqual([]);
		const added = Object.values(plan.target.fields).find(
			(field) => field.id === "area",
		) as { default_value?: unknown } | undefined;
		expect(added?.default_value).toEqual({
			kind: "term",
			term: { kind: "session-user-property", userPropertyUuid: DISTRICT },
		});
	});
});

// ── Translations ─────────────────────────────────────────────────────

describe("a translation whose source CommCare HQ reworded", () => {
	it("keeps its text and its provenance, and is marked for review", async () => {
		const unit = makeTranslationUnitId("field", id(NOTE), "label");
		const ref = produce(visits(), (draft) => {
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fr" },
				translations: {
					fra: {
						[unit]: {
							value: proseText("Remarque"),
							sourceFingerprint: translationSourceFingerprint(
								"prose",
								proseText("Note"),
							),
							origin: "ai",
							review: "reviewed",
							translatedFrom: "eng",
						},
					},
				},
			} as BlueprintDoc["localization"];
		});
		const B = await readingOf(ref, ref);
		// CommCare HQ's form builder rewords the English label and leaves the French as it is,
		// which a reading takes as a person's French against the new source.
		const reworded = proseText("Visit remarks");
		const T = produce(B, (draft) => {
			const field = draft.fields[id(NOTE)] as { label?: unknown };
			field.label = reworded;
			const entry = draft.localization?.translations.fra?.[unit];
			if (entry === undefined) throw new Error("The reading holds no French.");
			entry.sourceFingerprint = translationSourceFingerprint("prose", reworded);
		});
		const plan = changesOf(
			planFromDocuments({
				ref,
				now: ref,
				base: B,
				theirs: T,
				renamesSince: [],
			}),
		);
		expect(plan.target.localization?.translations.fra?.[unit]).toEqual({
			value: proseText("Remarque"),
			sourceFingerprint: translationSourceFingerprint("prose", reworded),
			origin: "ai",
			review: "needs-review",
			translatedFrom: "eng",
		});
		expect(plan.hqChanges.translations.review).toBe(1);
	});
});

describe("a translation whose own text CommCare HQ changed", () => {
	it("takes CommCare HQ's text as a person's, reviewed, in place of Nova's", async () => {
		const unit = makeTranslationUnitId("field", id(NOTE), "label");
		const ref = produce(visits(), (draft) => {
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fr" },
				translations: {
					fra: {
						[unit]: {
							value: proseText("Remarque"),
							sourceFingerprint: translationSourceFingerprint(
								"prose",
								proseText("Note"),
							),
							origin: "ai",
							review: "needs-review",
							translatedFrom: "eng",
						},
					},
				},
			} as BlueprintDoc["localization"];
		});
		const B = await readingOf(ref, ref);
		// CommCare HQ's form builder rewrites the French label alone.
		const T = produce(B, (draft) => {
			const entry = draft.localization?.translations.fra?.[unit];
			if (entry === undefined) throw new Error("The reading holds no French.");
			entry.value = proseText("Note de visite");
		});
		const read = T.localization?.translations.fra?.[unit];
		expect(read?.review).toBe("reviewed");
		const plan = changesOf(
			planFromDocuments({
				ref,
				now: ref,
				base: B,
				theirs: T,
				renamesSince: [],
			}),
		);
		expect(plan.target.localization?.translations.fra?.[unit]).toEqual(read);
	});
});

describe("HQ language renames and saved translations", () => {
	const name = makeTranslationUnitId("app", "name");
	const fp = (value: string) => translationSourceFingerprint("text", value);
	function source() {
		return produce(visits(), (draft) => {
			draft.appName = "Community clinic";
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra", "project:qaa"],
				wireCodes: { eng: "en", fra: "fr", "project:qaa": "qaa" },
				translations: {
					fra: {
						[name]: {
							value: "Clinique",
							sourceFingerprint: fp("Community clinic"),
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
						},
					},
					"project:qaa": {
						[name]: {
							value: "Klinik",
							sourceFingerprint: fp("Clinic"),
							origin: "ai",
							review: "needs-review",
							translatedFrom: "eng",
						},
					},
				},
			};
		});
	}
	it.each([
		["eng", "eng"],
		["fra", "fra"],
	])(
		"brings an HQ change of the %s resource code into the same language",
		async (tag, to) => {
			const ref = source();
			const changed = produce(ref, (draft) => {
				if (draft.localization) draft.localization.wireCodes[tag] = to;
			});
			const B = await readingOf(ref, ref);
			const T = await readingOf(changed, ref);
			const plan = changesOf(
				planFromDocuments({
					ref,
					now: ref,
					base: B,
					theirs: T,
					renamesSince: [],
				}),
			);
			expect(plan.target.localization).toEqual(changed.localization);
			expect(plan.batch).toContainEqual({
				kind: "rebindLanguageCodes",
				changes: [
					{ language: tag, from: ref.localization?.wireCodes[tag], to },
				],
			});
			expect(admitted(ref, plan.batch).ok).toBe(true);
		},
	);
	it.each(["keep", "replace", "clear"] as const)(
		"opens the stale phrase becoming source for a decision and accepts the new review after %s",
		async (action) => {
			const ref = produce(source(), (draft) => {
				const entry = draft.localization?.translations.fra[name];
				if (!entry) throw Error("Missing French");
				entry.sourceFingerprint = fp("Clinic");
				entry.origin = "ai";
				entry.review = "needs-review";
			});
			const B = await readingOf(ref, ref);
			const T = await readingOf(ref, ref, undefined, (body) => {
				body.name = "Clinique";
				body.langs = ["fr", "en", "qaa"];
				const strings = body.translations as Record<
					string,
					Record<string, string>
				>;
				for (const lang of ["en", "qaa", "fr"])
					strings[lang] = {
						...strings[lang],
						"app.display.name": lang === "fr" ? "Clinique" : "Community clinic",
						"homescreen.title": lang === "fr" ? "Clinique" : "Community clinic",
					};
			});
			const input = { ref, base: B, theirs: T, renamesSince: [] };
			expect(planFromDocuments({ ...input, now: ref })).toMatchObject({
				kind: "held",
				reason: "stale-source-translation",
				translation: { language: { language: "fra" }, unitId: name },
			});
			const now = committed(
				ref,
				action === "keep"
					? [
							{
								kind: "reviewTranslation",
								language: "fra",
								unitId: name,
								expectedSourceFingerprint: fp("Clinic"),
								sourceFingerprint: fp("Community clinic"),
								value: "Clinique",
							},
						]
					: [
							{
								kind: "setTranslation",
								language: "fra",
								unitId: name,
								entry:
									action === "clear"
										? null
										: {
												value: "Clinique locale",
												origin: "human",
												review: "reviewed",
												translatedFrom: "eng",
												sourceFingerprint: fp("Community clinic"),
											},
							},
						],
			);
			const next = changesOf(planFromDocuments({ ...input, now }));
			expect(next.target.localization?.sourceLanguage).toBe("fra");
			expect(admitted(now, next.batch).ok).toBe(true);
		},
	);
	it.each([true, false])(
		"preserves the stale editable translation and the actual HQ worker fallback (old wording explicitly kept %s)",
		async (keepOld) => {
			const ref = source();
			const B = await readingOf(ref, ref);
			const T = await readingOf(ref, ref, undefined, (body) => {
				body.name = "Clinique";
				body.langs = ["fr", "en", "qaa"];
				const strings = body.translations as Record<
					string,
					Record<string, string>
				>;
				for (const lang of ["en", "qaa", "fr"])
					strings[lang] = {
						...strings[lang],
						"app.display.name":
							lang === "fr" || (lang === "qaa" && !keepOld)
								? "Clinique"
								: "Community clinic",
						"homescreen.title":
							lang === "fr" || (lang === "qaa" && !keepOld)
								? "Clinique"
								: "Community clinic",
					};
			});
			const plan = changesOf(
				planFromDocuments({
					ref,
					now: ref,
					base: B,
					theirs: T,
					renamesSince: [],
				}),
			);
			const unit = snapshotTranslationUnits(plan.target).get(name);
			if (!unit) throw Error("Missing app name");
			expect(
				localizeTranslationUnit(plan.target, "project:qaa", unit),
			).toMatchObject({
				status: "out-of-date",
				explicit: ref.localization?.translations["project:qaa"][name],
				effective: keepOld ? "Community clinic" : "Clinique",
			});
			expect(admitted(ref, plan.batch).ok).toBe(true);
			const read = await readingOf(plan.target, plan.target);
			expect(
				read.localization?.translations["project:qaa"][name]?.value ??
					read.appName,
			).toBe(keepOld ? "Community clinic" : "Clinique");
			const reviewed = committed(plan.target, [
				{
					kind: "reviewTranslation",
					language: "project:qaa",
					unitId: name,
					expectedSourceFingerprint: fp("Clinic"),
					sourceFingerprint: unit.sourceFingerprint,
					value: "Klinik",
				},
			]);
			const restored = localizeTranslationUnit(reviewed, "project:qaa", unit);
			expect(restored).toMatchObject({
				status: "ready",
				effective: "Klinik",
				explicit: { origin: "ai", review: "reviewed" },
			});
			expect(restored.explicit?.workerFallback).toBeUndefined();
		},
	);
});
it("keeps one column's source and Spanish row wording while its Results cell is hidden through an HQ re-read", async () => {
	const initial = localizationWireFixture("bilingual");
	const moduleUuid = initial.moduleOrder[0];
	const column = initial.modules[moduleUuid].caseListConfig?.columns[0];
	if (!column) throw Error("The fixture needs a case column");
	const id = generatedWordingId(
		column.uuid,
		"caseRows",
		makeTranslationUnitId("column", column.uuid, "header"),
	);
	const unit = snapshotTranslationUnits(initial).get(id);
	if (!unit) throw Error("The column needs an owned row label");
	const entry = {
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
		sourceFingerprint: unit.sourceFingerprint,
	} as const;
	const original = committed(initial, [
		{
			kind: "addColumn",
			moduleUuid,
			column: plainColumn(
				testUuid("still-visible-name"),
				"case_name",
				"Patient",
			),
			afterInList: column.uuid,
			afterInDetail: column.uuid,
		},
		{
			kind: "setTranslation",
			language: "eng",
			unitId: id,
			entry: { ...entry, value: "Priority patient" },
		},
	]);
	const current = snapshotTranslationUnits(original).get(id);
	if (!current) throw Error("The original needs its generated wording");
	const given = committed(original, [
		{
			kind: "setTranslation",
			language: "spa",
			unitId: id,
			entry: {
				...entry,
				sourceFingerprint: current.sourceFingerprint,
				value: "Paciente prioritario",
			},
		},
	]);
	const visibility = (visible: boolean): Mutation => ({
		kind: "updateColumn",
		moduleUuid,
		uuid: column.uuid,
		visibilityPatch: { surface: "list", visible },
	});
	const hidden = committed(given, [visibility(false)]);
	expect(hidden.localization?.generatedSourceWording?.[id]).toEqual(
		given.localization?.generatedSourceWording?.[id],
	);
	expect(hidden.localization?.translations.spa[id]).toEqual(
		given.localization?.translations.spa[id],
	);
	expect(snapshotTranslationUnits(hidden).get(id)?.generated?.dormant).toBe(
		true,
	);
	expect(Object.values(expandDoc(hidden).translations?.en ?? {})).not.toContain(
		"Priority patient",
	);
	const read = await readingOf(hidden, hidden);
	const changed = committed(hidden, [
		{ kind: "setAppName", name: "Field visits" },
	]);
	const theirs = await readingOf(changed, hidden);
	const staged = committed(hidden, [
		{ kind: "setAppName", name: "Unpublished name" },
		{
			kind: "setTranslation",
			language: "eng",
			unitId: id,
			entry: {
				...entry,
				sourceFingerprint: current.sourceFingerprint,
				value: "Staged priority",
			},
		},
	]);
	const plan = changesOf(
		planFromDocuments({
			ref: hidden,
			now: staged,
			base: read,
			theirs,
			renamesSince: [],
		}),
	);
	expect(plan.appliedTo).toBe("published");
	const taken = committed(staged, plan.batch);
	const restored = committed(taken, [visibility(true)]);
	expect(Object.values(expandDoc(restored).translations?.en ?? {})).toContain(
		"Staged priority",
	);
	expect(Object.values(expandDoc(restored).translations?.es ?? {})).toContain(
		"Paciente prioritario",
	);
	const removed = committed(hidden, [
		{ kind: "removeColumn", moduleUuid, uuid: column.uuid },
	]);
	expect(removed.localization?.generatedSourceWording?.[id]).toBeUndefined();
	expect(removed.localization?.translations.spa[id]).toBeUndefined();
});

it("retains a search result column's wording across a search being disabled and enabled", () => {
	const doc = localizationWireFixture("bilingual");
	const owner = doc.moduleOrder[0];
	const column = doc.modules[owner].caseListConfig?.columns[0];
	if (!column) throw Error("The fixture needs a case column");
	const edit = (enabled: boolean): Mutation => ({
		kind: "updateModule",
		uuid: owner,
		patch: {},
		caseSearchConfigOperation: enabled ? "enable" : "disable-if-unused",
	});
	const withSearch = committed(doc, [edit(true)]);
	const id = generatedWordingId(
		column.uuid,
		"searchRows",
		makeTranslationUnitId("column", column.uuid, "header"),
	);
	const unit = snapshotTranslationUnits(withSearch).get(id);
	if (!unit) throw Error("Expected a search result label");
	const entry = {
		value: "Search priority",
		origin: "ai",
		review: "needs-review",
		sourceFingerprint: unit.sourceFingerprint,
		translatedFrom: "eng",
	} as const;
	const given = committed(withSearch, [
		{ kind: "setTranslation", language: "spa", unitId: id, entry },
	]);
	const disabled = committed(given, [edit(false)]);
	expect(disabled.localization?.translations.spa[id]).toEqual(entry);
	expect(
		Object.values(expandDoc(disabled).translations?.es ?? {}),
	).not.toContain(entry.value);
	expect(
		Object.values(
			expandDoc(committed(disabled, [edit(true)])).translations?.es ?? {},
		),
	).toContain(entry.value);
});

it("keeps a stale generated draft recoverable when its language becomes the original", () => {
	const initial = localizationWireFixture("bilingual");
	const menu = initial.moduleOrder[0],
		form = initial.formOrder[menu][0];
	const id = generatedWordingId(form, "submitButton");
	const set = (doc: BlueprintDoc, language: string, value: string) => {
		const unit = snapshotTranslationUnits(doc).get(id);
		if (!unit) throw Error("Missing submit button");
		return committed(doc, [
			{
				kind: "setTranslation",
				language,
				unitId: id,
				entry: {
					value,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "ai",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		]);
	};
	const first = set(initial, "eng", "Complete the visit");
	const translated = set(first, "spa", "Guardar visita");
	const changed = set(translated, "eng", "Send the record");
	const promoted = committed(changed, [
		{ kind: "rebaseSourceLanguage", from: "eng", to: "spa" },
	]);
	const unit = snapshotTranslationUnits(promoted).get(id);
	if (!unit) throw Error("Missing promoted submit button");
	const row = localizeTranslationUnit(promoted, "spa", unit);
	expect(row).toMatchObject({
		status: "out-of-date",
		effective: "Submit",
		explicit: {
			value: "Guardar visita",
			origin: "ai",
			review: "reviewed",
			workerFallback: { value: "Submit" },
		},
	});
	expect(expandDoc(promoted).translations?.en["forms.m0f0.submit_label"]).toBe(
		"Send the record",
	);
	const kept = committed(promoted, [
		{
			kind: "reviewTranslation",
			language: "spa",
			unitId: id,
			value: "Guardar visita",
			expectedSourceFingerprint: row.explicit?.sourceFingerprint ?? "",
			sourceFingerprint: row.sourceFingerprint,
		},
	]);
	expect(expandDoc(kept).translations?.es["forms.m0f0.submit_label"]).toBe(
		"Guardar visita",
	);
});

it("retains the reviewed Spanish wording of an unused search guard when Spanish becomes the HQ source", async () => {
	const initial = localizationWireFixture("prompts");
	const id = makeTranslationUnitId(
		"system",
		"search-validation",
		"whole-number",
	);
	const guard = snapshotTranslationUnits(initial).get(id);
	if (!guard) throw Error("Missing whole-number guard");
	const entry = {
		value: "Un entero, por favor",
		sourceFingerprint: guard.sourceFingerprint,
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	} as const;
	const combinedId = makeTranslationUnitId(
		"system",
		"search-validation",
		"combined:whole-number+quote",
	);
	const combined = snapshotTranslationUnits(initial).get(combinedId);
	if (!combined) throw Error("Missing whole-number and quotation guard");
	const combinedText = "Indique un entero sin mezclar comillas.";
	const form = initial.formOrder[initial.moduleOrder[0]][0];
	const buttonId = makeTranslationUnitId("generated", form, "submitButton");
	const button = snapshotTranslationUnits(initial).get(buttonId);
	if (!button) throw Error("Missing form submit control");
	const oldButton = {
		...entry,
		value: "Finish intake",
		sourceFingerprint: button.sourceFingerprint,
		origin: "ai",
		review: "needs-review",
	} as const;
	const ref = committed(initial, [
		{
			kind: "setTranslation",
			language: "eng",
			unitId: buttonId,
			entry: oldButton,
		},
	]);
	const now = committed(ref, [
		// A separate wire-visible edit makes this a take over the published
		// reference. The review reports its loss, while dormant guards survive.
		{ kind: "setAppName", name: "Unpublished title" },
		{ kind: "setTranslation", language: "spa", unitId: id, entry },
		{
			kind: "setTranslation",
			language: "spa",
			unitId: combinedId,
			entry: {
				...entry,
				sourceFingerprint: combined.sourceFingerprint,
				value: combinedText,
			},
		},
	]);
	const B = await readingOf(ref, ref);
	const T = await readingOf(ref, ref, undefined, (body) => {
		body.name = "Búsqueda";
		const strings = body.translations as Record<string, Record<string, string>>;
		strings.en = {
			...strings.en,
			"app.display.name": ref.appName,
			"homescreen.title": ref.appName,
		};
	});
	expect(T.localization?.sourceLanguage).toBe("spa");
	const plan = changesOf(
		planFromDocuments({ ref, now, base: B, theirs: T, renamesSince: [] }),
	);
	expect(plan.appliedTo).toBe("published");
	const saved = committed(now, plan.batch);
	const requiredId = makeTranslationUnitId(
		"system",
		"search-required",
		"default",
	);
	const required = ref.localization?.translations.spa[requiredId];
	expect(required?.value).toBe("Complete esta respuesta antes de buscar.");
	expect(saved.localization?.generatedSourceWording?.[requiredId]).toEqual(
		required,
	);
	expect(saved.localization?.translations.eng[buttonId]).toEqual(oldButton);
	expect(localizeTranslationUnit(saved, "eng", button)).toMatchObject({
		effective: "Finish intake",
		status: "needs-review",
	});
	expect(expandDoc(saved).translations?.en["forms.m0f0.submit_label"]).toBe(
		"Finish intake",
	);
	expect(
		expandDoc(saved).translations?.es["forms.m0f0.submit_label"],
	).toBeUndefined();
	expect(localizeTranslationUnit(saved, "spa", guard)).toMatchObject({
		effective: entry.value,
		explicit: entry,
	});
	expect(localizeTranslationUnit(saved, "eng", guard).effective).toBe(
		guard.source,
	);
	const months = testUuid("months-since-visit");
	const printing = committed(saved, [
		{
			kind: "addCaseProperty",
			caseType: "patient",
			property: {
				name: "due_date",
				label: proseText("Due date"),
				data_type: "date",
			},
		},
		{
			kind: "addSearchInput",
			moduleUuid: saved.moduleOrder[0],
			searchInput: advancedSearchInputDef(
				months,
				"months",
				"Months",
				"text",
				whenInput(
					input(months),
					eq(
						prop("patient", "due_date"),
						dateAdd(today(), "months", double(term(input(months)))),
					),
				),
			),
		},
	]);
	const body = servedExport(printing).body;
	expect(body.modules).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				search_config: expect.objectContaining({
					properties: expect.arrayContaining([
						expect.objectContaining({
							name: "months",
							validations: [
								expect.objectContaining({
									text: { en: combined.source, es: combinedText },
								}),
							],
						}),
					]),
				}),
			}),
		]),
	);
	const read = await readingOf(printing, printing);
	expect(localizeTranslationUnit(read, "spa", combined).effective).toBe(
		combinedText,
	);
	const customized = committed(printing, [
		{
			kind: "setTranslation",
			language: "eng",
			unitId: combinedId,
			entry: {
				...entry,
				sourceFingerprint: translationSourceFingerprint("text", combinedText),
				translatedFrom: "spa",
				value: "Enter an integer without mixing quotation marks.",
			},
		},
	]);
	const both = await readingOf(customized, customized);
	expect(localizeTranslationUnit(both, "spa", combined).effective).toBe(
		combinedText,
	);
	expect(localizeTranslationUnit(both, "eng", combined).effective).toBe(
		"Enter an integer without mixing quotation marks.",
	);
});

describe("a new first language in an app with several", () => {
	it("keeps the incumbent source through a reorder and rebases a change to the app's original wording", async () => {
		const ref = produce(visits(), (draft) => {
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fr" },
				translations: { fra: {} },
			};
		});
		const B = await readingOf(ref, ref);
		const reordered = await readingOf(ref, ref, undefined, (body) => {
			body.langs = ["fr", "en"];
		});
		expect(reordered.localization).toMatchObject({
			defaultLanguage: "fra",
			sourceLanguage: "eng",
		});
		const T = await readingOf(ref, ref, undefined, (body) => {
			body.langs = ["fr", "en"];
			const strings = body.translations as Record<
				string,
				Record<string, string>
			>;
			strings.en = {
				...strings.en,
				"app.display.name": ref.appName,
				"homescreen.title": ref.appName,
			};
			body.name = "Tournées";
		});
		expect(T.localization).toMatchObject({
			defaultLanguage: "fra",
			sourceLanguage: "fra",
		});
		const plan = changesOf(
			planFromDocuments({
				ref,
				now: ref,
				base: B,
				theirs: T,
				renamesSince: [],
			}),
		);
		expect(plan.target.appName).toBe("Tournées");
		expect(
			Object.values(plan.target.localization?.translations.eng ?? {}).map(
				(entry) => entry.value,
			),
		).toContain(ref.appName);
	});
});

// ── Unpublished changes ──────────────────────────────────────────────

describe("changes made in Nova since the publish", () => {
	const renamedVisit = (doc: BlueprintDoc) =>
		committed(doc, [
			{ kind: "renameForm", uuid: id(VISIT), newId: "Home visit" },
		] as unknown as Mutation[]);

	it("leaves a change both sides made alike off Nova's list, with no batch", async () => {
		const ref = visits();
		const both = renamedVisit(ref);
		const plan = changesOf(await planOf(ref, both, { now: both }));
		expect(plan.appliedTo).toBe("published");
		expect(plan.batch).toEqual([]);
		expect(plan.novaChanges.count).toBe(0);
	});

	it("puts the app's name changed in Nova on Nova's list", async () => {
		const ref = visits();
		const now = committed(ref, [{ kind: "setAppName", name: "Clinic visits" }]);
		const plan = changesOf(await planOf(ref, renamedVisit(ref), { now }));
		expect(plan.appliedTo).toBe("published");
		expect(plan.novaChanges.app).toEqual(["name"]);
		expect(plan.target.appName).toBe("Visits");
		expect(plan.target.forms[id(VISIT)]?.name).toBe("Home visit");
	});

	it("gives the lists and no batch where a case property was renamed in Nova", async () => {
		const ref = visits();
		const rename = { caseType: "patient", from: "visit_note", to: "notes" };
		const now = committed(ref, [
			{ kind: "renameCaseProperties", renames: [rename] },
		]);
		const plan = changesOf(
			await planOf(ref, renamedVisit(ref), { now, renamesSince: [rename] }),
		);
		expect(plan.appliedTo).toBe("published");
		expect(plan.renamedInNova).toEqual([rename]);
		expect(plan.batch).toEqual([]);
		expect(plan.hqChanges.count).toBeGreaterThan(0);
		expect(plan.novaChanges.count).toBeGreaterThan(0);
	});

	it("keeps a property the head declared since, and removes no declaration", async () => {
		const ref = visits();
		const now = committed(ref, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "allergy", label: proseText("Allergy") },
			},
			{ kind: "setAppName", name: "Clinic visits" },
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(ref, renamedVisit(ref), { now }));
		expect(plan.appliedTo).toBe("published");
		expect(catalogOf(plan.target, "patient")?.map((one) => one.name)).toContain(
			"allergy",
		);
		// CommCare HQ renamed a form and declared nothing: the kept declaration is on no list.
		expect(plan.hqChanges.app).toEqual([]);
		expect(plan.hqChanges.count).toBe(1);
		expect(plan.novaChanges.app).toEqual(["name"]);
		expect(
			plan.batch.filter((mutation) => mutation.kind === "removeCaseProperty"),
		).toEqual([]);
		expect(admitted(now, plan.batch).ok).toBe(true);
	});
});

// ── The case catalog ─────────────────────────────────────────────────

describe("the case catalog a change reaches", () => {
	it("keeps a declared property's declaration and label, and lists one only a save gave", async () => {
		const ref = visits();
		expect(catalogOf(ref, "patient")?.map((one) => one.name)).not.toContain(
			"temp",
		);
		const theirs = without(ref, NOTE, TEMP);
		const plan = changesOf(await planOf(ref, theirs));
		expect(
			catalogOf(plan.target, "patient")?.find(
				(one) => one.name === "visit_note",
			),
		).toEqual(
			catalogOf(ref, "patient")?.find((one) => one.name === "visit_note"),
		);
		expect(plan.removedCaseProperties).toEqual([
			{ caseType: "patient", name: "temp" },
		]);
		expect(
			plan.batch.filter((mutation) => mutation.kind === "removeCaseProperty"),
		).toEqual([]);
	});

	it("takes a property's new type and keeps the label Nova gave it", async () => {
		const ref = visits();
		const theirs = converted(ref, WEIGHT, "decimal");
		const plan = changesOf(await planOf(ref, theirs));
		expect(admitted(ref, plan.batch).ok).toBe(true);
		expect(
			catalogOf(plan.target, "patient")?.find((one) => one.name === "weight"),
		).toEqual({
			name: "weight",
			label: proseText("Weight"),
			data_type: "decimal",
		});
		expect(
			plan.batch.filter((mutation) => mutation.kind === "setCaseProperty"),
		).toHaveLength(1);
	});

	it("retires a case type the changed app no longer uses, and lists it", async () => {
		const ref = visits({ households: true });
		const theirs = committed(ref, [
			{ kind: "removeModule", uuid: id(HOUSEHOLDS) },
		]);
		const plan = changesOf(await planOf(ref, theirs));
		expect(plan.target.caseTypes?.map((type) => type.name)).not.toContain(
			"household",
		);
		expect(plan.removedCaseTypes).toEqual(["household"]);
	});

	it("places a property CommCare HQ starts saving after one the catalog declares, or first, where the one before it is only saved", async () => {
		const ref = visits();
		// `temp` is saved by the visit and declared nowhere; `temp_site` sorts right after it.
		expect(catalogOf(ref, "patient")?.map((one) => one.name)).not.toContain(
			"temp",
		);
		const site = id("plan-temp-site");
		const asked = committed(ref, [
			{
				kind: "addField",
				parentUuid: id(VISIT),
				field: {
					uuid: site,
					id: "temp_site",
					kind: "text",
					label: proseText("Where the temperature was taken"),
				},
			},
		] as unknown as Mutation[]);
		const theirs = committed(
			produce(asked, (draft) => {
				const own = draft.forms[id(VISIT)]?.caseOperations?.find(
					(one) => one.action === "own",
				);
				if (own === undefined) throw new Error("The visit holds no own arm.");
				own.writes = [
					...(own.writes ?? []),
					{
						property: "temp_site",
						value: { kind: "term", term: { kind: "field", uuid: site } },
					},
				];
			}),
			[],
		);
		const plan = changesOf(await planOf(ref, theirs));
		// The reading's catalog holds what the app saves, in name order: only `temp`, which the
		// catalog does not declare, comes before `temp_site`, so it goes first.
		expect(catalogOf(plan.target, "patient")?.map((one) => one.name)).toEqual([
			"temp_site",
			...(catalogOf(ref, "patient") ?? []).map((one) => one.name),
		]);
		expect(admitted(ref, plan.batch).ok).toBe(true);
	});

	it("applies the changes to the published document where a slug nothing reads was renamed in Nova", async () => {
		const published = visits();
		const now = committed(published, [
			{ kind: "updateUserProperty", uuid: DISTRICT, patch: { slug: "region" } },
		] as unknown as Mutation[]);
		const ref = withHeadUnsent(published, now);
		expect(ref.userProperties?.[DISTRICT]?.slug).toBe("district");
		// CommCare HQ's change starts reading the published slug.
		const theirs = committed(published, [
			{
				kind: "addField",
				parentUuid: id(REGISTER),
				field: {
					uuid: id("plan-area"),
					id: "area",
					kind: "text",
					label: proseText("Area"),
					default_value: {
						kind: "term",
						term: { kind: "session-user-property", userPropertyUuid: DISTRICT },
					},
				},
			},
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(ref, theirs, { now }));
		expect(plan.appliedTo).toBe("published");
		expect(plan.novaChanges.app).toContain("worker-properties");
		expect(plan.target.userProperties?.[DISTRICT]?.slug).toBe("district");
	});

	it("names an automation's read the change removes, and takes the change once the automation is edited", async () => {
		const rule = testUuid("plan-rule");
		const automation = {
			uuid: rule,
			kind: "case-update",
			name: "Flag fevers",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [
				{
					uuid: testUuid("plan-rule-fever"),
					kind: "match-property",
					scope: "case",
					property: "temp",
					matchType: "equal",
					value: "40",
				},
			],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: testUuid("plan-rule-update"),
					target: { scope: "case", property: "risk" },
					value: { kind: "literal", value: "high" },
				},
			],
			closeCase: false,
		} as unknown as Automation;
		const ref = committed(visits(), [
			{ kind: "addAutomation", automation },
		] as unknown as Mutation[]);
		// CommCare HQ's app holds no automation: its edit is made to the app without one.
		const theirs = without(visits(), TEMP);
		const first = changesOf(await planOf(ref, theirs));
		expect(first.appliedTo).toBe("head");
		const refused = admitted(ref, first.batch);
		expect(refused.ok).toBe(false);

		const edited = committed(ref, [
			{ kind: "removeAutomation", uuid: rule, targetKind: "case-update" },
		] as unknown as Mutation[]);
		const second = changesOf(
			planFromDocuments({
				ref,
				now: edited,
				base: await readingOf(ref, ref),
				theirs: await readingOf(theirs, ref),
				renamesSince: [],
			}),
		);
		expect(second.appliedTo).toBe("head");
		expect(second.novaChanges.count).toBe(0);
		expect(admitted(edited, second.batch).ok).toBe(true);
	});
});

// ── Nova's spelling of what CommCare HQ changed ──────────────────────

describe("a menu or form whose spelling no longer fits the change", () => {
	const SCREENS = "plan-screens-menu";
	const SCREEN = "plan-screen";
	const FIRST = "plan-first-page";
	const SECOND = "plan-second-page";
	const CLIENTS = "plan-clients";
	const SIGN_UP = "plan-sign-up";
	const TILE = {
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		horizontalAlign: "left",
		verticalAlign: "top",
		fontSize: "medium",
	} as const;

	/**
	 * Every dormant spelling of one kind, each on a menu or form a change
	 * can reach: a list's column holding a tile cell on a list that is no
	 * tile; a form whose formatting is off, its questions holding plain text
	 * flags, and whose root is two one-screen groups; and a menu whose
	 * registration a list offers after an empty search stands first.
	 */
	function dormant(): BlueprintDoc {
		const doc = buildDoc({
			appId: "plan-dormant",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: SCREENS,
					name: "Screens",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								...caseListConfig([{ field: "case_name", header: "Name" }])
									.columns[0],
								tile: TILE,
							} as never,
						],
						searchInputs: [],
					},
					forms: [
						{
							uuid: SCREEN,
							name: "Screen",
							type: "followup",
							fields: [
								f({
									uuid: FIRST,
									kind: "group",
									id: "first",
									label: "First",
									fieldList: true,
									children: [
										f({ kind: "text", id: "a", label: "A", plainLabel: true }),
									],
								}),
								f({
									uuid: SECOND,
									kind: "group",
									id: "second",
									label: "Second",
									fieldList: true,
									children: [
										f({ kind: "text", id: "b", label: "B", plainLabel: true }),
									],
								}),
							],
						},
					],
				},
				{
					uuid: CLIENTS,
					name: "Clients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: { formsReadSearch: true },
					caseListRegistrationForm: { formUuid: SIGN_UP },
					forms: [
						{
							uuid: SIGN_UP,
							name: "Sign up",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
						{
							name: "Check in",
							type: "followup",
							fields: [f({ kind: "text", id: "c", label: "C" })],
						},
					],
				},
			],
		});
		return committed(
			produce(doc, (draft) => {
				(draft.forms[id(SCREEN)] as { plainText?: true }).plainText = true;
			}),
			[],
		);
	}

	it("retains each hidden list action and registration menu title by its surviving owner", async () => {
		const module = id(CLIENTS),
			form = id(SIGN_UP);
		const entry = generatedWordingId(module, "caseListEntry");
		const action = generatedWordingId(module, "registerButton");
		const hiddenTitle = generatedWordingId(form, "registrationMenuTitle");
		const roles = [
			[entry, "Patient index"],
			[action, "Enroll patient"],
			[hiddenTitle, "Worker registration"],
		] as const;
		const show: Mutation = {
			kind: "setCaseListMenuItem",
			uuid: module,
			item: {},
		};
		const hide: Mutation = {
			kind: "setCaseListMenuItem",
			uuid: module,
			item: null,
		};
		const initial = committed(dormant(), [
			show,
			{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
		]);
		let current = initial;
		for (const language of ["eng", "spa"]) {
			const rows = snapshotTranslationUnits(current);
			current = committed(
				current,
				roles.map(([id, text]) => {
					const unit = rows.get(id);
					if (!unit || unit.generated?.dormant)
						throw Error("Expected a visible owned control");
					return {
						kind: "setTranslation",
						language,
						unitId: id,
						entry: {
							value: `${text} ${language}`,
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
							sourceFingerprint: unit.sourceFingerprint,
						},
					};
				}),
			);
		}
		const hidden = committed(current, [
			hide,
			...caseListRegistrationMutations(current, module, form, null),
		]);
		const body = expandDoc(hidden);
		for (const [id, text] of roles) {
			expect(snapshotTranslationUnits(hidden).get(id)?.generated?.dormant).toBe(
				true,
			);
			expect(hidden.localization?.generatedSourceWording?.[id]?.value).toBe(
				`${text} eng`,
			);
			expect(hidden.localization?.translations.spa[id]?.value).toBe(
				`${text} spa`,
			);
			expect(Object.values(body.translations?.en ?? {})).not.toContain(
				`${text} eng`,
			);
		}
		const remote = committed(hidden, [
			{ kind: "setAppName", name: "Updated registry" },
		]);
		const take = changesOf(await planOf(hidden, remote));
		const taken = committed(hidden, take.batch);
		const restored = committed(taken, [
			show,
			...caseListRegistrationMutations(taken, module, form, {}),
		]);
		const strings = expandDoc(restored).translations;
		for (const [, text] of roles) {
			expect(Object.values(strings?.en ?? {})).toContain(`${text} eng`);
			expect(Object.values(strings?.es ?? {})).toContain(`${text} spa`);
		}
		const removed = committed(hidden, [{ kind: "removeModule", uuid: module }]);
		for (const [id] of roles) {
			expect(
				removed.localization?.generatedSourceWording?.[id],
			).toBeUndefined();
			expect(removed.localization?.translations.spa[id]).toBeUndefined();
		}
	});

	/** The plan, held to its round trip: the change is taken in the reader's spelling of what it
	 *  touched, the target reads back as CommCare HQ's app does, and nothing outside what
	 *  CommCare HQ changed and what took the reader's spelling moved. */
	async function respelledBy(mutations: readonly Mutation[]) {
		const ref = dormant();
		// CommCare HQ's edit is made to the app CommCare HQ holds, which holds none of Nova's
		// dormant spellings.
		const theirs = committed(await readingOf(ref, ref), mutations);
		const T = await readingOf(theirs, ref);
		const plan = changesOf(await planOf(ref, theirs));
		expect(
			readBackDifferences(T, {
				doc: canonDocument(plan.target),
				choices: null,
			}),
		).toEqual([]);
		const respelled = new Set<string>(plan.respelled);
		const changed = documentDifferences(ref, theirs);
		for (const { path } of documentDifferences(ref, plan.target)) {
			const [top, key] = path;
			const owner =
				top === "fields" || top === "fieldOrder"
					? Object.keys(ref.forms).find((form) =>
							(function under(at: string | undefined): boolean {
								if (at === undefined) return false;
								if (at === form) return true;
								return under(ref.fieldParent[at as Uuid]);
							})(key),
						)
					: key;
			// An entity the change added is the change's, under whichever UUID the reading gave it.
			const added =
				key !== undefined &&
				["modules", "forms", "fields", "formOrder", "fieldOrder"].includes(
					top ?? "",
				) &&
				!Object.hasOwn(ref.modules, key) &&
				!Object.hasOwn(ref.forms, key) &&
				!Object.hasOwn(ref.fields, key);
			const within =
				added ||
				changed.some(({ path: one }) =>
					one
						.slice(0, Math.min(one.length, path.length))
						.every((segment, at) => segment === path[at]),
				) ||
				(owner !== undefined && respelled.has(owner));
			expect(within, `/${path.join("/")} moved outside the change`).toBe(true);
		}
		return plan;
	}

	it("takes a list switched to a tile, whose cells CommCare HQ places over a dormant one", async () => {
		const ref = dormant();
		const B = await readingOf(ref, ref);
		const column = B.modules[id(SCREENS)]?.caseListConfig?.columns[0];
		if (column === undefined) throw new Error("The list holds no column.");
		const placed = { ...TILE, width: 4 };
		const theirs = committed(B, [
			{ kind: "setCaseListMeta", uuid: id(SCREENS), patch: { tile: {} } },
			{
				kind: "updateColumn",
				moduleUuid: id(SCREENS),
				uuid: column.uuid,
				tilePatch: placed,
			},
		] as unknown as Mutation[]);
		// A tile list places every column, so the change carries the cell and writes it over
		// Nova's: the change fits Nova's spelling and nothing is respelled.
		const plan = changesOf(await planOf(ref, theirs));
		expect(plan.respelled).toEqual([]);
		expect(
			plan.target.modules[id(SCREENS)]?.caseListConfig?.columns[0]?.tile,
		).toEqual(placed);
	});

	it("takes a condition added to one of a root's one-screen groups, which the base reads as sections", async () => {
		// The base reads the root's one-screen groups as sections; with a condition on one,
		// CommCare HQ's app reads as groups. No mutation converts a section to a group, so the
		// diff removes each page by name and adds it again under its own uuid
		// (`lib/doc/diffDocsToMutations.ts::rebornFields`).
		const ref = dormant();
		const b = Object.values(ref.fields).find((field) => field.id === "b");
		if (b === undefined) throw new Error("The form holds the question b.");
		const condition = not(isBlank(formField(b.uuid)));
		const theirs = committed(ref, [
			{
				kind: "updateField",
				uuid: id(FIRST),
				targetKind: "group",
				patch: { relevant: condition },
			},
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(ref, theirs));
		expect(plan.target.fields[id(FIRST)]).toMatchObject({
			kind: "group",
			fieldList: true,
			relevant: condition,
		});
		expect(plan.target.fields[id(SECOND)]).toMatchObject({
			kind: "group",
			fieldList: true,
		});
		expect(plan.target.fieldOrder[id(SCREEN)]).toEqual([id(FIRST), id(SECOND)]);
		expect(
			readBackDifferences(await readingOf(theirs, ref), {
				doc: canonDocument(plan.target),
				choices: null,
			}),
		).toEqual([]);
		// The batch replays over the head to the target exactly.
		const replayed = admitted(ref, plan.batch);
		expect(replayed.ok).toBe(true);
		expect(documentDifferences(replayed.nextDoc, plan.target)).toEqual([]);
	});

	it("keeps the tile cell Nova holds on a column whose content CommCare HQ changed", async () => {
		const ref = dormant();
		const column = ref.modules[id(SCREENS)]?.caseListConfig?.columns[0];
		if (column === undefined) throw new Error("The list holds no column.");
		const {
			uuid,
			sort: _sort,
			tile: _tile,
			visibleInList: _list,
			visibleInDetail: _detail,
			notOnList: _notOnList,
			...content
		} = column as typeof column & Record<string, unknown>;
		const theirs = committed(ref, [
			{
				kind: "updateColumn",
				moduleUuid: id(SCREENS),
				uuid,
				column: { ...content, header: "Patient" },
			},
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(ref, theirs));
		const taken = plan.target.modules[id(SCREENS)]?.caseListConfig?.columns[0];
		expect(taken).toMatchObject({ tile: TILE, header: "Patient" });
	});

	it("takes formatting turned on over dormant plain text flags", async () => {
		const plan = await respelledBy([
			{ kind: "updateForm", uuid: id(SCREEN), patch: { plainText: null } },
		] as unknown as Mutation[]);
		expect(plan.respelled).toContain(id(SCREEN));
	});

	it("writes no spelling into a respelled form that prints otherwise there", async () => {
		const { near, print, holding } = nearLowering(dormant(), "a");
		const ref = holding(near);
		const theirs = committed(await readingOf(ref, ref), [
			{ kind: "updateForm", uuid: id(SCREEN), patch: { plainText: null } },
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(ref, theirs));
		expect(plan.respelled).toContain(id(SCREEN));
		// The form takes the reader's spelling, and the condition keeps what it prints.
		expect(print(plan.target)).toBe(print(ref));
	});

	it("takes a form added to a menu whose offered registration stands first, keeping its place", async () => {
		const plan = await respelledBy([
			{
				kind: "addForm",
				moduleUuid: id(CLIENTS),
				form: {
					uuid: id("plan-follow-up"),
					id: "follow_up",
					name: "Follow up",
					type: "followup",
					caseOperations: [
						{ uuid: id("plan-follow-up-own"), id: "patient", action: "own" },
					],
				},
			},
			{
				kind: "addField",
				parentUuid: id("plan-follow-up"),
				field: {
					uuid: id("plan-follow-up-d"),
					id: "d",
					kind: "text",
					label: proseText("D"),
				},
			},
		] as unknown as Mutation[]);
		// Both readings put the offered registration last, so no move or add anchors on it, the
		// change fits Nova's order, and Nova's registration keeps its place first.
		expect(plan.respelled).toEqual([]);
		const order = plan.target.formOrder[id(CLIENTS)] ?? [];
		expect(order[0]).toBe(id(SIGN_UP));
		expect(order).toHaveLength(3);
	});
});

// ── A slot that prints near a lowering ───────────────────────────────

/** The field of `doc` whose question id is `fieldId`. */
function fieldOf(doc: BlueprintDoc, fieldId: string): Uuid {
	const found = (Object.keys(doc.fields) as Uuid[]).find(
		(uuid) => doc.fields[uuid]?.id === fieldId,
	);
	if (found === undefined) throw new Error(`No question ${fieldId}.`);
	return found;
}

/**
 * A comparison of two dates and times in the display condition of `fieldId`, which a device
 * lowers to arithmetic over microseconds, and that arithmetic with the day count's constant one
 * off: what a person writes by editing the long formula HQ's form builder shows. The canonical
 * form's `instant` row reads the comparison from a fragment of the lowering, so it would take
 * the second for the first, which prints otherwise.
 */
function nearLowering(doc: BlueprintDoc, fieldId: string) {
	const slot = {
		entity: "field",
		uuid: fieldOf(doc, fieldId),
		slot: "relevant",
	} as const;
	const parse = (text: string) => {
		const parsed = parseFormExpressionForSlot(doc, slot, text, "unavailable");
		if (!parsed.ok || parsed.expression === undefined)
			throw new Error(`The text does not bind: ${text}`);
		return parsed.expression;
	};
	const naming = identityLookupWireNaming();
	const comparison = parse("now() > '2026-01-01T00:00:00.000Z'");
	const lowering = printSlotUnder(doc, slot, comparison, naming);
	if (lowering === undefined) throw new Error("The comparison has no print.");
	let edited = false;
	const near = mapExpressionAst(parse(lowering), {
		mapTerm: (one) => {
			if (edited || one.kind !== "literal" || one.value !== 719468)
				return undefined;
			edited = true;
			return { ...one, value: 719469 };
		},
	});
	expect(edited).toBe(true);
	const print = (held: BlueprintDoc) =>
		printSlotUnder(
			held,
			slot,
			(held.fields[slot.uuid] as { relevant?: Expression })
				.relevant as Expression,
			naming,
		);
	const holding = (expression: Expression) =>
		committed(
			produce(doc, (draft) => {
				(draft.fields[slot.uuid] as { relevant?: Expression }).relevant =
					expression;
			}),
			[],
		);
	return { comparison, near, print, holding };
}

describe("a condition that prints near a lowering", () => {
	it("is an unpublished change of Nova's against the comparison it was published as", async () => {
		const base = visits();
		const { comparison, near, holding } = nearLowering(base, "comment");
		const ref = holding(comparison);
		const now = holding(near);
		const theirs = committed(ref, [
			{ kind: "renameForm", uuid: id(VISIT), newId: "Home visit" },
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(ref, theirs, { now }));
		// The head holds arithmetic that prints otherwise than what was published, so the change
		// is applied to the published document and the head's edit is listed, never taken over.
		expect(plan.appliedTo).toBe("published");
		expect(plan.novaChanges.count).toBeGreaterThan(0);
	});
});

// ── Case Management's own names ──────────────────────────────────────

describe("a form whose case changes hold their own names and order", () => {
	it("keeps every id and the order where CommCare HQ changed something else in the form", async () => {
		const ref = visits();
		const register = ref.forms[id(REGISTER)];
		const operations = register?.caseOperations ?? [];
		expect(operations.length).toBeGreaterThan(0);
		const named = produce(ref, (draft) => {
			const form = draft.forms[id(REGISTER)];
			if (form === undefined) return;
			form.caseOperations = operations.map((operation, index) => ({
				...operation,
				id: `kept_name_${index}`,
			}));
		});
		assertAdmittedDoc(named);
		const theirs = committed(named, [
			{
				kind: "updateField",
				uuid: id(HOME),
				targetKind: "text",
				patch: { label: proseText("Home village") },
			},
		] as unknown as Mutation[]);
		const plan = changesOf(await planOf(named, theirs));
		expect(plan.target.forms[id(REGISTER)]?.caseOperations).toEqual(
			named.forms[id(REGISTER)]?.caseOperations,
		);
	});
});

// ── touchedBy ────────────────────────────────────────────────────────

describe("touchedBy", () => {
	const ENTRY = id("plan-entry");
	const LIST_ENTRY = id("plan-list-entry");
	/* The clinic with a deep link to its visit form and one to its case list. */
	const doc = produce(visits(), (draft) => {
		const visitForm = draft.forms[id(VISIT)];
		const patientsMenu = draft.modules[id(PATIENTS)];
		if (visitForm === undefined || patientsMenu === undefined)
			throw new Error("The clinic holds its visit form and its menu.");
		visitForm.entryPoint = { uuid: ENTRY, id: "visit" } as never;
		patientsMenu.caseListEntryPoint = {
			uuid: LIST_ENTRY,
			id: "patients",
		} as never;
	});
	const register = id(REGISTER);
	const visit = id(VISIT);
	const patients = id(PATIENTS);
	const close = id("plan-close");
	const group = id("plan-group");
	const column = doc.modules[patients]?.caseListConfig?.columns[0]?.uuid;
	const cases: readonly {
		readonly name: string;
		readonly mutations: readonly unknown[];
		readonly touched: readonly Uuid[];
	}[] = [
		{
			name: "a menu's own change",
			mutations: [{ kind: "renameModule", uuid: patients, newId: "Clients" }],
			touched: [patients],
		},
		{
			name: "a list's column",
			mutations: [{ kind: "removeColumn", moduleUuid: patients, uuid: column }],
			touched: [patients],
		},
		{
			name: "a form's own change",
			mutations: [{ kind: "renameForm", uuid: visit, newId: "Home visit" }],
			touched: [visit],
		},
		{
			name: "a question's change",
			mutations: [{ kind: "removeField", uuid: id(TEMP) }],
			touched: [visit],
		},
		{
			name: "a question added under a question added",
			mutations: [
				{
					kind: "addField",
					parentUuid: register,
					field: {
						uuid: group,
						id: "group",
						kind: "group",
						label: proseText("Group"),
					},
				},
				{
					kind: "addField",
					parentUuid: group,
					field: {
						uuid: id("plan-inner"),
						id: "inner",
						kind: "text",
						label: proseText("Inner"),
					},
				},
			],
			touched: [register],
		},
		{
			name: "a question moved to another form",
			mutations: [
				{
					kind: "moveField",
					uuid: id(TEMP),
					toParentUuid: register,
					after: null,
				},
			],
			touched: [visit, register],
		},
		{
			name: "a form added to a menu",
			mutations: [
				{
					kind: "addForm",
					moduleUuid: patients,
					form: { uuid: close, id: "close", name: "Close", type: "close" },
				},
			],
			touched: [close, patients],
		},
		{
			name: "a form moved in its menu",
			mutations: [
				{ kind: "moveForm", uuid: visit, toModuleUuid: patients, after: null },
			],
			touched: [visit, patients],
		},
		{
			name: "a form removed",
			mutations: [{ kind: "removeForm", uuid: visit }],
			touched: [visit, patients],
		},
		{
			name: "a hold of a form's case change",
			mutations: [
				{
					kind: "holdPlacements",
					holds: [{ target: "own-close", formUuid: visit, placement: null }],
				},
			],
			touched: [visit],
		},
		{
			name: "a deep link added to a form",
			mutations: [
				{
					kind: "addEntryPoint",
					target: { kind: "form", moduleUuid: patients, formUuid: register },
					entryPoint: { uuid: id("plan-new-entry"), id: "register" },
				},
			],
			touched: [register],
		},
		{
			name: "a deep link added to a menu",
			mutations: [
				{
					kind: "addEntryPoint",
					target: { kind: "module", moduleUuid: patients },
					entryPoint: { uuid: id("plan-new-entry"), id: "patients_menu" },
				},
			],
			touched: [patients],
		},
		{
			name: "a form's deep link changed or removed",
			mutations: [
				{
					kind: "updateEntryPoint",
					entryPointUuid: ENTRY,
					patch: { id: "home_visit" },
				},
				{ kind: "removeEntryPoint", entryPointUuid: ENTRY },
			],
			touched: [visit],
		},
		{
			name: "a case list's deep link changed",
			mutations: [
				{
					kind: "updateEntryPoint",
					entryPointUuid: LIST_ENTRY,
					patch: { id: "clients" },
				},
			],
			touched: [patients],
		},
		{
			name: "a menu's Search field, its list's settings and its media",
			mutations: [
				{
					kind: "removeSearchInput",
					moduleUuid: patients,
					uuid: id("plan-search"),
				},
				{ kind: "setCaseListMeta", uuid: patients, patch: { tile: null } },
				{
					kind: "setModuleMedia",
					uuid: patients,
					icon: null,
					audioLabel: null,
				},
			],
			touched: [patients],
		},
		{
			name: "a form's links, its otherwise and its media",
			mutations: [
				{ kind: "removeFormLink", formUuid: register, uuid: id("plan-link") },
				{ kind: "setFormOtherwise", formUuid: visit, otherwise: null },
				{ kind: "setFormMedia", uuid: visit, icon: null, audioLabel: null },
			],
			touched: [register, visit],
		},
		{
			name: "a question's kind, its choices and its media",
			mutations: [
				{ kind: "convertField", uuid: id(TEMP), toKind: "decimal" },
				{ kind: "removeOption", fieldUuid: id(HOME), uuid: id("plan-north") },
				{
					kind: "setFieldMedia",
					fieldUuid: id(NOTE),
					slot: "label",
					media: null,
				},
			],
			touched: [visit, register],
		},
		{
			name: "the app's own settings and its catalog",
			mutations: [
				{ kind: "setAppName", name: "Clinic" },
				{ kind: "retireCaseType", caseType: "household" },
				{ kind: "removeUserProperty", uuid: DISTRICT },
			],
			touched: [],
		},
	];
	for (const { name, mutations, touched } of cases)
		it(`names what ${name} touches`, () => {
			expect(new Set(touchedBy(doc, mutations as Mutation[]))).toEqual(
				new Set(touched),
			);
		});
});
