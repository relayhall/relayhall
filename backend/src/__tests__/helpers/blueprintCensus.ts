/** Bounded static oracle. It resolves lexical aliases and destructured/computed
 * members, folds SQL constants, and reports unsupported sensitive call forms.
 * It does not execute production modules or claim to prove database effects. */
import ts from 'typescript';
import path from 'path';

export interface SourceUnit { name: string; text: string }
export interface Finding { file: string; line: number; code: string; detail: string }
interface Entity { root: string; members: string[]; module?: string; opaque?: boolean }
interface Binding { value?: ts.Expression; property?: string; imported?: Entity; parameter?: string; body?: ts.Node; reassigned?: boolean }
const cleanName = (value:string) => value.replace(/\\/g,'/');
const unwrap = (node:ts.Expression):ts.Expression => ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node)||ts.isAwaitExpression(node) ? unwrap(node.expression) : node;
const isScope = (n:ts.Node) => ts.isSourceFile(n)||ts.isBlock(n)||ts.isFunctionLike(n);

export class ParsedSource {
 readonly file:ts.SourceFile;
 readonly calls:ts.CallExpression[]=[];
 readonly imports=new Map<string,Entity>();
 private scopes=new Map<ts.Node,Map<string,Binding>>();
 private fields=new Map<string,Entity>();
 constructor(readonly unit:SourceUnit) {
  this.file=ts.createSourceFile(unit.name,unit.text,ts.ScriptTarget.Latest,true,unit.name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const scope=(n:ts.Node):ts.Node=>{let p=n.parent;while(p&&!isScope(p))p=p.parent;return p||this.file};
  const add=(where:ts.Node,name:string,binding:Binding)=>{if(!this.scopes.has(where))this.scopes.set(where,new Map());this.scopes.get(where)!.set(name,binding)};
  const assignments:ts.Identifier[]=[];
  const walk=(n:ts.Node)=>{
   if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)&&n.importClause){
    const specifier=n.moduleSpecifier.text,clause=n.importClause;
    const module=specifier.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(cleanName(unit.name)),specifier)):specifier;
    const register=(local:string,root:string)=>{const entity={root,members:[],module};this.imports.set(local,entity);add(this.file,local,{imported:entity})};
    if(clause.name)register(clause.name.text,'default');
    if(clause.namedBindings){if(ts.isNamespaceImport(clause.namedBindings))register(clause.namedBindings.name.text,'*');else for(const el of clause.namedBindings.elements)register(el.name.text,el.propertyName?.text||el.name.text)}
   }
   if(ts.isVariableDeclaration(n)){
    if(ts.isIdentifier(n.name))add(scope(n),n.name.text,{value:n.initializer});
    else if(ts.isObjectBindingPattern(n.name))for(const el of n.name.elements)if(ts.isIdentifier(el.name))add(scope(n),el.name.text,{value:n.initializer,property:el.propertyName&&ts.isIdentifier(el.propertyName)?el.propertyName.text:el.name.text});
   }
   if(ts.isFunctionDeclaration(n)&&n.name)add(scope(n),n.name.text,{body:n.body});
   if(ts.isParameter(n)&&ts.isIdentifier(n.name)){
    const type=n.type&&ts.isTypeReferenceNode(n.type)?n.type.typeName.getText(this.file):undefined;
    add(n.parent,n.name.text,{parameter:type||n.name.text});
    if(n.modifiers?.some(m=>[ts.SyntaxKind.PrivateKeyword,ts.SyntaxKind.PublicKeyword,ts.SyntaxKind.ProtectedKeyword,ts.SyntaxKind.ReadonlyKeyword].includes(m.kind))&&type)this.fields.set(n.name.text,{root:type,members:[],module:this.imports.get(type)?.module});
   }
   if(ts.isCallExpression(n))this.calls.push(n);
   if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isIdentifier(n.left))assignments.push(n.left);
   ts.forEachChild(n,walk);
  };walk(this.file);
  for(const identifier of assignments){const b=this.binding(identifier.text,identifier);if(b)b.reassigned=true}
 }
 private binding(name:string,at:ts.Node):Binding|undefined {for(let p:ts.Node|undefined=at;p;p=p.parent){const b=this.scopes.get(p)?.get(name);if(b)return b}return undefined}
 handler(node:ts.Expression):ts.Node|undefined {node=unwrap(node);if(ts.isIdentifier(node)){const b=this.binding(node.text,node);return b?.body||b?.value}return undefined}
 alternatives(node:ts.Expression|undefined,seen=new Set<ts.Node>()):string[]{
  if(!node||seen.has(node))return ['?'];node=unwrap(node);const next=new Set(seen).add(node);
  if(ts.isIdentifier(node)){const b=this.binding(node.text,node);return b?.reassigned?['?']:this.alternatives(b?.value,next)}
  if(ts.isConditionalExpression(node))return [...this.alternatives(node.whenTrue,next),...this.alternatives(node.whenFalse,next)];
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return this.alternatives(node.left,next).flatMap(a=>this.alternatives(node.right,next).map(b=>a+b)).slice(0,64);
  if(ts.isElementAccessExpression(node)){
   const base=unwrap(node.expression);
   if(ts.isObjectLiteralExpression(base))return base.properties.flatMap(p=>ts.isPropertyAssignment(p)?this.alternatives(p.initializer,next):['?']);
  }
  if(ts.isTemplateExpression(node)){
   let values=[node.head.text];for(const span of node.templateSpans)values=values.flatMap(a=>this.alternatives(span.expression,next).map(b=>a+b+span.literal.text)).slice(0,64);return values;
  }
  return [this.constant(node)??'?'];
 }
 constant(node:ts.Expression|undefined,seen=new Set<ts.Node>()):string|undefined {
  if(!node||seen.has(node))return undefined;node=unwrap(node);const next=new Set(seen).add(node);
  if(ts.isStringLiteralLike(node)||ts.isNumericLiteral(node))return node.text;
  if(ts.isIdentifier(node)){const b=this.binding(node.text,node);return b?.reassigned?undefined:this.constant(b?.value,next)}
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=this.constant(node.left,next),b=this.constant(node.right,next);return a===undefined||b===undefined?undefined:a+b}
  if(ts.isTemplateExpression(node)){let value=node.head.text;for(const span of node.templateSpans)value+=(this.constant(span.expression,next)??'?')+span.literal.text;return value}
  return undefined;
 }
 entity(node:ts.Expression,seen=new Set<ts.Node>()):Entity {
  node=unwrap(node);if(seen.has(node))return {root:'<cycle>',members:[],opaque:true};const next=new Set(seen).add(node);
  if(node.kind===ts.SyntaxKind.ThisKeyword)return {root:'this',members:[]};
  if(ts.isIdentifier(node)){
   const b=this.binding(node.text,node);if(b?.imported)return b.imported;
   if(b?.value){const resolved=this.entity(b.value,next);return {...resolved,opaque:resolved.opaque||b.reassigned,members:[...resolved.members,...(b.property?[b.property]:[])]}}
   if(b?.parameter)return {root:b.parameter,members:[]};
   return {root:node.text,members:[]};
  }
  if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
   const base=this.entity(node.expression,next);const member=ts.isPropertyAccessExpression(node)?node.name.text:this.constant(node.argumentExpression);
   if(base.root==='this'&&base.members.length===0&&member&&this.fields.has(member))return this.fields.get(member)!;
   if(base.root==='*'&&base.members.length===0&&member)return {...base,root:member};
   return {...base,members:[...base.members,member??'<dynamic>'],opaque:base.opaque||member===undefined};
  }
  if(ts.isCallExpression(node)){
   const callee=this.entity(node.expression,next);
   if(callee.members.at(-1)==='bind')return {...callee,members:callee.members.slice(0,-1)};
   return {...callee,members:[...callee.members,'()']};
  }
  if(ts.isNewExpression(node))return this.entity(node.expression,next);
  return {root:node.getText(this.file),members:[],opaque:true};
 }
 finding(node:ts.Node,code:string,detail:string):Finding {return {file:cleanName(this.unit.name),line:this.file.getLineAndCharacterOfPosition(node.getStart(this.file)).line+1,code,detail}}
 context(node:ts.Node):string {
  for(let p:ts.Node|undefined=node;p;p=p.parent){
   if(ts.isMethodDeclaration(p)&&p.name)return p.name.getText(this.file);
   if(ts.isFunctionDeclaration(p)&&p.name)return p.name.text;
  }return '<module>';
 }
 functionContext(node:ts.Node):string {
  for(let p:ts.Node|undefined=node;p;p=p.parent){
   if(ts.isVariableDeclaration(p)&&ts.isIdentifier(p.name)&&p.initializer){const value=unwrap(p.initializer);if(ts.isArrowFunction(value)||ts.isFunctionExpression(value)||ts.isCallExpression(value)&&value.arguments.some(a=>ts.isArrowFunction(a)||ts.isFunctionExpression(a)))return p.name.text}
   if(ts.isFunctionDeclaration(p)&&p.name)return p.name.text;
   if(ts.isMethodDeclaration(p))return p.name.getText(this.file);
  }return '<module>';
 }
}

