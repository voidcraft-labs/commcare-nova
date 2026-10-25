package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Hashtable;
import java.util.Iterator;
import org.commcare.session.SessionFrame;
import org.commcare.session.SessionInstanceBuilder;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.condition.Recalculate;
import org.javarosa.core.model.condition.Triggerable;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceBase;
import org.javarosa.core.model.instance.InstanceInitializationFactory;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathTypeMismatchException;
import org.javarosa.xpath.expr.FunctionUtils;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * The session context reads in Core, over the forms the expression producer
 * writes as /expression/session-context/ with their rows in
 * /expression/session-context.json (lib/commcare/__tests__/sessionContextFixture.ts).
 *
 * The window width gate. Web Apps' client sends the browser's width only while
 * a menu or a list loads, so a form request rebuilds the session with no
 * window_width node, and Core's SessionInstanceBuilder.addData writes no node
 * for a null value. A bare read of an absent node is an invalid nodeset whose
 * value read throws (XPathPathExpr.evalRaw, XPathNodeset.unpack), but the path
 * is checked once per expression object (templatePathChecked). Formplayer
 * caches each session's FormDef (FormDefinitionService.getFormDefWithCache): a
 * cache hit reuses expressions already checked while the width was present,
 * and a miss deserializes a fresh FormDef from the session's stored definition
 * (getFormDefFromSession, FormDefStringSerializer.deserialize), whose
 * expressions start unchecked, since XPathPathExpr.writeExternal and
 * readExternal do not carry the flag. Each method opens the gate's form with a
 * session holding the width 1024, then initializes again with a session that
 * holds none: on the same FormDef (the cache hit) and on a freshly parsed one
 * (the cache miss, which a re-parse stands for). The count guard reads '' in
 * both. Whether the fresh bare read throws decides whether Nova may admit
 * window_width in a slot a form evaluates.
 *
 * Each bare assertion's failure names what the calculate gave instead, so a
 * run's verdict is its readout.
 */
public class SessionContextRuntimeTest {
    private static JSONObject rows() throws Exception {
        try (InputStream input = SessionContextRuntimeTest.class.getResourceAsStream("/expression/session-context.json")) {
            assertNotNull("The expression producer did not supply session-context.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown session context rows version", 1, result.getInt("schemaVersion"));
            return result;
        }
    }

    /** Core's own session instance, with the given width and no case-list step. */
    private static InstanceInitializationFactory session(String windowWidth) {
        return new InstanceInitializationFactory() {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (!"commcaresession".equals(instance.getInstanceId())) {
                    throw new AssertionError("The gate's form reads no instance " + instance.getInstanceId());
                }
                TreeElement root = SessionInstanceBuilder.getSessionInstance(new SessionFrame(), "device", "1", 0L,
                        "worker", "worker-id", new Hashtable<>(), windowWidth, "en");
                InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                return new ConcreteInstanceRoot(root);
            }
        };
    }

    private static FormDef parse(String resource) {
        FormDef form = new FormParseInit(resource).getFormDef();
        assertNotNull("Core must parse " + resource, form);
        return form;
    }

    private static String held(FormDef form, String path) throws Exception {
        return (String)ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(" + path + ")");
    }

    /** The calculate whose target is `path`, evaluated through the form's own expression object. */
    private static Object calculate(FormDef form, String path) {
        for (Iterator<Triggerable> triggerables = form.getTriggerables(); triggerables.hasNext(); ) {
            Triggerable triggerable = triggerables.next();
            if (!(triggerable instanceof Recalculate)) continue;
            for (TreeReference target : triggerable.getTargets()) {
                if (path.equals(target.toString(false))) {
                    return FunctionUtils.unpack(((Recalculate)triggerable).eval(form.getMainInstance(), form.getEvaluationContext()));
                }
            }
        }
        throw new AssertionError("The gate's form has no calculate for " + path);
    }

    /** Initializes `form` with a session that has no width; the exception a calculate threw, or null. */
    private static RuntimeException initializeWithoutWidth(FormDef form) {
        try {
            form.initialize(true, session(null));
            return null;
        } catch (RuntimeException thrown) {
            return thrown;
        }
    }

    private static String described(RuntimeException thrown) {
        return thrown.getClass().getName() + ": " + thrown.getMessage();
    }

    /** The first opening, with the width present: both calculates read it. */
    private static FormDef openWithWidth(JSONObject gate) throws Exception {
        FormDef form = parse(gate.getString("form"));
        form.initialize(true, session(gate.getString("width")));
        assertEquals("The bare read misses the width a menu request carries",
            gate.getString("width"), held(form, gate.getString("bare")));
        assertEquals("The guarded read misses the width a menu request carries",
            gate.getString("width"), held(form, gate.getString("guarded")));
        return form;
    }

    /** Arm (a): the cached FormDef, its expressions already checked while the width was present. */
    @Test public void windowWidthReadOnACachedForm() throws Exception {
        JSONObject gate = rows().getJSONObject("windowWidthGate");
        FormDef form = openWithWidth(gate);
        RuntimeException thrown = initializeWithoutWidth(form);
        assertEquals("On a cached form the guarded read of an absent width is not blank",
            "", calculate(form, gate.getString("guarded")));
        if (thrown != null) {
            fail("On a cached form the bare read of an absent width threw " + described(thrown)
                + ", where it was expected to read ''");
        }
        assertEquals("On a cached form the bare read of an absent width read '" + held(form, gate.getString("bare"))
            + "', where it was expected to read ''", "", held(form, gate.getString("bare")));
    }

    /** Arm (b): a fresh FormDef, as Formplayer deserializes one after a cache miss. */
    @Test public void windowWidthReadOnAFreshForm() throws Exception {
        JSONObject gate = rows().getJSONObject("windowWidthGate");
        openWithWidth(gate);
        FormDef fresh = parse(gate.getString("form"));
        RuntimeException thrown = initializeWithoutWidth(fresh);
        assertEquals("On a fresh form the guarded read of an absent width is not blank",
            "", calculate(fresh, gate.getString("guarded")));
        if (thrown == null) {
            fail("On a fresh form the bare read of an absent width read '" + held(fresh, gate.getString("bare"))
                + "', where it was expected to throw XPathTypeMismatchException");
        }
        assertTrue("On a fresh form the bare read of an absent width threw " + described(thrown)
            + ", where it was expected to throw XPathTypeMismatchException",
            thrown instanceof XPathTypeMismatchException);
        assertTrue("The fresh form's exception does not name the bare calculate: " + described(thrown),
            String.valueOf(thrown.getMessage()).contains("window_width"));
    }
}
