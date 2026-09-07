import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { mediaWireFixture } from "../../../lib/commcare/__tests__/mediaWireFixtures";
import { suiteOracleCases } from "../../../lib/commcare/__tests__/suiteOracleCorpus";
import { xformOracleCases } from "../../../lib/commcare/__tests__/xformOracleCorpus";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const out = resolve(process.argv[2] ?? "/tmp/nova-oracle-evidence");
mkdirSync(out, { recursive: true });
for (const entry of xformOracleCases)
	writeFileSync(resolve(out, `${entry.name}.xml`), entry.xml);
writeFileSync(
	resolve(out, "xform-cases.tsv"),
	xformOracleCases
		.map((entry) => `${entry.name}\t${entry.nativeAccepts}`)
		.join("\n"),
);
console.log(`${xformOracleCases.length} native XForm cases`);
for (const entry of suiteOracleCases)
	writeFileSync(resolve(out, `${entry.name}.suite.xml`), entry.xml);
writeFileSync(
	resolve(out, "suite-cases.tsv"),
	suiteOracleCases
		.map((entry) => `${entry.name}\t${entry.nativeAccepts}`)
		.join("\n"),
);
console.log(`${suiteOracleCases.length} native suite cases`);

const { doc } = mediaWireFixture();
const archive = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
writeFileSync(
	resolve(out, "admitted-case-title.suite.xml"),
	archive.readAsText("suite.xml"),
);
writeFileSync(
	resolve(out, "admitted-case-title.strings.properties"),
	archive.readAsText("default/app_strings.txt"),
);