const canonicalModules:Record<string,string>={projectService:'ProjectService',phaseService:'PhaseService',taskManagerDB:'TaskManagerDB',reportManager:'ReportManager',taskElementService:'TaskElementService',blueprintProvenanceService:'BlueprintProvenanceService',auditService:'AuditService',authorizationRepository:'AuthorizationRepository',BlueprintRegistryService:'BlueprintRegistryService'};
const allowedOperations=new Set(['projectService.create','phaseService.create','taskManagerDB.createTask','taskManagerDB.addDependency','taskManagerDB.assignTaskRoles','reportManager.create','taskElementService.createReference','blueprintProvenanceService.stamp','auditService.record','authorizationRepository.listScope','authorizationRepository.authorizedIds','BlueprintRegistryService.resolve']);
const serviceFunctions:Record<string,string>={requireBlueprintScope:'BlueprintRegistryService',blueprintNotFound:'BlueprintRegistryService',buildBlueprintPlan:'BlueprintPlanService',enforceBlueprintPlan:'BlueprintPlanService',blueprintRequestHash:'BlueprintPlanService'};
const helperFunctions:Record<string,string>={...serviceFunctions,validateBlueprintValues:'blueprintDocument',blueprintDigest:'blueprintDocument',validateConnectorProfile:'executionProfile',v4:'uuid',runCreationTransaction:'creationTransaction'};
const workTables=new Set(['projects','phases','tasks','subtasks','reports','task_dependencies']);
const sqlClean=(sql:string)=>sql.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ').replace(/"/g,'');
const modulePath=(expected:string)=>expected==='uuid'?'uuid':['blueprintDocument','executionProfile'].includes(expected)?`utils/${expected}`:['creationTransaction','connection'].includes(expected)?`db/${expected}`:`services/${expected}`;
const validModule=(entity:Entity,expected:string)=>entity.module?.replace(/^.*backend\/src\//,'').replace(/\.ts$/,'')===modulePath(expected);

export function creationSqlFindings(unit:SourceUnit):Finding[]{
 const parsed=new ParsedSource(unit),out:Finding[]=[];
 for(const call of parsed.calls){
  const e=parsed.entity(call.expression),last=e.members.at(-1);
  if(last!=='query'){
   if(e.opaque&&(['client','pool','PoolClient'].includes(e.root)||e.members.includes('client')))out.push(parsed.finding(call,'D2_OPAQUE_DATABASE_CALL',e.root+'.'+e.members.join('.')));
   continue;
  }
  const sql=parsed.constant(call.arguments[0]);if(sql===undefined){out.push(parsed.finding(call,'D2_OPAQUE_SQL','Query text is not statically classified'));continue}
  const normalized=sqlClean(sql);
  for(const match of normalized.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:[\w]+\.)?([a-z_?][\w?]*)/ig)){
   if(workTables.has(match[1].toLowerCase())||match[1].includes('?'))out.push(parsed.finding(call,'D2_DIRECT_WORK_WRITE',match[0]));
  }
 }
 for(const name of ['projectService','phaseService','taskManagerDB','reportManager'])if(![...parsed.imports.values()].some(e=>e.root===name&&validModule(e,canonicalModules[name])))out.push(parsed.finding(parsed.file,'D2_CANONICAL_IMPORT_MISSING',name));
 return out;
}

