package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import com.google.common.collect.Multimap;

import org.commcare.CommCareApplication;
import org.commcare.activities.QueryRequestActivity;
import org.commcare.android.mocks.ModernHttpRequesterMock;
import org.commcare.cases.instance.CaseInstanceTreeElement;
import org.commcare.dalvik.R;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.utils.RobolectricUtil;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.model.xform.DataModelSerializer;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collection;
import java.util.Hashtable;
import java.util.Map;
import java.util.TreeMap;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.Transformer;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;

/**
 * What Android's search screen does with the search home opened.
 *
 * First, where the request names an answer ({@code queryAnswer}), on a screen of its own: what the screen sends
 * once every free-text prompt holds that answer and the worker presses Search
 * (QueryRequestActivity.makeQueryRequest), the errors Core's query manager holds for the prompts at that moment,
 * and what the screen shows when the server answers 400, as HQ answers a query it refuses.
 *
 * Then the search itself, its prompts left as the screen opened them: the server is the project's own test
 * requester (ModernHttpRequesterMock), which answers with every case of the asked types the device holds, in
 * HQ's search response shape, as the Core runner answers a search (proof/core, CaseData.searchResults). The
 * screen's result goes back to home, and the walk goes on to the list behind it.
 */
final class Queries {
    /** Set by the reader for the request it is answering; null where the request names none. */
    static String answer;
    private static final java.util.Set<String> probed = new java.util.HashSet<>();
    private static final java.util.Set<String> typedIn = new java.util.HashSet<>();

    private Queries() {
    }

    /** Reads the search screen; true where the search was answered and home was handed its result. */
    static boolean read(Intent started, JSONObject step, ShadowActivity home) throws Exception {
        JSONObject query = new JSONObject();
        step.put("query", query);
        if (answer != null && probed.add(String.valueOf(step.opt("session")))) {
            // Once a request for each search a session asks for: the walks that pass it again send it and go on.
            QueryRequestActivity probe = open(started);
            RemoteQuerySessionManager manager = manager(probe);
            if (manager != null) {
                query.put("withAnswer", withAnswer(probe, manager));
            }
        }
        JSONObject prompts = Answers.table == null ? null : Answers.table.optJSONObject("searchPrompts");
        if (prompts != null && typedIn.add(String.valueOf(step.opt("session")))) {
            // Once a session for each search: the screen as a worker leaves it after typing into every prompt.
            QueryRequestActivity typed = open(started);
            RemoteQuerySessionManager manager = manager(typed);
            if (manager != null) {
                query.put("typed", typed(typed, manager, prompts));
            }
        }
        QueryRequestActivity activity = open(started);
        RemoteQuerySessionManager manager = manager(activity);
        if (manager == null) {
            query.put("opened", false);
            return false;
        }
        query.put("opened", true);
        query.put("url", address(String.valueOf(manager.getBaseUrl())));
        JSONObject shown = new JSONObject();
        for (Map.Entry<String, View> box : new TreeMap<>(boxes(activity)).entrySet()) {
            shown.put(box.getKey(), box.getValue().getClass().getSimpleName());
        }
        query.put("prompts", shown);
        Multimap<String, String> params = manager.getRawQueryParams(false);
        query.put("RemoteQuerySessionManager.getRawQueryParams", params(params));

        File results = File.createTempFile("search-results", ".xml");
        Files.write(results.toPath(), searchResults(params.get("case_type")));
        String root = CommCareApplication.instance().getArchiveFileRoot().addArchiveFile(results.getParent());
        ModernHttpRequesterMock.setResponseCodes(new Integer[]{200});
        ModernHttpRequesterMock.setExpectedUrls(new String[0]);
        ModernHttpRequesterMock.setRequestPayloads(new String[]{"jr://archive/" + root + "/" + results.getName()});
        press(activity);
        ShadowActivity shadow = Shadows.shadowOf(activity);
        query.put("finishing", activity.isFinishing());
        query.put("resultCode", shadow.getResultCode());
        TextView error = (TextView)((Activity)activity).findViewById(R.id.error_message);
        if (error.getVisibility() == View.VISIBLE) {
            query.put("errorText", String.valueOf(error.getText()));
        }
        if (!activity.isFinishing() || shadow.getResultCode() != Activity.RESULT_OK) {
            return false;
        }
        home.receiveResult(started, shadow.getResultCode(), shadow.getResultIntent());
        ShadowLooper.idleMainLooper();
        return true;
    }

    private static QueryRequestActivity open(Intent started) {
        QueryRequestActivity activity =
                Robolectric.buildActivity(QueryRequestActivity.class, started).setup().get();
        ShadowLooper.idleMainLooper();
        return activity;
    }

    private static RemoteQuerySessionManager manager(QueryRequestActivity activity) throws Exception {
        return (RemoteQuerySessionManager)Screens.field(activity, "remoteQuerySessionManager");
    }

    @SuppressWarnings("unchecked")
    private static Hashtable<String, View> boxes(QueryRequestActivity activity) throws Exception {
        return (Hashtable<String, View>)Screens.field(Screens.field(activity, "mRequestUiController"),
                "promptsBoxes");
    }

    private static void press(QueryRequestActivity activity) {
        Button search = (Button)((Activity)activity).findViewById(R.id.request_button);
        search.performClick();
        RobolectricUtil.flushBackgroundThread(activity);
        ShadowLooper.idleMainLooper();
    }

