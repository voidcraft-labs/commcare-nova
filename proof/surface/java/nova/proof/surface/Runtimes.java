package nova.proof.surface;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
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
import com.github.javaparser.ast.expr.CharLiteralExpr;
import com.github.javaparser.ast.expr.ClassExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.stmt.ExpressionStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ForStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.stmt.Statement;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.ThrowStmt;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * The runtime families the XForm parser does not hold: the itext forms each runtime reads, the session
 * instance Core builds, the instance sources Core's initializer dispatches on, the XPath functions
 * registered outside Core's parser, Core's XPath grammar, and the search prompt inputs and
 * appearances each runtime acts on. The UI string ids are UiStrings'.
 */
final class Runtimes {
    private Runtimes() {
    }

    private static Expression unwrap(Expression expression) {
        Expression inner = expression;
        while (inner instanceof EnclosedExpr || inner instanceof CastExpr) {
            inner = inner instanceof EnclosedExpr ? ((EnclosedExpr) inner).getInner() : ((CastExpr) inner).getExpression();
        }
        return inner;
    }

    @SuppressWarnings("unchecked")
    private static void addTo(Map<String, Object> facts, String fact, Object value) {
        ((List<Object>) facts.computeIfAbsent(fact, k -> new ArrayList<>())).add(value);
    }

    // -- itext forms ----------------------------------------------------------------------

