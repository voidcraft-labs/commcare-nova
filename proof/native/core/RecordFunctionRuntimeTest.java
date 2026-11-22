package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Each formula is evaluated by Core over a real text node, the class of a
 * custom property of a case on a worker's device. Postgres reads the same
 * control rows from a stored case. */
public class RecordFunctionRuntimeTest {
    @Test
    public void coreEvaluatesTheRecordFunctionControls() throws Exception {
        try (InputStream stream = getClass().getResourceAsStream("/record-functions/values.json")) {
            assertNotNull(stream);
            JSONArray rows = new JSONArray(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                TreeElement root = new TreeElement("data", 0);
                List<String> args = new ArrayList<>();
                JSONArray operands = row.getJSONArray("args");
                for (int j = 0; j < operands.length(); j++) {
                    Object arg = operands.get(j);
                    if (arg instanceof JSONObject) {
                        TreeElement child = new TreeElement("value", 0);
                        child.setValue(new StringData(((JSONObject)arg).getString("read")));
                        root.addChild(child);
                        args.add("/data/value");
                    } else if (arg instanceof String) {
                        args.add("'" + arg + "'");
                    } else {
                        args.add(arg.toString());
                    }
                }
                FormInstance model = new FormInstance(root);
                String expression = row.getString("fn") + "(" + String.join(", ", args) + ")";
                Object result = XPathParseTool.parseXPath(expression).eval(model, new EvaluationContext(model));
                assertEquals(expression, row.getString("expected"), FunctionUtils.toString(result));
            }
        }
    }
}
