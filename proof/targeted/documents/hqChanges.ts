/**
 * Saves a person makes to an app's content in CommCare HQ between Nova's
 * publishes, and what Nova's next publish over each does: brings the change
 * in, or goes ahead where the save changed nothing Nova holds.
 *
 * Each document is a Nova-born app. Over Nova's first publish (A) a person
 * makes the saves its `hq-side.json` names, each through the view a person's
 * save reaches (`proof/observe/hqside.py`, the form builder's through
 * `proof/editors/vellum.py::open_and_save`). Nova's next publish compares
 * what HQ holds with its baseline and stops (`hq_changed`, a change it can
 * bring in); the capture then makes Nova's review of the change and its
 * bring-in through Nova's own functions (`proof/corpus/publish.ts`,
 * `lib/deployment/hqChanges/review.ts::checkHqChanges`), holds the document
 * the bring-in takes to the one the document states (`bringsIn`, made from D
 * by Nova's planner and admitted by Nova's gate, `../build.ts::broughtInDocument`),
 * holds a second review to find nothing, and captures the publish that
 * follows. A document stating `records` is one whose publish Nova stops and
 * whose review finds nothing to bring in, so Nova records what CommCare HQ
 * holds and sends the publish again: the form saved with no change, whose
 * bytes the form builder's save writes again, and the location list
 * setting, which Nova's next publish sets back.
 *
 * The documents (one save each but the menu's, which makes two):
 *
 * - `targeted-hq-changes-label`: a question's label reworded in the app's
 *   first language in HQ's form builder, in an app with a second language;
 *   the second language's text is kept, and marked for review, since its
 *   source changed;
 * - `targeted-hq-changes-resave`: a form opened in HQ's form builder and
 *   saved with no change, which reads as the same app;
 * - `targeted-hq-changes-questions`: a question added and one removed;
 * - `targeted-hq-changes-form-setting`: a form's own setting, where the
 *   worker goes after it;
 * - `targeted-hq-changes-case-management`: a form's case management saves
 *   one more answer to its case;
 * - `targeted-hq-changes-menu`: a menu renamed, and a column added to its
 *   case list;
 * - `targeted-hq-changes-forms`: a form removed, and a survey added with its
 *   own question;
 * - `targeted-hq-changes-order`: a menu and a form moved;
 * - `targeted-hq-changes-location-list`: the location list setting set to
 *   both lists, which Nova's next publish sets back (its review lists it as
 *   what that publish changes) and which changes nothing Nova's document
 *   holds;
 * - `targeted-hq-changes-media`: the picture a question shows replaced
 *   under its path on HQ's media page; the bring-in takes the person's
 *   picture, which the Project's library already holds, and the publish
 *   that follows sends it at the path its content derives. The capture also
 *   runs the person's other choice, publishing over the change: the publish
 *   stops, the discard goes through, and HQ's map points the path at the
 *   document of Nova's bytes again (`alsoPublishesOver`).
 *
 * What a person adds in HQ is named in the document the bring-in gives by
 * the UUID Nova's reading mints for its key in CommCare HQ's app
 * (`lib/commcare/reader/identity.ts::mintEntityUuid` over `externalKey`): a
 * form by its `xmlns`, a question by its form's `xmlns` and its path, a case
 * list column by its menu's id, kind, property and place.
 *
 * Fixed values: each form under test holds the answer a worker gives one of
 * its questions (`./echo.ts`).
 */

