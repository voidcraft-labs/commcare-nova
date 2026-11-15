package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.modern.util.Pair;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.LoggerInterface;
import org.commcare.util.mocks.*;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.Constants;
import org.javarosa.core.model.User;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Core's own menu listing, its case-first question and its after-submit frames over the menus Nova writes for
 * menus that show their forms in the menu above, on Nova's local suite and on HQ's build alike: each screen lists
 * what Preview shows there (`menuProjection.ts::previewScreenEntryVisibility` over `menuScreens.ts::menuScreenEntries`,
 * written by the producer), in order, for a worker holding each role a display condition compares, so every condition
 * is read holding and not, a submenu's rows carrying its parent's (a row its own condition admits and its parent's
 * refuses is left off, which the producer names in `parentHides`), each screen read as a device reaches it: with no
 * case chosen, or, where the screen chooses a case first, once Core has asked for it and been given each case of its
 * type the device holds; a screen whose condition reads a user field the worker's device lacks fails whole exactly
 * where Preview refuses it (the worker-data documents, read for a list of workers' data rather than roles, in a test of their own); choosing a menu asks for a case first exactly where Nova says the screen chooses a case
 * first and exactly where Preview opens a case list for it, submenus or not, and once that case is chosen Core lists
 * the screen, however many forms it shows, as `fill` holds (the menu-landings document holds each shape Preview once
 * read apart: a case-first menu with a submenu, a case list menu with a submenu, a case-first menu of one form, and
 * advanced menus whose entries ask for the datum each load's tag names, and a basic submenu under an advanced parent);
 * one step back from each case-loading form lands where Preview lands, the menu with the case held where the form was
 * chosen after its case and the case list where it was chosen before, and stepping on back to its case list and
 * choosing a case there opens the form again exactly where Preview does (`stepBacks`); each
 * form with no destinations of its own lands
 * where Preview lands it (`frameLanding.ts::screenOfFrame` over its after-submit frame), every one of them: an entry
 * of a menu whose forms read the search is given the search's results and its claim as Core's own command-line
 * session gives them, and any other entry that asks for a search or a claim fails. The step-back control is the
 * fact Nova's refusal of a frame through a first menu that shares one case rests on. Core's in-memory case storage
 * stands in for a device's; no form is entered and no search or claim reaches a server. */
public class MenuScreensRuntimeTest {
 private static final String[] DOCUMENTS={"forms-in-menu-above","forms-in-menu-above-nested","forms-in-menu-above-registration-only","forms-in-menu-above-one-case","register-from-case-list","register-from-case-list-web-apps","register-from-case-list-other-returns","register-from-case-list-web-apps-other-returns","worker-place-read","worker-place-forms","worker-place-menus","undeclared-worker-field-control","menu-landings"};
 /** The documents read for a list of workers' data, each refusing some screen for a worker who lacks a field. */
 private static final String[] WORKER_DOCUMENTS={"worker-place-read","worker-place-forms","worker-place-menus","undeclared-worker-field-control"};
 private static final class Parser extends SuiteParser{Parser(InputStream in)throws IOException{super(in,null,"menu-screens-proof",null,true,true,false);}}
 private static final LoggerInterface FAIL=new LoggerInterface(){
  @Override public void logError(String message,Exception cause){fail(message);}
  @Override public void logError(String message){fail(message);}
 };
 static JSONObject json(String resource)throws IOException{
  try(InputStream in=MenuScreensRuntimeTest.class.getResourceAsStream(resource)){assertNotNull(resource,in);return new JSONObject(new String(in.readAllBytes(),StandardCharsets.UTF_8));}
 }
 static Suite suite(String document,boolean hq)throws Exception{
  String resource="/menu-screens/"+document+(hq?".hq-suite.xml":".suite.xml");
  try(InputStream in=MenuScreensRuntimeTest.class.getResourceAsStream(resource)){assertNotNull(resource,in);return new Parser(in).parse();}
 }
 /** A session on the suite for a signed-in worker whose device holds the given cases, each `{id, type}`, and whose
  * role is blank. */
 static SessionWrapper session(Suite suite,MockUserDataSandbox sandbox,String[]... cases){return session(suite,sandbox,new JSONObject().put("role",""),new JSONArray(),cases);}
 /** The same, the worker's data the listing's `user` (each user field the device holds, with its value), and the
  * device also holding the producer's `deviceCases`, each `{id, type, properties}`. The documents that compare the
  * role declare it as a worker property, which the setup list a publish shows names for someone to add on CommCare
  * HQ, and in a project space that defines it a worker with no value has it blank: HQ's restore gives every worker
  * each user field the project space defines, `''` where none is set (`user_data.py::UserData.to_dict`). A field the
  * data leaves out is one the device holds no key for: a place key of a worker assigned nowhere
  * (`models.py::get_user_session_data`), or a field the project space does not define. */
 static SessionWrapper session(Suite suite,MockUserDataSandbox sandbox,JSONObject user,JSONArray deviceCases,String[]... cases){
  User worker=new User("worker","","worker-id");
  for(String key:user.keySet())worker.setProperty(key,user.getString(key));
  sandbox.setLoggedInUser(worker);
  for(String[] seed:cases){Case c=new Case(seed[0],seed[1]);c.setCaseId(seed[0]);sandbox.getCaseStorage().write(c);}
  for(int i=0;i<deviceCases.length();i++){
   JSONObject held=deviceCases.getJSONObject(i);Case c=new Case(held.getString("id"),held.getString("type"));
   c.setCaseId(held.getString("id"));
   JSONObject properties=held.getJSONObject("properties");
   for(String name:properties.keySet())c.setProperty(name,properties.getString(name));
   sandbox.getCaseStorage().write(c);
  }
  CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);
  return new SessionWrapper(platform,sandbox);
 }
 /** Satisfy what the entry chosen last needs, a case with `caseId` for each selection, until it needs nothing.
  * Where the entry's menu has its forms read the search (`readsSearch`), the search is answered with an empty
  * result set (`RemoteQuerySessionManager.buildExternalDataInstance`, `CommCareSession.setQueryDatum`) and the
  * claim as having posted (`EXTRA_POST_SUCCESS`, as Core's `SyncScreen` marks it); anywhere else a search or a
  * claim is no step the entry should need. */
 static void fill(SessionWrapper session,String caseId,String label,boolean readsSearch)throws Exception{fill(session,caseId,label,readsSearch,false);}
 /** The same, for a menu that chooses a case first: until it asks for a command, which its screen then lists. */
 static void fill(SessionWrapper session,String caseId,String label,boolean readsSearch,boolean toMenu)throws Exception{
  for(int step=0;;step++){
   assertTrue(label+" needs more than ten values",step<10);
   EvaluationContext context=session.getEvaluationContext();
   String needed=session.getNeededData(context);
   if(!toMenu&&needed==null)return;
   assertNotNull(label+" opens an entry before it lists its menu",needed);
   if(toMenu&&needed.equals(SessionFrame.STATE_COMMAND_ID)){assertTrue(label+" asks for a command before a case",step>0);return;}
   if(needed.equals(SessionFrame.STATE_QUERY_REQUEST)||needed.equals(SessionFrame.STATE_SYNC_REQUEST))
    assertTrue(label+" needs "+needed+" in a menu whose forms do not read the search",readsSearch);
   if(needed.equals(SessionFrame.STATE_QUERY_REQUEST)){
    RemoteQuerySessionManager manager=RemoteQuerySessionManager.buildQuerySessionManager(session,context,new ArrayList<>());
    assertNotNull(label,manager);
    Pair<ExternalDataInstance,String> results=manager.buildExternalDataInstance(new ByteArrayInputStream("<results/>".getBytes(StandardCharsets.UTF_8)),"menu-screens-proof",com.google.common.collect.ArrayListMultimap.create());
    assertNotNull(label+": "+results.second,results.first);
    session.setQueryDatum(results.first);
   }
   else if(needed.equals(SessionFrame.STATE_SYNC_REQUEST))session.addExtraToCurrentFrameStep(Constants.EXTRA_POST_SUCCESS,true);
   else if(needed.equals(SessionFrame.STATE_DATUM_VAL))session.setEntityDatum(session.getNeededDatum().getDataId(),caseId);
   else if(needed.equals(SessionFrame.STATE_MULTIPLE_DATUM_VAL))session.setDatum(SessionFrame.STATE_MULTIPLE_DATUM_VAL,session.getNeededDatum().getDataId(),"selection-"+caseId);
   else if(needed.equals(SessionFrame.STATE_DATUM_COMPUTED))session.setComputedDatum(context);
   else fail(label+" needs "+needed);
  }
 }
 /** Each screen of a document's suite, local or HQ's, listed for each reading the producer wrote: what Core's
  * `MenuLoader` lists equals what Preview shows, or, where Preview refuses the screen, Core fails it whole. Returns
  * how many rows a parent's condition alone hid, and how many listings Core refused. */
 static int[] listEachScreen(String document,boolean hq)throws Exception{
  int parentHidden=0,refused=0;
  JSONObject evidence=json("/menu-screens/"+document+".screens.json");
  JSONArray screens=evidence.getJSONArray("screens"),deviceCases=evidence.getJSONArray("deviceCases");
  for(int i=0;i<screens.length();i++){
   JSONObject screen=screens.getJSONObject(i);String menuId=screen.getString("menuId");
   JSONArray listings=screen.getJSONArray("listings"),entries=screen.getJSONArray("entries");
   boolean readsSearch=false;
   for(int j=0;j<entries.length();j++)readsSearch|=entries.getJSONObject(j).getBoolean("readsSearch");
   for(int l=0;l<listings.length();l++){
    JSONObject listing=listings.getJSONObject(l);JSONObject user=listing.getJSONObject("user");
    String caseId=listing.isNull("caseId")?null:listing.getString("caseId");
    String label=document+" "+menuId+" user="+user+" case="+caseId+" hq="+hq;
    assertEquals(label+" is read with a case chosen exactly where it chooses one first",screen.getBoolean("asksCaseFirst"),caseId!=null);
    // Each worker reads its own parse of the suite, as a worker's device holds its own install: Core checks an
    // expression's path against the instance only until the check first passes and then never again
    // (`XPathPathExpr.templatePathChecked`), so a parse a worker holding the field has read would read the field as
    // blank for a worker who lacks it.
    SessionWrapper session=session(suite(document,hq),MockDataUtils.getStaticStorage(),user,deviceCases);
    // A screen that chooses a case first is listed once its case is chosen, as a device reaches it: Core asks for
    // the case before any command (`CommCareSession.getDataNeededByAllEntries`), and lists the menu after.
    if(caseId!=null){session.setCommand(menuId);fill(session,caseId,label,readsSearch,true);}
    List<String> expected=new ArrayList<>();JSONArray commands=listing.getJSONArray("commands");
    for(int j=0;j<commands.length();j++)expected.add(commands.getString(j));
    MenuLoader loader=new MenuLoader(session.getPlatform(),session,menuId,FAIL,false,false);
    // Where a condition the screen reads asks for a user field the device lacks, Core refuses the read
    // (`XPathNodeset.unpack` on a path `DataInstance.hasTemplatePath` misses) and the whole screen fails: the loader
    // lists nothing and holds the exception, which Formplayer and Android show in place of the menu
    // (`MenuScreen.init`, `MenuAdapter.showAnyLoadErrors`). Preview shows its refusal there, and lists elsewhere.
    if(listing.getBoolean("refused")){
     assertNotNull(label+" lists the screen, which Preview refuses",loader.getLoadException());
     assertEquals(label,0,loader.getMenus().length);
     refused++;
     continue;
    }
    assertNull(label,loader.getLoadException());
    List<String> listed=new ArrayList<>();for(MenuDisplayable displayable:loader.getMenus())listed.add(displayable.getCommandID());
    assertEquals(label,expected,listed);
    // A row of a submenu shown above that its own condition, where it has one, admits and its parent's refuses: the
    // menu's relevance carries the parent's condition (`menus.py::_generate_menu`), so Core leaves the row off.
    JSONArray parentHides=listing.getJSONArray("parentHides");
    for(int j=0;j<parentHides.length();j++){
     assertFalse(label+" lists "+parentHides.getString(j)+", which its parent's condition hides",listed.contains(parentHides.getString(j)));
     parentHidden++;
    }
   }
  }
  return new int[]{parentHidden,refused};
 }
 @Test public void eachScreenListsWhatNovaSaysAndAsksForACaseFirstWhereNovaSays()throws Exception{
  int parentHidden=0;
  for(String document:DOCUMENTS)for(boolean hq:new boolean[]{false,true}){
   if(!Arrays.asList(WORKER_DOCUMENTS).contains(document))parentHidden+=listEachScreen(document,hq)[0];
   Suite suite=suite(document,hq);
   JSONArray screens=json("/menu-screens/"+document+".screens.json").getJSONArray("screens");
   for(int i=0;i<screens.length();i++){
    JSONObject screen=screens.getJSONObject(i);String menuId=screen.getString("menuId");
    if(menuId.equals("root"))continue;
    String label=document+" "+menuId+" hq="+hq;
    SessionWrapper session=session(suite,MockDataUtils.getStaticStorage());
    session.setCommand(menuId);
    String needed=session.getNeededData(session.getEvaluationContext());
    // A menu whose forms read the search asks for its search, whose result is the case chosen, before any form.
    boolean asksCase=SessionFrame.STATE_DATUM_VAL.equals(needed)||SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(needed)||SessionFrame.STATE_QUERY_REQUEST.equals(needed);
    assertEquals(label,screen.getBoolean("asksCaseFirst"),asksCase);
    // Choosing the menu opens a case list in Preview exactly where Core asks for a case, submenus or not: Core lists
    // nothing of the screen, a submenu's tile included, before its case (`navigation.ts::moduleLanding`, the
    // producer's `landsOnCaseList`).
    assertEquals(label+" opens on a case list in Preview",screen.getBoolean("landsOnCaseList"),asksCase);
   }
  }
  // Some listing, on both paths, holds a submenu's row its parent's condition alone hides.
  assertTrue("rows a parent's condition alone hides: "+parentHidden,parentHidden>=2);
 }
 /** The worker-data documents, read for a list of workers' data rather than roles: a screen whose condition reads a
  * user field the worker's device lacks (a place key of a worker assigned nowhere, a field the project space does not
  * define) fails whole in Core exactly where Preview refuses it, and lists what Preview lists for every other worker.
  * Each document refuses some screen on both suites: a menu's tile (`worker-place-read`), a case-first menu's form
  * once its case is chosen (`worker-place-forms`), a form shown on the first menu, a submenu's form shown in its
  * parent's screen and a submenu's tile (`worker-place-menus`), and an undeclared field (the control). Its own test,
  * so a failure elsewhere in the family never leaves it unread. */
 @Test public void aScreenThatReadsAUserFieldTheDeviceLacksFailsWhereNovaSays()throws Exception{
  for(String document:WORKER_DOCUMENTS)for(boolean hq:new boolean[]{false,true})
   assertTrue(document+" hq="+hq+" refuses no screen",listEachScreen(document,hq)[1]>0);
 }
 /** Steps back from where the session stands, as a device's Back reaches the case list, until the session asks for a
  * case (`CommCareSession.stepBack`), chooses `caseId` there, and returns the command the session then opens, or null
  * where it asks for a command, which lists the menu. */
 static String afterStepBack(SessionWrapper session,String caseId,String label){
  for(int step=0;;step++){
   assertTrue(label+" never asks for a case stepping back",step<6);
   String needed=session.getNeededData(session.getEvaluationContext());
   if(SessionFrame.STATE_DATUM_VAL.equals(needed)){session.setEntityDatum(session.getNeededDatum().getDataId(),caseId);break;}
   if(SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(needed)){session.setDatum(SessionFrame.STATE_MULTIPLE_DATUM_VAL,session.getNeededDatum().getDataId(),"selection-"+caseId);break;}
   session.stepBack(session.getEvaluationContext());
  }
  String needed=session.getNeededData(session.getEvaluationContext());
  if(needed==null)return session.getCommand();
  assertEquals(label+" asks for something other than a command once the case is chosen again",SessionFrame.STATE_COMMAND_ID,needed);
  return null;
 }
 /** A worker chooses each case-loading form as its screen offers it, after the case where the screen chooses its case
  * first and before any case elsewhere, and steps back once: Core stops on the menu with the case still held where the
  * form's command sits above the case (`shouldPopNext` stops where the session waits for a command), which a device
  * shows (Android's `MenuActivity` after `stepBack`, Web Apps' selections less the form), and on the case list where it
  * sits beneath the case, and Preview lands on the same screen (`oneStepBack`: `menuProjection.ts::
  * previewCaseListHeldChoices` on a list's own form menu, `moduleScreenLanding` on a menu screen). Stepping back on
  * to the case list and choosing a case again, Core opens the form where its command sits beneath the case and asks
  * for a command, listing the menu, where it sits above it, and Preview does the same
  * (`previewCaseListReturn`, `previewCaseListFormRequest`, the producer's `stepBacks`). */
 @Test public void eachStepBackFromAFormContinuesWherePreviewDoes()throws Exception{
  int afterCase=0,beforeCase=0;
  for(String document:DOCUMENTS)for(boolean hq:new boolean[]{false,true}){
   Suite suite=suite(document,hq);
   JSONArray screens=json("/menu-screens/"+document+".screens.json").getJSONArray("screens");
   for(int i=0;i<screens.length();i++){
    JSONObject screen=screens.getJSONObject(i);String menuId=screen.getString("menuId");
    boolean caseFirst=screen.getBoolean("asksCaseFirst");
    JSONArray stepBacks=screen.getJSONArray("stepBacks");
    for(int j=0;j<stepBacks.length();j++){
     JSONObject stepBack=stepBacks.getJSONObject(j);
     String command=stepBack.getString("command"),caseId=stepBack.getString("caseId");
     String label=document+" "+menuId+" "+command+" hq="+hq;
     SessionWrapper session=session(suite,MockDataUtils.getStaticStorage());
     if(!menuId.equals("root"))session.setCommand(menuId);
     if(caseFirst){fill(session,caseId,label,false,true);afterCase++;}else beforeCase++;
     session.setCommand(command);
     fill(session,caseId,label,false);
     session.stepBack(session.getEvaluationContext());
     String needed=session.getNeededData(session.getEvaluationContext());
     String landed=SessionFrame.STATE_COMMAND_ID.equals(needed)?"menu":SessionFrame.STATE_DATUM_VAL.equals(needed)||SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(needed)?"case-list":needed;
     assertEquals(label+" one step back",stepBack.getString("oneStepBack"),landed);
     if(landed.equals("menu"))
      assertTrue(label+" lets go of the case on the menu one step back",session.getData().containsValue(caseId)||session.getData().containsValue("selection-"+caseId));
     String expected=stepBack.isNull("afterStepBack")?null:stepBack.getString("afterStepBack");
     assertEquals(label+" after a step back to its case list",expected,afterStepBack(session,caseId,label));
    }
   }
  }
  // Both ways a form is chosen are read, on both paths.
  assertTrue("step backs from a form chosen after its case: "+afterCase,afterCase>=4);
  assertTrue("step backs from a form chosen before its case: "+beforeCase,beforeCase>=4);
 }
 @Test public void eachFormLandsWhereItsAfterSubmitSays()throws Exception{
  int landed=0,searched=0;
  for(String document:DOCUMENTS)for(boolean hq:new boolean[]{false,true}){
   Suite suite=suite(document,hq);
   JSONArray screens=json("/menu-screens/"+document+".screens.json").getJSONArray("screens");
   for(int i=0;i<screens.length();i++){
    JSONArray entries=screens.getJSONObject(i).getJSONArray("entries");
    for(int j=0;j<entries.length();j++){
     JSONObject entry=entries.getJSONObject(j);
     if(!entry.getString("kind").equals("form")||!entry.has("landsOn"))continue;
     String command=entry.getString("command");String label=document+" "+command+" hq="+hq;
     SessionWrapper session=session(suite,MockDataUtils.getStaticStorage());
     session.setCommand(command);
     fill(session,"case-one",label,entry.getBoolean("readsSearch"));
     landed++;if(entry.getBoolean("readsSearch"))searched++;
     // The answer says whether a frame is left to run, which Home and the first menu need not leave: where none is,
     // the platform ends the session and starts again at its first menu, with no command
     // (`MenuSessionRunnerService.executeAndRebuildSession`, `AndroidSessionWrapper.terminateSession`).
     boolean frameLeft=session.finishExecuteAndPop(session.getEvaluationContext());
     String expected=entry.isNull("landsOn")?null:entry.getString("landsOn");
     assertEquals(label,expected,frameLeft?session.getCommand():null);
    }
   }
  }
  // Every form of every document lands, on both paths, those of the menus whose forms read the search among them.
  assertTrue("forms landed: "+landed,landed>40);
  assertTrue("forms of a menu whose forms read the search landed: "+searched,searched>0);
 }
 /** Two top-level menus show their follow-up forms on the first menu, of case types alpha and beta, so every
  * form there opens one chosen case; an ordinary alpha menu's form links to the alpha form above. The link's
  * frame holds the alpha case ahead of the form's command, and once the worker steps back from that form, Core
  * keeps the case: choosing the ordinary beta menu asks for a form and never for a beta case, and the beta form
  * opens on the alpha case. Nova's gate refuses the link (`FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE`). */
 @Test public void aFrameThroughAFirstMenuThatSharesOneCaseLeavesItsCaseForTheNextForm()throws Exception{
  for(boolean hq:new boolean[]{false,true}){
   String label="step-back-control hq="+hq;
   SessionWrapper session=session(suite("step-back-control",hq),MockDataUtils.getStaticStorage(),new String[]{"alpha-case","alpha"},new String[]{"beta-case","beta"});
   // The ordinary alpha menu asks for its case first, then for its one form (`CommCareSession.getNeededData`: a menu
   // command names no entry of its own).
   session.setCommand("m2");
   assertEquals(label,SessionFrame.STATE_DATUM_VAL,session.getNeededData(session.getEvaluationContext()));
   session.setEntityDatum(session.getNeededDatum().getDataId(),"alpha-case");
   assertEquals(label,SessionFrame.STATE_COMMAND_ID,session.getNeededData(session.getEvaluationContext()));
   session.setCommand("m2-f0");
   assertNull(label,session.getNeededData(session.getEvaluationContext()));
   assertEquals(label,"m2-f0",session.getCommand());
   assertTrue(label,session.finishExecuteAndPop(session.getEvaluationContext()));
   assertEquals(label,"m0-f0",session.getCommand());
   assertEquals(label,"alpha-case",session.getData().get("case_id"));
   session.stepBack(session.getEvaluationContext());
   session.setCommand("m3");
   assertEquals(label,SessionFrame.STATE_COMMAND_ID,session.getNeededData(session.getEvaluationContext()));
   session.setCommand("m3-f0");
   assertNull(label,session.getNeededData(session.getEvaluationContext()));
   assertEquals(label,"alpha-case",session.getData().get("case_id"));
  }
 }
}
