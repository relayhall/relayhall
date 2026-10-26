// Explicit owned-fixture only. Never infer localhost/5432 or deployment state.
const {spawnSync}=require('child_process');
require('./completion-reference-endpoint').assertCompletionReferenceEndpoint(process.env);
const p=spawnSync(process.execPath,['node_modules/jest/bin/jest.js','--config','jest.completion-reference.config.js','--runInBand','--no-cache'],{stdio:'inherit',env:{...process.env,NODE_OPTIONS:'--max-old-space-size=1024'}});process.exit(p.status===null?1:p.status);