import { createHash } from "node:crypto";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { expandDoc } from "@/lib/commcare/expander";
import {
	jrFileRef,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { externalKey, mintEntityUuid } from "@/lib/commcare/reader/identity";
import {
	derivedFormXmlns,
	derivedUniqueId,
	targetWireIdentity,
	type WireIdentity,
} from "@/lib/commcare/wireIdentity";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	type TranslationEntry,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import {
	type CorpusDocument,
	type HqSideSaves,
	uploadedMedia,
} from "../../corpus/documents";
import {
	broughtInDocument,
	caseListOf,
	targetedDocument,
	targetedUuid,
} from "../build";
import { answerHeld } from "./echo";

const ROWS = ["changes made in CommCare HQ, brought in"];

/** The XForm Nova's publish sends for a form of `doc`, under `identity`. */
function formXml(
	doc: BlueprintDoc,
	formUuid: Uuid,
	identity?: WireIdentity,
): string {
	const application = expandDoc(
		doc,
		identity === undefined ? {} : { identity },
	);
	const formId =
		identity === undefined
			? derivedUniqueId(formUuid)
			: identity.formUniqueId(formUuid);
	const xml = application._attachments[`${formId}.xml`];
	if (xml === undefined) {
		throw new Error(
			`Nova's export of ${doc.appId} holds no XForm for the form ${formUuid}.`,
		);
	}
	return xml;
}

/** The UUID Nova's reading mints for a form CommCare HQ holds under `xmlns` and Nova does not. */
function readFormUuid(appId: string, xmlns: string): Uuid {
	return mintEntityUuid(appId, externalKey.form(xmlns));
}

/** The UUID Nova's reading mints for a question at `path` of the form under `xmlns`. */
function readFieldUuid(appId: string, xmlns: string, path: string[]): Uuid {
	return mintEntityUuid(appId, externalKey.field(xmlns, path));
}

/** `document` with what a person saves in HQ over A, and what Nova's next publish over it does. */
function withSaves(
	document: CorpusDocument,
	hqSide: HqSideSaves,
): CorpusDocument {
	return { ...document, hqSide };
}

// ── A survey ─────────────────────────────────────────────────────────

/** A menu of visits: a visit form with a note and a weight, and a follow-up call with its reason. */
function surveyDoc(
	id: string,
	options: {
		readonly reports?: boolean;
		readonly visitFields?: ReturnType<typeof f>[];
		readonly visitPostSubmit?: "module";
		readonly forms?: "visit" | "both";
		readonly order?: "authored" | "moved";
	} = {},
): BlueprintDoc {
	const uuid = (name: string) => targetedUuid(id, name);
	const visit = {
		uuid: uuid("visit"),
		name: "Visit",
		type: "survey" as const,
		...(options.visitPostSubmit !== undefined && {
			postSubmit: options.visitPostSubmit,
		}),
		fields: options.visitFields ?? [
			f({
				kind: "text",
				uuid: uuid("note"),
				id: "note",
				label: proseText("Note"),
			}),
			f({
				kind: "int",
				uuid: uuid("weight"),
				id: "weight",
				label: proseText("Weight"),
			}),
		],
	};
	const call = {
		uuid: uuid("call"),
		name: "Follow-up call",
		type: "survey" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid("reason"),
				id: "reason",
				label: proseText("Reason"),
			}),
		],
	};
	const visits = {
		uuid: uuid("visits"),
		name: "Visits",
		forms:
			options.forms === "visit"
				? [visit]
				: options.order === "moved"
					? [call, visit]
					: [visit, call],
	};
	const reports = {
		uuid: uuid("reports"),
		name: "Reports",
		forms: [
			{
				uuid: uuid("summary"),
				name: "Weekly summary",
				type: "survey" as const,
				fields: [
					f({
						kind: "text",
						uuid: uuid("summary-note"),
						id: "summary_note",
						label: proseText("Summary"),
					}),
				],
			},
		],
	};
	return buildDoc({
		appId: id,
		appName: "Clinic visits",
		modules:
			options.reports !== true
				? [visits]
				: options.order === "moved"
					? [reports, visits]
					: [visits, reports],
	});
}

/** The value check of a survey's visit form: the note a worker enters is the one the form holds. */
function visitNoteHeld(id: string) {
	return answerHeld(
		"note-held",
		targetedUuid(id, "visit"),
		"/data/note",
		"seen",
	);
}

// ── The label ────────────────────────────────────────────────────────

const LABEL = "targeted-hq-changes-label";

