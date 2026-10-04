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
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.SuperExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.expr.UnaryExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
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
import com.github.javaparser.ast.stmt.SynchronizedStmt;
import com.github.javaparser.ast.stmt.ThrowStmt;
import com.github.javaparser.ast.stmt.TryStmt;
import com.github.javaparser.ast.stmt.WhileStmt;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * The suite and profile parsers Core and Android install an app with: every element each parser
 * checks, every attribute it reads and on which element, and which parser reads each child
 * element.
 *
 * The element the XML parser is on is followed through each parse method in order: `checkNode(X)`
 * puts it on X, `nextTagInBlock(X)` on some child of X ("X/*"), `nextTag(X)` on X,
 * `parser.nextTag()` on a child of the current element, and a branch that tests the current
 * element's name (`"x".equals(parser.getName())`, `.toLowerCase()`, `equalsIgnoreCase`, a
 * `switch` on it, or a local or parameter holding it) on that element. A guard that leaves the
 * method unless the name is one of several (`if (!"a".equals(name) && !"b".equals(name)) throw`)
 * leaves it on one of those. A call to one of the parser's own methods carries the current element
 * into it, with the element's name and any string constant passed to its parameters
 * (`parseFunction("x")` checks node `x`); a call to an own helper that only moves the XML parser
 * (`nextStartTag()`) leaves it past the current element. A call to a static method of another class
 * that is handed the XML parser (`ParseInstance.parseInstance(instances, parser)`) reads from where
 * the caller is. A parser that reads every attribute by position (`getAttributeValue(i)`, a
 * fixture's tree elements) is marked so.
 *
 * A child parser reads where its method is called, not where it is constructed: `new
 * X(parser).parse()`, a factory's product called at once, a local or a field holding a parser, and
 * a parser handed to another parser's constructor and read through that parser's field. A parser
 * entered on an element its caller does not name (a child of X, or one of several) is put on the
 * element its own parse names before it moves: the node it checks, the block it reads, or the
 * names it tests. An attribute read while the parser is on one of several elements is read on each
 * of them.
 *
 * The parsers are those the installers construct and every parser those reach.
 */
final class Parsers {
    /** The ElementParser methods that move the XML parser. */
    private static final Set<String> MOVES = Set.of("nextTag", "next", "nextText", "nextTagInBlock",
            "getNextTagInBlock", "skipBlock", "nextNonWhitespace");

    private final Code code;
    private final Map<String, Map<String, Object>> parsers = new TreeMap<>();
    private final Set<String> analysed = new HashSet<>();
    /** Parsers still to read, each {parser, element, method, arity}. */
    private final List<String[]> queue = new ArrayList<>();
    /** The parsers handed to each parser's constructor: {product, how it was made and by whom}. */
    private final Map<String, Set<List<String>>> handed = new TreeMap<>();
    /** Each attribute read, by where it is and the element it is read on: {parser, elements, attribute, place}
     * (ParserValues follows each value). */
    private final Map<String, Map<String, Object>> reads = new TreeMap<>();

    private Parsers(Code code) {
        this.code = code;
    }

    static Map<String, Object> read(Code code, List<String> installerDirectories) {
        Parsers reader = new Parsers(code);
        reader.collectHanded();
        Set<String> roots = new TreeSet<>();
        for (Code.Unit unit : code.units) {
            boolean installer = installerDirectories.stream().anyMatch(d -> unit.relative.contains("/" + d + "/"));
            if (!installer) {
                continue;
            }
            for (ObjectCreationExpr creation : unit.tree.findAll(ObjectCreationExpr.class)) {
                String name = creation.getType().getNameAsString();
                if (reader.isParser(name)) {
                    roots.add(name);
                }
            }
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                String built = reader.factoryProduct(call, Code.typeOf(call));
                if (built != null) {
                    roots.add(built);
                }
            }
        }
        for (String root : roots) {
            reader.queue.add(new String[]{root, "?", "parse", "0"});
        }
        while (!reader.queue.isEmpty()) {
            String[] next = reader.queue.remove(0);
            if (reader.analysed.add(String.join("@", next))) {
                reader.analyse(next[0], next[1], next[2], Integer.parseInt(next[3]));
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("roots", new ArrayList<>(roots));
        out.put("parsers", reader.parsers);
        out.put("reads", new ArrayList<>(reader.reads.values()));
        return out;
    }

    boolean isParser(String name) {
        TypeDeclaration<?> type = code.type(name);
        Set<String> seen = new HashSet<>();
        while (type != null && seen.add(type.getNameAsString())) {
            String parent = Code.superName(type);
            if (parent == null) {
                return false;
            }
            if (parent.equals("ElementParser")) {
                return true;
            }
            type = code.type(parent);
        }
        return false;
    }

    private boolean isSameOrSubclass(String name, String base) {
        Set<String> seen = new HashSet<>();
        String current = name;
        while (current != null && seen.add(current)) {
            if (current.equals(base)) {
                return true;
            }
            TypeDeclaration<?> type = code.type(current);
            current = type == null ? null : Code.superName(type);
        }
        return false;
    }

    /** The parser class a factory call returns: `X.buildY(...)` or an own `getXParser()`. */
    private String factoryProduct(MethodCallExpr call, TypeDeclaration<?> context) {
        List<CallableDeclaration<?>> targets = new ArrayList<>();
        if (call.getScope().isPresent() && call.getScope().get() instanceof NameExpr) {
            String owner = ((NameExpr) call.getScope().get()).getNameAsString();
            if (isParser(owner)) {
                targets.addAll(code.callables(code.type(owner), call.getNameAsString(), call.getArguments().size()));
            }
        } else if (context != null && (!call.getScope().isPresent() || call.getScope().get() instanceof ThisExpr)) {
            targets.addAll(code.callables(context, call.getNameAsString(), call.getArguments().size()));
        }
        for (CallableDeclaration<?> target : targets) {
            for (ReturnStmt returned : target.findAll(ReturnStmt.class)) {
                if (returned.getExpression().isPresent() && returned.getExpression().get() instanceof ObjectCreationExpr) {
                    String built = ((ObjectCreationExpr) returned.getExpression().get()).getType().getNameAsString();
                    if (isParser(built)) {
                        return built;
                    }
                }
            }
        }
        return null;
    }

    /** Each parser a subclass of `base` returns from its override of the factory method `name`. */
    private List<String[]> overrides(TypeDeclaration<?> base, String name, int arity) {
        List<String[]> found = new ArrayList<>();
        String baseName = base.getNameAsString();
        for (List<TypeDeclaration<?>> declarations : code.types.values()) {
            TypeDeclaration<?> candidate = declarations.get(0);
            if (!baseName.equals(Code.superName(candidate))) {
                continue;
            }
            for (MethodDeclaration method : candidate.getMethodsByName(name)) {
                if (method.getParameters().size() != arity || !overridesFactory(base, method)) {
                    continue;
                }
                for (ReturnStmt returned : method.findAll(ReturnStmt.class)) {
                    if (returned.getExpression().isPresent() && returned.getExpression().get() instanceof ObjectCreationExpr) {
                        String built = ((ObjectCreationExpr) returned.getExpression().get()).getType().getNameAsString();
                        if (isParser(built)) {
                            found.add(new String[]{built, candidate.getNameAsString() + "." + name});
                        }
                    }
                }
            }
        }
        return found;
    }

    private boolean overridesFactory(TypeDeclaration<?> base, MethodDeclaration method) {
        for (TypeDeclaration<?> type : code.lookupChain(base)) {
            if (!type.getMethodsBySignature(method.getNameAsString(),
                    method.getParameters().stream().map(p -> p.getType().asString()).toArray(String[]::new)).isEmpty()) {
                return true;
            }
        }
        return false;
    }

    /**
     * The parsers each parser's constructor is handed, made in place (`new X(parser, new Y(parser))`
     * or `new X(parser, getYParser())`, with every subclass override of the factory), wherever they
     * are made.
     */
    private void collectHanded() {
        for (Code.Unit unit : code.units) {
            for (ObjectCreationExpr creation : unit.tree.findAll(ObjectCreationExpr.class)) {
                String receiver = creation.getType().getNameAsString();
                if (!isParser(receiver)) {
                    continue;
                }
                TypeDeclaration<?> maker = Code.typeOf(creation);
                String by = maker == null ? "?" : maker.getNameAsString();
                for (Expression argument : creation.getArguments()) {
                    for (String[] product : products(argument, maker)) {
                        handed.computeIfAbsent(receiver, k -> new LinkedHashSet<>())
                                .add(List.of(product[0], product[1] + " in " + by));
                    }
                }
            }
        }
    }

    /** The parsers an expression makes where it stands: {class, how}. */
    private List<String[]> products(Expression expression, TypeDeclaration<?> context) {
        List<String[]> found = new ArrayList<>();
        if (expression instanceof ObjectCreationExpr) {
            String built = ((ObjectCreationExpr) expression).getType().getNameAsString();
            if (isParser(built)) {
                found.add(new String[]{built, "new"});
            }
        } else if (expression instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) expression;
            String built = factoryProduct(call, context);
            if (built != null) {
                found.add(new String[]{built, "factory " + call.getNameAsString()});
                boolean own = !call.getScope().isPresent() || call.getScope().get() instanceof ThisExpr;
                if (own && context != null) {
                    for (String[] override : overrides(context, call.getNameAsString(), call.getArguments().size())) {
                        found.add(new String[]{override[0], "override " + override[1]});
                    }
                }
            }
        }
        return found;
    }

    // -- one parser ---------------------------------------------------------------

    private Map<String, Object> entry(String name) {
        return parsers.computeIfAbsent(name, k -> {
            Map<String, Object> facts = new LinkedHashMap<>();
            TypeDeclaration<?> type = code.type(k);
            facts.put("at", code.where(type));
            facts.put("platform", code.unitOf(type).platform);
            facts.put("extends", Code.superName(type));
            facts.put("elements", new TreeMap<String, Object>());
            facts.put("attributes", new TreeMap<String, Object>());
            facts.put("children", new TreeMap<String, Object>());
            facts.put("readsAttributesByPosition", false);
            return facts;
        });
    }

    /** The parser whose facts are being read. */
    private TypeDeclaration<?> current;
    private String currentName;
    /** The class whose code is being read: the parser, or a helper class it hands the XML parser to. */
    private TypeDeclaration<?> context;
    /** The (parser, class, method, element, names) combinations already read, so recursion ends. */
    private final Set<String> visited = new HashSet<>();

    private void analyse(String name, String element, String method, int arity) {
        TypeDeclaration<?> type = code.type(name);
        entry(name);
        CallableDeclaration<?> target = null;
        for (CallableDeclaration<?> callable : code.callables(type, method, arity)) {
            if (callable instanceof MethodDeclaration && ((MethodDeclaration) callable).getBody().isPresent()) {
                target = callable;
                break;
            }
        }
        if (target == null) {
            return;
        }
        // An inherited method is the facts of the parser that declares it.
        TypeDeclaration<?> declaring = Code.typeOf(target);
        String owner = declaring != null && isParser(declaring.getNameAsString()) ? declaring.getNameAsString() : name;
        entry(owner);
        current = code.type(owner);
        currentName = owner;
        context = current;
        String start = element;
        if (!concrete(element)) {
            List<String> own = entryNames(target);
            if (!own.isEmpty()) {
                start = String.join("|", new TreeSet<>(own));
            }
        }
        method(target, start, new Frame());
    }

    private static boolean concrete(String element) {
        return !element.contains("?") && !element.contains("/") && !element.contains("|");
    }

    /**
     * The elements a parse method names for the element it starts on, before it first moves the
     * XML parser: the node it checks, the block whose children it reads, or the names it tests.
     */
    private List<String> entryNames(CallableDeclaration<?> callable) {
        List<String> found = new ArrayList<>();
        if (!(callable instanceof MethodDeclaration) || !((MethodDeclaration) callable).getBody().isPresent()) {
            return found;
        }
        scanEntry(((MethodDeclaration) callable).getBody().get().getStatements(), new Frame(), found);
        return found;
    }

    /** Returns false once the scan reaches the first move. */
    private boolean scanEntry(List<Statement> statements, Frame frame, List<String> found) {
        for (Statement statement : statements) {
            if (statement instanceof IfStmt) {
                IfStmt branch = (IfStmt) statement;
                if (moves(branch.getCondition())) {
                    return false;
                }
                for (String[] test : nameTests(branch.getCondition(), frame, true)) {
                    found.add(test[0]);
                }
                continue;
            }
            if (statement instanceof SwitchStmt) {
                SwitchStmt choice = (SwitchStmt) statement;
                if (nameExpression(choice.getSelector(), frame) != null) {
                    for (SwitchEntry entry : choice.getEntries()) {
                        for (Expression label : entry.getLabels()) {
                            String value = constant(label, frame);
                            if (value != null) {
                                found.add(value);
                            }
                        }
                    }
                }
                return false;
            }
            if (statement instanceof TryStmt) {
                if (!scanEntry(((TryStmt) statement).getTryBlock().getStatements(), frame, found)) {
                    return false;
                }
                continue;
            }
            if (statement instanceof BlockStmt) {
                if (!scanEntry(((BlockStmt) statement).getStatements(), frame, found)) {
                    return false;
                }
                continue;
            }
            if (statement instanceof WhileStmt || statement instanceof ForStmt || statement instanceof DoStmt) {
                if (found.isEmpty()) {
                    for (MethodCallExpr call : statement.findAll(MethodCallExpr.class)) {
                        if ((call.getNameAsString().equals("nextTagInBlock") || call.getNameAsString().equals("getNextTagInBlock"))
                                && call.getArguments().size() == 1) {
                            String block = constant(call.getArgument(0), frame);
                            if (block != null) {
                                found.add(block);
                            }
                            break;
                        }
                    }
                }
                return false;
            }
            if (statement instanceof ReturnStmt || statement instanceof ThrowStmt) {
                return false;
            }
            for (MethodCallExpr call : statement.findAll(MethodCallExpr.class)) {
                if (call.getNameAsString().equals("checkNode") && call.getArguments().size() == 1) {
                    if (found.isEmpty()) {
                        found.addAll(elements(call.getArgument(0), frame));
                    }
                    return false;
                }
                if ((call.getNameAsString().equals("nextTagInBlock") || call.getNameAsString().equals("getNextTagInBlock"))
                        && call.getArguments().size() == 1) {
                    String block = constant(call.getArgument(0), frame);
                    if (block != null && found.isEmpty()) {
                        found.add(block);
                    }
                    return false;
                }
            }
            if (moves(statement)) {
                return false;
            }
            for (VariableDeclarator variable : statement.findAll(VariableDeclarator.class)) {
                variable.getInitializer().ifPresent(init -> {
                    String[] name = nameExpression(init, frame);
                    if (name != null) {
                        frame.names.put(variable.getNameAsString(), name[0].equals("lowercased"));
                    }
                });
            }
        }
        return true;
    }

    private static boolean moves(Node node) {
        for (MethodCallExpr call : node.findAll(MethodCallExpr.class)) {
            if (MOVES.contains(call.getNameAsString())) {
                return true;
            }
        }
        return false;
    }

    /** Reads a callable from `element`, with the locals holding the element's name and the parsers held. */
    private void method(CallableDeclaration<?> callable, String element, Frame frame) {
        TypeDeclaration<?> owner = Code.typeOf(callable);
        String key = currentName + ":" + (owner == null ? "?" : Code.qualifiedName(owner)) + "#"
                + callable.getDeclarationAsString(false, false, false) + "@" + element + frame.key();
        if (!visited.add(key)) {
            return;
        }
        Node body = callable instanceof MethodDeclaration ? ((MethodDeclaration) callable).getBody().orElse(null) : null;
        if (body != null) {
            statement((Statement) body, element, frame.copy());
        }
    }

    /** Runs a statement from `element`, returning the element the XML parser is on afterwards. */
    private String statement(Statement statement, String element, Frame frame) {
        if (statement instanceof BlockStmt) {
            String state = element;
            for (Statement inner : ((BlockStmt) statement).getStatements()) {
                state = statement(inner, state, frame);
            }
            return state;
        }
        if (statement instanceof ExpressionStmt) {
            return expression(((ExpressionStmt) statement).getExpression(), element, frame);
        }
        if (statement instanceof IfStmt) {
            IfStmt branch = (IfStmt) statement;
            String state = expression(branch.getCondition(), element, frame);
            List<String[]> tested = nameTests(branch.getCondition(), frame, false);
            if (tested.isEmpty()) {
                statement(branch.getThenStmt(), state, frame);
            } else {
                for (String[] test : tested) {
                    element(test[0], test[1]);
                    statement(branch.getThenStmt(), test[0], frame);
                }
            }
            branch.getElseStmt().ifPresent(other -> statement(other, state, frame));
            List<String[]> required = guard(branch, frame);
            if (!required.isEmpty()) {
                Set<String> allowed = new TreeSet<>();
                for (String[] test : required) {
                    element(test[0], test[1]);
                    allowed.add(test[0]);
                }
                return String.join("|", allowed);
            }
            return state;
        }
        if (statement instanceof WhileStmt) {
            String state = expression(((WhileStmt) statement).getCondition(), element, frame);
            statement(((WhileStmt) statement).getBody(), state, frame);
            return state;
        }
        if (statement instanceof DoStmt) {
            String state = statement(((DoStmt) statement).getBody(), element, frame);
            return expression(((DoStmt) statement).getCondition(), state, frame);
        }
        if (statement instanceof ForStmt) {
            ForStmt loop = (ForStmt) statement;
            String state = element;
            for (Expression initial : loop.getInitialization()) {
                state = expression(initial, state, frame);
            }
            if (loop.getCompare().isPresent()) {
                state = expression(loop.getCompare().get(), state, frame);
            }
            statement(loop.getBody(), state, frame);
            return state;
        }
        if (statement instanceof ForEachStmt) {
            statement(((ForEachStmt) statement).getBody(), element, frame);
            return element;
        }
        if (statement instanceof SwitchStmt) {
            SwitchStmt choice = (SwitchStmt) statement;
            String state = expression(choice.getSelector(), element, frame);
            String[] name = nameExpression(choice.getSelector(), frame);
            for (SwitchEntry entry : choice.getEntries()) {
                List<String> labels = new ArrayList<>();
                for (Expression label : entry.getLabels()) {
                    String value = constant(label, frame);
                    if (value != null) {
                        labels.add(value);
                    }
                }
                if (name != null && !labels.isEmpty()) {
                    for (String label : labels) {
                        element(label, name[0]);
                        run(entry.getStatements(), label, frame);
                    }
                } else {
                    run(entry.getStatements(), state, frame);
                }
            }
            return state;
        }
        if (statement instanceof TryStmt) {
            TryStmt attempt = (TryStmt) statement;
            String state = statement(attempt.getTryBlock(), element, frame);
            attempt.getCatchClauses().forEach(clause -> statement(clause.getBody(), element, frame));
            attempt.getFinallyBlock().ifPresent(block -> statement(block, element, frame));
            return state;
        }
        if (statement instanceof ReturnStmt) {
            ((ReturnStmt) statement).getExpression().ifPresent(e -> expression(e, element, frame));
            return element;
        }
        if (statement instanceof ThrowStmt) {
            expression(((ThrowStmt) statement).getExpression(), element, frame);
            return element;
        }
        if (statement instanceof LabeledStmt) {
            return statement(((LabeledStmt) statement).getStatement(), element, frame);
        }
        if (statement instanceof SynchronizedStmt) {
            return statement(((SynchronizedStmt) statement).getBody(), element, frame);
        }
        return element;
    }

    private void run(List<Statement> statements, String element, Frame frame) {
        String state = element;
        for (Statement statement : statements) {
            state = statement(statement, state, frame);
        }
    }

    /**
     * The names an `if` requires of the current element when it leaves the method otherwise: its
     * condition joins negated name tests with `&&`, it has no `else`, and its branch ends in a
     * `throw` or a `return`.
     */
    private List<String[]> guard(IfStmt branch, Frame frame) {
        List<String[]> found = new ArrayList<>();
        if (branch.getElseStmt().isPresent() || !exits(branch.getThenStmt())) {
            return found;
        }
        List<Expression> conjuncts = new ArrayList<>();
        conjuncts(branch.getCondition(), conjuncts);
        for (Expression conjunct : conjuncts) {
            Expression inner = unwrap(conjunct);
            if (!(inner instanceof UnaryExpr) || ((UnaryExpr) inner).getOperator() != UnaryExpr.Operator.LOGICAL_COMPLEMENT) {
                return new ArrayList<>();
            }
            List<String[]> tested = nameTests(((UnaryExpr) inner).getExpression(), frame, false);
            if (tested.size() != 1) {
                return new ArrayList<>();
            }
            found.add(tested.get(0));
        }
        return found;
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

    private static Expression unwrap(Expression expression) {
        Expression inner = expression;
        while (inner instanceof EnclosedExpr) {
            inner = ((EnclosedExpr) inner).getInner();
        }
        return inner;
    }

    private static boolean exits(Statement statement) {
        if (statement instanceof ThrowStmt || statement instanceof ReturnStmt) {
            return true;
        }
        if (statement instanceof BlockStmt) {
            List<Statement> inner = ((BlockStmt) statement).getStatements();
            return !inner.isEmpty() && exits(inner.get(inner.size() - 1));
        }
        return false;
    }

    /** Evaluates an expression's calls in order, returning the element the XML parser is on afterwards. */
    private String expression(Expression expression, String element, Frame frame) {
        String[] state = {element};
        List<Node> ordered = new ArrayList<>();
        collectPostOrder(expression, ordered);
        for (Node node : ordered) {
            if (node instanceof VariableDeclarator) {
                VariableDeclarator variable = (VariableDeclarator) node;
                variable.getInitializer().ifPresent(init -> bind(variable.getNameAsString(), init, frame));
            } else if (node instanceof AssignExpr) {
                AssignExpr assign = (AssignExpr) node;
                if (assign.getTarget() instanceof NameExpr) {
                    bind(((NameExpr) assign.getTarget()).getNameAsString(), assign.getValue(), frame);
                }
            } else if (node instanceof MethodCallExpr) {
                state[0] = call((MethodCallExpr) node, state[0], frame);
            }
        }
        return state[0];
    }

    /** Records what a local now holds: the current element's name, or parsers made where it is bound. */
    private void bind(String local, Expression value, Frame frame) {
        String[] name = nameExpression(value, frame);
        if (name != null) {
            frame.names.put(local, name[0].equals("lowercased"));
        }
        List<String[]> made = products(unwrap(value), context);
        if (!made.isEmpty()) {
            frame.holders.put(local, made);
        }
    }

    private static void collectPostOrder(Node node, List<Node> out) {
        if (node instanceof LambdaExpr) {
            return;
        }
        for (Node child : node.getChildNodes()) {
            collectPostOrder(child, out);
        }
        out.add(node);
    }

    private String call(MethodCallExpr call, String element, Frame frame) {
        String name = call.getNameAsString();
        Expression scope = call.getScope().orElse(null);
        boolean own = scope == null || scope instanceof ThisExpr || scope instanceof SuperExpr;
        if (own && name.equals("checkNode") && call.getArguments().size() == 1) {
            List<String> checked = elements(call.getArgument(0), frame);
            for (String value : checked) {
                element(value, "exact");
            }
            return checked.isEmpty() ? "?" : String.join("|", new TreeSet<>(checked));
        }
        if (own && (name.equals("nextTagInBlock") || name.equals("getNextTagInBlock")) && call.getArguments().size() == 1) {
            String block = constant(call.getArgument(0), frame);
            if (block == null && nameExpression(call.getArgument(0), frame) != null && concrete(element)) {
                // The block named by the current element's own name is the current element.
                block = element;
            }
            if (block != null) {
                element(block, "exact");
                return block + "/*";
            }
            return "?";
        }
        if (own && name.equals("nextTag") && call.getArguments().size() == 1) {
            String next = constant(call.getArgument(0), frame);
            if (next != null) {
                element(next, "exact");
                return next;
            }
            return "?";
        }
        if (!own && (name.equals("nextTag") || name.equals("next")) && call.getArguments().isEmpty()) {
            return concrete(element) ? element + "/*" : "?";
        }
        if ((name.equals("getAttributeValue") || name.equals("getAttributeName")) && call.getArguments().size() == 1) {
            // Every attribute, read by position (a fixture's tree elements).
            entry(currentName).put("readsAttributesByPosition", true);
            return element;
        }
        if (name.equals("getAttributeValue") && call.getArguments().size() == 2) {
            String attribute = constant(call.getArgument(1), frame);
            attribute(element, attribute == null ? "<" + call.getArgument(1) + ">" : attribute);
            if (attribute != null) {
                read(call, element, attribute);
            }
            return element;
        }
        // A parser's method called where it is made: `new X(parser).parse()`, `getXParser().parse()`.
        if (scope != null) {
            List<String[]> made = products(unwrap(scope), context);
            if (!made.isEmpty()) {
                for (String[] product : made) {
                    child(product[0], element, product[1], name, call.getArguments().size());
                }
                return element;
            }
        }
        // A parser's method called through a local or a field holding it.
        if (scope instanceof NameExpr || (scope instanceof FieldAccessExpr
                && ((FieldAccessExpr) scope).getScope() instanceof ThisExpr)) {
            String holder = scope instanceof NameExpr ? ((NameExpr) scope).getNameAsString()
                    : ((FieldAccessExpr) scope).getNameAsString();
            if (scope instanceof NameExpr && frame.holders.containsKey(holder)) {
                for (String[] product : frame.holders.get(holder)) {
                    child(product[0], element, product[1], name, call.getArguments().size());
                }
                return element;
            }
            String declared = fieldType(holder);
            if (declared != null && isParser(declared)) {
                boolean any = false;
                for (List<String> product : handed.getOrDefault(currentName, Set.of())) {
                    if (isSameOrSubclass(product.get(0), declared)) {
                        child(product.get(0), element, "field " + holder + ", " + product.get(1), name,
                                call.getArguments().size());
                        any = true;
                    }
                }
                if (!any) {
                    child(declared, element, "field " + holder, name, call.getArguments().size());
                }
                return element;
            }
        }
        if (own) {
            TypeDeclaration<?> lookup = scope instanceof SuperExpr ? superOf(context) : context;
            boolean moved = false;
            for (CallableDeclaration<?> target : code.callables(lookup, name, call.getArguments().size())) {
                method(target, element, frame.into(target, call, this));
                moved |= movesXmlParser(target);
            }
            // A helper that only moves the XML parser (`nextStartTag()`) leaves it past the current element.
            return moved ? (concrete(element) ? element + "/*" : "?") : element;
        }
        // A static method of another class handed the XML parser reads it where the caller is.
        if (scope instanceof NameExpr && handsXmlParser(call)) {
            TypeDeclaration<?> helper = code.type(((NameExpr) scope).getNameAsString());
            if (helper != null && !isParser(helper.getNameAsString())) {
                TypeDeclaration<?> saved = context;
                context = helper;
                try {
                    for (CallableDeclaration<?> target : code.callables(helper, name, call.getArguments().size())) {
                        if (target.isStatic()) {
                            method(target, element, frame.into(target, call, this));
                        }
                    }
                } finally {
                    context = saved;
                }
            }
        }
        return element;
    }

    /**
     * Whether an own method only moves the XML parser: it calls the parser's `nextTag` or `next`
     * and checks no node and reads no attribute of its own.
     */
    private static boolean movesXmlParser(CallableDeclaration<?> target) {
        boolean moves = false;
        for (MethodCallExpr inner : target.findAll(MethodCallExpr.class)) {
            String called = inner.getNameAsString();
            boolean onParser = inner.getScope().isPresent() && !(inner.getScope().get() instanceof ThisExpr);
            if (onParser && (called.equals("nextTag") || called.equals("next")) && inner.getArguments().isEmpty()) {
                moves = true;
            }
            if (called.equals("checkNode") || called.equals("getAttributeValue") || called.equals("nextTagInBlock")
                    || called.equals("getNextTagInBlock")) {
                return false;
            }
        }
        return moves;
    }

    private TypeDeclaration<?> superOf(TypeDeclaration<?> type) {
        String parent = type == null ? null : Code.superName(type);
        return parent == null ? null : code.type(parent);
    }

    /** Whether a call hands the XML parser (a field, parameter or local declared KXmlParser) to its callee. */
    private boolean handsXmlParser(MethodCallExpr call) {
        for (Expression argument : call.getArguments()) {
            Expression inner = unwrap(argument);
            String type = null;
            if (inner instanceof NameExpr) {
                type = declaredType(call, ((NameExpr) inner).getNameAsString());
            } else if (inner instanceof FieldAccessExpr && ((FieldAccessExpr) inner).getScope() instanceof ThisExpr) {
                type = fieldType(((FieldAccessExpr) inner).getNameAsString());
            }
            if (type != null && (type.equals("KXmlParser") || type.equals("XmlPullParser"))) {
                return true;
            }
        }
        return false;
    }

    /** The simple type a name is declared with where `at` stands: a local, a parameter, or a field. */
    private String declaredType(Node at, String name) {
        Node current = at.getParentNode().orElse(null);
        while (current != null && !(current instanceof TypeDeclaration)) {
            if (current instanceof CallableDeclaration) {
                for (Parameter parameter : ((CallableDeclaration<?>) current).getParameters()) {
                    if (parameter.getNameAsString().equals(name)) {
                        return simple(parameter.getType().asString());
                    }
                }
                for (VariableDeclarator local : current.findAll(VariableDeclarator.class)) {
                    if (local.getNameAsString().equals(name)) {
                        return simple(local.getType().asString());
                    }
                }
                break;
            }
            current = current.getParentNode().orElse(null);
        }
        return fieldType(name);
    }

    private String fieldType(String name) {
        VariableDeclarator field = code.field(context, name);
        return field == null ? null : simple(field.getType().asString());
    }

    private static String simple(String type) {
        String bare = type.contains("<") ? type.substring(0, type.indexOf('<')) : type;
        return bare.substring(bare.lastIndexOf('.') + 1);
    }

    private List<String> elements(Expression argument, Frame frame) {
        List<String> found = new ArrayList<>();
        Expression inner = argument;
        if (inner instanceof ArrayCreationExpr && ((ArrayCreationExpr) inner).getInitializer().isPresent()) {
            inner = ((ArrayCreationExpr) inner).getInitializer().get();
        }
        if (inner instanceof ArrayInitializerExpr) {
            for (Expression value : ((ArrayInitializerExpr) inner).getValues()) {
                String text = constant(value, frame);
                if (text != null) {
                    found.add(text);
                }
            }
        } else {
            String text = constant(inner, frame);
            if (text != null) {
                found.add(text);
            }
        }
        return found;
    }

    /**
     * The element names a condition tests the current element for, each with how it matches:
     * "exact", "lowercased" (the name is lowercased before an exact compare) or "ignore-case". With
     * `negated`, the names inside a `!` count too (the entry scan reads every name tested).
     */
    private List<String[]> nameTests(Expression condition, Frame frame, boolean negated) {
        List<String[]> found = new ArrayList<>();
        Expression inner = unwrap(condition);
        if (inner instanceof BinaryExpr) {
            BinaryExpr binary = (BinaryExpr) inner;
            if (binary.getOperator() == BinaryExpr.Operator.OR || binary.getOperator() == BinaryExpr.Operator.AND) {
                found.addAll(nameTests(binary.getLeft(), frame, negated));
                found.addAll(nameTests(binary.getRight(), frame, negated));
            }
            return found;
        }
        if (inner instanceof UnaryExpr) {
            UnaryExpr unary = (UnaryExpr) inner;
            if (negated && unary.getOperator() == UnaryExpr.Operator.LOGICAL_COMPLEMENT) {
                return nameTests(unary.getExpression(), frame, true);
            }
            return found;
        }
        if (!(inner instanceof MethodCallExpr)) {
            return found;
        }
        MethodCallExpr call = (MethodCallExpr) inner;
        String method = call.getNameAsString();
        if (!(method.equals("equals") || method.equals("equalsIgnoreCase") || method.equals("contentEquals"))
                || call.getArguments().size() != 1 || !call.getScope().isPresent()) {
            return found;
        }
        Expression left = call.getScope().get();
        Expression right = call.getArgument(0);
        String[] name = nameExpression(left, frame);
        String value = constant(right, frame);
        if (name == null) {
            name = nameExpression(right, frame);
            value = constant(left, frame);
        }
        if (name != null && value != null) {
            found.add(new String[]{value, method.equals("equalsIgnoreCase") ? "ignore-case" : name[0]});
        }
        return found;
    }

    /** Whether an expression is the current element's name: ["exact"] or ["lowercased"], else null. */
    private String[] nameExpression(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (inner instanceof NameExpr && frame.names.containsKey(((NameExpr) inner).getNameAsString())) {
            return new String[]{frame.names.get(((NameExpr) inner).getNameAsString()) ? "lowercased" : "exact"};
        }
        if (inner instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) inner;
            if (call.getNameAsString().equals("getName") && call.getArguments().isEmpty()) {
                return new String[]{"exact"};
            }
            if (call.getNameAsString().equals("toLowerCase") && call.getScope().isPresent()) {
                String[] name = nameExpression(call.getScope().get(), frame);
                return name == null ? null : new String[]{"lowercased"};
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private void element(String name, String match) {
        Map<String, Object> elements = (Map<String, Object>) entry(currentName).get("elements");
        Set<String> matches = (Set<String>) elements.computeIfAbsent(name, k -> new TreeSet<String>());
        matches.add(match);
    }

    /** Records an attribute read on the element the XML parser is on, or on each of several. */
    @SuppressWarnings("unchecked")
    private void attribute(String element, String attribute) {
        Map<String, Object> attributes = (Map<String, Object>) entry(currentName).get("attributes");
        Set<String> on = (Set<String>) attributes.computeIfAbsent(attribute, k -> new TreeSet<String>());
        if (element.contains("|") && !element.contains("/")) {
            for (String one : element.split("\\|")) {
                on.add(one);
            }
        } else {
            on.add(element);
        }
    }

    /** Records where an attribute read is, so the value it reads can be followed (ParserValues). */
    private void read(MethodCallExpr call, String element, String attribute) {
        String place = ParserValues.place(code, call);
        if (place == null) {
            return;
        }
        List<String> on = element.contains("|") && !element.contains("/") ? List.of(element.split("\\|"))
                : List.of(element);
        Map<String, Object> read = new LinkedHashMap<>();
        read.put("parser", currentName);
        read.put("elements", new ArrayList<>(new TreeSet<>(on)));
        read.put("attribute", attribute);
        read.put("place", place);
        reads.put(currentName + "@" + attribute + "@" + String.join("|", on) + "@" + place, read);
    }

    /** Records that `parser`'s method reads the element the caller is on, and queues it. */
    @SuppressWarnings("unchecked")
    private void child(String parser, String element, String via, String method, int arity) {
        Map<String, Object> children = (Map<String, Object>) entry(currentName).get("children");
        Set<String> at = (Set<String>) children.computeIfAbsent(parser, k -> new LinkedHashSet<String>());
        at.add(element + " (" + via + ")");
        queue.add(new String[]{parser, element, method, String.valueOf(arity)});
    }

    /**
     * What a method's locals and parameters hold: the current element's name (true when
     * lowercased), parsers made where they were bound, and string constants passed as arguments.
     */
    static final class Frame {
        final Map<String, Boolean> names = new HashMap<>();
        final Map<String, List<String[]>> holders = new HashMap<>();
        final Map<String, String> values = new HashMap<>();

        Frame copy() {
            Frame out = new Frame();
            out.names.putAll(names);
            out.holders.putAll(holders);
            out.values.putAll(values);
            return out;
        }

        String key() {
            Map<String, Object> described = new TreeMap<>();
            described.put("names", new TreeMap<>(names));
            described.put("holders", new TreeSet<>(holders.keySet()));
            described.put("values", new TreeMap<>(values));
            return described.toString();
        }

        /** What a callee's parameters hold from the caller's arguments. */
        Frame into(CallableDeclaration<?> target, MethodCallExpr call, Parsers reader) {
            Frame callee = new Frame();
            List<Parameter> parameters = target.getParameters();
            for (int i = 0; i < parameters.size() && i < call.getArguments().size(); i++) {
                String parameter = parameters.get(i).getNameAsString();
                Expression argument = unwrap(call.getArgument(i));
                String[] name = reader.nameExpression(argument, this);
                if (name != null) {
                    callee.names.put(parameter, name[0].equals("lowercased"));
                }
                if (argument instanceof NameExpr && holders.containsKey(((NameExpr) argument).getNameAsString())) {
                    callee.holders.put(parameter, holders.get(((NameExpr) argument).getNameAsString()));
                }
                String value = reader.constant(argument, this);
                if (value != null) {
                    callee.values.put(parameter, value);
                }
            }
            return callee;
        }
    }

    /** The string an expression always has here: a constant, or a parameter passed one. */
    private String constant(Expression expression, Frame frame) {
        Expression inner = unwrap(expression);
        if (frame != null && inner instanceof NameExpr && frame.values.containsKey(((NameExpr) inner).getNameAsString())) {
            return frame.values.get(((NameExpr) inner).getNameAsString());
        }
        return code.constant(inner, context);
    }

    /** The parsers' facts as plain JSON values (sets become sorted lists). */
    @SuppressWarnings("unchecked")
    static Object plain(Object value) {
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
        if (value instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object element : (List<Object>) value) {
                out.add(plain(element));
            }
            return out;
        }
        return value;
    }
}
