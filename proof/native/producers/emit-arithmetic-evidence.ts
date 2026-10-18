import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { arithmeticFixture } from "../../../lib/commcare/__tests__/arithmeticFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { requireExpressionContext } from "../../../lib/commcare/expressionContext";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { toWire } from "../../../lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "../../../lib/commcare/xpath/wire/serialize";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema } from "../../../lib/domain";
import { arith, literal, term } from "../../../lib/domain/expression";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-arithmetic-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
const { doc, formUuid } = arithmeticFixture();
const operation = doc.forms[formUuid].caseOperations?.[0];
if (operation === undefined)
	throw new Error("The arithmetic fixture has no write operation.");
const types = requireExpressionContext(doc, {
	entity: "form",
	uuid: formUuid,
	slot: "case_operation_write_value",
	member: { operationUuid: operation.uuid, property: "quotient" },
});
blueprintDocSchema.parse(toPersistableDoc(doc));
const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
if (findings.length) throw new Error(JSON.stringify(findings));
const hq = expandDoc(doc);
const zip = new AdmZip(
	compileCcz(hq, doc.appName, doc, {
		runtimeTarget: NATIVE_RUNTIME_TARGET,
	}),
);
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
		.map(
			([a, b]) =>
				serializeWire(
					toWire(arith("quotient", term(literal(a)), term(literal(b))), {
						target: "xform",
						types,
					}),
					{ target: "xform", constraint: false },
				).text,
		)
		.join("\n"),
);
