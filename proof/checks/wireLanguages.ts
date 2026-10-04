/**
 * Each language of a Nova document in the order Nova's expander writes the
 * app's `langs`, for proof 1 over an edit (`proof/checks/proof1.py`): each
 * language's tag and its wire code, so a language is paired with itself
 * between D and D′ by its tag and compared at its position in HQ's `langs`.
 *
 * The codes come from the functions `lib/commcare/localization.ts::
 * commCareLocalization` calls for the expander: the language wire plan
 * (`planLanguageWire`) over the document's effective localization
 * (`effectiveAppLocalization`), in its `languageOrder`.
 *
 *   node --conditions=react-server --import tsx proof/checks/wireLanguages.ts <document.json>...
 *
 * Each argument is a corpus `document.json` (its `doc` is the persistable
 * document). Prints one JSON array, one entry per argument, in order.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { planLanguageWire } from "@/lib/commcare/languageWire";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { effectiveAppLocalization, type PersistableDoc } from "@/lib/domain";

export interface WireLanguage {
	readonly tag: string;
	readonly code: string;
}

export function wireLanguages(persisted: PersistableDoc): WireLanguage[] {
	const localization = effectiveAppLocalization(
		hydratePersistedBlueprint(persisted).localization,
	);
	const wire = planLanguageWire(
		localization.languageOrder,
		localization.defaultLanguage,
	);
	return localization.languageOrder.map((tag) => {
		const code = wire.wireCodeByTag.get(tag);
		if (code === undefined) {
			throw new Error(
				`The language wire plan gave the language ${tag} no code, so its position on the wire is unknown.`,
			);
		}
		return { tag, code };
	});
}

async function main(paths: readonly string[]): Promise<void> {
	if (paths.length === 0) {
		throw new Error(
			"Name one or more corpus document.json files whose languages to print.",
		);
	}
	const languages: WireLanguage[][] = [];
	for (const path of paths) {
		const file = JSON.parse(await readFile(path, "utf8")) as {
			doc?: PersistableDoc;
		};
		if (file.doc === undefined) {
			throw new Error(
				`${path} holds no doc, the persistable document a corpus document.json carries.`,
			);
		}
		languages.push(wireLanguages(file.doc));
	}
	process.stdout.write(`${JSON.stringify(languages)}\n`);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
