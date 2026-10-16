import { describe, expect, it } from "vitest";
import type { DeploymentView } from "@/lib/deployment/actions";
import {
	createPublishingRecordsStore,
	type DeploymentsRead,
} from "../publishingRecordsStore";

type Outcome = Awaited<ReturnType<DeploymentsRead>>;

/** A read the test answers by hand, counting the reads it was asked for. */
function controlledRead() {
	const pending: Array<{
		appId: string;
		settle: (outcome: Outcome) => void;
		fail: (reason: unknown) => void;
	}> = [];
	const read: DeploymentsRead = (appId) =>
		new Promise((resolve, reject) => {
			pending.push({ appId, settle: resolve, fail: reject });
		});
	return { read, pending };
}

const VIEWS = [{ deployment: {} }] as unknown as readonly DeploymentView[];
const FAILED = "Nova couldn't load where this app has been published.";

/** Let the settled read's continuation run. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the shared publishing records", () => {
	it("reads once per revision for every surface subscribed to an app", async () => {
		const { read, pending } = controlledRead();
		const store = createPublishingRecordsStore(read, FAILED);
		let notified = 0;
		const unsubscribe = [
			store.subscribe("app-1", () => notified++),
			store.subscribe("app-1", () => notified++),
		];
		try {
			store.ensureLoaded("app-1", 0);
			store.ensureLoaded("app-1", 0);
			expect(pending).toHaveLength(1);
			expect(store.snapshot("app-1").pending).toBe(true);

			pending[0]?.settle({ ok: true, views: VIEWS });
			await settled();
			expect(store.snapshot("app-1")).toMatchObject({
				pending: false,
				views: VIEWS,
				failure: null,
			});
			expect(notified).toBeGreaterThan(0);

			store.ensureLoaded("app-1", 1);
			expect(pending).toHaveLength(2);
			pending[1]?.settle({ ok: true, views: [] });
			await settled();
			expect(store.snapshot("app-1").views).toEqual([]);
		} finally {
			for (const stop of unsubscribe) stop();
		}
	});

	it("keeps a rejected read's failure in the records, beside the views it held", async () => {
		const { read, pending } = controlledRead();
		const store = createPublishingRecordsStore(read, FAILED);
		const unsubscribe = store.subscribe("app-1", () => {});
		try {
			store.ensureLoaded("app-1", 0);
			pending[0]?.settle({ ok: true, views: VIEWS });
			await settled();
			store.reload("app-1");
			pending[1]?.fail(new Error("network"));
			await settled();
			expect(store.snapshot("app-1")).toMatchObject({
				pending: false,
				views: VIEWS,
				failure: FAILED,
			});
		} finally {
			unsubscribe();
		}
	});

	it("drops a read an upsert superseded, and forgets an app nobody holds", async () => {
		const { read, pending } = controlledRead();
		const store = createPublishingRecordsStore(read, FAILED);
		const unsubscribe = store.subscribe("app-1", () => {});
		const fresh = {
			deployment: { deployment: {} },
		} as unknown as DeploymentView;
		try {
			store.ensureLoaded("app-1", 0);
			store.upsert("app-1", fresh);
			pending[0]?.settle({ ok: true, views: [] });
			await settled();
			expect(store.snapshot("app-1").views).toEqual([fresh]);
		} finally {
			unsubscribe();
		}
		/* With no subscriber the held copy goes, so the next surface reads
		 * afresh. */
		expect(store.snapshot("app-1").views).toBeNull();
		const again = store.subscribe("app-1", () => {});
		try {
			store.ensureLoaded("app-1", 0);
			expect(pending).toHaveLength(2);
			pending[1]?.settle({ ok: true, views: [] });
			await settled();
		} finally {
			again();
		}
	});
});
