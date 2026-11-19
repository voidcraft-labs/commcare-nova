/**
 * A Nova document's emission as CommCare HQ holds it once imported, served
 * the way the bring-in reads an app: the source read (`apps/source/`), whose
 * body is HQ's shell with every key the import body carries written over it
 * (`novaReading.ts::servedExport`), and the application resource summarized
 * from that same source as `ApplicationResource.dehydrate_module` summarizes
 * one (`proof/corpus/hqSummary.ts`), both at one save counter.
 *
 * And the smallest app whose form holds a create keyed by an answer: the
 * emitter puts such a create in a Save to Case block whose `@case_id` is a
 * calculate bind, `concat('<prefix>', <the answer>)`, in a one-row repeat
 * (`lib/commcare/CLAUDE.md`, the case block paragraph), and the reader reads
 * the prefix back off that bind (`reader/caseManagement/saveToCase.ts::keyedKey`).
 */

import type { MockAgent } from "undici";
import {
	type RetainedHqAnswer,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { HqQuestionSummary } from "@/lib/commcare/hq/application";
import { parseHqAppSource } from "@/lib/commcare/hq/appSource";
import type { BlueprintDoc, TargetedCaseOperation } from "@/lib/domain";
import { authoredCaseIdPrefix } from "@/lib/domain/caseOperationIdentity";
import { formField, term } from "@/lib/domain/expression";
import { hqApplicationModules as summarizeHqApplication } from "@/proof/corpus/hqSummary";
import {
	changedAnswer,
	counterOf,
	FIXTURE_PATHS,
	serveAnswer,
} from "./adoptionFixture";
import { servedExport } from "./novaReading";

type Body = Record<string, unknown>;

/** CommCare HQ's source read and application resource of one app. */
export interface ServedHqApp {
	readonly source: RetainedHqAnswer;
	readonly resource: RetainedHqAnswer;
}

/** One question of CommCare HQ's summary as the resource writes it. */
function questionJson(question: HqQuestionSummary): Body {
	return {
		value: question.path,
		tag: question.tag,
		type: question.type,
		repeat: question.repeat,
		group: question.group,
		is_group: question.isGroup,
		...(question.required !== null && { required: question.required }),
		relevant: question.relevant,
		constraint: question.constraint,
		calculate: question.calculate,
		setvalue: question.setvalue,
		translations: question.labelTranslations,
		...(question.options !== null && {
			options: question.options.map((option) => ({
				value: option.value,
				translations: option.labelTranslations,
			})),
		}),
	};
}

/**
 * CommCare HQ's source and application resource for `doc`'s emission at save
 * counter `version`, the source's form XML first given to `xml` where a save
 * in CommCare HQ changed it; the resource summarizes the source as served.
 */
export function servedHqApp(
	doc: BlueprintDoc,
	version: number,
	xml: (text: string) => string = (text) => text,
): ServedHqApp {
	const body: Body = { ...servedExport(doc).body, version };
	const attachments = body._attachments as Record<string, unknown>;
	for (const [name, text] of Object.entries(attachments))
		if (typeof text === "string" && name.endsWith(".xml"))
			attachments[name] = xml(text);
	const parsed = parseHqAppSource(body);
	if (parsed.kind !== "source")
		throw new Error(`The emission is no source (${JSON.stringify(parsed)}).`);
	const summary = summarizeHqApplication(parsed.source);
	const resource = changedAnswer(
		retainedReadingRead("application"),
		(held) => ({
			...held,
			name: body.name,
			version,
			modules: parsed.source.modules.map((menu, i) => ({
				case_properties: [],
				case_type: menu.caseType,
				name: (body.modules as Body[])[i]?.name,
				unique_id: menu.uniqueId,
				forms: (summary[i]?.kind === "summarized" ? summary[i].forms : []).map(
					(form) => ({
						name: {},
						unique_id: form.uniqueId,
						xmlns: form.xmlns,
						questions: form.questions.map(questionJson),
					}),
				),
			})),
		}),
	);
	const source: RetainedHqAnswer = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
	return { source, resource };
}

/**
 * One read of the app as a review, a bring-in or a create makes it, `times`
 * times: the resource, the source, the counter, and where `tables`, CommCare
 * HQ's list of lookup tables.
 */
export function serveHqApp(
	peer: MockAgent,
	served: ServedHqApp,
	times = 1,
	tables = true,
): void {
	serveAnswer(peer, FIXTURE_PATHS.application, served.resource, times);
	serveAnswer(peer, FIXTURE_PATHS.source, served.source, times);
	serveAnswer(peer, FIXTURE_PATHS.version, counterOf(served.resource), times);
	if (tables)
		serveAnswer(
			peer,
			FIXTURE_PATHS.tables,
			retainedGroupRead("lookups/lookup-tables"),
			times,
		);
}

const KEYED_APP_ID = "keyed-create-app";
const REGISTER = testUuid("keyed-register");
const CODE = testUuid("keyed-code");
const SAMPLE = testUuid("keyed-sample");

/**
 * The smallest app whose form holds a create keyed by an answer: patients
 * registered with a sample code, each registration also making a `sample`
 * case keyed by that code.
 */
export function keyedCreateApp(): BlueprintDoc {
	const create: TargetedCaseOperation = {
		uuid: SAMPLE,
		id: "sample",
		action: "create",
		caseType: "sample",
		target: { kind: "new", idFrom: CODE },
		name: term(formField(CODE)),
	};
	return buildDoc(
		{
			appId: KEYED_APP_ID,
			appName: "Samples",
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "sample", properties: [] },
			],
			modules: [
				{
					uuid: "keyed-patients",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "keyed-register",
							name: "Register",
							type: "registration",
							fields: [
								f({
									uuid: "keyed-name",
									kind: "text",
									id: "name",
									label: "Name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									uuid: "keyed-code",
									kind: "text",
									id: "code",
									label: "Sample code",
								}),
							],
						},
					],
				},
			],
		},
		(built) => {
			const form = built.forms[REGISTER];
			if (form === undefined) throw new Error("The app holds no Register.");
			built.forms[REGISTER] = { ...form, caseOperations: [create] };
		},
	);
}

/** The keyed create of `keyedCreateApp` and the form that holds it. */
const KEYED_CREATE = {
	formUuid: REGISTER,
	operationUuid: SAMPLE,
	caseType: "sample",
} as const;

/** The prefix the keyed create's cases stand under in an app of id `appId`. */
export function keyedPrefixIn(appId: string): string {
	return authoredCaseIdPrefix({ appId, ...KEYED_CREATE });
}

/** The prefix `keyedCreateApp`'s emission writes, and so the one CommCare HQ holds after Nova's export. */
export const EMITTED_KEYED_PREFIX = keyedPrefixIn(KEYED_APP_ID);

/**
 * `keyedCreateApp` as CommCare HQ serves it at save counter `version`, its
 * keyed create's cases standing under `prefix`: a person who edits the case
 * id's calculation in CommCare HQ's form builder changes it there, in the
 * form's source alone.
 */
export function servedKeyedApp(
	version: number,
	prefix: string = EMITTED_KEYED_PREFIX,
): ServedHqApp {
	let held = false;
	const served = servedHqApp(keyedCreateApp(), version, (xml) => {
		held ||= xml.includes(EMITTED_KEYED_PREFIX);
		return xml.replaceAll(EMITTED_KEYED_PREFIX, prefix);
	});
	if (!held)
		throw new Error("The app's form holds no case id under its prefix.");
	return served;
}
