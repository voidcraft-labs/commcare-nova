// proof/ci/products.mjs is what holds the native proofs' products, made once
// on CI's x64 runner and read by arm64 shards, equal wherever they are
// produced (proof-image.yml's weekly check). Its contract: two productions
// are the same exactly when they differ by a one-to-one renaming, per
// product, of the ids each one minted; any other byte differs, inside a zip
// archive too; and a product that failed, or that only one side holds, fails
// the comparison. The fixtures are productions written as produce.py lays
// them out, with each .ccz built by adm-zip, the library Nova builds its .ccz
// with (lib/commcare/compiler.ts), so the archive reader is held to archives
// it did not write.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Scripts } from "./scripts";

let scratch: string;
let scripts: Scripts;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-products-"));
	scripts = new Scripts(undefined, scratch);
});

afterEach(async () => {
	await scripts.join();
	await rm(scratch, { recursive: true, force: true });
});

// A content digest every production writes alike, which is compared as written.
const DIGEST = "3f786850e387550fdab836ed7e6dc881de23001b";

interface Ids {
	form: string;
	module: string;
	xmlns: string;
	profile: string;
	hq: string;
}

function minted(): Ids {
	return {
		form: randomBytes(20).toString("hex"),
		module: randomBytes(20).toString("hex"),
		xmlns: randomBytes(8).toString("hex"),
		profile: randomUUID(),
		hq: randomUUID(),
	};
}

function suite(ids: Ids, label = "Register"): string {
	return `<suite><entry form="${ids.form}"><command id="m0-f0"><text>${label}</text></command></entry><menu id="${ids.module}"/></suite>\n`;
}

/** The files of one production, by path under its directory; `edit` changes them before they are written. */
function layout(
	ids: Ids,
	edit: (files: Map<string, Buffer>) => void = () => {},
) {
	const ccz = new AdmZip();
	ccz.addFile("suite.xml", Buffer.from(suite(ids)));
	ccz.addFile(
		"profile.ccpr",
		Buffer.from(`<profile uniqueid="${ids.profile}" digest="${DIGEST}"/>\n`),
	);
	ccz.addFile(
		"modules-0/forms-0.xml",
		Buffer.from(
			`<h:html xmlns="http://openrosa.org/formdesigner/${ids.xmlns}"/>\n`,
		),
	);
	const files = new Map<string, Buffer>([
		[
			"case/app.json",
			Buffer.from(
				`${JSON.stringify({ modules: [{ unique_id: ids.module, forms: [{ unique_id: ids.form, xmlns: `http://openrosa.org/formdesigner/${ids.xmlns}` }] }], digest: DIGEST })}\n`,
			),
		],
		["case/app.ccz", ccz.toBuffer()],
		["hq-oracle/answer.json", Buffer.from(`{"case_id": "${ids.hq}"}\n`)],
		[
			"produced.json",
			Buffer.from(
				`${JSON.stringify({ case: { status: 0, error: null }, "hq-oracle": { status: 0, error: null } })}\n`,
			),
		],
		["logs/case.log", Buffer.from(`produced in ${Math.random()} s\n`)],
		["timings.json", Buffer.from(`{"case": ${Math.random()}}\n`)],
	]);
	edit(files);
	return files;
}

async function write(name: string, files: Map<string, Buffer>) {
	const root = join(scratch, name);
	for (const [path, bytes] of files) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), bytes);
	}
	return root;
}

function compare(left: string, right: string) {
	return scripts.run("products.mjs", ["compare", left, right]);
}

it("holds two productions the same when they differ only in the ids each minted", async () => {
	const left = await write("left", layout(minted()));
	const right = await write("right", layout(minted()));
	const compared = await compare(left, right);
	expect(compared.code).toBe(0);
	expect(compared.stdout).toContain(
		"are the same, but for the ids each production minted.",
	);
});

it("finds a byte that differs inside an archive's entry", async () => {
	const left = await write("left", layout(minted()));
	const ids = minted();
	const right = await write(
		"right",
		layout(ids, (files) => {
			const ccz = new AdmZip(files.get("case/app.ccz"));
			ccz.updateFile("suite.xml", Buffer.from(suite(ids, "Registr")));
			files.set("case/app.ccz", ccz.toBuffer());
		}),
	);
	const compared = await compare(left, right);
	expect(compared.code).toBe(1);
	expect(compared.stdout).toContain("1 files differ");
	expect(compared.stdout).toContain("case/app.ccz!suite.xml: differs at byte");
});

it("finds ids that relate differently across a product's files", async () => {
	// The right production's suite names a form and a module its app.json does
	// not: each id alone is a minted one, but the two files no longer agree.
	const left = await write("left", layout(minted()));
	const right = await write(
		"right",
		layout(minted(), (files) => {
			const ccz = new AdmZip(files.get("case/app.ccz"));
			ccz.updateFile("suite.xml", Buffer.from(suite(minted())));
			files.set("case/app.ccz", ccz.toBuffer());
		}),
	);
	const compared = await compare(left, right);
	expect(compared.code).toBe(1);
	// The archive comes first in path order, so its ids are named first and app.json's disagree.
	expect(compared.stdout).toContain("1 files differ");
	expect(compared.stdout).toContain("case/app.json: differs at byte");
});

it("compares an id both productions hold as written, so one that changes place differs", async () => {
	// HQ's answer names a case the fixture fixes (both sides hold its id) and one
	// it mints. The right production swaps them: renamed alike, every id-shaped
	// token would line up again, but the fixed id is not minted and stays as written.
	const answer = (caseId: string, parentId: string) =>
		Buffer.from(`{"case_id": "${caseId}", "parent_id": "${parentId}"}\n`);
	const ids = minted();
	const left = await write(
		"left",
		layout(ids, (files) => {
			files.set("hq-oracle/answer.json", answer(ids.hq, DIGEST));
		}),
	);
	const other = minted();
	const right = await write(
		"right",
		layout(other, (files) => {
			files.set("hq-oracle/answer.json", answer(DIGEST, other.hq));
		}),
	);
	const compared = await compare(left, right);
	expect(compared.code).toBe(1);
	expect(compared.stdout).toContain("1 files differ");
	expect(compared.stdout).toContain(
		"hq-oracle/answer.json: differs at byte 13",
	);
});

it("fails a product that failed or that one side does not hold, and ignores how each production went", async () => {
	const left = await write("left", layout(minted()));
	const right = await write(
		"right",
		layout(minted(), (files) => {
			files.delete("hq-oracle/answer.json");
			files.set(
				"produced.json",
				Buffer.from(
					`${JSON.stringify({ case: { status: 0, error: null }, "hq-oracle": { status: 1, error: "exited with status 1, so its corpus is incomplete" } })}\n`,
				),
			);
		}),
	);
	const compared = await compare(left, right);
	expect(compared.code).toBe(1);
	expect(compared.stdout).toContain(
		"the hq-oracle product failed on the right: it exited with status 1, so its corpus is incomplete.",
	);
	expect(compared.stdout).toContain("hq-oracle/answer.json: only on the left.");
	// logs/ and timings.json differ between every two productions and are never named.
	expect(compared.stdout).not.toMatch(/logs\/|timings\.json/);
});

it("refuses a side that is no production", async () => {
	const left = await write("left", layout(minted()));
	const right = await write(
		"right",
		layout(minted(), (files) => files.delete("produced.json")),
	);
	const compared = await compare(left, right);
	expect(compared.code).toBe(2);
	expect(compared.stderr).toContain("produced.json cannot be read");
});
