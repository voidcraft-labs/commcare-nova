// Builds the JavaScript of HQ's editor pages and of its Web Apps page for the
// proof harness's editor driver (proof/editors, proof/webapps), at image
// build time, from HQ's own node packages.
//
// HQ ships its page JavaScript as webpack bundles (`yarn build`:
// webpack/generateDetails.js, then webpack/webpack.prod.js). The harness
// bundles the same entries with esbuild instead, under a configuration read
// from HQ's own webpack configuration objects (this script requires them), so
// every module resolves and behaves as it does in HQ's build:
//
// - resolve.alias, with webpack's matching (a key is the whole request or its
//   first segments; aliases apply again to what they produce);
// - resolve.fallback (`false` is an empty module), resolve's default
//   extensions, main fields and condition names for a web target; and, where
//   esbuild's resolver finds no file for a request, webpack's own resolver's
//   answer (enhanced-resolve, from HQ's node packages): webpack completes a
//   package `exports` target with its extensions where esbuild takes the
//   target as written (Web Apps' `markdown-it/dist/markdown-it`), and reads a
//   package's `browser` field mapping a request to `false` as an empty
//   module (crypto-js's `crypto`);
// - externals: every request of the page graphs is put to the
//   configuration's externals, and one they make external fails the build
//   (HQ's only external applies to a Vellum checkout beside HQ, which the
//   image has none of);
// - ProvidePlugin's definitions, as `require(<request>)` wherever the name is
//   free;
// - NormalModuleReplacementPlugin, on the request and on the resolved file;
// - module.rules: style-loader + css-loader (and less-loader) inject the
//   stylesheet into the page when the module runs; asset/resource modules
//   export their URL; exports-loader appends the export it names; babel-loader
//   is checked to have no configuration, so it leaves the source as it is;
// - strict mode as webpack gives it: an ES module (one with an import or
//   export statement; HarmonyDetectionParserPlugin) runs strict, and any
//   other module runs as its own source says. esbuild hoists ES modules into
//   the bundle's sloppy scope, so each ES module is compiled to a CommonJS
//   module of its own with esbuild's ES module interop (its exports live
//   getters, its imports required where they stand, after every statement
//   that loads a module is moved ahead of its body, where an ES module
//   evaluates them) and a "use strict" directive, and every entry is a stub
//   that requires its page module, so no directive reaches the bundle's top
//   scope;
// - webpack's AMD support (AMDPlugin, on unless `amd: false`): a module that
//   calls a free `define` gets webpack's define, with its literal dependency
//   lists loaded as modules;
// - `import.meta.url` as the module's own file URL (ImportMetaPlugin);
// - `global`, `__filename` and `__dirname` as webpack's node defaults for a
//   web target give them, and process.env.NODE_ENV as the configuration's
//   mode sets it.
//
// A construct this list does not cover (an AMD `require([...], callback)`, a
// loader rule with options it does not know, a module no rule loads, an ES
// module whose meaning a CommonJS module of its own would change: one that
// reads a free `module` or `exports`, or awaits at its top level) fails the
// build, so a change in HQ's build is seen here rather than as a page that
// behaves differently.
//
// It writes:
//
// - under the output directory (/opt/editors), static/<webpack folder>/<entry>.js:
//   one bundle per covered page entry, where HQ's static URL for its own
//   bundles points (`webpack` or `webpack_b3`, from the configuration's output
//   path), with its assets;
// - HQ's manifests (entry -> bundle files) where HQ's own build writes them,
//   in HQ's build directory (webpack/appPaths.js::BUILD_ARTIFACTS_DIR, which
//   hqwebapp/utils/webpack.py::WEBPACK_BUILD_DIR reads), under the file names
//   HQ's EntryChunksPlugin writes, so HQ's own `webpack_bundles` template
//   filter names the scripts each page loads;
// - static/vellum/host.html and its bundle: HQ's vendored Vellum build with
//   HQ's own jQuery, Bootstrap 3, select2 and underscore, resolved by the
//   form designer page's (Bootstrap 3) configuration, and the options HQ's form
//   designer page adds to Vellum's, taken from HQ's form_designer.js;
// - build.json: what was built, from which HQ files, with which of the
//   semantics above applied where.
//
// Usage: node build.mjs [--hq /opt/hq] [--out /opt/editors] [--tools /opt/proof-tools]

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const HQ = path.resolve(option("--hq", "/opt/hq"));
const OUT = path.resolve(option("--out", "/opt/editors"));
const TOOLS = path.resolve(option("--tools", "/opt/proof-tools"));

const tools = createRequire(path.join(TOOLS, "package.json"));
const hq = createRequire(path.join(HQ, "package.json"));
const esbuild = tools("esbuild");
const acorn = tools("acorn");
const walk = tools("acorn-walk");

// HQ's settings.py STATIC_URL; HQ's `{% static %}` prefixes bundle paths with it.
const STATIC_URL = "/static/";

// The pages the editor driver renders, each by the webpack entry its page
// template names ({% js_entry %} or {% js_entry_b3 %}).
const PAGE_ENTRIES = [
	// app_manager/app_view_settings.html: app settings, add-ons, UI translations
	"app_manager/js/app_view",
	// app_manager/bootstrap3/module_view.html: module settings, case list, case search
	"app_manager/js/modules/bootstrap3/module_view",
	// app_manager/form_view.html: form settings, case management
	"app_manager/js/forms/form_view",
	// cloudcare/formplayer_home.html: Web Apps, the client the Web Apps
	// driver runs against Formplayer (proof/webapps)
	"cloudcare/js/formplayer/main",
	// cloudcare/preview_app_base.html: App Preview, the same client under the
	// app builder's preview page (proof/webapps)
	"cloudcare/js/preview_app/main",
	// motech/connection_settings_detail.html and
	// repeaters/add_form_repeater.html: the Connection Settings and Add
	// Forwarder pages a project space's admin sets Connect's forwarder up
	// with (proof/connect/hq.py)
	"motech/js/connection_settings_detail",
	"repeaters/js/add_form_repeater",
];

// HQ's form designer page entry, whose page JavaScript adds options to
// Vellum's (app_manager/bootstrap3/form_designer.html).
const FORM_DESIGNER_ENTRY = "app_manager/js/forms/bootstrap3/form_designer";

// What HQ's form designer page JavaScript adds to the options the server
// renders, and the callbacks it adds to their `core`. The driver runs the
// first as HQ wrote it and observes Vellum through the second, so a change to
// either set fails the build rather than going unseen.
const EXPECTED_PAGE_OPTION_KEYS = ["csrftoken", "itemset", "windowManager"];
const EXPECTED_CORE_CALLBACKS = [
	"formLoadedCallback",
	"formLoadingCallback",
	"onFormSave",
	"onReady",
];

