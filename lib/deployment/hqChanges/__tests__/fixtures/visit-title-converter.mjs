export const sourceRevision = "1".repeat(40);

export function convert({ visitTitle, ...rest }, { prefix }, { projectId }) {
	if (typeof visitTitle !== "string" || projectId !== "clinic-project")
		throw new Error("Expected this Project's old document.");
	return { ...rest, appName: prefix + visitTitle };
}
