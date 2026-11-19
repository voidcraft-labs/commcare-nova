/**
 * The one context a reading's stages share: the input, the accounting and the
 * root cursor, the drafts the structure stages fill, the expressions they
 * register, the facts later readers take, and, from the expression stage on,
 * the bound document. A stage changes a draft only inside `writeDraft`, which
 * counts a revision, so a document built from the drafts can be memoized on
 * that revision.
 */

import type {
	AppLocalization,
	BlueprintDoc,
	Form,
	LocationProperty,
	Module,
	OrganizationLevel,
	UserProperty,
	Uuid,
} from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import type { InventoryIndex } from "../surface/inventory";
import { Accounting, type Admitted } from "./accounting";
import type { HeldExpansions } from "./heldExpansions";
import type { IdentityResolver } from "./identity";
import type { JsonCursor } from "./jsonCursor";
import {
	type AnsweredPendingRegistry,
	pendingRegistry,
} from "./pendingExpressions";
import { appPlace } from "./place";
import { type TranslationSink, translationSink } from "./translations";
import type { ReadDraft, ReaderInput, ReaderOptions, ReadFacts } from "./types";
import type { ReadXForm } from "./xform";

/** `ReadFacts` while the stages fill it: every list appendable, every scalar assignable. */
export type MutableReadFacts = {
	-readonly [K in keyof ReadFacts]: ReadFacts[K] extends readonly (infer E)[]
		? E[]
		: ReadFacts[K];
};

export interface DraftApp {
	appName: Admitted<string> | undefined;
	/** Set by the application stage; its translations are filled by the text stage. */
	localization: AppLocalization | undefined;
	appSettings: Partial<BlueprintDoc["appSettings"]>;
	/** The Web Apps logo's asset, set by the application stage where its path resolved to one. */
	logo: string | undefined;
	/** HQ's order. */
	readonly modules: DraftModule[];
	/** The project space's levels (`levelsFromHq`). */
	levels: readonly OrganizationLevel[];
	/** The app's Connect kind, set once every form is read (`xform/connect.ts::readConnectType`). */
	connectType: BlueprintDoc["connectType"];
	/** What the app reads of the worker and of places (`worldEntitiesFromReads`). */
	userProperties: readonly UserProperty[];
	locationProperties: readonly LocationProperty[];
	/** The case catalog the case management stages write; null while no stage has written one. */
	caseTypes: BlueprintDoc["caseTypes"];
	/** Each hidden registration menu the menus stage folded into its host, in HQ's order. Its
	 *  draft stays in `modules` so every key of it is read; it is no menu of the document, its
	 *  one form is the host's last, and its HQ id is listed under `syntheticModuleUuid(formUuid)`. */
	readonly foldedMenus: FoldedMenu[];
}

/** A hidden registration menu read as its host's registration after an empty search. */
export interface FoldedMenu {
	/** The hidden menu's own draft. */
	readonly menu: DraftModule;
	readonly hostUuid: Uuid;
	/** The registration form, now the last of the host's forms. */
	readonly formUuid: Uuid;
}

export interface DraftModule {
	readonly index: number;
	readonly uniqueId: string;
	readonly uuid: Uuid;
	readonly docType: "Module" | "AdvancedModule";
	readonly json: JsonCursor;
	readonly place: HqPlace;
	/** The slots stages set. `assembleDocument` parses the whole with `moduleSchema`. */
	readonly module: Partial<Module>;
	readonly forms: DraftForm[];
}

export interface DraftForm {
	readonly menu: number;
	readonly index: number;
	readonly xmlns: string;
	readonly uuid: Uuid;
	readonly docType: "Form" | "AdvancedForm";
	readonly json: JsonCursor;
	readonly place: HqPlace;
	readonly form: Partial<Form>;
	/** Set by the forms stage; null where the source held no readable XForm (a finding was made). */
	xform: ReadXForm | null;
	/** Each create block's `@case_id` path, absolute from the data root, to the UUID of the
	 *  operation read from it. Empty until the case management stage sets it. */
	operationIdPaths: ReadonlyMap<string, Uuid>;
}

/** What the accounting's close gives. */
export type ClosedAccounting = ReturnType<Accounting["close"]>;

export interface ReadContext {
	readonly input: ReaderInput;
	readonly accounting: Accounting;
	/** Class `Application`, artifact `app.json`. */
	readonly app: JsonCursor;
	readonly draft: DraftApp;
	readonly translations: TranslationSink;
	/** Every expression registered for the expression stage, with the node each was read from. */
	readonly pending: AnsweredPendingRegistry;
	/** `input.resolver`. */
	readonly resolver: IdentityResolver;
	/** The bound provisional document; undefined before the expression stage. Frozen; replaced,
	 *  never mutated. */
	doc: BlueprintDoc | undefined;
	/** Facts stages append for `ReadFacts`, the hand-offs among them. */
	readonly facts: MutableReadFacts;
	/** Whether any slot reads the `locations` instance; set by the expression stage. */
	readsLocations: boolean;
	/** The draft the assembly stage gives where no finding stands. */
	assembled: ReadDraft | undefined;
	/** How many times a draft has been written: what a document built from the drafts is
	 *  memoized on. */
	readonly draftRevision: number;
	/** The one way a stage changes a draft: runs `write`, then counts a draft revision. */
	writeDraft(write: () => void): void;
	/** `ReaderOptions.heldExpansions`. */
	readonly heldExpansions: HeldExpansions | undefined;
	/** Closes the accounting once; every later call answers the same close. */
	close(): ClosedAccounting;
}

function emptyFacts(input: ReaderInput): MutableReadFacts {
	return {
		webAppsOnInHq: input.source.cloudcareEnabled,
		mediaReferences: [],
		pendingMedia: [],
		unreadTables: [],
		foldedTranslationKeys: 0,
		forms: [],
		sameStateRewrites: [],
		entryFactsRefused: [],
		childCasesUnread: [],
		rewrites: [],
		expressionRounds: 0,
	};
}

/** The context a reading starts with: no draft written, the root cursor open. */
export function createReadContext(
	input: ReaderInput,
	options: ReaderOptions,
	index: InventoryIndex,
): ReadContext {
	const accounting = new Accounting(index, { log: options.claims ?? "counts" });
	const app = accounting.json(input.source.raw, appPlace());
	let revision = 0;
	let closed: ClosedAccounting | undefined;
	return {
		input,
		accounting,
		app,
		draft: {
			appName: undefined,
			localization: undefined,
			appSettings: {},
			logo: undefined,
			modules: [],
			levels: [],
			connectType: null,
			userProperties: [],
			locationProperties: [],
			caseTypes: null,
			foldedMenus: [],
		},
		translations: translationSink(),
		pending: pendingRegistry(),
		resolver: input.resolver,
		doc: undefined,
		facts: emptyFacts(input),
		readsLocations: false,
		assembled: undefined,
		get draftRevision() {
			return revision;
		},
		writeDraft(write) {
			write();
			revision += 1;
		},
		heldExpansions: options.heldExpansions,
		close() {
			closed ??= accounting.close();
			return closed;
		},
	};
}