// webpack's resolve defaults for a web target
// (webpack/lib/config/defaults.js::getResolveDefaults): its condition names
// are "webpack", the mode and "browser", with "import" or "require" and
// "module" by dependency type; esbuild adds "browser", "import"/"require" and
// "default" itself.
const WEBPACK_EXTENSIONS = [".js", ".json", ".wasm"];
const WEBPACK_MAIN_FIELDS = ["browser", "module", "main"];
const webpackConditions = (mode) => ["module", "webpack", mode];

// Where the ProvidePlugin modules are written for the build, and removed after.
const PROVIDE_DIR = path.join(HQ, ".proof-editors-provide");

// Each page entry is built from a stub that requires the page's module, so
// the page's own module is compiled like every other ES module (esbuild moves
// an entry's "use strict" to the top of the bundle, where it would make every
// module strict).
const ENTRY_NAMESPACE = "proof-entry";

class BuildRefused extends Error {}

function refuse(message) {
	throw new BuildRefused(
		`${message}\nThe editor bundles reproduce HQ's webpack build (proof/image/editors/build.mjs); ` +
			"teach it the construct, or check what changed in HQ's webpack configuration.",
	);
}

// --- HQ's webpack configuration ------------------------------------------

/**
 * HQ's production webpack configurations, as `yarn build` makes them: HQ's own
 * generateDetails.js writes the entries and aliases its configuration reads,
 * then webpack.prod.js is required from HQ's root (it resolves some paths
 * against the working directory).
 */
function hqWebpackConfigurations() {
	execFileSync(process.execPath, ["webpack/generateDetails.js", "--prod"], {
		cwd: HQ,
		stdio: "inherit",
	});
	process.chdir(HQ);
	const configurations = hq("./webpack/webpack.prod.js");
	if (!Array.isArray(configurations)) {
		refuse(
			"HQ's webpack/webpack.prod.js no longer exports a list of configurations.",
		);
	}
	return configurations.map((config) => {
		const chunks = config.plugins.find(
			(plugin) => plugin.constructor.name === "EntryChunksPlugin",
		);
		if (!chunks) {
			refuse(
				"A configuration in HQ's webpack.prod.js has no EntryChunksPlugin, so the harness cannot tell which manifest HQ reads its bundles from.",
			);
		}
		if (config.amd === false) {
			refuse(
				"HQ's webpack configuration turns AMD off; the bundles apply webpack's AMD define.",
			);
		}
		if (config.target !== undefined) {
			refuse(
				`HQ's webpack configuration sets target ${JSON.stringify(config.target)}; the bundles reproduce webpack's web target.`,
			);
		}
		return {
			config,
			folder: path.basename(config.output.path),
			manifest: chunks.options.filename || "manifest.json",
		};
	});
}

/** Where HQ's own build writes its manifests (plugins.js::EntryChunksPlugin). */
function hqBuildArtifactsDir() {
	const dir = hq("./webpack/appPaths.js").BUILD_ARTIFACTS_DIR;
	if (typeof dir !== "string" || !path.isAbsolute(dir)) {
		refuse(
			"HQ's webpack/appPaths.js no longer names its BUILD_ARTIFACTS_DIR, where HQ's build writes its manifests.",
		);
	}
	return dir;
}

/**
 * Whether the configuration's externals make a request external, as webpack
 * asks them (ExternalModuleFactoryPlugin): a function is called with the
 * request's context and answers through its callback or its promise; a string,
 * a regular expression or an object names requests itself.
 */
async function externalFor(externals, request, context, issuer) {
	for (const item of [].concat(externals ?? [])) {
		let result;
		if (typeof item === "function") {
			result = await new Promise((resolve, reject) => {
				const answered = item(
					{ context, request, contextInfo: { issuer } },
					(error, value) => (error ? reject(error) : resolve(value)),
				);
				if (answered && typeof answered.then === "function") {
					answered.then(resolve, reject);
				}
			});
		} else if (typeof item === "string") {
			result = item === request ? item : undefined;
		} else if (item instanceof RegExp) {
			result = item.test(request) ? request : undefined;
		} else if (item && typeof item === "object") {
			result = Object.hasOwn(item, request) ? item[request] : undefined;
		} else {
			refuse(
				`HQ's webpack externals hold ${String(item)}, which the harness cannot ask.`,
			);
		}
		if (result !== undefined && result !== false) return result;
	}
	return undefined;
}

/** Fails the build unless babel-loader, which HQ runs on its own sources, has nothing to apply. */
function checkBabelIsIdentity(file) {
	const babel = hq("@babel/core");
	const partial = babel.loadPartialConfig({
		filename: file,
		cwd: HQ,
		root: HQ,
	});
	const applied = [
		...(partial.options.plugins || []),
		...(partial.options.presets || []),
	];
	if (partial.hasFilesystemConfig() || applied.length) {
		refuse(
			`HQ now configures Babel (${partial.config || partial.babelrc || "plugins or presets"}), so babel-loader transforms HQ's sources.`,
		);
	}
}

function ruleList(config) {
	const rules = [];
	const visit = (list) => {
		for (const rule of list) {
			if (rule.rules) {
				if (rule.test || rule.include || rule.exclude?.length) {
					// A rule group's conditions narrow the rules inside it; HQ's
					// only group excludes the Vellum debug directory, empty when
					// no Vellum checkout sits beside HQ.
					const excluded = [].concat(rule.exclude || []);
					if (rule.test || rule.include || excluded.some((e) => e)) {
						refuse(
							"HQ's webpack rules hold a conditional rule group the harness does not reproduce.",
						);
					}
				}
				visit(rule.rules);
			} else if (Object.keys(rule).length) {
				rules.push(rule);
			}
		}
	};
	visit(config.module.rules);
	return rules;
}

function conditionMatches(condition, file) {
	if (condition === undefined) return true;
	if (Array.isArray(condition))
		return condition.some((c) => conditionMatches(c, file));
	if (condition instanceof RegExp) return condition.test(file);
	if (typeof condition === "string") return file.startsWith(condition);
	if (typeof condition === "function") return condition(file);
	refuse(
		`HQ's webpack rules use a condition the harness cannot evaluate: ${condition}`,
	);
}

function excluded(rule, file) {
	const exclude = [].concat(rule.exclude || []);
	return exclude.length > 0 && exclude.some((c) => conditionMatches(c, file));
}

