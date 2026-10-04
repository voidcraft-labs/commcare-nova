package nova.proof.core;

import org.javarosa.model.xform.XPathReference;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.XPathBinaryOpExpr;
import org.javarosa.xpath.expr.XPathExpression;
import org.javarosa.xpath.expr.XPathFilterExpr;
import org.javarosa.xpath.expr.XPathFuncExpr;
import org.javarosa.xpath.expr.XPathPathExpr;
import org.javarosa.xpath.expr.XPathStep;
import org.javarosa.xpath.expr.XPathUnaryOpExpr;
import org.javarosa.xpath.parser.XPathSyntaxException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Field;

/**
 * "xpathSame": whether Core's form parser reads two spellings of one attribute as the same thing.
 *
 * {"pairs": [[a, b, reading], ...]} gives {"results": [{"same", "trees", "errors"}]}, one per pair in order.
 * "reading" names how Core's XFormParser reads the attribute the two texts are spellings of (absent: "xpath"):
 * - "xpath": the text parsed with XPathParseTool.parseXPath, as Core parses a bind's conditions, a control's ref,
 *   a setvalue's value or an itemset's nodeset, value, copy or sort (those it parses with
 *   XPathReference.getPathExpr, which is parseXPath and then a refusal of anything that is not a path, so two
 *   texts parseXPath makes one tree of are read alike there too);
 * - "itemsetLabel": an itemset label's ref, read as ItemSetParsingUtils.setLabel reads it: a text that starts
 *   with "jr:itext(" and ends with ")" names an itext by the path between that opening and the first ")", any
 *   other text is the label's path itself, and either path is XPathReference.getPathExpr's, so "jr:itext(name) "
 *   (no closing ")" last) is a function call Core refuses where "jr:itext( name )" is the itext "name".
 * "trees" holds each side's reading as Core's toString() writes the parsed tree (the structural form: every
 * operator, function call, step and literal as Core holds it), an itemset label's itext marked "itext ", or null
 * where the side did not parse; "errors" holds each side's error, or null. toPrettyString() is never used: it
 * drops the parentheses Core's tree holds as structure (XPathArithExpr) and requotes string literals, so two
 * different expressions can print alike.
 *
 * "same" is Core's structural equality (XPathExpression.equals over the two trees), with an itemset label's two
 * sides also both itext or both not, and with one exception: Core's XPathFuncExpr.equals answers false for two
 * calls of uuid() or random() whatever their arguments ("we should never assume one uuid equals another"), a
 * statement about their values, not their structure, so here two such calls are the same expression when their
 * names and arguments are. Every other node is compared as its own equals() compares it: a binary operator by its
 * class, operator and operands; a negation by its operand; a path by its initial context, its filter expression
 * and its steps; a step by its axis, its node test (with its name, namespace or literal) and its predicates; a
 * filter expression by its expression and predicates; a literal or a variable by its value. Two sides that are
 * not both read without an error are never the same.
 *
 * An error's message is Core's, but for Parser.verifyBaseExpr's "Bad node: " + the node, which Core writes with
 * Object.toString (its class and identity hash, different on every run); that message keeps the class and drops
 * the hash, wherever in the message it is.
 */
final class XPathSame {
    private static final String XPATH = "xpath";
    private static final String ITEMSET_LABEL = "itemsetLabel";
    // ItemSetParsingUtils.setLabel's itext opening and closing.
    private static final String ITEXT_OPEN = "jr:itext(";
    private static final String ITEXT_CLOSE = ")";
    private static final Field FUNCTION_NAME;

    static {
        try {
            FUNCTION_NAME = XPathFuncExpr.class.getDeclaredField("name");
            FUNCTION_NAME.setAccessible(true);
        } catch (NoSuchFieldException e) {
            throw new IllegalStateException("Core's XPathFuncExpr no longer holds its name in a field called"
                    + " \"name\"; the runner's xpathSame op reads it there.", e);
        }
    }

    private XPathSame() {
    }

    static JSONObject run(JSONObject request) {
        JSONArray pairs = request.optJSONArray("pairs");
        if (pairs == null) {
            throw new RequestException("The xpathSame request needs \"pairs\" as a list of [text, text, reading]"
                    + " entries.");
        }
        JSONArray results = new JSONArray();
        for (int i = 0; i < pairs.length(); i++) {
            JSONArray pair = pairs.optJSONArray(i);
            if (pair == null || pair.length() < 2 || pair.length() > 3 || !(pair.get(0) instanceof String)
                    || !(pair.get(1) instanceof String) || (pair.length() == 3 && !(pair.get(2) instanceof String))) {
                throw new RequestException("Pair " + i + " of the xpathSame request is not [text, text] or"
                        + " [text, text, reading].");
            }
            String reading = pair.length() == 3 ? pair.getString(2) : XPATH;
            if (!XPATH.equals(reading) && !ITEMSET_LABEL.equals(reading)) {
                throw new RequestException("Pair " + i + " of the xpathSame request names the reading \"" + reading
                        + "\"; the runner reads \"" + XPATH + "\" and \"" + ITEMSET_LABEL + "\".");
            }
            results.put(compare(pair.getString(0), pair.getString(1), reading));
        }
        JSONObject answer = new JSONObject();
        answer.put("results", results);
        return answer;
    }