/** The French text of each unit, as a reviewed human translation of the English. */
function frenchOf(
	doc: BlueprintDoc,
	texts: ReadonlyMap<string, string | ReturnType<typeof proseText>>,
	review: TranslationEntry["review"],
): Record<string, TranslationEntry> {
	const units = translationUnitsById(doc);
	const entries: Record<string, TranslationEntry> = {};
	for (const [unitId, value] of texts) {
		const unit = units.get(unitId as never);
		if (unit === undefined)
			throw new Error(`${LABEL} names no unit ${unitId}.`);
		entries[unitId] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review,
			translatedFrom: "eng",
		};
	}
	return entries;
}

/**
 * A visit form whose note is labelled `noteLabel` in English and "Remarque"
 * in French, the French a reviewed human translation of the English but for
 * the note's label, whose review is `noteReview`: a bring-in of a reworded
 * source keeps the French text and its origin, names the new source and asks
 * for a review (`lib/deployment/hqChanges/plan.ts`, the narrowing of
 * `setTranslation`).
 */
function labelDoc(
	noteLabel: string,
	noteReview: TranslationEntry["review"],
): BlueprintDoc {
	const uuid = (name: string) => targetedUuid(LABEL, name);
	const doc = surveyDoc(LABEL, {
		forms: "visit",
		visitFields: [
			f({
				kind: "text",
				uuid: uuid("note"),
				id: "note",
				label: proseText(noteLabel),
				plainLabel: true,
			}),
		],
	});
	const texts = new Map<string, string | ReturnType<typeof proseText>>([
		[makeTranslationUnitId("app", "name"), "Visites de la clinique"],
		[
			makeTranslationUnitId("field", uuid("note"), "label"),
			proseText("Remarque"),
		],
	]);
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fra" },
		translations: { fra: {} },
	};
	const french = frenchOf(doc, texts, "reviewed");
	const note = makeTranslationUnitId("field", uuid("note"), "label");
	const entry = french[note];
	if (entry === undefined) throw new Error(`${LABEL} holds no French note.`);
	french[note] = { ...entry, review: noteReview };
	doc.localization.translations = { fra: french };
	return doc;
}

export function hqChangesLabel(): CorpusDocument {
	const document = targetedDocument({
		id: LABEL,
		rows: ROWS,
		doc: labelDoc("Note", "reviewed"),
		expected: { intent: [visitNoteHeld(LABEL)] },
	});
	return withSaves(document, {
		formLabel: {
			module: 0,
			form: 0,
			question: "/data/note",
			label: "Visit note",
			edit: "builder-model",
		},
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(
			document,
			labelDoc("Visit note", "needs-review"),
		),
	});
}

// ── The form saved with no change ────────────────────────────────────

const RESAVE = "targeted-hq-changes-resave";

export function hqChangesResave(): CorpusDocument {
	return withSaves(
		targetedDocument({
			id: RESAVE,
			rows: ROWS,
			doc: surveyDoc(RESAVE),
			expected: { intent: [visitNoteHeld(RESAVE)] },
		}),
		{
			formResave: { module: 0, form: 0 },
			republish: "records",
			recorded: { reason: "reads-the-same", publishChanges: [] },
		},
	);
}

// ── A question added and one removed ─────────────────────────────────

const QUESTIONS = "targeted-hq-changes-questions";

export function hqChangesQuestions(): CorpusDocument {
	const uuid = (name: string) => targetedUuid(QUESTIONS, name);
	const document = targetedDocument({
		id: QUESTIONS,
		rows: ROWS,
		doc: surveyDoc(QUESTIONS),
		expected: { intent: [visitNoteHeld(QUESTIONS)] },
	});
	const xmlns = derivedFormXmlns(uuid("visit"));
	const after = surveyDoc(QUESTIONS, {
		visitFields: [
			f({
				kind: "text",
				uuid: uuid("note"),
				id: "note",
				label: proseText("Note"),
			}),
			f({
				kind: "text",
				uuid: readFieldUuid(QUESTIONS, xmlns, ["symptoms"]),
				id: "symptoms",
				label: proseText("Symptoms"),
			}),
		],
	});
	return withSaves(document, {
		questions: { module: 0, form: 0, xform: formXml(after, uuid("visit")) },
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(document, after),
	});
}

