/** Lifecycle transport identifiers use the MCP surface's snake-case names.
 * App/read content stays in the shared authoring representation. */
export function projectWorkPayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const names: Record<string, string> = {
		workId: "work_id",
		appId: "app_id",
		projectId: "project_id",
		savedRevision: "saved_revision",
		pendingChanges: "pending_changes",
	};
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [names[key] ?? key, item]),
	);
}
