package nova.proof.core;

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
 * The fixed answer table (proof/core/answers.json) a session answers questions
 * from. Every value is a string in the encoding Web Apps sends Formplayer, and
 * is turned into Core's answer data exactly as Formplayer's
 * JsonActionUtils.getAnswerData does: a select takes the 1-based index of an
 * option, a multi-select a space-separated list of indices, a geopoint
 * "lat lon alt accuracy", and everything else is cast from its text by the
 * template AnswerDataFactory gives the question's control and data type.
 *
 * A question's values come from the first of: the Nova kind the request names
 * for its data path, the entry for its control, the entry for its data type.
 *
 * Two values stand for the run's clock: "@clock:today" is its date and
 * "@clock:now" its instant, spelled as Core spells a date and a date-time
 * (Generated.todaySpelling, nowSpelling), so a table can offer a date that a
 * "recent, not in the future" constraint accepts whatever clock a request sets.
 */
final class Answers {
    static final int MAX_TRIES = 3;

    private final JSONObject table;
    private final JSONObject questionKinds;

    Answers(JSONObject table, JSONObject questionKinds) {
        this.table = table;
        this.questionKinds = questionKinds == null ? new JSONObject() : questionKinds;
        for (String section : new String[]{"repeats", "controls", "dataTypes", "novaKinds"}) {
            if (!(table.opt(section) instanceof JSONObject)) {
                throw new RequestException("The answer table has no \"" + section + "\" object; send the table"
                        + " in proof/core/answers.json.");
            }
        }
    }

    int repeatsToAdd() {
        return table.getJSONObject("repeats").getInt("add");
    }

    /** The values to try for this question, and which table entry they came from. */
    Choice valuesFor(FormEntryPrompt prompt, String dataPath) {
        String kind = questionKinds.optString(dataPath, null);
        if (kind != null) {
            JSONArray values = table.getJSONObject("novaKinds").optJSONArray(kind);
            if (values == null) {
                return new Choice("novaKind:" + kind, null);
            }
            return new Choice("novaKind:" + kind, strings(values));
        }
        String control = CoreNames.control(prompt.getControlType());
        JSONArray values = table.getJSONObject("controls").optJSONArray(control);
        if (values != null) {
            return new Choice("control:" + control, strings(values));
        }
        String dataType = CoreNames.dataType(prompt.getDataType());
        values = table.getJSONObject("dataTypes").optJSONArray(dataType);
        return new Choice("dataType:" + dataType, values == null ? null : strings(values));
    }

    private static List<String> strings(JSONArray values) {
        List<String> list = new ArrayList<>();
        for (int i = 0; i < values.length(); i++) {
            list.add(resolve(values.getString(i)));
        }
        return list;
    }

    /** A table or request value with the clock's values in place of "@clock:today" and "@clock:now". */
    static String resolve(String value) {
        if (Generated.TODAY.equals(value)) {
            return Generated.todaySpelling();
        }
        if (Generated.NOW.equals(value)) {
            return Generated.nowSpelling();
        }
        return value;
    }

    /**
     * Formplayer's JsonActionUtils.getAnswerData, statement for statement, so a
     * value means here what it means to Web Apps.
     */
    static IAnswerData answerData(FormEntryPrompt formEntryPrompt, String data) {
        int index;
        switch (formEntryPrompt.getDataType()) {
            case Constants.DATATYPE_CHOICE:
                index = Integer.parseInt(data);
                Vector<SelectChoice> selectChoices = formEntryPrompt.getSelectChoices();
                if (index <= selectChoices.size()) {
                    SelectChoice selectChoiceAnswer = selectChoices.get(index - 1);
                    return new SelectOneData(selectChoiceAnswer.selection());
                } else {
                    throw new IllegalStateException(
                            "Index " + index + " out of range for question " + formEntryPrompt.getQuestion().getTextID());
                }
            case Constants.DATATYPE_CHOICE_LIST:
                String[] split = parseMultiSelectString(data);
                Vector<Selection> ret = new Vector<>();
                for (String s : split) {
                    index = Integer.parseInt(s);
                    selectChoices = formEntryPrompt.getSelectChoices();
                    if (index <= selectChoices.size()) {
                        Selection selection = selectChoices.get(
                                index - 1).selection();
                        ret.add(selection);
                    } else {
                        throw new IllegalStateException(
                                "Index " + index + " out of range for question " + formEntryPrompt.getQuestion().getTextID());
                    }
                }
                return new SelectMultiData(ret);
            case Constants.DATATYPE_GEOPOINT:
                return AnswerDataFactory.template(formEntryPrompt.getControlType(),
                        formEntryPrompt.getDataType()).cast(
                        new UncastData(convertTouchFormsGeoPointString(data)));
        }
        return data.equals("") ? null : AnswerDataFactory.template(formEntryPrompt.getControlType(),
                formEntryPrompt.getDataType()).cast(new UncastData(data));
    }

    private static String convertTouchFormsGeoPointString(String touchformsString) {
        return touchformsString.replace(",", " ").replace("[", "").replace("]", "");
    }

    private static String[] parseMultiSelectString(String answer) {
        answer = answer.trim();
        if (answer.startsWith("[") && answer.endsWith("]")) {
            answer = answer.substring(1, answer.length() - 1);
        }
        String[] ret = answer.split(" ");
        for (int i = 0; i < ret.length; i++) {
            ret[i] = ret[i].replace(",", "");
        }
        return ret;
    }

    /** Values from one table entry; null values means the table has no entry for the question. */
    static final class Choice {
        final String source;
        final List<String> values;

        Choice(String source, List<String> values) {
            this.source = source;
            this.values = values;
        }
    }
}