/** The rules that apply to a file, as webpack matches `test` and `exclude` against its path. */
function matchingRules(rules, file) {
	return rules.filter(
		(rule) =>
			rule.test !== undefined &&
			conditionMatches(rule.test, file) &&
			!excluded(rule, file),
	);
}

function loaderNames(rule) {
	if (rule.loader) return [rule.loader];
	return []
		.concat(rule.use || [])
		.map((use) => (typeof use === "string" ? use : use.loader));
}

// webpack's own resolver (enhanced-resolve, from HQ's node packages), under
// webpack's resolve defaults for a web target, by dependency type.
const webpackResolvers = new Map();

/**
 * How webpack's own resolver answers a request esbuild's found no file for:
 * the file, `false` for a module a package's `browser` field leaves out (an
 * empty module to webpack), or undefined where webpack finds none either.
 */
function webpackResolve(mode, request, context, kind) {
	const type = kind === "require-call" ? "require" : "import";
	const key = `${mode}:${type}`;
	if (!webpackResolvers.has(key)) {
		const { ResolverFactory, CachedInputFileSystem } = hq("enhanced-resolve");
		webpackResolvers.set(
			key,
			ResolverFactory.createResolver({
				fileSystem: new CachedInputFileSystem(hq("node:fs"), 4000),
				extensions: WEBPACK_EXTENSIONS,
				mainFields: WEBPACK_MAIN_FIELDS,
				aliasFields: ["browser"],
				exportsFields: ["exports"],
				conditionNames: [...webpackConditions(mode), "browser", type],
			}),
		);
	}
	return new Promise((resolve) => {
		webpackResolvers
			.get(key)
			.resolve({}, context, request, {}, (error, file) =>
				resolve(error ? undefined : file),
			);
	});
}

// --- JavaScript source analysis -------------------------------------------

function parseModule(source, file) {
	const options = { ecmaVersion: "latest", allowHashBang: true, ranges: true };
	try {
		return acorn.parse(source, { ...options, sourceType: "module" });
	} catch {
		try {
			return acorn.parse(source, {
				...options,
				sourceType: "script",
				allowReturnOutsideFunction: true,
			});
		} catch (error) {
			refuse(`The harness could not parse ${file}: ${error.message}`);
		}
	}
}

function patternNames(pattern, names = []) {
	if (!pattern) return names;
	switch (pattern.type) {
		case "Identifier":
			names.push(pattern.name);
			break;
		case "ObjectPattern":
			for (const property of pattern.properties) {
				patternNames(
					property.type === "RestElement" ? property.argument : property.value,
					names,
				);
			}
			break;
		case "ArrayPattern":
			for (const element of pattern.elements) patternNames(element, names);
			break;
		case "AssignmentPattern":
			patternNames(pattern.left, names);
			break;
		case "RestElement":
			patternNames(pattern.argument, names);
			break;
		default:
			break;
	}
	return names;
}

const FUNCTION_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
]);
const BLOCK_TYPES = new Set([
	"Program",
	"BlockStatement",
	"ForStatement",
	"ForInStatement",
	"ForOfStatement",
	"SwitchStatement",
	"StaticBlock",
]);

/**
 * The names each scope of a module declares: Program, functions (their
 * parameters, `var`s and nested function declarations), blocks (`let`,
 * `const`, `class`) and catch clauses.
 */
function scopeDeclarations(ast) {
	const declared = new Map();
	const add = (node, names) => {
		if (!declared.has(node)) declared.set(node, new Set());
		for (const name of names) declared.get(node).add(name);
	};
	walk.fullAncestor(ast, (node, _state, ancestors) => {
		const up = ancestors.slice(0, -1).reverse();
		const nearestFunction = () =>
			up.find((a) => FUNCTION_TYPES.has(a.type) || a.type === "Program");
		const nearestBlock = () =>
			up.find((a) => BLOCK_TYPES.has(a.type) || FUNCTION_TYPES.has(a.type));
		if (FUNCTION_TYPES.has(node.type)) {
			add(
				node,
				node.params.flatMap((p) => patternNames(p)),
			);
			if (node.type === "FunctionExpression" && node.id)
				add(node, [node.id.name]);
			if (node.type === "FunctionDeclaration" && node.id)
				add(nearestFunction(), [node.id.name]);
		} else if (node.type === "VariableDeclaration") {
			const names = node.declarations.flatMap((d) => patternNames(d.id));
			add(node.kind === "var" ? nearestFunction() : nearestBlock(), names);
		} else if (node.type === "ClassDeclaration" && node.id) {
			add(nearestBlock(), [node.id.name]);
		} else if (node.type === "CatchClause" && node.param) {
			add(node, patternNames(node.param));
		} else if (
			node.type === "ImportSpecifier" ||
			node.type === "ImportDefaultSpecifier" ||
			node.type === "ImportNamespaceSpecifier"
		) {
			add(ast, [node.local.name]);
		}
	});
	return declared;
}

/** Whether an Identifier node, with its ancestors, is a reference (not a key, label or declaration). */
function isReference(node, parent) {
	if (!parent) return true;
	switch (parent.type) {
		case "MemberExpression":
			return parent.object === node || parent.computed;
		case "Property":
			return parent.value === node || (parent.computed && parent.key === node);
		case "MethodDefinition":
		case "PropertyDefinition":
			return parent.computed && parent.key === node;
		case "LabeledStatement":
		case "BreakStatement":
		case "ContinueStatement":
		case "MetaProperty":
			return false;
		case "ExportSpecifier":
			return parent.local === node;
		case "ImportSpecifier":
		case "ImportDefaultSpecifier":
		case "ImportNamespaceSpecifier":
			return false;
		case "VariableDeclarator":
			return parent.init === node;
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ClassDeclaration":
		case "ClassExpression":
			return parent.body === node;
		case "CatchClause":
			return parent.param !== node;
		default:
			return true;
	}
}

/** Every reference to one of `names` that no enclosing scope of the module declares. */
function freeReferences(ast, names) {
	const declared = scopeDeclarations(ast);
	const found = [];
	walk.fullAncestor(ast, (node, _state, ancestors) => {
		if (node.type !== "Identifier" || !names.has(node.name)) return;
		const parent = ancestors[ancestors.length - 2];
		if (!isReference(node, parent)) return;
		const bound = ancestors
			.slice(0, -1)
			.some((scope) => declared.get(scope)?.has(node.name));
		if (!bound) found.push({ node, ancestors: ancestors.slice() });
	});
	return found;
}

