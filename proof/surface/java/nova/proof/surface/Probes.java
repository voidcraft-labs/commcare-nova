package nova.proof.surface;

import java.util.ArrayList;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.session.SessionFrame;
import org.commcare.session.SessionInstanceBuilder;
import org.commcare.suite.model.StackFrameStep;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.AbstractTreeElement;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.XPathBinaryOpExpr;
import org.javarosa.xpath.expr.XPathExpression;
import org.javarosa.xpath.expr.XPathPathExpr;

/**
 * Runtime readings the surface's tests hold the Java families against, made by running Core's own
 * compiled classes rather than reading their source. None of them is a family.
 *
 *   probe session                 the paths of the session instance getSessionInstance builds
 *   probe instance-source <src>...  the setup method generateRoot runs for each src
 *   probe xpath <expression>...   the class Core's parser builds for each, the top operator, a
 *                                 path's step axes and whether Core makes a reference of it
 *   probe form-handlers           the function names a form's evaluation context holds
 *   probe text-forms              the string constants FormEntryCaption declares (its itext forms)
 *   probe attribute-namespaces    what kXML's getAttributeValue answers by the namespace it is asked for
 */
final class Probes {
    private Probes() {
    }

    static Object run(String probe, String[] args, int from) throws Exception {
        switch (probe) {
            case "session":
                return session();
            case "instance-source": {
                Map<String, Object> out = new TreeMap<>();
                for (int i = from; i < args.length; i++) {
                    out.put(args[i], instanceSource(args[i]));
                }
                return out;
            }
            case "xpath": {
                Map<String, Object> out = new TreeMap<>();
                for (int i = from; i < args.length; i++) {
                    out.put(args[i], xpath(args[i]));
                }
                return out;
            }
            case "text-forms": {
                // The form names Core's form entry API declares for itext (`FormEntryCaption.TEXT_FORM_*`).
                List<String> forms = new ArrayList<>();
                for (java.lang.reflect.Field field : Class.forName("org.javarosa.form.api.FormEntryCaption").getFields()) {
                    if (java.lang.reflect.Modifier.isStatic(field.getModifiers()) && field.getType() == String.class
                            && java.lang.reflect.Modifier.isFinal(field.getModifiers())) {
                        forms.add((String) field.get(null));
                    }
                }
                forms.sort(null);
                return forms;
            }
            case "attribute-namespaces": {
                // What kXML's Element.getAttributeValue(namespace, name) answers for an attribute held in a
                // namespace and for one held in none, by the namespace argument XFormParser passes.
                Map<String, Object> out = new TreeMap<>();
                org.kxml2.kdom.Element element = new org.kxml2.kdom.Element();
                element.setAttribute("http://example.org/probe", "inNamespace", "a");
                element.setAttribute("", "inNone", "b");
                for (String attribute : List.of("inNamespace", "inNone")) {
                    Map<String, Object> read = new TreeMap<>();
                    read.put("null", element.getAttributeValue(null, attribute));
                    read.put("empty", element.getAttributeValue("", attribute));
                    read.put("namespace", element.getAttributeValue("http://example.org/probe", attribute));
                    out.put(attribute, read);
                }
                return out;
            }
            case "form-handlers": {
                FormDef form = new FormDef();
                form.setEvaluationContext(new EvaluationContext(null));
                return new ArrayList<>(new TreeSet<>(form.getEvaluationContext().getFunctionHandlers().keySet()));
            }
            default:
                throw new IllegalArgumentException("unknown probe " + probe);
        }
    }

    /** The session instance for a frame holding one case datum and a query, with one user property. */
    private static Object session() {
        SessionFrame frame = new SessionFrame();
        frame.pushStep(new StackFrameStep(SessionFrame.STATE_DATUM_VAL, "case_id", "a-case"));
        StackFrameStep queried = new StackFrameStep(SessionFrame.STATE_DATUM_VAL, "other_case_id", "b-case");
        queried.addExtra(SessionInstanceBuilder.KEY_LAST_QUERY_STRING, "typed");
        frame.pushStep(queried);
        Hashtable<String, String> user = new Hashtable<>();
        user.put("user_property", "a-value");
        TreeElement root = SessionInstanceBuilder.getSessionInstance(frame, "device", "1.0", 0L, "worker", "worker-id",
                user, "1024", "en");
        List<String> paths = new ArrayList<>();
        walk(root, root.getName(), paths);
        return paths;
    }

    private static void walk(AbstractTreeElement<?> element, String path, List<String> out) {
        out.add(path);
        for (int i = 0; i < element.getNumChildren(); i++) {
            AbstractTreeElement<?> child = element.getChildAt(i);
            walk(child, path + "/" + child.getName(), out);
        }
    }

    /**
     * The `CommCareInstanceInitializer` method `generateRoot` hands an instance with this src to. The
     * initializer holds no sandbox, so a setup method stops at its first use of it; the deepest
     * initializer method on the stack is where generateRoot dispatched.
     */
    private static Object instanceSource(String src) {
        CommCareInstanceInitializer initializer = new CommCareInstanceInitializer(null, null, null);
        try {
            Object root = initializer.generateRoot(new ExternalDataInstance(src, "probe"));
            return "returned " + root.getClass().getSimpleName()
                    + (root == org.javarosa.core.model.instance.ConcreteInstanceRoot.NULL ? " NULL" : "");
        } catch (RuntimeException stopped) {
            // The initializer frame nearest generateRoot is the method generateRoot called.
            String found = null;
            for (StackTraceElement frame : stopped.getStackTrace()) {
                if (frame.getMethodName().equals("generateRoot")) {
                    break;
                }
                if (frame.getClassName().equals(CommCareInstanceInitializer.class.getName())) {
                    found = frame.getMethodName();
                }
            }
            return found == null ? "stopped in generateRoot: " + stopped : found;
        }
    }

    private static Object xpath(String expression) throws Exception {
        Map<String, Object> facts = new LinkedHashMap<>();
        XPathExpression parsed;
        try {
            parsed = XPathParseTool.parseXPath(expression);
        } catch (Exception refused) {
            facts.put("refused", refused.getClass().getSimpleName());
            return facts;
        }
        facts.put("class", parsed.getClass().getSimpleName());
        if (parsed instanceof XPathBinaryOpExpr) {
            int op = ((XPathBinaryOpExpr) parsed).op;
            for (java.lang.reflect.Field field : parsed.getClass().getDeclaredFields()) {
                if (java.lang.reflect.Modifier.isStatic(field.getModifiers()) && field.getType() == int.class
                        && field.getInt(null) == op) {
                    facts.put("op", field.getName());
                }
            }
        }
        if (parsed instanceof XPathPathExpr) {
            List<Integer> axes = new ArrayList<>();
            for (org.javarosa.xpath.expr.XPathStep step : ((XPathPathExpr) parsed).steps) {
                axes.add(step.axis);
            }
            facts.put("axes", axes);
            try {
                ((XPathPathExpr) parsed).getReference();
                facts.put("reference", "accepted");
            } catch (RuntimeException refused) {
                facts.put("reference", "refused: " + refused.getMessage());
            }
        }
        return facts;
    }

}
