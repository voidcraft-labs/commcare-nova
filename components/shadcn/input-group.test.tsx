// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	InputGroup,
	InputGroupInput,
	InputGroupTextarea,
} from "@/components/shadcn/input-group";

describe("InputGroup focus treatment", () => {
	it("leaves the single focus ring on the group wrapper", () => {
		render(
			<>
				<InputGroup data-testid="text-group">
					<InputGroupInput aria-label="Name" />
				</InputGroup>
				<InputGroup data-testid="message-group">
					<InputGroupTextarea aria-label="Message" />
				</InputGroup>
			</>,
		);

		expect(
			screen
				.getByTestId("text-group")
				.classList.contains("nova-focusable-within"),
		).toBe(true);
		expect(
			screen
				.getByTestId("message-group")
				.classList.contains("nova-focusable-within"),
		).toBe(true);
		expect(
			screen
				.getByRole("textbox", { name: "Name" })
				.classList.contains("nova-focusable"),
		).toBe(false);
		expect(
			screen
				.getByRole("textbox", { name: "Message" })
				.classList.contains("nova-focusable"),
		).toBe(false);
	});
});