function literalStrings(arrayNode) {
	if (arrayNode?.type !== "ArrayExpression") return null;
	return arrayNode.elements.map((element) =>
		element && element.type === "Literal" && typeof element.value === "string"
			? element.value
			: refuse(
					"An AMD dependency list holds something other than string literals.",
				),
	);
}

// webpack's AMD define (AMDDefineDependencyParserPlugin with its runtime):
// dependencies "require", "exports" and "module" are the module's own; any
// other is loaded as a module when define runs (or is a local module a named
// define declared); a factory is called with them (with require, exports and
// module when it names none) and the module's exports object as `this`, and
// what it returns, when it returns something, becomes the module's exports;
// an object is the exports itself; a named define declares a local module and
// leaves the module's exports alone.
function amdPrelude(dependencies) {
	const table = dependencies
		.map(
			(dep) =>
				`${JSON.stringify(dep)}: function () { return require(${JSON.stringify(dep)}); }`,
		)
		.join(", ");
	return (
		"var __proofAmdModules = {" +
		table +
		"}, __proofAmdLocal = {};" +
		"function __proofAmdDependency(name) {" +
		' if (name === "require") return require;' +
		' if (name === "exports") return exports;' +
		' if (name === "module") return module;' +
		" if (Object.prototype.hasOwnProperty.call(__proofAmdLocal, name)) return __proofAmdLocal[name];" +
		" if (!Object.prototype.hasOwnProperty.call(__proofAmdModules, name)) throw new Error(" +
		'"proof editor bundle: this module defines an AMD dependency its source does not list literally: " + name);' +
		" return __proofAmdModules[name](); }" +
		"var define = function (name, deps, factory) {" +
		' if (typeof name !== "string") { factory = deps; deps = name; name = null; }' +
		" if (!Array.isArray(deps)) { factory = deps; deps = null; }" +
		' var result = typeof factory === "function"' +
		"  ? factory.apply(exports, deps ? deps.map(__proofAmdDependency) : [require, exports, module])" +
		"  : factory;" +
		" if (name) { __proofAmdLocal[name] = result; } else if (result !== undefined) { module.exports = result; }" +
		"}; define.amd = {};"
	);
}

const packageTypes = new Map();

/** The `type` of the package a file belongs to (its nearest package.json), as webpack reads it. */
function packageType(file) {
	const dir = path.dirname(file);
	if (packageTypes.has(dir)) return packageTypes.get(dir);
	let type = null;
	const manifest = path.join(dir, "package.json");
	if (existsSync(manifest)) {
		try {
			type = JSON.parse(readFileSync(manifest, "utf8")).type ?? null;
		} catch {
			refuse(`The harness could not read ${manifest}.`);
		}
	} else if (dir !== path.dirname(dir) && dir !== HQ) {
		type = packageType(dir);
	}
	packageTypes.set(dir, type);
	return type;
}

// Statements that load another module where they stand once compiled to
// CommonJS; an ES module evaluates them all before its own body.
const LOADING_STATEMENTS = new Set([
	"ImportDeclaration",
	"ExportAllDeclaration",
]);

function loadsModule(statement) {
	return (
		LOADING_STATEMENTS.has(statement.type) ||
		(statement.type === "ExportNamedDeclaration" && statement.source !== null)
	);
}

/**
 * Whether webpack parses the file as an ES module (strict harmony):
 * HarmonyDetectionParserPlugin makes a module with an import or export
 * statement one, and webpack's module type javascript/esm (a .mjs file, or a
 * file of a package whose type is "module") makes any module one.
 */
function isEsModule(ast, file) {
	return (
		file.endsWith(".mjs") ||
		packageType(file) === "module" ||
		ast.body.some((s) => /^(Import|Export)/.test(s.type))
	);
}

/** Fails the build when compiling an ES module to a CommonJS module of its own would change its meaning. */
function checkStrictModule(ast, file) {
	const free = freeReferences(ast, new Set(["module", "exports"]));
	if (free.length) {
		refuse(
			`${file} is an ES module that reads a free \`${free[0].node.name}\`, which webpack leaves to the page and a CommonJS module of its own would answer.`,
		);
	}
}

/**
 * The ES module with every statement that loads another module moved ahead
 * of its body, in their own order, as an ES module evaluates them (a
 * CommonJS module of its own loads each where it stands). Each moved
 * statement leaves an empty statement behind, so no two statements run
 * together. Null when every load already comes first.
 */
function hoistLoads(source, ast) {
	const firstBody = ast.body.findIndex((statement) => !loadsModule(statement));
	const late = ast.body.filter(
		(statement, index) =>
			firstBody !== -1 && index > firstBody && loadsModule(statement),
	);
	if (!late.length) return null;
	const loads = ast.body.filter(loadsModule);
	let body = "";
	let at = 0;
	for (const statement of loads) {
		body += `${source.slice(at, statement.start)};`;
		at = statement.end;
	}
	body += source.slice(at);
	const head = loads
		.map((statement) => `${source.slice(statement.start, statement.end)};\n`)
		.join("");
	return { contents: head + body, moved: late.length };
}

/**
 * An ES module compiled to a CommonJS module of its own that runs strict, as
 * webpack runs every ES module (see the header).
 */
async function strictModule(contents, file) {
	let compiled;
	try {
		compiled = await esbuild.transform(contents, {
			format: "cjs",
			loader: "js",
			sourcefile: file,
			target: "esnext",
			logLevel: "silent",
		});
	} catch (error) {
		refuse(
			`The harness could not compile the ES module ${file} to a strict module of its own: ${error.errors?.map((e) => e.text).join("; ") ?? error.message}`,
		);
	}
	return `"use strict";\n${compiled.code}`;
}

