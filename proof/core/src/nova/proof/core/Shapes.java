package nova.proof.core;

import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.condition.Constraint;
import org.javarosa.core.model.condition.Recalculate;
import org.javarosa.core.model.condition.Triggerable;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.xform.util.XFormUtils;
import org.javarosa.xpath.XPathConditional;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.javarosa.xpath.expr.XPathBinaryOpExpr;
import org.javarosa.xpath.expr.XPathConcatFunc;
import org.javarosa.xpath.expr.XPathCustomRuntimeFunc;
import org.javarosa.xpath.expr.XPathExpression;
import org.javarosa.xpath.expr.XPathFilterExpr;
import org.javarosa.xpath.expr.XPathFuncExpr;
import org.javarosa.xpath.expr.XPathIfFunc;
import org.javarosa.xpath.expr.XPathNumericLiteral;
import org.javarosa.xpath.expr.XPathPathExpr;
import org.javarosa.xpath.expr.XPathStep;
import org.javarosa.xpath.expr.XPathStringLiteral;
import org.javarosa.xpath.expr.XPathUnaryOpExpr;
import org.javarosa.xpath.expr.XPathVariableReference;
import org.javarosa.xpath.parser.Lexer;
import org.javarosa.xpath.parser.Token;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * What Core's parsers make of an expression or a form, read statically: no
 * instance is initialized and nothing is evaluated.
 *
 * "xpathParse" parses each expression with Core's own XPath parser
 * (XPathParseTool.parseXPath, which builds each call through
 * ASTNodeFunctionCall.buildFuncExpr) and Core's lexer (Lexer.lex), and lists
 * what the parsed tree holds, at any depth (arguments, operands, filter and
 * step predicates):
 * - "functions": the name of every function it calls; a name Core does not
 *   build into a class of its own parses as an XPathCustomRuntimeFunc and is
 *   listed all the same, with "custom" naming it (an evaluation context's
 *   function handler answers it at run time);
 * - "roots": a path rooted at instance(...) or current() lists that root
 *   rather than a call, since XPathPathExpr.getReference reads those two, and
 *   only those two, as the start of a path;
 * - "instancePaths": each path rooted at instance('<id>') with a literal id:
 *   the id, and each step after it (its name for a named child step, "@name"
 *   for a named attribute step, null for any other step);
 * - "expressions": the class of every expression node other than a function
 *   call; the XPathFilterExpr Core builds as a path's head (instance(...),
 *   current()) is part of that XPathPathExpr and is not listed, since Core
 *   reads it as the path's reference and never evaluates it on its own;
 * - "axes" and "tests": the XPathStep axis and node test constant of every
 *   step;
 * - "tokens": the Token constant of every token the lexer makes.
 *
 * "xpathStrings" lists the strings an expression can evaluate to, read over
 * its string literals: a string or number literal is its own text, concat()
 * is each combination of its arguments' strings, if() is the strings of
 * either branch, and any other expression is the request's "hole" (a value
 * only the run time knows). It is how a check reads the text an expression
 * hands another language, such as the CSQL a search's _xpath_query sends.
 *
 * "formShape" parses a form as Core's XFormInstaller does (XFormUtils, which runs
 * XFormParser) and lists every node of the main instance's template: its
 * reference, namespace, template value, and what its bind made of it (data
 * type, required, the constraint's expression, the calculate's expression,
 * and the calculate's value where Core's parser reads it as a string literal,
 * the value every submission writes there). A form is not initialized, so the
 * shape needs neither a session nor case data.
 */
final class Shapes {
    private static final Field FUNCTION_NAME;
    // Above this many strings an expression's strings are cut off, and "truncated" says so.
    private static final int MAX_STRINGS = 256;

    static {
        try {
            // XPathFuncExpr keeps the name it was built under (ASTNodeFunctionCall.buildFuncExpr passes
            // the call's QName as text) in a protected field with no accessor.
            FUNCTION_NAME = XPathFuncExpr.class.getDeclaredField("name");
            FUNCTION_NAME.setAccessible(true);
        } catch (NoSuchFieldException e) {
            throw new IllegalStateException("Core's XPathFuncExpr no longer holds its name in a field called"
                    + " \"name\"; the runner's xpathParse op reads it there.", e);
        }
    }

    private Shapes() {
    }

