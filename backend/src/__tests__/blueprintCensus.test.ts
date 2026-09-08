import fs from 'fs';
import path from 'path';
import { creationSqlFindings,creationCallFindings,builderFindings,detachedReaderFindings,propagationRouteFindings,SourceUnit } from './helpers/blueprintCensus';

const sourceRoot=path.resolve(__dirname,'..');
const read=(relative:string):SourceUnit=>({name:relative,text:fs.readFileSync(path.join(sourceRoot,relative),'utf8')});
const implementation=read('services/BlueprintInstantiationService.ts');
function productionSources(directory=sourceRoot,root=sourceRoot,prefix=''):SourceUnit[]{
 return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const full=path.join(directory,entry.name);
  if(entry.isDirectory())return ['__tests__','node_modules','dist'].includes(entry.name)?[]:productionSources(full,root,prefix);
  if(!/\.tsx?$/.test(entry.name)||entry.name.endsWith('.d.ts')||/\.(test|spec)\.tsx?$/.test(entry.name))return [];
  return [{name:prefix+path.relative(root,full).replace(/\\/g,'/'),text:fs.readFileSync(full,'utf8')}];
 });
}
const corpus=productionSources();
const frontendRoot=path.resolve(sourceRoot,'../../frontend/src');
const frontend=productionSources(frontendRoot,frontendRoot,'frontend/src/');
const fixtures=path.join(__dirname,'fixtures','blueprint-census');
const fixture=(name:string,sourceName='services/Example.ts'):SourceUnit=>({name:sourceName,text:fs.readFileSync(path.join(fixtures,name+'.ts.fixture'),'utf8')});

describe('Blueprint semantic census production controls',()=>{
 test('D2 canonical imports and no direct work-plane SQL',()=>expect(creationSqlFindings(implementation)).toEqual([]));
 test('D5 exact admitted service and helper call identities',()=>expect(creationCallFindings(implementation)).toEqual([]));
 test('D16 each entry point uses exactly the shared plan builder',()=>expect(builderFindings(implementation)).toEqual([]));
 test('D8 reader whole production corpus excludes postcommit Blueprint bodies',()=>{
  expect(corpus.length).toBeGreaterThan(200);
  for(const file of ['services/ProjectService.ts','services/PhaseService.ts','services/TaskManagerDB.ts','services/ReportManager.ts','utils/blueprintProvenance.ts','routes/blueprints.ts'])expect(corpus.some(unit=>unit.name===file)).toBe(true);
  expect(frontend.some(unit=>unit.name==='frontend/src/components/projects/ProjectDetailModal.tsx')).toBe(true);
  expect(frontend.length).toBeGreaterThan(100);
  expect(detachedReaderFindings([...corpus,...frontend])).toEqual([]);
 });
 test('D8 route whole production corpus excludes propagation carriers',()=>expect(propagationRouteFindings(corpus)).toEqual([]));
});

const controls=[
 ['sql-direct','D2_DIRECT_WORK_WRITE','sql'],['sql-concatenated','D2_DIRECT_WORK_WRITE','sql'],
 ['sql-destructured','D2_DIRECT_WORK_WRITE','sql'],['sql-bound-alias','D2_DIRECT_WORK_WRITE','sql'],
 ['sql-dynamic','D2_OPAQUE_SQL','sql'],['sql-dynamic-method','D2_OPAQUE_DATABASE_CALL','sql'],
 ['sql-reassigned','D2_OPAQUE_SQL','sql'],
 ['service-alias','D5_UNAPPROVED_SERVICE_CALL','calls'],['service-destructured','D5_UNAPPROVED_SERVICE_CALL','calls'],
 ['service-dynamic','D5_UNAPPROVED_SERVICE_CALL','calls'],['service-new-verb','D5_UNAPPROVED_SERVICE_CALL','calls'],
 ['service-helper','D5_UNAPPROVED_SERVICE_CALL','calls'],
 ['service-module-spoof','D5_UNAPPROVED_SERVICE_CALL','calls'],
 ['service-reassigned','D5_UNAPPROVED_SERVICE_CALL','calls'],
 ['builder-replaced','D16_BUILDER_COUNT','builder'],['builder-additional','D16_SECOND_BUILDER','builder'],
 ['builder-nonplan-name','D16_ALTERNATE_PLAN_VALUE','builder'],
 ['reader-sql','D8_POSTCOMMIT_BODY_QUERY','reader'],['reader-alias','D8_POSTCOMMIT_BODY_QUERY','reader'],
 ['reader-registry-value','D8_POSTCOMMIT_BODY_VALUE','reader'],
 ['reader-approved-module-wrong-context','D8_POSTCOMMIT_BODY_QUERY','reader-context'],
 ['reader-after-commit','D8_POSTCOMMIT_BODY_QUERY','reader-context'],
 ['reader-destructured-body','D8_POSTCOMMIT_BODY_VALUE','reader'],
 ['reader-forwarding-helper','D8_POSTCOMMIT_REGISTRY_READ','reader'],
 ['reader-frontend','D8_FRONTEND_DOCUMENT_FETCH','frontend'],
 ['reader-frontend-wrong-context','D8_FRONTEND_DOCUMENT_FETCH','frontend-context'],
 ['reader-frontend-apply','D8_FRONTEND_INSTANCE_WRITE','frontend-context'],
 ['route-path','D8_PROPAGATION_ROUTE','routes'],['route-body','D8_PROPAGATION_ROUTE','routes'],
 ['route-named-handler','D8_PROPAGATION_ROUTE','routes'],
] as const;
describe('Blueprint census independently exercised negative controls',()=>{
 test('negative fixture inventory is closed and has one named predicate per case',()=>{
  const actual=fs.readdirSync(fixtures).filter(name=>name.endsWith('.ts.fixture')).map(name=>name.replace(/\.ts\.fixture$/,'')).sort();
  expect(actual).toEqual([...controls.map(row=>row[0]),'safe-aliases','safe-builder','safe-reader','safe-route'].sort());
  expect(controls).toHaveLength(30);
 });
 test.each(controls)('%s is flagged by the SAME production predicate (%s)',(name,code,kind)=>{
  const unit=fixture(name,kind==='reader-context'?'services/BlueprintInstantiationService.ts':kind==='frontend'?'frontend/src/components/projects/Provenance.tsx':kind==='frontend-context'?'frontend/src/pages/BlueprintsPage.tsx':'services/Example.ts');
  const findings=kind==='sql'?creationSqlFindings(unit):kind==='calls'?creationCallFindings(unit):kind==='builder'?builderFindings(unit):kind.startsWith('reader')||kind.startsWith('frontend')?detachedReaderFindings([unit]):propagationRouteFindings([unit]);
  expect(findings.map(row=>row.code)).toContain(code);
 });
 test('valid SQL and canonical call aliases are admitted',()=>{
  const unit=fixture('safe-aliases');expect(creationSqlFindings(unit)).toEqual([]);expect(creationCallFindings(unit)).toEqual([]);
 });
 test('exact shared builders under aliases are admitted',()=>expect(builderFindings(fixture('safe-builder'))).toEqual([]));
 test('ordinary stamp reads and ledger metadata are not document reads',()=>expect(detachedReaderFindings([fixture('safe-reader')])).toEqual([]));
 test('ordinary Task updates and registry discovery are not propagation',()=>expect(propagationRouteFindings([fixture('safe-route')])).toEqual([]));
});
