import type { Worker } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";
import type {} from "../lib/preview-xpath-worker-client";

test("Preview executes its built worker and lazy Java character table, terminates blocked work and opens a fresh generation", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-xpath-worker-client.ts");
	const workers: Worker[] = [];
	const closed = new Set<Worker>();
	const recordClosed = (worker: Worker) => {
		closed.add(worker);
	};
	const recordWorker = (worker: Worker) => {
		workers.push(worker);
		worker.on("close", recordClosed);
	};
	page.on("worker", recordWorker);
	try {
		await page.goto(peer.origin);
		await page.waitForFunction(() => window.previewXPathAudit !== undefined);
		const warm = await page.evaluate(() =>
			window.previewXPathAudit.run("regex('aaaa', '(a|aa)+$')"),
		);
		expect(warm).toMatchObject({ ok: true, value: true });
		const firstWorker = workers[0];
		if (firstWorker === undefined) throw new Error("Worker did not start");
		expect(firstWorker.url()).toContain("/xpath-worker/xpath-worker.js");
		expect(
			await page.evaluate(() =>
				window.previewXPathAudit.run(
					String.raw`regex('a', '\N{LATIN SMALL LETTER A}')`,
				),
			),
		).toMatchObject({ ok: true, value: true });
		// This intentional yield outlives the 50 ms CPU watchdog. Only the actual
		// worker's pause/resume protocol can keep it alive while the timer runs.
		expect(
			await page.evaluate(() =>
				window.previewXPathAudit.run("sleep(100, 'yielded')", 50),
			),
		).toMatchObject({ ok: true, value: "yielded" });
		expect(
			await page.evaluate(() =>
				window.previewXPathAudit.run(
					`regex('${"a".repeat(10000)}b', '(a+)+$')`,
					50,
				),
			),
		).toMatchObject({ ok: false, error: { code: "timeout" } });
		await expect.poll(() => closed.has(firstWorker)).toBe(true);
		expect(
			await page.evaluate(() => window.previewXPathAudit.run("6 * 7")),
		).toMatchObject({ ok: true, value: 42 });
		const replacement = workers[1];
		if (replacement === undefined)
			throw new Error("Replacement worker did not start");
		await page.evaluate(() => window.previewXPathAudit.startSleep());
		expect(
			await page.evaluate(() => window.previewXPathAudit.cancelSleep()),
		).toMatchObject({ ok: false, error: { code: "cancelled" } });
		await expect.poll(() => closed.has(replacement)).toBe(true);
		expect(
			await page.evaluate(() =>
				window.previewXPathAudit.run("'after cancellation'"),
			),
		).toMatchObject({ ok: true, value: "after cancellation" });
	} finally {
		page.off("worker", recordWorker);
		for (const worker of workers) worker.off("close", recordClosed);
		try {
			await page.evaluate(async () => {
				await window.previewXPathAudit?.dispose();
			});
		} finally {
			try {
				await page.goto("about:blank");
			} finally {
				await peer.close();
			}
		}
	}
});