// ── A form's own setting ─────────────────────────────────────────────

const FORM_SETTING = "targeted-hq-changes-form-setting";

export function hqChangesFormSetting(): CorpusDocument {
	const document = targetedDocument({
		id: FORM_SETTING,
		rows: ROWS,
		doc: surveyDoc(FORM_SETTING),
		expected: { intent: [visitNoteHeld(FORM_SETTING)] },
	});
	return withSaves(document, {
		formAttribute: {
			module: 0,
			form: 0,
			attributes: { post_form_workflow: "module" },
		},
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(
			document,
			surveyDoc(FORM_SETTING, { visitPostSubmit: "module" }),
		),
	});
}

// ── A form removed and a survey added ────────────────────────────────

const FORMS = "targeted-hq-changes-forms";

/** The `xmlns` HQ's form builder leaves on the survey a person adds, as the XForm posted to it names it. */
const ADDED_XMLNS = `http://openrosa.org/formdesigner/${targetedUuid(FORMS, "added-xmlns").toUpperCase()}`;

export function hqChangesForms(): CorpusDocument {
	const uuid = (name: string) => targetedUuid(FORMS, name);
	const document = targetedDocument({
		id: FORMS,
		rows: ROWS,
		doc: surveyDoc(FORMS),
		expected: { intent: [visitNoteHeld(FORMS)] },
	});
	const added = readFormUuid(FORMS, ADDED_XMLNS);
	const after = buildDoc({
		appId: FORMS,
		appName: "Clinic visits",
		modules: [
			{
				uuid: uuid("visits"),
				name: "Visits",
				forms: [
					{
						uuid: uuid("visit"),
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
							f({
								kind: "int",
								uuid: uuid("weight"),
								id: "weight",
								label: proseText("Weight"),
							}),
						],
					},
					{
						uuid: added,
						name: "Survey",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: readFieldUuid(FORMS, ADDED_XMLNS, ["topic"]),
								id: "topic",
								label: proseText("Topic"),
							}),
						],
					},
				],
			},
		],
	});
	const identity = targetWireIdentity([
		{
			entityKind: "form",
			novaEntityUuid: added,
			uniqueId: null,
			xmlns: ADDED_XMLNS,
		},
	]);
	return withSaves(document, {
		formsAddedAndRemoved: {
			module: 0,
			removed: 1,
			added: { name: "Survey", xform: formXml(after, added, identity) },
		},
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(document, after),
	});
}

// ── A menu and a form moved ──────────────────────────────────────────

const ORDER = "targeted-hq-changes-order";

export function hqChangesOrder(): CorpusDocument {
	const document = targetedDocument({
		id: ORDER,
		rows: ROWS,
		doc: surveyDoc(ORDER, { reports: true }),
		expected: { intent: [visitNoteHeld(ORDER)] },
	});
	return withSaves(document, {
		/* The menus move first, so the visits' menu is the second when its
		 * forms move. */
		order: {
			modules: { from: 1, to: 0 },
			forms: { module: 1, from: 1, to: 0 },
		},
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(
			document,
			surveyDoc(ORDER, { reports: true, order: "moved" }),
		),
	});
}

// ── The location list setting ────────────────────────────────────────

const LOCATION_LIST = "targeted-hq-changes-location-list";

export function hqChangesLocationList(): CorpusDocument {
	return withSaves(
		targetedDocument({
			id: LOCATION_LIST,
			rows: ROWS,
			doc: surveyDoc(LOCATION_LIST),
			expected: { intent: [visitNoteHeld(LOCATION_LIST)] },
		}),
		{
			appAttributes: { location_fixture_restore: "both_fixtures" },
			republish: "records",
			recorded: {
				reason: "publish-changes",
				publishChanges: ["location-list-setting-reset"],
			},
		},
	);
}

