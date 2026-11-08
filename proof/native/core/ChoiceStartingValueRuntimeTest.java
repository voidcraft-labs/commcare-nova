package nova.compatibility;

import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.*;
import org.javarosa.xpath.XPathTypeMismatchException;
import org.javarosa.xpath.XPathException;
import org.junit.Test;
import static org.junit.Assert.*;

/** Retained Nova exports from before #856: Core accepts the value, then
 * refuses its label and restoration. This establishes the diagnostic's
 * runtime boundary, not a native question validation rule. */
public class ChoiceStartingValueRuntimeTest {
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    private static InstanceInitializationFactory environment() {
        return new InstanceInitializationFactory() {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                TreeElement root = node("session", null), context = node("context", null);
                for (String key : new String[]{"deviceid", "username", "userid", "appversion"})
                    context.addChild(node(key, "proof-" + key));
                context.addChild(node("drift", "0"));
                root.addChild(context);
                root.addChild(node("data", null));
                InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                return new ConcreteInstanceRoot(root);
            }
        };
    }
    @Test public void answerLabelsAndRestorationRequireAvailableChoices() {
        for (String kind : new String[]{"single_select", "multi_select"}) {
            for (String scenario : (kind.equals("multi_select") ? new String[]{"valid", "invalid", "mixed", "blank", "leading"} : new String[]{"valid", "invalid", "mixed", "blank"})) {
                FormParseInit parsed = new FormParseInit("/choice-starting-values/" + kind + "-" + scenario + ".xml");
                FormDef form = parsed.getFormDef();
                if (scenario.equals("leading")) {
                    XPathException failure = assertThrows(XPathException.class, () -> form.initialize(true, environment()));
                    assertTrue(failure.getMessage().contains("empty XML Value"));
                    continue;
                }
                form.initialize(true, environment());
                FormEntryController controller = parsed.getFormEntryController();
                int events = 0;
                while (controller.stepToNextEvent() != FormEntryController.EVENT_QUESTION)
                    assertTrue("Question reached", ++events < 20);
                FormEntryPrompt prompt = controller.getModel().getQuestionPrompt();
                String value = prompt.getAnswerValue() == null ? "" : prompt.getAnswerValue().uncast().getString();
                assertEquals(scenario.equals("valid") ? "yes" : scenario.equals("blank") ? "" : scenario.equals("mixed") ? "yes pending" : "pending", value);
                if (scenario.equals("valid") || scenario.equals("blank")) {
                    if (scenario.equals("valid")) assertTrue(prompt.getAnswerText().contains("Yes"));
                    else assertNull(prompt.getAnswerText());
                    form.attachControlsToInstanceData();
                } else {
                    assertThrows(XPathTypeMismatchException.class, () -> prompt.getAnswerText());
                    assertThrows(XPathTypeMismatchException.class, () -> form.attachControlsToInstanceData());
                    assertEquals(value, prompt.getAnswerValue().uncast().getString());
                }
            }
        }
    }
}
