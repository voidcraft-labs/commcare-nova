import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	caseChoiceDoc,
	caseChoiceSnapshot,
} from "../../../lib/__tests__/caseChoiceFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output) throw new Error("A case-choice evidence directory is required.");
mkdirSync(output, { recursive: true });
const doc = caseChoiceDoc();
const hq = expandDoc(doc);
const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
writeFileSync(resolve(output, "app.json"), JSON.stringify(hq));
for (const [index, name] of ["directory", "attendance"].entries())
	writeFileSync(
		resolve(output, `${name}.xml`),
		zip.readAsText(`modules-${index}/forms-0.xml`),
	);
writeFileSync(
	resolve(output, "cases.tsv"),
	caseChoiceSnapshot()
		.rows.map((row) =>
			[
				row.case_id,
				row.case_type,
				row.case_name,
				row.parent_case_id ?? "",
				row.status,
			].join("\t"),
		)
		.join("\n"),
);
