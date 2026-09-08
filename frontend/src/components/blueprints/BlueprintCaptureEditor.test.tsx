// @vitest-environment jsdom
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BlueprintDraftEditor } from './BlueprintDraftEditor';
import { BlueprintCapture } from './BlueprintCapture';
import type { BlueprintDocument } from '../../types/blueprint';
import { authenticatedFetch } from '../../utils/auth';
vi.mock('../../utils/auth',()=>({authenticatedFetch:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const fixture=():BlueprintDocument=>({schemaVersion:'rh.blueprint/1.0',blueprint:{key:'sample',version:1,name:'Sample'},parameters:[],
  target:{mode:'new-project',project:{name:'Project'}},references:[],phases:[],tasks:[{key:'task-1',title:'Inspect',description:'Review evidence',priority:'high',subtasks:[{text:'Check result'}],defaults:{maxRetries:3}}],
  humanGates:[],reports:[],dependencies:[]});
describe('capture and shared draft editing',()=>{
 test('required and optional controls author typed parameters while fixed fields stay unchanged',()=>{
   let current=fixture();
   function Editor(){const [doc,setDoc]=useState(current);return <BlueprintDraftEditor document={doc} onChange={next=>{current=next;setDoc(next);}}/>;}
   render(<Editor/>);
   fireEvent.change(screen.getByLabelText('Task 1 · description mode'),{target:{value:'required'}});
   expect(current.tasks[0].description).toBe('{{field_tasks_0_description}}');
   expect(current.parameters[0]).toMatchObject({required:true,type:'text',default:'Review evidence'});
   expect(current.tasks[0].title).toBe('Inspect');
   fireEvent.change(screen.getByLabelText('Task 1 · description mode'),{target:{value:'optional'}});
   expect(current.parameters[0].required).toBe(false);
   fireEvent.change(screen.getByLabelText('Task 1 · description mode'),{target:{value:'fixed'}});
   expect(current.tasks[0].description).toBe('Review evidence');expect(current.parameters).toHaveLength(0);
   fireEvent.change(screen.getByLabelText('Task 1 · Priority mode'),{target:{value:'optional'}});
   expect(current.parameters[0]).toMatchObject({type:'enum',required:false,default:'high',constraints:{enum:['urgent','high','normal','low','someday']}});
 });
 test('ordinary Task editor saves a fixed field without adding parameters',async()=>{
   let current=fixture();
   function Editor(){const [doc,setDoc]=useState(current);return <BlueprintDraftEditor document={doc} onChange={next=>{current=next;setDoc(next);}}/>;}
   render(<Editor/>);
   fireEvent.click(screen.getByRole('button',{name:'Edit Task 1 · title'}));
   fireEvent.change(screen.getByRole('textbox',{name:'Task 1 · title'}),{target:{value:'Inspect the result'}});
   fireEvent.click(screen.getByRole('button',{name:'Save'}));
   await waitFor(()=>expect(current.tasks[0].title).toBe('Inspect the result'));
   expect(current.parameters).toHaveLength(0);
 });
 test('capture posts the selected Phase and renders server refusal without losing the name',async()=>{
   vi.mocked(authenticatedFetch).mockResolvedValue({ok:false,status:404,json:async()=>({success:false,error:'Phase unavailable',code:'BLUEPRINT_CAPTURE_NOT_FOUND'})} as Response);
   render(<MemoryRouter><BlueprintCapture phaseId="phase-one" projectId="project-one" phaseName="Delivery" onClose={()=>{}}/></MemoryRouter>);
   fireEvent.click(screen.getByRole('button',{name:'Save draft Blueprint'}));
   await screen.findByRole('alert');
   expect((screen.getByLabelText('Blueprint name') as HTMLInputElement).value).toBe('Delivery');
   expect(JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[0][1]?.body))).toEqual({phaseId:'phase-one',projectId:'project-one',name:'Delivery'});
 });
});

test('Connector options remain fixed without misleading placeholder controls',()=>{
 const doc=fixture();doc.tasks[0].defaults={executionProfile:{service:'worker',options:{retries:2,enabled:true,mode:'review'},parameters:{mode:{count:2}}}};
 render(<BlueprintDraftEditor document={doc} onChange={()=>{}}/>);
 expect(screen.queryByLabelText('Task 1 · defaults · executionProfile · options · retries mode')).toBeNull();
 expect(screen.queryByLabelText('Task 1 · defaults · executionProfile · options · enabled mode')).toBeNull();
 expect(screen.queryByLabelText('Task 1 · defaults · executionProfile · options · mode mode')).toBeNull();
 expect(screen.getByRole('button',{name:'Edit Task 1 · defaults · executionProfile · options · retries'})).toBeTruthy();
 expect(screen.getAllByText(/Connector options require their descriptor types/)).toHaveLength(4);
});
test('empty structured lists can add and parameterize their first item without losing list shape',()=>{
 let current=fixture();current.tasks[0].definitionOfDone=[];current.tasks[0].successCriteria=[];current.tasks[0].constraints=[];
 function Editor(){const[doc,setDoc]=useState(current);return <BlueprintDraftEditor document={doc} onChange={next=>{current=next;setDoc(next);}}/>;}
 render(<Editor/>);
 for(const field of ['definitionOfDone','successCriteria','constraints']){
  fireEvent.click(screen.getByRole('button',{name:'Add '+field+' item to Task 1'}));
  fireEvent.change(screen.getByLabelText('Task 1 · '+field+' 1 mode'),{target:{value:'required'}});
  expect(current.tasks[0][field]).toEqual(['{{field_tasks_0_'+field.toLowerCase()+'_0}}']);
 }
});
