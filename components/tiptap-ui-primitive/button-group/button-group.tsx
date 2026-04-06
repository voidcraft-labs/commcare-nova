import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { Separator } from "@/components/tiptap-ui-primitive/separator";
import { cn } from "@/lib/tiptap-utils";
import "./button-group.css";

const buttonGroupVariants = cva("tiptap-button-group", {
	variants: {
		orientation: {
			horizontal: "tiptap-button-group-horizontal",
			vertical: "tiptap-button-group-vertical",
		},
	},
	defaultVariants: {
		orientation: "horizontal",
	},
});

/**
 * Semantic grouping for toolbar buttons. Uses `<fieldset>` instead of
 * `<div role="group">` so assistive technology gets native group semantics
 * without an ARIA role override.
 */
function ButtonGroup({
	className,
	orientation,
	...props
}: React.ComponentProps<"fieldset"> &
	VariantProps<typeof buttonGroupVariants>) {
	return (
		<fieldset
			data-slot="tiptap-button-group"
			data-orientation={orientation}
			className={cn(buttonGroupVariants({ orientation }), className)}
			{...props}
		/>
	);
}

function ButtonGroupText({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">) {
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{ className: cn("tiptap-button-group-text", className) },
			props,
		),
		render,
		state: { slot: "tiptap-button-group-text" },
	});
}

function ButtonGroupSeparator({
	className,
	orientation = "vertical",
	...props
}: React.ComponentProps<typeof Separator>) {
	return (
		<Separator
			data-slot="tiptap-button-group-separator"
			orientation={orientation}
			className={cn("tiptap-button-group-separator", className)}
			{...props}
		/>
	);
}

export {
	ButtonGroup,
	ButtonGroupSeparator,
	ButtonGroupText,
	buttonGroupVariants,
};
