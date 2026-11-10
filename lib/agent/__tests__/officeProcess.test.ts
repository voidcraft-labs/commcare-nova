import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";
import { OfficeParser } from "../officeProcess";
import { docxDocument } from "./fixtures/officeDocuments";

async function childFixture(source: string) {
	const directory = await mkdtemp(join(tmpdir(), "nova-office-"));
	const workerPath = join(directory, "child.mjs");
	const pidPath = join(directory, "pid");
	await writeFile(
		workerPath,
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\n${source}`,
	);
	return { directory, workerPath, pidPath };
}

function assertGone(pid: number) {
	expect(() => process.kill(pid, 0)).toThrow(
		expect.objectContaining({ code: "ESRCH" }),
	);
}

const validResult =
	'JSON.stringify({ markdown: "finished", figures: [], warnings: [], peakRssKb: process.resourceUsage().maxRSS })';

describe("Office subprocess ownership", () => {
	it("kills and joins synchronous work on cancellation, then admits the waiting file", async () => {
		const fixture = await childFixture(
			`if (process.argv[2] === "docx") { for (;;) {} } else { process.stdout.write(${validResult}); }`,
		);
		const controller = new AbortController();
		const parser = new OfficeParser({ workerPath: fixture.workerPath });
		const running = parser.convert(Buffer.alloc(0), "docx", controller.signal);
		const rejected = expect(running).rejects.toThrow("cancel reading");
		let queued: Promise<unknown> | undefined;
		try {
			await vi.waitFor(async () =>
				expect(Number(await readFile(fixture.pidPath, "utf8"))).toBeGreaterThan(
					0,
				),
			);
			const pid = Number(await readFile(fixture.pidPath, "utf8"));
			queued = parser.convert(Buffer.alloc(0), "xlsx");
			controller.abort(new Error("cancel reading"));
			await rejected;
			assertGone(pid);
			await expect(queued).resolves.toMatchObject({ markdown: "finished" });
		} finally {
			controller.abort(new Error("cancel reading"));
			await Promise.allSettled([
				running,
				...(queued !== undefined ? [queued] : []),
			]);
			await rm(fixture.directory, { recursive: true, force: true });
		}
	});

	it("bounds pending requests and removes canceled waiters without starting them", async () => {
		const fixture = await childFixture("for (;;) {}");
		const parser = new OfficeParser({ workerPath: fixture.workerPath });
		const active = new AbortController();
		const waiting = new AbortController();
		const running = parser.convert(Buffer.alloc(0), "docx", active.signal);
		const result = Promise.allSettled([running]);
		const queued = Array.from({ length: 4 }, () =>
			parser.convert(Buffer.alloc(0), "docx", waiting.signal),
		);
		const queueResults = Promise.allSettled(queued);
		try {
			await expect(parser.convert(Buffer.alloc(0), "xlsx")).rejects.toThrow(
				"several files",
			);
			waiting.abort();
			expect(
				(await queueResults).every((item) => item.status === "rejected"),
			).toBe(true);
			active.abort();
			await result;
		} finally {
			active.abort();
			waiting.abort();
			await Promise.all([result, queueResults]);
			await rm(fixture.directory, { recursive: true, force: true });
		}
	});

	it("honors a preparation deadline while queued and recovers from failed startup", async () => {
		const fixture = await childFixture("for (;;) {}");
		const controller = new AbortController();
		const parser = new OfficeParser({ workerPath: fixture.workerPath });
		const running = parser.convert(Buffer.alloc(0), "docx", controller.signal);
		const settled = Promise.allSettled([running]);
		try {
			await vi.waitFor(async () =>
				expect(Number(await readFile(fixture.pidPath, "utf8"))).toBeGreaterThan(
					0,
				),
			);
			const pid = Number(await readFile(fixture.pidPath, "utf8"));
			await expect(
				parser.convert(Buffer.alloc(0), "docx", AbortSignal.timeout(25)),
			).rejects.toThrow();
			expect(Number(await readFile(fixture.pidPath, "utf8"))).toBe(pid);
			expect(() => process.kill(pid, 0)).not.toThrow();
			controller.abort();
			await settled;
			assertGone(pid);
			await rm(fixture.workerPath);
			await expect(parser.convert(Buffer.alloc(0), "xlsx")).rejects.toThrow();
			await writeFile(
				fixture.workerPath,
				`process.stdout.write(${validResult});`,
			);
			await expect(
				parser.convert(Buffer.alloc(0), "xlsx"),
			).resolves.toMatchObject({ markdown: "finished" });
		} finally {
			controller.abort();
			await settled;
			await rm(fixture.directory, { recursive: true, force: true });
		}
	});

	it.each([
		["deadline", "for (;;) {}", { timeoutMs: 3_000 }],
		[
			"V8 heap",
			'const rows = []; for (;;) rows.push(new Array(10000).fill("held"));',
			{ heapMb: 32 },
		],
		["output", 'process.stdout.write("x".repeat(35 * 1024 * 1024));', {}],
	])(
		"joins a child that exceeds the %s budget",
		async (_label, source, options) => {
			const fixture = await childFixture(source);
			const controller = new AbortController();
			const parser = new OfficeParser({
				workerPath: fixture.workerPath,
				...options,
			});
			const running = parser.convert(
				Buffer.alloc(0),
				"docx",
				controller.signal,
			);
			try {
				await expect(running).rejects.toThrow();
				assertGone(Number(await readFile(fixture.pidPath, "utf8")));
			} finally {
				controller.abort();
				await Promise.allSettled([running]);
				await rm(fixture.directory, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform === "linux")(
		"bounds native buffers outside the V8 heap",
		async () => {
			const fixture = await childFixture(
				"Buffer.alloc(1024 * 1024 * 1024); process.stdout.write(" +
					validResult +
					");",
			);
			try {
				await expect(
					new OfficeParser({ workerPath: fixture.workerPath }).convert(
						Buffer.alloc(0),
						"docx",
					),
				).rejects.toThrow();
				assertGone(Number(await readFile(fixture.pidPath, "utf8")));
			} finally {
				await rm(fixture.directory, { recursive: true, force: true });
			}
		},
	);

	it("rejects under-declared, corrupt and excessive-complexity documents and remains usable", async () => {
		const parser = new OfficeParser();
		const ordinary = docxDocument();
		const underDeclared = Buffer.from(ordinary);
		const header = underDeclared.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		underDeclared.writeUInt32LE(1, header + 24);
		const complex = new AdmZip(ordinary);
		complex.updateFile(
			"word/document.xml",
			Buffer.from(
				`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${"<w:smartTag>".repeat(30_000)}<w:p><w:r><w:t>Deep</w:t></w:r></w:p>${"</w:smartTag>".repeat(30_000)}</w:body></w:document>`,
			),
		);
		for (const bytes of [
			underDeclared,
			Buffer.from("not an archive"),
			complex.toBuffer(),
		]) {
			await expect(parser.convert(bytes, "docx")).rejects.toThrow();
		}
		const result = await parser.convert(ordinary, "docx");
		expect(result.markdown).toContain("# Doc heading");
		expect(result.markdown).toContain("body");
		expect(result.peakRssKb).toBeGreaterThan(0);
	});
});