/** The module's source with webpack's parser-level semantics applied, and which ones were. */
function transformJavaScript(source, file, rules) {
	const applied = [];
	const mayUse =
		file.endsWith(".mjs") ||
		packageType(file) === "module" ||
		source.includes("define") ||
		source.includes("import") ||
		source.includes("export") ||
		source.includes("require");
	let ast = null;
	let esModule = false;
	const edits = [];
	let prefix = "";
	let suffix = "";
	if (mayUse) {
		ast = parseModule(source, file);
		const isModule = ast.sourceType === "module" && isEsModule(ast, file);
		const hoisted = isModule ? hoistLoads(source, ast) : null;
		if (hoisted) {
			source = hoisted.contents;
			ast = parseModule(source, file);
			applied.push({ loadsFirst: hoisted.moved });
		}
		if (
			!isModule &&
			(file.endsWith(".mjs") || packageType(file) === "module")
		) {
			refuse(
				`${file} is an ES module to webpack (a .mjs file, or a package whose type is "module"), and it does not parse as one.`,
			);
		}
		if (isModule) {
			checkStrictModule(ast, file);
			esModule = true;
			applied.push({ strictModule: true });
		}
		const free = freeReferences(ast, new Set(["define", "require"]));
		const defineRefs = free.filter((ref) => ref.node.name === "define");
		for (const ref of free.filter((r) => r.node.name === "require")) {
			const call = ref.ancestors[ref.ancestors.length - 2];
			if (
				call?.type === "CallExpression" &&
				call.callee === ref.node &&
				call.arguments[0]?.type === "ArrayExpression"
			) {
				refuse(
					`${file} makes an AMD require([...], callback), which webpack loads asynchronously; the harness does not reproduce it.`,
				);
			}
		}
		if (defineRefs.length) {
			if (isModule) {
				refuse(
					`${file} is an ES module that uses AMD's define; the harness does not reproduce that.`,
				);
			}
			const dependencies = new Set();
			for (const ref of defineRefs) {
				const call = ref.ancestors[ref.ancestors.length - 2];
				if (call?.type === "CallExpression" && call.callee === ref.node) {
					const args = call.arguments;
					const list =
						literalStrings(args.find((a) => a.type === "ArrayExpression")) ||
						[];
					for (const dep of list) {
						if (!["require", "exports", "module"].includes(dep))
							dependencies.add(dep);
					}
				}
			}
			prefix += amdPrelude([...dependencies].sort());
			applied.push({ amd: [...dependencies].sort() });
		}
		walk.full(ast, (node) => {
			if (
				node.type === "MemberExpression" &&
				node.object.type === "MetaProperty" &&
				node.object.meta.name === "import" &&
				!node.computed &&
				node.property.name === "url"
			) {
				edits.push([
					node.start,
					node.end,
					JSON.stringify(pathToFileURL(file).toString()),
				]);
			}
		});
		if (edits.length) applied.push({ importMetaUrl: edits.length });
	}
	for (const rule of matchingRules(rules, file)) {
		const loaders = loaderNames(rule);
		if (loaders.length === 1 && loaders[0] === "exports-loader") {
			if (esModule) {
				refuse(
					`exports-loader applies to the ES module ${file}, which the harness does not reproduce.`,
				);
			}
			const { type, exports } = rule.options || {};
			if (
				type !== "commonjs" ||
				exports?.syntax !== "single" ||
				typeof exports.name !== "string"
			) {
				refuse(
					`exports-loader applies to ${file} with options the harness does not reproduce.`,
				);
			}
			suffix += `\nmodule.exports = ${exports.name};\n`;
			applied.push({ exportsLoader: exports.name });
		}
	}
	if (!prefix && !suffix && !edits.length)
		return { contents: source, applied, esModule };
	let contents = source;
	for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) {
		contents = contents.slice(0, start) + text + contents.slice(end);
	}
	if (prefix) {
		// After the directive prologue, so a "use strict" module stays strict.
		let at = 0;
		for (const statement of ast.body) {
			if (
				statement.type === "ExpressionStatement" &&
				statement.directive !== undefined
			)
				at = statement.end;
			else break;
		}
		contents = `${contents.slice(0, at)};${prefix}\n${contents.slice(at)}`;
	}
	return { contents: contents + suffix, applied, esModule };
}

// --- The esbuild plugin reproducing webpack's module semantics ------------

function aliasEntries(config) {
	return Object.entries(config.resolve.alias || {}).map(([name, target]) => {
		const onlyModule = name.endsWith("$");
		return { name: onlyModule ? name.slice(0, -1) : name, onlyModule, target };
	});
}

