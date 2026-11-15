/**
 * The one comparison of a document with what a reading of its export gave.
 *
 * Contract: `readBackDifferences` leaves out of both documents every entity
 * of a kind CommCare HQ's app holds nothing of (`KINDS_WITH_NO_EXTERNAL_KEY`)
 * and compares every other entity; where the reading offered its declarations
 * beside the document, it leaves out the declaration `expected` holds and
 * reports one difference at `appSettings/runsOnlyOn` where no offered choice
 * is that declaration; with `choices: null` it compares the two declarations
 * in place; and its module graph holds no canonical form, which a caller
 * applies where its claim has one.
 *
 * Plausible failures: the fuzz read back and the proof lane's read back
 * making two comparisons of one claim; a kind compared by nothing, or one a
 * reading can never return failing every read back; a declaration the
 * reading does not offer passing unseen; a canonical form applied inside the
 * comparison, which would forgive a reader that returns one member of a pair
 * for CommCare HQ's bytes and the other for Nova's.
 */

import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { KINDS_WITH_NO_EXTERNAL_KEY } from "@/lib/commcare/reader/identity";
import type { BlueprintDoc } from "@/lib/domain";
import { BLUEPRINT_AUTHORED_IDENTITY_KINDS } from "@/lib/domain/authoredIdentities";
import { readBackDifferences } from "../readBack";
import {
	entitiesOf,
	everyKindDocument,
	plantedInside,
} from "./readBackDocument";

const NO_EXTERNAL_KEY: ReadonlySet<string> = new Set(
	KINDS_WITH_NO_EXTERNAL_KEY,
);

function declared(
	doc: BlueprintDoc,
	runsOnlyOn: BlueprintDoc["appSettings"]["runsOnlyOn"],
): BlueprintDoc {
	const { runsOnlyOn: _old, ...appSettings } = doc.appSettings;
	return {
		...doc,
		appSettings:
			runsOnlyOn === undefined ? appSettings : { ...appSettings, runsOnlyOn },
	};
}

describe("readBackDifferences", () => {
	it("gives none for one document read back as itself", () => {
		const doc = everyKindDocument();
		expect(readBackDifferences(doc, { doc, choices: null })).toEqual([]);
	});

	it("compares every entity but those of a kind no wire carries", () => {
		const doc = everyKindDocument();
		const entities = entitiesOf(doc);
		// The fixture holds every kind, so no kind goes unjudged.
		expect(new Set(entities.map((entity) => entity.kind))).toEqual(
			new Set(BLUEPRINT_AUTHORED_IDENTITY_KINDS),
		);
		for (const entity of entities) {
			const planted = plantedInside(doc, entity.uuid);
			const differences = readBackDifferences(doc, {
				doc: planted,
				choices: null,
			});
			if (NO_EXTERNAL_KEY.has(entity.kind))
				expect(differences, entity.kind).toEqual([]);
			else expect(differences.length, entity.kind).toBeGreaterThan(0);
			// Planted on the expected side, the same holds.
			const reversed = readBackDifferences(planted, { doc, choices: null });
			expect(reversed.length === 0, entity.kind).toBe(
				NO_EXTERNAL_KEY.has(entity.kind),
			);
		}
	});

	it("leaves out the declaration a reading offers beside the document, and says where none is offered", () => {
		const read = declared(everyKindDocument(), undefined);
		const androidOnly = declared(read, "android");
		expect(
			readBackDifferences(androidOnly, {
				doc: read,
				choices: [{ runsOnlyOn: "android" }, { runsOnlyOn: undefined }],
			}),
		).toEqual([]);
		expect(
			readBackDifferences(androidOnly, {
				doc: read,
				choices: [{ runsOnlyOn: "web-apps" }, { runsOnlyOn: undefined }],
			}),
		).toEqual([{ path: ["appSettings", "runsOnlyOn"], kind: "value" }]);
		// Both platforms is a choice that declares nothing.
		expect(
			readBackDifferences(read, {
				doc: read,
				choices: [{ runsOnlyOn: undefined }],
			}),
		).toEqual([]);
		expect(
			readBackDifferences(read, {
				doc: read,
				choices: [{ runsOnlyOn: "android" }],
			}),
		).toEqual([{ path: ["appSettings", "runsOnlyOn"], kind: "value" }]);
		// A reading that offers nothing offers no declaration.
		expect(readBackDifferences(read, { doc: read, choices: [] })).toEqual([
			{ path: ["appSettings", "runsOnlyOn"], kind: "value" },
		]);
	});

	it("compares the two declarations in place where the reading is whole", () => {
		const read = declared(everyKindDocument(), "android");
		expect(readBackDifferences(read, { doc: read, choices: null })).toEqual([]);
		expect(
			readBackDifferences(read, {
				doc: declared(read, undefined),
				choices: null,
			}),
		).toEqual([{ path: ["appSettings", "runsOnlyOn"], kind: "missing" }]);
		expect(
			readBackDifferences(declared(read, "web-apps"), {
				doc: read,
				choices: null,
			}),
		).toEqual([{ path: ["appSettings", "runsOnlyOn"], kind: "value" }]);
	});

	it("holds no canonical form in its module graph", async () => {
		const entry = "lib/deployment/reading/readBack.ts";
		const { metafile } = await build({
			entryPoints: [entry],
			bundle: true,
			write: false,
			metafile: true,
			platform: "node",
			format: "esm",
			packages: "external",
			logLevel: "silent",
		});
		const inputs = Object.keys(metafile.inputs);
		expect(inputs).toContain(entry);
		expect(inputs).toContain("lib/doc/documentDifferences.ts");
		expect(inputs).not.toContain("lib/commcare/reader/canon.ts");
	});
});
