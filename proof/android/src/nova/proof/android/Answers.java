package nova.proof.android;

import org.javarosa.core.model.Constants;
import org.javarosa.core.model.SelectChoice;
import org.javarosa.core.model.data.AnswerDataFactory;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.data.SelectMultiData;
import org.javarosa.core.model.data.SelectOneData;
import org.javarosa.core.model.data.UncastData;
import org.javarosa.core.model.data.helper.Selection;
import org.javarosa.form.api.FormEntryPrompt;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Vector;

/**
 * The values a walk answers a form's questions with: the lane's own answer table (proof/core/answers.json, sent
 * with the request), read as the Core runner reads it (proof/core Answers.java), so a device's walk gives a
 * question what Core's and Formplayer's walks give it. A question takes the values of its control's entry, else
 * of its data type's; a select takes the 1-based index of an option, a multi-select a list of them, and any
 * other value is cast from its text by Core's own template for the question (AnswerDataFactory).
 *
 * The table's clock values are the reader's clock's (ProofClock), which is the day and instant the app's own
 * logic reads on the device.
 */
final class Answers {
    static final int MAX_TRIES = 3;
    /** Set by the reader for the request it is answering; null where the request sends no table. */
    static JSONObject table;

    private Answers() {
    }

    static List<String> valuesFor(FormEntryPrompt prompt) {
        List<String> found = new ArrayList<>();
        if (table == null) {
            return found;
        }
        JSONArray values = table.optJSONObject("controls") == null ? null
                : table.optJSONObject("controls").optJSONArray(control(prompt.getControlType()));
        if (values == null && table.optJSONObject("dataTypes") != null) {
            values = table.optJSONObject("dataTypes").optJSONArray(dataType(prompt.getDataType()));
        }
        for (int i = 0; values != null && i < values.length() && i < MAX_TRIES; i++) {
            String value = values.optString(i);
            found.add("@clock:today".equals(value) ? ProofClock.TODAY
                    : "@clock:now".equals(value) ? ProofClock.NOW : value);
        }
        return found;
    }

    static int repeatsToAdd() {
        JSONObject repeats = table == null ? null : table.optJSONObject("repeats");
        return repeats == null ? 0 : repeats.optInt("add", 0);
    }

    /** Formplayer's JsonActionUtils.getAnswerData, as the Core runner holds it. */
    static IAnswerData answerData(FormEntryPrompt prompt, String data) {
        switch (prompt.getDataType()) {
            case Constants.DATATYPE_CHOICE: {
                Vector<SelectChoice> choices = prompt.getSelectChoices();
                int index = Integer.parseInt(data);
                if (choices == null || index > choices.size()) {
                    throw new IllegalStateException("no option " + index);
                }
                return new SelectOneData(choices.get(index - 1).selection());
            }
            case Constants.DATATYPE_CHOICE_LIST: {
                Vector<SelectChoice> choices = prompt.getSelectChoices();
                Vector<Selection> chosen = new Vector<>();
                for (String part : data.trim().split(" ")) {
                    int index = Integer.parseInt(part);
                    if (choices == null || index > choices.size()) {
                        throw new IllegalStateException("no option " + index);
                    }
                    chosen.add(choices.get(index - 1).selection());
                }
                return new SelectMultiData(chosen);
            }
            default:
                return data.isEmpty() ? null : AnswerDataFactory.template(prompt.getControlType(),
                        prompt.getDataType()).cast(new UncastData(data));
        }
    }

    /** Core's control constants by the names the answer table uses (proof/core CoreNames.control). */
    static String control(int control) {
        switch (control) {
            case Constants.CONTROL_UNTYPED:
                return "untyped";
            case Constants.CONTROL_INPUT:
                return "input";
            case Constants.CONTROL_SELECT_ONE:
                return "select1";
            case Constants.CONTROL_SELECT_MULTI:
                return "select";
            case Constants.CONTROL_TEXTAREA:
                return "textarea";
            case Constants.CONTROL_SECRET:
                return "secret";
            case Constants.CONTROL_RANGE:
                return "range";
            case Constants.CONTROL_UPLOAD:
                return "upload";
            case Constants.CONTROL_SUBMIT:
                return "submit";
            case Constants.CONTROL_TRIGGER:
                return "trigger";
            case Constants.CONTROL_IMAGE_CHOOSE:
                return "image";
            case Constants.CONTROL_LABEL:
                return "label";
            case Constants.CONTROL_AUDIO_CAPTURE:
                return "audio";
            case Constants.CONTROL_VIDEO_CAPTURE:
                return "video";
            case Constants.CONTROL_DOCUMENT_UPLOAD:
                return "document";
            default:
                return "control-" + control;
        }
    }

    /** Core's data type constants by the names the answer table uses (proof/core CoreNames.dataType). */
    static String dataType(int dataType) {
        switch (dataType) {
            case Constants.DATATYPE_UNSUPPORTED:
                return "unsupported";
            case Constants.DATATYPE_NULL:
                return "null";
            case Constants.DATATYPE_TEXT:
                return "text";
            case Constants.DATATYPE_INTEGER:
                return "integer";
            case Constants.DATATYPE_DECIMAL:
                return "decimal";
            case Constants.DATATYPE_DATE:
                return "date";
            case Constants.DATATYPE_TIME:
                return "time";
            case Constants.DATATYPE_DATE_TIME:
                return "dateTime";
            case Constants.DATATYPE_CHOICE:
                return "choice";
            case Constants.DATATYPE_CHOICE_LIST:
                return "choiceList";
            case Constants.DATATYPE_BOOLEAN:
                return "boolean";
            case Constants.DATATYPE_GEOPOINT:
                return "geopoint";
            case Constants.DATATYPE_BARCODE:
                return "barcode";
            case Constants.DATATYPE_BINARY:
                return "binary";
            case Constants.DATATYPE_LONG:
                return "long";
            default:
                return "dataType-" + dataType;
        }
    }
}
