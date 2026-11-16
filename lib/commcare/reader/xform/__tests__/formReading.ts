/**
 * One form's source read through the reader's own stages, over an app on
 * CommCare HQ's own shell: the application walker and the structure stage
 * admit the form and its attachment, the forms stage reads the source, and
 * stage 5b mints its fields. What the stages after it would claim (its text,
 * its logic) stays unclaimed, so a test reads the findings it is about.
 */

import type { Finding } from "@/lib/publish/hqFindings";
import {
	closeAfterStructure,
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readApplication } from "../../appShell";
import type { DraftForm, ReadContext } from "../../context";
import { readStructure } from "../../structure";
import type { ReaderLookupCatalog, ReaderMediaResolution } from "../../types";
import {
	type DraftField,
	mintFields,
	type ReadXForm,
	readForms,
} from "../index";

export const XMLNS = "http://openrosa.org/formdesigner/reader-test";

const NAMESPACES = [
	'xmlns:h="http://www.w3.org/1999/xhtml"',
	'xmlns="http://www.w3.org/2002/xforms"',
	'xmlns:jr="http://openrosa.org/javarosa"',
	'xmlns:vellum="http://commcarehq.org/xforms/vellum"',
	'xmlns:orx="http://openrosa.org/jr/xforms"',
	'xmlns:odkx="http://opendatakit.org/xforms"',
].join(" ");

/** A form's source from its parts, as HQ's form builder lays one out. */
export function xformSource(parts: {
	readonly data: string;
	readonly model?: string;
	readonly body?: string;
	readonly head?: string;
	readonly root?: string;
	readonly rootAttributes?: string;
}): string {
	const root = parts.root ?? "data";
	return `<?xml version="1.0" encoding="UTF-8"?>
<h:html ${NAMESPACES}>
<h:head>
<h:title>Form</h:title>
<model>
<instance>
<${root} xmlns="${XMLNS}" uiVersion="1" version="1" name="Form"${parts.rootAttributes ?? ""}>${parts.data}</${root}>
</instance>
${parts.model ?? ""}
</model>
${parts.head ?? ""}
</h:head>
<h:body>${parts.body ?? ""}</h:body>
</h:html>`;
}

export interface FormReading {
	readonly ctx: ReadContext;
	readonly form: DraftForm;
	readonly xform: ReadXForm | null;
	readonly closed: ReturnType<ReadContext["close"]>;
}

export interface FormReadingOptions {
	readonly lookup?: ReaderLookupCatalog;
	/** Run stage 5b as well. */
	readonly mint?: boolean;
	/** The app's language codes, HQ's `langs`, where a test reads text in several languages. */
	readonly langs?: readonly string[];
	/** What the media index answers for a path; every path has no entry where none is given. */
	readonly media?: (path: string) => ReaderMediaResolution;
}

/** Reads the sources of an app of one menu, each form's source given whole. */
export async function readForm(
	source: string,
	options: FormReadingOptions = {},
): Promise<FormReading> {
	const body = {
		...retainedSourceBody("shell/app-source"),
		modules: [
			{
				doc_type: "Module",
				unique_id: "m-reader",
				name: { en: "Menu" },
				case_type: "",
				forms: [
					{
						doc_type: "Form",
						unique_id: "r1",
						xmlns: XMLNS,
						name: { en: "Form" },
					},
				],
			},
		],
		_attachments: { "r1.xml": source },
		...(options.langs === undefined ? {} : { langs: options.langs }),
	};
	const input = readerInput(
		await sourceFromBody(body),
		options.media === undefined ? {} : { media: options.media },
	);
	const ctx = readContext(
		options.lookup === undefined ? input : { ...input, lookup: options.lookup },
	);
	readApplication(ctx);
	readStructure(ctx);
	readForms(ctx);
	if (options.mint === true) mintFields(ctx);
	const form = ctx.draft.modules[0]?.forms[0] as DraftForm;
	return { ctx, form, xform: form.xform, closed: closeAfterStructure(ctx) };
}

/** The findings at a question or its form, the form reader's places. */
export function formFindings(reading: FormReading): readonly Finding[] {
	return reading.closed.findings.filter(
		(finding) =>
			finding.place.kind === "question" || finding.place.kind === "form",
	);
}

/** The codes of the findings at the question at `path`. */
export function codesAt(reading: FormReading, path: string): string[] {
	return reading.closed.findings
		.filter(
			(finding) =>
				finding.place.kind === "question" && finding.place.path === path,
		)
		.map((finding) => finding.code);
}

/** The names of the `unrecognized` findings at the question at `path`. */
export function unrecognizedAt(reading: FormReading, path: string): string[] {
	return reading.closed.findings
		.filter(
			(finding) =>
				finding.code === "unrecognized" &&
				finding.place.kind === "question" &&
				finding.place.path === path,
		)
		.map((finding) => finding.detail.name ?? "");
}

/** The fields of a reading in document order. */
export function readFields(xform: ReadXForm): DraftField[] {
	const order: DraftField[] = [];
	const walk = (parent: DraftField | null) => {
		for (const field of xform.childrenOf(parent)) {
			order.push(field);
			walk(field);
		}
	};
	walk(null);
	return order;
}
