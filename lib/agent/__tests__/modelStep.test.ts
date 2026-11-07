import { expect, it } from "vitest";
import { MODEL_ROLES } from "@/lib/models";
import { classifyError } from "../errorClassifier";
import { productionModelStep } from "../modelStep";
import { modelFailureDiagnostics } from "../modelStepError";
import { respondWithObject, withResponsesPeer } from "./responsesPeer";

it.each([false, true])(
	"requires a provider completion signal (interrupted: %s)",
	async (interrupted) => {
		await withResponsesPeer(
			(_request, response) =>
				respondWithObject(response, "The app is ready.", { interrupted }),
			async (provider) => {
				const step = productionModelStep(
					provider(MODEL_ROLES.architect.modelId),
					"medium",
					"local-test",
				);
				const result = step({
					system: "Design the app.",
					messages: [{ role: "user", content: "Build a survey." }],
					tools: {},
					signal: new AbortController().signal,
				});
				if (interrupted)
					await expect(result).rejects.toThrow(
						"ended before completion (interrupted)",
					);
				else
					await expect(result).resolves.toMatchObject({
						text: "The app is ready.",
						finishReason: "stop",
						usage: { inputTokens: 11, outputTokens: 7 },
					});
			},
		);
	},
);

it.each([401, 429, 503])(
	"classifies the actual wrapped HTTP %s provider failure",
	async (status) => {
		await withResponsesPeer(
			(_request, response) => {
				response
					.writeHead(status, {
						"content-type": "application/json",
						"x-request-id": "request-123",
					})
					.end(
						JSON.stringify({
							error: {
								message: "Sorry, something went wrong.",
								type: "server_error",
							},
						}),
					);
			},
			async (provider) => {
				const step = productionModelStep(
					provider(MODEL_ROLES.architect.modelId),
					"medium",
					"local-test",
				);
				let failure: unknown;
				try {
					await step({
						system: "Design the app.",
						messages: [{ role: "user", content: "Build a survey." }],
						tools: {},
						signal: new AbortController().signal,
					});
				} catch (error) {
					failure = error;
				}
				expect(failure).toBeInstanceOf(Error);
				expect(modelFailureDiagnostics(failure)).toEqual({
					providerStatus: status,
					providerRequestId: "request-123",
				});
				expect(classifyError(failure).type).toBe(
					status === 401
						? "api_auth"
						: status === 429
							? "api_rate_limit"
							: "api_server",
				);
			},
		);
	},
);
