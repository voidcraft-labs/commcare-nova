import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { arithmeticFixture } from "../../../lib/commcare/__tests__/arithmeticFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { emitOnDeviceExpression } from "../../../lib/commcare/expression/onDeviceEmitter";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema } from "../../../lib/domain";
import { arith, literal, term } from "../../../lib/domain/predicate";

const output = process.argv[2];
if (!output) throw new Error("Pass an output directory.");
mkdirSync(output, { recursive: true });
const { doc } = arithmeticFixture();
blueprintDocSchema.parse(toPersistableDoc(doc));
const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
if (findings.length) throw new Error(JSON.stringify(findings));
const hq = expandDoc(doc);
const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
writeFileSync(
	resolve(output, "arithmetic.xml"),
	zip.readAsText("modules-0/forms-0.xml"),
);
writeFileSync(resolve(output, "arithmetic.json"), JSON.stringify(hq));
// Separate scalar probes preserve the existing native zero behavior; these
// are runtime observations, not a claim that a non-finite case write succeeds.
writeFileSync(
	resolve(output, "arithmetic-zero.txt"),
	[
		[1, 0],
		[-1, 0],
		[0, 0],
	]
		.map(([a, b]) =>
			emitOnDeviceExpression(arith("div", term(literal(a)), term(literal(b)))),
		)
		.join("\n"),
);
