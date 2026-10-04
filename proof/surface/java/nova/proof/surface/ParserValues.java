package nova.proof.surface;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.ArrayAccessExpr;
import com.github.javaparser.ast.expr.ArrayCreationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.AssignExpr;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.CastExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.InstanceOfExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.expr.SuperExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.expr.UnaryExpr;
import com.github.javaparser.ast.expr.VariableDeclarationExpr;
import com.github.javaparser.ast.stmt.CatchClause;
import com.github.javaparser.ast.stmt.DoStmt;
import com.github.javaparser.ast.stmt.ExplicitConstructorInvocationStmt;
import com.github.javaparser.ast.stmt.ExpressionStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ForStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.SwitchStmt;
import com.github.javaparser.ast.stmt.ThrowStmt;
import com.github.javaparser.ast.stmt.WhileStmt;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Where the value of each attribute a suite or profile parser reads goes: whether Core's XPath parser
 * parses it as an expression of its own (`XPathParseTool.parseXPath`, `XPathReference.getPathExpr`,
 * `new XPathReference`, `new XPathConditional`), read over Core's and Android's whole Java.
 *
 * Each read (`parser.getAttributeValue(ns, "name")`, where the parser family found it) is followed
 * through what carries its value: locals and parameters (each where its declaration holds),
 * conditional expressions, the String methods that return a string made of it (`trim`,
 * `substring`...), collections it is put in and the elements read back out of them (a map's keys
 * apart from what it maps them to: `extras.put(key, value)` gives `value` to `extras.get(key)` and
 * `key` to `extras.keys()`), the arguments of the methods and constructors of the classes the sources
 * hold (their overrides in subclasses and implementations too, and `this(...)`), the fields they are
 * stored in, and what a method returns at each call whose receiver may be of its class.
 *
 * A field is read where its class, a subclass or an inner class reads it, never in the methods that
 * write or read an object's serialized form, and through a local object only where that method does
 * not store the field itself (`Text.XPathText` reads back the argument it just stored). A field
 * stored by a constructor carries the constants that constructor (the one `new` ran, with those it
 * delegates to) gives the object's other fields, `false` for a boolean none assigns, and a factory's
 * local object those it assigns (`t.type = TEXT_TYPE_FLAT`); a read in a branch on those fields that
 * they rule out (`switch (type)`, `if (valueIsXpath)`, or a method only such branches call) is not
 * reached. So `Text` parses only an `XPathText`'s argument, and a stack step only a value its
 * constructor marks as XPath.
 *
 * A value that leaves the model a parser builds is followed once: what its getter returns, read at a
 * call in another class (the session parsing `SessionDatum.getValue()`); a further hop is recorded
 * (`beyond`), not followed, since past it a value is data of the runtime's (a datum id becoming a
 * tree element's name), not an expression. A value concatenated into a longer text Core parses is
 * `embedded`, unless it is a whole argument of a function the text calls (`"string(" + function +
 * ")"`), which is parsed.
 *
 * A read reaches a parse, or it is followed to its end: compared, measured, turned into a number, a
 * URL or an exception's message, written to a stream or a log. A value handed to a library method the
 * reader knows nothing of is an escape, and one whose route needs a receiver the reader cannot type is
 * `untyped`; both are recorded with where they happened.
 */
final class ParserValues {
    private static final Set<String> SINK_CALLS = Set.of("parseXPath", "getPathExpr");
    private static final Set<String> SINK_TYPES = Set.of("XPathReference", "XPathConditional");
    /** Methods on a value (or a collection of values) whose result is made of it. */
    private static final Set<String> DERIVING = Set.of("trim", "strip", "toLowerCase", "toUpperCase", "substring",
            "replace", "replaceAll", "replaceFirst", "intern", "concat", "split", "toString", "toCharArray", "get",
            "elementAt", "firstElement", "lastElement", "remove", "pop", "peek", "poll", "next", "nextElement",
            "elements", "iterator", "values", "keySet", "keys", "entrySet", "getValue", "getKey", "toArray",
            "subList", "clone", "getOrDefault", "listIterator", "previous");
    /** Methods on a value whose result says something of it, but is not made of it. */
    private static final Set<String> MEASURING = Set.of("equals", "equalsIgnoreCase", "contentEquals", "length",
            "isEmpty", "startsWith", "endsWith", "contains", "containsKey", "containsValue", "indexOf",
            "lastIndexOf", "compareTo", "compareToIgnoreCase", "hashCode", "size", "matches", "charAt", "isBlank",
            "hasMoreElements", "hasNext", "getClass", "regionMatches", "codePointAt");
    /** Methods that put an argument into the collection (or builder) they are called on. */
    private static final Set<String> INSERTING = Set.of("add", "addElement", "put", "push", "insertElementAt",
            "setElementAt", "addAll", "putAll", "append", "offer", "set", "putIfAbsent", "addFirst", "addLast",
            "insert");
    /** Library calls taking a value whose result is not made of it (a number, a truth value, a match). */
    private static final Set<String> CONSUMING = Set.of("parseInt", "parseLong", "parseDouble", "parseFloat",
            "parseBoolean", "parseShort", "parseByte", "isEmpty", "matcher", "compile", "println", "print", "printf",
            "log", "d", "e", "i", "v", "w", "wtf", "format", "decode", "encode");
    /** Library classes whose construction from a value consumes it (a URL is never an expression). */
    private static final Set<String> CONSUMING_TYPES = Set.of("URL", "URI", "File", "Integer", "Long", "Double",
            "Float", "Boolean", "BigDecimal", "BigInteger", "Date", "SimpleDateFormat", "Locale", "Pattern");
    /** Library classes whose construction from a value is made of it. */
    private static final Set<String> COPYING_TYPES = Set.of("String", "StringBuilder", "StringBuffer", "Vector",
            "ArrayList", "LinkedList", "Hashtable", "HashMap", "LinkedHashMap", "TreeMap", "HashSet", "TreeSet",
            "LinkedHashSet", "OrderedHashtable", "Stack");
    /** Core's own classes a value reaches only to be written out or logged. */
    private static final Set<String> WRITING = Set.of("ExtUtil", "Logger", "System", "Log", "Timber");

    private final Code code;
    /** Every type and the types it extends or implements, by simple name. */
    private final Map<String, Set<String>> supertypes = new HashMap<>();
    /** Every call in the sources, by (name, arity). */
    private final Map<String, List<MethodCallExpr>> calls = new HashMap<>();
    /** Every name and every field access in the sources, by the identifier. */
    private final Map<String, List<NameExpr>> names = new HashMap<>();
    private final Map<String, List<FieldAccessExpr>> accesses = new HashMap<>();
    /** Whether a type is in a class's family (`family`), by the type and the class's simple name. */
    private final Map<TypeDeclaration<?>, Map<String, Boolean>> families = new java.util.IdentityHashMap<>();
    private final Map<Flow, List<Step>> successors = new HashMap<>();