function webpackMirror({ config, folder, record }) {
	const aliases = aliasEntries(config);
	const fallback = config.resolve.fallback || {};
	const rules = ruleList(config);
	const replacements = config.plugins
		.filter(
			(plugin) => plugin.constructor.name === "NormalModuleReplacementPlugin",
		)
		.map((plugin) => {
			if (typeof plugin.newResource !== "string") {
				refuse(
					"HQ's NormalModuleReplacementPlugin computes its replacement; the harness reproduces a fixed one only.",
				);
			}
			return plugin;
		});
	const assetBase = `${STATIC_URL}${folder}/assets`;

	const note = (file, entry) => {
		const relative = path.relative(HQ, file);
		if (!record.applied[relative]) record.applied[relative] = [];
		record.applied[relative].push(entry);
	};

	return {
		name: "hq-webpack-semantics",
		setup(build) {
			async function resolveRequest(request, args, depth = 0) {
				if (depth > 8)
					refuse(
						`Resolving ${request} from ${args.importer} went through more than 8 aliases.`,
					);
				for (const replacement of replacements) {
					if (replacement.resourceRegExp.test(request))
						request = replacement.newResource;
				}
				for (const alias of aliases) {
					const matches =
						request === alias.name ||
						(!alias.onlyModule && request.startsWith(`${alias.name}/`));
					if (!matches) continue;
					if (alias.target === false)
						return { path: request, namespace: "webpack-empty" };
					const next = alias.target + request.slice(alias.name.length);
					const resolved = path.isAbsolute(next)
						? await plain(next, args)
						: await resolveRequest(next, args, depth + 1);
					if (resolved) return resolved;
				}
				const resolved = await plain(request, args);
				if (resolved) return resolved;
				const bare = request.split("/")[0];
				if (Object.hasOwn(fallback, request) || Object.hasOwn(fallback, bare)) {
					const target = Object.hasOwn(fallback, request)
						? fallback[request]
						: fallback[bare];
					if (target === false)
						return { path: request, namespace: "webpack-empty" };
					return resolveRequest(target, args, depth + 1);
				}
				return null;
			}

			async function plain(request, args) {
				let result = await build.resolve(request, {
					resolveDir: args.resolveDir,
					kind: args.kind,
					importer: args.importer,
					pluginData: { plain: true },
				});
				if (result.errors.length || !path.isAbsolute(result.path)) {
					// Where esbuild's resolver finds no file, webpack's own answers
					// (webpackResolve): it completes a package `exports` target
					// with its extensions, where esbuild takes the target as
					// written, and reads a `browser` field's `false` as an empty
					// module.
					const answered = await webpackResolve(
						config.mode,
						request,
						args.resolveDir,
						args.kind,
					);
					if (answered === undefined) return null;
					note(args.importer, { webpackResolved: request });
					if (answered === false)
						return { path: request, namespace: "webpack-empty" };
					result = { path: answered, namespace: "file" };
				}
				let file = result.path;
				for (const replacement of replacements) {
					if (replacement.resourceRegExp.test(file)) {
						file = path.resolve(path.dirname(file), replacement.newResource);
					}
				}
				return { ...result, path: file };
			}

			build.onResolve({ filter: /.*/ }, async (args) => {
				if (args.pluginData?.plain) return undefined;
				if (args.kind === "entry-point") {
					if (args.path.startsWith(`${ENTRY_NAMESPACE}:`)) {
						return {
							path: args.path.slice(ENTRY_NAMESPACE.length + 1),
							namespace: ENTRY_NAMESPACE,
						};
					}
					return undefined;
				}
				if (args.path.startsWith("data:"))
					return { path: args.path, external: true };
				const external = await externalFor(
					config.externals,
					args.path,
					args.resolveDir,
					args.importer,
				);
				if (external !== undefined) {
					refuse(
						`HQ's webpack externals make "${args.path}" (from ${args.importer}) the external ${JSON.stringify(external)}; the harness bundles every module.`,
					);
				}
				record.externalsAsked = (record.externalsAsked ?? 0) + 1;
				const resolved = await resolveRequest(args.path, args);
				if (!resolved) {
					return {
						errors: [
							{
								text: `HQ's webpack configuration resolves no module for "${args.path}" (from ${args.importer}).`,
							},
						],
					};
				}
				return {
					path: resolved.path,
					namespace: resolved.namespace || "file",
					sideEffects: resolved.sideEffects,
				};
			});

			build.onLoad({ filter: /.*/, namespace: "webpack-empty" }, () => ({
				contents: "module.exports = {};",
				loader: "js",
			}));

			build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, (args) => ({
				contents: `require(${JSON.stringify(args.path)});\n`,
				loader: "js",
				resolveDir: path.dirname(args.path),
			}));

			build.onLoad({ filter: /\.(c|m)?js$/ }, async (args) => {
				const source = readFileSync(args.path, "utf8");
				// The ProvidePlugin module is esbuild's inject file, which esbuild
				// reads as the ES module it is (its exports are the provided names).
				if (args.path.startsWith(PROVIDE_DIR + path.sep)) {
					return { contents: source, loader: "js" };
				}
				const { contents, applied, esModule } = transformJavaScript(
					source,
					args.path,
					rules,
				);
				for (const entry of applied) note(args.path, entry);
				if (esModule) record.strictModules = (record.strictModules ?? 0) + 1;
				return {
					contents: esModule
						? await strictModule(contents, args.path)
						: contents,
					loader: "js",
					resolveDir: path.dirname(args.path),
				};
			});

			build.onLoad({ filter: /\.(css|less)$/ }, async (args) => {
				const matched = matchingRules(rules, args.path);
				const styleRule = matched.find(
					(rule) => loaderNames(rule)[0] === "style-loader",
				);
				if (!styleRule) {
					refuse(
						`No rule of HQ's webpack configuration loads the stylesheet ${args.path}.`,
					);
				}
				const loaders = loaderNames(styleRule);
				let cssText;
				if (loaders.join("+") === "style-loader+css-loader") {
					cssText = await bundleStylesheet(
						args.path,
						readFileSync(args.path, "utf8"),
					);
				} else if (
					loaders.join("+") === "style-loader+css-loader+less-loader"
				) {
					const lessOptions =
						[].concat(styleRule.use).find((u) => u.loader === "less-loader")
							?.options?.lessOptions || {};
					const less = hq("less");
					const compiled = await less.render(readFileSync(args.path, "utf8"), {
						...lessOptions,
						filename: args.path,
					});
					cssText = await bundleStylesheet(args.path, compiled.css);
				} else {
					refuse(
						`HQ loads ${args.path} with ${loaders.join(" + ")}, which the harness does not reproduce.`,
					);
				}
				note(args.path, { injectedStylesheet: loaders.join("+") });
				// style-loader's default: a <style> element appended to <head> when the module runs.
				return {
					contents:
						"var style = document.createElement('style');" +
						`style.textContent = ${JSON.stringify(cssText)};` +
						"document.head.appendChild(style);",
					loader: "js",
				};
			});

			async function bundleStylesheet(file, css) {
				const result = await esbuild.build({
					stdin: {
						contents: css,
						resolveDir: path.dirname(file),
						sourcefile: file,
						loader: "css",
					},
					bundle: true,
					write: false,
					outdir: path.join(OUT, "static", folder, "assets"),
					publicPath: assetBase,
					assetNames: "[name]-[hash]",
					logLevel: "silent",
					plugins: [assetPlugin(rules, (entry) => note(file, entry))],
				});
				for (const output of result.outputFiles) {
					if (!output.path.endsWith(".css")) {
						mkdirSync(path.dirname(output.path), { recursive: true });
						writeFileSync(output.path, output.contents);
					}
				}
				const css_ = result.outputFiles.find((output) =>
					output.path.endsWith(".css"),
				);
				return css_ ? css_.text : "";
			}

			// Any other file a module imports: asset/resource by HQ's rules, or JSON.
			build.onLoad({ filter: /\.[^./]+$/ }, (args) => {
				if (args.path.endsWith(".json")) return undefined;
				return assetLoad(rules, args.path, (entry) => note(args.path, entry));
			});
		},
	};
}

function assetLoad(rules, file, note) {
	const rule = matchingRules(rules, file).find(
		(r) => r.type === "asset/resource",
	);
	if (!rule) {
		refuse(`No rule of HQ's webpack configuration loads ${file}.`);
	}
	note({ assetResource: String(rule.test) });
	return { contents: readFileSync(file), loader: "file" };
}

function assetPlugin(rules, note) {
	return {
		name: "hq-webpack-assets",
		setup(build) {
			build.onResolve({ filter: /^data:/ }, (args) => ({
				path: args.path,
				external: true,
			}));
			build.onLoad({ filter: /\.[^./]+$/ }, (args) => {
				if (args.path.endsWith(".css")) return undefined;
				return assetLoad(rules, args.path, note);
			});
		},
	};
}

