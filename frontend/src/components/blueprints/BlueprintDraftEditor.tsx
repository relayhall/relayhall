import { useState } from 'react';
import type { BlueprintDocument, BlueprintParameter } from '../../types/blueprint';
import { TaskTextSectionEditor } from '../tasks/TaskTextSectionEditor';
import { PrioritySelect, ThinkingSelect } from '../tasks/taskFieldEditors';
import type { TaskPriority } from '../../types/task';
import { Button } from '../Button';
import '../../pages/TaskDetailPage.css';

type Path = (string | number)[];
type Field = { path: Path; label: string; fixedOnly?: boolean; choices?: string[]; type?: BlueprintParameter['type'] };
const binding = (value: unknown) => typeof value === 'string' ? /^{{([a-z][a-z0-9_]*)}}$/.exec(value)?.[1] : undefined;
const read = (document: BlueprintDocument, path: Path): unknown => path.reduce<any>((value, key) => value?.[key], document);
function write(document: BlueprintDocument, path: Path, value: unknown) {
  const parent = path.slice(0, -1).reduce<any>((current, key) => current[key], document);
  parent[path[path.length - 1]] = value;
}
function fields(document: BlueprintDocument): Field[] {
  const result: Field[] = [];
  function leaves(value: unknown, path: Path, label: string, type?: BlueprintParameter['type']) {
    if (Array.isArray(value)) value.forEach((child, index) => leaves(child, [...path, index], label + ' ' + (index + 1), type));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => {
      if (!['key', 'phase', 'status', 'references'].includes(key)) leaves(child, [...path, key], label + ' · ' + key, key === 'personality' ? 'personality-ref' : key === 'service' ? 'service-ref' : type);
    });
    else result.push({ path, label, fixedOnly:path.includes('executionProfile') && (path.includes('options') || path.includes('parameters')), type: type || (typeof value === 'number' ? 'integer' : typeof value==='boolean' ? 'boolean' : 'text') });
  }
  document.phases.forEach((phase, index) => ['name','goal'].forEach(key => leaves(phase[key] ?? '', ['phases',index,key], 'Phase ' + (index + 1) + ' · ' + key)));
  if (typeof document.target.project === 'object') Object.entries(document.target.project).forEach(([key,value]) => leaves(value,['target','project',key],'New Project · '+key));
  document.tasks.forEach((task, index) => {
    const prefix = ['tasks',index] as Path;
    ['title','description','definitionOfDone','successCriteria','constraints','notes'].forEach(key => leaves(task[key] ?? '', [...prefix,key], 'Task ' + (index + 1) + ' · ' + key));
    ['tags','subtasks','defaults'].forEach(key=>leaves(task[key] ?? (key==='defaults' ? {} : []),[...prefix,key],'Task '+(index+1)+' · '+key));
    result.push({ path: [...prefix,'priority'],label:'Task '+(index+1)+' · Priority',choices:['urgent','high','normal','low','someday'],type:'enum' });
    result.push({ path: [...prefix,'thinking'],label:'Task '+(index+1)+' · Thinking',choices:['low','medium','high'],type:'enum' });
    if (task.roles && typeof task.roles === 'object') Object.entries(task.roles).forEach(([key,value]) => leaves(value,[...prefix,'roles',key],'Task '+(index+1)+' · '+key,'principal-ref'));
  });
  return result;
}

/** The ordinary Task text editor owns editing, errors and save/cancel behavior.
 * The Blueprint layer only adds parameter metadata beside each captured field. */
