package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.TimeZone;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.AnswerDataFactory;
import org.javarosa.core.model.data.IntegerData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.data.UncastData;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceBase;
import org.javarosa.core.model.instance.InstanceInitializationFactory;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryModel;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * A calculated value in a text, in Core, in one device zone: the vector form
 * of lib/preview/engine/__tests__/proseValue.vectors.ts, compiled into a
 * local archive by the expression producer and written as
 * /expression/prose-values/form.xml with its rows in
 * /expression/prose-values.json.
 *
 * Core reads each output of a text as an expression of its own
 * (XFormParser.parseOutput), evaluates it at the question's node
 * (FormDef.fillTemplateString) and prints the result by XPath's string rule
 * (XPathConditional.evalReadable). Each label must read as the text Preview
 * prints for it. A validation message that holds a value is composed in
 * jr:constraintMsg with the value as it is, so a refused answer must show the
 * composed text (FormEntryPrompt.getConstraintText): Core answers an error
 * raised while composing a message with the expression's own text, which is
 * what a count() around a scalar would raise (XPathCountFunc.evalBody).
 * Each zone runs in a test JVM started in it, because DateUtils fixes its 1970
 * epoch when it loads; the date and time vector reads the zone.
 *
 * Plausible failures: a value printed otherwise than Preview prints it (a
 * number's spelling, a date's, a yes or no's), a label that keeps its
 * template's placeholder, and a message that reads as its own expression.
 */
public class ProseValueRuntimeTest {
    private static JSONObject rows() throws Exception {
        try (InputStream input = ProseValueRuntimeTest.class.getResourceAsStream("/expression/prose-values.json")) {
            assertNotNull("The expression producer did not supply prose-values.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown calculated value rows version", 1, result.getInt("schemaVersion"));
            return result;
        }
    }

    /** The JVM's own zone is the device's: the named setup, user.timezone, and no DateUtils provider. */
    private static String deviceZone() {
        String label = System.getProperty("nova.proof.zone.label");
        assertNotNull("This class must run through a named native zone setup", label);
        String jvmId = System.getProperty("nova.proof.zone.jvm");
        assertNotNull("The native runner did not supply the JVM zone", jvmId);
        assertEquals("The JVM was started in the wrong zone", jvmId, TimeZone.getDefault().getID());
        assertEquals("The native runner must set user.timezone", jvmId, System.getProperty("user.timezone"));
        assertEquals("The values run only in device zones, never behind a Formplayer provider",
            "", System.getProperty("nova.proof.zone.provider", ""));
        DateUtils.resetTimezoneProvider();
        assertNull("A device zone has no named DateUtils zone", DateUtils.timezone());
        return label;
    }

    private static TreeElement node(String name, String value) {
        TreeElement element = new TreeElement(name, 0);
        if (value != null) element.setValue(new StringData(value));
        return element;
    }

    /** The phone's session, which the local archive's meta block reads. */
    private static InstanceInitializationFactory session() {
        return new InstanceInitializationFactory() {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                assertEquals("The vector form reads no instance but the session",
                    "commcaresession", instance.getInstanceId());
                TreeElement root = node("session", null);
                TreeElement context = node("context", null);
                for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) {
                    context.addChild(node(key, "fixture-" + key));
                }
                context.addChild(node("drift", "0"));
                root.addChild(context);
                InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                return new ConcreteInstanceRoot(root);
            }
        };
    }

    private static TreeReference ref(FormDef form, String path) throws Exception {
        XPathNodeset target = (XPathNodeset)XPathParseTool.parseXPath(path).eval(form.getMainInstance(), form.getEvaluationContext());
        assertEquals("One node answers " + path, 1, target.size());
        return target.getRefAt(0);
    }

    /** The form with every answer given, each cast by its question's own type as its widget's answer is. */
    private static FormDef answered(JSONObject rows) throws Exception {
        FormDef form = new FormParseInit(rows.getString("form")).getFormDef();
        form.initialize(true, session());
        JSONArray answers = rows.getJSONArray("answers");
        for (int index = 0; index < answers.length(); index++) {
            JSONObject answer = answers.getJSONObject(index);
            TreeReference target = ref(form, answer.getString("question"));
            int type = form.getMainInstance().resolveReference(target).getDataType();
            form.setValue(AnswerDataFactory.templateByDataType(type).cast(new UncastData(answer.getString("value"))), target);
        }
        return form;
    }

    private static FormEntryModel at(FormDef form, String path) throws Exception {
        TreeReference target = ref(form, path);
        FormEntryModel model = new FormEntryModel(form);
        FormEntryController controller = new FormEntryController(model);
        int events = 0;
        while (controller.stepToNextEvent() != FormEntryController.EVENT_END_OF_FORM) {
            assertTrue("Bounded vector form", ++events < 100);
            if (model.getEvent() == FormEntryController.EVENT_QUESTION
                    && model.getFormIndex().getReference().equals(target)) return model;
        }
        throw new AssertionError("Missing question " + path);
    }

    @Test public void eachValueReadsAsPreviewPrintsIt() throws Exception {
        JSONObject rows = rows();
        String zone = deviceZone();
        FormDef form = answered(rows);
        JSONArray vectors = rows.getJSONArray("vectors");
        for (int index = 0; index < vectors.length(); index++) {
            JSONObject vector = vectors.getJSONObject(index);
            FormEntryPrompt prompt = at(form, vector.getString("question")).getQuestionPrompt();
            assertEquals(zone + " " + vector.getString("id") + ": Core prints the value otherwise than Preview",
                vector.getString("text"), prompt.getQuestionText());
        }
    }

    @Test public void eachValidationMessageReadsAsItsComposedText() throws Exception {
        JSONObject rows = rows();
        String zone = deviceZone();
        JSONArray messages = rows.getJSONArray("messages");
        for (int index = 0; index < messages.length(); index++) {
            JSONObject message = messages.getJSONObject(index);
            FormDef form = answered(rows);
            FormEntryModel entry = at(form, message.getString("question"));
            assertEquals(zone + " " + message.getString("id") + ": the refused answer was taken",
                FormEntryController.ANSWER_CONSTRAINT_VIOLATED,
                new FormEntryController(entry).answerQuestion(
                    new IntegerData(Integer.parseInt(message.getString("refused")))));
            assertEquals(zone + " " + message.getString("id") + ": the message does not read as its composed text",
                message.getString("text"), entry.getQuestionPrompt().getConstraintText());
        }
    }
}
