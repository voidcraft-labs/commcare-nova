// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "../alert-dialog";
import { Button } from "../button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../dialog";
import { Popover, PopoverContent } from "../popover";
import { PortaledContentDirectionProvider } from "../portaled-content-direction";

const LONG_NAME =
	"ThisIsAnAuthoredNameWithNoNaturalBreakThatMustNeverForceTheDialogOutsideTheViewport";

async function settleBaseUiMount(): Promise<void> {
	await act(async () => {
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
}

describe("dialog viewport containment", () => {
	it("carries the worker-content direction into dialog and popover portals", async () => {
		render(
			<PortaledContentDirectionProvider direction="rtl">
				<Dialog open>
					<DialogContent showCloseButton={false}>
						<DialogTitle>تفاصيل</DialogTitle>
					</DialogContent>
				</Dialog>
				<Popover open>
					<PopoverContent>التاريخ</PopoverContent>
				</Popover>
			</PortaledContentDirectionProvider>,
		);
		await settleBaseUiMount();

		expect(
			document
				.querySelector('[data-slot="dialog-content"]')
				?.getAttribute("dir"),
		).toBe("rtl");
		expect(
			document
				.querySelector('[data-slot="popover-content"]')
				?.getAttribute("dir"),
		).toBe("rtl");
	});

	it("wraps authored alert copy and keeps actions in one horizontal row", async () => {
		render(
			<AlertDialog open>
				<AlertDialogContent>
					<AlertDialogTitle>{LONG_NAME}</AlertDialogTitle>
					<AlertDialogDescription>{LONG_NAME}</AlertDialogDescription>
					<AlertDialogFooter>
						<button type="button">Cancel</button>
						<button type="button">Delete</button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>,
		);
		await settleBaseUiMount();

		const content = document.querySelector<HTMLElement>(
			'[data-slot="alert-dialog-content"]',
		);
		expect(content?.className).toContain("overflow-x-hidden");
		for (const node of screen.getAllByText(LONG_NAME)) {
			expect(node.className).toContain("break-words");
			expect(node.className).toContain("[overflow-wrap:anywhere]");
		}
		const footer = document.querySelector<HTMLElement>(
			'[data-slot="alert-dialog-footer"]',
		);
		expect(footer?.className).toContain("flex-row");
		expect(footer?.className).not.toContain("flex-col");
	});

	it("contains long ordinary dialog copy without horizontal scrolling", async () => {
		render(
			<Dialog open>
				<DialogContent showCloseButton={false}>
					<DialogTitle>{LONG_NAME}</DialogTitle>
					<DialogDescription>{LONG_NAME}</DialogDescription>
				</DialogContent>
			</Dialog>,
		);
		await settleBaseUiMount();

		const content = document.querySelector<HTMLElement>(
			'[data-slot="dialog-content"]',
		);
		expect(content?.className).toContain("overflow-x-hidden");
		for (const node of screen.getAllByText(LONG_NAME)) {
			expect(node.className).toContain("break-words");
			expect(node.className).toContain("[overflow-wrap:anywhere]");
		}
	});

	it("reserves the close button's space for a wrapping dialog title", async () => {
		render(
			<Dialog open>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{LONG_NAME}</DialogTitle>
					</DialogHeader>
				</DialogContent>
			</Dialog>,
		);
		await settleBaseUiMount();

		const header = document.querySelector<HTMLElement>(
			'[data-slot="dialog-header"]',
		);
		expect(header?.className).toContain(
			"group-has-data-[slot=dialog-close]/dialog-content:pr-11",
		);
		expect(screen.getByRole("button", { name: "Close" }).className).toContain(
			"size-11",
		);
	});

	it("gives rendered cancel actions the same 44px target as primary actions", async () => {
		render(
			<Dialog open>
				<DialogContent showCloseButton={false}>
					<DialogTitle>Choose a connection</DialogTitle>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button>Use connection</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>,
		);
		await settleBaseUiMount();

		/* The 44px floor lives on the Button itself now: every rendered
		 *  footer action is the one 44px control. */
		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect(cancel.className).toContain("h-11");
		const primary = screen.getByRole("button", { name: "Use connection" });
		expect(primary.className).toContain("h-11");
	});
});