    private static JSONArray expressions(JSONObject request) {
        JSONArray expressions = request.optJSONArray("expressions");
        if (expressions == null) {
            throw new RequestException("The " + request.optString("op") + " request needs \"expressions\" as a"
                    + " list of strings.");
        }
        for (int i = 0; i < expressions.length(); i++) {
            if (!(expressions.get(i) instanceof String)) {
                throw new RequestException("Expression " + i + " of the " + request.optString("op")
                        + " request is not a string.");
            }
        }
        return expressions;
    }

    /** What one parsed expression holds, gathered by {@link #collect}. */
    private static final class Parsed {
        final TreeSet<String> functions = new TreeSet<>();
        final TreeSet<String> custom = new TreeSet<>();
        final TreeSet<String> roots = new TreeSet<>();
        final TreeSet<String> expressions = new TreeSet<>();
        final TreeSet<String> axes = new TreeSet<>();
        final TreeSet<String> tests = new TreeSet<>();
        final JSONArray instancePaths = new JSONArray();
    }

    /** {"expressions": [text]} gives {"results": [{functions, custom, roots, ...} or {"error"}]}, in order. */
    static JSONObject xpathParse(JSONObject request) {
        JSONArray expressions = expressions(request);
        JSONArray results = new JSONArray();
        for (int i = 0; i < expressions.length(); i++) {
            String text = expressions.getString(i);
            JSONObject result = new JSONObject();
            try {
                XPathExpression tree = XPathParseTool.parseXPath(text);
                Parsed parsed = new Parsed();
                if (tree != null) {
                    collect(tree, parsed);
                }
                TreeSet<String> tokens = new TreeSet<>();
                for (Token token : Lexer.lex(text)) {
                    String type = TOKENS.get(token.type);
                    if (type == null) {
                        throw new IllegalStateException("Core's lexer made a token of type " + token.type
                                + ", which no Token constant names.");
                    }
                    tokens.add(type);
                }
                result.put("functions", new JSONArray(parsed.functions));
                result.put("custom", new JSONArray(parsed.custom));
                result.put("roots", new JSONArray(parsed.roots));
                result.put("instancePaths", parsed.instancePaths);
                result.put("expressions", new JSONArray(parsed.expressions));
                result.put("axes", new JSONArray(parsed.axes));
                result.put("tests", new JSONArray(parsed.tests));
                result.put("tokens", new JSONArray(tokens));
            } catch (Exception e) {
                result.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            results.put(result);
        }
        JSONObject answer = new JSONObject();
        answer.put("results", results);
        return answer;
    }

    // Core's constants by value: Token's token types, XPathStep's axes and node tests.
    private static final Map<Integer, String> TOKENS = constants(Token.class, "");
    private static final Map<Integer, String> AXES = constants(XPathStep.class, "AXIS_");
    private static final Map<Integer, String> TESTS = constants(XPathStep.class, "TEST_");

    private static Map<Integer, String> constants(Class<?> owner, String prefix) {
        Map<Integer, String> found = new HashMap<>();
        for (Field field : owner.getDeclaredFields()) {
            int modifiers = field.getModifiers();
            if (Modifier.isStatic(modifiers) && Modifier.isFinal(modifiers) && field.getType() == int.class
                    && field.getName().startsWith(prefix)) {
                try {
                    String previous = found.put(field.getInt(null), field.getName());
                    if (previous != null) {
                        throw new IllegalStateException(owner.getName() + "'s constants " + previous + " and "
                                + field.getName() + " share a value, so the runner cannot name one by it.");
                    }
                } catch (IllegalAccessException e) {
                    throw new IllegalStateException("The runner could not read " + owner.getName() + "."
                            + field.getName() + ".", e);
                }
            }
        }
        return found;
    }

    private static void collect(XPathExpression expression, Parsed parsed) {
        if (expression instanceof XPathFuncExpr) {
            XPathFuncExpr call = (XPathFuncExpr)expression;
            String name = functionName(call);
            parsed.functions.add(name);
            if (call.getClass() == XPathCustomRuntimeFunc.class) {
                parsed.custom.add(name);
            }
            for (XPathExpression argument : call.args) {
                collect(argument, parsed);
            }
            return;
        }
        parsed.expressions.add(expression.getClass().getSimpleName());
        if (expression instanceof XPathBinaryOpExpr) {
            collect(((XPathBinaryOpExpr)expression).a, parsed);
            collect(((XPathBinaryOpExpr)expression).b, parsed);
        } else if (expression instanceof XPathUnaryOpExpr) {
            collect(((XPathUnaryOpExpr)expression).a, parsed);
        } else if (expression instanceof XPathPathExpr) {
            XPathPathExpr path = (XPathPathExpr)expression;
            if (path.filtExpr != null) {
                XPathExpression start = path.filtExpr.x;
                String root = start instanceof XPathFuncExpr ? functionName((XPathFuncExpr)start) : null;
                if (path.initContext == XPathPathExpr.INIT_CONTEXT_EXPR
                        && ("instance".equals(root) || "current".equals(root))) {
                    // XPathPathExpr.getReference reads these two as the path's root, never as calls.
                    parsed.roots.add(root);
                    XPathExpression[] arguments = ((XPathFuncExpr)start).args;
                    if ("instance".equals(root) && arguments.length == 1
                            && arguments[0] instanceof XPathStringLiteral) {
                        JSONObject instancePath = new JSONObject();
                        instancePath.put("instance", ((XPathStringLiteral)arguments[0]).s);
                        JSONArray steps = new JSONArray();
                        for (XPathStep step : path.steps) {
                            steps.put(stepName(step));
                        }
                        instancePath.put("steps", steps);
                        parsed.instancePaths.put(instancePath);
                    }
                    for (XPathExpression argument : arguments) {
                        collect(argument, parsed);
                    }
                    if (path.filtExpr.predicates != null) {
                        for (XPathExpression predicate : path.filtExpr.predicates) {
                            collect(predicate, parsed);
                        }
                    }
                } else {
                    collect(path.filtExpr, parsed);
                }
            }
            for (XPathStep step : path.steps) {
                parsed.axes.add(AXES.get(step.axis));
                parsed.tests.add(TESTS.get(step.test));
                if (step.predicates != null) {
                    for (XPathExpression predicate : step.predicates) {
                        collect(predicate, parsed);
                    }
                }
            }
        } else if (expression instanceof XPathFilterExpr) {
            XPathFilterExpr filter = (XPathFilterExpr)expression;
            collect(filter.x, parsed);
            if (filter.predicates != null) {
                for (XPathExpression predicate : filter.predicates) {
                    collect(predicate, parsed);
                }
            }
        } else if (!(expression instanceof XPathStringLiteral || expression instanceof XPathNumericLiteral
                || expression instanceof XPathVariableReference)) {
            // A node class this walk does not know could hold calls it would miss.
            throw new IllegalStateException("Core's XPath parser built a " + expression.getClass().getName()
                    + ", which the runner's xpathParse op does not know how to walk; teach Shapes.collect"
                    + " its children.");
        }
    }

    /** A step as a path through an instance names it: its name, "@" and its name, or null for any other step. */
    private static Object stepName(XPathStep step) {
        if (step.test == XPathStep.TEST_NAME && step.axis == XPathStep.AXIS_CHILD) {
            return step.name.toString();
        }
        if (step.test == XPathStep.TEST_NAME && step.axis == XPathStep.AXIS_ATTRIBUTE) {
            return "@" + step.name.toString();
        }
        return JSONObject.NULL;
    }

    private static String functionName(XPathFuncExpr call) {
        try {
            return (String)FUNCTION_NAME.get(call);
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("The runner could not read a function call's name.", e);
        }
    }

    /**
     * {"expressions": [text], "hole": text} gives {"results": [{"strings", "truncated"} or {"error"}]}, in order.
     */
    static JSONObject xpathStrings(JSONObject request) {
        JSONArray expressions = expressions(request);
        String hole = Ops.requireString(request, "hole");
        JSONArray results = new JSONArray();
        for (int i = 0; i < expressions.length(); i++) {
            JSONObject result = new JSONObject();
            try {
                XPathExpression tree = XPathParseTool.parseXPath(expressions.getString(i));
                boolean[] truncated = {false};
                Set<String> strings = tree == null ? Set.of("") : strings(tree, hole, truncated);
                result.put("strings", new JSONArray(new TreeSet<>(strings)));
                result.put("truncated", truncated[0]);
            } catch (Exception e) {
                result.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            results.put(result);
        }
        JSONObject answer = new JSONObject();
        answer.put("results", results);
        return answer;
    }

    private static Set<String> strings(XPathExpression expression, String hole, boolean[] truncated) {
        if (expression instanceof XPathStringLiteral) {
            return Set.of(((XPathStringLiteral)expression).s);
        }
        if (expression instanceof XPathNumericLiteral) {
            // The text Core's string() gives the number (FunctionUtils.toString).
            return Set.of(FunctionUtils.toString(((XPathNumericLiteral)expression).d));
        }
        if (expression instanceof XPathFuncExpr) {
            XPathFuncExpr call = (XPathFuncExpr)expression;
            String name = functionName(call);
            if (XPathConcatFunc.NAME.equals(name) && call.getClass() == XPathConcatFunc.class) {
                Set<String> combined = new LinkedHashSet<>(Set.of(""));
                for (XPathExpression argument : call.args) {
                    Set<String> next = new LinkedHashSet<>();
                    for (String prefix : combined) {
                        for (String part : strings(argument, hole, truncated)) {
                            if (next.size() >= MAX_STRINGS) {
                                truncated[0] = true;
                                break;
                            }
                            next.add(prefix + part);
                        }
                    }
                    combined = next;
                }
                return combined;
            }
            if (XPathIfFunc.NAME.equals(name) && call.getClass() == XPathIfFunc.class && call.args.length == 3) {
                Set<String> either = new LinkedHashSet<>(strings(call.args[1], hole, truncated));
                either.addAll(strings(call.args[2], hole, truncated));
                if (either.size() > MAX_STRINGS) {
                    truncated[0] = true;
                }
                return either;
            }
        }
        return Set.of(hole);
    }

    /** {"formBase64": the form's bytes} gives {"nodes": [...]}, the main instance's template in document order. */
    static JSONObject formShape(JSONObject request) throws Exception {
        byte[] bytes = Base64.getDecoder().decode(Ops.requireString(request, "formBase64"));
        FormDef form = XFormUtils.getFormRaw(new InputStreamReader(new ByteArrayInputStream(bytes),
                StandardCharsets.UTF_8));
        Map<String, String> calculates = new HashMap<>();
        for (Iterator<Triggerable> it = form.getTriggerables(); it.hasNext(); ) {
            Triggerable triggerable = it.next();
            if (triggerable instanceof Recalculate && triggerable.expr instanceof XPathConditional) {
                for (TreeReference target : triggerable.getTargets()) {
                    calculates.put(target.genericize().toString(false), ((XPathConditional)triggerable.expr).xpath);
                }
            }
        }
        JSONArray nodes = new JSONArray();
        TreeElement root = form.getMainInstance().getRoot();
        walk(root, "", nodes, calculates);
        JSONObject answer = new JSONObject();
        answer.put("nodes", nodes);
        return answer;
    }

    private static void walk(TreeElement element, String parentPath, JSONArray nodes,
                             Map<String, String> calculates) throws Exception {
        String path = parentPath + "/" + element.getName();
        JSONObject node = new JSONObject();
        node.put("path", path);
        node.put("name", element.getName());
        node.put("namespace", element.getNamespace() == null ? JSONObject.NULL : element.getNamespace());
        node.put("repeatable", element.isRepeatable());
        IAnswerData value = element.getValue();
        node.put("value", value == null ? JSONObject.NULL : value.uncast().getString());
        node.put("dataType", CoreNames.dataType(element.getDataType()));
        node.put("required", element.isRequired());
        Constraint constraint = element.getConstraint();
        if (constraint == null) {
            node.put("constraint", JSONObject.NULL);
        } else if (constraint.constraint instanceof XPathConditional) {
            node.put("constraint", ((XPathConditional)constraint.constraint).xpath);
        } else {
            node.put("constraint", String.valueOf(constraint.constraint));
        }
        JSONObject attributes = new JSONObject();
        for (int i = 0; i < element.getAttributeCount(); i++) {
            attributes.put(element.getAttributeName(i), element.getAttributeValue(i));
        }
        node.put("attributes", attributes);
        String calculate = calculates.get(path);
        node.put("calculate", calculate == null ? JSONObject.NULL : calculate);
        XPathExpression parsed = calculate == null ? null : XPathParseTool.parseXPath(calculate);
        node.put("calculatedConstant", parsed instanceof XPathStringLiteral ? ((XPathStringLiteral)parsed).s
                : JSONObject.NULL);
        nodes.put(node);
        for (int i = 0; i < element.getNumChildren(); i++) {
            walk(element.getChildAt(i), path, nodes, calculates);
        }
    }
}
