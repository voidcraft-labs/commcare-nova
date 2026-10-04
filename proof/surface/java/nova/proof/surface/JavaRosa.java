package nova.proof.surface;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.stmt.Statement;
import com.github.javaparser.ast.stmt.SwitchEntry;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * JavaRosa's XForm vocabulary: the XPath functions Core's parser builds, the XForm parser's
 * type, handler and action tables and action events (by reflection over Core's compiled classes,
 * with each handler's behaviour read from its source), and the handlers and extension parsers
 * Android adds.
 */
final class JavaRosa {
    private JavaRosa() {
    }

    static Map<String, Object> read(Code code) throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("functions", functions(code));
        Class<?> parser = Class.forName("org.javarosa.xform.parse.XFormParser");
        Map<String, Object> typeMappings = new TreeMap<>();
        Map<Integer, List<String>> datatypes = constantNames("org.javarosa.core.model.Constants", "DATATYPE_");
        for (Map.Entry<String, Integer> entry : staticTable(parser, "typeMappings", Integer.class).entrySet()) {
            typeMappings.put(entry.getKey(), datatypes.getOrDefault(entry.getValue(), List.of(String.valueOf(entry.getValue()))));
        }
        out.put("types", typeMappings);
        Map<String, Map<String, Map<String, Object>>> behaviour = handlerBehaviour(code);
        Map<String, Map<String, Object>> group = behaviour.getOrDefault("groupLevelHandlers", Map.of());
        Map<String, Map<String, Object>> top = new TreeMap<>(group);
        top.putAll(behaviour.getOrDefault("topLevelHandlers", Map.of()));
        out.put("groupHandlers", handlers(staticTable(parser, "groupLevelHandlers", Object.class), group));
        out.put("topHandlers", handlers(staticTable(parser, "topLevelHandlers", Object.class), top));
        out.put("actionHandlers", handlers(staticTable(parser, "actionHandlers", Object.class),
                behaviour.getOrDefault("actionHandlers", Map.of())));
        Class<?> action = Class.forName("org.javarosa.core.model.actions.Action");
        Field events = action.getDeclaredField("allEvents");
        events.setAccessible(true);
        List<String> eventNames = new ArrayList<>();
        for (String event : (String[]) events.get(null)) {
            eventNames.add(event);
        }
        out.put("events", eventNames);
        out.put("android", androidRegistrations(code));
        return out;
    }

    /** Each case label of ASTNodeFunctionCall.buildFuncExpr with the class it builds. */
    private static List<Object> functions(Code code) throws Exception {
        TypeDeclaration<?> type = code.type("ASTNodeFunctionCall");
        if (type == null) {
            throw new IllegalStateException("Core's ASTNodeFunctionCall is not among the parsed sources.");
        }
        MethodDeclaration build = type.getMethodsByName("buildFuncExpr").stream().findFirst()
                .orElseThrow(() -> new IllegalStateException("ASTNodeFunctionCall has no buildFuncExpr."));
        List<Object> found = new ArrayList<>();
        List<String> pending = new ArrayList<>();
        for (SwitchEntry entry : build.findAll(SwitchEntry.class)) {
            for (Expression label : entry.getLabels()) {
                String name = code.constant(label, type);
                if (name == null) {
                    throw new IllegalStateException("buildFuncExpr has a case label " + label + " that is not a string.");
                }
                pending.add(name);
            }
            String built = null;
            for (Statement statement : entry.getStatements()) {
                for (ReturnStmt returned : statement.findAll(ReturnStmt.class)) {
                    for (ObjectCreationExpr creation : returned.findAll(ObjectCreationExpr.class)) {
                        built = creation.getType().getNameAsString();
                        break;
                    }
                    if (built != null) {
                        break;
                    }
                }
                if (built != null) {
                    break;
                }
            }
            if (built == null && entry.getStatements().isEmpty()) {
                // A label with no statements falls through to the next one.
                continue;
            }
            for (String name : pending) {
                Map<String, Object> function = new LinkedHashMap<>();
                function.put("name", name);
                function.put("class", built);
                function.put("acceptedArgCounts", acceptedArgCounts(name, built));
                found.add(function);
            }
            pending.clear();
        }
        return found;
    }

    /** The largest argument count the surface asks Core's parser about. */
    static final int MOST_ARGUMENTS = 12;

    /**
     * The argument counts, from none to {@link #MOST_ARGUMENTS}, with which Core's own XPath parser
     * builds a call of `name` as `built`: the constructor checks the count
     * (`XPathFuncExpr.validateArgCount`, or the class's own override), so a count the function
     * refuses does not parse.
     */
    static List<Integer> acceptedArgCounts(String name, String built) {
        List<Integer> accepted = new ArrayList<>();
        for (int count = 0; count <= MOST_ARGUMENTS; count++) {
            String call = name + "(" + String.join(",", java.util.Collections.nCopies(count, "1")) + ")";
            try {
                Object expression = org.javarosa.xpath.XPathParseTool.parseXPath(call);
                if (expression.getClass().getSimpleName().equals(built)) {
                    accepted.add(count);
                }
            } catch (Exception refused) {
                // Core refuses the call with this many arguments.
            }
        }
        return accepted;
    }

    @SuppressWarnings("unchecked")
    private static <V> Map<String, V> staticTable(Class<?> owner, String name, Class<V> valueType) throws Exception {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        Map<String, V> sorted = new TreeMap<>();
        for (Map.Entry<Object, Object> entry : ((Hashtable<Object, Object>) field.get(null)).entrySet()) {
            sorted.put((String) entry.getKey(), valueType.cast(entry.getValue()));
        }
        return sorted;
    }

    private static Map<Integer, List<String>> constantNames(String className, String prefix) throws Exception {
        Map<Integer, List<String>> names = new TreeMap<>();
        for (Field field : Class.forName(className).getDeclaredFields()) {
            if (Modifier.isStatic(field.getModifiers()) && field.getType() == int.class
                    && field.getName().startsWith(prefix)) {
                field.setAccessible(true);
                names.computeIfAbsent(field.getInt(null), k -> new ArrayList<>()).add(field.getName());
            }
        }
        for (List<String> list : names.values()) {
            list.sort(null);
        }
        return names;
    }

    /**
     * What each handler XFormParser registers does, read from its source: for a lambda bound to a
     * local and put under a key, the parser method it calls and the constants it passes; for a
     * `registerActionHandler(KEY, X.getHandler())`, the action class.
     */
    private static Map<String, Map<String, Map<String, Object>>> handlerBehaviour(Code code) {
        TypeDeclaration<?> type = code.type("XFormParser");
        Map<String, Map<String, Map<String, Object>>> found = new TreeMap<>();
        for (MethodDeclaration method : type.getMethods()) {
            Map<String, Map<String, Object>> lambdas = new LinkedHashMap<>();
            for (VariableDeclarator variable : method.findAll(VariableDeclarator.class)) {
                if (variable.getInitializer().isPresent() && variable.getInitializer().get() instanceof LambdaExpr) {
                    LambdaExpr lambda = (LambdaExpr) variable.getInitializer().get();
                    Map<String, Object> behaviour = new LinkedHashMap<>();
                    List<String> constants = new ArrayList<>();
                    for (MethodCallExpr call : lambda.findAll(MethodCallExpr.class)) {
                        if (!behaviour.containsKey("calls")) {
                            behaviour.put("calls", call.getNameAsString());
                        }
                        for (Expression argument : call.getArguments()) {
                            if (argument instanceof FieldAccessExpr || (argument instanceof NameExpr
                                    && ((NameExpr) argument).getNameAsString().toUpperCase().equals(((NameExpr) argument).getNameAsString()))) {
                                constants.add(argument.toString());
                            }
                        }
                    }
                    behaviour.put("passes", constants);
                    lambdas.put(variable.getNameAsString(), behaviour);
                }
            }
            for (MethodCallExpr call : method.findAll(MethodCallExpr.class)) {
                String name = call.getNameAsString();
                String table = name.equals("registerActionHandler") ? "actionHandlers"
                        : name.equals("put") && call.getScope().isPresent() ? call.getScope().get().toString() : null;
                if (table != null && call.getArguments().size() == 2) {
                    String key = code.constant(call.getArgument(0), type);
                    Expression value = call.getArgument(1);
                    if (key == null) {
                        continue;
                    }
                    Map<String, Map<String, Object>> tableBehaviour = found.computeIfAbsent(table, k -> new TreeMap<>());
                    if (value instanceof NameExpr && lambdas.containsKey(((NameExpr) value).getNameAsString())) {
                        tableBehaviour.put(key, lambdas.get(((NameExpr) value).getNameAsString()));
                    } else if (value instanceof MethodCallExpr && ((MethodCallExpr) value).getScope().isPresent()) {
                        Map<String, Object> behaviour = new LinkedHashMap<>();
                        behaviour.put("handler", ((MethodCallExpr) value).getScope().get().toString());
                        tableBehaviour.put(key, behaviour);
                    }
                }
            }
        }
        return found;
    }

    private static Map<String, Object> handlers(Map<String, Object> table, Map<String, Map<String, Object>> behaviour) {
        Map<String, Object> out = new TreeMap<>();
        for (String key : table.keySet()) {
            out.put(key, behaviour.getOrDefault(key, Map.of()));
        }
        return out;
    }

    /** The registrations Android adds to XFormParser, and the extension parsers it passes. */
    static List<Object> androidRegistrations(Code code) {
        List<Object> found = new ArrayList<>();
        for (Code.Unit unit : code.units) {
            if (!unit.platform.equals("android")) {
                continue;
            }
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                String name = call.getNameAsString();
                boolean onParser = call.getScope().map(s -> s.toString().equals("XFormParser")).orElse(false);
                if (onParser && (name.equals("registerHandler") || name.equals("registerActionHandler")
                        || name.equals("registerControlType") || name.equals("addDataType"))
                        && !call.getArguments().isEmpty()) {
                    Map<String, Object> registration = new LinkedHashMap<>();
                    registration.put("registers", name);
                    registration.put("key", code.constant(call.getArgument(0), Code.typeOf(call)));
                    registration.put("keyExpression", call.getArgument(0).toString());
                    registration.put("value", call.getArguments().size() > 1 ? handlerName(call.getArgument(1)) : null);
                    registration.put("at", code.where(call));
                    found.add(registration);
                }
            }
            for (MethodDeclaration method : unit.tree.findAll(MethodDeclaration.class)) {
                if (!method.getNameAsString().equals("getAllAndroidExtensionParsers")) {
                    continue;
                }
                for (ObjectCreationExpr creation : method.findAll(ObjectCreationExpr.class)) {
                    String created = creation.getType().getNameAsString();
                    if (created.endsWith("Parser")) {
                        Map<String, Object> registration = new LinkedHashMap<>();
                        registration.put("registers", "extensionParser");
                        registration.put("key", null);
                        registration.put("keyExpression", null);
                        registration.put("value", created);
                        registration.put("at", code.where(creation));
                        found.add(registration);
                    }
                }
            }
        }
        return found;
    }

    private static String handlerName(Expression value) {
        if (value instanceof ObjectCreationExpr) {
            return ((ObjectCreationExpr) value).getType().getNameAsString();
        }
        return value.toString();
    }

    /**
     * The attributes each extension parser reads, by the element it reads them on. A parser reads
     * the element it is registered for (`registerHandler("intent", ...)`, `registerActionHandler`,
     * or the `setElementName(...)` of a question extension parser) through its handler's `Element`
     * parameter, and that element's children through a local taken from `getChild`, named by the
     * `getName().equals(...)` test around the read (`intent/extra`). An attribute in a namespace
     * is written `{namespace}name`.
     */
    static Map<String, Object> extensionParsers(Code code, List<Map<String, Object>> registrations) {
        Map<String, Object> out = new TreeMap<>();
        for (Map<String, Object> registration : registrations) {
            String name = (String) registration.get("value");
            TypeDeclaration<?> type = code.type(name);
            if (type == null) {
                continue;
            }
            String element = (String) registration.get("key");
            if (element == null) {
                for (MethodCallExpr call : type.findAll(MethodCallExpr.class)) {
                    if (call.getNameAsString().equals("setElementName") && call.getArguments().size() == 1) {
                        element = code.constant(call.getArgument(0), type);
                    }
                }
            }
            if (element == null) {
                throw new IllegalStateException("The surface extractor could not tell which element the extension parser "
                        + name + " reads: it is registered without a name and sets none.");
            }
            Map<String, Set<String>> attributes = new TreeMap<>();
            for (MethodDeclaration method : type.getMethods()) {
                if (!method.getBody().isPresent()) {
                    continue;
                }
                // The handler's Element parameter is the element itself (path "").
                Map<String, String> paths = new HashMap<>();
                method.getParameters().forEach(parameter -> {
                    if (parameter.getType().asString().equals("Element")) {
                        paths.put(parameter.getNameAsString(), "");
                    }
                });
                if (paths.isEmpty()) {
                    continue;
                }
                readElements(code, type, method.getBody().get(), paths, attributes);
            }
            Map<String, Object> byElement = new TreeMap<>();
            for (Map.Entry<String, Set<String>> read : attributes.entrySet()) {
                String path = read.getKey().isEmpty() ? element : element + "/" + read.getKey();
                byElement.put(path, new ArrayList<>(read.getValue()));
            }
            Map<String, Object> facts = new LinkedHashMap<>();
            facts.put("element", element);
            facts.put("attributes", byElement);
            facts.put("at", code.where(type));
            out.put(name, facts);
        }
        return out;
    }

    /**
     * Reads a handler's statements with the path (relative to its element) each `Element` local
     * stands for, recording every `getAttributeValue(namespace, name)` on one of them.
     */
    private static void readElements(Code code, TypeDeclaration<?> type, Node node, Map<String, String> paths,
                                     Map<String, Set<String>> attributes) {
        if (node instanceof IfStmt) {
            IfStmt branch = (IfStmt) node;
            readElements(code, type, branch.getCondition(), paths, attributes);
            Map<String, String> inside = new HashMap<>(paths);
            for (MethodCallExpr test : branch.getCondition().findAll(MethodCallExpr.class)) {
                String[] named = namedChild(code, type, test, paths);
                if (named != null) {
                    inside.put(named[0], named[1]);
                }
            }
            readElements(code, type, branch.getThenStmt(), inside, attributes);
            branch.getElseStmt().ifPresent(other -> readElements(code, type, other, paths, attributes));
            return;
        }
        if (node instanceof VariableDeclarator) {
            VariableDeclarator variable = (VariableDeclarator) node;
            Expression init = variable.getInitializer().map(JavaRosa::uncast).orElse(null);
            if (init instanceof MethodCallExpr && ((MethodCallExpr) init).getNameAsString().equals("getChild")
                    && ((MethodCallExpr) init).getScope().isPresent()
                    && ((MethodCallExpr) init).getScope().get() instanceof NameExpr) {
                String parent = paths.get(((NameExpr) ((MethodCallExpr) init).getScope().get()).getNameAsString());
                if (parent != null) {
                    paths.put(variable.getNameAsString(), (parent.isEmpty() ? "" : parent + "/") + "*");
                }
            }
        }
        if (node instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) node;
            if (call.getNameAsString().equals("getAttributeValue") && call.getArguments().size() == 2
                    && call.getScope().isPresent() && call.getScope().get() instanceof NameExpr) {
                String path = paths.get(((NameExpr) call.getScope().get()).getNameAsString());
                if (path == null) {
                    throw new IllegalStateException("The extension parser " + type.getNameAsString() + " reads "
                            + call + " on something the surface extractor cannot tell is its element or a child of it.");
                }
                String attribute = code.constant(call.getArgument(1), type);
                if (attribute == null) {
                    throw new IllegalStateException("The extension parser " + type.getNameAsString() + " reads an attribute "
                            + "whose name the surface extractor cannot resolve: " + call);
                }
                Expression space = call.getArgument(0);
                String namespace = space instanceof com.github.javaparser.ast.expr.NullLiteralExpr ? null
                        : code.constant(space, type);
                attributes.computeIfAbsent(path, k -> new TreeSet<>())
                        .add(namespace == null ? attribute : "{" + namespace + "}" + attribute);
            }
        }
        for (Node child : node.getChildNodes()) {
            readElements(code, type, child, paths, attributes);
        }
    }

    /** For `child.getName().equals(X)` (or `X.equals(child.getName())`) on an element local: {local, path}. */
    private static String[] namedChild(Code code, TypeDeclaration<?> type, MethodCallExpr test, Map<String, String> paths) {
        if (!test.getNameAsString().equals("equals") || test.getArguments().size() != 1 || !test.getScope().isPresent()) {
            return null;
        }
        Expression[] sides = {test.getScope().get(), test.getArgument(0)};
        for (int i = 0; i < 2; i++) {
            Expression side = sides[i];
            if (side instanceof MethodCallExpr && ((MethodCallExpr) side).getNameAsString().equals("getName")
                    && ((MethodCallExpr) side).getScope().isPresent()
                    && ((MethodCallExpr) side).getScope().get() instanceof NameExpr) {
                String local = ((NameExpr) ((MethodCallExpr) side).getScope().get()).getNameAsString();
                String path = paths.get(local);
                String name = code.constant(sides[1 - i], type);
                if (path != null && path.endsWith("*") && name != null) {
                    return new String[]{local, path.substring(0, path.length() - 1) + name};
                }
            }
        }
        return null;
    }

    private static Expression uncast(Expression expression) {
        Expression inner = expression;
        while (inner instanceof com.github.javaparser.ast.expr.CastExpr || inner instanceof com.github.javaparser.ast.expr.EnclosedExpr) {
            inner = inner instanceof com.github.javaparser.ast.expr.CastExpr
                    ? ((com.github.javaparser.ast.expr.CastExpr) inner).getExpression()
                    : ((com.github.javaparser.ast.expr.EnclosedExpr) inner).getInner();
        }
        return inner;
    }
}
