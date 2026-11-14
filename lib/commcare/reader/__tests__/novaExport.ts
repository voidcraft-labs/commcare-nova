/**
 * A Nova document as CommCare HQ serves its export, on HQ's own app shell,
 * with the source of each form and the menus open to a test's edits: the
 * input a whole reading takes in these tests.
 */

import type { BlueprintDoc } from "@/lib/domain";
import { type ExpandOptions, expandDoc } from "../../expander";
import type { ReaderInput } from "../types";
import { readerInput, retainedSourceBody, sourceFromBody } from "./readerInput";

export interface ExportEdits {
	/** Each form's source, changed as a person or HQ's builder would. */
	readonly xml?: (xml: string) => string;
	/** The menus, changed as HQ's pages would store them. */
	readonly modules?: (
		modules: Record<string, unknown>[],
	) => Record<string, unknown>[];
	/** Root keys written over the shell's. */
	readonly root?: Readonly<Record<string, unknown>>;
	/** What the export is expanded with: the tables' names, for an app that reads one. */
	readonly expand?: ExpandOptions;
}

/**
 * HQ's source body for `doc`'s export, with `edits` applied: every key the
 * export carries written over HQ's shell, as HQ's import replaces each
 * top-level key a body holds (`models/applications.py::_merge_source_into_app`),
 * so the languages and their strings are the export's.
 */
export function exportedBody(
	doc: BlueprintDoc,
	edits: ExportEdits = {},
): Record<string, unknown> {
	const emitted = JSON.parse(
		JSON.stringify(expandDoc(doc, edits.expand)),
	) as Record<string, unknown>;
	const attachments = Object.fromEntries(
		Object.entries(emitted._attachments as Record<string, string>).map(
			([name, xml]) => [name, edits.xml === undefined ? xml : edits.xml(xml)],
		),
	);
	const modules = emitted.modules as Record<string, unknown>[];
	return {
		...retainedSourceBody("shell/app-source"),
		...emitted,
		modules: edits.modules === undefined ? modules : edits.modules(modules),
		_attachments: attachments,
		...edits.root,
	};
}

/** The reader's input over `body`, every expression's record print held to read back. */
export async function inputFor(
	body: Readonly<Record<string, unknown>>,
	overrides: Partial<ReaderInput> = {},
): Promise<ReaderInput> {
	const input = readerInput(await sourceFromBody(body));
	return { ...input, recordDialect: () => undefined, ...overrides };
}

/** A mirror menu of the menu `source`, as HQ stores one. */
export function mirrorMenu(source: string): Record<string, unknown> {
	return {
		doc_type: "ShadowModule",
		unique_id: `mirror-of-${source}`,
		name: { en: "Mirror" },
		case_type: null,
		forms: [],
		source_module_id: source,
	};
}