// ── A case menu ──────────────────────────────────────────────────────

/** Patients registered with their name and age, and visited for their weight. */
function patientsDoc(
	id: string,
	options: {
		readonly menuName?: string;
		readonly ageColumn?: Uuid;
		readonly weightSaved?: boolean;
		/** The first menu in a grid, the form menus set per menu, and this menu's own in a grid. */
		readonly gridLayouts?: boolean;
	} = {},
): BlueprintDoc {
	const uuid = (name: string) => targetedUuid(id, name);
	const columns = [plainColumn(uuid("name-column"), "case_name", "Name")];
	/* A column a person adds on the Case List page is on the list alone: the
	 * page's save posts the list's columns, and the detail keeps its own. */
	const age =
		options.ageColumn === undefined
			? []
			: [
					plainColumn(options.ageColumn, "age", "Age", {
						visibleInDetail: false,
					}),
				];
	const doc = buildDoc({
		appId: id,
		appName: "Patient care",
		...(options.gridLayouts === true && {
			appSettings: {
				...NEW_APP_SETTINGS,
				firstMenuLayout: "grid" as const,
				formMenuLayout: "individual" as const,
			},
		}),
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "weight", label: proseText("Weight"), data_type: "int" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("patients"),
				id: "patients",
				name: options.menuName ?? "Patients",
				caseType: "patient",
				...(options.gridLayouts === true && { menuLayout: "grid" as const }),
				caseListConfig: caseListOf([...columns, ...age]),
				forms: [
					{
						uuid: uuid("register"),
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "patient_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "int",
								uuid: uuid("age"),
								id: "age",
								label: proseText("Age"),
								caseWrite: { caseType: "patient", property: "age" },
							}),
						],
					},
					{
						uuid: uuid("visit"),
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "int",
								uuid: uuid("weight"),
								id: "weight",
								label: proseText("Weight"),
								...(options.weightSaved === true && {
									caseWrite: { caseType: "patient", property: "weight" },
								}),
							}),
						],
					},
				],
			},
		],
	});
	/* A mapping saved on CommCare HQ's Case Management tab writes the answer
	 * and opens the question on nothing: HQ holds no preload beside it. */
	const weight = doc.fields[uuid("weight")];
	if (options.weightSaved === true && weight !== undefined)
		delete (weight as { default_value?: unknown }).default_value;
	return doc;
}

/** The value check of the patients' registration: the name a worker enters is the one the form holds. */
function patientNameHeld(id: string) {
	return answerHeld(
		"name-held",
		targetedUuid(id, "register"),
		"/data/patient_name",
		"Asha",
		"local",
		{
			command: "m0-f0",
			data: { case_id_new_patient_0: `${id}-patient` },
		},
	);
}

const MENU = "targeted-hq-changes-menu";

export function hqChangesMenu(): CorpusDocument {
	const document = targetedDocument({
		id: MENU,
		rows: ROWS,
		doc: patientsDoc(MENU),
		expected: { intent: [patientNameHeld(MENU)] },
	});
	const patients = derivedUniqueId(targetedUuid(MENU, "patients"));
	const ageColumn = mintEntityUuid(
		MENU,
		externalKey.caseListColumn(patients, "plain", "age", 0),
	);
	const after = patientsDoc(MENU, { menuName: "Patient list", ageColumn });
	const application = expandDoc(after);
	const columns = application.modules[0]?.case_details.short.columns ?? [];
	const column = columns[columns.length - 1];
	if (column === undefined) throw new Error(`${MENU} holds no age column.`);
	return withSaves(document, {
		moduleAttribute: { module: 0, name: "Patient list" },
		moduleDetail: {
			module: 0,
			column: column as unknown as Readonly<Record<string, unknown>>,
		},
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(document, after),
	});
}

const MENU_LAYOUTS = "targeted-hq-changes-menu-layouts";