export function BlueprintDraftEditor({ document, onChange }: { document: BlueprintDocument; onChange: (document: BlueprintDocument) => void }) {
  const [fixedValues] = useState<Record<string,unknown>>({});
  const [active, setActive] = useState<string | null>(null);
  const update = (edit: (next: BlueprintDocument) => void) => { const next = structuredClone(document); edit(next); onChange(next); };
  return <div>
    <label>Blueprint name<input value={document.blueprint.name} onChange={event => update(next => { next.blueprint.name = event.target.value; })} /></label>
    <label>Blueprint key<input value={document.blueprint.key} onChange={event => update(next => { next.blueprint.key = event.target.value; })} /></label>
    {fields(document).map(field => {
      const id = ['blueprint', ...field.path].join('-'); const value = read(document, field.path);
      const parameterKey = binding(value); const parameter = document.parameters.find(row => row.key === parameterKey);
      const mode = parameter ? parameter.required ? 'required' : 'optional' : 'fixed';
      const toggle = (mode: string) => update(next => {
        const old = next.parameters.find(row => row.key === parameterKey);
        if (mode === 'fixed') {
          write(next,field.path,fixedValues[id] ?? old?.default ?? (field.type==='integer' ? 0 : field.choices?.[0] ?? ''));
          // A manually authored parameter may be shared by several fields.
          const remaining = JSON.stringify({tasks:next.tasks,phases:next.phases,target:next.target,humanGates:next.humanGates,reports:next.reports});
          if (old && !remaining.includes('{{'+old.key+'}}')) next.parameters = next.parameters.filter(row => row.key !== old.key);
          return;
        }
        if (!parameterKey) fixedValues[id]=value;
        const key = parameterKey || ['field', ...field.path].join('_').toLowerCase().slice(0,64);
        const declaration: BlueprintParameter = { key, label: old?.label || field.label, promptText: old?.promptText || field.label, help: old?.help || '',
          type: old?.type || field.type || 'text', required: mode === 'required',
          ...(field.choices ? {constraints:{enum:field.choices}} : field.type==='integer' ? {constraints:{min:0,max:100}} : {}),
          ...(!field.type?.endsWith('-ref') && !parameterKey ? {default: (value ?? field.choices?.[0] ?? '') as string | number} : old?.default !== undefined ? {default:old.default} : {}) };
        next.parameters = [...next.parameters.filter(row => row.key !== key), declaration];
        write(next,field.path,'{{'+key+'}}');
      });
      return <div key={id}>
        {field.fixedOnly ? <p>{field.label} is fixed. Connector options require their descriptor types; placeholder modes are unavailable in this editor.</p> : <><label htmlFor={'mode-'+id}>{field.label} mode</label>
        <select id={'mode-'+id} value={mode} onChange={event => toggle(event.target.value)}>
          <option value="fixed">Fixed</option><option value="required">Placeholder — required</option><option value="optional">Placeholder — optional</option>
        </select></>}
        {parameter ? <fieldset><legend>{field.label} placeholder</legend>
          <label>Label<input value={parameter.label} onChange={event => update(next => { const p=next.parameters.find(row=>row.key===parameter.key)!;p.label=event.target.value;p.promptText=event.target.value; })} /></label>
          <label>Help text<input value={parameter.help || ''} onChange={event => update(next => { next.parameters.find(row=>row.key===parameter.key)!.help=event.target.value; })} /></label>
        </fieldset> : field.choices ? <label>{field.label}
          {field.path.at(-1)==='priority' ? <PrioritySelect value={(value || 'normal') as TaskPriority} onChange={priority=>update(next=>write(next,field.path,priority))} />
            : <ThinkingSelect value={String(value || '')} onChange={thinking=>update(next=>write(next,field.path,thinking))} />}
        </label> : <TaskTextSectionEditor id={id} heading={field.label} value={String(value ?? '')} activeEditor={active} updatedElsewhere={false}
          onBegin={setActive} onEnd={()=>setActive(null)} onSave={async text=>update(next=>write(next,field.path,field.type==='integer' ? Number(text) : field.type==='boolean' ? text==='true' : text))}>
          <p className="blueprint-literal">{String(value ?? '') || 'Not set'}</p>
        </TaskTextSectionEditor>}
      </div>;
    })}
    {document.tasks.map((task,index)=><fieldset key={String(task.key)}><legend>Task {index+1} structure</legend>
      {['definitionOfDone','successCriteria','constraints'].filter(field=>Array.isArray(task[field])).map(field=><Button key={field} variant="secondary"
        onClick={()=>update(next=>{(next.tasks[index][field] as string[]).push('New item');})}>Add {field} item to Task {index+1}</Button>)}
      <Button variant="secondary" onClick={()=>update(next=>{next.tasks[index].subtasks=[...(next.tasks[index].subtasks as Array<{text:string}> || []),{text:'New subtask'}];})}>Add subtask to Task {index+1}</Button>
      <Button variant="secondary" onClick={()=>update(next=>{next.tasks[index].tags=[...(next.tasks[index].tags as string[] || []),'new-tag'];})}>Add tag to Task {index+1}</Button>
      <label>Depends on<select aria-label={'Task '+(index+1)+' dependencies'} multiple value={document.dependencies.filter(edge=>edge.task===task.key).map(edge=>edge.dependsOn)}
        onChange={event=>{const chosen=Array.from(event.target.selectedOptions,option=>option.value);update(next=>{next.dependencies=[...next.dependencies.filter(edge=>edge.task!==task.key),...chosen.map(dependsOn=>({task:String(task.key),dependsOn}))];});}}>
        {[...document.tasks,...document.humanGates].filter(other=>other.key!==task.key).map(other=><option key={String(other.key)} value={String(other.key)}>{String(other.title)}</option>)}
      </select></label>
    </fieldset>)}
    <Button variant="secondary" onClick={()=>update(next=>{next.tasks.push({key:'task-'+(next.tasks.length+1),title:'New Task',description:'',priority:'normal',subtasks:[],tags:[],defaults:{}});})}>Add Task</Button>
  </div>;
}
