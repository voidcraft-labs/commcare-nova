import { startSpan } from "@sentry/nextjs";

type AuthoringStoreOperation =
	| "loadChangeSet"
	| "loadChangeSetSteps"
	| "authorizeChangeSet"
	| "stageChangeSetRequest";

/** Fixed source names locate filtered SQL without collecting work content. */
export function traceAuthoringStoreOperation<T>(
	operation: AuthoringStoreOperation,
	body: () => Promise<T>,
): Promise<T> {
	return startSpan(
		{
			name: `authoring.store.${operation}`,
			op: "authoring.store",
			attributes: {
				"code.file.path": "lib/agent/change-set/store.ts",
				"code.function.name": operation,
			},
		},
		body,
	);
}