/**
 * Each menu layout slot changed on CommCare HQ's own pages: the app settings
 * page's Modules Menu Display set to Grid (`use_grid_menus`) and Forms Menu
 * Display to per-menu (`grid_form_menus` `some`), then the menu settings
 * page's Menu Display of Patients set to Grid (`display_style`). The review
 * lists the change and the bring-in takes each slot
 * (`lib/commcare/hq/menuLayout.ts::sourceMenuLayouts`): the first menu in a
 * grid, the form menus set per menu, and Patients' own in a grid.
 */
export function hqChangesMenuLayouts(): CorpusDocument {
	const document = targetedDocument({
		id: MENU_LAYOUTS,
		rows: ROWS,
		doc: patientsDoc(MENU_LAYOUTS),
		expected: { intent: [patientNameHeld(MENU_LAYOUTS)] },
	});
	return withSaves(document, {
		appAttributes: { use_grid_menus: true, grid_form_menus: "some" },
		moduleLayout: { module: 0, displayStyle: "grid" },
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(
			document,
			patientsDoc(MENU_LAYOUTS, { gridLayouts: true }),
		),
	});
}

const CASE_MANAGEMENT = "targeted-hq-changes-case-management";

export function hqChangesCaseManagement(): CorpusDocument {
	const document = targetedDocument({
		id: CASE_MANAGEMENT,
		rows: ROWS,
		doc: patientsDoc(CASE_MANAGEMENT),
		expected: { intent: [patientNameHeld(CASE_MANAGEMENT)] },
	});
	return withSaves(document, {
		formActions: { module: 0, form: 1, update: { weight: "/data/weight" } },
		republish: "brings-in",
		publishChanges: [],
		bringsIn: broughtInDocument(
			document,
			patientsDoc(CASE_MANAGEMENT, { weightSaved: true }),
		),
	});
}

// ── A picture replaced under its path ────────────────────────────────

const MEDIA = "targeted-hq-changes-media";

/**
 * A survey whose note shows `picture` on its label: Nova's own picture in
 * D, and the picture a person uploads in its place in the document the
 * bring-in gives.
 */
function pictureDoc(picture: typeof mediaIds.label): BlueprintDoc {
	return surveyDoc(MEDIA, {
		forms: "visit",
		visitFields: [
			f({
				kind: "text",
				uuid: targetedUuid(MEDIA, "note"),
				id: "note",
				label: proseText("Note"),
				label_media: { image: picture },
			}),
		],
	});
}

export function hqChangesMedia(): CorpusDocument {
	const manifest = mediaManifest();
	const asset = (id: typeof mediaIds.label) => {
		const held = manifest.get(id);
		if (held?.bytes === undefined)
			throw new Error(`${MEDIA}'s media manifest holds no bytes for ${id}.`);
		return held;
	};
	const own = asset(mediaIds.label);
	const theirs = asset(mediaIds.option);
	/* The Project holds both pictures: Nova's, which D shows, and the one the
	 * person uploads in HQ, which the bring-in's publication of that file
	 * finds by its bytes. */
	const media = uploadedMedia(
		new Map([
			[mediaIds.label, own],
			[mediaIds.option, theirs],
		]),
	);
	const document = targetedDocument({
		id: MEDIA,
		rows: ROWS,
		doc: pictureDoc(mediaIds.label),
		...(media !== undefined && { media }),
		expected: { intent: [visitNoteHeld(MEDIA)] },
	});
	const ownPath = jrFileRef(
		wirePathFor(
			createHash("sha256")
				.update(own.bytes as Buffer)
				.digest("hex"),
			own.extension,
		),
	);
	return withSaves(document, {
		mediaReplaced: {
			path: ownPath,
			mimeType: theirs.mimeType,
			base64: Buffer.from(theirs.bytes as Buffer).toString("base64"),
		},
		republish: "brings-in",
		/* The replaced picture takes the path of its own bytes, which the next
		 * publish moves its reference to. */
		publishChanges: ["media-files-renamed"],
		removedFileReferences: [ownPath],
		bringsIn: broughtInDocument(document, pictureDoc(mediaIds.option)),
		alsoPublishesOver: true,
	});
}