/** esbuild's options for one flavour of HQ's configuration. */
function esbuildOptions(flavour, record, extra = {}) {
	const provide = flavour.config.plugins.find(
		(p) => p.constructor.name === "ProvidePlugin",
	);
	// ProvidePlugin: each free name is `require(<request>)` (or a member of
	// it), resolved as from any of HQ's sources (HQ's root holds node_modules).
	const injected = path.join(PROVIDE_DIR, `provide-${flavour.folder}.js`);
	const definitions = Object.entries(provide ? provide.definitions : {});
	writeFileSync(
		injected,
		definitions
			.map(([name, request], i) => {
				const [module, ...members] = [].concat(request);
				const access = members.map((m) => `[${JSON.stringify(m)}]`).join("");
				return `var provided${i} = require(${JSON.stringify(module)})${access};\nexport { provided${i} as ${JSON.stringify(name)} };`;
			})
			.join("\n"),
	);
	const mode = flavour.config.mode;
	if (mode !== "production")
		refuse(`HQ's production webpack configuration has mode ${mode}.`);
	return {
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "esnext",
		write: true,
		metafile: true,
		logLevel: "silent",
		mainFields: WEBPACK_MAIN_FIELDS,
		conditions: webpackConditions(mode),
		resolveExtensions: WEBPACK_EXTENSIONS,
		inject: [injected],
		define: {
			// webpack's node defaults for a web target: `global` is the global
			// object, __filename and __dirname are mocked.
			global: "globalThis",
			__filename: JSON.stringify("/index.js"),
			__dirname: JSON.stringify("/"),
			"process.env.NODE_ENV": JSON.stringify(mode),
		},
		assetNames: "assets/[name]-[hash]",
		publicPath: `${STATIC_URL}${flavour.folder}`,
		plugins: [
			webpackMirror({ config: flavour.config, folder: flavour.folder, record }),
		],
		...extra,
	};
}

function inputsOf(metafile) {
	const inputs = Object.keys(metafile.inputs)
		.map((input) => input.replace(/^[a-z-]+:/, ""))
		.map((input) => (path.isAbsolute(input) ? input : path.resolve(input)))
		.map((input) => path.relative(HQ, input));
	return [...new Set(inputs)].sort();
}

async function buildPageEntries(flavours, report) {
	const manifests = new Map(flavours.map((f) => [f.manifest, {}]));
	for (const entry of PAGE_ENTRIES) {
		const owners = flavours.filter((f) => f.config.entry[entry]);
		if (owners.length !== 1) {
			refuse(
				`HQ's webpack configurations name the page entry ${entry} ${owners.length} times; the harness expects exactly one.`,
			);
		}
		const [flavour] = owners;
		const source = flavour.config.entry[entry].import;
		checkBabelIsIdentity(source);
		const record = { applied: {} };
		const outdir = path.join(OUT, "static", flavour.folder);
		const started = Date.now();
		const result = await esbuild.build(
			esbuildOptions(flavour, record, {
				entryPoints: { [entry]: `${ENTRY_NAMESPACE}:${source}` },
				outdir,
			}),
		);
		manifests.get(flavour.manifest)[entry] = [`${entry}.js`];
		report.pages.push({
			entry,
			folder: flavour.folder,
			manifest: flavour.manifest,
			source: path.relative(HQ, source),
			bundle: path.join("static", flavour.folder, `${entry}.js`),
			seconds: (Date.now() - started) / 1000,
			strictModules: record.strictModules ?? 0,
			externalsAsked: record.externalsAsked ?? 0,
			inputs: inputsOf(result.metafile),
			applied: record.applied,
		});
	}
	// HQ reads the manifests where its own build writes them.
	const manifestDir = hqBuildArtifactsDir();
	mkdirSync(manifestDir, { recursive: true });
	for (const [name, manifest] of manifests) {
		writeFileSync(
			path.join(manifestDir, name),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);
	}
	report.manifests = [...manifests.keys()].map((name) =>
		path.join(manifestDir, name),
	);
}

// --- The Vellum host --------------------------------------------------------

function sourceOf(source, node) {
	return source.slice(node.start, node.end);
}

function isCall(node, object, property) {
	return (
		node?.type === "CallExpression" &&
		node.callee.type === "MemberExpression" &&
		!node.callee.computed &&
		node.callee.object.type === "Identifier" &&
		node.callee.object.name === object &&
		node.callee.property.name === property
	);
}

function objectKeys(node) {
	return node.properties
		.map((p) => (p.key.type === "Identifier" ? p.key.name : p.key.value))
		.sort();
}

/**
 * What HQ's form designer page adds to the options the server renders:
 * `_.extend({}, initialPageData.get("vellum_options"), <additions>)`, and the
 * callbacks it then adds with `VELLUM_OPTIONS.core = _.extend(VELLUM_OPTIONS.core, {...})`.
 */
function formDesignerAdditions(file) {
	const source = readFileSync(file, "utf8");
	const ast = parseModule(source, file);
	const additions = [];
	const coreCallbacks = [];
	walk.full(ast, (node) => {
		if (!isCall(node, "_", "extend")) return;
		const [first, second, third] = node.arguments;
		if (
			first?.type === "ObjectExpression" &&
			first.properties.length === 0 &&
			isCall(second, "initialPageData", "get") &&
			second.arguments[0]?.value === "vellum_options" &&
			third?.type === "ObjectExpression"
		) {
			additions.push(third);
		}
		if (
			first?.type === "MemberExpression" &&
			first.property.name === "core" &&
			second?.type === "ObjectExpression"
		) {
			coreCallbacks.push(...objectKeys(second));
		}
	});
	if (additions.length !== 1) {
		refuse(
			`HQ's ${path.relative(HQ, file)} merges ${additions.length} objects over the server's Vellum options; the harness expects one.`,
		);
	}
	const [addition] = additions;
	const keys = objectKeys(addition);
	if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_PAGE_OPTION_KEYS)) {
		refuse(
			`HQ's form designer page now adds the Vellum options ${keys.join(", ")} (the harness knows ${EXPECTED_PAGE_OPTION_KEYS.join(", ")}).`,
		);
	}
	if (
		JSON.stringify(coreCallbacks.sort()) !==
		JSON.stringify(EXPECTED_CORE_CALLBACKS)
	) {
		refuse(
			`HQ's form designer page now adds the core callbacks ${coreCallbacks.join(", ")} (the harness observes ${EXPECTED_CORE_CALLBACKS.join(", ")}).`,
		);
	}
	// The additions run in the host with the modules the page imports under the
	// same names; anything else they read must be a browser global.
	const imports = new Map();
	for (const statement of ast.body) {
		if (statement.type !== "ImportDeclaration") continue;
		for (const specifier of statement.specifiers) {
			if (specifier.type !== "ImportDefaultSpecifier")
				refuse(
					`${file} imports ${specifier.local.name} in a way the host does not reproduce.`,
				);
			imports.set(specifier.local.name, statement.source.value);
		}
	}
	const wrapped = parseModule(`(${sourceOf(source, addition)})`, file);
	const names = new Set(imports.keys());
	const used = new Set(
		freeReferences(wrapped, names).map((ref) => ref.node.name),
	);
	return {
		additions: sourceOf(source, addition),
		imports: [...used].sort().map((name) => [name, imports.get(name)]),
		coreCallbacks,
	};
}

