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
import org.robolectric.shadows.ShadowLooper;

/**
 * What a case detail shows of one case, tab by tab, built as the app's own detail fragment builds a tab
 * (EntityDetailFragment.onCreateView): the tabs its pager offers (Detail.getDisplayableChildDetails under
 * EntityUtil.prepareCompoundEvaluationContext, each titled as EntityDetailPagerAdapter.getPageTitle titles it),
 * the case read by a NodeEntityFactory in the context EntityUtil.getEntityFactoryContext gives, and each field
 * the app's own adapter holds (EntityDetailAdapter, which leaves out a field the entity calls invalid) as its
 * own row view (EntityDetailView) shows it. The fragment itself sits in a pager Robolectric lays out no page
 * of, so it is the fragment's steps that run here, on the same classes.
 *
 * A tab that lists a row a node (a detail with a nodeset) is the app's own fragment for it
 * (EntitySubnodeDetailFragment), made by the screen's own pager adapter (EntityDetailPagerAdapter.createFragment)
 * and shown on the screen, where it loads its rows as it does in the pager (its EntityLoaderTask over the
 * nodeset in the case's context) and lays them out with its own adapter (EntitySubnodeDetailAdapter): its
 * header and each row are read as shown and drawn.
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
                    found.put("nodeset", true);
                    found.put("rows", nodeRows(activity, tabs.length() - 1));
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

    // How long a tab's rows may take to load before the reader says they did not.
    private static final long LOAD_MILLIS = 120_000;

    /**
     * The rows of the tab at {@code position} of the screen's detail, as the app's own fragment for a tab of a
     * row per node loads and shows them (the class's last paragraph); what was raised where the screen holds no
     * detail pager or the fragment failed.
     */
    private static Object nodeRows(AppCompatActivity activity, int position) throws Exception {
        Object view = null;
        for (String name : new String[]{"mDetailView", "detailView"}) {
            try {
                view = Screens.field(activity, name);
                break;
            } catch (NoSuchFieldException absent) {
                // The other screen's name.
            }
        }
        if (!(view instanceof org.commcare.views.TabbedDetailView)) {
            return "the screen holds no detail pager";
        }
        androidx.viewpager2.widget.ViewPager2 pager =
                (androidx.viewpager2.widget.ViewPager2)Screens.field(view, "mViewPager");
        org.commcare.adapters.EntityDetailPagerAdapter adapter =
                (org.commcare.adapters.EntityDetailPagerAdapter)pager.getAdapter();
        androidx.fragment.app.Fragment fragment = adapter.createFragment(position);
        activity.getSupportFragmentManager().beginTransaction()
                .add(android.R.id.content, fragment, "proof-node-rows").commitNow();
        try {
            long deadline = System.nanoTime() + LOAD_MILLIS * 1_000_000L;
            while (Screens.field(fragment, "adapter") == null) {
                Object loader = Screens.field(fragment, "loader");
                if (loader instanceof android.os.AsyncTask) {
                    ((android.os.AsyncTask<?, ?, ?>)loader).get(LOAD_MILLIS, java.util.concurrent.TimeUnit.MILLISECONDS);
                }
                ShadowLooper.idleMainLooper();
                if (System.nanoTime() > deadline) {
                    throw new IllegalStateException("A tab's rows did not load within " + LOAD_MILLIS / 1000 + " s.");
                }
            }
            android.widget.ListView list = (android.widget.ListView)Screens.field(fragment, "listView");
            android.widget.ListAdapter rows = list.getAdapter();
            JSONObject found = new JSONObject();
            View header = fragment.getView() == null ? null
                    : fragment.getView().findViewById(org.commcare.dalvik.R.id.entity_detail_header);
            found.put("header", header == null ? JSONObject.NULL : Views.texts(header));
            JSONArray shown = new JSONArray();
            int width = Views.screenWidth();
            for (int i = 0; i < rows.getCount(); i++) {
                View row = rows.getView(i, null, list);
                JSONObject entry = new JSONObject();
                entry.put("texts", Views.texts(row));
                entry.put("images", Views.images(row));
                entry.put("drawn", Views.drawn(row, width));
                shown.put(entry);
            }
            found.put("rows", shown);
            return found;
        } finally {
            activity.getSupportFragmentManager().beginTransaction().remove(fragment).commitNowAllowingStateLoss();
        }
    }
}