    private ParserValues(Code code) {
        this.code = code;
        for (List<TypeDeclaration<?>> declared : code.types.values()) {
            for (TypeDeclaration<?> type : declared) {
                Set<String> parents = supertypes.computeIfAbsent(type.getNameAsString(), k -> new TreeSet<>());
                if (type instanceof ClassOrInterfaceDeclaration) {
                    ClassOrInterfaceDeclaration declaration = (ClassOrInterfaceDeclaration) type;
                    for (ClassOrInterfaceType parent : declaration.getExtendedTypes()) {
                        parents.add(parent.getNameAsString());
                    }
                    for (ClassOrInterfaceType parent : declaration.getImplementedTypes()) {
                        parents.add(parent.getNameAsString());
                    }
                }
            }
        }
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                calls.computeIfAbsent(call.getNameAsString() + "/" + call.getArguments().size(),
                        k -> new ArrayList<>()).add(call);
            }
            for (NameExpr name : unit.tree.findAll(NameExpr.class)) {
                names.computeIfAbsent(name.getNameAsString(), k -> new ArrayList<>()).add(name);
            }
            for (FieldAccessExpr access : unit.tree.findAll(FieldAccessExpr.class)) {
                accesses.computeIfAbsent(access.getNameAsString(), k -> new ArrayList<>()).add(access);
            }
        }
    }

    /**
     * Where a `getAttributeValue` call is, the same in any load of the same sources: its file, the
     * type and callable around it, and its place among that callable's `getAttributeValue` calls.
     */
    static String place(Code code, MethodCallExpr call) {
        Code.Unit unit = code.unitOf(call);
        Node around = call.getParentNode().orElse(null);
        while (around != null && !(around instanceof CallableDeclaration) && !(around instanceof TypeDeclaration)) {
            around = around.getParentNode().orElse(null);
        }
        if (unit == null || around == null) {
            return null;
        }
        int index = 0;
        for (MethodCallExpr other : around.findAll(MethodCallExpr.class)) {
            if (other == call) {
                break;
            }
            if (other.getNameAsString().equals("getAttributeValue")) {
                index++;
            }
        }
        String in = around instanceof CallableDeclaration
                ? ((CallableDeclaration<?>) around).getDeclarationAsString(false, false, false) : "";
        TypeDeclaration<?> type = Code.typeOf(around);
        return unit.relative + "::" + (type == null ? "?" : Code.qualifiedName(type)) + "#" + in + "#" + index;
    }

    /**
     * For each read (`{parser, elements, attribute, place}`), where its value goes:
     * `{parser: {attribute: {element: {"parsed": [where...], "embedded": [where...], "escapes": [where...]}}}}`.
     */
    static Map<String, Object> read(Code code, List<Map<String, Object>> reads) {
        ParserValues reader = new ParserValues(code);
        Map<String, Node> sites = new HashMap<>();
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                if (call.getNameAsString().equals("getAttributeValue")) {
                    String place = place(code, call);
                    if (place != null) {
                        sites.put(place, call);
                    }
                }
            }
        }
        Map<String, Object> out = new TreeMap<>();
        for (Map<String, Object> read : reads) {
            String place = (String) read.get("place");
            Node call = sites.get(place);
            if (call == null) {
                throw new IllegalStateException("The parser family read an attribute at " + place
                        + ", and the whole sources hold no getAttributeValue call there.");
            }
            Map<String, Set<String>> found = reader.follow(call);
            @SuppressWarnings("unchecked")
            Map<String, Object> attributes = (Map<String, Object>) out.computeIfAbsent((String) read.get("parser"),
                    k -> new TreeMap<>());
            @SuppressWarnings("unchecked")
            Map<String, Object> elements = (Map<String, Object>) attributes.computeIfAbsent(
                    (String) read.get("attribute"), k -> new TreeMap<>());
            @SuppressWarnings("unchecked")
            List<String> on = (List<String>) read.get("elements");
            for (String element : on) {
                @SuppressWarnings("unchecked")
                Map<String, Set<String>> held = (Map<String, Set<String>>) elements.computeIfAbsent(element,
                        k -> new TreeMap<>());
                for (Map.Entry<String, Set<String>> entry : found.entrySet()) {
                    held.computeIfAbsent(entry.getKey(), k -> new TreeSet<>()).addAll(entry.getValue());
                }
            }
        }
        return out;
    }

    // -- flows ------------------------------------------------------------------------------

    /**
     * Something that carries the value: an expression, a local or parameter, a field (by the class
     * declaring it, and the constants the object's other fields hold where the reader can tell, which
     * decide the branches a read of it is in), what a method returns. Inside a constructor, `entry` is
     * the constructor `new` ran (a `this(...)` call keeps it), so a field the object is given is read
     * with the constants that constructor and those it delegates to set.
     */
    private static final class Flow {
        final String kind;
        final Node node;
        final String name;
        final Node entry;

        Flow(String kind, Node node, String name) {
            this(kind, node, name, null);
        }

        Flow(String kind, Node node, String name, Node entry) {
            this.kind = kind;
            this.node = node;
            this.name = name;
            this.entry = entry;
        }

        @Override
        public boolean equals(Object other) {
            if (!(other instanceof Flow)) {
                return false;
            }
            Flow flow = (Flow) other;
            return kind.equals(flow.kind) && node == flow.node && Objects.equals(name, flow.name)
                    && entry == flow.entry;
        }

        @Override
        public int hashCode() {
            return Objects.hash(kind, System.identityHashCode(node), name, System.identityHashCode(entry));
        }
    }

    /** The flow being expanded (its entry carries to the flows of the same callable). */
    private Flow expanding;

    /** A flow in the callable being expanded. */
    private Flow here(String kind, Node node, String name) {
        return new Flow(kind, node, name, expanding == null ? null : expanding.entry);
    }

    /**
     * Whether the flow being expanded is a map whose keys hold the value (`extras.put(value, x)`):
     * its keys are read out (`keys()`, `keySet()`), what it maps them to is not.
     */
    private boolean keyed() {
        return expanding != null && expanding.name != null
                && (expanding.name.equals(KEYS) || expanding.name.endsWith(FACET));
    }

    private static final String KEYS = "keys";
    /** The suffix of a variable's or a field's flow name for a map whose keys hold the value (no name holds `~`). */
    private static final String FACET = "~" + KEYS;

    /** The name an expression's flow carries where the value is a map's keys. */
    private String exprName() {
        return keyed() ? KEYS : null;
    }

    /** The suffix a variable's or a field's flow carries where the value is a map's keys. */
    private String facet() {
        return keyed() ? FACET : "";
    }

    /** Where a flow goes next: another flow (embedded once a concatenation is passed), a parse, or an escape. */
    private static final class Step {
        final Flow flow;
        final boolean concatenated;
        // Whether the step leaves the class the value is held in for another (what a getter returns read at a
        // call in another class, a field read through another object).
        final boolean hop;
        final String terminal; // "parsed", "escapes" or "untyped", with `where`
        final String where;

        Step(Flow flow, boolean concatenated) {
            this(flow, concatenated, false);
        }

        Step(Flow flow, boolean concatenated, boolean hop) {
            this.flow = flow;
            this.concatenated = concatenated;
            this.hop = hop;
            this.terminal = null;
            this.where = null;
        }

        Step(String terminal, String where) {
            this.flow = null;
            this.concatenated = false;
            this.hop = false;
            this.terminal = terminal;
            this.where = where;
        }
    }

    /** One flow reached: embedded or not, after how many hops, and the flow it was reached from. */
    private static final class State {
        final Flow flow;
        final boolean embedded;
        final int hops;
        final State from;

        State(Flow flow, boolean embedded, int hops, State from) {
            this.flow = flow;
            this.embedded = embedded;
            this.hops = hops;
            this.from = from;
        }
    }

    /** How many times a value is followed out of the class holding it: a model's getter read by the session. */
    private static final int HOPS = 1;

    private Map<String, Set<String>> follow(Node read) {
        Map<String, Set<String>> found = new TreeMap<>();
        Deque<State> queue = new ArrayDeque<>();
        List<Set<Flow>> seen = new ArrayList<>();
        for (int i = 0; i < 2 * (HOPS + 1); i++) {
            seen.add(new HashSet<>());
        }
        queue.add(new State(new Flow("expr", read, null), false, 0, null));
        while (!queue.isEmpty()) {
            State state = queue.poll();
            if (!seen.get(state.hops * 2 + (state.embedded ? 1 : 0)).add(state.flow)) {
                continue;
            }
            for (Step step : successors(state.flow)) {
                if (step.flow != null) {
                    int hops = state.hops + (step.hop ? 1 : 0);
                    if (hops > HOPS) {
                        found.computeIfAbsent("beyond", k -> new TreeSet<>()).add(code.where(step.flow.node == null
                                ? state.flow.node : step.flow.node));
                        continue;
                    }
                    queue.add(new State(step.flow, state.embedded || step.concatenated, hops, state));
                    continue;
                }
                String kind = step.terminal.equals("parsed") ? (state.embedded ? "embedded" : "parsed") : step.terminal;
                Set<String> held = found.computeIfAbsent(kind, k -> new TreeSet<>());
                held.add(step.where);
                found.computeIfAbsent(kind + "Path", k -> new TreeSet<>());
                if (found.get(kind + "Path").isEmpty()) {
                    found.get(kind + "Path").add(path(state) + " -> " + step.where);
                }
            }
        }
        return found;
    }

    private String path(State state) {
        List<String> steps = new ArrayList<>();
        for (State at = state; at != null; at = at.from) {
            Node node = at.flow.node;
            String where = node == null ? at.flow.name : code.where(node) + (at.flow.name == null ? ""
                    : " " + at.flow.name);
            if (steps.isEmpty() || !steps.get(0).equals(where)) {
                steps.add(0, where);
            }
        }
        return String.join(" -> ", steps);
    }

    private List<Step> successors(Flow flow) {
        List<Step> known = successors.get(flow);
        if (known != null) {
            return known;
        }
        List<Step> found = new ArrayList<>();
        Flow saved = expanding;
        expanding = flow;
        try {
            expand(flow, found);
        } finally {
            expanding = saved;
        }
        successors.put(flow, found);
        return found;
    }

    private void expand(Flow flow, List<Step> found) {
        switch (flow.kind) {
            case "expr":
                expression((Expression) flow.node, found);
                break;
            case "local":
                String local = flow.name.endsWith(FACET) ? flow.name.substring(0, flow.name.length() - FACET.length())
                        : flow.name;
                for (NameExpr use : flow.node.findAll(NameExpr.class)) {
                    if (use.getNameAsString().equals(local) && !overwritten(use)) {
                        found.add(new Step(here("expr", use, exprName()), false));
                    }
                }
                break;
            case "field":
                fieldReads(flow.name, found);
                break;
            case "return":
                returnSites((CallableDeclaration<?>) flow.node, found);
                break;
            default:
                throw new IllegalStateException(flow.kind);
        }
    }

    /** Whether a name is the target of a plain assignment (its old value is not read there). */
    private static boolean overwritten(NameExpr use) {
        Node parent = use.getParentNode().orElse(null);
        return parent instanceof AssignExpr && ((AssignExpr) parent).getTarget() == use
                && ((AssignExpr) parent).getOperator() == AssignExpr.Operator.ASSIGN;
    }

    /** Where the value of an expression goes, from the expression around it. */
    private void expression(Expression value, List<Step> found) {
        Node parent = value.getParentNode().orElse(null);
        if (parent instanceof EnclosedExpr || parent instanceof CastExpr) {
            found.add(new Step(here("expr", parent, exprName()), false));
        } else if (parent instanceof ConditionalExpr) {
            if (((ConditionalExpr) parent).getCondition() != value) {
                found.add(new Step(here("expr", parent, exprName()), false));
            }
        } else if (parent instanceof BinaryExpr) {
            if (((BinaryExpr) parent).getOperator() == BinaryExpr.Operator.PLUS && !keyed()) {
                BinaryExpr top = (BinaryExpr) parent;
                while (top.getParentNode().orElse(null) instanceof BinaryExpr
                        && ((BinaryExpr) top.getParentNode().get()).getOperator() == BinaryExpr.Operator.PLUS) {
                    top = (BinaryExpr) top.getParentNode().get();
                }
                found.add(new Step(here("expr", top, null), !wholeArgument(top, value)));
            }
        } else if (parent instanceof UnaryExpr || parent instanceof InstanceOfExpr) {
            return;
        } else if (parent instanceof MethodCallExpr) {
            call((MethodCallExpr) parent, value, found);
        } else if (parent instanceof ObjectCreationExpr) {
            creation((ObjectCreationExpr) parent, value, found);
        } else if (parent instanceof ExplicitConstructorInvocationStmt) {
            ExplicitConstructorInvocationStmt invocation = (ExplicitConstructorInvocationStmt) parent;
            int index = invocation.getArguments().indexOf(value);
            TypeDeclaration<?> type = Code.typeOf(invocation);
            TypeDeclaration<?> target = invocation.isThis() || type == null ? type : code.type(Code.superName(type));
            if (target == null) {
                found.add(new Step("escapes", code.where(invocation)));
                return;
            }
            for (CallableDeclaration<?> callable : code.callables(target, null, invocation.getArguments().size())) {
                parameter(callable, index, found, expanding.entry);
            }
        } else if (parent instanceof VariableDeclarator) {
            VariableDeclarator variable = (VariableDeclarator) parent;
            Node owner = owner(variable);
            if (owner == null) {
                found.add(new Step(new Flow("field", null, fieldKey(Code.typeOf(variable), variable.getNameAsString())
                        + facet()), false));
            } else {
                found.add(new Step(here("local", scopeOf(variable), variable.getNameAsString() + facet()), false));
            }
        } else if (parent instanceof AssignExpr) {
            AssignExpr assign = (AssignExpr) parent;
            if (assign.getValue() == value) {
                boolean joined = assign.getOperator() == AssignExpr.Operator.PLUS;
                List<Step> targets = new ArrayList<>();
                assigned(assign.getTarget(), targets);
                for (Step target : targets) {
                    found.add(target.flow == null ? target : new Step(target.flow, joined));
                }
            }
            found.add(new Step(here("expr", assign, exprName()), false));
        } else if (parent instanceof FieldAccessExpr) {
            if (!((FieldAccessExpr) parent).getNameAsString().equals("length")) {
                found.add(new Step("escapes", code.where(parent) + " (." + ((FieldAccessExpr) parent).getNameAsString()
                        + " of it)"));
            }
        } else if (parent instanceof ReturnStmt) {
            Node callable = owner(parent);
            if (callable instanceof CallableDeclaration) {
                found.add(new Step(new Flow("return", callable, exprName()), false));
            } else {
                found.add(new Step("escapes", code.where(parent) + " (a lambda's result)"));
            }
        } else if (parent instanceof ForEachStmt) {
            ForEachStmt loop = (ForEachStmt) parent;
            if (loop.getIterable() == value && !keyed()) {
                for (VariableDeclarator variable : loop.getVariable().getVariables()) {
                    found.add(new Step(here("local", loop, variable.getNameAsString()), false));
                }
            }
        } else if (parent instanceof ArrayAccessExpr) {
            if (((ArrayAccessExpr) parent).getName() == value && !keyed()) {
                found.add(new Step(here("expr", parent, null), false));
            }
        } else if (parent instanceof ArrayInitializerExpr || parent instanceof ArrayCreationExpr) {
            found.add(new Step(here("expr", parent, exprName()), false));
        } else if (parent instanceof VariableDeclarationExpr || parent instanceof ExpressionStmt
                || parent instanceof ThrowStmt || parent instanceof IfStmt || parent instanceof WhileStmt
                || parent instanceof DoStmt || parent instanceof ForStmt || parent instanceof SwitchStmt
                || parent instanceof SwitchEntry || parent instanceof CatchClause) {
            return;
        } else if (parent instanceof LambdaExpr) {
            found.add(new Step("escapes", code.where(parent) + " (a lambda's result)"));
        } else {
            found.add(new Step("escapes", code.where(value) + " (" + (parent == null ? "nothing" :
                    parent.getClass().getSimpleName()) + ")"));
        }
    }

    /** A value assigned to a local, a field or an array element. */
    private void assigned(Expression target, List<Step> found) {
        if (target instanceof NameExpr) {
            String name = ((NameExpr) target).getNameAsString();
            Node local = localScope(target, name);
            if (local != null) {
                found.add(new Step(here("local", local, name + facet()), false));
            } else {
                found.add(new Step(new Flow("field", null, fieldKey(Code.typeOf(target), name) + facet()
                        + tags(thisTags(target))), false));
            }
        } else if (target instanceof FieldAccessExpr) {
            FieldAccessExpr access = (FieldAccessExpr) target;
            boolean own = access.getScope() instanceof ThisExpr || access.getScope() instanceof SuperExpr;
            String type = own ? null : typeName(access.getScope());
            TypeDeclaration<?> declared = type == null ? Code.typeOf(target) : code.type(type);
            Map<String, String> known = own ? thisTags(target) : access.getScope() instanceof NameExpr
                    ? localTags(target, ((NameExpr) access.getScope()).getNameAsString()) : Map.of();
            found.add(new Step(new Flow("field", null, fieldKey(declared, access.getNameAsString()) + facet()
                    + tags(known) + "@" + PLACE + code.where(target)), false));
        } else if (target instanceof ArrayAccessExpr) {
            assigned(((ArrayAccessExpr) target).getName(), found);
        } else {
            found.add(new Step("escapes", code.where(target) + " (an assignment to " + target + ")"));
        }
    }

    /** The field a name means in a class: `Declaring.name`, the declaring class found along the class's chain. */
    private String fieldKey(TypeDeclaration<?> context, String name) {
        VariableDeclarator declared = code.field(context, name);
        TypeDeclaration<?> owner = declared == null ? context : Code.typeOf(declared);
        return (owner == null ? "?" : Code.qualifiedName(owner)) + "#" + name;
    }

    private void call(MethodCallExpr call, Expression value, List<Step> found) {
        String name = call.getNameAsString();
        Expression scope = call.getScope().orElse(null);
        int arity = call.getArguments().size();
        if (scope == value && keyed()) {
            if (Set.of("keys", "keySet", "navigableKeySet", "entrySet").contains(name)) {
                found.add(new Step(new Flow("expr", call, null, expanding.entry), false));
            } else if (!DERIVING.contains(name) && !MEASURING.contains(name) && !INSERTING.contains(name)) {
                found.add(new Step("escapes", code.where(call) + " (" + name + " called on a map holding it)"));
            }
            return;
        }
        if (scope == value) {
            if (DERIVING.contains(name)) {
                found.add(new Step(here("expr", call, null), false));
            } else if (INSERTING.contains(name)) {
                if (name.equals("append") || name.equals("insert")) {
                    found.add(new Step(here("expr", call, null), false));
                }
            } else if (name.equals("forEach") && arity == 1 && call.getArgument(0) instanceof LambdaExpr) {
                LambdaExpr lambda = (LambdaExpr) call.getArgument(0);
                for (Parameter parameter : lambda.getParameters()) {
                    found.add(new Step(here("local", lambda, parameter.getNameAsString()), false));
                }
            } else if (!MEASURING.contains(name)) {
                found.add(new Step("escapes", code.where(call) + " (" + name + " called on it)"));
            }
            return;
        }
        int index = call.getArguments().indexOf(value);
        if (SINK_CALLS.contains(name) && arity == 1) {
            found.add(new Step("parsed", code.where(call)));
            return;
        }
        if (INSERTING.contains(name) && scope != null) {
            // The collection (or builder) now holds the value: every read of the variable holding it; a map
            // put to under the value holds it in its keys.
            boolean key = !keyed() && index == 0 && arity == 2 && (name.equals("put") || name.equals("putIfAbsent"));
            Flow saved = expanding;
            if (key) {
                expanding = new Flow("expr", value, KEYS, saved.entry);
            }
            try {
                if (scope instanceof NameExpr || scope instanceof FieldAccessExpr) {
                    assigned(scope, found);
                } else {
                    found.add(new Step(here("expr", scope, exprName()), false));
                }
            } finally {
                expanding = saved;
            }
            if (name.equals("append") || name.equals("insert")) {
                found.add(new Step(here("expr", call, null), false));
            }
            return;
        }
        if (scope instanceof NameExpr && WRITING.contains(((NameExpr) scope).getNameAsString())
                || scope instanceof FieldAccessExpr && rootName(scope) != null && WRITING.contains(rootName(scope))) {
            return;
        }
        if (scope instanceof NameExpr && ((NameExpr) scope).getNameAsString().equals("String")
                && (name.equals("valueOf") || name.equals("join") || name.equals("format"))) {
            found.add(new Step(here("expr", call, null), name.equals("format") || name.equals("join")));
            return;
        }
        List<CallableDeclaration<?>> targets = callees(call);
        if (targets == null) {
            found.add(new Step("escapes", code.where(call) + " (passed to " + name + " on " + scope
                    + ", which the reader cannot type)"));
            return;
        }
        if (!targets.isEmpty()) {
            for (CallableDeclaration<?> target : targets) {
                parameter(target, index, found, null);
            }
            return;
        }
        if (keyed()) {
            found.add(new Step("escapes", code.where(call) + " (a map holding it passed to " + name + ")"));
            return;
        }
        if (MEASURING.contains(name) || CONSUMING.contains(name)) {
            return;
        }
        if ((name.equals("asList") || name.equals("singletonList") || name.startsWith("unmodifiable"))
                && scope instanceof NameExpr) {
            found.add(new Step(here("expr", call, null), false));
            return;
        }
        found.add(new Step("escapes", code.where(call) + " (passed to " + name + ")"));
    }

    private void creation(ObjectCreationExpr creation, Expression value, List<Step> found) {
        String type = creation.getType().getNameAsString();
        int index = creation.getArguments().indexOf(value);
        if (SINK_TYPES.contains(type)) {
            found.add(new Step("parsed", code.where(creation)));
            return;
        }
        if (throwable(type)) {
            return;
        }
        TypeDeclaration<?> declared = code.type(type);
        if (declared != null) {
            List<CallableDeclaration<?>> constructors = code.callables(declared, null, creation.getArguments().size());
            if (constructors.isEmpty()) {
                found.add(new Step("escapes", code.where(creation) + " (no constructor of " + type + " takes it)"));
            }
            for (CallableDeclaration<?> constructor : constructors) {
                parameter(constructor, index, found, constructor);
            }
            return;
        }
        if (CONSUMING_TYPES.contains(type)) {
            return;
        }
        if (COPYING_TYPES.contains(type)) {
            found.add(new Step(here("expr", creation, exprName()), false));
            return;
        }
        found.add(new Step("escapes", code.where(creation) + " (new " + type + ")"));
    }

    private boolean throwable(String type) {
        Set<String> seen = new HashSet<>();
        Deque<String> pending = new ArrayDeque<>(List.of(type));
        while (!pending.isEmpty()) {
            String next = pending.poll();
            if (!seen.add(next)) {
                continue;
            }
            if (next.endsWith("Exception") || next.endsWith("Error") || next.equals("Throwable")) {
                return true;
            }
            pending.addAll(supertypes.getOrDefault(next, Set.of()));
        }
        return false;
    }

    private void parameter(CallableDeclaration<?> callable, int index, List<Step> found, Node entry) {
        if (index < 0 || index >= callable.getParameters().size()) {
            return;
        }
        Parameter parameter = callable.getParameter(index);
        if (parameter.isVarArgs()) {
            found.add(new Step("escapes", code.where(callable) + " (a variable argument)"));
            return;
        }
        found.add(new Step(new Flow("local", callable, parameter.getNameAsString() + facet(),
                callable instanceof ConstructorDeclaration ? entry : null), false));
    }

    /** Every read of a field: in the class that declares it, its subclasses and inner classes, and through a
     * receiver of one of those classes (or one the reader cannot type) in the same file. */
    private void fieldReads(String named, List<Step> found) {
        // `Declaring#field[#keys][|tag=value;...]@where it was stored` (the store's place only for one through a
        // local); a tag's value is a constant's spelling, which may hold any character, so the place is found from
        // the end and the tags between the first `|` and it.
        int placed = named.lastIndexOf("@" + PLACE);
        String origin = placed < 0 ? null : named.substring(placed + 1 + PLACE.length());
        String keyAndTags = placed < 0 ? named : named.substring(0, placed);
        int bar = keyAndTags.indexOf('|');
        String key = bar < 0 ? keyAndTags : keyAndTags.substring(0, bar);
        if (key.indexOf('#') < 0) {
            throw new IllegalStateException("A field's flow is named " + named + ", which names no declaring class.");
        }
        boolean keys = key.endsWith(FACET);
        if (keys) {
            key = key.substring(0, key.length() - FACET.length());
        }
        Map<String, String> known = new TreeMap<>();
        if (bar >= 0) {
            known.putAll(untagged(keyAndTags.substring(bar)));
        }
        String owner = key.substring(0, key.indexOf('#'));
        String name = key.substring(key.indexOf('#') + 1);
        String simple = owner.substring(owner.lastIndexOf('.') + 1);
        for (NameExpr use : names.getOrDefault(name, List.of())) {
            TypeDeclaration<?> type = Code.typeOf(use);
            if (type != null && family(type, simple) && localOwner(use, name) == null && !overwritten(use)
                    && !serializing(use) && reachable(use, known, 0)) {
                found.add(new Step(new Flow("expr", use, keys ? KEYS : carried(known)), false));
            }
        }
        {
            for (FieldAccessExpr access : accesses.getOrDefault(name, List.of())) {
                if (written(access) || serializing(access)) {
                    continue;
                }
                Expression scope = access.getScope();
                if (scope instanceof ThisExpr || scope instanceof SuperExpr) {
                    TypeDeclaration<?> type = Code.typeOf(access);
                    if (type != null && family(type, simple) && reachable(access, known, 0)) {
                        found.add(new Step(new Flow("expr", access, keys ? KEYS : carried(known)), false));
                    }
                    continue;
                }
                if (scope instanceof NameExpr && storesThrough(access, ((NameExpr) scope).getNameAsString(), name)
                        && !code.where(access).equals(origin)) {
                    continue; // a local object this method stores the field of itself: the read sees that store
                }
                String type = typeName(scope);
                TypeDeclaration<?> at = Code.typeOf(access);
                boolean inside = at != null && family(at, simple);
                if ((type != null ? related(type, simple) : inside) && reachable(access, known, 0)) {
                    found.add(new Step(new Flow("expr", access, keys ? KEYS : carried(known)), false, !inside));
                }
            }
        }
    }

    /**
     * Whether a value is a whole argument of a function call the concatenation spells (`"string(" +
     * value + ")"`): the text before it ends with `(` or `,`, and the text after it starts with `)`
     * or `,`, so the parsed text holds the value as an expression of its own.
     */
    private static boolean wholeArgument(BinaryExpr top, Expression value) {
        List<Expression> parts = new ArrayList<>();
        flatten(top, parts);
        int index = -1;
        for (int i = 0; i < parts.size(); i++) {
            Node at = value;
            while (at != null && at != top) {
                if (at == parts.get(i)) {
                    index = i;
                    break;
                }
                at = at.getParentNode().orElse(null);
            }
            if (index >= 0) {
                break;
            }
        }
        if (index <= 0 || index >= parts.size() - 1) {
            return false;
        }
        Expression before = parts.get(index - 1);
        Expression after = parts.get(index + 1);
        if (!(before instanceof StringLiteralExpr) || !(after instanceof StringLiteralExpr)) {
            return false;
        }
        String left = ((StringLiteralExpr) before).getValue().trim();
        String right = ((StringLiteralExpr) after).getValue().trim();
        return (left.endsWith("(") || left.endsWith(",")) && (right.startsWith(")") || right.startsWith(","));
    }

    private static void flatten(Expression expression, List<Expression> out) {
        if (expression instanceof BinaryExpr && ((BinaryExpr) expression).getOperator() == BinaryExpr.Operator.PLUS) {
            flatten(((BinaryExpr) expression).getLeft(), out);
            flatten(((BinaryExpr) expression).getRight(), out);
        } else {
            out.add(expression);
        }
    }

    /** A field read's flow name: the constants of the object it was stored in, for a copy of the object. */
    private static String carried(Map<String, String> known) {
        return known.isEmpty() ? null : "tags" + tags(known);
    }

    private static Map<String, String> uncarried(String name) {
        return name != null && name.startsWith("tags|") ? untagged(name.substring("tags".length())) : new TreeMap<>();
    }

    /** The marker before a field flow's store place in its name. */
    private static final String PLACE = "place:";

    /** Known constants as a flow's name carries them: `|<field>=<spelling>;...`, each spelling URL-encoded. */
    private static String tags(Map<String, String> known) {
        if (known.isEmpty()) {
            return "";
        }
        StringBuilder out = new StringBuilder("|");
        for (Map.Entry<String, String> tag : new TreeMap<>(known).entrySet()) {
            out.append(tag.getKey()).append('=')
                    .append(java.net.URLEncoder.encode(tag.getValue(), java.nio.charset.StandardCharsets.UTF_8))
                    .append(';');
        }
        return out.toString();
    }

    private static Map<String, String> untagged(String tags) {
        Map<String, String> known = new TreeMap<>();
        for (String tag : tags.substring(1).split(";")) {
            int equals = tag.indexOf('=');
            if (equals > 0) {
                known.put(tag.substring(0, equals),
                        java.net.URLDecoder.decode(tag.substring(equals + 1), java.nio.charset.StandardCharsets.UTF_8));
            }
        }
        return known;
    }

    /** A constant's spelling as a branch compares it: a literal's text, or a named constant's last name. */
    private static String constantText(Expression expression) {
        Expression inner = expression;
        while (inner instanceof EnclosedExpr) {
            inner = ((EnclosedExpr) inner).getInner();
        }
        if (inner instanceof com.github.javaparser.ast.expr.LiteralExpr) {
            return inner.toString();
        }
        if (inner instanceof NameExpr && Character.isUpperCase(((NameExpr) inner).getNameAsString().charAt(0))) {
            return ((NameExpr) inner).getNameAsString();
        }
        if (inner instanceof FieldAccessExpr && Character.isUpperCase(((FieldAccessExpr) inner).getNameAsString().charAt(0))) {
            return ((FieldAccessExpr) inner).getNameAsString();
        }
        return null;
    }

    /**
     * The constants an object's other fields hold where a constructor stores a field of it: what the
     * constructor `new` ran (the flow's entry) and those it delegates to with `this(...)` assign
     * them, and `false` for a boolean field none of them assigns. Elsewhere, nothing is known.
     */
    private Map<String, String> thisTags(Node store) {
        Node around = owner(store);
        if (!(around instanceof ConstructorDeclaration)) {
            return Map.of();
        }
        // A copy of a field read from another object (`this.value = other.value`): the copy's other fields
        // copied from that object (`this.valueIsXpath = other.valueIsXpath`) hold what that object's held.
        Map<String, String> incoming = expanding == null ? Map.of() : uncarried(expanding.name);
        String source = expanding != null && expanding.node instanceof FieldAccessExpr
                && ((FieldAccessExpr) expanding.node).getScope() instanceof NameExpr
                ? ((NameExpr) ((FieldAccessExpr) expanding.node).getScope()).getNameAsString() : null;
        Node entry = expanding != null && expanding.entry instanceof ConstructorDeclaration ? expanding.entry : around;
        List<ConstructorDeclaration> chain = new ArrayList<>();
        Deque<ConstructorDeclaration> pending = new ArrayDeque<>(List.of((ConstructorDeclaration) entry));
        while (!pending.isEmpty()) {
            ConstructorDeclaration next = pending.poll();
            if (chain.contains(next)) {
                continue;
            }
            chain.add(next);
            for (ExplicitConstructorInvocationStmt invocation : next.findAll(ExplicitConstructorInvocationStmt.class)) {
                TypeDeclaration<?> type = Code.typeOf(next);
                if (invocation.isThis() && type != null) {
                    for (CallableDeclaration<?> delegated : code.callables(type, null, invocation.getArguments().size())) {
                        pending.add((ConstructorDeclaration) delegated);
                    }
                }
            }
        }
        Map<String, String> known = new TreeMap<>();
        Set<String> assigned = new HashSet<>();
        Set<String> conflicting = new HashSet<>();
        for (ConstructorDeclaration constructor : chain) {
            for (AssignExpr assign : constructor.findAll(AssignExpr.class)) {
                Expression target = assign.getTarget();
                String field = target instanceof FieldAccessExpr && ((FieldAccessExpr) target).getScope() instanceof ThisExpr
                        ? ((FieldAccessExpr) target).getNameAsString()
                        : target instanceof NameExpr && localOwner(target, ((NameExpr) target).getNameAsString()) == null
                        ? ((NameExpr) target).getNameAsString() : null;
                if (field == null) {
                    continue;
                }
                assigned.add(field);
                String value = constantText(assign.getValue());
                if (value == null && source != null && incoming.containsKey(field)
                        && assign.getValue() instanceof FieldAccessExpr
                        && ((FieldAccessExpr) assign.getValue()).getNameAsString().equals(field)
                        && ((FieldAccessExpr) assign.getValue()).getScope() instanceof NameExpr
                        && ((NameExpr) ((FieldAccessExpr) assign.getValue()).getScope()).getNameAsString().equals(source)) {
                    value = incoming.get(field);
                }
                if (value == null || known.containsKey(field) && !known.get(field).equals(value)) {
                    conflicting.add(field);
                } else {
                    known.put(field, value);
                }
            }
        }
        TypeDeclaration<?> type = Code.typeOf(entry);
        if (type != null) {
            for (com.github.javaparser.ast.body.FieldDeclaration declaration : type.getFields()) {
                for (VariableDeclarator variable : declaration.getVariables()) {
                    if (!declaration.isStatic() && variable.getType().asString().equals("boolean")
                            && !variable.getInitializer().isPresent() && !assigned.contains(variable.getNameAsString())) {
                        known.put(variable.getNameAsString(), "false");
                    }
                }
            }
        }
        known.keySet().removeAll(conflicting);
        return known;
    }

    /** The constants a method assigns to a local object's other fields (`t.type = TEXT_TYPE_FLAT`). */
    private Map<String, String> localTags(Node store, String local) {
        Node around = owner(store);
        if (around == null) {
            return Map.of();
        }
        Map<String, String> known = new TreeMap<>();
        Set<String> conflicting = new HashSet<>();
        for (AssignExpr assign : around.findAll(AssignExpr.class)) {
            if (!(assign.getTarget() instanceof FieldAccessExpr)) {
                continue;
            }
            FieldAccessExpr target = (FieldAccessExpr) assign.getTarget();
            if (!(target.getScope() instanceof NameExpr) || !((NameExpr) target.getScope()).getNameAsString().equals(local)) {
                continue;
            }
            String value = constantText(assign.getValue());
            String field = target.getNameAsString();
            if (value == null || known.containsKey(field) && !known.get(field).equals(value)) {
                conflicting.add(field);
            } else {
                known.put(field, value);
            }
        }
        known.keySet().removeAll(conflicting);
        return known;
    }

    /**
     * Whether a read of a field may run for an object whose other fields hold `known`: no branch it is
     * in (an `if` on one of those fields, a `switch` on one) rules it out, and, for a method only its
     * own class calls, some call of it may run.
     */
    private boolean reachable(Node read, Map<String, String> known, int depth) {
        if (known.isEmpty()) {
            return true;
        }
        Node child = read;
        Node current = read.getParentNode().orElse(null);
        while (current != null && !(current instanceof CallableDeclaration) && !(current instanceof TypeDeclaration)) {
            if (current instanceof IfStmt) {
                IfStmt branch = (IfStmt) current;
                Boolean then = child == branch.getThenStmt() ? Boolean.TRUE
                        : branch.getElseStmt().isPresent() && child == branch.getElseStmt().get() ? Boolean.FALSE : null;
                if (then != null && excluded(branch.getCondition(), then, known)) {
                    return false;
                }
            }
            if (current instanceof SwitchEntry && current.getParentNode().orElse(null) instanceof SwitchStmt) {
                SwitchEntry entry = (SwitchEntry) current;
                String field = fieldNamed(((SwitchStmt) current.getParentNode().get()).getSelector());
                if (field != null && known.containsKey(field) && !entry.getLabels().isEmpty()) {
                    boolean listed = false;
                    for (Expression label : entry.getLabels()) {
                        listed |= known.get(field).equals(constantText(label));
                    }
                    if (!listed) {
                        return false;
                    }
                }
            }
            child = current;
            current = current.getParentNode().orElse(null);
        }
        if (!(current instanceof MethodDeclaration) || depth > 3) {
            return true;
        }
        MethodDeclaration method = (MethodDeclaration) current;
        TypeDeclaration<?> type = Code.typeOf(method);
        if (type == null) {
            return true;
        }
        List<MethodCallExpr> own = new ArrayList<>();
        for (MethodCallExpr call : calls.getOrDefault(method.getNameAsString() + "/" + method.getParameters().size(),
                List.of())) {
            Expression scope = call.getScope().orElse(null);
            TypeDeclaration<?> at = Code.typeOf(call);
            boolean inside = at != null && family(at, type.getNameAsString());
            if (!inside || scope != null && !(scope instanceof ThisExpr)) {
                return true; // called from outside its class: any object may reach it
            }
            own.add(call);
        }
        if (own.isEmpty()) {
            return true;
        }
        for (MethodCallExpr call : own) {
            if (reachable(call, known, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    /** Whether a branch's condition, taken (`then`) or not, rules out the known constants. */
    private static boolean excluded(Expression condition, boolean then, Map<String, String> known) {
        Expression inner = condition;
        while (inner instanceof EnclosedExpr) {
            inner = ((EnclosedExpr) inner).getInner();
        }
        if (inner instanceof UnaryExpr && ((UnaryExpr) inner).getOperator() == UnaryExpr.Operator.LOGICAL_COMPLEMENT) {
            return excluded(((UnaryExpr) inner).getExpression(), !then, known);
        }
        String field = fieldNamed(inner);
        if (field != null && known.containsKey(field)) {
            String value = known.get(field);
            return value.equals("true") && !then || value.equals("false") && then;
        }
        if (inner instanceof BinaryExpr) {
            BinaryExpr binary = (BinaryExpr) inner;
            boolean equal = binary.getOperator() == BinaryExpr.Operator.EQUALS;
            if (!equal && binary.getOperator() != BinaryExpr.Operator.NOT_EQUALS) {
                return false;
            }
            String left = fieldNamed(binary.getLeft());
            String right = fieldNamed(binary.getRight());
            String compared = left != null ? constantText(binary.getRight()) : constantText(binary.getLeft());
            String named = left != null ? left : right;
            if (named == null || compared == null || !known.containsKey(named)) {
                return false;
            }
            boolean holds = known.get(named).equals(compared);
            return equal == then ? !holds : holds;
        }
        return false;
    }

    /** The field an expression names on `this` (`type`, `this.type`), or null. */
    private static String fieldNamed(Expression expression) {
        if (expression instanceof NameExpr && localOwner(expression, ((NameExpr) expression).getNameAsString()) == null) {
            return ((NameExpr) expression).getNameAsString();
        }
        if (expression instanceof FieldAccessExpr && ((FieldAccessExpr) expression).getScope() instanceof ThisExpr) {
            return ((FieldAccessExpr) expression).getNameAsString();
        }
        return null;
    }

    /** Whether a node is inside a method that writes or reads an object's serialized form (its fields go to or
     * come from a stream, not to a reader of their values). */
    private static boolean serializing(Node node) {
        Node current = node.getParentNode().orElse(null);
        while (current != null && !(current instanceof TypeDeclaration)) {
            if (current instanceof MethodDeclaration) {
                String name = ((MethodDeclaration) current).getNameAsString();
                return name.equals("writeExternal") || name.equals("readExternal");
            }
            current = current.getParentNode().orElse(null);
        }
        return false;
    }

    /** Whether the callable around a read of `local.field` assigns `local.field` itself. */
    private static boolean storesThrough(Node read, String local, String field) {
        Node around = owner(read);
        if (around == null || localOwner(read, local) == null) {
            return false;
        }
        for (AssignExpr assign : around.findAll(AssignExpr.class)) {
            if (assign.getTarget() instanceof FieldAccessExpr) {
                FieldAccessExpr target = (FieldAccessExpr) assign.getTarget();
                if (target.getNameAsString().equals(field) && target.getScope() instanceof NameExpr
                        && ((NameExpr) target.getScope()).getNameAsString().equals(local)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean written(FieldAccessExpr access) {
        Node parent = access.getParentNode().orElse(null);
        return parent instanceof AssignExpr && ((AssignExpr) parent).getTarget() == access
                && ((AssignExpr) parent).getOperator() == AssignExpr.Operator.ASSIGN;
    }

    /** Whether a type is `simple`, one of its subclasses, or a class inside one of those. */
    private boolean family(TypeDeclaration<?> type, String simple) {
        return families.computeIfAbsent(type, k -> new HashMap<>()).computeIfAbsent(simple, k -> {
            for (TypeDeclaration<?> chained : code.lookupChain(type)) {
                if (chained.getNameAsString().equals(simple)) {
                    return true;
                }
            }
            return subtype(type.getNameAsString(), simple);
        });
    }

    private boolean subtype(String type, String of) {
        Set<String> seen = new HashSet<>();
        Deque<String> pending = new ArrayDeque<>(List.of(type));
        while (!pending.isEmpty()) {
            String next = pending.poll();
            if (!seen.add(next)) {
                continue;
            }
            if (next.equals(of)) {
                return true;
            }
            pending.addAll(supertypes.getOrDefault(next, Set.of()));
        }
        return false;
    }

    /** Whether a receiver of `type` may be an object of `of` (one extends or implements the other). */
    private boolean related(String type, String of) {
        return subtype(type, of) || subtype(of, type);
    }

    /** Every call of a method whose receiver may be of its class (or cannot be typed), where it returns. */
    private void returnSites(CallableDeclaration<?> callable, List<Step> found) {
        if (!(callable instanceof MethodDeclaration)) {
            return;
        }
        TypeDeclaration<?> declaring = Code.typeOf(callable);
        String simple = declaring == null ? "?" : declaring.getNameAsString();
        for (MethodCallExpr call : calls.getOrDefault(
                callable.getNameAsString() + "/" + callable.getParameters().size(), List.of())) {
            Expression scope = call.getScope().orElse(null);
            String type;
            if (scope == null || scope instanceof ThisExpr || scope instanceof SuperExpr) {
                TypeDeclaration<?> at = Code.typeOf(call);
                type = null;
                boolean own = false;
                for (TypeDeclaration<?> chained : at == null ? List.<TypeDeclaration<?>>of() : code.lookupChain(at)) {
                    own |= related(chained.getNameAsString(), simple);
                }
                if (own) {
                    found.add(new Step(new Flow("expr", call, expanding.name), false));
                }
                continue;
            }
            if (serializing(call)) {
                continue;
            }
            type = typeName(scope);
            TypeDeclaration<?> at = Code.typeOf(call);
            boolean inside = at != null && family(at, simple);
            if (type == null) {
                found.add(new Step("untyped", code.where(call) + " (" + simple + "." + call.getNameAsString()
                        + " may be what " + scope + " calls; the reader cannot type it)"));
            } else if (related(type, simple)) {
                found.add(new Step(new Flow("expr", call, expanding.name), false, !inside));
            }
        }
    }

    /** The methods a call may run, among the sources' classes; none for a library method, null where the
     * reader cannot type the receiver. */
    private List<CallableDeclaration<?>> callees(MethodCallExpr call) {
        String name = call.getNameAsString();
        int arity = call.getArguments().size();
        Expression scope = call.getScope().orElse(null);
        List<TypeDeclaration<?>> receivers = new ArrayList<>();
        if (scope == null || scope instanceof ThisExpr) {
            TypeDeclaration<?> at = Code.typeOf(call);
            if (at != null) {
                receivers.add(at);
            }
        } else if (scope instanceof SuperExpr) {
            TypeDeclaration<?> at = Code.typeOf(call);
            TypeDeclaration<?> parent = at == null ? null : code.type(Code.superName(at));
            if (parent != null) {
                receivers.add(parent);
            }
        } else {
            String type = typeName(scope);
            if (type != null) {
                List<TypeDeclaration<?>> declared = code.types.get(type);
                if (declared == null) {
                    return List.of();
                }
                receivers.addAll(declared);
            } else {
                return null; // a receiver the reader cannot type
            }
        }
        List<CallableDeclaration<?>> found = new ArrayList<>();
        Set<String> names = new HashSet<>();
        for (TypeDeclaration<?> receiver : receivers) {
            names.add(receiver.getNameAsString());
            for (CallableDeclaration<?> callable : code.callables(receiver, name, arity)) {
                if (body(callable) && !found.contains(callable)) {
                    found.add(callable);
                }
            }
        }
        // The overrides in the receiver's subclasses and implementations.
        for (List<TypeDeclaration<?>> declared : code.types.values()) {
            for (TypeDeclaration<?> type : declared) {
                if (names.contains(type.getNameAsString())) {
                    continue;
                }
                boolean below = names.stream().anyMatch(receiver -> subtype(type.getNameAsString(), receiver));
                if (!below) {
                    continue;
                }
                for (CallableDeclaration<?> callable : type.getMethodsByName(name)) {
                    if (callable.getParameters().size() == arity && body(callable) && !found.contains(callable)) {
                        found.add(callable);
                    }
                }
            }
        }
        return found;
    }

    private static boolean body(CallableDeclaration<?> callable) {
        return callable instanceof ConstructorDeclaration
                || callable instanceof MethodDeclaration && ((MethodDeclaration) callable).getBody().isPresent();
    }

    private static String rootName(Expression expression) {
        Expression current = expression;
        while (current instanceof FieldAccessExpr) {
            current = ((FieldAccessExpr) current).getScope();
        }
        return current instanceof NameExpr ? ((NameExpr) current).getNameAsString() : null;
    }

    // -- names and types ----------------------------------------------------------------------

    /** The callable or lambda a declaration or statement belongs to (null for a field's initialiser). */
    private static Node owner(Node node) {
        Node current = node.getParentNode().orElse(null);
        while (current != null && !(current instanceof CallableDeclaration) && !(current instanceof LambdaExpr)
                && !(current instanceof TypeDeclaration)) {
            current = current.getParentNode().orElse(null);
        }
        return current instanceof TypeDeclaration ? null : current;
    }

    /** The callable or lambda declaring a local or parameter `name` visible where `at` stands, or null. */
    private static Node localOwner(Node at, String name) {
        Node current = at.getParentNode().orElse(null);
        while (current != null && !(current instanceof TypeDeclaration)) {
            if (current instanceof CallableDeclaration) {
                CallableDeclaration<?> callable = (CallableDeclaration<?>) current;
                for (Parameter parameter : callable.getParameters()) {
                    if (parameter.getNameAsString().equals(name)) {
                        return callable;
                    }
                }
                for (VariableDeclarator local : callable.findAll(VariableDeclarator.class)) {
                    if (local.getNameAsString().equals(name) && Code.typeOf(local) == Code.typeOf(callable)
                            && within(at, scopeOf(local))) {
                        return callable;
                    }
                }
                for (CatchClause clause : callable.findAll(CatchClause.class)) {
                    if (clause.getParameter().getNameAsString().equals(name) && within(at, clause)) {
                        return callable;
                    }
                }
                return null;
            }
            if (current instanceof LambdaExpr) {
                for (Parameter parameter : ((LambdaExpr) current).getParameters()) {
                    if (parameter.getNameAsString().equals(name)) {
                        return current;
                    }
                }
            }
            current = current.getParentNode().orElse(null);
        }
        return null;
    }

    /** Where the local or parameter `name` visible at `at` holds: its callable, lambda, or the block (loop,
     * `try`, `switch` entry) around its declaration; null for a field. */
    private static Node localScope(Node at, String name) {
        Node owner = localOwner(at, name);
        if (owner == null) {
            return null;
        }
        if (owner instanceof LambdaExpr) {
            return owner;
        }
        for (Parameter parameter : ((CallableDeclaration<?>) owner).getParameters()) {
            if (parameter.getNameAsString().equals(name)) {
                return owner;
            }
        }
        Node best = null;
        for (VariableDeclarator local : owner.findAll(VariableDeclarator.class)) {
            Node scope = scopeOf(local);
            if (local.getNameAsString().equals(name) && within(at, scope) && (best == null || within(scope, best))) {
                best = scope;
            }
        }
        return best != null ? best : owner;
    }

    /** Where a local's declaration holds: the block, loop, `try` or `switch` entry around it. */
    private static Node scopeOf(VariableDeclarator local) {
        Node current = local.getParentNode().orElse(null);
        while (current != null && !(current instanceof com.github.javaparser.ast.stmt.BlockStmt)
                && !(current instanceof ForStmt) && !(current instanceof ForEachStmt)
                && !(current instanceof com.github.javaparser.ast.stmt.TryStmt) && !(current instanceof SwitchEntry)
                && !(current instanceof LambdaExpr) && !(current instanceof CallableDeclaration)) {
            current = current.getParentNode().orElse(null);
        }
        return current;
    }

    private static boolean within(Node node, Node scope) {
        for (Node current = node; current != null; current = current.getParentNode().orElse(null)) {
            if (current == scope) {
                return true;
            }
        }
        return false;
    }

    /** The simple name of an expression's static type, where the reader can tell it; null otherwise. */
    private String typeName(Expression expression) {
        if (expression instanceof EnclosedExpr) {
            return typeName(((EnclosedExpr) expression).getInner());
        }
        if (expression instanceof CastExpr) {
            return simple(((CastExpr) expression).getType());
        }
        if (expression instanceof ObjectCreationExpr) {
            return ((ObjectCreationExpr) expression).getType().getNameAsString();
        }
        if (expression instanceof StringLiteralExpr) {
            return "String";
        }
        if (expression instanceof ThisExpr) {
            TypeDeclaration<?> type = Code.typeOf(expression);
            return type == null ? null : type.getNameAsString();
        }
        if (expression instanceof NameExpr) {
            String name = ((NameExpr) expression).getNameAsString();
            Node owner = localOwner(expression, name);
            if (owner != null) {
                return localType(owner, name);
            }
            VariableDeclarator field = code.field(Code.typeOf(expression), name);
            if (field != null) {
                return simple(field.getType());
            }
            if (code.types.containsKey(name) || Character.isUpperCase(name.charAt(0))) {
                return name; // a class named as the receiver of a static call
            }
            return null;
        }
        if (expression instanceof FieldAccessExpr) {
            FieldAccessExpr access = (FieldAccessExpr) expression;
            TypeDeclaration<?> holder = access.getScope() instanceof ThisExpr ? Code.typeOf(access)
                    : code.type(typeName(access.getScope()));
            VariableDeclarator field = holder == null ? null : code.field(holder, access.getNameAsString());
            return field == null ? null : simple(field.getType());
        }
        if (expression instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) expression;
            List<CallableDeclaration<?>> targets = callees(call);
            if (targets == null) {
                return null;
            }
            if (targets.isEmpty()) {
                return element(call);
            }
            String returned = null;
            for (CallableDeclaration<?> callable : targets) {
                if (!(callable instanceof MethodDeclaration)) {
                    continue;
                }
                String type = simple(((MethodDeclaration) callable).getType());
                if (returned == null) {
                    returned = type;
                } else if (!returned.equals(type)) {
                    return null;
                }
            }
            return returned;
        }
        return null;
    }

    /** The element type a library collection's read returns, from the collection's declared type arguments. */
    private String element(MethodCallExpr call) {
        if (!Set.of("get", "elementAt", "firstElement", "lastElement", "remove", "pop", "peek", "poll", "next",
                "nextElement", "getOrDefault").contains(call.getNameAsString()) || !call.getScope().isPresent()) {
            return null;
        }
        Type declared = declaredType(call.getScope().get());
        if (declared == null || !declared.isClassOrInterfaceType()) {
            return null;
        }
        return declared.asClassOrInterfaceType().getTypeArguments()
                .map(arguments -> arguments.isEmpty() ? null : simple(arguments.get(arguments.size() - 1)))
                .orElse(null);
    }

    /** The declared type of a local, parameter or field an expression names. */
    private Type declaredType(Expression expression) {
        if (expression instanceof NameExpr) {
            String name = ((NameExpr) expression).getNameAsString();
            Node owner = localOwner(expression, name);
            if (owner != null) {
                if (owner instanceof CallableDeclaration) {
                    for (Parameter parameter : ((CallableDeclaration<?>) owner).getParameters()) {
                        if (parameter.getNameAsString().equals(name)) {
                            return parameter.getType();
                        }
                    }
                }
                for (VariableDeclarator local : owner.findAll(VariableDeclarator.class)) {
                    if (local.getNameAsString().equals(name)) {
                        return local.getType();
                    }
                }
                return null;
            }
            VariableDeclarator field = code.field(Code.typeOf(expression), name);
            return field == null ? null : field.getType();
        }
        if (expression instanceof FieldAccessExpr && ((FieldAccessExpr) expression).getScope() instanceof ThisExpr) {
            VariableDeclarator field = code.field(Code.typeOf(expression), ((FieldAccessExpr) expression).getNameAsString());
            return field == null ? null : field.getType();
        }
        return null;
    }

    private String localType(Node owner, String name) {
        if (owner instanceof CallableDeclaration) {
            for (Parameter parameter : ((CallableDeclaration<?>) owner).getParameters()) {
                if (parameter.getNameAsString().equals(name)) {
                    return simple(parameter.getType());
                }
            }
        }
        if (owner instanceof LambdaExpr) {
            for (Parameter parameter : ((LambdaExpr) owner).getParameters()) {
                if (parameter.getNameAsString().equals(name)) {
                    return parameter.getType().isUnknownType() ? null : simple(parameter.getType());
                }
            }
        }
        for (VariableDeclarator local : owner.findAll(VariableDeclarator.class)) {
            if (local.getNameAsString().equals(name)) {
                return local.getType().isVarType() ? null : simple(local.getType());
            }
        }
        for (CatchClause clause : owner.findAll(CatchClause.class)) {
            if (clause.getParameter().getNameAsString().equals(name)) {
                return simple(clause.getParameter().getType());
            }
        }
        return null;
    }

    private static String simple(Type type) {
        String text = type.asString();
        if (text.contains("<")) {
            text = text.substring(0, text.indexOf('<'));
        }
        while (text.endsWith("[]")) {
            text = text.substring(0, text.length() - 2);
        }
        return text.substring(text.lastIndexOf('.') + 1);
    }

}
