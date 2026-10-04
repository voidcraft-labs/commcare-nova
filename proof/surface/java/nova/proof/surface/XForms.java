package nova.proof.surface;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.ArrayCreationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.AssignExpr;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.BooleanLiteralExpr;
import com.github.javaparser.ast.expr.CastExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.IntegerLiteralExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NullLiteralExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.expr.UnaryExpr;
import com.github.javaparser.ast.expr.VariableDeclarationExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.stmt.BreakStmt;
import com.github.javaparser.ast.stmt.ContinueStmt;
import com.github.javaparser.ast.stmt.DoStmt;
import com.github.javaparser.ast.stmt.ExpressionStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ForStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.LabeledStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.stmt.Statement;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.SwitchStmt;
import com.github.javaparser.ast.stmt.ThrowStmt;
import com.github.javaparser.ast.stmt.TryStmt;
import com.github.javaparser.ast.stmt.WhileStmt;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * What Core's XForm parser reads from a form: every element it dispatches, tests for or walks, every
 * attribute it reads on each, with its namespace, the values it compares an attribute with, and
 * whether the value is parsed as XPath.
 *
 * XFormParser works over a kXML document tree, so the reader follows element values rather than a
 * pull parser's position. Each handler of the parser's tables (`topLevelHandlers`,
 * `groupLevelHandlers`, `actionHandlers`, read from the source with each key checked against the
 * tables Core's compiled class holds, plus the handlers Android registers) is entered with its
 * element at the path of its key. Inside a method, an element value is followed through locals,
 * parameters, fields, vectors and casts: `X.getElement(i)` and `X.getChild(i)` are a child of X
 * (`X/*`), and a test of the child's name (`"label".equals(child.getName())`, a local holding the
 * name, `.toLowerCase()`, a table's `containsKey`, a list's `contains`, a helper returning such a
 * test) or namespace narrows it (`repeat/jr:addCaption`). A call to a table's handler
 * (`handlers.get(name).handle(this, e, parent)`) enters the handler of each key the element can
 * have, at that key's path. A method entered again on a descendant of the element it is already
 * reading collapses to `X//*`. Statements that only report (a `reporter` call, a print, a thrown
 * exception's message, an `if` holding only those) are not reads.
 *
 * Integer and boolean state the parser branches on is followed where it is a parameter passed a
 * constant (`parseGroup(..., CONTAINER_REPEAT)`) or a flag set from one (`group.setIsRepeat(true)`
 * read back by `group.isRepeat()`), so a read under `isRepeat()` sits on `repeat` and not `group`.
 * Such a value stays known past a point several paths reach (the end of an `if`, a loop, whose
 * `break`s and `continue`s are paths out of it, a `switch`, a `try` and its handlers) only where
 * every path agrees on it; otherwise a later test of it reads both branches.
 */
final class XForms {
    static final String JAVAROSA = "http://openrosa.org/javarosa";

    /** A handler a table holds: a lambda (with the handler its wrapper captured) or a class. */
    static final class Handler {
        final LambdaExpr lambda;
        final TypeDeclaration<?> type;
        final Handler captured;
        final String captureName;

        Handler(LambdaExpr lambda, TypeDeclaration<?> type, Handler captured, String captureName) {
            this.lambda = lambda;
            this.type = type;
            this.captured = captured;
            this.captureName = captureName;
        }

        String describe(Code code) {
            if (lambda != null) {
                return code.where(lambda) + " (lambda)";
            }
            return code.where(type);
        }
    }

    private final Code code;
    private final TypeDeclaration<?> parser;
    /** Table field -> key -> handlers. */
    private final Map<String, Map<String, List<Handler>>> tables = new TreeMap<>();
    /** Element path -> facts. */
    private final Map<String, Map<String, Object>> elements = new TreeMap<>();
    /** "path@attribute" -> facts. */
    private final Map<String, Map<String, Object>> attributes = new TreeMap<>();
    /** Field -> element paths it holds (an Element field, or a vector of them). */
    private final Map<String, Set<String>> fields = new TreeMap<>();
    /** Element paths a test narrowed to the XForms namespace (written bare, like a step of any namespace). */
    private final Set<String> xformsNamespaced = new TreeSet<>();
    /** Extension parser classes Android registers, with the element each sets. */
    private final Map<String, String> extensionParsers = new TreeMap<>();
    private boolean fieldsChanged;
    private final Set<String> visited = new HashSet<>();
    /** Memo key of a method entered -> the attribute values it returns. */
    private final Map<String, Set<String>> returned = new HashMap<>();
    /** The memo key of the method being read, so its returns are recorded. */
    private String reading;
    private final List<Object[]> stack = new ArrayList<>();
    private TypeDeclaration<?> context;
    /** The loops, switches and labelled blocks the statement being read is inside, innermost last. */
    private List<Exits> exits = new ArrayList<>();
    /** A label read on a loop or switch, which it takes when it is entered. */
    private String pendingLabel;

    /** A loop, switch or labelled block, with the states its `break`s and `continue`s carry out of it. */
    static final class Exits {
        enum Kind { LOOP, SWITCH, BLOCK }

        final Kind kind;
        final String label;
        final List<Frame> breaks = new ArrayList<>();
        final List<Frame> continues = new ArrayList<>();

        Exits(Kind kind, String label) {
            this.kind = kind;
            this.label = label;
        }
    }

    /**
     * The conditions under which a local holds an element at a path, as tokens the manifest checks evaluate on an
     * export's element (proof/checks/manifest_usage.py): `not-named:<name>` (a name test the element failed:
     * its local name is not that one), `childless` (it stands where a test found none of its element children),
     * `without:<attribute>` (a test found that attribute absent), and `first` (it is the first value a field
     * takes: the first element of its path Core meets). A path held without a condition has none recorded.
     */
    static final class Conditions {
        static final String CHILDLESS = "childless";
        static final String FIRST = "first";

        static Map<String, Set<String>> copy(Map<String, Set<String>> held) {
            Map<String, Set<String>> out = new TreeMap<>();
            held.forEach((path, conditions) -> out.put(path, new TreeSet<>(conditions)));
            return out;
        }

        /** The conditions `from` holds `local`'s path under, against `into`'s: a path both hold keeps those both agree on. */
        static void merge(Frame into, Frame from) {
            for (Map.Entry<String, Set<String>> held : from.elems.entrySet()) {
                String local = held.getKey();
                Set<String> already = into.elems.getOrDefault(local, Set.of());
                Map<String, Set<String>> fromConditions = from.conditions.getOrDefault(local, Map.of());
                Map<String, Set<String>> merged = copy(into.conditions.getOrDefault(local, Map.of()));
                for (String path : held.getValue()) {
                    Set<String> theirs = fromConditions.getOrDefault(path, Set.of());
                    if (already.contains(path)) {
                        Set<String> ours = merged.getOrDefault(path, Set.of());
                        Set<String> both = new TreeSet<>(ours);
                        both.retainAll(theirs);
                        put(merged, path, both);
                    } else {
                        put(merged, path, theirs);
                    }
                }
                if (merged.isEmpty()) {
                    into.conditions.remove(local);
                } else {
                    into.conditions.put(local, merged);
                }
            }
            into.nullChildrenOf.entrySet().removeIf(entry -> !entry.getValue().equals(from.nullChildrenOf.get(entry.getKey())));
            into.nullFields.retainAll(from.nullFields);
        }

        static void put(Map<String, Set<String>> held, String path, Set<String> conditions) {
            if (conditions.isEmpty()) {
                held.remove(path);
            } else {
                held.put(path, new TreeSet<>(conditions));
            }
        }

        /** Adds `condition` to every path `local` holds. */
        static void add(Frame frame, String local, Set<String> paths, String condition) {
            Map<String, Set<String>> held = frame.conditions.computeIfAbsent(local, k -> new TreeMap<>());
            for (String path : paths) {
                held.computeIfAbsent(path, k -> new TreeSet<>()).add(condition);
            }
        }

        /** Two sources' conditions on the paths both may hold (a conditional's branches): those both agree on. */
        static Map<String, Set<String>> union(Map<String, Set<String>> left, Set<String> leftPaths,
                                              Map<String, Set<String>> right, Set<String> rightPaths) {
            Map<String, Set<String>> out = new TreeMap<>();
            Set<String> all = new TreeSet<>(leftPaths);
            all.addAll(rightPaths);
            for (String path : all) {
                Set<String> conditions;
                if (leftPaths.contains(path) && rightPaths.contains(path)) {
                    conditions = new TreeSet<>(left.getOrDefault(path, Set.of()));
                    conditions.retainAll(right.getOrDefault(path, Set.of()));
                } else {
                    conditions = new TreeSet<>((leftPaths.contains(path) ? left : right).getOrDefault(path, Set.of()));
                }
                put(out, path, conditions);
            }
            return out;
        }
    }

    /** Field -> element path -> the conditions every assignment of it made (`Conditions`). */
    private final Map<String, Map<String, Set<String>>> fieldConditions = new TreeMap<>();
    /** "path@xmlns" -> the conditions of each read of the element's namespace, one set per read. */
    private final Map<String, Set<List<String>>> namespaceReads = new TreeMap<>();
    /** Whether the expression being read is bound to a local, where a namespace it reads is read when used. */
    private boolean deferringNamespace;

    private XForms(Code code) {
        this.code = code;
        this.parser = code.type("XFormParser");
        if (parser == null) {
            throw new IllegalStateException("Core's XFormParser is not among the parsed sources.");
        }
    }

    /**
     * Reads the parser. `registrations` are Android's registrations (JavaRosa.androidRegistrations):
     * handlers, action handlers and extension parsers.
     */
    static Map<String, Object> read(Code code, List<Object> registrations) throws Exception {
        XForms reader = new XForms(code);
        reader.collectTables(registrations);
        reader.checkTables();
        int rounds = 0;
        do {
            reader.fieldsChanged = false;
            reader.visited.clear();
            reader.elements.clear();
            reader.attributes.clear();
            reader.namespaceReads.clear();
            reader.document();
            if (++rounds > 10) {
                throw new IllegalStateException("The XForm reader's field flow did not settle in ten rounds.");
            }
        } while (reader.fieldsChanged);
        for (Map.Entry<String, Map<String, Object>> element : reader.elements.entrySet()) {
            element.getValue().put("namespace", new TreeSet<>(Set.of(reader.namespaceOf(element.getKey()))));
        }
        // An element's namespace is read under conditions only where every read of it has some: one read
        // without any makes it read wherever the path matches.
        for (Map.Entry<String, Set<List<String>>> read : reader.namespaceReads.entrySet()) {
            Map<String, Object> facts = reader.attributes.get(read.getKey());
            if (facts != null && read.getValue().stream().noneMatch(List::isEmpty)) {
                List<List<String>> when = new ArrayList<>(read.getValue());
                when.sort(java.util.Comparator.comparing(Object::toString));
                facts.put("when", when);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("elements", plain(reader.elements));
        out.put("attributes", plain(reader.attributes));
        Map<String, Object> tables = new TreeMap<>();
        for (Map.Entry<String, Map<String, List<Handler>>> table : reader.tables.entrySet()) {
            Map<String, Object> keys = new TreeMap<>();
            for (Map.Entry<String, List<Handler>> entry : table.getValue().entrySet()) {
                List<String> described = new ArrayList<>();
                for (Handler handler : entry.getValue()) {
                    described.add(handler.describe(code));
                }
                keys.put(entry.getKey(), described);
            }
            tables.put(table.getKey(), keys);
        }
        out.put("tables", tables);
        out.put("extensionParsers", new TreeMap<>(reader.extensionParsers));
        return out;
    }

    /**
     * How Core matches an element's namespace, from its last step: a step with a prefix (`jr:addCaption`,
     * `h:*`) is one whose namespace Core tests, and a bare step one Core matches by its local name alone, in
     * any namespace (a handler table's key, `"label".equals(child.getName())`), unless a test narrowed it to the
     * XForms namespace, which is written bare too.
     */
    private String namespaceOf(String path) {
        String step = path.substring(path.lastIndexOf('/') + 1);
        if (step.startsWith("{")) {
            return step.substring(1, step.indexOf('}'));
        }
        if (step.contains(":")) {
            String prefix = step.substring(0, step.indexOf(':'));
            for (Map.Entry<String, String> known : PREFIXES.entrySet()) {
                if (known.getValue().equals(prefix)) {
                    return known.getKey();
                }
            }
            throw new IllegalStateException("The XForm reader wrote the step " + step + " with a prefix it does not know.");
        }
        return xformsNamespaced.contains(path) ? "http://www.w3.org/2002/xforms" : "any";
    }

    // -- the tables -----------------------------------------------------------------------

    private void collectTables(List<Object> registrations) {
        for (MethodDeclaration method : parser.getMethods()) {
            Map<String, LambdaExpr> lambdas = new HashMap<>();
            for (VariableDeclarator variable : method.findAll(VariableDeclarator.class)) {
                if (variable.getInitializer().isPresent() && variable.getInitializer().get() instanceof LambdaExpr) {
                    lambdas.put(variable.getNameAsString(), (LambdaExpr) variable.getInitializer().get());
                }
            }
            for (MethodCallExpr call : method.findAll(MethodCallExpr.class)) {
                if (call.getNameAsString().equals("put") && call.getArguments().size() == 2 && call.getScope().isPresent()
                        && isTable(call.getScope().get().toString())) {
                    String table = call.getScope().get().toString();
                    Expression value = call.getArgument(1);
                    String key = code.constant(call.getArgument(0), parser);
                    if (key != null && value instanceof NameExpr && lambdas.containsKey(((NameExpr) value).getNameAsString())) {
                        add(table, key, new Handler(lambdas.get(((NameExpr) value).getNameAsString()), parser, null, null));
                    } else if (key == null && value instanceof MethodCallExpr
                            && ((MethodCallExpr) value).getNameAsString().equals("get")
                            && ((MethodCallExpr) value).getScope().isPresent()
                            && isTable(((MethodCallExpr) value).getScope().get().toString())) {
                        // A table filled from another table's entries (the top level from the group level).
                        String from = ((MethodCallExpr) value).getScope().get().toString();
                        for (Map.Entry<String, List<Handler>> entry : tables.getOrDefault(from, Map.of()).entrySet()) {
                            for (Handler handler : entry.getValue()) {
                                add(table, entry.getKey(), handler);
                            }
                        }
                    }
                }
                if (call.getNameAsString().equals("registerActionHandler") && call.getArguments().size() == 2
                        && !call.getScope().isPresent()) {
                    String key = code.constant(call.getArgument(0), parser);
                    Handler specific = handlerOf(call.getArgument(1), parser);
                    if (key != null && specific != null) {
                        add("actionHandlers", key, actionWrapper(specific));
                    }
                }
            }
        }
        for (Object registration : registrations) {
            @SuppressWarnings("unchecked")
            Map<String, Object> registered = (Map<String, Object>) registration;
            String registers = (String) registered.get("registers");
            String key = (String) registered.get("key");
            String value = (String) registered.get("value");
            TypeDeclaration<?> type = value == null ? null : code.type(value);
            if (registers.equals("extensionParser") && type != null) {
                extensionParsers.put(value, elementNameOf(type));
            } else if (registers.equals("registerHandler") && key != null && type != null) {
                Handler handler = new Handler(null, type, null, null);
                add("topLevelHandlers", key, handler);
                add("groupLevelHandlers", key, handler);
            } else if (registers.equals("registerActionHandler") && key != null && type != null) {
                add("actionHandlers", key, actionWrapper(new Handler(null, type, null, null)));
            } else if (registers.equals("registerHandler") || registers.equals("registerActionHandler")
                    || registers.equals("registerControlType")) {
                throw new IllegalStateException("Android registers " + registered.get("keyExpression") + " with "
                        + registers + " (" + registered.get("at") + ") in a form the XForm reader cannot follow.");
            }
        }
    }

    private static boolean isTable(String name) {
        return name.equals("topLevelHandlers") || name.equals("groupLevelHandlers") || name.equals("actionHandlers");
    }

    private void add(String table, String key, Handler handler) {
        tables.computeIfAbsent(table, k -> new TreeMap<>()).computeIfAbsent(key, k -> new ArrayList<>()).add(handler);
    }

    /** The lambda `registerActionHandler` wraps every action handler in, capturing the specific handler. */
    private Handler actionWrapper(Handler specific) {
        MethodDeclaration register = parser.getMethodsByName("registerActionHandler").stream().findFirst()
                .orElseThrow(() -> new IllegalStateException("XFormParser has no registerActionHandler."));
        LambdaExpr wrapper = register.findFirst(LambdaExpr.class)
                .orElseThrow(() -> new IllegalStateException("registerActionHandler wraps no lambda."));
        String captured = register.getParameter(1).getNameAsString();
        return new Handler(wrapper, parser, specific, captured);
    }

    /** A handler an expression stands for: `X.getHandler()` returning a lambda, or `new X()`. */
    private Handler handlerOf(Expression value, TypeDeclaration<?> where) {
        Expression inner = unwrap(value);
        if (inner instanceof ObjectCreationExpr) {
            TypeDeclaration<?> type = code.type(((ObjectCreationExpr) inner).getType().getNameAsString());
            return type == null ? null : new Handler(null, type, null, null);
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getScope().isPresent()
                && ((MethodCallExpr) inner).getScope().get() instanceof NameExpr) {
            TypeDeclaration<?> owner = code.type(((NameExpr) ((MethodCallExpr) inner).getScope().get()).getNameAsString());
            if (owner != null) {
                for (CallableDeclaration<?> target : code.callables(owner, ((MethodCallExpr) inner).getNameAsString(), 0)) {
                    for (ReturnStmt returned : target.findAll(ReturnStmt.class)) {
                        if (returned.getExpression().isPresent() && returned.getExpression().get() instanceof LambdaExpr) {
                            return new Handler((LambdaExpr) returned.getExpression().get(), owner, null, null);
                        }
                    }
                }
            }
        }
        return null;
    }

    /** The element an extension parser sets (`setElementName(...)` in its constructor). */
    private String elementNameOf(TypeDeclaration<?> type) {
        for (MethodCallExpr call : type.findAll(MethodCallExpr.class)) {
            if (call.getNameAsString().equals("setElementName") && call.getArguments().size() == 1) {
                String name = code.constant(call.getArgument(0), type);
                if (name != null) {
                    return name;
                }
            }
        }
        throw new IllegalStateException("The extension parser " + type.getNameAsString()
                + " sets no element name the XForm reader can resolve.");
    }

    /** The keys of a table Core itself registers a handler for, so every platform's table holds them. */
    private Set<String> everyPlatformKeys(String table) {
        Set<String> out = new TreeSet<>();
        for (Map.Entry<String, List<Handler>> entry : tables.getOrDefault(table, Map.of()).entrySet()) {
            for (Handler handler : entry.getValue()) {
                if (isCore(handler)) {
                    out.add(entry.getKey());
                }
            }
        }
        return out;
    }

    private boolean isCore(Handler handler) {
        return code.unitOf(handler.lambda != null ? handler.lambda : handler.type).platform.equals("core")
                && (handler.captured == null || isCore(handler.captured));
    }

    /** Every key read from the source is a key of Core's compiled tables, and every Core key was read. */
    @SuppressWarnings("unchecked")
    private void checkTables() throws Exception {
        Class<?> compiled = Class.forName("org.javarosa.xform.parse.XFormParser");
        for (String table : List.of("topLevelHandlers", "groupLevelHandlers", "actionHandlers")) {
            Field field = compiled.getDeclaredField(table);
            field.setAccessible(true);
            Set<String> runtime = new TreeSet<>(((Hashtable<String, Object>) field.get(null)).keySet());
            Set<String> read = new TreeSet<>(tables.getOrDefault(table, Map.of()).keySet());
            Set<String> core = new TreeSet<>();
            for (Map.Entry<String, List<Handler>> entry : tables.getOrDefault(table, Map.of()).entrySet()) {
                for (Handler handler : entry.getValue()) {
                    if (code.unitOf(handler.lambda != null ? handler.lambda : handler.type).platform.equals("core")
                            && (handler.captured == null
                            || code.unitOf(handler.captured.lambda != null ? handler.captured.lambda : handler.captured.type)
                            .platform.equals("core"))) {
                        core.add(entry.getKey());
                    }
                }
            }
            if (!core.equals(runtime) || !read.containsAll(runtime)) {
                throw new IllegalStateException("XFormParser's compiled " + table + " holds " + runtime
                        + " but the XForm reader read " + core + " from Core's source. The table is filled in a way "
                        + "the reader does not follow.");
            }
        }
    }

    // -- the document ---------------------------------------------------------------------

    /** Reads the parser from where it starts: `parseDoc` on the document's root element. */
    private void document() {
        CallableDeclaration<?> parseDoc = code.callables(parser, "parseDoc", 0).get(0);
        context = parser;
        Frame frame = new Frame();
        frame.self = "parser";
        // The root element is any element: `getRootElement()` stands for it.
        method(parseDoc, frame);
    }

    // -- facts ----------------------------------------------------------------------------

    private Map<String, Object> element(String path) {
        return elements.computeIfAbsent(path, k -> {
            Map<String, Object> facts = new TreeMap<>();
            facts.put("at", new TreeSet<String>());
            return facts;
        });
    }

    @SuppressWarnings("unchecked")
    private void elementFact(String path, String fact, Object value, Node at) {
        if (!named(path)) {
            return;
        }
        Map<String, Object> facts = element(path);
        ((Set<String>) facts.get("at")).add(code.where(at));
        if (value instanceof String) {
            ((Set<String>) facts.computeIfAbsent(fact, k -> new TreeSet<String>())).add((String) value);
        } else if (value != null) {
            facts.put(fact, value);
        }
    }

    @SuppressWarnings("unchecked")
    private void attribute(String path, String namespace, String name, String match, Node at) {
        if (!named(path)) {
            return;
        }
        String key = path + "@" + qualified(namespace, name);
        Map<String, Object> facts = attributes.computeIfAbsent(key, k -> {
            Map<String, Object> made = new TreeMap<>();
            made.put("at", new TreeSet<String>());
            made.put("namespace", new TreeSet<String>());
            made.put("read", new TreeSet<String>());
            return made;
        });
        ((Set<String>) facts.get("at")).add(code.where(at));
        ((Set<String>) facts.get("namespace")).add(namespace == null ? "any" : namespace.isEmpty() ? "none" : namespace);
        ((Set<String>) facts.get("read")).add(match);
        elementFact(path, "at", null, at);
    }

    @SuppressWarnings("unchecked")
    private void attributeFact(String key, String fact, String value) {
        Map<String, Object> facts = attributes.get(key);
        if (facts != null) {
            ((Set<String>) facts.computeIfAbsent(fact, k -> new TreeSet<String>())).add(value);
        }
    }

    /** A path names something once it holds a concrete step (not only the root wildcard). */
    private static boolean named(String path) {
        for (String step : path.split("/")) {
            String local = step.contains(":") ? step.substring(step.indexOf(':') + 1) : step;
            if (!local.isEmpty() && !local.equals("*")) {
                return true;
            }
        }
        return false;
    }

    /**
     * A namespaced name written with the prefix HQ and Vellum write for the namespace (the XForms
     * namespace bare), else `{uri}name`: the spelling the manifest checks read an export's XForm with
     * (proof/checks/manifest_usage.py, PREFIXES).
     */
    static String qualified(String namespace, String name) {
        if (namespace == null || namespace.isEmpty()) {
            return name;
        }
        String prefix = PREFIXES.get(namespace);
        if (prefix == null) {
            return "{" + namespace + "}" + name;
        }
        return prefix.isEmpty() ? name : prefix + ":" + name;
    }

    static final Map<String, String> PREFIXES = Map.of(
            "http://www.w3.org/2002/xforms", "",
            "http://www.w3.org/1999/xhtml", "h",
            JAVAROSA, "jr",
            "http://openrosa.org/jr/xforms", "orx",
            "http://commcarehq.org/xforms", "cc",
            "http://commcarehq.org/xforms/vellum", "vellum",
            "http://opendatakit.org/xforms", "odkx",
            "http://www.w3.org/2001/XMLSchema", "xsd");

    // -- interpretation -------------------------------------------------------------------

    /** What a method's locals hold. */
    static final class Frame {
        String self;
        final Map<String, Set<String>> elems = new HashMap<>();
        /** local -> {element local, match}: the local holds that element's name. */
        final Map<String, String[]> names = new HashMap<>();
        /** local -> element local: the local holds that element's namespace. */
        final Map<String, String> namespaces = new HashMap<>();
        /** local -> element local: the local holds the name of one of its attributes, read by position. */
        final Map<String, String> attributeNames = new HashMap<>();
        /** local -> attribute keys whose value it holds. */
        final Map<String, Set<String>> values = new HashMap<>();
        final Map<String, String> strings = new HashMap<>();
        final Map<String, Long> ints = new HashMap<>();
        /** "local.field" -> the boolean a freshly made object's field holds. */
        final Map<String, Boolean> flags = new HashMap<>();
        /** local -> a boolean the local always holds here. */
        final Map<String, Boolean> booleans = new HashMap<>();
        /** local -> the class of the object it was made as here. */
        final Map<String, String> types = new HashMap<>();
        /** local -> element local: the local holds the namespace of an attribute read by position. */
        final Map<String, String> attributeNamespaces = new HashMap<>();
        /** local -> a handler table field it holds. */
        final Map<String, String> tables = new HashMap<>();
        /** local -> {table, element local}: a handler looked up by an element's name. */
        final Map<String, String[]> lookups = new HashMap<>();
        final Map<String, List<Handler>> handlers = new HashMap<>();
        /** local -> extension parser classes it holds. */
        final Map<String, Set<String>> extensions = new HashMap<>();
        final Map<String, Set<String>> strSets = new HashMap<>();
        /** local -> element paths a vector holds. */
        final Map<String, Set<String>> vectors = new HashMap<>();
        /**
         * local -> element path -> the conditions under which the local holds an element at that path
         * (`Conditions`): what a failed name test, a null test or a field's first assignment established.
         */
        final Map<String, Map<String, Set<String>>> conditions = new HashMap<>();
        /** local -> the local whose element's children it held when a test found it null. */
        final Map<String, String> nullChildrenOf = new HashMap<>();
        /** Fields a test found null on this path: an assignment to one here is its first. */
        final Set<String> nullFields = new TreeSet<>();

        Frame copy() {
            Frame out = new Frame();
            out.self = self;
            elems.forEach((k, v) -> out.elems.put(k, new TreeSet<>(v)));
            conditions.forEach((k, v) -> out.conditions.put(k, Conditions.copy(v)));
            out.nullChildrenOf.putAll(nullChildrenOf);
            out.nullFields.addAll(nullFields);
            out.names.putAll(names);
            out.namespaces.putAll(namespaces);
            out.attributeNames.putAll(attributeNames);
            values.forEach((k, v) -> out.values.put(k, new TreeSet<>(v)));
            out.strings.putAll(strings);
            out.ints.putAll(ints);
            out.flags.putAll(flags);
            out.types.putAll(types);
            out.booleans.putAll(booleans);
            out.attributeNamespaces.putAll(attributeNamespaces);
            out.tables.putAll(tables);
            out.lookups.putAll(lookups);
            out.handlers.putAll(handlers);
            extensions.forEach((k, v) -> out.extensions.put(k, new TreeSet<>(v)));
            strSets.forEach((k, v) -> out.strSets.put(k, new TreeSet<>(v)));
            vectors.forEach((k, v) -> out.vectors.put(k, new TreeSet<>(v)));
            return out;
        }

        /** The state a callee's memo key depends on. */
        String key() {
            Map<String, Object> described = new TreeMap<>();
            described.put("e", new TreeMap<>(elems));
            described.put("n", names.entrySet().stream().map(e -> e.getKey() + "=" + String.join(",", e.getValue()))
                    .sorted().toList());
            described.put("v", new TreeMap<>(values));
            described.put("s", new TreeMap<>(strings));
            described.put("i", new TreeMap<>(ints));
            described.put("b", new TreeMap<>(booleans));
            described.put("t", new TreeMap<>(tables));
            described.put("h", new TreeSet<>(handlers.keySet()));
            described.put("x", new TreeMap<>(extensions));
            if (!conditions.isEmpty()) {
                Map<String, Object> held = new TreeMap<>();
                conditions.forEach((k, v) -> held.put(k, Conditions.copy(v)));
                described.put("c", held);
            }
            return described.toString();
        }

        void forget(String local) {
            conditions.remove(local);
            nullChildrenOf.remove(local);
            elems.remove(local);
            names.remove(local);
            namespaces.remove(local);
            attributeNames.remove(local);
            values.remove(local);
            strings.remove(local);
            ints.remove(local);
            tables.remove(local);
            lookups.remove(local);
            handlers.remove(local);
            extensions.remove(local);
            strSets.remove(local);
            vectors.remove(local);
            types.remove(local);
            booleans.remove(local);
            attributeNamespaces.remove(local);
            flags.keySet().removeIf(flag -> flag.startsWith(local + "."));
        }
    }

    private void method(CallableDeclaration<?> callable, Frame frame) {
        TypeDeclaration<?> owner = Code.typeOf(callable);
        String id = (owner == null ? "?" : Code.qualifiedName(owner)) + "#" + callable.getDeclarationAsString(false, false, false);
        String key = memoKey(callable, frame);
        if (!visited.add(key)) {
            return;
        }
        Statement body = callable instanceof MethodDeclaration ? ((MethodDeclaration) callable).getBody().orElse(null)
                : callable instanceof ConstructorDeclaration ? ((ConstructorDeclaration) callable).getBody() : null;
        if (body == null) {
            return;
        }
        TypeDeclaration<?> saved = context;
        String savedReading = reading;
        List<Exits> savedExits = exits;
        context = owner;
        reading = key;
        // A `break` or `continue` never leaves the method it is in.
        exits = new ArrayList<>();
        returned.put(key, new TreeSet<>());
        Set<String> held = new TreeSet<>();
        frame.elems.values().forEach(held::addAll);
        stack.add(new Object[]{id, held});
        try {
            statement(body, frame);
        } finally {
            stack.remove(stack.size() - 1);
            context = saved;
            reading = savedReading;
            exits = savedExits;
        }
    }

    /** The memo key a call enters its callee with. */
    private String memoKey(CallableDeclaration<?> callable, Frame frame) {
        TypeDeclaration<?> owner = Code.typeOf(callable);
        return (owner == null ? "?" : Code.qualifiedName(owner)) + "#" + callable.getDeclarationAsString(false, false, false)
                + frame.key();
    }

    /** Runs a statement; returns false when control cannot continue past it. */
    private boolean statement(Statement statement, Frame frame) {
        if (diagnostic(statement)) {
            return true;
        }
        if (statement instanceof BlockStmt) {
            for (Statement inner : ((BlockStmt) statement).getStatements()) {
                if (!statement(inner, frame)) {
                    return false;
                }
            }
            return true;
        }
        if (statement instanceof ExpressionStmt) {
            expression(((ExpressionStmt) statement).getExpression(), frame);
            return true;
        }
        if (statement instanceof IfStmt) {
            IfStmt branch = (IfStmt) statement;
            expression(branch.getCondition(), frame);
            attributeNameTests(branch.getCondition(), frame);
            Boolean known = evaluate(branch.getCondition(), frame);
            Frame then = frame.copy();
            boolean thenContinues = true;
            if (known == null || known) {
                narrow(branch.getCondition(), then, true);
                thenContinues = statement(branch.getThenStmt(), then);
            }
            Frame otherwise = frame.copy();
            boolean elseContinues = true;
            if (known == null || !known) {
                narrow(branch.getCondition(), otherwise, false);
                if (branch.getElseStmt().isPresent()) {
                    elseContinues = statement(branch.getElseStmt().get(), otherwise);
                }
            }
            // A branch Core always takes here is the state that follows.
            if (known != null && known) {
                replace(frame, then);
                return thenContinues;
            }
            if (known != null) {
                replace(frame, otherwise);
                return elseContinues;
            }
            if (!thenContinues && elseContinues) {
                // A guard: past the `if`, the condition was false.
                replace(frame, otherwise);
            } else if (thenContinues && !elseContinues) {
                replace(frame, then);
            } else {
                merge(frame, then);
                merge(frame, otherwise);
                settle(frame, List.of(then, otherwise));
            }
            return thenContinues || elseContinues;
        }
        if (statement instanceof LabeledStmt) {
            LabeledStmt labeled = (LabeledStmt) statement;
            Statement inner = labeled.getStatement();
            if (inner instanceof ForStmt || inner instanceof ForEachStmt || inner instanceof WhileStmt
                    || inner instanceof DoStmt || inner instanceof SwitchStmt) {
                pendingLabel = labeled.getLabel().asString();
                return statement(inner, frame);
            }
            // A labelled block: only `break <label>` leaves it.
            Exits block = enter(Exits.Kind.BLOCK, labeled.getLabel().asString());
            boolean continues;
            try {
                continues = statement(inner, frame);
            } finally {
                leave(block);
            }
            return join(frame, continues ? List.of(frame.copy()) : List.of(), block.breaks) || continues;
        }
        if (statement instanceof ForStmt) {
            ForStmt loop = (ForStmt) statement;
            Exits exits = enter(Exits.Kind.LOOP, null);
            loop.getInitialization().forEach(e -> expression(e, frame));
            loop.getCompare().ifPresent(e -> expression(e, frame));
            return loop(frame, frame.copy(), loop.getBody(), exits);
        }
        if (statement instanceof ForEachStmt) {
            ForEachStmt loop = (ForEachStmt) statement;
            Exits exits = enter(Exits.Kind.LOOP, null);
            Frame body = frame.copy();
            String variable = loop.getVariable().getVariables().get(0).getNameAsString();
            Expression iterable = unwrap(loop.getIterable());
            Set<String> paths = vectorPaths(iterable, frame);
            if (!paths.isEmpty()) {
                body.elems.put(variable, paths);
            }
            Set<String> strings = stringSet(iterable, frame);
            if (strings != null) {
                body.strSets.put(variable, strings);
            }
            Set<String> extensions = extensionsOf(iterable, frame);
            if (!extensions.isEmpty()) {
                body.extensions.put(variable, extensions);
            }
            return loop(frame, body, loop.getBody(), exits);
        }
        if (statement instanceof WhileStmt) {
            Exits exits = enter(Exits.Kind.LOOP, null);
            expression(((WhileStmt) statement).getCondition(), frame);
            return loop(frame, frame.copy(), ((WhileStmt) statement).getBody(), exits);
        }
        if (statement instanceof DoStmt) {
            Exits exits = enter(Exits.Kind.LOOP, null);
            loop(frame, frame.copy(), ((DoStmt) statement).getBody(), exits);
            expression(((DoStmt) statement).getCondition(), frame);
            return true;
        }
        if (statement instanceof SwitchStmt) {
            SwitchStmt choice = (SwitchStmt) statement;
            Exits exits = enter(Exits.Kind.SWITCH, null);
            expression(choice.getSelector(), frame);
            List<Frame> reaching = new ArrayList<>();
            if (choice.getEntries().stream().noneMatch(entry -> entry.getLabels().isEmpty())) {
                // No `default`: a selector no label matches passes straight through.
                reaching.add(frame.copy());
            }
            try {
                for (SwitchEntry entry : choice.getEntries()) {
                    Frame branch = frame.copy();
                    boolean continues = true;
                    for (Statement inner : entry.getStatements()) {
                        if (!statement(inner, branch)) {
                            continues = false;
                            break;
                        }
                    }
                    if (continues) {
                        // Falling into the next entry is read as reaching the end of the switch.
                        reaching.add(branch);
                    }
                    merge(frame, branch);
                }
            } finally {
                leave(exits);
            }
            join(frame, reaching, exits.breaks);
            return true;
        }
        if (statement instanceof TryStmt) {
            TryStmt attempt = (TryStmt) statement;
            Frame body = frame.copy();
            statement(attempt.getTryBlock(), body);
            // An exception can leave the block anywhere, so the state before it reaches a handler too.
            List<Frame> reaching = new ArrayList<>(List.of(frame.copy(), body));
            merge(frame, body);
            for (com.github.javaparser.ast.stmt.CatchClause clause : attempt.getCatchClauses()) {
                Frame handler = frame.copy();
                settle(handler, List.of(frame, body));
                if (statement(clause.getBody(), handler)) {
                    reaching.add(handler);
                    merge(frame, handler);
                }
            }
            settle(frame, reaching);
            attempt.getFinallyBlock().ifPresent(block -> statement(block, frame));
            return true;
        }
        if (statement instanceof ReturnStmt) {
            ((ReturnStmt) statement).getExpression().ifPresent(e -> {
                expression(e, frame);
                if (reading != null) {
                    returned.computeIfAbsent(reading, k -> new TreeSet<>()).addAll(valuesOf(e, frame));
                }
            });
            return false;
        }
        if (statement instanceof BreakStmt) {
            String label = ((BreakStmt) statement).getLabel().map(l -> l.asString()).orElse(null);
            Exits target = target(label, false);
            if (target != null) {
                target.breaks.add(frame.copy());
            }
            return false;
        }
        if (statement instanceof ContinueStmt) {
            String label = ((ContinueStmt) statement).getLabel().map(l -> l.asString()).orElse(null);
            Exits target = target(label, true);
            if (target != null) {
                target.continues.add(frame.copy());
            }
            return false;
        }
        if (statement instanceof ThrowStmt) {
            return false;
        }
        return true;
    }

    /** Reads a loop's body from `body` (the state entering it); past the loop, every way out is joined. */
    private boolean loop(Frame frame, Frame body, Statement statement, Exits exits) {
        boolean continues;
        try {
            continues = statement(statement, body);
        } finally {
            leave(exits);
        }
        // Past the loop: it ran no times, ran to the end of its body, continued, or broke out.
        List<Frame> reaching = new ArrayList<>(List.of(frame.copy()));
        if (continues) {
            reaching.add(body);
        }
        merge(frame, body);
        reaching.addAll(exits.continues);
        for (Frame continued : exits.continues) {
            merge(frame, continued);
        }
        join(frame, reaching, exits.breaks);
        return true;
    }

    /** Where a `break` or `continue` (with its label, if any) goes. */
    private Exits target(String label, boolean isContinue) {
        for (int i = exits.size() - 1; i >= 0; i--) {
            Exits candidate = exits.get(i);
            if (label != null ? label.equals(candidate.label)
                    : isContinue ? candidate.kind == Exits.Kind.LOOP : candidate.kind != Exits.Kind.BLOCK) {
                return candidate;
            }
        }
        return null;
    }

    private Exits enter(Exits.Kind kind, String label) {
        Exits made = new Exits(kind, label != null ? label : pendingLabel);
        pendingLabel = null;
        exits.add(made);
        return made;
    }

    private void leave(Exits made) {
        exits.remove(made);
    }

    /**
     * `frame` becomes the state past a point the `reaching` paths and the `broken` ones (a `break`'s state)
     * arrive at: their elements and other held sets are added, and a known value stays known only where every
     * path agrees. Returns whether any path arrives.
     */
    private static boolean join(Frame frame, List<Frame> reaching, List<Frame> broken) {
        List<Frame> all = new ArrayList<>(reaching);
        all.addAll(broken);
        for (Frame out : broken) {
            merge(frame, out);
        }
        settle(frame, all);
        return !all.isEmpty();
    }

    /**
     * Adds what `from` may hold to `into`: element paths, attribute values, vectors and extension parsers are
     * unioned, and a local's name, namespace, attribute name, lookup, handler, table or string set is kept as
     * `into` has it or taken from `from`. Known values (booleans, flags, strings, integers, made types) are not
     * merged here: `settle` keeps each only where every reaching path agrees.
     */
    private static void merge(Frame into, Frame from) {
        Conditions.merge(into, from);
        from.elems.forEach((k, v) -> into.elems.computeIfAbsent(k, x -> new TreeSet<>()).addAll(v));
        from.values.forEach((k, v) -> into.values.computeIfAbsent(k, x -> new TreeSet<>()).addAll(v));
        from.vectors.forEach((k, v) -> into.vectors.computeIfAbsent(k, x -> new TreeSet<>()).addAll(v));
        from.names.forEach(into.names::putIfAbsent);
        from.namespaces.forEach(into.namespaces::putIfAbsent);
        from.attributeNames.forEach(into.attributeNames::putIfAbsent);
        from.lookups.forEach(into.lookups::putIfAbsent);
        from.handlers.forEach(into.handlers::putIfAbsent);
        from.tables.forEach(into.tables::putIfAbsent);
        from.extensions.forEach((k, v) -> into.extensions.computeIfAbsent(k, x -> new TreeSet<>()).addAll(v));
        from.strSets.forEach(into.strSets::putIfAbsent);
        from.attributeNamespaces.forEach(into.attributeNamespaces::putIfAbsent);
    }

    /**
     * The known values past a join: a boolean, flag, string, integer or made type stays known only where every
     * reaching path holds the same one. A value one path does not know (or that the paths disagree on) is
     * unknown there, so a later test of it reads both branches.
     */
    private static void settle(Frame into, List<Frame> reaching) {
        if (reaching.isEmpty()) {
            return;
        }
        Map<String, Boolean> booleans = agreed(reaching, f -> f.booleans);
        Map<String, Boolean> flags = agreed(reaching, f -> f.flags);
        Map<String, String> strings = agreed(reaching, f -> f.strings);
        Map<String, Long> ints = agreed(reaching, f -> f.ints);
        Map<String, String> types = agreed(reaching, f -> f.types);
        into.booleans.clear();
        into.booleans.putAll(booleans);
        into.flags.clear();
        into.flags.putAll(flags);
        into.strings.clear();
        into.strings.putAll(strings);
        into.ints.clear();
        into.ints.putAll(ints);
        into.types.clear();
        into.types.putAll(types);
    }

    private static <V> Map<String, V> agreed(List<Frame> reaching, java.util.function.Function<Frame, Map<String, V>> of) {
        Map<String, V> out = new HashMap<>();
        for (Map.Entry<String, V> entry : of.apply(reaching.get(0)).entrySet()) {
            boolean everywhere = true;
            for (Frame other : reaching) {
                V value = of.apply(other).get(entry.getKey());
                if (value == null || !value.equals(entry.getValue())) {
                    everywhere = false;
                    break;
                }
            }
            if (everywhere) {
                out.put(entry.getKey(), entry.getValue());
            }
        }
        return out;
    }

    /** Makes `into` hold exactly what `from` holds. */
    private static void replace(Frame into, Frame from) {
        Frame copied = from.copy();
        into.elems.clear();
        into.elems.putAll(copied.elems);
        into.names.clear();
        into.names.putAll(copied.names);
        into.namespaces.clear();
        into.namespaces.putAll(copied.namespaces);
        into.attributeNames.clear();
        into.attributeNames.putAll(copied.attributeNames);
        into.attributeNamespaces.clear();
        into.attributeNamespaces.putAll(copied.attributeNamespaces);
        into.values.clear();
        into.values.putAll(copied.values);
        into.strings.clear();
        into.strings.putAll(copied.strings);
        into.ints.clear();
        into.ints.putAll(copied.ints);
        into.booleans.clear();
        into.booleans.putAll(copied.booleans);
        into.flags.clear();
        into.flags.putAll(copied.flags);
        into.types.clear();
        into.types.putAll(copied.types);
        into.tables.clear();
        into.tables.putAll(copied.tables);
        into.lookups.clear();
        into.lookups.putAll(copied.lookups);
        into.handlers.clear();
        into.handlers.putAll(copied.handlers);
        into.extensions.clear();
        into.extensions.putAll(copied.extensions);
        into.strSets.clear();
        into.strSets.putAll(copied.strSets);
        into.vectors.clear();
        into.vectors.putAll(copied.vectors);
        into.conditions.clear();
        into.conditions.putAll(copied.conditions);
        into.nullChildrenOf.clear();
        into.nullChildrenOf.putAll(copied.nullChildrenOf);
        into.nullFields.clear();
        into.nullFields.addAll(copied.nullFields);
    }

    /** A statement that only reports: a reporter call, a print, a stack trace, or an `if` of only those. */
    private static boolean diagnostic(Statement statement) {
        if (statement instanceof ExpressionStmt && ((ExpressionStmt) statement).getExpression() instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) ((ExpressionStmt) statement).getExpression();
            String scope = call.getScope().map(Node::toString).orElse("");
            return scope.equals("reporter") || scope.equals("System.out") || scope.equals("System.err")
                    || call.getNameAsString().equals("printStackTrace") || scope.equals("Logger");
        }
        if (statement instanceof IfStmt && !((IfStmt) statement).getElseStmt().isPresent()) {
            Statement then = ((IfStmt) statement).getThenStmt();
            if (then instanceof BlockStmt) {
                List<Statement> inner = ((BlockStmt) then).getStatements();
                return !inner.isEmpty() && inner.stream().allMatch(XForms::diagnostic);
            }
            return diagnostic(then);
        }
        return false;
    }

    // -- expressions ----------------------------------------------------------------------

    private void expression(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof VariableDeclarationExpr) {
            for (VariableDeclarator variable : ((VariableDeclarationExpr) inner).getVariables()) {
                String local = variable.getNameAsString();
                frame.forget(local);
                if (variable.getInitializer().isPresent()) {
                    Expression init = variable.getInitializer().get();
                    bound(init, frame);
                    bind(local, init, frame);
                }
            }
            return;
        }
        if (inner instanceof AssignExpr) {
            AssignExpr assign = (AssignExpr) inner;
            Expression target = assign.getTarget();
            boolean toLocal = target instanceof NameExpr && isLocal(((NameExpr) target).getNameAsString(), target);
            if (toLocal) {
                bound(assign.getValue(), frame);
            } else {
                expression(assign.getValue(), frame);
            }
            if (toLocal) {
                String local = ((NameExpr) target).getNameAsString();
                Set<String> keptValues = assign.getOperator() == AssignExpr.Operator.ASSIGN ? null : frame.values.get(local);
                // The local a test found null while it held this value's children: it now stands for the parent.
                String fallbackOf = frame.nullChildrenOf.get(local);
                frame.forget(local);
                bind(local, assign.getValue(), frame);
                if (keptValues != null) {
                    frame.values.computeIfAbsent(local, k -> new TreeSet<>()).addAll(keptValues);
                }
                Expression value = unwrap(assign.getValue());
                if (fallbackOf != null && value instanceof NameExpr && ((NameExpr) value).getNameAsString().equals(fallbackOf)) {
                    Conditions.add(frame, local, frame.elems.getOrDefault(local, Set.of()), Conditions.CHILDLESS);
                }
            } else {
                String field = fieldName(target);
                if (field != null) {
                    Map<String, Set<String>> conditions = Conditions.copy(conditionsOf(assign.getValue(), frame));
                    Set<String> paths = elementsOf(assign.getValue(), frame);
                    if (frame.nullFields.contains(field)) {
                        // Assigned only where a test found it null: the field keeps the first value it takes.
                        for (String path : paths) {
                            conditions.computeIfAbsent(path, k -> new TreeSet<>()).add(Conditions.FIRST);
                        }
                    }
                    addToField(field, paths, conditions);
                }
            }
            return;
        }
        if (inner instanceof NameExpr) {
            // A local holding an element's namespace, used: Core reads the namespace here.
            String local = ((NameExpr) inner).getNameAsString();
            if (!deferringNamespace && frame.namespaces.containsKey(local)) {
                namespaceUse(frame.namespaces.get(local), frame, inner);
            }
            return;
        }
        if (inner instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) inner;
            call.getScope().ifPresent(scope -> {
                if (!(unwrap(scope) instanceof NameExpr)) {
                    expression(scope, frame);
                }
            });
            for (Expression argument : call.getArguments()) {
                if (!(argument instanceof LambdaExpr)) {
                    expression(argument, frame);
                }
            }
            call(call, frame);
            return;
        }
        if (inner instanceof ObjectCreationExpr) {
            for (Expression argument : ((ObjectCreationExpr) inner).getArguments()) {
                expression(argument, frame);
            }
            creation((ObjectCreationExpr) inner, frame);
            return;
        }
        if (inner instanceof BinaryExpr) {
            BinaryExpr binary = (BinaryExpr) inner;
            expression(binary.getLeft(), frame);
            if (binary.getOperator() == BinaryExpr.Operator.AND || binary.getOperator() == BinaryExpr.Operator.OR) {
                // Java evaluates the right side only where the left one does not decide: `a && b` reads nothing of
                // `b` where `a` is false here (`group.isRepeat() && ...` on a group).
                Boolean left = evaluate(binary.getLeft(), frame);
                if (left != null && left == (binary.getOperator() == BinaryExpr.Operator.OR)) {
                    return;
                }
            }
            expression(binary.getRight(), frame);
            return;
        }
        if (inner instanceof UnaryExpr) {
            expression(((UnaryExpr) inner).getExpression(), frame);
            return;
        }
        if (inner instanceof ConditionalExpr) {
            expression(((ConditionalExpr) inner).getCondition(), frame);
            expression(((ConditionalExpr) inner).getThenExpr(), frame);
            expression(((ConditionalExpr) inner).getElseExpr(), frame);
            return;
        }
        if (inner instanceof FieldAccessExpr) {
            expression(((FieldAccessExpr) inner).getScope(), frame);
        }
    }

    /**
     * Reads an expression bound to a local: an element's namespace it holds (`String ns = e.getNamespace()`) is
     * read where the local is used, not here.
     */
    private void bound(Expression value, Frame frame) {
        boolean saved = deferringNamespace;
        deferringNamespace = namespaceOf(value, frame) != null;
        try {
            expression(value, frame);
        } finally {
            deferringNamespace = saved;
        }
    }

    /** The namespace of the element `element` (a local) holds, used here: read on each of its paths. */
    private void namespaceUse(String element, Frame frame, Node at) {
        Map<String, Set<String>> conditions = frame.conditions.getOrDefault(element, Map.of());
        for (String path : frame.elems.getOrDefault(element, Set.of())) {
            namespaceRead(path, conditions.getOrDefault(path, Set.of()), at);
        }
    }

    /** Whether `name` is a local or parameter where `at` stands (rather than a field). */
    private static boolean isLocal(String name, Node at) {
        Node current = at.getParentNode().orElse(null);
        while (current != null && !(current instanceof TypeDeclaration)) {
            if (current instanceof CallableDeclaration) {
                for (Parameter parameter : ((CallableDeclaration<?>) current).getParameters()) {
                    if (parameter.getNameAsString().equals(name)) {
                        return true;
                    }
                }
                for (VariableDeclarator local : current.findAll(VariableDeclarator.class)) {
                    if (local.getNameAsString().equals(name)) {
                        return true;
                    }
                }
                return false;
            }
            if (current instanceof LambdaExpr) {
                for (Parameter parameter : ((LambdaExpr) current).getParameters()) {
                    if (parameter.getNameAsString().equals(name)) {
                        return true;
                    }
                }
                for (VariableDeclarator local : current.findAll(VariableDeclarator.class)) {
                    if (local.getNameAsString().equals(name)) {
                        return true;
                    }
                }
            }
            current = current.getParentNode().orElse(null);
        }
        return false;
    }

    /** The field an assignment target or a read names, when it is one of the context's fields. */
    private String fieldName(Expression target) {
        Expression inner = unwrap(target);
        String name = null;
        if (inner instanceof NameExpr && !isLocal(((NameExpr) inner).getNameAsString(), inner)) {
            name = ((NameExpr) inner).getNameAsString();
        } else if (inner instanceof FieldAccessExpr && ((FieldAccessExpr) inner).getScope() instanceof ThisExpr) {
            name = ((FieldAccessExpr) inner).getNameAsString();
        }
        return name != null && code.field(context, name) != null ? Code.qualifiedName(Code.typeOf(code.field(context, name)))
                + "." + name : null;
    }

    private void addToField(String field, Set<String> paths, Map<String, Set<String>> conditions) {
        if (paths.isEmpty()) {
            return;
        }
        Set<String> held = fields.computeIfAbsent(field, k -> new TreeSet<>());
        Map<String, Set<String>> kept = fieldConditions.computeIfAbsent(field, k -> new TreeMap<>());
        for (String path : paths) {
            Set<String> these = conditions.getOrDefault(path, Set.of());
            if (!held.contains(path)) {
                Conditions.put(kept, path, these);
                continue;
            }
            // A path the field took before keeps only the conditions every assignment made.
            Set<String> before = kept.getOrDefault(path, Set.of());
            Set<String> both = new TreeSet<>(before);
            both.retainAll(these);
            if (!both.equals(before)) {
                Conditions.put(kept, path, both);
                fieldsChanged = true;
            }
        }
        if (held.addAll(paths)) {
            fieldsChanged = true;
        }
    }

    /** Records what a local now holds. */
    private void bind(String local, Expression value, Frame frame) {
        Expression inner = unwrap(value);
        Set<String> paths = elementsOf(inner, frame);
        if (!paths.isEmpty()) {
            frame.elems.put(local, paths);
            Map<String, Set<String>> conditions = new TreeMap<>();
            conditionsOf(inner, frame).forEach((path, held) -> {
                if (paths.contains(path)) {
                    Conditions.put(conditions, path, held);
                }
            });
            if (!conditions.isEmpty()) {
                frame.conditions.put(local, conditions);
            }
        }
        String[] name = nameOf(inner, frame);
        if (name != null) {
            frame.names.put(local, name);
        }
        String namespaceOf = namespaceOf(inner, frame);
        if (namespaceOf != null) {
            frame.namespaces.put(local, namespaceOf);
        }
        String attributeName = attributeNameOf(inner, frame);
        if (attributeName != null) {
            frame.attributeNames.put(local, attributeName);
        }
        Set<String> held = valuesOf(inner, frame);
        if (!held.isEmpty()) {
            frame.values.put(local, held);
        }
        String text = stringOf(inner, frame);
        if (text != null) {
            frame.strings.put(local, text);
        }
        Long number = intOf(inner, frame);
        if (number != null) {
            frame.ints.put(local, number);
        }
        String table = tableOf(inner, frame);
        if (table != null) {
            frame.tables.put(local, table);
        }
        Boolean known = evaluate(inner, frame);
        if (known != null) {
            frame.booleans.put(local, known);
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getNameAsString().equals("get")
                && ((MethodCallExpr) inner).getArguments().size() == 1 && ((MethodCallExpr) inner).getScope().isPresent()) {
            String looked = tableOf(((MethodCallExpr) inner).getScope().get(), frame);
            String[] byName = nameOf(((MethodCallExpr) inner).getArgument(0), frame);
            if (looked != null && byName != null) {
                frame.lookups.put(local, new String[]{looked, byName[0]});
            }
        }
        Set<String> strings = stringSet(inner, frame);
        if (strings != null) {
            frame.strSets.put(local, strings);
        }
        if (inner instanceof ObjectCreationExpr) {
            String created = ((ObjectCreationExpr) inner).getType().getNameAsString();
            if (created.equals("Vector") || created.equals("ArrayList")) {
                frame.vectors.put(local, new TreeSet<>());
            }
            TypeDeclaration<?> type = code.type(created);
            if (type != null && ((ObjectCreationExpr) inner).getArguments().isEmpty()) {
                frame.types.put(local, created);
                freshFlags(local, type, frame);
            }
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getNameAsString().equals("getAttributeNamespace")
                && ((MethodCallExpr) inner).getArguments().size() == 1 && ((MethodCallExpr) inner).getScope().isPresent()) {
            String element = elementLocal(((MethodCallExpr) inner).getScope().get(), frame);
            if (element != null) {
                frame.attributeNamespaces.put(local, element);
            }
        }
    }

    /** The booleans a freshly made object's fields hold: their initialisers and its no-argument constructor's assignments. */
    private void freshFlags(String local, TypeDeclaration<?> type, Frame frame) {
        for (FieldDeclaration field : type.getFields()) {
            for (VariableDeclarator variable : field.getVariables()) {
                if (variable.getType().asString().equals("boolean")) {
                    Expression init = variable.getInitializer().orElse(null);
                    frame.flags.put(local + "." + variable.getNameAsString(),
                            init instanceof BooleanLiteralExpr && ((BooleanLiteralExpr) init).getValue());
                }
            }
        }
        for (CallableDeclaration<?> constructor : code.callables(type, null, 0)) {
            for (AssignExpr assign : constructor.findAll(AssignExpr.class)) {
                String field = assign.getTarget() instanceof NameExpr ? ((NameExpr) assign.getTarget()).getNameAsString()
                        : assign.getTarget() instanceof FieldAccessExpr ? ((FieldAccessExpr) assign.getTarget()).getNameAsString()
                        : null;
                if (field != null && frame.flags.containsKey(local + "." + field)
                        && assign.getValue() instanceof BooleanLiteralExpr) {
                    frame.flags.put(local + "." + field, ((BooleanLiteralExpr) assign.getValue()).getValue());
                }
            }
        }
    }

    /**
     * The boolean field an accessor of a type reads or writes: a no-argument method returning a field, or a
     * one-argument method assigning its parameter to a field.
     */
    private String accessedField(TypeDeclaration<?> type, String method, int arity) {
        for (CallableDeclaration<?> target : code.callables(type, method, arity)) {
            if (!(target instanceof MethodDeclaration) || !((MethodDeclaration) target).getBody().isPresent()) {
                continue;
            }
            List<Statement> body = ((MethodDeclaration) target).getBody().get().getStatements();
            if (body.size() != 1) {
                continue;
            }
            Statement only = body.get(0);
            if (arity == 0 && only instanceof ReturnStmt && ((ReturnStmt) only).getExpression().isPresent()) {
                Expression returned = unwrap(((ReturnStmt) only).getExpression().get());
                if (returned instanceof NameExpr) {
                    return ((NameExpr) returned).getNameAsString();
                }
                if (returned instanceof FieldAccessExpr && ((FieldAccessExpr) returned).getScope() instanceof ThisExpr) {
                    return ((FieldAccessExpr) returned).getNameAsString();
                }
            }
            if (arity == 1 && only instanceof ExpressionStmt && ((ExpressionStmt) only).getExpression() instanceof AssignExpr) {
                AssignExpr assign = (AssignExpr) ((ExpressionStmt) only).getExpression();
                String parameter = target.getParameter(0).getNameAsString();
                if (unwrap(assign.getValue()) instanceof NameExpr
                        && ((NameExpr) unwrap(assign.getValue())).getNameAsString().equals(parameter)) {
                    Expression field = assign.getTarget();
                    if (field instanceof FieldAccessExpr) {
                        return ((FieldAccessExpr) field).getNameAsString();
                    }
                    if (field instanceof NameExpr) {
                        return ((NameExpr) field).getNameAsString();
                    }
                }
            }
        }
        return null;
    }

    // -- values ---------------------------------------------------------------------------

    private static Expression unwrap(Expression expression) {
        Expression inner = expression;
        while (inner instanceof EnclosedExpr || inner instanceof CastExpr) {
            inner = inner instanceof EnclosedExpr ? ((EnclosedExpr) inner).getInner() : ((CastExpr) inner).getExpression();
        }
        return inner;
    }

    /** The element paths an expression stands for. */
    private Set<String> elementsOf(Expression expression, Frame frame) {
        Set<String> out = new TreeSet<>();
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr) {
            String name = ((NameExpr) inner).getNameAsString();
            if (frame.elems.containsKey(name)) {
                return new TreeSet<>(frame.elems.get(name));
            }
            String field = fieldName(inner);
            if (field != null && fields.containsKey(field) && !isVectorType(inner)) {
                return new TreeSet<>(fields.get(field));
            }
            return out;
        }
        if (inner instanceof FieldAccessExpr) {
            String field = fieldName(inner);
            if (field != null && fields.containsKey(field)) {
                return new TreeSet<>(fields.get(field));
            }
            return out;
        }
        if (inner instanceof ConditionalExpr) {
            out.addAll(elementsOf(((ConditionalExpr) inner).getThenExpr(), frame));
            out.addAll(elementsOf(((ConditionalExpr) inner).getElseExpr(), frame));
            return out;
        }
        if (inner instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) inner;
            String name = call.getNameAsString();
            Expression scope = call.getScope().orElse(null);
            if (scope == null) {
                return out;
            }
            if (name.equals("getRootElement") && call.getArguments().isEmpty()) {
                out.add("*");
                return out;
            }
            Set<String> parents = elementsOf(scope, frame);
            if (!parents.isEmpty() && (name.equals("getElement") || name.equals("getChild")) && call.getArguments().size() == 1) {
                for (String parent : parents) {
                    out.add(child(parent));
                }
                return out;
            }
            if (!parents.isEmpty() && name.equals("getElement") && call.getArguments().size() == 2) {
                String namespace = stringOf(call.getArgument(0), frame);
                String child = stringOf(call.getArgument(1), frame);
                for (String parent : parents) {
                    out.add(narrowStep(child(parent), namespace, child == null ? "*" : child));
                }
                return out;
            }
            Set<String> held = vectorPaths(scope, frame);
            if ((name.equals("elementAt") || name.equals("get") || name.equals("firstElement")
                    || name.equals("lastElement")) && !held.isEmpty()) {
                return held;
            }
        }
        return out;
    }

    private boolean isVectorType(Expression at) {
        String name = at instanceof NameExpr ? ((NameExpr) at).getNameAsString() : null;
        VariableDeclarator field = name == null ? null : code.field(context, name);
        return field != null && !field.getType().asString().equals("Element");
    }

    /** The element paths a vector expression holds (a local or a field). */
    private Set<String> vectorPaths(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.vectors.containsKey(((NameExpr) inner).getNameAsString())) {
            return new TreeSet<>(frame.vectors.get(((NameExpr) inner).getNameAsString()));
        }
        String field = fieldName(inner);
        if (field != null && fields.containsKey(field) && isVectorType(inner)) {
            return new TreeSet<>(fields.get(field));
        }
        return new TreeSet<>();
    }

    /** The conditions an expression holds each of its element paths under (`Conditions`), where it holds any. */
    private Map<String, Set<String>> conditionsOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr) {
            String name = ((NameExpr) inner).getNameAsString();
            if (frame.elems.containsKey(name)) {
                return frame.conditions.getOrDefault(name, Map.of());
            }
            String field = fieldName(inner);
            return field != null ? fieldConditions.getOrDefault(field, Map.of()) : Map.of();
        }
        if (inner instanceof FieldAccessExpr) {
            String field = fieldName(inner);
            return field != null ? fieldConditions.getOrDefault(field, Map.of()) : Map.of();
        }
        if (inner instanceof ConditionalExpr) {
            Expression then = ((ConditionalExpr) inner).getThenExpr();
            Expression otherwise = ((ConditionalExpr) inner).getElseExpr();
            return Conditions.union(conditionsOf(then, frame), elementsOf(then, frame),
                    conditionsOf(otherwise, frame), elementsOf(otherwise, frame));
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getScope().isPresent()) {
            String name = ((MethodCallExpr) inner).getNameAsString();
            if (name.equals("elementAt") || name.equals("get") || name.equals("firstElement") || name.equals("lastElement")) {
                Expression scope = unwrap(((MethodCallExpr) inner).getScope().get());
                String field = fieldName(scope);
                if (field != null && isVectorType(scope)) {
                    return fieldConditions.getOrDefault(field, Map.of());
                }
            }
        }
        return Map.of();
    }

    private static String child(String parent) {
        return parent.endsWith("//*") ? parent : parent + "/*";
    }

    /**
     * The path with its last step's wildcard narrowed to `name` (and `namespace`), or null when it cannot be.
     * A step narrowed to the XForms namespace is written bare, as a step Core matches in any namespace is, so it
     * is noted for its `namespace` fact.
     */
    private String narrowStep(String path, String namespace, String name) {
        String made = narrowed(path, namespace, name);
        if (made != null && namespace != null && !namespace.isEmpty() && qualified(namespace, "").isEmpty()) {
            xformsNamespaced.add(made);
        }
        return made;
    }

    private static String narrowed(String path, String namespace, String name) {
        int slash = path.lastIndexOf('/');
        String parent = slash < 0 ? "" : path.substring(0, slash + 1);
        String step = slash < 0 ? path : path.substring(slash + 1);
        String stepNamespacePrefix = step.contains(":") ? step.substring(0, step.indexOf(':') + 1) : "";
        String stepName = step.contains(":") ? step.substring(step.indexOf(':') + 1) : step;
        String wanted = namespace == null || namespace.isEmpty() ? "" : qualified(namespace, "").replace("}", "}");
        if (!wanted.isEmpty() && !stepNamespacePrefix.isEmpty() && !stepNamespacePrefix.equals(wanted)) {
            return null;
        }
        String prefix = wanted.isEmpty() ? stepNamespacePrefix : wanted;
        if (stepName.equals("*")) {
            return parent + prefix + name;
        }
        if (name.equals("*") || stepName.equals(name)) {
            return parent + prefix + stepName;
        }
        return null;
    }

    /** {element local, match} when the expression is an element's name. */
    private String[] nameOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.names.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.names.get(((NameExpr) inner).getNameAsString());
        }
        if (inner instanceof ConditionalExpr) {
            String[] then = nameOf(((ConditionalExpr) inner).getThenExpr(), frame);
            return then != null ? then : nameOf(((ConditionalExpr) inner).getElseExpr(), frame);
        }
        if (inner instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) inner;
            if (call.getNameAsString().equals("getName") && call.getArguments().isEmpty() && call.getScope().isPresent()) {
                String local = elementLocal(call.getScope().get(), frame);
                return local == null ? null : new String[]{local, "exact"};
            }
            if (call.getNameAsString().equals("toLowerCase") && call.getScope().isPresent()) {
                String[] name = nameOf(call.getScope().get(), frame);
                return name == null ? null : new String[]{name[0], "lowercased"};
            }
        }
        return null;
    }

    /** The local naming an element, when the expression is one (a local, or a field held in a fresh local). */
    private String elementLocal(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.elems.containsKey(((NameExpr) inner).getNameAsString())) {
            return ((NameExpr) inner).getNameAsString();
        }
        Set<String> paths = elementsOf(inner, frame);
        if (!paths.isEmpty()) {
            String synthetic = "<" + inner + ">";
            frame.elems.put(synthetic, paths);
            Map<String, Set<String>> conditions = conditionsOf(inner, frame);
            if (conditions.isEmpty()) {
                frame.conditions.remove(synthetic);
            } else {
                frame.conditions.put(synthetic, Conditions.copy(conditions));
            }
            return synthetic;
        }
        return null;
    }

    private String namespaceOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.namespaces.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.namespaces.get(((NameExpr) inner).getNameAsString());
        }
        if (inner instanceof ConditionalExpr) {
            String then = namespaceOf(((ConditionalExpr) inner).getThenExpr(), frame);
            return then != null ? then : namespaceOf(((ConditionalExpr) inner).getElseExpr(), frame);
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getNameAsString().equals("getNamespace")
                && ((MethodCallExpr) inner).getArguments().isEmpty() && ((MethodCallExpr) inner).getScope().isPresent()) {
            return elementLocal(((MethodCallExpr) inner).getScope().get(), frame);
        }
        return null;
    }

    private String attributeNameOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.attributeNames.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.attributeNames.get(((NameExpr) inner).getNameAsString());
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getNameAsString().equals("getAttributeName")
                && ((MethodCallExpr) inner).getArguments().size() == 1 && ((MethodCallExpr) inner).getScope().isPresent()) {
            return elementLocal(((MethodCallExpr) inner).getScope().get(), frame);
        }
        return null;
    }

    /** The attribute keys whose value an expression holds (a read, a local holding one, or a string derived from one). */
    private Set<String> valuesOf(Expression expression, Frame frame) {
        Set<String> out = new TreeSet<>();
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.values.containsKey(((NameExpr) inner).getNameAsString())) {
            return new TreeSet<>(frame.values.get(((NameExpr) inner).getNameAsString()));
        }
        if (inner instanceof ConditionalExpr) {
            out.addAll(valuesOf(((ConditionalExpr) inner).getThenExpr(), frame));
            out.addAll(valuesOf(((ConditionalExpr) inner).getElseExpr(), frame));
            return out;
        }
        if (inner instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) inner;
            String name = call.getNameAsString();
            if (name.equals("getAttributeValue") && call.getArguments().size() == 2 && call.getScope().isPresent()) {
                Set<String> paths = elementsOf(call.getScope().get(), frame);
                String namespace = unwrap(call.getArgument(0)) instanceof NullLiteralExpr ? null
                        : stringOf(call.getArgument(0), frame);
                String attribute = stringOf(call.getArgument(1), frame);
                if (attribute != null) {
                    for (String path : paths) {
                        out.add(path + "@" + qualified(namespace, attribute));
                    }
                }
                return out;
            }
            if (Set.of("substring", "trim", "toLowerCase", "toUpperCase", "intern").contains(name) && call.getScope().isPresent()) {
                return valuesOf(call.getScope().get(), frame);
            }
            // An own method returning an attribute's value (`getRequiredAttribute(e, "resource")`).
            Expression scope = call.getScope().map(XForms::unwrap).orElse(null);
            if (scope == null || scope instanceof ThisExpr) {
                for (CallableDeclaration<?> target : code.callables(context, name, call.getArguments().size())) {
                    out.addAll(returned.getOrDefault(memoKey(target, into(target, call, frame)), Set.of()));
                }
            }
        }
        return out;
    }

    /** A string an expression always has here. */
    private String stringOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.strings.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.strings.get(((NameExpr) inner).getNameAsString());
        }
        if (inner instanceof NameExpr && isLocal(((NameExpr) inner).getNameAsString(), inner)) {
            return null;
        }
        return code.constant(inner, context);
    }

    /** An integer an expression always has here: a literal, a static final field, or a parameter passed one. */
    private Long intOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof IntegerLiteralExpr) {
            return ((IntegerLiteralExpr) inner).asNumber().longValue();
        }
        if (inner instanceof UnaryExpr && ((UnaryExpr) inner).getOperator() == UnaryExpr.Operator.MINUS) {
            Long value = intOf(((UnaryExpr) inner).getExpression(), frame);
            return value == null ? null : -value;
        }
        if (inner instanceof NameExpr) {
            String name = ((NameExpr) inner).getNameAsString();
            if (frame.ints.containsKey(name)) {
                return frame.ints.get(name);
            }
            if (isLocal(name, inner)) {
                return null;
            }
            return intField(code.field(context, name));
        }
        if (inner instanceof FieldAccessExpr) {
            String owner = ((FieldAccessExpr) inner).getScope().toString();
            owner = owner.substring(owner.lastIndexOf('.') + 1);
            return intField(code.field(code.type(owner), ((FieldAccessExpr) inner).getNameAsString()));
        }
        return null;
    }

    private Long intField(VariableDeclarator field) {
        if (field == null || !field.getInitializer().isPresent()) {
            return null;
        }
        Node declaration = field.getParentNode().orElse(null);
        if (!(declaration instanceof FieldDeclaration) || !((FieldDeclaration) declaration).isFinal()) {
            return null;
        }
        TypeDeclaration<?> saved = context;
        context = Code.typeOf(field);
        try {
            return intOf(field.getInitializer().get(), new Frame());
        } finally {
            context = saved;
        }
    }

    private String tableOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr) {
            String name = ((NameExpr) inner).getNameAsString();
            if (frame.tables.containsKey(name)) {
                return frame.tables.get(name);
            }
            if (!isLocal(name, inner) && tables.containsKey(name)) {
                return name;
            }
        }
        if (inner instanceof FieldAccessExpr && tables.containsKey(((FieldAccessExpr) inner).getNameAsString())) {
            return ((FieldAccessExpr) inner).getNameAsString();
        }
        return null;
    }

    /** The constant strings a local array or list holds, when it holds only constants. */
    private Set<String> stringSet(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.strSets.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.strSets.get(((NameExpr) inner).getNameAsString());
        }
        if (inner instanceof ArrayCreationExpr && ((ArrayCreationExpr) inner).getInitializer().isPresent()) {
            inner = ((ArrayCreationExpr) inner).getInitializer().get();
        }
        if (inner instanceof ArrayInitializerExpr) {
            Set<String> out = new TreeSet<>();
            for (Expression value : ((ArrayInitializerExpr) inner).getValues()) {
                String text = stringOf(value, frame);
                if (text == null) {
                    return null;
                }
                out.add(text);
            }
            return out;
        }
        return null;
    }

    private Set<String> extensionsOf(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.extensions.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.extensions.get(((NameExpr) inner).getNameAsString());
        }
        if (inner instanceof NameExpr && ((NameExpr) inner).getNameAsString().equals("extensionParsers")
                && !isLocal("extensionParsers", inner)) {
            // The parser's own list, which only XFormUtils fills, with the parsers Android passes it.
            return new TreeSet<>(extensionParsers.keySet());
        }
        return new TreeSet<>();
    }

    // -- calls ----------------------------------------------------------------------------

    private void creation(ObjectCreationExpr creation, Frame frame) {
        String created = creation.getType().getNameAsString();
        if (Set.of("XPathReference", "XPathConditional").contains(created) && !creation.getArguments().isEmpty()) {
            for (String value : valuesOf(creation.getArgument(0), frame)) {
                attributeFact(value, "parsedAs", "xpath");
            }
        }
    }

    private void call(MethodCallExpr call, Frame frame) {
        String name = call.getNameAsString();
        Expression scope = call.getScope().map(XForms::unwrap).orElse(null);
        int arity = call.getArguments().size();

        // A method of a local holding an element's namespace (`namespace.equals(...)`): the namespace is used.
        if (scope instanceof NameExpr && !deferringNamespace && frame.namespaces.containsKey(((NameExpr) scope).getNameAsString())) {
            namespaceUse(frame.namespaces.get(((NameExpr) scope).getNameAsString()), frame, call);
        }

        // Reads of an element.
        Set<String> on = scope == null ? Set.of() : elementsOf(scope, frame);
        if (!on.isEmpty()) {
            if (name.equals("getAttributeValue") && arity == 2) {
                String namespace = unwrap(call.getArgument(0)) instanceof NullLiteralExpr ? null
                        : stringOf(call.getArgument(0), frame);
                String attribute = stringOf(call.getArgument(1), frame);
                if (attribute == null) {
                    throw new IllegalStateException("The XForm reader cannot resolve the attribute read at "
                            + code.where(call) + ": " + call);
                }
                for (String path : on) {
                    attribute(path, namespace, attribute, "named", call);
                }
                return;
            }
            if ((name.equals("getAttributeValue") || name.equals("getAttributeName")
                    || name.equals("getAttributeNamespace")) && arity == 1 || name.equals("getAttributeCount")) {
                for (String path : on) {
                    elementFact(path, "readsAttributesByPosition", true, call);
                }
                return;
            }
            if ((name.equals("getText") || name.equals("isText")) && arity == 1) {
                for (String path : on) {
                    elementFact(path, "readsText", true, call);
                }
                return;
            }
            if (name.equals("getNamespaceUri") || name.equals("getNamespacePrefix") || name.equals("getNamespaceCount")) {
                for (String path : on) {
                    elementFact(path, "readsNamespaceDeclarations", true, call);
                }
                return;
            }
            if (name.equals("getNamespace") && arity == 0) {
                if (deferringNamespace) {
                    return;  // bound to a local: read where the local is used
                }
                Map<String, Set<String>> conditions = conditionsOf(scope, frame);
                for (String path : on) {
                    namespaceRead(path, conditions.getOrDefault(path, Set.of()), call);
                }
                return;
            }
            if (name.equals("write") && arity == 1) {
                for (String path : on) {
                    elementFact(path, "writtenWhole", true, call);
                }
                return;
            }
        }

        // A freshly made object's boolean field set from a literal.
        if (scope instanceof NameExpr && arity == 1 && frame.types.containsKey(((NameExpr) scope).getNameAsString())
                && unwrap(call.getArgument(0)) instanceof BooleanLiteralExpr) {
            String local = ((NameExpr) scope).getNameAsString();
            String field = accessedField(code.type(frame.types.get(local)), name, 1);
            if (field != null) {
                frame.flags.put(local + "." + field, ((BooleanLiteralExpr) unwrap(call.getArgument(0))).getValue());
                return;
            }
        }

        // An attribute's value parsed as XPath.
        if ((name.equals("parseXPath") || name.equals("getPathExpr")) && arity == 1) {
            for (String value : valuesOf(call.getArgument(0), frame)) {
                attributeFact(value, "parsedAs", "xpath");
            }
        }

        // Vectors.
        if (scope instanceof NameExpr && (name.equals("addElement") || name.equals("add")) && arity == 1) {
            String holder = ((NameExpr) scope).getNameAsString();
            Set<String> paths = elementsOf(call.getArgument(0), frame);
            if (frame.vectors.containsKey(holder)) {
                frame.vectors.get(holder).addAll(paths);
                String text = stringOf(call.getArgument(0), frame);
                Set<String> texts = stringSet(call.getArgument(0), frame);
                if (text != null || texts != null) {
                    Set<String> set = frame.strSets.computeIfAbsent(holder, k -> new TreeSet<>());
                    if (text != null) {
                        set.add(text);
                    }
                    if (texts != null) {
                        set.addAll(texts);
                    }
                }
            } else if (!isLocal(holder, scope)) {
                String field = fieldName(scope);
                if (field != null) {
                    addToField(field, paths, conditionsOf(call.getArgument(0), frame));
                }
            }
            return;
        }
        if (scope instanceof NameExpr && frame.strSets.containsKey(((NameExpr) scope).getNameAsString())
                && name.equals("addElement")) {
            return;
        }

        // Comparisons of an attribute's value.
        if (Set.of("equals", "equalsIgnoreCase", "startsWith", "endsWith", "contains").contains(name) && arity == 1
                && scope != null) {
            compare(call, scope, call.getArgument(0), name, frame);
            if (name.equals("equals") || name.equals("equalsIgnoreCase")) {
                compare(call, call.getArgument(0), scope, name, frame);
            }
            return;
        }

        // Handler dispatch: `table.get(name).handle(this, e, parent)` or a local holding the lookup.
        if (name.equals("handle") && arity == 3 && scope != null) {
            Set<String> elementPaths = elementsOf(call.getArgument(1), frame);
            if (scope instanceof NameExpr && frame.lookups.containsKey(((NameExpr) scope).getNameAsString())) {
                dispatch(frame.lookups.get(((NameExpr) scope).getNameAsString())[0], elementPaths, call);
                return;
            }
            if (scope instanceof MethodCallExpr && ((MethodCallExpr) scope).getNameAsString().equals("get")
                    && ((MethodCallExpr) scope).getScope().isPresent()) {
                String table = tableOf(((MethodCallExpr) scope).getScope().get(), frame);
                if (table != null) {
                    dispatch(table, elementPaths, call);
                    return;
                }
            }
            if (scope instanceof NameExpr && frame.handlers.containsKey(((NameExpr) scope).getNameAsString())) {
                for (Handler handler : frame.handlers.get(((NameExpr) scope).getNameAsString())) {
                    invoke(handler, elementPaths);
                }
                return;
            }
        }

        // Extension parsers: `parser.parse(e)` on a parser `canParse` admitted.
        if (scope instanceof NameExpr && frame.extensions.containsKey(((NameExpr) scope).getNameAsString())
                && name.equals("parse") && arity == 1) {
            for (String parserName : frame.extensions.get(((NameExpr) scope).getNameAsString())) {
                TypeDeclaration<?> type = code.type(parserName);
                Frame callee = new Frame();
                List<CallableDeclaration<?>> targets = code.callables(type, "parse", 1);
                for (CallableDeclaration<?> target : targets) {
                    Set<String> narrowed = new TreeSet<>();
                    for (String path : elementsOf(call.getArgument(0), frame)) {
                        String one = narrowStep(path, null, extensionParsers.get(parserName));
                        if (one != null) {
                            narrowed.add(one);
                        }
                    }
                    callee.elems.put(target.getParameter(0).getNameAsString(), narrowed);
                    method(target, callee);
                }
            }
            return;
        }

        // Own methods: no scope, `this`, the handler's parser parameter, or the parser class itself.
        boolean own = scope == null || scope instanceof ThisExpr
                || (scope instanceof NameExpr && ((NameExpr) scope).getNameAsString().equals(frame.self))
                || (scope instanceof NameExpr && context != null
                && ((NameExpr) scope).getNameAsString().equals(context.getNameAsString()));
        TypeDeclaration<?> lookup = own ? (scope instanceof NameExpr && ((NameExpr) scope).getNameAsString().equals(frame.self)
                ? parser : context) : null;
        if (!own && scope instanceof NameExpr && !isLocal(((NameExpr) scope).getNameAsString(), scope)) {
            // A static method of another class handed an element or an attribute's value.
            TypeDeclaration<?> helper = code.type(((NameExpr) scope).getNameAsString());
            if (helper != null && handsSomething(call, frame)) {
                lookup = helper;
            }
        }
        if (lookup != null) {
            for (CallableDeclaration<?> target : code.callables(lookup, name, arity)) {
                if (!own && !target.isStatic()) {
                    continue;
                }
                method(target, into(target, call, frame));
            }
        }
    }

    /** Whether a call hands its callee an element or an attribute's value. */
    private boolean handsSomething(MethodCallExpr call, Frame frame) {
        for (Expression argument : call.getArguments()) {
            if (!elementsOf(argument, frame).isEmpty() || !valuesOf(argument, frame).isEmpty()) {
                return true;
            }
        }
        return false;
    }

    /** Core reads the namespace of an element at `path`, under `conditions` (`Conditions`; none for every one). */
    private void namespaceRead(String path, Set<String> conditions, Node at) {
        if (named(path)) {
            attribute(path, "", "xmlns", "namespace", at);
            namespaceReads.computeIfAbsent(path + "@xmlns", k -> new java.util.LinkedHashSet<>())
                    .add(new ArrayList<>(new TreeSet<>(conditions)));
        }
    }

    /** Records a comparison of an attribute's value (`left.method(right)`) with a constant. */
    private void compare(MethodCallExpr call, Expression left, Expression right, String method, Frame frame) {
        Set<String> held = valuesOf(left, frame);
        String value = stringOf(right, frame);
        if (!held.isEmpty() && value != null) {
            for (String key : held) {
                attributeFact(key, "compared", method + " " + value);
            }
        }
        String element = namespaceOf(left, frame);
        if (element != null && value != null) {
            Map<String, Set<String>> conditions = frame.conditions.getOrDefault(element, Map.of());
            for (String path : frame.elems.getOrDefault(element, Set.of())) {
                namespaceRead(path, conditions.getOrDefault(path, Set.of()), call);
                attributeFact(path + "@xmlns", "compared", method + " " + value);
            }
        }
    }

    /** Enters each handler of `table` for the keys an element can have. */
    private void dispatch(String table, Set<String> paths, Node at) {
        for (String path : paths) {
            int slash = path.lastIndexOf('/');
            String under = slash < 0 ? "(root)" : path.endsWith("//*") ? path.substring(0, path.length() - 1)
                    : path.substring(0, slash);
            String step = path.substring(slash + 1);
            String stepName = step.contains(":") ? step.substring(step.indexOf(':') + 1) : step;
            for (Map.Entry<String, List<Handler>> entry : tables.getOrDefault(table, Map.of()).entrySet()) {
                if (!stepName.equals("*") && !stepName.equals(entry.getKey())) {
                    continue;
                }
                String key = entry.getKey();
                // The table is keyed by the element's local name, whatever its namespace.
                elementFact(key, "match", "table " + table, at);
                elementFact(key, "dispatchedBy", table, at);
                elementFact(key, "dispatchedUnder", under, at);
                for (Handler handler : entry.getValue()) {
                    invoke(handler, Set.of(key));
                }
            }
        }
    }

    /** Runs a handler with its element at `paths`. */
    private void invoke(Handler handler, Set<String> paths) {
        if (handler.lambda != null) {
            LambdaExpr lambda = handler.lambda;
            Frame frame = new Frame();
            frame.self = lambda.getParameters().get(0).getNameAsString();
            frame.elems.put(lambda.getParameters().get(1).getNameAsString(), new TreeSet<>(paths));
            if (handler.captured != null) {
                frame.handlers.put(handler.captureName, List.of(handler.captured));
            }
            String id = code.where(lambda) + "#lambda" + frame.key();
            if (!visited.add(id)) {
                return;
            }
            TypeDeclaration<?> saved = context;
            List<Exits> savedExits = exits;
            context = Code.typeOf(lambda);
            exits = new ArrayList<>();
            try {
                if (lambda.getBody() instanceof ExpressionStmt) {
                    expression(((ExpressionStmt) lambda.getBody()).getExpression(), frame);
                } else {
                    statement(lambda.getBody(), frame);
                }
            } finally {
                context = saved;
                exits = savedExits;
            }
            return;
        }
        for (CallableDeclaration<?> target : code.callables(handler.type, "handle", 3)) {
            Frame frame = new Frame();
            frame.self = target.getParameter(0).getNameAsString();
            frame.elems.put(target.getParameter(1).getNameAsString(), new TreeSet<>(paths));
            method(target, frame);
        }
    }

    /** What a callee's parameters hold from the caller's arguments. */
    private Frame into(CallableDeclaration<?> target, MethodCallExpr call, Frame frame) {
        Frame callee = new Frame();
        callee.self = frame.self;
        List<Parameter> parameters = target.getParameters();
        String id = (Code.typeOf(target) == null ? "?" : Code.qualifiedName(Code.typeOf(target))) + "#"
                + target.getDeclarationAsString(false, false, false);
        for (int i = 0; i < parameters.size() && i < call.getArguments().size(); i++) {
            String parameter = parameters.get(i).getNameAsString();
            Expression argument = unwrap(call.getArgument(i));
            Set<String> paths = elementsOf(argument, frame);
            if (!paths.isEmpty()) {
                Set<String> collapsed = collapse(id, paths);
                callee.elems.put(parameter, collapsed);
                // The conditions of the paths the callee is handed as they are (a collapsed one keeps none).
                Map<String, Set<String>> conditions = new TreeMap<>();
                conditionsOf(argument, frame).forEach((path, held) -> {
                    if (collapsed.contains(path)) {
                        Conditions.put(conditions, path, held);
                    }
                });
                if (!conditions.isEmpty()) {
                    callee.conditions.put(parameter, conditions);
                }
            }
            Set<String> held = valuesOf(argument, frame);
            if (!held.isEmpty()) {
                callee.values.put(parameter, held);
            }
            String text = stringOf(argument, frame);
            if (text != null) {
                callee.strings.put(parameter, text);
            }
            Long number = intOf(argument, frame);
            if (number != null) {
                callee.ints.put(parameter, number);
            }
            Boolean known = evaluate(argument, frame);
            if (known != null) {
                callee.booleans.put(parameter, known);
            }
            String table = tableOf(argument, frame);
            if (table != null) {
                callee.tables.put(parameter, table);
            }
            if (argument instanceof NameExpr && frame.handlers.containsKey(((NameExpr) argument).getNameAsString())) {
                callee.handlers.put(parameter, frame.handlers.get(((NameExpr) argument).getNameAsString()));
            }
            Set<String> held2 = vectorPaths(argument, frame);
            if (!held2.isEmpty()) {
                callee.vectors.put(parameter, held2);
            }
        }
        return callee;
    }

    /** A method entered again on descendants of the element it already reads reads `X//*`. */
    @SuppressWarnings("unchecked")
    private Set<String> collapse(String id, Set<String> paths) {
        Set<String> out = new TreeSet<>();
        for (String path : paths) {
            String collapsed = path;
            for (Object[] entered : stack) {
                if (!entered[0].equals(id)) {
                    continue;
                }
                for (String held : (Set<String>) entered[1]) {
                    String base = held.endsWith("//*") ? held.substring(0, held.length() - 3) : held;
                    if (!base.isEmpty() && collapsed.startsWith(base + "/") && !collapsed.equals(base + "//*")) {
                        collapsed = base + "//*";
                    }
                }
            }
            out.add(collapsed);
        }
        return out;
    }

    // -- conditions -----------------------------------------------------------------------

    /**
     * Attributes read by position and picked by name: `name.equals("x")` on a local holding
     * `getAttributeName(i)`, with the namespace a conjunct tests on `getAttributeNamespace(i)`.
     */
    private void attributeNameTests(Expression condition, Frame frame) {
        List<Expression> conjuncts = new ArrayList<>();
        conjuncts(condition, conjuncts);
        String namespace = null;
        for (Expression conjunct : conjuncts) {
            String[] test = equalityWith(conjunct, frame.attributeNamespaces, frame);
            if (test != null) {
                namespace = test[1];
            }
        }
        for (Expression conjunct : conjuncts) {
            String[] test = equalityWith(conjunct, frame.attributeNames, frame);
            if (test != null) {
                for (String path : frame.elems.getOrDefault(test[0], Set.of())) {
                    attribute(path, namespace == null ? null : namespace, test[1], "by position, name tested", conjunct);
                }
            }
        }
        for (Expression conjunct : conjuncts) {
            if (unwrap(conjunct) instanceof BinaryExpr && ((BinaryExpr) unwrap(conjunct)).getOperator() == BinaryExpr.Operator.OR) {
                attributeNameTests(((BinaryExpr) unwrap(conjunct)).getLeft(), frame);
                attributeNameTests(((BinaryExpr) unwrap(conjunct)).getRight(), frame);
            }
        }
    }

    private static void conjuncts(Expression expression, List<Expression> out) {
        Expression inner = unwrap(expression);
        if (inner instanceof BinaryExpr && ((BinaryExpr) inner).getOperator() == BinaryExpr.Operator.AND) {
            conjuncts(((BinaryExpr) inner).getLeft(), out);
            conjuncts(((BinaryExpr) inner).getRight(), out);
        } else {
            out.add(inner);
        }
    }

    /** {element local, constant} for `local.equals(constant)` (either way round) on a local of `held`. */
    private String[] equalityWith(Expression expression, Map<String, String> held, Frame frame) {
        Expression inner = unwrap(expression);
        if (!(inner instanceof MethodCallExpr) || !((MethodCallExpr) inner).getNameAsString().equals("equals")
                || ((MethodCallExpr) inner).getArguments().size() != 1 || !((MethodCallExpr) inner).getScope().isPresent()) {
            return null;
        }
        Expression[] sides = {unwrap(((MethodCallExpr) inner).getScope().get()), unwrap(((MethodCallExpr) inner).getArgument(0))};
        for (int i = 0; i < 2; i++) {
            if (sides[i] instanceof NameExpr && held.containsKey(((NameExpr) sides[i]).getNameAsString())) {
                String value = stringOf(sides[1 - i], frame);
                if (value != null) {
                    return new String[]{held.get(((NameExpr) sides[i]).getNameAsString()), value};
                }
            }
        }
        return null;
    }

    /** The value a condition always has here, or null. */
    private Boolean evaluate(Expression condition, Frame frame) {
        Expression inner = unwrap(condition);
        if (inner instanceof BooleanLiteralExpr) {
            return ((BooleanLiteralExpr) inner).getValue();
        }
        if (inner instanceof NameExpr && frame.booleans.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.booleans.get(((NameExpr) inner).getNameAsString());
        }
        if (inner instanceof UnaryExpr && ((UnaryExpr) inner).getOperator() == UnaryExpr.Operator.LOGICAL_COMPLEMENT) {
            Boolean value = evaluate(((UnaryExpr) inner).getExpression(), frame);
            return value == null ? null : !value;
        }
        if (inner instanceof BinaryExpr) {
            BinaryExpr binary = (BinaryExpr) inner;
            BinaryExpr.Operator operator = binary.getOperator();
            if (operator == BinaryExpr.Operator.AND || operator == BinaryExpr.Operator.OR) {
                Boolean left = evaluate(binary.getLeft(), frame);
                Boolean right = evaluate(binary.getRight(), frame);
                boolean and = operator == BinaryExpr.Operator.AND;
                if (left != null && left != and) {
                    return !and;
                }
                if (right != null && right != and) {
                    return !and;
                }
                return left != null && right != null ? and : null;
            }
            if (operator == BinaryExpr.Operator.EQUALS || operator == BinaryExpr.Operator.NOT_EQUALS) {
                Long left = intOf(binary.getLeft(), frame);
                Long right = intOf(binary.getRight(), frame);
                if (left != null && right != null) {
                    return (left.equals(right)) == (operator == BinaryExpr.Operator.EQUALS);
                }
            }
            return null;
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getArguments().isEmpty()
                && ((MethodCallExpr) inner).getScope().isPresent()
                && unwrap(((MethodCallExpr) inner).getScope().get()) instanceof NameExpr) {
            String local = ((NameExpr) unwrap(((MethodCallExpr) inner).getScope().get())).getNameAsString();
            String type = frame.types.get(local);
            String field = type == null ? null : accessedField(code.type(type), ((MethodCallExpr) inner).getNameAsString(), 0);
            return field == null ? null : frame.flags.get(local + "." + field);
        }
        return null;
    }

    /** Narrows the frame by a condition's element tests: as true (`then`) or false. */
    private void narrow(Expression condition, Frame frame, boolean then) {
        Expression inner = unwrap(condition);
        if (inner instanceof UnaryExpr && ((UnaryExpr) inner).getOperator() == UnaryExpr.Operator.LOGICAL_COMPLEMENT) {
            narrow(((UnaryExpr) inner).getExpression(), frame, !then);
            return;
        }
        if (inner instanceof BinaryExpr) {
            BinaryExpr binary = (BinaryExpr) inner;
            boolean and = binary.getOperator() == BinaryExpr.Operator.AND;
            boolean or = binary.getOperator() == BinaryExpr.Operator.OR;
            if ((and && then) || (or && !then)) {
                narrow(binary.getLeft(), frame, then);
                narrow(binary.getRight(), frame, then);
                return;
            }
            if ((or && then) || (and && !then)) {
                // Either side may hold: the union of each side's narrowing, each path under the conditions both
                // sides agree on (a side holding no element there leaves the other's).
                Frame left = frame.copy();
                narrow(binary.getLeft(), left, then);
                Frame right = frame.copy();
                narrow(binary.getRight(), right, then);
                for (String local : new ArrayList<>(frame.elems.keySet())) {
                    Set<String> leftPaths = left.elems.getOrDefault(local, Set.of());
                    Set<String> rightPaths = right.elems.getOrDefault(local, Set.of());
                    Set<String> union = new TreeSet<>(leftPaths);
                    union.addAll(rightPaths);
                    frame.elems.put(local, union);
                    Map<String, Set<String>> conditions = Conditions.union(left.conditions.getOrDefault(local, Map.of()),
                            leftPaths, right.conditions.getOrDefault(local, Map.of()), rightPaths);
                    if (conditions.isEmpty()) {
                        frame.conditions.remove(local);
                    } else {
                        frame.conditions.put(local, conditions);
                    }
                }
                frame.nullFields.clear();
                frame.nullFields.addAll(left.nullFields);
                frame.nullFields.retainAll(right.nullFields);
                frame.nullChildrenOf.clear();
                left.nullChildrenOf.forEach((local, parent) -> {
                    if (parent.equals(right.nullChildrenOf.get(local))) {
                        frame.nullChildrenOf.put(local, parent);
                    }
                });
                return;
            }
            if (binary.getOperator() == BinaryExpr.Operator.EQUALS || binary.getOperator() == BinaryExpr.Operator.NOT_EQUALS) {
                // `x == null` / `x != null`: a null element holds nothing.
                boolean equals = binary.getOperator() == BinaryExpr.Operator.EQUALS;
                Expression other = unwrap(binary.getLeft()) instanceof NullLiteralExpr ? binary.getRight()
                        : unwrap(binary.getRight()) instanceof NullLiteralExpr ? binary.getLeft() : null;
                if (other != null && unwrap(other) instanceof NameExpr && equals == then) {
                    isNull((NameExpr) unwrap(other), frame);
                }
            }
            return;
        }
        if (!(inner instanceof MethodCallExpr)) {
            return;
        }
        MethodCallExpr call = (MethodCallExpr) inner;
        String method = call.getNameAsString();
        if (!then) {
            // A failed name test narrows a concrete set (`name` was not this one); a wildcard stays, now known to
            // name none of the names tested (`not-named:`).
            for (Object[] test : nameTests(call, frame)) {
                String local = (String) test[0];
                @SuppressWarnings("unchecked")
                Set<String> names = (Set<String>) test[1];
                Set<String> kept = new TreeSet<>();
                for (String path : frame.elems.getOrDefault(local, Set.of())) {
                    String step = path.substring(path.lastIndexOf('/') + 1);
                    String stepName = step.contains(":") ? step.substring(step.indexOf(':') + 1) : step;
                    if (stepName.equals("*") || !names.contains(stepName)) {
                        kept.add(path);
                    }
                }
                frame.elems.put(local, kept);
                Map<String, Set<String>> conditions = frame.conditions.get(local);
                if (conditions != null) {
                    conditions.keySet().retainAll(kept);
                }
                String match = (String) test[2];
                // A table's key some platform alone registers (Android's) rules nothing out on the others: only
                // the keys every platform holds do, and an extension parser (Android's) none.
                Set<String> failed = match.startsWith("table ") ? everyPlatformKeys(match.substring(6))
                        : match.equals("extension parser") ? Set.of() : names;
                notNamed(frame, local, failed, match);
            }
            return;
        }
        for (Object[] test : nameTests(call, frame)) {
            String local = (String) test[0];
            @SuppressWarnings("unchecked")
            Set<String> names = (Set<String>) test[1];
            String match = (String) test[2];
            String namespace = (String) test[3];
            Set<String> narrowed = new TreeSet<>();
            for (String path : frame.elems.getOrDefault(local, Set.of())) {
                for (String one : names) {
                    String made = narrowStep(path, namespace, one);
                    if (made != null) {
                        narrowed.add(made);
                        if (!one.equals("*")) {
                            elementFact(made, "match", match, call);
                        }
                    }
                }
            }
            frame.elems.put(local, narrowed);
            // A path the test leaves as it was keeps its conditions; a narrowed one is a name of its own.
            Map<String, Set<String>> conditions = frame.conditions.get(local);
            if (conditions != null) {
                conditions.keySet().retainAll(narrowed);
                if (conditions.isEmpty()) {
                    frame.conditions.remove(local);
                }
            }
        }
    }

    /** The element `local` holds names none of `names` (a failed test): its wildcard paths are `not-named:`. */
    private static void notNamed(Frame frame, String local, Set<String> names, String match) {
        String token = "ignore-case".equals(match) || "lowercased".equals(match) ? "not-named-ignoring-case:" : "not-named:";
        Set<String> wildcards = new TreeSet<>();
        for (String path : frame.elems.getOrDefault(local, Set.of())) {
            String step = path.substring(path.lastIndexOf('/') + 1);
            if ((step.contains(":") ? step.substring(step.indexOf(':') + 1) : step).equals("*")) {
                wildcards.add(path);
            }
        }
        for (String name : names) {
            if (!name.equals("*")) {
                Conditions.add(frame, local, wildcards, token + name);
            }
        }
        if (frame.conditions.containsKey(local) && frame.conditions.get(local).isEmpty()) {
            frame.conditions.remove(local);
        }
    }

    /**
     * What a test finding `x` null establishes here: an element local holds nothing (and, where it held the
     * children of another local's element, stands for none of them: `nullChildrenOf`); the element a name local
     * names is null too; the element a handler lookup was made for has no handler in that table (`not-named:`
     * each key); the element an attribute value local was read on lacks the attribute (`without:`); a field is
     * found null (`nullFields`).
     */
    private void isNull(NameExpr x, Frame frame) {
        String name = x.getNameAsString();
        if (frame.elems.containsKey(name)) {
            String parent = parentOfChildren(frame, name);
            if (parent != null) {
                frame.nullChildrenOf.put(name, parent);
            }
            frame.elems.put(name, new TreeSet<>());
            frame.conditions.remove(name);
        }
        String[] named = frame.names.get(name);
        if (named != null && frame.elems.containsKey(named[0])) {
            frame.elems.put(named[0], new TreeSet<>());
            frame.conditions.remove(named[0]);
        }
        String[] lookup = frame.lookups.get(name);
        if (lookup != null && tables.containsKey(lookup[0])) {
            notNamed(frame, lookup[1], everyPlatformKeys(lookup[0]), "exact");
        }
        for (String value : frame.values.getOrDefault(name, Set.of())) {
            int at = value.lastIndexOf('@');
            String path = value.substring(0, at);
            String attribute = value.substring(at + 1);
            for (Map.Entry<String, Set<String>> held : new ArrayList<>(frame.elems.entrySet())) {
                if (held.getValue().contains(path)) {
                    Conditions.add(frame, held.getKey(), Set.of(path), "without:" + attribute);
                }
            }
        }
        if (!isLocal(name, x)) {
            String field = fieldName(x);
            if (field != null) {
                frame.nullFields.add(field);
            }
        }
    }

    /** The local whose element's children `local` holds (each of its paths a `P/*` of that local's), if one. */
    private static String parentOfChildren(Frame frame, String local) {
        Set<String> paths = frame.elems.getOrDefault(local, Set.of());
        if (paths.isEmpty()) {
            return null;
        }
        Set<String> parents = new TreeSet<>();
        for (String path : paths) {
            if (!path.endsWith("/*") || path.endsWith("//*")) {
                return null;
            }
            parents.add(path.substring(0, path.length() - 2));
        }
        String found = null;
        for (Map.Entry<String, Set<String>> held : frame.elems.entrySet()) {
            if (!held.getKey().equals(local) && !held.getKey().startsWith("<") && held.getValue().equals(parents)) {
                if (found != null) {
                    return null;
                }
                found = held.getKey();
            }
        }
        return found;
    }

    /** The element tests a call makes: {element local, names, match, namespace}. */
    private List<Object[]> nameTests(MethodCallExpr call, Frame frame) {
        List<Object[]> found = new ArrayList<>();
        String method = call.getNameAsString();
        Expression scope = call.getScope().map(XForms::unwrap).orElse(null);
        if ((method.equals("equals") || method.equals("equalsIgnoreCase") || method.equals("contentEquals"))
                && call.getArguments().size() == 1 && scope != null) {
            Expression[] sides = {scope, call.getArgument(0)};
            for (int i = 0; i < 2; i++) {
                String[] name = nameOf(sides[i], frame);
                String value = stringOf(sides[1 - i], frame);
                if (name != null && value != null) {
                    found.add(new Object[]{name[0], Set.of(value), method.equals("equalsIgnoreCase") ? "ignore-case"
                            : name[1], null});
                }
                String element = namespaceOf(sides[i], frame);
                if (element != null && value != null) {
                    found.add(new Object[]{element, Set.of("*"), "namespace", value});
                }
            }
            return found;
        }
        if (method.equals("containsKey") && call.getArguments().size() == 1 && scope != null) {
            String table = tableOf(scope, frame);
            String[] name = nameOf(call.getArgument(0), frame);
            if (table != null && name != null) {
                found.add(new Object[]{name[0], new TreeSet<>(tables.get(table).keySet()), "table " + table, null});
            }
            return found;
        }
        if (method.equals("contains") && call.getArguments().size() == 1 && scope != null) {
            Set<String> listed = stringSet(scope, frame);
            String[] name = nameOf(call.getArgument(0), frame);
            if (listed != null && name != null) {
                found.add(new Object[]{name[0], listed, "listed", null});
            }
            return found;
        }
        if (method.equals("canParse") && call.getArguments().size() == 1 && scope instanceof NameExpr
                && frame.extensions.containsKey(((NameExpr) scope).getNameAsString())) {
            String local = elementLocal(call.getArgument(0), frame);
            Set<String> names = new TreeSet<>();
            for (String parserName : frame.extensions.get(((NameExpr) scope).getNameAsString())) {
                names.add(extensionParsers.get(parserName));
            }
            if (local != null) {
                found.add(new Object[]{local, names, "extension parser", null});
            }
            return found;
        }
        // A static helper returning a test of its element parameter (`XFormUtils.isOutput(kid)`).
        if (call.getArguments().size() == 1 && scope instanceof NameExpr && code.type(((NameExpr) scope).getNameAsString()) != null) {
            String local = elementLocal(call.getArgument(0), frame);
            if (local == null) {
                return found;
            }
            for (CallableDeclaration<?> target : code.callables(code.type(((NameExpr) scope).getNameAsString()), method, 1)) {
                if (!(target instanceof MethodDeclaration) || !((MethodDeclaration) target).getBody().isPresent()) {
                    continue;
                }
                List<Statement> body = ((MethodDeclaration) target).getBody().get().getStatements();
                if (body.size() == 1 && body.get(0) instanceof ReturnStmt && ((ReturnStmt) body.get(0)).getExpression().isPresent()
                        && unwrap(((ReturnStmt) body.get(0)).getExpression().get()) instanceof MethodCallExpr) {
                    Frame callee = new Frame();
                    callee.elems.put(target.getParameter(0).getNameAsString(), new TreeSet<>(Set.of("*")));
                    TypeDeclaration<?> saved = context;
                    context = Code.typeOf(target);
                    try {
                        for (Object[] test : nameTests((MethodCallExpr) unwrap(((ReturnStmt) body.get(0)).getExpression().get()),
                                callee)) {
                            found.add(new Object[]{local, test[1], test[2], test[3]});
                        }
                    } finally {
                        context = saved;
                    }
                }
            }
        }
        return found;
    }

    // -- output ---------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Object plain(Object value) {
        if (value instanceof Map) {
            Map<String, Object> out = new TreeMap<>();
            for (Map.Entry<String, Object> entry : ((Map<String, Object>) value).entrySet()) {
                out.put(entry.getKey(), plain(entry.getValue()));
            }
            return out;
        }
        if (value instanceof Set) {
            List<Object> out = new ArrayList<>();
            for (Object element : new TreeSet<>((Set<Object>) value)) {
                out.add(plain(element));
            }
            return out;
        }
        return value;
    }

}
