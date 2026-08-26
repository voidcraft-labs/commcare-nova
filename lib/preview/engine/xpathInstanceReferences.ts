import { parser } from "@/lib/commcare/xpath";
import { pathInitializerStringArgument } from "@/lib/commcare/xpath/functionCapabilities";

/** Whether an XPath expression structurally invokes instance() for an exact
 * secondary-instance id. String contents and similarly named functions do not
 * count as references. */
export function xpathReferencesInstance(
	source: string,
	instanceId: string,
): boolean {
	const tree = parser.parse(source);
	let found = false;
	tree.iterate({
		enter(cursor) {
			if (found || cursor.type.name !== "Invoke") return;
			const nameNode = cursor.node.getChild("FunctionName");
			if (
				nameNode !== null &&
				source.slice(nameNode.from, nameNode.to) === "instance" &&
				pathInitializerStringArgument(cursor.node, source) === instanceId
			) {
				found = true;
			}
		},
	});
	return found;
}

/** Whether an authored structural hashtag needs the device casedb snapshot.
 * `#form/*` is backed by the main instance; every other admitted hashtag
 * (`#<case-type>/*` and `#user/*`) is a casedb nodeset projection. Parse the
 * token rather than scanning text so quoted examples do not trigger a load. */
export function xpathReferencesCaseDatabaseHashtag(source: string): boolean {
	const tree = parser.parse(source);
	let found = false;
	tree.iterate({
		enter(cursor) {
			if (found || cursor.type.name !== "HashtagRef") return;
			found = !source.slice(cursor.from, cursor.to).startsWith("#form/");
		},
	});
	return found;
}
