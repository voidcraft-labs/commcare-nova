/**
 * The form reader's claims: one for each claim a form's source is read under,
 * named by its entry's id less the area, followed by `@` and the surface key
 * where one entry is claimed under several keys. Every member is registered
 * with `defineClaims("xform", …)`, so `claimsBindManifest.test.ts` holds each
 * to the manifest.
 */

import {
	account,
	type Claim,
	type ClaimUse,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";

const MAKERS: {
	readonly [U in ClaimUse]: (entry: string, key: string | null) => Claim<U>;
} = {
	take,
	derived,
	drop,
	refuse,
	account,
};

/**
 * One entry's claims under several surface keys, one per site of a question
 * (its data node, its control, the control's `ref`, the bind's `type`),
 * registered as `<entry less its area>@<key>`.
 */
function under<U extends ClaimUse, const S extends string>(
	use: U,
	entry: string,
	keys: Readonly<Record<S, string | null>>,
): Readonly<Record<S, Claim<U>>> {
	const short = entry.slice(entry.indexOf("/") + 1);
	const sites = {} as Record<S, Claim<U>>;
	const named: Record<string, Claim> = {};
	for (const site of Object.keys(keys) as S[]) {
		const key = keys[site];
		const one = MAKERS[use](entry, key);
		sites[site] = one;
		const name = `${short}@${key ?? site}`;
		named[Object.hasOwn(named, name) ? `${name}/${site}` : name] = one;
	}
	defineClaims("xform", named);
	return sites;
}

/** One claim of one entry, registered under the entry's id less its area. */
function one<U extends ClaimUse>(
	use: U,
	entry: string,
	key: string | null,
): Claim<U> {
	const claim = MAKERS[use](entry, key);
	defineClaims("xform", { [entry.slice(entry.indexOf("/") + 1)]: claim });
	return claim;
}

const Q = (id: string) => `questions/${id}`;

/** The sites of a question a kind row claims: its data node, its control, the control's `ref`
 *  and the bind's `type`. */
export interface KindSites {
	readonly node: Claim<"take">;
	readonly control?: Claim<"take">;
	readonly ref?: Claim<"take">;
	readonly type?: Claim<"take">;
	/** An upload's `mediatype`. */
	readonly mediatype?: Claim<"take">;
	/** The kind's own appearance token. */
	readonly appearance?: Claim<"take">;
}

function kind(
	id: string,
	keys: {
		readonly node: string;
		readonly control?: string;
		readonly ref?: string;
		readonly type?: string;
		readonly mediatype?: string;
		readonly appearance?: string;
	},
): KindSites {
	const present = Object.fromEntries(
		Object.entries(keys).filter(([, key]) => key !== undefined),
	) as Record<string, string>;
	return under("take", Q(id), present) as unknown as KindSites;
}

/** The controls that hold a label, a hint, a help text and an alert. */
export const TEXT_CONTROLS = [
	"input",
	"secret",
	"select",
	"select1",
	"trigger",
	"upload",
] as const;
export type TextControl = (typeof TEXT_CONTROLS)[number];
type TextChild = "label" | "hint" | "help" | "alert";

/** A text child's element on each control, by the control's tag. */
function elementKeys(child: TextChild): Record<TextControl, string> {
	return Object.fromEntries(
		TEXT_CONTROLS.map((tag) => [tag, `xform:${tag}/${child}`]),
	) as Record<TextControl, string>;
}

/** A text child's element and its `ref` on each control: `<tag>` and `<tag>Ref`. */
function slotKeys(
	child: TextChild,
): Record<TextControl | `${TextControl}Ref`, string> {
	return Object.fromEntries(
		TEXT_CONTROLS.flatMap((tag) => [
			[tag, `xform:${tag}/${child}`],
			[`${tag}Ref`, `xform:${tag}/${child}@ref`],
		]),
	) as Record<TextControl | `${TextControl}Ref`, string>;
}

const CHOICE_LABEL_KEYS = {
	select1: "xform:select1/item/label",
	select1Ref: "xform:select1/item/label@ref",
	select: "xform:select/item/label",
	selectRef: "xform:select/item/label@ref",
} as const;

/** One entry's claims on an itext value of each media form, by Core's key for the form. */
function mediaClaims<U extends ClaimUse>(
	use: U,
	entry: string,
): Readonly<Record<"image" | "audio" | "video", Claim<U>>> {
	return under(use, entry, {
		image: "itext-form:core/image",
		audio: "itext-form:core/audio",
		video: "itext-form:core/video",
	});
}

const INPUT = {
	control: "xform:input",
	ref: "xform:input@ref",
	type: "xform:model/bind@type",
} as const;

export const X = {
	// ── The frame of a form's source (8.2) ──────────────────────────────
	frame: under(
		"derived",
		"application-and-settings/attachments-form-unique-id-xml",
		{
			model: "jr-control:model",
			dataRoot: "xform:model/instance/*",
		},
	),
	blankSource: one(
		"refuse",
		"forms-and-case-writes/blank-source-or-no-non-group-question",
		"schema:Application._attachments",
	),
	doctype: one(
		"refuse",
		Q("dtd-declared-entity-references-predefined-ones-such-as-amp-are"),
		null,
	),
	ignoreMarkdown: one(
		"take",
		Q("vellum-ignore-containing-markdown-on-h-html-vellum-s-disable"),
		"vellum-markup:h:html@vellum:ignore",
	),
	ignoreRichText: one(
		"drop",
		Q("vellum-ignore-containing-richtext"),
		"vellum-markup:h:html@vellum:ignore",
	),
	ignoreRetain: one(
		"refuse",
		Q("content-marked-vellum-ignore-retain-vellum-ignored"),
		"mug:Ignored",
	),
	title: under("take", Q("h-title-and-data-name-whatever-their-text"), {
		title: "xform:title",
	}),
	// The same entry as `title`, under a second use and key: registered by that key.
	dataName: under("derived", Q("h-title-and-data-name-whatever-their-text"), {
		name: "xform:model/instance/*@name",
	}).name,
	uiVersionOne: one(
		"derived",
		Q("data-root-uiversion-of-1"),
		"xform:model/instance/*@uiVersion",
	),
	uiVersionOther: one(
		"refuse",
		Q("data-root-uiversion-other-than-1-or-absent"),
		"xform:model/instance/*",
	),
	dataVersion: one(
		"drop",
		Q("data-root-version"),
		"xform:model/instance/*@version",
	),
	dataXmlns: one(
		"take",
		"forms-and-case-writes/xmlns-form-json-and-xform-data-node",
		"xform:model/instance/*@xmlns",
	),
	dataRootAttribute: under(
		"refuse",
		Q("data-root-attributes-other-than-uiversion-version-and-name-and"),
		{
			"jr:template": "xform:model/instance/*@jr:template",
			"jr:modeltype": "xform:model/instance/*@jr:modeltype",
			"jr:recordset": "xform:model/instance/*@jr:recordset",
			src: "xform:model/instance/*@src",
		},
	),
	rootNotData: one(
		"refuse",
		Q("data-root-element-named-other-than-data"),
		"xform:model/instance/*",
	),
	hashtags: under("drop", Q("vellum-hashtags-vellum-hashtagtransforms"), {
		hashtags: "vellum-markup:h:head/vellum:hashtags",
		transforms: "vellum-markup:h:head/vellum:hashtagTransforms",
	}),
	odkxIntentUnreferenced: one(
		"drop",
		Q("odkx-intent-that-no-question-references"),
		"jr-control:intent",
	),
	headDispatched: one(
		"refuse",
		Q("other-h-head-children-whose-local-name-or-a-descendant-s-core-or"),
		"jr-control:model",
	),
	headOther: one(
		"drop",
		Q("h-head-children-other-than-hq-s-own-h-title-model-odkx-intent"),
		null,
	),
	sendSubmission: one("refuse", Q("send-submission"), "jr-action:send"),
	submissionAccepted: one(
		"drop",
		Q("a-submission-core-accepts-with-no-send-naming-it"),
		"xform:model/submission",
	),
	submissionRefused: one(
		"refuse",
		Q("a-submission-core-s-parser-refuses-missing-any-of-id-resource"),
		"xform:model/submission",
	),
	pollsensor: one(
		"refuse",
		Q("authored-orx-pollsensor"),
		"jr-action:pollsensor",
	),
	modelXformsChild: one(
		"refuse",
		Q("unknown-xforms-namespace-model-children-text-in-model"),
		"xform:model/*",
	),
	modelForeignNamed: one(
		"refuse",
		Q("unknown-namespace-model-children-named-itext-instance-bind"),
		"jr-action:setvalue",
	),
	modelForeignOther: one(
		"drop",
		Q("other-unknown-model-children-non-xforms-namespace-whose-local"),
		"xform:model/*",
	),
	secondPrimaryInstance: one(
		"refuse",
		"expressions-and-data/more-than-one-instance-without-an-id",
		"xform:model/instance",
	),
	inlineInstance: one(
		"refuse",
		"expressions-and-data/inline-instance-content-inside-instance-no-src",
		"xform:model/instance@id",
	),

	// ── The data tree, binds and secondary instances (8.3) ──────────────
	siblingsOfOneName: one(
		"refuse",
		Q("two-sibling-data-nodes-with-one-name"),
		"xform:model/instance//*",
	),
	authoredMeta: one(
		"refuse",
		Q("authored-data-meta-block"),
		"xform:model/instance/*/*",
	),
	questionIdGrammar: one(
		"refuse",
		Q("question-id-failing-the-grammar-or-meta-in-any-case"),
		"xform:model/instance//*",
	),
	questionIdReserved: one(
		"refuse",
		Q("question-id-case-registration-script"),
		"xform:model/instance//*",
	),
	vellumComment: one(
		"drop",
		Q("vellum-comment"),
		"vellum-markup:model/instance//*@vellum:comment",
	),
	vellumLock: under("refuse", Q("vellum-lock-all-locked-question"), {
		node: "vellum-markup:model/instance//*@vellum:lock",
		bind: "vellum-markup:bind@vellum:lock",
	}),
	dataNodeXmlns: one(
		"refuse",
		Q("data-node-xmlns-on-a-hidden-value"),
		"xform:model/instance//*@xmlns",
	),
	defaultDataValue: one(
		"refuse",
		Q("default-data-value-datavalue-instance-text"),
		"xform:model/instance//*",
	),
	connectWorkAreaUpdate: one(
		"refuse",
		Q("connect-work-area-update"),
		"mug:ConnectWorkAreaUpdate",
	),
	bindNoNode: one(
		"drop",
		Q("bind-whose-nodeset-matches-no-node"),
		"xform:model/bind@nodeset",
	),
	bindOnDataRoot: one(
		"refuse",
		Q("bind-whose-path-names-the-data-root-itself-data-data-or-a"),
		"xform:model/bind@nodeset",
	),
	bindAttributePath: one(
		"refuse",
		Q("bind-on-an-attribute-path-not-owned-by-a-plugin-savetocase-model"),
		"xform:model/bind@nodeset",
	),
	bind: under("take", Q("bind-nodeset-absolute-or-relative"), {
		nodeset: "xform:model/bind@nodeset",
	}),
	bindElement: under("derived", Q("bind-nodeset-absolute-or-relative"), {
		element: "xform:model/bind",
	}),
	bindPreload: under("drop", Q("jr-preload-jr-preloadparams"), {
		preload: "xform:model/bind@jr:preload",
		preloadParams: "xform:model/bind@jr:preloadParams",
	}),

	// ── The body (8.4) and the join (8.5) ────────────────────────────────
	unknownControl: one(
		"refuse",
		Q("unknown-body-control-vellum-readonly-e-g-range"),
		"mug:ReadOnly",
	),
	bareRepeat: one(
		"refuse",
		Q("bare-repeat-with-no-group-wrapper"),
		"mug:ReadOnly",
	),
	readonlyInput: one(
		"refuse",
		Q("input-readonly-true-control-attribute"),
		"jr-control:input",
	),
	reflessTrigger: one("refuse", Q("ref-less-trigger"), "xform:trigger"),
	bindIdPath: under(
		"take",
		Q("bind-id-with-control-bind-where-the-id-is-the-node-s-path"),
		{
			id: "xform:model/bind@id",
			input: "xform:input@bind",
			secret: "xform:secret@bind",
			select: "xform:select@bind",
			select1: "xform:select1@bind",
			trigger: "xform:trigger@bind",
			upload: "xform:upload@bind",
			group: "xform:group@bind",
			repeat: "xform:repeat@bind",
		},
	),
	bindIdOther: under(
		"refuse",
		Q("any-other-bind-id-named-by-a-control-s-bind"),
		{
			id: "xform:model/bind@id",
			input: "xform:input@bind",
			secret: "xform:secret@bind",
			select: "xform:select@bind",
			select1: "xform:select1@bind",
			trigger: "xform:trigger@bind",
			upload: "xform:upload@bind",
			group: "xform:group@bind",
			repeat: "xform:repeat@bind",
		},
	),
	controlNoNode: one(
		"refuse",
		Q("a-control-whose-ref-names-no-node"),
		"xform:input@ref",
	),
	hiddenWithChildren: one(
		"refuse",
		Q("hidden-value-with-children"),
		"xform:model/instance//*",
	),
	questionWithChildren: one(
		"refuse",
		Q("a-question-other-than-a-group-or-repeat-whose-data-node-has"),
		"xform:model/instance//*",
	),
	dataParentOtherGroup: one(
		"refuse",
		Q("data-parent-data-node-under-another-group-than-its-control"),
		"xform:input@ref",
	),
	dataParentCrossingRepeat: one(
		"refuse",
		Q("data-parent-crossing-a-repeat"),
		"xform:group@ref",
	),

	// ── Field kinds (9.1) ────────────────────────────────────────────────
	kind: {
		text: kind("text-input-xsd-string", { node: "mug:Text", ...INPUT }),
		phone: kind("phone-number-xsd-string-appearance-numeric", {
			node: "mug:PhoneNumber",
			...INPUT,
			appearance: "appearance:web-apps/numeric",
		}),
		untypedText: kind(
			"an-input-whose-bind-has-no-type-any-appearance-but-numeric-or",
			{ node: "mug:Text", control: INPUT.control, ref: INPUT.ref },
		),
		int: kind("integer-xsd-int-xsd-integer-read-as-the-same", {
			node: "mug:Int",
			...INPUT,
		}),
		decimal: kind("decimal-xsd-double", { node: "mug:Double", ...INPUT }),
		date: kind("date-xsd-date", { node: "mug:Date", ...INPUT }),
		time: kind("time-xsd-time", { node: "mug:Time", ...INPUT }),
		datetime: kind("date-and-time-xsd-datetime", {
			node: "mug:DateTime",
			...INPUT,
		}),
		geopoint: kind("gps-geopoint", { node: "mug:Geopoint", ...INPUT }),
		barcode: kind("barcode-barcode", { node: "mug:Barcode", ...INPUT }),
		secret: kind("password-secret-xsd-string", {
			node: "mug:Secret",
			control: "xform:secret",
			ref: "xform:secret@ref",
			type: "xform:model/bind@type",
		}),
		untypedSecret: kind(
			"a-secret-whose-bind-has-no-type-any-appearance-but-numeric-or",
			{ node: "mug:Secret", control: "xform:secret", ref: "xform:secret@ref" },
		),
		singleSelect: kind("multiple-choice-select1-item", {
			node: "mug:Select",
			control: "xform:select1",
			ref: "xform:select1@ref",
		}),
		multiSelect: kind("checkbox-select-item", {
			node: "mug:MSelect",
			control: "xform:select",
			ref: "xform:select@ref",
		}),
		label: kind("label-trigger-whose-appearance-is-exactly-minimal", {
			node: "mug:Trigger",
			control: "xform:trigger",
			ref: "xform:trigger@ref",
			appearance: "xform:trigger@appearance",
		}),
		image: kind("image-capture-upload-image", {
			node: "mug:Image",
			control: "xform:upload",
			ref: "xform:upload@ref",
			mediatype: "xform:upload@mediatype",
		}),
		signature: kind("signature-image-signature", {
			node: "mug:Signature",
			control: "xform:upload",
			ref: "xform:upload@ref",
			mediatype: "xform:upload@mediatype",
			appearance: "xform:upload@appearance",
		}),
		audio: kind("audio-capture-audio", {
			node: "mug:Audio",
			control: "xform:upload",
			ref: "xform:upload@ref",
			mediatype: "xform:upload@mediatype",
		}),
		video: kind("video-capture-video", {
			node: "mug:Video",
			control: "xform:upload",
			ref: "xform:upload@ref",
			mediatype: "xform:upload@mediatype",
		}),
		file: kind("document-upload-application-text", {
			node: "mug:Document",
			control: "xform:upload",
			ref: "xform:upload@ref",
			mediatype: "xform:upload@mediatype",
		}),
		hiddenOneSource: kind(
			"hidden-value-data-node-bind-no-control-with-calculate-or-default",
			{ node: "mug:DataBindOnly", type: "mug:DataBindOnly" },
		),
		hiddenNeither: kind("hidden-value-with-neither", {
			node: "mug:DataBindOnly",
			type: "mug:DataBindOnly",
		}),
	},
	selectType: one(
		"take",
		Q("select-bind-type-xsd-string-or-a-choice-type-matching-the"),
		"xform:model/bind@type",
	),
	binaryType: one(
		"take",
		Q("binary-bind-type-on-an-upload"),
		"xform:model/bind@type",
	),
	hiddenDatetimeType: one(
		"take",
		Q("hidden-value-bound-xsd-datetime"),
		"xform:model/bind@type",
	),
	choice: {
		single: under("take", Q("multiple-choice-select1-item"), {
			item: "xform:select1/item",
			value: "xform:select1/item/value",
		}),
		multi: under("take", Q("checkbox-select-item"), {
			item: "xform:select/item",
			value: "xform:select/item/value",
		}),
	},
	/** The refusing rows of 9.1, each one claim over every site of the question. */
	refusedKind: {
		untypedTextNumeric: one(
			"refuse",
			Q("an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring"),
			"mug:Text",
		),
		long: one("refuse", Q("long-xsd-long"), "mug:Long"),
		intent: one(
			"refuse",
			Q("android-app-callout-input-appearance-intent-id-bind-type-intent"),
			"mug:AndroidIntent",
		),
		inputOtherType: one(
			"refuse",
			Q("input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd"),
			"mug:Text",
		),
		untypedSecretNumeric: one(
			"refuse",
			Q("a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring"),
			"mug:Secret",
		),
		secretNumericType: one(
			"refuse",
			Q("secret-with-a-numeric-bind-type"),
			"jr-type:int",
		),
		contradictingChoiceType: one(
			"refuse",
			Q("a-choice-bind-type-contradicting-the-control-listitem-select1-on"),
			"jr-type:listItem",
		),
		selectOtherType: one(
			"refuse",
			Q("a-select-whose-bind-type-is-neither-a-choice-type-nor-a-string"),
			"jr-type:int",
		),
		acknowledgeLabel: one(
			"refuse",
			Q("acknowledge-label-a-trigger-whose-appearance-is-neither-exactly"),
			"mug:Trigger",
		),
		face: one("refuse", Q("face-capture-image-face"), "mug:FaceCapture"),
		uploadOther: one(
			"refuse",
			Q("upload-with-any-other-mediatype-or-none"),
			"jr-control:upload",
		),
		hiddenBoth: one(
			"refuse",
			Q("hidden-value-with-both-calculate-and-a-default-by-any-expression"),
			"mug:DataBindOnly",
		),
		hiddenOtherType: one(
			"refuse",
			Q("hidden-value-bound-a-type-nova-would-not-write"),
			"xform:model/bind@type",
		),
	},
	imageMaxDimension: one(
		"refuse",
		Q("jr-imagedimensionscaledmax-250-500-1000px-or-another-positive"),
		"jr-extension:UploadQuestionExtensionParser",
	),
	imageMaxDimensionInvalid: one(
		"refuse",
		Q("jr-imagedimensionscaledmax-that-is-not-an-integer-or-is-greater"),
		"jr-extension:UploadQuestionExtensionParser",
	),
	imageMaxDimensionElsewhere: one(
		"account",
		Q("jr-imagedimensionscaledmax-an-integer-with-or-without-px-on-any"),
		"jr-extension:UploadQuestionExtensionParser",
	),

	// ── Choices (10.1) ───────────────────────────────────────────────────
	choicesBothOrNeither: under(
		"refuse",
		Q("select-with-both-items-and-an-itemset-or-no-choices"),
		{ select1: "jr-control:select1", select: "jr-control:select" },
	),
	choiceMissingValue: under(
		"refuse",
		Q("item-without-value-or-an-itemset-without-label-or-without-both"),
		{
			select1Item: "xform:select1/item",
			selectItem: "xform:select/item",
			select1Itemset: "xform:select1/itemset",
			selectItemset: "xform:select/itemset",
		},
	),
	itemsetCopy: one("refuse", Q("itemset-copy"), "xform:select1/itemset/copy"),
	itemsetSort: one(
		"refuse",
		Q("itemset-sort-ref"),
		"vellum-feature:sorted_itemsets",
	),
	choiceValueRefused: one(
		"refuse",
		Q("choice-value-with-whitespace-empty-or-duplicated"),
		"xform:select1/item/value",
	),
	choiceValueBothQuotes: one(
		"refuse",
		Q("choice-value-holding-both-an-apostrophe-and-a-double-quote"),
		"xform:select1/item/value",
	),
	choiceValueInstance: one(
		"refuse",
		Q("choice-value-read-as-an-instance"),
		"xform:select1/item/value",
	),
	choiceValueQuote: under("take", Q("choice-value-containing-or"), {
		select1: "xform:select1/item/value",
		select: "xform:select/item/value",
	}),
	lookupItemset: under(
		"take",
		Q("lookup-table-select-selectdynamic-mselectdynamic-itemset-nodeset"),
		{
			select1: "xform:select1/itemset",
			select1Nodeset: "xform:select1/itemset@nodeset",
			select: "xform:select/itemset",
			selectNodeset: "xform:select/itemset@nodeset",
		},
	),
	lookupRefs: under("take", Q("itemset-label-value-refs-to-lookup-fields"), {
		select1Label: "xform:select1/itemset/label",
		select1LabelRef: "xform:select1/itemset/label@ref",
		select1Value: "xform:select1/itemset/value",
		select1ValueRef: "xform:select1/itemset/value@ref",
		selectLabel: "xform:select/itemset/label",
		selectLabelRef: "xform:select/itemset/label@ref",
		selectValue: "xform:select/itemset/value",
		selectValueRef: "xform:select/itemset/value@ref",
	}),
	itemsetRefShape: one(
		"refuse",
		Q("itemset-refs-to-attr-or-property-qualified-fields"),
		"xform:select1/itemset/value@ref",
	),
	/** A label or value ref naming a column the told table lacks: a read of what is not there,
	 *  which a device reads blank for every choice (`options.ts::readItemset`). */
	itemsetColumn: one(
		"refuse",
		"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
		null,
	),
	itemsetItextLabel: one(
		"refuse",
		Q("itemset-label-jr-itext-field"),
		"xform:select1/itemset/label@ref",
	),
	caseChoices: under(
		"take",
		Q("itemset-over-casedb-in-nova-s-case-choices-shape"),
		{
			select1: "xform:select1/itemset",
			select1Nodeset: "xform:select1/itemset@nodeset",
			select: "xform:select/itemset",
			selectNodeset: "xform:select/itemset@nodeset",
		},
	),
	otherItemset: one(
		"refuse",
		Q("itemset-over-casedb-or-another-instance-advanced-data-source"),
		"xform:select1/itemset",
	),

	// ── Groups, Question Lists and sections (10.2) ───────────────────────
	group: under("take", Q("group-group-ref-label-no-appearance"), {
		node: "mug:Group",
		control: "xform:group",
		ref: "xform:group@ref",
	}),
	unlabelledGroup: under(
		"take",
		Q("group-group-ref-with-no-label-and-no-appearance-outside-a"),
		{ node: "mug:Group", control: "xform:group", ref: "xform:group@ref" },
	),
	questionList: under(
		"take",
		Q("question-list-group-appearance-field-list-labelled"),
		{
			node: "mug:FieldList",
			control: "xform:group",
			ref: "xform:group@ref",
			appearance: "xform:group@appearance",
		},
	),
	unlabelledQuestionList: under(
		"take",
		Q("question-list-unlabelled-anywhere-else"),
		{
			node: "mug:FieldList",
			control: "xform:group",
			ref: "xform:group@ref",
			appearance: "xform:group@appearance",
		},
	),
	sectionQuestionList: under(
		"take",
		Q("question-list-unlabelled-when-every-root-field-is-a-section-and"),
		{
			node: "mug:FieldList",
			control: "xform:group",
			ref: "xform:group@ref",
			appearance: "xform:group@appearance",
		},
	),
	groupInQuestionList: one(
		"take",
		Q("groups-nested-in-a-question-list"),
		"vellum-feature:group_in_field_list",
	),
	userRepeatInQuestionList: one(
		"refuse",
		Q("user-controlled-repeat-inside-a-question-list-a-group-whose"),
		"xform:repeat",
	),

	// ── Repeats (10.3, 10.4) ─────────────────────────────────────────────
	repeatWrapper: under(
		"derived",
		Q("group-ref-x-wrapping-the-repeat-raw-attribute"),
		{
			control: "xform:group",
			ref: "xform:group@ref",
		},
	),
	userRepeat: under("take", Q("repeat-group-user-controlled"), {
		node: "mug:Repeat",
		control: "xform:repeat",
		nodeset: "xform:repeat@nodeset",
		template: "xform:model/instance//*@jr:template",
	}),
	countFromInteger: under(
		"take",
		Q("repeat-with-jr-count-naming-an-integer-question-of-the-form-s"),
		{
			node: "mug:Repeat",
			control: "xform:repeat",
			nodeset: "xform:repeat@nodeset",
			noAddRemove: "xform:repeat@jr:noAddRemove",
			template: "xform:model/instance//*@jr:template",
		},
	),
	countFromHidden: under(
		"take",
		Q("jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in"),
		{
			node: "mug:Repeat",
			control: "xform:repeat",
			nodeset: "xform:repeat@nodeset",
			noAddRemove: "xform:repeat@jr:noAddRemove",
			template: "xform:model/instance//*@jr:template",
		},
	),
	countFromSelect: under(
		"take",
		Q("jr-count-naming-a-single-select-question-whose-every-choice"),
		{
			node: "mug:Repeat",
			control: "xform:repeat",
			nodeset: "xform:repeat@nodeset",
			noAddRemove: "xform:repeat@jr:noAddRemove",
			template: "xform:model/instance//*@jr:template",
		},
	),
	countFromQuery: under(
		"take",
		Q("count-repeat-whose-count-and-row-ids-come-from-one-query-a"),
		{
			node: "mug:Repeat",
			control: "xform:repeat",
			nodeset: "xform:repeat@nodeset",
			count: "xform:repeat@jr:count",
			noAddRemove: "xform:repeat@jr:noAddRemove",
			template: "xform:model/instance//*@jr:template",
		},
	),
	modelIteration: under(
		"take",
		Q("repeat-model-iteration-vellum-role-repeat-ids-count-current"),
		{
			node: "mug:Repeat",
			role: "vellum-markup:model/instance//*@vellum:role",
			control: "xform:repeat",
			nodeset: "xform:repeat@nodeset",
			count: "xform:repeat@jr:count",
			noAddRemove: "xform:repeat@jr:noAddRemove",
			template: "xform:model/instance//*@jr:template",
			setvalue: "xform:setvalue",
			event: "xform:setvalue@event",
			setvalueRef: "xform:setvalue@ref",
			setvalueValue: "xform:setvalue@value",
			group: "xform:group",
			groupRef: "xform:group@ref",
		},
	),
	currentIndexCalculate: one(
		"derived",
		Q("bind-calculate-on-a-hidden-value"),
		"xform:model/bind@calculate",
	),
	noAddRemoveWithoutCount: one(
		"refuse",
		Q("jr-noaddremove-without-jr-count"),
		"xform:repeat@jr:noAddRemove",
	),
	countNotAPath: one(
		"refuse",
		Q("jr-count-that-is-not-a-path-such-as-data-n-1"),
		"mug:Repeat",
	),
	countNamingNoNode: one(
		"refuse",
		Q("jr-count-naming-a-node-in-a-secondary-instance-or-no-node"),
		"mug:Repeat",
	),
	countFromDecimal: one(
		"refuse",
		Q("jr-count-naming-a-decimal-question"),
		"mug:Repeat",
	),
	countFromOther: one(
		"refuse",
		Q("jr-count-naming-any-other-question-kind-text-barcode-multi"),
		"mug:Repeat",
	),
	countFromNonIntegerHidden: one(
		"refuse",
		Q("jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer"),
		"mug:Repeat",
	),
	countReadingItsRows: one(
		"refuse",
		Q("a-count-that-depends-on-the-rows-it-creates-through-calculations"),
		"xform:repeat@jr:count",
	),
	addCaptions: one(
		"refuse",
		Q("repeat-add-captions-jr-addcaption-jr-addemptycaption"),
		"xform:repeat/jr:addCaption",
	),
	otherCaptions: one(
		"drop",
		Q("other-repeat-captions-choosecaption-delcaption-donecaption"),
		"xform:repeat/jr:chooseCaption",
	),
	itextCaptions: one(
		"refuse",
		Q("those-captions-referencing-itext"),
		"xform:repeat/jr:chooseCaption@ref",
	),
	modelIterationNested: one(
		"refuse",
		Q("model-iteration-repeat-nested-in-another-repeat-of-any-kind"),
		"vellum-markup:model/instance//*@vellum:role",
	),
	modelIterationBlankAnswer: one(
		"refuse",
		Q("model-iteration-repeat-whose-query-reads-a-form-answer-that-is"),
		"vellum-markup:model/instance//*@vellum:role",
	),
	modelIterationLateRelevance: one(
		"refuse",
		Q("model-iteration-repeat-under-an-ancestor-that-core-s-load-can"),
		"vellum-markup:model/instance//*@vellum:role",
	),
	modelIterationOutsideRule: one(
		"refuse",
		Q("model-iteration-repeat-outside-nova-s-model-iteration-rule"),
		"vellum-markup:model/instance//*@vellum:role",
	),

	// ── Logic slots and load-time values (11) ────────────────────────────
	requiredOnLabel: one(
		"refuse",
		Q("bind-required-on-a-label"),
		"xform:model/bind@required",
	),
	/** A constraint that is Nova's scalar check alone, held by the field's record of it. */
	scalarCheck: one("take", Q("bind-constraint"), "xform:model/bind@constraint"),
	constraintOnCapture: one(
		"refuse",
		Q("bind-constraint-on-a-capture-question-or-a-label"),
		"xform:model/bind@constraint",
	),
	calculateOnVisible: one(
		"refuse",
		Q("bind-calculate-on-a-visible-question"),
		"xform:model/bind@calculate",
	),
	bindReadonly: one("refuse", Q("bind-readonly"), "xform:model/bind@readonly"),
	messageWithoutConstraint: one(
		"refuse",
		Q("validation-message-without-a-validation-condition"),
		"xform:model/bind@jr:constraintMsg",
	),
	messageOnCapture: one(
		"refuse",
		Q("validation-message-on-a-capture-question-or-a-label"),
		"xform:model/bind@jr:constraintMsg",
	),
	defaultOnCapture: one(
		"refuse",
		Q("default-on-a-capture-question-or-a-label"),
		"xform:setvalue",
	),
	defaultOutside: under(
		"take",
		Q("setvalue-event-xforms-ready-default-on-a-question-outside"),
		{
			setvalue: "xform:setvalue",
			event: "xform:setvalue@event",
			ref: "xform:setvalue@ref",
		},
	),
	defaultInside: under(
		"take",
		Q("setvalue-event-jr-insert-default-inside-a-repeat-not-reading"),
		{
			setvalue: "xform:setvalue",
			event: "xform:setvalue@event",
			ref: "xform:setvalue@ref",
		},
	),
	defaultEventMismatch: one(
		"refuse",
		Q("a-default-value-s-setvalue-whose-event-does-not-match-where-the"),
		"jr-action:setvalue",
	),
	secondDefault: one(
		"refuse",
		Q("a-second-default-setvalue-on-one-question"),
		"xform:setvalue",
	),
	formLevelSetvalue: one(
		"refuse",
		Q("setvalue-event-xforms-value-changed-authored-xforms-revalidate"),
		"jr-action:setvalue",
	),
	actionInControl: under("refuse", Q("actions-nested-inside-controls"), {
		setvalue: "jr-action:setvalue",
		send: "jr-action:send",
		pollsensor: "jr-action:pollsensor",
	}),
	loadOrder: one(
		"refuse",
		Q("default-setvalues-in-an-order-a-save-in-the-form-builder-changes"),
		"xform:setvalue",
	),

	// ── Itext, by reference (12.1) ───────────────────────────────────────
	translationElement: one(
		"derived",
		"application-and-settings/attachments-form-unique-id-xml",
		"xform:model/itext/translation",
	),
	translationLang: one(
		"take",
		"application-and-settings/langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin",
		"xform:model/itext/translation@lang",
	),
	translationOtherLanguage: one(
		"drop",
		Q("translation-for-a-language-not-in-langs"),
		"xform:model/itext/translation@lang",
	),
	itextIds: under(
		"drop",
		Q("itext-ids-other-than-a-pragma-key-default-placement"),
		{
			default: "xform:model/itext/translation@default",
			id: "xform:model/itext/translation/text@id",
		},
	),
	duplicateTextId: one(
		"refuse",
		Q("duplicate-text-id-in-one-translation-jr-itext-with-double-quotes"),
		"xform:model/itext/translation/text@id",
	),
	firstWithoutDefault: one(
		"refuse",
		Q("a-label-whose-itext-in-the-first-translation-has-no-default-form"),
		"xform:model/itext/translation/text",
	),
	unreferencedText: one(
		"drop",
		Q("itext-entry-referenced-by-no-question-and-no-expression-other"),
		"xform:model/itext/translation/text@id",
	),
	expressionOnlyText: one(
		"refuse",
		Q("itext-entry-referenced-only-from-jr-itext-in-an-expression"),
		"xform:model/itext/translation/text@id",
	),
	unreferencedPragma: one(
		"refuse",
		Q("itext-pragma-entries-pragma-form-descriptor-pragma-skip-full"),
		"xform:model/itext/translation/text@id",
	),
	pragmaMerged: one(
		"account",
		Q("a-question-text-whose-itext-id-is-a-pragma-key-hq-s-build-merges"),
		"xform:model/itext/translation/text@id",
	),
	pragmaVolatilityWithoutKey: one(
		"account",
		Q("a-question-text-whose-itext-id-is-pragma-volatility-entity-title"),
		"xform:model/itext/translation/text@id",
	),
	pragmaFormDescriptor: one(
		"refuse",
		Q("a-question-text-whose-itext-id-is-pragma-form-descriptor-where"),
		"xform:model/itext/translation/text@id",
	),
	pragmaKey: one(
		"refuse",
		Q("a-question-text-label-hint-help-validation-message-repeat-add"),
		"xform:model/itext/translation/text@id",
	),
	itext: under("take", Q("label-default-text-itext-value"), {
		text: "xform:model/itext/translation/text",
		value: "xform:model/itext/translation/text/value",
	}),
	labelRef: under(
		"take",
		Q("label-default-text-itext-value"),
		slotKeys("label"),
	),
	inlineLabel: under(
		"take",
		Q("inline-label-text-label-no-itext"),
		elementKeys("label"),
	),
	hint: under("take", Q("hint-text"), slotKeys("hint")),
	hintOnLabel: under("refuse", Q("hint-text-on-a-label"), elementKeys("hint")),
	help: under("take", Q("help-text-markdown-form"), slotKeys("help")),
	helpOnCapture: under(
		"refuse",
		Q("help-text-on-a-capture-question-or-a-label"),
		elementKeys("help"),
	),
	alert: under(
		"take",
		Q("jr-constraintmsg-jr-itext-id-or-alert-ref-jr-itext-id"),
		slotKeys("alert"),
	),
	constraintMsg: one(
		"take",
		Q("validation-message-text"),
		"xform:model/bind@jr:constraintMsg",
	),
	literalConstraintMsg: one(
		"refuse",
		Q("literal-jr-constraintmsg-text-no-itext"),
		"xform:model/bind@jr:constraintMsg",
	),
	choiceLabel: under(
		"take",
		Q("choice-label-text-markdown"),
		CHOICE_LABEL_KEYS,
	),
	choiceLabelPlain: under(
		"take",
		Q("choice-label-with-no-markdown-form"),
		CHOICE_LABEL_KEYS,
	),
	groupLabel: under("take", Q("group-repeat-label-text-markdown"), {
		label: "xform:label",
		ref: "xform:label@ref",
	}),

	// ── Forms of a text (12.2) ───────────────────────────────────────────
	labelPlain: one(
		"take",
		Q("label-with-no-markdown-form"),
		"xform:model/itext/translation/text",
	),
	helpPlain: one(
		"take",
		Q("help-text-with-no-markdown-form"),
		"xform:model/itext/translation/text",
	),
	markdownEqual: one(
		"take",
		Q("markdown-form-equal-to-the-default-text"),
		"itext-form:core/markdown",
	),
	markdownDiffering: one(
		"refuse",
		Q("markdown-form-differing-from-the-default-text"),
		"itext-form:core/markdown",
	),
	markdownSomeLanguages: one(
		"refuse",
		Q("a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk"),
		"itext-form:core/markdown",
	),
	markdownSomeLanguagesOneText: one(
		"take",
		Q(
			"a-markdown-form-in-some-languages-only-each-other-language-holding-the-default-s",
		),
		"itext-form:core/markdown",
	),
	markdownFormattingOff: one(
		"refuse",
		Q("a-markdown-form-in-a-form-whose-text-formatting-is-off"),
		"itext-form:core/markdown",
	),
	hintMarkdown: one(
		"drop",
		Q("hint-markdown-form"),
		"itext-form:core/markdown",
	),
	validationMarkdown: one(
		"drop",
		Q("validation-message-markdown-form"),
		"itext-form:core/markdown",
	),
	videoInline: one(
		"refuse",
		Q("label-video-inline"),
		"itext-form:android/video-inline",
	),
	longForm: one("refuse", Q("long-form"), "itext-form:core/long"),
	shortForm: one("account", Q("short-form"), "itext-form:core/short"),
	labelBigImage: one(
		"refuse",
		Q("label-big-image"),
		"itext-form:android/big-image",
	),
	choiceBigImage: one(
		"refuse",
		Q("choice-big-image"),
		"itext-form:android/big-image",
	),
	qrcode: one("refuse", Q("label-qrcode"), "itext-form:android/qrcode"),
	tts: one("refuse", Q("label-tts"), "itext-form:android/tts"),
	customForm: one(
		"account",
		Q("custom-form-names"),
		"xform:model/itext/translation/text/value@form",
	),
	blankTranslation: one(
		"take",
		Q("an-explicitly-blank-value-in-a-non-default-language-where-the"),
		"xform:model/itext/translation/text/value",
	),
	blankFirstLanguage: one(
		"refuse",
		Q(
			"an-explicitly-blank-value-in-the-first-language-where-another-holds-text",
		),
		"xform:model/itext/translation/text/value",
	),

	// ── Prose (12.3) ─────────────────────────────────────────────────────
	xhtmlChild: one(
		"refuse",
		Q("xhtml-namespace-child-elements-inside-a-value"),
		"xform:model/itext/translation/text/value/h:*",
	),
	otherChild: one(
		"drop",
		Q("other-child-elements-inside-a-value"),
		"xform:model/itext/translation/text/value/*",
	),
	output: one(
		"derived",
		Q("output-value-of-a-question-case-or-user-reference"),
		"xform:model/itext/translation/text/value/output",
	),
	literalOutput: one(
		"derived",
		Q("output-value-any-other-expression"),
		"xform:model/itext/translation/text/value/output@value",
	),
	outputRef: one(
		"take",
		Q("output-ref"),
		"xform:model/itext/translation/text/value/output@ref",
	),

	// ── Media (12.4) ─────────────────────────────────────────────────────
	labelMedia: mediaClaims(
		"take",
		Q("label-image-audio-video-same-asset-every-language"),
	),
	helpMedia: mediaClaims("take", Q("help-media")),
	choiceImage: under("take", Q("choice-image"), {
		image: "itext-form:core/image",
	}),
	choiceAudioVideo: under("take", Q("choice-audio-video"), {
		audio: "itext-form:core/audio",
		video: "itext-form:core/video",
	}),
	mediaDiffering: mediaClaims(
		"refuse",
		Q("label-or-option-media-differing-by-language"),
	),
	helpMediaOnCapture: mediaClaims(
		"refuse",
		Q("help-media-on-a-capture-question-or-a-label"),
	),
	hintMedia: mediaClaims(
		"account",
		Q("hint-media-other-than-a-missing-file-the-media-section-refuses"),
	),
	validationMedia: mediaClaims(
		"account",
		Q("validation-message-media-constraintmediaitext-other-than-a"),
	),
	groupMedia: mediaClaims(
		"account",
		Q("group-repeat-label-media-other-than-a-missing-file-the-media"),
	),

	// ── Translations (12.5) ──────────────────────────────────────────────
	outputsDiffer: one(
		"refuse",
		Q("a-text-whose-languages-show-different-values"),
		"xform:model/itext/translation/text/value/output",
	),
} as const;
