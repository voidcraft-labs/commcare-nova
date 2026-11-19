import {
	getGlobalDispatcher,
	type MockAgent,
	MockAgent as MockAgentClass,
	setGlobalDispatcher,
} from "undici";

/**
 * CommCare HQ's save counter for each working app a test's peer stands in
 * for, as `views/releases.py::current_app_version` serves it. Every save of a
 * working app adds one (`models/applications.py::ApplicationBase.save`), so
 * an import that updates an app answers the counter after its own save, a
 * create leaves a new app at 1 (`_import_app` saves the new document once),
 * and a test that stands for a save in HQ's editor calls `save`.
 */
export class HqSaveCounter {
	private readonly counts = new Map<string, number>();
	private readonly released = new Map<string, number>();

	/** The counter of `appId` now; 0 for an app no test step saved. */
	at(appId: string): number {
		return this.counts.get(appId) ?? 0;
	}

	/** One save of `appId`: answers the counter it leaves. */
	save(appId: string): number {
		const next = this.at(appId) + 1;
		this.counts.set(appId, next);
		return next;
	}

	/** The counter `appId` stands at, as HQ holds it before the test's first step. */
	standAt(appId: string, count: number): void {
		this.counts.set(appId, count);
	}

	/** A person builds `appId` at the counter it stands at and releases that build. */
	release(appId: string): number {
		const build = this.at(appId);
		this.released.set(appId, build);
		return build;
	}

	/** The build `appId` last released, which is also its latest build; null where none. */
	releasedBuild(appId: string): number | null {
		return this.released.get(appId) ?? null;
	}

	/** A create: HQ's one save of the new document leaves it at 1. */
	create(appId: string): void {
		this.counts.set(appId, 1);
	}

	reset(): void {
		this.counts.clear();
		this.released.clear();
	}
}

/** Whether a request path is an app's `current_version` read. */
export function isSaveCounterPath(path: string): boolean {
	return /^\/a\/[^/]+\/apps\/view\/[^/]+\/current_version\/$/.test(path);
}

function appIdOf(path: string): string {
	const segments = path.split("/");
	return decodeURIComponent(segments[segments.length - 3] ?? "");
}

/**
 * The peer `withHttpPeer` gives (real fetch, every destination but the one
 * named refused), with every app's `current_version` answered from
 * `counter` at the moment it is asked. That standing answer is no
 * expectation, so a run that never reads a counter leaves nothing pending;
 * every other interceptor the run adds must still be used.
 */
export async function withHqPeer<T>(
	counter: HqSaveCounter,
	origin: string,
	run: (peer: MockAgent) => Promise<T>,
): Promise<T> {
	const previous = getGlobalDispatcher();
	const peer = new MockAgentClass({ enableCallHistory: true });
	peer.disableNetConnect();
	setGlobalDispatcher(peer);
	try {
		peer
			.get(origin)
			.intercept({ path: isSaveCounterPath, method: "GET" })
			.reply((opts) => {
				const appId = appIdOf(opts.path);
				const build = counter.releasedBuild(appId);
				return {
					statusCode: 200,
					data: JSON.stringify({
						currentVersion: counter.at(appId),
						latestBuild: build,
						latestReleasedBuild: build,
					}),
				};
			})
			.persist();
		const result = await run(peer);
		const pending = peer
			.pendingInterceptors()
			.filter((dispatch) => dispatch.path !== isSaveCounterPath);
		if (pending.length > 0) {
			throw new Error(
				`${pending.length} interceptor(s) the test added were never used: ${pending
					.map((dispatch) => `${dispatch.method} ${String(dispatch.path)}`)
					.join(", ")}`,
			);
		}
		return result;
	} finally {
		setGlobalDispatcher(previous);
		await peer.close();
	}
}
