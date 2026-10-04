package nova.proof.core;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

/** The runner's operations, one per request "op". */
final class Ops {
    static final List<String> NAMES = List.of("validateForm", "admit", "release", "session", "evaluate",
            "xpathParse", "xpathStrings", "xpathSame", "formShape", "shutdown");

    private Ops() {
    }

    static JSONObject dispatch(String op, JSONObject request, Apps apps) throws Exception {
        switch (op) {
            case "validateForm":
                return validateForm(request);
            case "admit":
                return Admission.admit(request, apps);
            case "release":
                return apps.release(requireString(request, "appHandle"));
            case "session":
                return SessionOp.run(request, apps);
            case "evaluate":
                return Evaluate.run(request, apps);
            case "xpathParse":
                return Shapes.xpathParse(request);
            case "xpathStrings":
                return Shapes.xpathStrings(request);
            case "xpathSame":
                return XPathSame.run(request);
            case "formShape":
                return Shapes.formShape(request);
            default:
                throw new RequestException("The runner has no op named \"" + op + "\". Send one of: "
                        + String.join(", ", NAMES) + ".");
        }
    }

    /**
     * {"xmlBase64": the form's bytes} gives {"report": Formplayer's JSON text}.
     * The bytes are decoded as UTF-8 exactly as Formplayer decodes the body HQ posts.
     */
    private static JSONObject validateForm(JSONObject request) throws Exception {
        byte[] bytes = Base64.getDecoder().decode(requireString(request, "xmlBase64"));
        JSONObject result = new JSONObject();
        result.put("report", ValidateForm.validate(new String(bytes, StandardCharsets.UTF_8)));
        return result;
    }

    static String requireString(JSONObject request, String key) {
        Object value = request.opt(key);
        if (!(value instanceof String)) {
            throw new RequestException("The " + request.optString("op") + " request needs \"" + key
                    + "\" as a string.");
        }
        return (String)value;
    }

    static JSONObject requireObject(JSONObject request, String key) {
        Object value = request.opt(key);
        if (!(value instanceof JSONObject)) {
            throw new RequestException("The " + request.optString("op") + " request needs \"" + key
                    + "\" as an object.");
        }
        return (JSONObject)value;
    }
}