export function creationCallFindings(unit:SourceUnit):Finding[]{
 const parsed=new ParsedSource(unit),out:Finding[]=[];
 for(const call of parsed.calls){
  const e=parsed.entity(call.expression);const operation=[e.root,...e.members].join('.');
  if(e.root==='pool'&&validModule(e,'connection')&&e.members.join('.')==='query')continue; // D2 owns SQL classification.
  if(operation==='authorizationRepository.listScope.().render'&&validModule(e,'AuthorizationRepository'))continue;
  if(e.root==='BlueprintPlanContextFactory'){
   const parent=call.parent;const outer=ts.isCallExpression(parent)?parsed.entity(parent.expression):undefined;
   if(outer?.root!=='buildBlueprintPlan'||!ts.isCallExpression(parent)||parent.arguments[3]!==call)out.push(parsed.finding(call,'D5_OPAQUE_CONTEXT_CALL','Plan context factory used outside the builder context argument'));
   continue;
  }
  if(!e.module)continue;
  if(e.opaque){out.push(parsed.finding(call,'D5_UNAPPROVED_SERVICE_CALL','Opaque/reassigned '+operation));continue}
  // These exact returned-value operations were reviewed with the backend
  // owner; arbitrary objects named has/filter/catch receive no exemption.
  if(operation==='authorizationRepository.authorizedIds.().has'&&validModule(e,'AuthorizationRepository'))continue;
  if(operation==='runCreationTransaction.().catch'&&validModule(e,'creationTransaction'))continue;
  if(['buildBlueprintPlan.().references.filter','buildBlueprintPlan.().tasks.filter','buildBlueprintPlan.().tasks.filter.().map'].includes(operation)&&validModule(e,'BlueprintPlanService'))continue;
  if(e.members.length===0&&helperFunctions[e.root]&&validModule(e,helperFunctions[e.root]))continue;
  if(allowedOperations.has(operation)&&validModule(e,canonicalModules[e.root]))continue;
  out.push(parsed.finding(call,'D5_UNAPPROVED_SERVICE_CALL',operation));
 }
 return out;
}

