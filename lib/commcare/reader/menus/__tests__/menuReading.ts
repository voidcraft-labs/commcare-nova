/**
 * A document read back through every stage of the reader: Nova's emission
 * of the document, on CommCare HQ's own app shell, as HQ's source view serves
 * it, read by `readHqApp`. A test may change the emitted JSON first, at the
 * key HQ's page or model writes, as HQ would store it.
 */
import {
	type BlueprintDoc,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import type { Finding } from "@/lib/publish/hqFindings";
import { expandDoc } from "../../../expander";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import type { ReadContext } from "../../context";
import { readHqApp, STAGES } from "../../index";
import type { ReadOutcome } from "../../types";

export type JsonObject = Record<string, unknown>;
export type AppJson = JsonObject & {
	modules: Array<JsonObject & { forms: JsonObject[] }>;
};

export interface MenuReading {
	readonly outcome: ReadOutcome;
	/** The read document, where the reading holds no finding. */
	readonly doc: BlueprintDoc | undefined;
	readonly findings: readonly Finding[];
	/** The source as the test stored it. */
	readonly app: AppJson;
}

/** `doc` emitted, `edit` applied to the stored JSON, and read back. */
export async function readMenusOf(
	doc: BlueprintDoc,
	edit: (app: AppJson) => void = () => {},
	caseListActionsApplied = true,
): Promise<MenuReading> {
	const emitted = expandDoc(doc);
	const app = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			langs: emitted.langs,
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	edit(app);
	const input = readerInput(await sourceFromBody(app));
	const outcome = readHqApp({
		...input,
		caseListActionsApplied,
		recordDialect: () => undefined,
	});
	return {
		outcome,
		doc: outcome.kind === "read" ? outcome.draft.doc : undefined,
		findings: outcome.kind === "account" ? outcome.findings : [],
		app,
	};
}

/** The codes of a reading's findings, `unrecognized` with its surface key. */
export function codesOf(reading: MenuReading): string[] {
	return reading.findings.map((finding) =>
		finding.code === "unrecognized"
			? `unrecognized:${(finding.detail as { name?: string }).name ?? ""}`
			: finding.code,
	);
}

/** The read document's module of `name`. */
export function moduleNamed(doc: BlueprintDoc, name: string) {
	const module = Object.values(doc.modules).find((one) => one.name === name);
	if (module === undefined)
		throw new Error(`The read document holds no menu named ${name}.`);
	return module;
}

/** The read document's form of `name`. */
export function formNamed(doc: BlueprintDoc, name: string) {
	const form = Object.values(doc.forms).find((one) => one.name === name);
	if (form === undefined)
		throw new Error(`The read document holds no form named ${name}.`);
	return form;
}

/** `doc` emitted, `edit` applied, and the reader's stages run on it up to `count`, or all. */
export async function stagesOver(
	doc: BlueprintDoc,
	edit: (app: AppJson) => void,
	count = STAGES.length,
): Promise<ReadContext> {
	const emitted = expandDoc(doc);
	const app = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			langs: emitted.langs,
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	edit(app);
	const ctx = readContext({
		...readerInput(await sourceFromBody(app)),
		caseListActionsApplied: true,
		recordDialect: () => undefined,
	});
	for (const stage of STAGES.slice(0, count)) stage(ctx);
	return ctx;
}

/** `doc` with a second language, Spanish, and the given texts translated into it. */
export function inSpanish(
	doc: BlueprintDoc,
	texts: ReadonlyMap<TranslationUnitId, string>,
): BlueprintDoc {
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of texts) {
		const unit = units.get(unitId);
		if (unit === undefined) throw new Error(`The document has no ${unitId}.`);
		entries[unitId] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	return {
		...doc,
		localization: {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: { spa: entries },
		},
	};
}
