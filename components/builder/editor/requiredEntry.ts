import type { Field } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { RequiredEditor } from "./fields/RequiredEditor";
import { ALWAYS_REQUIRED_EXPRESSION } from "./fields/requiredState";

/** The required property is born enabled when its Add pill is selected. */
export function requiredEntry<F extends Field & { required?: Expression }>(): {
	key: "required";
	component: typeof RequiredEditor;
	label: string;
	addable: true;
	visible: (field: F) => boolean;
	valueOnAdd: F["required"];
} {
	return {
		key: "required",
		component: RequiredEditor,
		label: "Required",
		addable: true,
		visible: (field) => !!field.required,
		valueOnAdd: ALWAYS_REQUIRED_EXPRESSION as F["required"],
	};
}