/** Both entry points must have exactly one canonical builder call. Additional
 * imported plan functions and alternate values assigned/returned as plan fail. */
export function builderFindings(unit:SourceUnit):Finding[]{
 const parsed=new ParsedSource(unit),out:Finding[]=[];
 for(const name of ['preview','instantiate']){
  const calls=parsed.calls.filter(c=>parsed.context(c)===name);
  const builders=calls.filter(c=>{const e=parsed.entity(c.expression);return e.root==='buildBlueprintPlan'&&e.members.length===0&&validModule(e,'BlueprintPlanService')});
  if(builders.length!==1)out.push(parsed.finding(builders[0]||parsed.file,'D16_BUILDER_COUNT',`${name}: ${builders.length}`));
  for(const call of calls){const e=parsed.entity(call.expression);
   if(e.module&&/plan/i.test(e.module)&&!['buildBlueprintPlan','enforceBlueprintPlan','blueprintRequestHash'].includes(e.root))out.push(parsed.finding(call,'D16_SECOND_BUILDER',e.root));
  }
  const visit=(node:ts.Node)=>{
   if(parsed.context(node)===name&&ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='plan'&&node.initializer){
    const value=unwrap(node.initializer);const e=ts.isCallExpression(value)?parsed.entity(value.expression):parsed.entity(value);
    if(e.root!=='buildBlueprintPlan'||e.members.length||!validModule(e,'BlueprintPlanService'))out.push(parsed.finding(node,'D16_ALTERNATE_PLAN_VALUE',e.root));
   }ts.forEachChild(node,visit);
  };visit(parsed.file);
 }
 return out;
}

