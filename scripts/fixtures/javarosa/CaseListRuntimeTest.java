package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.cases.entity.*;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.services.locale.*;
import org.junit.Test;
import org.junit.After;
import static org.junit.Assert.*;

/** Original artifacts from both producers execute through Core's node factory and sorter. */
public class CaseListRuntimeTest {
 private static final String[] SCENARIOS = {"local", "remote", "inline", "browse", "no-details", "match-none", "match-all", "unanswered"};
 private static final class Parser extends SuiteParser {
  Parser(InputStream input) throws IOException {super(input,null,"nova-case-list",null,true,true,false);}
 }
 private Suite suite(String name, boolean hq) throws Exception {
  LocalizerManager.clearInstance(); LocalizerManager.init(true);
  Hashtable<String,String> values;
  try (InputStream input=getClass().getResourceAsStream("/"+name+(hq?".hq":"")+".properties")) {assertNotNull(name,input);values=LocalizationUtils.parseLocaleInput(input);}
  Localizer localizer=LocalizerManager.getGlobalLocalizer(); localizer.addAvailableLocale("en"); localizer.registerLocaleResource("en",new TableLocaleSource(values)); localizer.setLocale("en");
  try (InputStream input=getClass().getResourceAsStream("/"+name+(hq?".hq-suite.xml":".suite.xml"))) {assertNotNull(name,input); return new Parser(input).parse();}
 }
 private static TreeElement node(String name,String value) {TreeElement n=new TreeElement(name,0);if(value!=null)n.setValue(new StringData(value));return n;}
 private static final class Data extends TestInstanceInitializer {
  final boolean tied;
  Data() {this(false);}
  Data(boolean tied) {this(MockDataUtils.getStaticStorage(),tied);}
  private Data(MockUserDataSandbox sandbox,boolean tied) {
   super(sandbox);this.tied=tied;
   for(int i=1;i<=7;i++) {
    Case c=new Case(i==2?"Zulu":i==3?"Alpha":"Patient "+i,i==7?"other":"patient");c.setCaseId("p"+i);c.setClosed(i==6);c.setUserId(i==5?"excluded":"allowed");
    c.setProperty("code",i==4?"b":"a"); c.setProperty("birthdate","2000-02-29"); c.setProperty("phone","+15551234"); c.setProperty("website","https://example.org/a?x=1&y=2"); c.setProperty("weight",i==1||i==3&&!tied?"10.5":"2.25");
    c.setIndex(new CaseIndex("parent","household",i==1?"h1":"h2")); sandbox.getCaseStorage().write(c);
   }
   for(int i=1;i<=2;i++){Case c=new Case("Home "+i,"household");c.setCaseId("h"+i);c.setProperty("rank",i==1?"2":"10");sandbox.getCaseStorage().write(c);}
  }
  @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
   String id=instance.getInstanceId(); TreeElement root;
   if(id.equals("commcaresession")) {root=node("session",null);TreeElement user=node("user",null),values=node("data",null),data=node("data",null);values.addChild(node("excluded_owners"," \texcluded\n "));values.addChild(node("display_name","Worker & teammate"));user.addChild(values);data.addChild(node("case_id","p1"));root.addChild(user);root.addChild(data);}
   else if(id.equals("results")||id.equals("results:inline")) {
    root=node("results",null);
    for(int i=1;i<=3;i++) {TreeElement c=new TreeElement("case",i-1);c.setAttribute(null,"case_id","p"+i);c.setAttribute(null,"case_type","patient");c.setAttribute(null,"status","open");c.addChild(node("case_name",i==2?"Zulu":i==3?"Alpha":"Remote "+i));c.addChild(node("code",i==2?"a b":i==3?"unknown":"a"));c.addChild(node("birthdate",i==3?"":"2000-02-29"));c.addChild(node("phone","+15551234"));c.addChild(node("website",i==3?"":"https://example.org/a?x=1&y=2"));c.addChild(node("weight",i==1||i==3&&!tied?"10.5":"2.25"));TreeElement index=node("index",null),parent=node("parent",i==1?"h1":"h2");parent.setAttribute(null,"relationship","child");index.addChild(parent);c.addChild(index);root.addChild(c);}
    for(int i=1;i<=2;i++){TreeElement c=new TreeElement("case",i+2);c.setAttribute(null,"case_id","h"+i);c.setAttribute(null,"case_type","household");c.addChild(node("rank",i==1?"20":"3"));c.addChild(node("commcare_is_related_case","true"));root.addChild(c);}
   } else return super.generateRoot(instance);
   InstanceUtils.setUpInstanceRoot(root,id,instance.getBase());return new ConcreteInstanceRoot(root);
  }
  EvaluationContext context(Entry entry) {Hashtable<String,DataInstance> instances=entry.getInstances(null);for(String id:new ArrayList<>(instances.keySet()))instances.put(id,instances.get(id).initialize(this,id));return new EvaluationContext(null,instances);}
 }
 @After public void cleanup(){LocalizerManager.clearInstance();}
 private static String command(String scenario) {return scenario.equals("browse")||scenario.equals("no-details")?"m0-case-list":scenario.equals("remote")?"search_command.m0":"m0-f0";}
 private static EntityDatum selection(Entry entry) {for(SessionDatum datum:entry.getSessionDataReqs())if(datum instanceof EntityDatum)return (EntityDatum)datum;throw new AssertionError("No case selection");}
 private static List<String> ids(List<Entity<TreeReference>> entities,EvaluationContext context) {List<String> ids=new ArrayList<>();for(Entity<TreeReference> e:entities)ids.add((String)context.resolveReference(e.getElement()).getAttribute(null,"case_id").getValue().getValue());return ids;}
 @Test public void typedSortUsesTheDisplayedCaseSourceAndHiddenDecimalThenNameTies() throws Exception {
  for(String scenario:new String[]{"local","remote","inline"}) for(boolean hq:new boolean[]{false,true}) for(boolean tied:new boolean[]{false,true}) {
   Suite suite=suite(scenario,hq);Entry entry=suite.getEntry(command(scenario));EvaluationContext context=new Data(tied).context(entry);Detail detail=suite.getDetail(selection(entry).getShortDetail());
   List<Entity<TreeReference>> entities=new ArrayList<>();NodeEntityFactory factory=new NodeEntityFactory(detail,context);for(TreeReference ref:context.expandReference(selection(entry).getNodeset()))entities.add(factory.getEntity(ref));
   assertEquals(9,detail.getFields().length);
   for(Entity<TreeReference> entity:entities)assertEquals(scenario+" hq="+hq,entity.getFieldString(7),entity.getSortField(7));
   List<Integer> indices=new ArrayList<>();for(int i=0;i<detail.getFields().length;i++)if(detail.getFields()[i].getSortOrder()>0)indices.add(i);indices.sort(Comparator.comparingInt(i->detail.getFields()[i].getSortOrder()));
   entities.sort(new EntitySorter(detail.getFields(),false,indices.stream().mapToInt(i->i).toArray(),args->{throw new AssertionError(Arrays.toString(args));}));
   assertEquals(scenario+" hq="+hq,scenario.equals("local")?(tied?Arrays.asList("p3","p2","p1"):Arrays.asList("p2","p3","p1")):(tied?Arrays.asList("p1","p3","p2"):Arrays.asList("p1","p2","p3")),ids(entities,context));
  }
 }
 @Test public void templatesResolveFormatsLocalesRelationsAndIndependentDetailOrder() throws Exception {
  for(String scenario:new String[]{"local","remote","inline","browse"})for(boolean hq:new boolean[]{false,true}) {
   Suite suite=suite(scenario,hq);Entry entry=suite.getEntry(command(scenario));EvaluationContext context=new Data().context(entry);EntityDatum selected=selection(entry);TreeReference first=context.expandReference(selected.getNodeset()).get(0);Detail shortDetail=suite.getDetail(selected.getShortDetail()),longDetail=suite.getDetail(selected.getLongDetail());
   Entity<TreeReference> row=new NodeEntityFactory(shortDetail,context).getEntity(first);boolean remote=scenario.equals("remote")||scenario.equals("inline");
   assertEquals(remote?"Remote 1":"Patient 1",row.getFieldString(0));assertEquals("2000-02-29",row.getFieldString(1));assertEquals("+15551234",row.getFieldString(2));assertEquals("[Open & read](https://example.org/a?x=1&y=2)",row.getFieldString(3));assertEquals("Active & ready ",row.getFieldString(4));assertEquals("jr://file/commcare/50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d.png",row.getFieldString(5));assertEquals("Old",row.getFieldString(6));assertEquals(remote?"20":"2",row.getFieldString(7));assertEquals("0",shortDetail.getFields()[8].getTemplateWidthHint());
   if(remote){List<TreeReference> refs=context.expandReference(selected.getNodeset());Entity<TreeReference> second=new NodeEntityFactory(shortDetail,context).getEntity(refs.get(1)),third=new NodeEntityFactory(shortDetail,context).getEntity(refs.get(2));assertEquals("Active & ready Paused",second.getFieldString(4));assertEquals("",third.getFieldString(1));assertEquals("",third.getFieldString(3));assertEquals(" ",third.getFieldString(4));assertEquals("",third.getFieldString(5));assertEquals("Old",third.getFieldString(6));}
   Entity<TreeReference> details=new NodeEntityFactory(longDetail,context).getEntity(first);assertEquals(9,details.getNumFields());assertEquals("Worker & teammate",details.getFieldString(0));assertEquals(row.getFieldString(7),details.getFieldString(1));for(int i=0;i<7;i++)assertEquals(row.getFieldString(6-i),details.getFieldString(i+2));
  }
 }
 @Test public void nodesetsAndBrowseNavigationHaveReachableIndependentSemantics() throws Exception {
  for(String scenario:SCENARIOS)for(boolean hq:new boolean[]{false,true}) {
   Suite suite=suite(scenario,hq);Entry entry=suite.getEntry(command(scenario));assertNotNull(entry);EvaluationContext context=new Data().context(entry);EntityDatum selected=selection(entry);List<Entity<TreeReference>> entities=new ArrayList<>();NodeEntityFactory factory=new NodeEntityFactory(suite.getDetail(selected.getShortDetail()),context);for(TreeReference ref:context.expandReference(selected.getNodeset()))entities.add(factory.getEntity(ref));
   List<String> expected=scenario.equals("match-none")?Collections.emptyList():scenario.equals("match-all")||scenario.equals("unanswered")?Arrays.asList("p1","p2","p3","p4"):Arrays.asList("p1","p2","p3");assertEquals(scenario+" hq="+hq,expected,ids(entities,context));
   assertEquals(scenario.equals("no-details")?null:"m0_"+(scenario.equals("remote")?"search":"case")+"_long",selected.getLongDetail());
   if(scenario.equals("browse")||scenario.equals("no-details")){assertNull(entry.getXFormNamespace());assertEquals("Patients & visits",entry.getDisplayText(context));}
  }
 }
}