    private static JSONObject compare(String a, String b, String reading) {
        Parsed left = ITEMSET_LABEL.equals(reading) ? itemsetLabel(a) : parse(a);
        Parsed right = ITEMSET_LABEL.equals(reading) ? itemsetLabel(b) : parse(b);
        JSONObject result = new JSONObject();
        result.put("same", left.error == null && right.error == null && left.itext == right.itext
                && same(left.tree, right.tree));
        result.put("trees", new JSONArray().put(left.shown()).put(right.shown()));
        result.put("errors", new JSONArray()
                .put(left.error == null ? JSONObject.NULL : left.error)
                .put(right.error == null ? JSONObject.NULL : right.error));
        return result;
    }

    private static final class Parsed {
        final XPathExpression tree;
        final String error;
        final boolean itext;

        Parsed(XPathExpression tree, String error, boolean itext) {
            this.tree = tree;
            this.error = error;
            this.itext = itext;
        }

        Object shown() {
            if (error != null) {
                return JSONObject.NULL;
            }
            String shown = tree == null ? "" : tree.toString();
            return itext ? "itext " + shown : shown;
        }
    }

    private static Parsed parse(String text) {
        try {
            return new Parsed(XPathParseTool.parseXPath(text), null, false);
        } catch (XPathSyntaxException | RuntimeException e) {
            return new Parsed(null, e.getClass().getSimpleName() + ": " + withoutIdentity(e.getMessage()), false);
        }
    }

    /** An itemset label's ref as ItemSetParsingUtils.setLabel reads it: an itext's path, or the label's own. */
    private static Parsed itemsetLabel(String text) {
        boolean itext = text.startsWith(ITEXT_OPEN) && text.endsWith(ITEXT_CLOSE);
        String path = itext ? text.substring(ITEXT_OPEN.length(), text.indexOf(ITEXT_CLOSE)) : text;
        try {
            return new Parsed(XPathReference.getPathExpr(path), null, itext);
        } catch (RuntimeException e) {
            return new Parsed(null, e.getClass().getSimpleName() + ": " + withoutIdentity(e.getMessage()), itext);
        }
    }

    /** A message with Parser.verifyBaseExpr's "Bad node: " + the node's Object.toString without the hash. */
    private static String withoutIdentity(String message) {
        if (message == null) {
            return null;
        }
        int bad = message.indexOf("Bad node: ");
        int at = bad < 0 ? -1 : message.indexOf('@', bad);
        if (at < 0) {
            return message;
        }
        int end = at + 1;
        while (end < message.length() && Character.digit(message.charAt(end), 16) >= 0) {
            end++;
        }
        return message.substring(0, at) + message.substring(end);
    }

    static boolean same(XPathExpression a, XPathExpression b) {
        if (a == null || b == null) {
            return a == b;
        }
        if (a.getClass() != b.getClass()) {
            return false;
        }
        if (a instanceof XPathFuncExpr) {
            XPathFuncExpr x = (XPathFuncExpr)a;
            XPathFuncExpr y = (XPathFuncExpr)b;
            return functionName(x).equals(functionName(y)) && all(x.args, y.args);
        }
        if (a instanceof XPathBinaryOpExpr) {
            XPathBinaryOpExpr x = (XPathBinaryOpExpr)a;
            XPathBinaryOpExpr y = (XPathBinaryOpExpr)b;
            return x.op == y.op && same(x.a, y.a) && same(x.b, y.b);
        }
        if (a instanceof XPathUnaryOpExpr) {
            return same(((XPathUnaryOpExpr)a).a, ((XPathUnaryOpExpr)b).a);
        }
        if (a instanceof XPathPathExpr) {
            XPathPathExpr x = (XPathPathExpr)a;
            XPathPathExpr y = (XPathPathExpr)b;
            if (x.initContext != y.initContext || x.steps.length != y.steps.length) {
                return false;
            }
            for (int i = 0; i < x.steps.length; i++) {
                if (!sameStep(x.steps[i], y.steps[i])) {
                    return false;
                }
            }
            return x.initContext != XPathPathExpr.INIT_CONTEXT_EXPR || same(x.filtExpr, y.filtExpr);
        }
        if (a instanceof XPathFilterExpr) {
            XPathFilterExpr x = (XPathFilterExpr)a;
            XPathFilterExpr y = (XPathFilterExpr)b;
            return same(x.x, y.x) && all(x.predicates, y.predicates);
        }
        // Literals and variable references: their own equals compares their value.
        return a.equals(b);
    }

    private static boolean sameStep(XPathStep x, XPathStep y) {
        if (x.axis != y.axis || x.test != y.test) {
            return false;
        }
        switch (x.test) {
            case XPathStep.TEST_NAME:
                if (!x.name.equals(y.name)) {
                    return false;
                }
                break;
            case XPathStep.TEST_NAMESPACE_WILDCARD:
                if (!x.namespace.equals(y.namespace)) {
                    return false;
                }
                break;
            case XPathStep.TEST_TYPE_PROCESSING_INSTRUCTION:
                if (x.literal == null ? y.literal != null : !x.literal.equals(y.literal)) {
                    return false;
                }
                break;
            default:
                break;
        }
        return all(x.predicates, y.predicates);
    }

    private static boolean all(XPathExpression[] x, XPathExpression[] y) {
        if (x.length != y.length) {
            return false;
        }
        for (int i = 0; i < x.length; i++) {
            if (!same(x[i], y[i])) {
                return false;
            }
        }
        return true;
    }

    private static String functionName(XPathFuncExpr call) {
        try {
            return (String)FUNCTION_NAME.get(call);
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("The runner could not read a function call's name.", e);
        }
    }
}
