import { expect, it } from "vitest";
import { MODEL_ROLES } from "@/lib/models";
import { productionModelStep } from "../modelStep";
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