async function buildVellumHost(flavours, report) {
	const owners = flavours.filter((f) => f.config.entry[FORM_DESIGNER_ENTRY]);
	if (owners.length !== 1) {
		refuse(
			`HQ's webpack configurations name the form designer entry ${FORM_DESIGNER_ENTRY} ${owners.length} times.`,
		);
	}
	const [flavour] = owners;
	const designer = flavour.config.entry[FORM_DESIGNER_ENTRY].import;
	const { additions, imports, coreCallbacks } = formDesignerAdditions(designer);
	const hostDir = path.join(OUT, "static", "vellum");
	mkdirSync(hostDir, { recursive: true });
	// The host's own imports, each a request HQ's form designer page graph makes:
	// jquery and underscore (form_designer.js), bootstrap (Bootstrap 3, through
	// commcarehq for Bootstrap 3 pages), select2 (app_manager/js/bootstrap3/app_manager)
	// and jquery.vellum.prod (form_designer.js's require, aliased to HQ's vendored build).
	const hostImports = new Map([
		["$", "jquery"],
		["_", "underscore"],
		...imports,
	]);
	// Resolved from the form designer's own directory, as its imports are.
	const hostScript = [
		"// The Vellum host page's script, generated by proof/image/editors/build.mjs.",
		...[...hostImports].map(
			([name, request]) => `import ${name} from ${JSON.stringify(request)};`,
		),
		'import "bootstrap";',
		'import "select2/dist/js/select2.full.min";',
		'import "jquery.vellum.prod";',
		"window.proofVellumHost = {",
		"\tjQuery: $,",
		"\tunderscore: _,",
		`\t// What ${path.relative(HQ, designer)} adds to the server's Vellum options, as it wrote it,`,
		"\t// strict as that ES module runs.",
		`\tpageOptions: function () { "use strict"; return (${additions}); },`,
		`\tcoreCallbacks: ${JSON.stringify(coreCallbacks)},`,
		"};",
		"",
	].join("\n");
	const record = { applied: {} };
	const started = Date.now();
	const result = await esbuild.build(
		esbuildOptions(flavour, record, {
			stdin: {
				contents: hostScript,
				resolveDir: path.dirname(designer),
				sourcefile: "proof-vellum-host.js",
				loader: "js",
			},
			entryNames: "host",
			outdir: hostDir,
			publicPath: `${STATIC_URL}vellum`,
		}),
	);
	// The page the driver opens. Only what HQ's site frame gives every page:
	// the CSRF token input and the page data containers HQ's modules read.
	writeFileSync(
		path.join(hostDir, "host.html"),
		[
			"<!doctype html>",
			'<html><head><meta charset="utf-8"><title>Vellum host</title></head>',
			"<body>",
			'<input id="csrfTokenContainer" type="hidden" value="proof-csrf-token">',
			'<div id="formdesigner" class="clearfix"></div>',
			'<div class="initial-page-data hide"></div>',
			'<div class="commcarehq-urls hide"></div>',
			'<div class="initial-analytics-data hide"></div>',
			'<div class="analytics-ab-tests hide"></div>',
			`<script src="${STATIC_URL}vellum/host.js"></script>`,
			"</body></html>",
			"",
		].join("\n"),
	);
	const vellumDir = path.join(
		HQ,
		"corehq/apps/app_manager/static/app_manager/js/vellum",
	);
	report.vellum = {
		formDesigner: path.relative(HQ, designer),
		folder: flavour.folder,
		version: readFileSync(path.join(vellumDir, "version.txt"), "utf8").trim(),
		host: path.relative(OUT, path.join(hostDir, "host.html")),
		bundle: path.join("static", "vellum", "host.js"),
		seconds: (Date.now() - started) / 1000,
		strictModules: record.strictModules ?? 0,
		externalsAsked: record.externalsAsked ?? 0,
		imports: Object.fromEntries(hostImports),
		coreCallbacks,
		inputs: inputsOf(result.metafile),
		applied: record.applied,
	};
}

async function main() {
	if (!existsSync(path.join(HQ, "manage.py"))) {
		throw new BuildRefused(`There is no CommCare HQ checkout at ${HQ}.`);
	}
	if (!statSync(path.join(HQ, "node_modules")).isDirectory()) {
		throw new BuildRefused(
			`HQ's node packages are not installed at ${HQ}/node_modules.`,
		);
	}
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });
	mkdirSync(PROVIDE_DIR, { recursive: true });
	const started = Date.now();
	const flavours = hqWebpackConfigurations();
	const report = {
		hq: HQ,
		staticUrl: STATIC_URL,
		staticDir: "static",
		node: process.version,
		esbuild: esbuild.version,
		webpack: hq("webpack/package.json").version,
		flavours: flavours.map((f) => ({
			folder: f.folder,
			manifest: f.manifest,
			aliases: Object.keys(f.config.resolve.alias || {}).length,
			provide: Object.keys(
				f.config.plugins.find((p) => p.constructor.name === "ProvidePlugin")
					?.definitions || {},
			),
			fallback: f.config.resolve.fallback || {},
			externals: [].concat(f.config.externals ?? []).length,
			mode: f.config.mode,
		})),
		pages: [],
	};
	await buildPageEntries(flavours, report);
	await buildVellumHost(flavours, report);
	rmSync(PROVIDE_DIR, { recursive: true, force: true });
	report.seconds = (Date.now() - started) / 1000;
	writeFileSync(
		path.join(OUT, "build.json"),
		`${JSON.stringify(report, null, "\t")}\n`,
	);
	for (const page of report.pages) {
		console.log(
			`${page.entry} (${page.folder}): ${page.inputs.length} modules (${page.strictModules} ES modules run strict), ${page.seconds} s`,
		);
	}
	console.log(
		`Vellum host (${report.vellum.folder}): ${report.vellum.inputs.length} modules (${report.vellum.strictModules} ES modules run strict), ${report.vellum.seconds} s`,
	);
	console.log(`HQ's manifests: ${report.manifests.join(", ")}`);
}

main().catch((error) => {
	if (error.errors?.length) {
		console.error(
			`esbuild refused the editor bundles:\n${error.errors.map((e) => `- ${e.text}`).join("\n")}`,
		);
	} else {
		console.error(error instanceof BuildRefused ? error.message : error.stack);
	}
	process.exit(1);
});