const legitimateConsumers:Record<string,Set<string>>={
 'services/BlueprintRegistryService.ts':new Set(['describe','list','get','save','store','importDocument','transition','export']),
 'services/BlueprintInstantiationService.ts':new Set(['preview','instantiate']),
 'services/BlueprintPlanService.ts':new Set(['buildBlueprintPlan','blueprintRequestHash']),
 'utils/blueprintDocument.ts':new Set(['validateBlueprintDocument','validateBlueprintValues','substituteBlueprint','blueprintDigests','blueprintDigest','expandedDependencies']),
};
function relative(unit:SourceUnit):string{return cleanName(unit.name).replace(/^.*backend\/src\//,'')}
const isBodySql=(sql:string)=>/\bblueprint_versions\b/i.test(sql)&&/\bSELECT\s+[\s\S]*?(?:\bdocument\b|\*|\?)[\s\S]*?\bFROM\b/i.test(sql);
const frontendContexts:Record<string,Set<string>>={
 'frontend/src/pages/BlueprintsPage.tsx':new Set(['loadList','loadDetail','saveDocument','transition','history','download']),
 'frontend/src/components/blueprints/BlueprintWizard.tsx':new Set(['getPreview','instantiate']),
 'frontend/src/components/blueprints/BlueprintUse.tsx':new Set(['getPreview','instantiate']),
 'frontend/src/components/blueprints/BlueprintCapture.tsx':new Set(['save']),
 // Approved separate setup reads only private instance defaults, never a template after creation.
 'frontend/src/components/blueprints/BlueprintSetup.tsx':new Set(['preview','apply']),
 'frontend/src/components/blueprints/api.ts':new Set(['blueprintRequest']),
};
function legitimate(parsed:ParsedSource,node:ts.Node,query=false):boolean{
 const file=relative(parsed.unit),context=parsed.context(node);
 if(!legitimateConsumers[file]?.has(context))return false;
 if(query&&['services/BlueprintPlanService.ts','utils/blueprintDocument.ts'].includes(file))return false;
 let transaction=false;
 for(let p:ts.Node|undefined=node;p;p=p.parent)if(ts.isCallExpression(p)){
  const e=parsed.entity(p.expression);
  if(e.members.at(-1)==='afterCommit'||['setTimeout','setImmediate','queueMicrotask'].includes(e.root))return false;
  if(e.root==='runCreationTransaction'&&e.members.length===0)transaction=true;
 }
 return file!=='services/BlueprintInstantiationService.ts'||context!=='instantiate'||transaction;
}
function registryReadRoute(parsed:ParsedSource,node:ts.Node):boolean{
 if(relative(parsed.unit)!=='routes/blueprints.ts')return false;
 for(let p:ts.Node|undefined=node;p;p=p.parent)if(ts.isCallExpression(p)){
  const e=parsed.entity(p.expression),route=parsed.constant(p.arguments[0]);
  if(e.members.at(-1)==='get'&&['/','/:id','/:id/versions/:n/export'].includes(route||''))return true;
 }return false;
}

/** Reader census visits every production source unit. It follows query aliases
 * and registry-result document reads; it never substitutes a four-file sample. */
export function detachedReaderFindings(units:SourceUnit[]):Finding[]{
 const out:Finding[]=[];
 for(const unit of units){
  const parsed=new ParsedSource(unit);
  for(const call of parsed.calls){const e=parsed.entity(call.expression),sql=parsed.constant(call.arguments[0]);
   if(e.members.at(-1)==='query'&&sql!==undefined&&isBodySql(sql)&&!legitimate(parsed,call,true))out.push(parsed.finding(call,'D8_POSTCOMMIT_BODY_QUERY','Blueprint document body read outside declared consumer context'));
   const registry=e.root==='BlueprintRegistryService'||e.root==='blueprintRegistry'&&/routes\/blueprints$/.test(e.module||'')||e.root==='this'&&relative(unit)==='services/BlueprintRegistryService.ts';
   if(registry&&['get','list','export'].includes(e.members.at(-1)||'')&&!legitimate(parsed,call)&&!registryReadRoute(parsed,call))out.push(parsed.finding(call,'D8_POSTCOMMIT_REGISTRY_READ','Document-bearing registry read outside registry/read surface; indirect forwarding is not exempt'));
   if(cleanName(unit.name).startsWith('frontend/')){
    const paths=parsed.alternatives(call.arguments[0]);
    const blueprintTransport=e.root==='blueprintRequest'&&e.members.length===0;
    const body=paths.some(value=>/\/blueprints(?:\/|$)/.test(value)&&!/(?:\/instantiations|\/versions)$/.test(value));
    const opaque=blueprintTransport&&paths.some(value=>value==='?'||value.startsWith('/?'));
    const fetcher=blueprintTransport||e.members.length===0&&['authenticatedFetch','fetch'].includes(e.root);
    if(fetcher&&(body||opaque)&&!frontendContexts[cleanName(unit.name)]?.has(parsed.functionContext(call)))out.push(parsed.finding(call,'D8_FRONTEND_DOCUMENT_FETCH',`${parsed.functionContext(call)}: ${paths.join(' | ')}`));
    // The registry/wizard may inspect a document, but cannot apply it to an
    // ordinary instance through pre-existing work routes either.
    if(fetcher&&call.arguments[1]&&(blueprintTransport||frontendContexts[cleanName(unit.name)])&&paths.some(value=>/\/(?:projects|phases|tasks|subtasks|reports)\//.test(value))){
     const options=unwrap(call.arguments[1]);let method:string|undefined;
     if(ts.isObjectLiteralExpression(options)){const field=options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(parsed.file)==='method');if(field&&ts.isPropertyAssignment(field))method=parsed.constant(field.initializer)}
     if(ts.isCallExpression(options)&&parsed.entity(options.expression).root==='blueprintJson')method=parsed.constant(options.arguments[1])??'POST';
     if(method===undefined||!['GET','HEAD'].includes(method.toUpperCase()))out.push(parsed.finding(call,'D8_FRONTEND_INSTANCE_WRITE','Blueprint consumer invokes an ordinary instance mutation'));
    }
   }
  }
  const visit=(node:ts.Node)=>{
   if((ts.isPropertyAccessExpression(node)&&node.name.text==='document')||(ts.isElementAccessExpression(node)&&parsed.constant(node.argumentExpression)==='document')||(ts.isBindingElement(node)&&ts.isIdentifier(node.name)&&(node.propertyName?.getText(parsed.file)||node.name.text)==='document')){
    const e=ts.isBindingElement(node)?parsed.entity(node.name as ts.Identifier):parsed.entity(node.expression);const blueprintSource=/Blueprint(?:Registry|Instantiation)Service/.test(e.root)||/Blueprint(?:Registry|Instantiation)Service$/.test(e.module||'');
    if(blueprintSource&&!legitimate(parsed,node))out.push(parsed.finding(node,'D8_POSTCOMMIT_BODY_VALUE',e.root+'.'+e.members.join('.')));
   }ts.forEachChild(node,visit);
  };visit(parsed.file);
 }
 return out;
}

const routes=new Set(['get','post','put','patch','delete','all']);
/** Route contracts carrying both Blueprint and instance identifiers are forbidden
 * except the ratified preview/instantiate creation carrier. Path/body/query are
 * inspected together, including aliases and literal-computed property names. */
export function propagationRouteFindings(units:SourceUnit[]):Finding[]{
 const out:Finding[]=[];
 for(const unit of units){const parsed=new ParsedSource(unit);
  for(const call of parsed.calls){const e=parsed.entity(call.expression),verb=e.members.at(-1);if(!verb||!routes.has(verb))continue;
   const route=parsed.constant(call.arguments[0]);if(route===undefined)continue;
   const names:string[]=[route];
   const walk=(node:ts.Node)=>{
    if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
     const entity=parsed.entity(node);if(entity.members.some(m=>['params','body','query'].includes(m)))names.push(entity.members.join('.'));
    }
    if(ts.isBindingElement(node)&&ts.isIdentifier(node.name))names.push(node.propertyName?.getText(parsed.file)||node.name.text);
    ts.forEachChild(node,walk);
   };for(const arg of call.arguments.slice(1)){walk(arg);const body=parsed.handler(arg);if(body)walk(body)}
   const carrier=names.join(' ');const blueprint=/blueprint|versionId/i.test(carrier)||relative(unit)==='routes/blueprints.ts';
   const instance=/instantiationId|instanceId|(?:project|task|phase|report)Id/i.test(carrier);
   const creation=relative(unit)==='routes/blueprints.ts'&&verb==='post'&&['/:id/instantiations','/:id/instantiations/preview'].includes(route);
   if(blueprint&&instance&&!creation)out.push(parsed.finding(call,'D8_PROPAGATION_ROUTE',`${verb.toUpperCase()} ${route}`));
  }
 }
 return out;
}