    /**
     * Each itext form a runtime reads: the `form` argument of every call to a method of Core's form
     * entry API that takes one (a method of `FormEntryCaption` or `FormEntryPrompt` with a parameter
     * named `form`), every comparison with a constant such a call is passed, and the forms
     * XFormParser checks a text id against (`itextKnownForms`).
     */
    static List<Object> itextForms(Code code) {
        Map<String, Integer> formMethods = new TreeMap<>();
        for (String owner : List.of("FormEntryCaption", "FormEntryPrompt")) {
            TypeDeclaration<?> type = code.type(owner);
            if (type == null) {
                throw new IllegalStateException("Core's " + owner + " is not among the parsed sources.");
            }
            for (MethodDeclaration method : type.getMethods()) {
                for (int i = 0; i < method.getParameters().size(); i++) {
                    Parameter parameter = method.getParameter(i);
                    if (parameter.getNameAsString().equals("form") && parameter.getType().asString().equals("String")) {
                        formMethods.put(method.getNameAsString() + "/" + method.getParameters().size(), i);
                    }
                }
            }
        }
        Map<List<String>, Set<String>> reads = new TreeMap<>((a, b) -> String.join("\n", a).compareTo(String.join("\n", b)));
        Set<String> formConstants = new TreeSet<>();
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                Integer index = formMethods.get(call.getNameAsString() + "/" + call.getArguments().size());
                if (index == null) {
                    continue;
                }
                Expression argument = unwrap(call.getArgument(index));
                String form = code.constant(argument, Code.typeOf(call));
                if (form != null) {
                    reads.computeIfAbsent(List.of(unit.platform, form, call.getNameAsString()), k -> new TreeSet<>())
                            .add(code.where(call));
                    if (argument instanceof FieldAccessExpr || argument instanceof NameExpr) {
                        formConstants.add(argument.toString().substring(argument.toString().lastIndexOf('.') + 1));
                    }
                }
            }
        }
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                if (!call.getNameAsString().equals("equals") || call.getArguments().size() != 1) {
                    continue;
                }
                Expression argument = unwrap(call.getArgument(0));
                String name = argument instanceof FieldAccessExpr ? ((FieldAccessExpr) argument).getNameAsString()
                        : argument instanceof NameExpr ? ((NameExpr) argument).getNameAsString() : null;
                if (name != null && formConstants.contains(name)) {
                    String form = code.constant(argument, Code.typeOf(call));
                    if (form != null) {
                        reads.computeIfAbsent(List.of(unit.platform, form, "equals"), k -> new TreeSet<>()).add(code.where(call));
                    }
                }
            }
        }
        TypeDeclaration<?> parser = code.type("XFormParser");
        for (MethodCallExpr call : parser.findAll(MethodCallExpr.class)) {
            if (call.getNameAsString().equals("addElement") && call.getScope().isPresent()
                    && call.getScope().get().toString().equals("itextKnownForms") && call.getArguments().size() == 1) {
                String form = code.constant(call.getArgument(0), parser);
                if (form != null) {
                    reads.computeIfAbsent(List.of("core", form, "itextKnownForms"), k -> new TreeSet<>()).add(code.where(call));
                }
            }
        }
        List<Object> out = new ArrayList<>();
        for (Map.Entry<List<String>, Set<String>> entry : reads.entrySet()) {
            Map<String, Object> read = new TreeMap<>();
            read.put("reader", entry.getKey().get(0));
            read.put("form", entry.getKey().get(1));
            read.put("via", entry.getKey().get(2));
            read.put("at", new ArrayList<>(entry.getValue()));
            out.add(read);
        }
        return out;
    }

    // -- the session instance -------------------------------------------------------------

    /**
     * The elements `SessionInstanceBuilder.getSessionInstance` builds: each `new TreeElement(name,
     * ...)`, placed under the element it is added to (`parent.addChild(child)`, through the builder's
     * own helpers), with its name (a constant, or `*` with the expression that names it), the value it
     * is given and the conditions it is built under.
     */
    static Map<String, Object> sessionInstance(Code code) {
        TypeDeclaration<?> builder = code.type("SessionInstanceBuilder");
        if (builder == null) {
            throw new IllegalStateException("Core's SessionInstanceBuilder is not among the parsed sources.");
        }
        SessionTree tree = new SessionTree(code, builder);
        CallableDeclaration<?> entry = builder.getMethodsByName("getSessionInstance").get(0);
        Map<String, String> arguments = new HashMap<>();
        for (Parameter parameter : entry.getParameters()) {
            arguments.put(parameter.getNameAsString(), parameter.getNameAsString());
        }
        tree.run(entry, new HashMap<>(), new HashMap<>(), arguments, new ArrayList<>());
        Map<String, Object> out = new TreeMap<>();
        for (SessionTree.Element element : tree.created) {
            String path = tree.path(element);
            if (path == null) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> facts = (Map<String, Object>) out.computeIfAbsent(path, k -> new TreeMap<>());
            addTo(facts, "built", element.facts);
        }
        return out;
    }

    static final class SessionTree {
        static final class Element {
            final String name;
            Element parent;
            final Map<String, Object> facts = new TreeMap<>();

            Element(String name) {
                this.name = name;
            }
        }

        final Code code;
        final TypeDeclaration<?> builder;
        final List<Element> created = new ArrayList<>();

        SessionTree(Code code, TypeDeclaration<?> builder) {
            this.code = code;
            this.builder = builder;
        }

        String path(Element element) {
            List<String> steps = new ArrayList<>();
            Element current = element;
            while (current != null) {
                steps.add(0, current.name);
                if (current.parent == null && !steps.get(0).equals("session")) {
                    return null;
                }
                current = current.parent;
            }
            return String.join("/", steps);
        }

        /**
         * Runs a builder method: `elements` maps locals to elements, `strings` to constant names,
         * `sources` to the expression (in the entry method's terms) a value comes from.
         */
        void run(CallableDeclaration<?> callable, Map<String, Element> elements, Map<String, String> strings,
                 Map<String, String> sources, List<String> conditions) {
            if (!(callable instanceof MethodDeclaration) || !((MethodDeclaration) callable).getBody().isPresent()) {
                return;
            }
            block(((MethodDeclaration) callable).getBody().get().getStatements(), elements, strings, sources, conditions);
        }

        void block(List<Statement> statements, Map<String, Element> elements, Map<String, String> strings,
                   Map<String, String> sources, List<String> conditions) {
            for (Statement statement : statements) {
                statement(statement, elements, strings, sources, conditions);
            }
        }

        void statement(Statement statement, Map<String, Element> elements, Map<String, String> strings,
                       Map<String, String> sources, List<String> conditions) {
            if (statement instanceof BlockStmt) {
                block(((BlockStmt) statement).getStatements(), elements, strings, sources, conditions);
            } else if (statement instanceof IfStmt) {
                IfStmt branch = (IfStmt) statement;
                List<String> then = new ArrayList<>(conditions);
                then.add(printed(branch.getCondition(), sources));
                statement(branch.getThenStmt(), elements, strings, sources, then);
                branch.getElseStmt().ifPresent(other -> {
                    List<String> otherwise = new ArrayList<>(conditions);
                    otherwise.add("not (" + printed(branch.getCondition(), sources) + ")");
                    statement(other, elements, strings, sources, otherwise);
                });
            } else if (statement instanceof ForEachStmt) {
                ForEachStmt loop = (ForEachStmt) statement;
                List<String> inside = new ArrayList<>(conditions);
                inside.add("for " + loop.getVariable().getVariables().get(0).getNameAsString() + " in "
                        + printed(loop.getIterable(), sources));
                statement(loop.getBody(), elements, strings, sources, inside);
            } else if (statement instanceof ForStmt) {
                ForStmt loop = (ForStmt) statement;
                List<String> inside = new ArrayList<>(conditions);
                inside.add("for " + loop.getInitialization() + "; " + loop.getCompare().map(Node::toString).orElse(""));
                statement(loop.getBody(), elements, strings, sources, inside);
            } else if (statement instanceof ExpressionStmt) {
                expression(((ExpressionStmt) statement).getExpression(), elements, strings, sources, conditions);
            }
        }

        /** An expression printed with each of the method's parameters replaced by what the entry passed. */
        String printed(Expression expression, Map<String, String> sources) {
            Expression bare = unwrap(expression);
            if (bare instanceof NameExpr && sources.containsKey(((NameExpr) bare).getNameAsString())) {
                return sources.get(((NameExpr) bare).getNameAsString());
            }
            Expression copy = expression.clone();
            for (NameExpr name : copy.findAll(NameExpr.class)) {
                String source = sources.get(name.getNameAsString());
                if (source != null && !source.equals(name.getNameAsString())) {
                    name.replace(new NameExpr("(" + source + ")"));
                }
            }
            return copy.toString();
        }

        void expression(Expression expression, Map<String, Element> elements, Map<String, String> strings,
                        Map<String, String> sources, List<String> conditions) {
            Expression inner = unwrap(expression);
            if (inner instanceof com.github.javaparser.ast.expr.VariableDeclarationExpr) {
                for (VariableDeclarator variable : ((com.github.javaparser.ast.expr.VariableDeclarationExpr) inner).getVariables()) {
                    variable.getInitializer().ifPresent(init -> {
                        Element made = element(init, elements, strings, sources, conditions);
                        if (made != null) {
                            elements.put(variable.getNameAsString(), made);
                        }
                        sources.put(variable.getNameAsString(), printed(init, sources));
                    });
                }
                return;
            }
            if (!(inner instanceof MethodCallExpr)) {
                return;
            }
            MethodCallExpr call = (MethodCallExpr) inner;
            String name = call.getNameAsString();
            if (name.equals("addChild") && call.getArguments().size() == 1 && call.getScope().isPresent()) {
                Element parent = elements.get(call.getScope().get().toString());
                Element child = elements.get(unwrap(call.getArgument(0)).toString());
                if (parent != null && child != null) {
                    child.parent = parent;
                    child.facts.put("addedWhen", new ArrayList<>(conditions));
                    child.facts.put("addedAt", code.where(call));
                }
                return;
            }
            if (name.equals("setValue") && call.getArguments().size() == 1 && call.getScope().isPresent()) {
                Element target = elements.get(call.getScope().get().toString());
                if (target != null) {
                    target.facts.put("value", printed(call.getArgument(0), sources));
                }
                return;
            }
            if (!call.getScope().isPresent()) {
                for (CallableDeclaration<?> target : code.callables(builder, name, call.getArguments().size())) {
                    Map<String, Element> calleeElements = new HashMap<>();
                    Map<String, String> calleeStrings = new HashMap<>();
                    Map<String, String> calleeSources = new HashMap<>();
                    for (int i = 0; i < target.getParameters().size(); i++) {
                        String parameter = target.getParameter(i).getNameAsString();
                        Expression argument = unwrap(call.getArgument(i));
                        Element element = elements.get(argument.toString());
                        if (element != null) {
                            calleeElements.put(parameter, element);
                        }
                        String constant = constant(argument, strings);
                        if (constant != null) {
                            calleeStrings.put(parameter, constant);
                        }
                        calleeSources.put(parameter, printed(argument, sources));
                    }
                    run(target, calleeElements, calleeStrings, calleeSources, conditions);
                }
            }
        }

        String constant(Expression expression, Map<String, String> strings) {
            Expression inner = unwrap(expression);
            if (inner instanceof NameExpr && strings.containsKey(((NameExpr) inner).getNameAsString())) {
                return strings.get(((NameExpr) inner).getNameAsString());
            }
            return code.constant(inner, builder);
        }

        Element element(Expression init, Map<String, Element> elements, Map<String, String> strings,
                        Map<String, String> sources, List<String> conditions) {
            Expression inner = unwrap(init);
            if (inner instanceof ObjectCreationExpr && ((ObjectCreationExpr) inner).getType().getNameAsString().equals("TreeElement")
                    && !((ObjectCreationExpr) inner).getArguments().isEmpty()) {
                Expression nameArgument = ((ObjectCreationExpr) inner).getArgument(0);
                String name = constant(nameArgument, strings);
                Element made = new Element(name == null ? "*" : name);
                if (name == null) {
                    made.facts.put("nameFrom", printed(nameArgument, sources));
                }
                made.facts.put("builtAt", code.where(inner));
                made.facts.put("builtWhen", new ArrayList<>(conditions));
                created.add(made);
                return made;
            }
            return null;
        }
    }

    // -- instance sources -----------------------------------------------------------------

    /**
     * The order in which `CommCareInstanceInitializer.generateRoot` matches an instance's `src` and the
     * setup each match runs: each branch of its `if` chain, with the test (`contains`, `startsWith`,
     * on the reference), the constant it tests for, and the setup method the branch returns; then,
     * for each subclass in Core, its command line and Android, the setup methods it overrides, and the
     * exceptions each setup method (and the methods of its class it calls) throws.
     */
    static Map<String, Object> instanceSources(Code code) {
        TypeDeclaration<?> base = code.type("CommCareInstanceInitializer");
        if (base == null) {
            throw new IllegalStateException("Core's CommCareInstanceInitializer is not among the parsed sources.");
        }
        MethodDeclaration generateRoot = base.getMethodsByName("generateRoot").get(0);
        List<Object> branches = new ArrayList<>();
        Statement current = generateRoot.getBody().get().getStatements().stream()
                .filter(s -> s instanceof IfStmt).findFirst()
                .orElseThrow(() -> new IllegalStateException("generateRoot holds no if chain."));
        int order = 0;
        while (current instanceof IfStmt) {
            IfStmt branch = (IfStmt) current;
            Map<String, Object> facts = new TreeMap<>();
            facts.put("order", ++order);
            facts.put("test", branch.getCondition().toString());
            Expression condition = unwrap(branch.getCondition());
            if (condition instanceof MethodCallExpr && ((MethodCallExpr) condition).getArguments().size() == 1) {
                facts.put("match", ((MethodCallExpr) condition).getNameAsString());
                facts.put("token", code.constant(((MethodCallExpr) condition).getArgument(0), base));
            } else {
                facts.put("match", null);
                facts.put("token", null);
            }
            facts.put("setup", returnedCall(branch.getThenStmt()));
            facts.put("at", code.where(branch));
            branches.add(facts);
            current = branch.getElseStmt().orElse(null);
        }
        Map<String, Object> fallback = new TreeMap<>();
        fallback.put("order", ++order);
        fallback.put("returns", generateRoot.getBody().get().getStatements().get(generateRoot.getBody().get().getStatements().size() - 1)
                .toString());
        fallback.put("at", code.where(generateRoot));
        Map<String, Object> overrides = new TreeMap<>();
        for (List<TypeDeclaration<?>> declarations : code.types.values()) {
            for (TypeDeclaration<?> type : declarations) {
                if (type == base || !extendsType(code, type, base)) {
                    continue;
                }
                List<String> methods = new ArrayList<>();
                for (MethodDeclaration method : type.getMethods()) {
                    if (!base.getMethodsByName(method.getNameAsString()).isEmpty()) {
                        methods.add(method.getNameAsString());
                    }
                }
                methods.sort(null);
                Map<String, Object> facts = new TreeMap<>();
                facts.put("platform", code.unitOf(type).relative.contains("/src/cli/") ? "cli" : code.unitOf(type).platform);
                facts.put("at", code.where(type));
                facts.put("overrides", methods);
                overrides.put(type.getNameAsString(), facts);
            }
        }
        Map<String, Object> raises = new TreeMap<>();
        for (MethodDeclaration method : base.getMethods()) {
            if (method.getNameAsString().startsWith("setup") || method.getNameAsString().equals("loadFixtureRoot")) {
                raises.put(method.getNameAsString(), thrown(code, base, method, new TreeSet<>()));
            }
        }
        Map<String, Object> out = new TreeMap<>();
        out.put("branches", branches);
        out.put("fallback", fallback);
        out.put("initializers", overrides);
        out.put("raises", raises);
        return out;
    }

    /** Whether a type extends `base`, through the classes it extends (not the types it is nested in). */
    private static boolean extendsType(Code code, TypeDeclaration<?> type, TypeDeclaration<?> base) {
        Set<String> seen = new TreeSet<>();
        TypeDeclaration<?> current = type;
        while (current != null && seen.add(current.getNameAsString())) {
            String parent = Code.superName(current);
            if (parent == null) {
                return false;
            }
            if (parent.equals(base.getNameAsString())) {
                return true;
            }
            current = code.type(parent);
        }
        return false;
    }

    private static String returnedCall(Statement statement) {
        for (ReturnStmt returned : statement.findAll(ReturnStmt.class)) {
            if (returned.getExpression().isPresent() && returned.getExpression().get() instanceof MethodCallExpr) {
                return ((MethodCallExpr) returned.getExpression().get()).getNameAsString();
            }
        }
        return null;
    }

    /** The exception classes a method throws, and those of its class's methods it calls. */
    private static List<String> thrown(Code code, TypeDeclaration<?> owner, MethodDeclaration method, Set<String> seen) {
        Set<String> found = new TreeSet<>();
        if (!seen.add(method.getDeclarationAsString(false, false, false))) {
            return new ArrayList<>();
        }
        for (ThrowStmt thrown : method.findAll(ThrowStmt.class)) {
            if (thrown.getExpression() instanceof ObjectCreationExpr) {
                found.add(((ObjectCreationExpr) thrown.getExpression()).getType().getNameAsString());
            }
        }
        for (MethodCallExpr call : method.findAll(MethodCallExpr.class)) {
            if (!call.getScope().isPresent()) {
                for (MethodDeclaration callee : owner.getMethodsByName(call.getNameAsString())) {
                    found.addAll(thrown(code, owner, callee, seen));
                }
            }
        }
        return new ArrayList<>(found);
    }

    // -- function handlers ----------------------------------------------------------------

    /**
     * Every `addFunctionHandler(handler)` registration, in Java and in Kotlin, with the function name
     * the handler answers (its `getName()`), its class, its argument prototypes and whether it takes
     * its arguments raw. A handler is an anonymous class, a class constructed in place, or a value a
     * static method or field holds.
     */
    static List<Object> functionHandlers(Code code, List<Kotlin.Unit> kotlin) {
        List<Object> out = new ArrayList<>();
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                if (!call.getNameAsString().equals("addFunctionHandler") || call.getArguments().size() != 1) {
                    continue;
                }
                Map<String, Object> registration = handler(code, unwrap(call.getArgument(0)), Code.typeOf(call));
                registration.put("platform", unit.relative.contains("/src/cli/") ? "cli" : unit.platform);
                registration.put("at", code.where(call));
                out.add(registration);
            }
        }
        for (Kotlin.Unit unit : kotlin) {
            List<Kotlin.Token> tokens = unit.tokens;
            for (int i = 0; i + 1 < tokens.size(); i++) {
                if (!tokens.get(i).is("addFunctionHandler") || !tokens.get(i + 1).is("(")) {
                    continue;
                }
                int close = Kotlin.closing(tokens, i + 1);
                List<Kotlin.Token> argument = tokens.subList(i + 2, close);
                Map<String, Object> registration;
                // `Type.method()`: a static Java method, read as Java.
                if (argument.size() == 5 && argument.get(0).kind == Kotlin.Kind.IDENT && argument.get(1).is(".")
                        && argument.get(2).kind == Kotlin.Kind.IDENT && argument.get(3).is("(") && argument.get(4).is(")")) {
                    MethodCallExpr call = new MethodCallExpr(new NameExpr(argument.get(0).text), argument.get(2).text);
                    registration = handler(code, call, null);
                } else {
                    registration = new TreeMap<>();
                    registration.put("handler", null);
                    registration.put("name", null);
                }
                registration.put("expression", String.join("", argument.stream().map(Kotlin.Token::toString).toList()));
                registration.put("platform", unit.platform);
                registration.put("at", Kotlin.where(unit, i));
                out.add(registration);
            }
        }
        return out;
    }

    private static Map<String, Object> handler(Code code, Expression argument, TypeDeclaration<?> context) {
        Map<String, Object> facts = new TreeMap<>();
        facts.put("expression", argument.toString().length() > 120 ? argument.toString().substring(0, argument.toString().indexOf('{') < 0
                ? 120 : argument.toString().indexOf('{')).trim() : argument.toString());
        List<Node> bodies = new ArrayList<>();
        String handlerClass = null;
        if (argument instanceof ObjectCreationExpr) {
            ObjectCreationExpr creation = (ObjectCreationExpr) argument;
            if (creation.getAnonymousClassBody().isPresent()) {
                handlerClass = "(anonymous " + creation.getType().getNameAsString() + ")";
                bodies.addAll(creation.getAnonymousClassBody().get());
            } else {
                handlerClass = creation.getType().getNameAsString();
            }
        } else if (argument instanceof MethodCallExpr && ((MethodCallExpr) argument).getScope().isPresent()
                && ((MethodCallExpr) argument).getScope().get() instanceof NameExpr) {
            TypeDeclaration<?> owner = code.type(((NameExpr) ((MethodCallExpr) argument).getScope().get()).getNameAsString());
            for (CallableDeclaration<?> target : code.callables(owner, ((MethodCallExpr) argument).getNameAsString(), 0)) {
                for (ReturnStmt returned : target.findAll(ReturnStmt.class)) {
                    if (returned.getExpression().isPresent()) {
                        handlerClass = heldClass(code, returned.getExpression().get(), owner);
                    }
                }
            }
        } else if (argument instanceof NameExpr) {
            handlerClass = heldClass(code, argument, context);
        }
        facts.put("handler", handlerClass);
        if (handlerClass != null && !handlerClass.startsWith("(")) {
            TypeDeclaration<?> type = code.type(handlerClass);
            if (type != null) {
                for (TypeDeclaration<?> one : code.lookupChain(type)) {
                    bodies.addAll(one.getMembers());
                }
            }
        }
        facts.put("name", null);
        for (Node member : bodies) {
            if (!(member instanceof MethodDeclaration) || !((MethodDeclaration) member).getBody().isPresent()) {
                continue;
            }
            MethodDeclaration method = (MethodDeclaration) member;
            TypeDeclaration<?> owner = Code.typeOf(method);
            if (method.getNameAsString().equals("getName") && facts.get("name") == null) {
                for (ReturnStmt returned : method.findAll(ReturnStmt.class)) {
                    returned.getExpression().ifPresent(e -> facts.put("name", code.constant(e, owner)));
                }
            } else if (method.getNameAsString().equals("rawArgs") && !facts.containsKey("rawArgs")) {
                for (ReturnStmt returned : method.findAll(ReturnStmt.class)) {
                    returned.getExpression().ifPresent(e -> facts.put("rawArgs",
                            e instanceof BooleanLiteralExpr ? ((BooleanLiteralExpr) e).getValue() : e.toString()));
                }
            } else if (method.getNameAsString().equals("getPrototypes") && !facts.containsKey("prototypes")) {
                List<Object> prototypes = new ArrayList<>();
                for (ArrayCreationExpr array : method.findAll(ArrayCreationExpr.class)) {
                    List<String> types = new ArrayList<>();
                    array.getInitializer().ifPresent(init -> {
                        for (Expression value : init.getValues()) {
                            types.add(value instanceof ClassExpr ? ((ClassExpr) value).getType().asString() : value.toString());
                        }
                    });
                    prototypes.add(types);
                }
                for (ArrayInitializerExpr array : method.findAll(ArrayInitializerExpr.class)) {
                    if (array.getParentNode().isPresent() && array.getParentNode().get() instanceof VariableDeclarator) {
                        List<String> types = new ArrayList<>();
                        for (Expression value : array.getValues()) {
                            types.add(value instanceof ClassExpr ? ((ClassExpr) value).getType().asString() : value.toString());
                        }
                        prototypes.add(types);
                    }
                }
                facts.put("prototypes", prototypes);
            }
        }
        return facts;
    }

    /** The class of the object an expression holds: `new X()`, or a field initialised with one. */
    private static String heldClass(Code code, Expression expression, TypeDeclaration<?> context) {
        Expression inner = unwrap(expression);
        if (inner instanceof ObjectCreationExpr) {
            return ((ObjectCreationExpr) inner).getType().getNameAsString();
        }
        if (inner instanceof NameExpr) {
            VariableDeclarator field = code.field(context, ((NameExpr) inner).getNameAsString());
            if (field != null && field.getInitializer().isPresent()) {
                return heldClass(code, field.getInitializer().get(), Code.typeOf(field));
            }
            if (field != null) {
                return field.getType().asString();
            }
        }
        return null;
    }

    // -- the XPath grammar ----------------------------------------------------------------

    /**
     * Core's XPath grammar: each token type (`Token`'s constants, by reflection) with the lexer
     * conditions under which `Lexer.lex` makes it, each binary and unary operator with the expression
     * it builds and its precedence (the parser's operator groups in the order `parseOperators` applies
     * them), each axis and node test with the names the parser accepts for it, whether Core makes a
     * reference of a step on it (`XPathPathExpr.getReference`, run on Core's own classes), and each
     * expression class the parser builds, with whether it evaluates or refuses.
     */
    static Map<String, Object> xpathGrammar(Code code) throws Exception {
        Map<String, Object> out = new TreeMap<>();
        Class<?> token = Class.forName("org.javarosa.xpath.parser.Token");
        Map<Integer, String> tokenNames = new TreeMap<>();
        for (Field field : token.getDeclaredFields()) {
            if (Modifier.isStatic(field.getModifiers()) && field.getType() == int.class) {
                tokenNames.put(field.getInt(null), field.getName());
            }
        }
        Map<String, Object> tokens = new TreeMap<>();
        for (String name : tokenNames.values()) {
            Map<String, Object> facts = new TreeMap<>();
            facts.put("lexed", new ArrayList<>());
            tokens.put(name, facts);
        }
        TypeDeclaration<?> lexer = code.type("Lexer");
        MethodDeclaration lex = lexer.getMethodsByName("lex").get(0);
        for (ObjectCreationExpr creation : lex.findAll(ObjectCreationExpr.class)) {
            if (!creation.getType().getNameAsString().equals("Token") || creation.getArguments().isEmpty()) {
                continue;
            }
            Expression kind = unwrap(creation.getArgument(0));
            List<String[]> made = new ArrayList<>();
            if (kind instanceof ConditionalExpr) {
                ConditionalExpr choice = (ConditionalExpr) kind;
                made.add(new String[]{last(choice.getThenExpr()), choice.getCondition().toString()});
                made.add(new String[]{last(choice.getElseExpr()), "!(" + choice.getCondition() + ")"});
            } else {
                made.add(new String[]{last(kind), null});
            }
            for (String[] one : made) {
                List<String> conditions = enclosingConditions(creation, lex);
                if (one[1] != null) {
                    conditions.add(one[1]);
                }
                Map<String, Object> lexed = new TreeMap<>();
                lexed.put("when", conditions);
                // A token made with a value (a number, a string, a name) has no fixed lexeme.
                lexed.put("lexeme", creation.getArguments().size() > 1 ? null : lexeme(conditions, creation));
                lexed.put("carriesValue", creation.getArguments().size() > 1);
                @SuppressWarnings("unchecked")
                Map<String, Object> facts = (Map<String, Object>) tokens.get(one[0]);
                if (facts == null) {
                    throw new IllegalStateException("Lexer.lex makes a token " + one[0] + " Token does not declare.");
                }
                addTo(facts, "lexed", lexed);
            }
        }
        // Binary operators and the expressions they build.
        TypeDeclaration<?> binary = code.type("ASTNodeBinaryOp");
        for (SwitchEntry entry : binary.getMethodsByName("getBinOpExpr").get(0).findAll(SwitchEntry.class)) {
            for (Expression label : entry.getLabels()) {
                String name = last(label);
                for (ObjectCreationExpr creation : entry.findAll(ObjectCreationExpr.class)) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> facts = (Map<String, Object>) tokens.get(name);
                    Map<String, Object> builds = new TreeMap<>();
                    builds.put("expression", creation.getType().getNameAsString());
                    builds.put("operator", creation.getArguments().size() == 3 ? last(creation.getArgument(0)) : null);
                    facts.put("binaryOperator", builds);
                }
            }
        }
        TypeDeclaration<?> parser = code.type("Parser");
        MethodDeclaration parseOperators = parser.getMethodsByName("parseOperators").get(0);
        Map<String, List<String>> groups = new LinkedHashMap<>();
        for (VariableDeclarator variable : parseOperators.findAll(VariableDeclarator.class)) {
            if (variable.getInitializer().isPresent() && variable.getInitializer().get() instanceof ArrayInitializerExpr) {
                List<String> members = new ArrayList<>();
                for (Expression value : ((ArrayInitializerExpr) variable.getInitializer().get()).getValues()) {
                    members.add(last(value));
                }
                groups.put(variable.getNameAsString(), members);
            }
        }
        int level = 0;
        for (MethodCallExpr call : parseOperators.findAll(MethodCallExpr.class)) {
            level++;
            if (call.getNameAsString().equals("parseBinaryOp") && call.getArguments().size() == 3) {
                for (String member : groups.getOrDefault(call.getArgument(1).toString(), List.of())) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> facts = (Map<String, Object>) tokens.get(member);
                    facts.put("applied", level);
                    facts.put("associativity", last(call.getArgument(2)));
                }
            } else if (call.getNameAsString().equals("parseUnaryOp") && call.getArguments().size() == 2) {
                @SuppressWarnings("unchecked")
                Map<String, Object> facts = (Map<String, Object>) tokens.get(last(call.getArgument(1)));
                facts.put("applied", level);
                TypeDeclaration<?> unary = code.type("ASTNodeUnaryOp");
                for (ObjectCreationExpr creation : unary.getMethodsByName("build").get(0).findAll(ObjectCreationExpr.class)) {
                    if (!creation.getType().getNameAsString().endsWith("Exception")) {
                        facts.put("unaryOperator", creation.getType().getNameAsString());
                    }
                }
            }
        }
        out.put("tokens", tokens);
        out.put("axes", axes(code));
        out.put("expressions", expressions(code));
        return out;
    }

    private static String last(Expression expression) {
        String text = unwrap(expression).toString();
        return text.substring(text.lastIndexOf('.') + 1);
    }

    /** The conditions of each `if` around `node` inside `within`: its test inside the `then`, negated inside the `else`. */
    private static List<String> enclosingConditions(Node node, Node within) {
        List<String> conditions = new ArrayList<>();
        for (Expression[] test : enclosingTests(node, within)) {
            conditions.add(test[1] == null ? test[0].toString() : "!(" + test[0] + ")");
        }
        return conditions;
    }

    /** Each `if` test around `node` inside `within`, outermost first: {test, null} in its `then`, {test, test} in its `else`. */
    private static List<Expression[]> enclosingTests(Node node, Node within) {
        List<Expression[]> tests = new ArrayList<>();
        Node child = node;
        Node current = node.getParentNode().orElse(null);
        while (current != null && current != within) {
            if (current instanceof IfStmt) {
                IfStmt branch = (IfStmt) current;
                if (branch.getThenStmt() == child) {
                    tests.add(0, new Expression[]{branch.getCondition(), null});
                } else if (branch.getElseStmt().isPresent() && branch.getElseStmt().get() == child
                        && !(child instanceof IfStmt)) {
                    // An `else` block negates its test; an `else if` link only orders the chain.
                    tests.add(0, new Expression[]{branch.getCondition(), branch.getCondition()});
                }
            }
            child = current;
            current = current.getParentNode().orElse(null);
        }
        return tests;
    }

    /**
     * The characters or word a token is made from, read from the tests that make it: the current
     * character (`c == '<'`), the next one (`d == '='`) where the branch also skips two characters
     * (`skip = 2`), or a word (`"and".equals(...)`).
     */
    private static String lexeme(List<String> conditions, ObjectCreationExpr creation) {
        String c = null;
        String d = null;
        String word = null;
        for (Expression[] test : enclosingTests(creation, null)) {
            if (test[1] != null) {
                continue;
            }
            List<Expression> conjuncts = new ArrayList<>();
            collect(test[0], conjuncts);
            for (Expression conjunct : conjuncts) {
                Expression inner = unwrap(conjunct);
                if (inner instanceof BinaryExpr && ((BinaryExpr) inner).getOperator() == BinaryExpr.Operator.EQUALS
                        && ((BinaryExpr) inner).getRight() instanceof CharLiteralExpr) {
                    String name = ((BinaryExpr) inner).getLeft().toString();
                    String value = String.valueOf(((CharLiteralExpr) ((BinaryExpr) inner).getRight()).asChar());
                    if (name.equals("c")) {
                        c = value;
                    } else if (name.equals("d")) {
                        d = value;
                    }
                }
                if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getNameAsString().equals("equals")
                        && ((MethodCallExpr) inner).getScope().isPresent()
                        && ((MethodCallExpr) inner).getScope().get().isStringLiteralExpr()) {
                    word = ((MethodCallExpr) inner).getScope().get().asStringLiteralExpr().asString();
                }
            }
        }
        if (word != null) {
            return word;
        }
        if (c == null) {
            return null;
        }
        Node block = creation;
        while (block != null && !(block instanceof BlockStmt)) {
            block = block.getParentNode().orElse(null);
        }
        int skip = 1;
        if (block != null) {
            for (AssignExpr assign : block.findAll(AssignExpr.class)) {
                if (assign.getTarget().toString().equals("skip") && assign.getValue().isIntegerLiteralExpr()
                        && Code.typeOf(assign) == Code.typeOf(creation)
                        && assign.getParentNode().flatMap(Node::getParentNode).orElse(null) == block) {
                    skip = assign.getValue().asIntegerLiteralExpr().asNumber().intValue();
                }
            }
        }
        return skip >= 2 && d != null ? c + d : c;
    }

    private static void collect(Expression expression, List<Expression> out) {
        Expression inner = unwrap(expression);
        if (inner instanceof BinaryExpr && ((BinaryExpr) inner).getOperator() == BinaryExpr.Operator.AND) {
            collect(((BinaryExpr) inner).getLeft(), out);
            collect(((BinaryExpr) inner).getRight(), out);
        } else {
            out.add(inner);
        }
    }

    /** Each axis: its constant, the name the parser accepts, and whether Core makes a reference of a step on it. */
    private static Map<String, Object> axes(Code code) throws Exception {
        Class<?> step = Class.forName("org.javarosa.xpath.expr.XPathStep");
        Class<?> qname = Class.forName("org.javarosa.xpath.expr.XPathQName");
        Class<?> path = Class.forName("org.javarosa.xpath.expr.XPathPathExpr");
        Map<String, Integer> axes = new TreeMap<>();
        Map<String, Integer> tests = new TreeMap<>();
        for (Field field : step.getDeclaredFields()) {
            if (Modifier.isStatic(field.getModifiers()) && field.getType() == int.class) {
                if (field.getName().startsWith("AXIS_")) {
                    axes.put(field.getName(), field.getInt(null));
                } else if (field.getName().startsWith("TEST_")) {
                    tests.put(field.getName(), field.getInt(null));
                }
            }
        }
        // The names the parser accepts for each axis and node test, read from their source.
        Map<String, String> axisNames = new TreeMap<>();
        Map<String, String> testNames = new TreeMap<>();
        TypeDeclaration<?> pathStep = code.type("ASTNodePathStep");
        for (IfStmt branch : pathStep.findAll(IfStmt.class)) {
            Expression condition = unwrap(branch.getCondition());
            if (condition instanceof MethodCallExpr && ((MethodCallExpr) condition).getNameAsString().equals("equals")
                    && ((MethodCallExpr) condition).getArguments().size() == 1
                    && ((MethodCallExpr) condition).getArgument(0).isStringLiteralExpr()) {
                String name = ((MethodCallExpr) condition).getArgument(0).asStringLiteralExpr().asString();
                for (AssignExpr assign : branch.getThenStmt().findAll(AssignExpr.class)) {
                    String value = last(assign.getValue());
                    if (value.startsWith("AXIS_")) {
                        axisNames.put(value, name);
                    } else if (value.startsWith("TEST_")) {
                        testNames.put(value, name);
                    }
                }
            }
        }
        Map<String, Object> out = new TreeMap<>();
        java.lang.reflect.Constructor<?> byTest = step.getConstructor(int.class, int.class);
        java.lang.reflect.Constructor<?> byName = step.getConstructor(int.class, qname);
        java.lang.reflect.Constructor<?> pathOf = path.getConstructor(int.class, java.lang.reflect.Array.newInstance(step, 0).getClass());
        int relative = path.getField("INIT_CONTEXT_RELATIVE").getInt(null);
        for (Map.Entry<String, Integer> axis : axes.entrySet()) {
            Map<String, Object> facts = new TreeMap<>();
            facts.put("constant", axis.getKey());
            facts.put("parserName", axisNames.get(axis.getKey()));
            facts.put("printed", step.getMethod("axisStr", int.class).invoke(null, axis.getValue()));
            Map<String, Object> reference = new TreeMap<>();
            for (Map.Entry<String, Integer> test : tests.entrySet()) {
                Object made = test.getKey().equals("TEST_NAME")
                        ? byName.newInstance(axis.getValue(), qname.getConstructor(String.class).newInstance("a"))
                        : byTest.newInstance(axis.getValue(), test.getValue());
                Object steps = java.lang.reflect.Array.newInstance(step, 1);
                java.lang.reflect.Array.set(steps, 0, made);
                Object expression = pathOf.newInstance(relative, steps);
                try {
                    path.getMethod("getReference").invoke(expression);
                    reference.put(test.getKey(), "accepted");
                } catch (java.lang.reflect.InvocationTargetException refused) {
                    reference.put(test.getKey(), "refused: " + refused.getCause().getMessage());
                }
            }
            facts.put("referenceByTest", reference);
            out.put(axis.getKey(), facts);
        }
        Map<String, Object> all = new TreeMap<>();
        all.put("axes", out);
        Map<String, Object> testFacts = new TreeMap<>();
        for (Map.Entry<String, Integer> test : tests.entrySet()) {
            Map<String, Object> facts = new TreeMap<>();
            facts.put("parserName", testNames.get(test.getKey()));
            testFacts.put(test.getKey(), facts);
        }
        all.put("tests", testFacts);
        return all;
    }

    /** Each expression class the parser's AST builds, with its builder and whether its evaluation refuses. */
    private static Map<String, Object> expressions(Code code) {
        Map<String, Object> out = new TreeMap<>();
        for (Code.Unit unit : code.units) {
            if (!unit.relative.contains("/xpath/parser/")) {
                continue;
            }
            for (ObjectCreationExpr creation : unit.tree.findAll(ObjectCreationExpr.class)) {
                String created = creation.getType().getNameAsString();
                if (!created.startsWith("XPath") || created.endsWith("Exception") || created.equals("XPathQName")
                        || created.equals("XPathStep") || created.endsWith("Func") || created.equals("XPathCustomRuntimeFunc")) {
                    continue;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> facts = (Map<String, Object>) out.computeIfAbsent(created, k -> {
                    Map<String, Object> made = new TreeMap<>();
                    made.put("builtBy", new TreeSet<String>());
                    made.put("initContexts", new TreeSet<String>());
                    return made;
                });
                @SuppressWarnings("unchecked")
                Set<String> builtBy = (Set<String>) facts.get("builtBy");
                builtBy.add(code.where(creation));
                for (Expression argument : creation.getArguments()) {
                    for (FieldAccessExpr access : argument.findAll(FieldAccessExpr.class)) {
                        if (access.getNameAsString().startsWith("INIT_CONTEXT_")) {
                            @SuppressWarnings("unchecked")
                            Set<String> contexts = (Set<String>) facts.get("initContexts");
                            contexts.add(access.getNameAsString());
                        }
                    }
                }
            }
        }
        for (Map.Entry<String, Object> entry : out.entrySet()) {
            TypeDeclaration<?> type = code.type(entry.getKey());
            @SuppressWarnings("unchecked")
            Map<String, Object> facts = (Map<String, Object>) entry.getValue();
            facts.put("evaluation", null);
            if (type == null) {
                continue;
            }
            for (MethodDeclaration method : type.getMethodsByName("evalRaw")) {
                List<Statement> body = method.getBody().map(BlockStmt::getStatements).orElse(new com.github.javaparser.ast.NodeList<>());
                if (body.size() == 1 && body.get(0) instanceof ThrowStmt
                        && ((ThrowStmt) body.get(0)).getExpression() instanceof ObjectCreationExpr) {
                    ObjectCreationExpr thrown = (ObjectCreationExpr) ((ThrowStmt) body.get(0)).getExpression();
                    facts.put("evaluation", "refuses: " + thrown.getType().getNameAsString()
                            + (thrown.getArguments().isEmpty() ? "" : " " + thrown.getArgument(0)));
                } else {
                    facts.put("evaluation", "evaluates");
                }
            }
            // The functions a filter expression's head may be for a reference (`instance(...)`, `current()`).
            if (entry.getKey().equals("XPathPathExpr")) {
                List<String> heads = new ArrayList<>();
                for (MethodDeclaration method : type.getMethodsByName("getReference")) {
                    for (MethodCallExpr call : method.findAll(MethodCallExpr.class)) {
                        if (call.getNameAsString().equals("equals") && call.getArguments().size() == 1
                                && call.getArgument(0).isStringLiteralExpr() && call.getScope().isPresent()
                                && call.getScope().get().toString().endsWith(".name")) {
                            heads.add(call.getArgument(0).asStringLiteralExpr().asString());
                        }
                    }
                }
                facts.put("referenceFilterHeads", heads);
            }
            facts.put("builtBy", new ArrayList<>((Set<?>) facts.get("builtBy")));
            facts.put("initContexts", new ArrayList<>((Set<?>) facts.get("initContexts")));
        }
        return out;
    }

    // -- search prompts -------------------------------------------------------------------

    /**
     * Each value a runtime compares a search prompt's `input` or `appearance` with, and the inputs
     * each runtime lists as supported: in Java, a comparison with `getInput()` or `getAppearance()`
     * called on a `QueryPrompt`, and the `add(...)`s of a `getSupportedPrompts` method; in Kotlin, a
     * comparison (`==`, `!=`, `contentEquals`, `equals`) with `<prompt>.input` or
     * `<prompt>.appearance` on a value declared `QueryPrompt`, or a local holding one.
     */
    static List<Object> prompts(Code code, List<Kotlin.Unit> kotlin) {
        List<Object> out = new ArrayList<>();
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                String name = call.getNameAsString();
                if ((name.equals("equals") || name.equals("contentEquals")) && call.getArguments().size() == 1
                        && call.getScope().isPresent()) {
                    Expression[] sides = {unwrap(call.getScope().get()), unwrap(call.getArgument(0))};
                    for (int i = 0; i < 2; i++) {
                        String property = promptProperty(sides[i]);
                        String value = code.constant(sides[1 - i], Code.typeOf(call));
                        if (property != null && value != null) {
                            out.add(promptRead(unit.platform, property, value, "compared", code.where(call)));
                        }
                    }
                }
                if ((name.equals("add") || name.equals("addElement")) && call.getArguments().size() == 1) {
                    Node method = call;
                    while (method != null && !(method instanceof MethodDeclaration)) {
                        method = method.getParentNode().orElse(null);
                    }
                    if (method != null && ((MethodDeclaration) method).getNameAsString().equals("getSupportedPrompts")) {
                        String value = code.constant(call.getArgument(0), Code.typeOf(call));
                        if (value != null) {
                            String platform = unit.relative.contains("/src/cli/") ? "cli" : unit.platform;
                            out.add(promptRead(platform, "input", value, "supported", code.where(call)));
                        }
                    }
                }
            }
        }
        for (Kotlin.Unit unit : kotlin) {
            List<Kotlin.Token> tokens = unit.tokens;
            Map<String, String> constants = new TreeMap<>();
            Set<String> prompts = new TreeSet<>();
            Map<String, String> aliases = new TreeMap<>();
            for (int i = 0; i + 3 < tokens.size(); i++) {
                if (tokens.get(i).is("const") && tokens.get(i + 1).is("val") && tokens.get(i + 3).is("=")
                        && i + 4 < tokens.size() && tokens.get(i + 4).kind == Kotlin.Kind.STRING) {
                    constants.put(tokens.get(i + 2).text, tokens.get(i + 4).text);
                }
                if (tokens.get(i).kind == Kotlin.Kind.IDENT && tokens.get(i + 1).is(":") && tokens.get(i + 2).is("QueryPrompt")) {
                    prompts.add(tokens.get(i).text);
                }
            }
            for (int i = 0; i + 5 < tokens.size(); i++) {
                if (tokens.get(i).is("val") && tokens.get(i + 2).is("=") && tokens.get(i + 3).kind == Kotlin.Kind.IDENT
                        && prompts.contains(tokens.get(i + 3).text)
                        && tokens.get(i + 4).is(".") && (tokens.get(i + 5).is("input") || tokens.get(i + 5).is("appearance"))
                        && (i + 6 >= tokens.size() || !tokens.get(i + 6).is("."))) {
                    aliases.put(tokens.get(i + 1).text, tokens.get(i + 5).text);
                }
            }
            for (int i = 0; i < tokens.size(); i++) {
                String property = null;
                int end = i;
                if (tokens.get(i).kind != Kotlin.Kind.IDENT) {
                    continue;
                }
                if (prompts.contains(tokens.get(i).text) && i + 2 < tokens.size() && tokens.get(i + 1).is(".")
                        && (tokens.get(i + 2).is("input") || tokens.get(i + 2).is("appearance"))) {
                    property = tokens.get(i + 2).text;
                    end = i + 2;
                } else if (aliases.containsKey(tokens.get(i).text) && (i == 0 || !tokens.get(i - 1).is("val"))) {
                    property = aliases.get(tokens.get(i).text);
                }
                if (property == null) {
                    continue;
                }
                // `x == V`, `x != V`, `x.contentEquals(V)`, `x.equals(V)` and `V == x`.
                List<Kotlin.Token> other = null;
                if (end + 1 < tokens.size() && (tokens.get(end + 1).is("==") || tokens.get(end + 1).is("!="))) {
                    other = operand(tokens, end + 2, true);
                } else if (end + 3 < tokens.size() && tokens.get(end + 1).is(".")
                        && (tokens.get(end + 2).is("contentEquals") || tokens.get(end + 2).is("equals"))
                        && tokens.get(end + 3).is("(")) {
                    other = tokens.subList(end + 4, Kotlin.closing(tokens, end + 3));
                } else if (i >= 2 && (tokens.get(i - 1).is("==") || tokens.get(i - 1).is("!="))) {
                    other = operand(tokens, i - 2, false);
                }
                String value = other == null ? null : kotlinConstant(code, other, constants);
                if (value != null) {
                    out.add(promptRead(unit.platform, property, value, "compared", Kotlin.where(unit, i)));
                }
            }
        }
        return out;
    }

    /** The tokens of a comparison's other operand: a literal, a name, or a dotted name. */
    private static List<Kotlin.Token> operand(List<Kotlin.Token> tokens, int at, boolean forward) {
        if (at < 0 || at >= tokens.size()) {
            return null;
        }
        if (forward) {
            int end = at;
            while (end + 2 < tokens.size() && tokens.get(end + 1).is(".") && tokens.get(end + 2).kind == Kotlin.Kind.IDENT) {
                end += 2;
            }
            return tokens.subList(at, end + 1);
        }
        int start = at;
        while (start - 2 >= 0 && tokens.get(start - 1).is(".") && tokens.get(start - 2).kind == Kotlin.Kind.IDENT) {
            start -= 2;
        }
        return tokens.subList(start, at + 1);
    }

    /** A Kotlin operand's constant string: a literal, a `const val` of the file, or a Java constant `Type.NAME`. */
    private static String kotlinConstant(Code code, List<Kotlin.Token> operand, Map<String, String> constants) {
        if (operand.size() == 1 && operand.get(0).kind == Kotlin.Kind.STRING) {
            return operand.get(0).text;
        }
        if (operand.size() == 1 && constants.containsKey(operand.get(0).text)) {
            return constants.get(operand.get(0).text);
        }
        if (operand.size() == 3 && operand.get(1).is(".")) {
            return code.constant(new FieldAccessExpr(new NameExpr(operand.get(0).text), operand.get(2).text), null);
        }
        return null;
    }

    /** `getInput()` / `getAppearance()` on a value declared `QueryPrompt`: "input" or "appearance". */
    private static String promptProperty(Expression expression) {
        if (!(expression instanceof MethodCallExpr) || !((MethodCallExpr) expression).getArguments().isEmpty()
                || !((MethodCallExpr) expression).getScope().isPresent()) {
            return null;
        }
        MethodCallExpr call = (MethodCallExpr) expression;
        String property = call.getNameAsString().equals("getInput") ? "input"
                : call.getNameAsString().equals("getAppearance") ? "appearance" : null;
        if (property == null || !(unwrap(call.getScope().get()) instanceof NameExpr)) {
            return null;
        }
        String holder = ((NameExpr) unwrap(call.getScope().get())).getNameAsString();
        Node current = call.getParentNode().orElse(null);
        while (current != null) {
            if (current instanceof CallableDeclaration) {
                for (Parameter parameter : ((CallableDeclaration<?>) current).getParameters()) {
                    if (parameter.getNameAsString().equals(holder)) {
                        return parameter.getType().asString().equals("QueryPrompt") ? property : null;
                    }
                }
                for (VariableDeclarator local : current.findAll(VariableDeclarator.class)) {
                    if (local.getNameAsString().equals(holder)) {
                        return local.getType().asString().equals("QueryPrompt") ? property : null;
                    }
                }
            }
            if (current instanceof ForEachStmt
                    && ((ForEachStmt) current).getVariable().getVariables().get(0).getNameAsString().equals(holder)) {
                return ((ForEachStmt) current).getVariable().getElementType().asString().equals("QueryPrompt") ? property : null;
            }
            current = current.getParentNode().orElse(null);
        }
        return null;
    }

    private static Map<String, Object> promptRead(String reader, String property, String value, String how, String at) {
        Map<String, Object> read = new TreeMap<>();
        read.put("reader", reader);
        read.put("property", property);
        read.put("value", value);
        read.put("how", how);
        read.put("at", at);
        return read;
    }
}
