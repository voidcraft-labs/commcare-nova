import { v4 as uuid } from "uuid";

/** Receipt-backed operations may safely replay a lost response once. A
 * refusal is a response, so changing the expected revision after review
 * starts a new gesture. Both attempts use exactly the same scoped request. */
export async function sendLookupGesture<Result>(
	action: (projectId: string, input: unknown) => Promise<Result>,
	projectId: string,
	input: object,
	existingOperationId?: string,
): Promise<Result> {
	const request = { ...input, operationId: existingOperationId ?? uuid() };
	try {
		return await action(projectId, request);
	} catch {
		return action(projectId, request);
	}
}
