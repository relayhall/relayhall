jest.mock('../services/TaskManagerDB',()=>({taskManagerDB:{queryTasks:jest.fn()}}));
jest.mock('../services/ProjectService',()=>({projectService:{list:jest.fn()}}));
jest.mock('../services/CanonicalRuntimeSignalService',()=>({canonicalRuntimeSignalService:{listTaskSignalsForTasks:jest.fn()}}));
import {ProjectStatsService} from '../services/ProjectStatsService';
import {taskManagerDB} from '../services/TaskManagerDB';
import {canonicalRuntimeSignalService} from '../services/CanonicalRuntimeSignalService';

test('active-agent statistics query only already-authorized Task ids and deduplicate actual active attempts',async()=>{
  (taskManagerDB.queryTasks as jest.Mock).mockResolvedValue([
    {id:'visible',status:'in-progress',updated:'2026-10-13T00:00:00Z'},
    {id:'hidden',status:'in-progress',activeAgent:{name:'forged'}},
  ]);
  const visible=jest.fn(async(rows:any[])=>rows.filter(row=>row.id==='visible'));
  (canonicalRuntimeSignalService.listTaskSignalsForTasks as jest.Mock).mockResolvedValue([
    {state:'active',attemptId:'actual'}, {state:'active',attemptId:'actual'},
    {state:'idle',attemptId:'ended'},
  ]);
  const result=await new ProjectStatsService().getStatsByName(visible,'fixture');
  expect(canonicalRuntimeSignalService.listTaskSignalsForTasks).toHaveBeenLastCalledWith(['visible']);
  expect(result).toMatchObject({total_tasks:1,in_progress_tasks:1,active_agents:1,last_activity:'2026-10-13T00:00:00Z'});
});

test('a readable Task status or forged retired agent field cannot manufacture an active agent',async()=>{
  (taskManagerDB.queryTasks as jest.Mock).mockResolvedValue([{id:'visible',status:'in-progress',activeAgent:{name:'forged'}}]);
  (canonicalRuntimeSignalService.listTaskSignalsForTasks as jest.Mock).mockResolvedValue([]);
  expect((await new ProjectStatsService().getStatsByName(async rows=>rows,'fixture')).active_agents).toBe(0);
});
