/**
 * A document read back through every stage of the reader: Nova's emission
 * of the document, on CommCare HQ's own app shell, as HQ's source view serves
 * it, read by `readHqApp`. A test may change the emitted JSON first, at the
 * key HQ's page or model writes, as HQ would store it.
 */
import type { BlueprintDoc } from "@/lib/domain";
import type { Finding } from "@/lib/publish/hqFindings";
import { expandDoc } from "../../../expander";
import {
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readHqApp } from "../../index";
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
): Promise<MenuReading> {
	const emitted = expandDoc(doc);
	const app = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	edit(app);
	const input = readerInput(await sourceFromBody(app));
	const outcome = readHqApp({ ...input, recordDialect: () => undefined });
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