    private static JSONObject withAnswer(QueryRequestActivity activity, RemoteQuerySessionManager manager)
            throws Exception {
        JSONObject found = new JSONObject();
        for (View box : boxes(activity).values()) {
            if (box instanceof EditText) {
                ((EditText)box).setText(answer);
            }
        }
        ShadowLooper.idleMainLooper();
        found.put("answer", answer);
        found.put("RemoteQuerySessionManager.getErrors", strings(manager.getErrors()));
        found.put("RemoteQuerySessionManager.getRawQueryParams", params(manager.getRawQueryParams(false)));
        ModernHttpRequesterMock.setResponseCodes(new Integer[]{400});
        ModernHttpRequesterMock.setExpectedUrls(new String[0]);
        ModernHttpRequesterMock.setRequestPayloads(new String[0]);
        press(activity);
        TextView error = (TextView)((Activity)activity).findViewById(R.id.error_message);
        JSONObject after = new JSONObject();
        after.put("errorShown", error.getVisibility() == View.VISIBLE);
        after.put("errorText", String.valueOf(error.getText()));
        after.put("finishing", activity.isFinishing());
        found.put("afterServerAnswers400", after);
        return found;
    }

    /**
     * The screen after the worker types the lane's search answers (the answer table's {@code searchPrompts}) into
     * each prompt through the screen's own views: a text box is typed into, a single select's spinner set to the
     * option, a checkbox prompt's box ticked. What each prompt was given, the errors Core's query manager then
     * holds and what the screen would send (the strings a search builds from the answers, CSQL among them).
     */
    private static JSONObject typed(QueryRequestActivity activity, RemoteQuerySessionManager manager,
                                    JSONObject answers) throws Exception {
        JSONObject found = new JSONObject();
        JSONObject given = new JSONObject();
        org.javarosa.core.util.OrderedHashtable<String, org.commcare.suite.model.QueryPrompt> needed =
                manager.getNeededUserInputDisplays();
        for (Map.Entry<String, View> box : new TreeMap<>(boxes(activity)).entrySet()) {
            org.commcare.suite.model.QueryPrompt prompt = needed.get(box.getKey());
            String input = prompt == null ? null : prompt.getInput();
            View view = box.getValue();
            if (view instanceof android.widget.Spinner) {
                int index = Integer.parseInt(answers.getString("select1"));
                android.widget.Spinner spinner = (android.widget.Spinner)view;
                if (index < spinner.getCount()) {
                    spinner.setSelection(index);
                    given.put(box.getKey(), String.valueOf(spinner.getSelectedItem()));
                } else {
                    given.put(box.getKey(), "no option " + index);
                }
            } else if (org.commcare.suite.model.QueryPrompt.INPUT_TYPE_CHECKBOX.equals(input)
                    && view instanceof android.view.ViewGroup) {
                int index = Integer.parseInt(answers.getString("checkbox"));
                android.view.ViewGroup boxes = (android.view.ViewGroup)view;
                if (index <= boxes.getChildCount()) {
                    android.widget.CheckBox tick = (android.widget.CheckBox)boxes.getChildAt(index - 1);
                    tick.performClick();
                    given.put(box.getKey(), String.valueOf(tick.getText()));
                } else {
                    given.put(box.getKey(), "no option " + index);
                }
            } else if (view instanceof EditText && view.isFocusable()) {
                ((EditText)view).setText(answers.getString("text"));
                given.put(box.getKey(), answers.getString("text"));
            } else {
                // A date range is chosen on Android's own date picker, which the walk does not open.
                given.put(box.getKey(), "not typed: " + (input == null ? view.getClass().getSimpleName() : input));
            }
            ShadowLooper.idleMainLooper();
        }
        found.put("given", given);
        found.put("RemoteQuerySessionManager.getErrors", strings(manager.getErrors()));
        found.put("RemoteQuerySessionManager.getRawQueryParams", params(manager.getRawQueryParams(false)));
        return found;
    }

    /** Every case of the asked types in the device's case storage, under HQ's search root. */
    private static byte[] searchResults(Collection<String> caseTypes) throws Exception {
        ByteArrayOutputStream serialized = new ByteArrayOutputStream();
        new DataModelSerializer(serialized,
                CommCareApplication.instance().getCurrentSessionWrapper().getIIF()).serialize(
                new ExternalDataInstance(ExternalDataInstance.JR_CASE_DB_REFERENCE,
                        CaseInstanceTreeElement.MODEL_NAME), null);
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        Document casedb = factory.newDocumentBuilder().parse(new ByteArrayInputStream(serialized.toByteArray()));
        Document results = factory.newDocumentBuilder().newDocument();
        Element root = results.createElement("results");
        root.setAttribute("id", "case");
        results.appendChild(root);
        NodeList children = casedb.getDocumentElement().getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node child = children.item(i);
            if (child instanceof Element && "case".equals(child.getNodeName())
                    && caseTypes.contains(((Element)child).getAttribute("case_type"))) {
                root.appendChild(results.importNode(child, true));
            }
        }
        Transformer transformer = TransformerFactory.newInstance().newTransformer();
        transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
        transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        transformer.transform(new DOMSource(results), new StreamResult(out));
        return out.toString("UTF-8").getBytes(StandardCharsets.UTF_8);
    }

    private static JSONObject strings(Hashtable<String, String> table) throws Exception {
        JSONObject found = new JSONObject();
        for (Map.Entry<String, String> entry : new TreeMap<>(table).entrySet()) {
            found.put(entry.getKey(), entry.getValue());
        }
        return found;
    }

    private static JSONObject params(Multimap<String, String> params) throws Exception {
        JSONObject found = new JSONObject();
        for (String key : new java.util.TreeSet<>(params.keySet())) {
            found.put(key, new JSONArray(params.get(key)));
        }
        return found;
    }

    /** An address as written, for a record: unchanged. */
    static String address(String url) {
        return url;
    }
}
