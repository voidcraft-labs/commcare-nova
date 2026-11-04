/**
 * Nova's emission of each form `proof/hq/fixtures/advanced-rule-shapes.json`
 * holds (written by `lib/commcare/__tests__/advancedPlacement.test.ts` from
 * the production predicates), for `proof/hq/test_advanced_rules.py`: each
 * row's refused and accepted twins built again on the fixture they came from
 * (`advancedPlacementFixture.ts::advancedFixture`), held to the commit gate's
 * validator, and written as the HQ import body Nova sends (`expandDoc`), as
 * `<row>-refused.json` and `<row>-accepted.json`, with the fixture itself as
 * `shapes.json`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { advancedFixture } from "../../../lib/commcare/__tests__/advancedPlacementFixture";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	type CaseOperation,
	type Form,
} from "../../../lib/domain";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-advanced-rule-evidence.ts OUTPUT_DIRECTORY",
	);

const SHAPES = resolve(
	import.meta.dirname,
	"../../hq/fixtures/advanced-rule-shapes.json",
);

interface Twin {
	readonly formType: Form["type"];
	readonly menu: "households" | "members";
	readonly nested: boolean;
	readonly operations: CaseOperation[];
	readonly openCondition?: Form["openCondition"];
	readonly closeCondition?: Form["closeCondition"];
}

interface Row {
	readonly clause: string;
	readonly action: "load" | "open";
	readonly refused: Twin;
	readonly accepted: Twin;
}

const text = readFileSync(SHAPES, "utf8");
const shapes = JSON.parse(text) as { rows: Row[] };
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "shapes.json"), text);
const refusals: string[] = [];
shapes.rows.forEach((row, index) => {
	for (const side of ["refused", "accepted"] as const) {
		const twin = row[side];
		const { doc } = advancedFixture({
			formType: twin.formType,
			menu: twin.menu,
			nested: twin.nested,
			form: {
				...(twin.openCondition !== undefined && {
					openCondition: twin.openCondition,
				}),
				...(twin.closeCondition !== undefined && {
					closeCondition: twin.closeCondition,
				}),
			},
			operations: () => structuredClone(twin.operations),
		});
		blueprintDocSchema.parse(toPersistableDoc(doc));
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		if (findings.length > 0) {
			refusals.push(
				`row ${index}, the ${row.action} clause "${row.clause}", ${side}: ${findings.map((finding) => finding.code).join(", ")}`,
			);
			continue;
		}
		writeFileSync(
			resolve(output, `${index}-${side}.json`),
			JSON.stringify(expandDoc(doc)),
		);
	}
});
if (refusals.length > 0)
	throw new Error(
		`Nova's commit gate refuses ${refusals.length} of the forms proof/hq/fixtures/advanced-rule-shapes.json holds, so no export of them reaches CommCare HQ to compare: ${refusals.join("; ")}. Each twin must be a document Nova admits; complete it in lib/commcare/__tests__/advancedPlacementFixture.ts or the row in advancedPlacement.test.ts, and write the fixture again.`,
	);
