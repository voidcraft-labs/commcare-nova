package nova.proof.android;

import android.view.View;
import android.widget.LinearLayout;

import androidx.appcompat.app.AppCompatActivity;

import org.commcare.CommCareApplication;
import org.commcare.activities.EntitySelectActivity;
import org.commcare.adapters.EntityDetailAdapter;
import org.commcare.cases.entity.Entity;
import org.commcare.cases.entity.NodeEntityFactory;
import org.commcare.suite.model.Detail;
import org.commcare.cases.entity.EntityUtil;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.TreeReference;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What a case detail shows of one case, tab by tab, built as the app's own detail fragment builds a tab
 * (EntityDetailFragment.onCreateView): the tabs its pager offers (Detail.getDisplayableChildDetails under
 * EntityUtil.prepareCompoundEvaluationContext, each titled as EntityDetailPagerAdapter.getPageTitle titles it),
 * the case read by a NodeEntityFactory in the context EntityUtil.getEntityFactoryContext gives, and each field
 * the app's own adapter holds (EntityDetailAdapter, which leaves out a field the entity calls invalid) as its
 * own row view (EntityDetailView) shows it. The fragment itself sits in a pager Robolectric lays out no page
 * of, so it is the fragment's steps that run here, on the same classes.
 */
final class Details {
    private Details() {
    }

    static JSONArray read(AppCompatActivity activity, Detail detail, TreeReference reference) throws Exception {
        JSONArray tabs = new JSONArray();
        EvaluationContext session = CommCareApplication.instance().getCurrentSessionWrapper().getEvaluationContext();
        Detail[] shown = detail.isCompound()
                ? detail.getDisplayableChildDetails(EntityUtil.prepareCompoundEvaluationContext(reference, detail,
                CommCareApplication.instance().getCurrentSessionWrapper().getEvaluationContext()))
                : new Detail[]{detail};
        for (Detail tab : shown) {
            JSONObject found = new JSONObject();
            tabs.put(found);
            try {
                found.put("title", Screens.orNull(tab.getTitle() == null ? null
                        : tab.getTitle().getText().evaluate()));
                if (tab.getNodeset() != null) {
                    // A tab of a row per node (EntitySubnodeDetailFragment): named, its rows not read.
                    found.put("nodeset", true);
                    continue;
                }
                EvaluationContext context = EntityUtil.getEntityFactoryContext(reference, detail.isCompound(),
                        detail.isCompound() ? detail : null, session);
                context.addFunctionHandler(EntitySelectActivity.getHereFunctionHandler());
                Entity<TreeReference> entity = new NodeEntityFactory(tab, context).getEntity(reference);
                EntityDetailAdapter adapter = new EntityDetailAdapter(activity, tab, entity, null, 0, null);
                JSONArray fields = new JSONArray();
                LinearLayout parent = new LinearLayout(activity);
                for (int i = 0; i < adapter.getCount(); i++) {
                    View row = adapter.getView(i, null, parent);
                    JSONObject field = new JSONObject();
                    field.put("texts", Views.texts(row));
                    field.put("images", Views.images(row));
                    fields.put(field);
                }
                found.put("fields", fields);
            } catch (RuntimeException raised) {
                found.put("raised", raised.getClass().getName() + ": " + raised.getMessage());
            }
        }
        return tabs;
    }
}
