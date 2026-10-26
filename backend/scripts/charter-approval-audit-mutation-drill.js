/** E101 controls over the real router. Run only in an isolated checkout with
 * its disposable DB. Every mutation is restored before the next control. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const target = new URL(process.env.RELAYHALL_TEST_DB_URL || 'invalid:');
const local = target.hostname === '127.0.0.1' && target.pathname === '/relayhall_report_sponsor_test';
const ci = process.env.CI === 'true' && target.hostname === 'postgres' && target.pathname === '/relayhall_ci'
  && target.username === 'relayhall_ci' && target.port === '5432';
if (!['postgres:', 'postgresql:'].includes(target.protocol) || !local && !ci) throw new Error('Exact disposable audit DB required');
const file = 'src/services/CharterService.ts';
const original = fs.readFileSync(file, 'utf8');
const controls = [
  { name:'success receipt', anchor:"    if (!actor) throw new Error('Charter approval audit attribution is required');",
    replacement:"    if (outcome === 'success') return;\n    if (!actor) throw new Error('Charter approval audit attribution is required');", pattern:'creates exactly one' },
  { name:'denied receipt', anchor:"    if (!actor) throw new Error('Charter approval audit attribution is required');",
    replacement:"    if (outcome === 'denied') return;\n    if (!actor) throw new Error('Charter approval audit attribution is required');", pattern:'domain-refused revision' },
  { name:'approval transaction', anchor:'    }, executor);', replacement:"    }, outcome === 'success' ? pool : executor);", pattern:'deferred approval commit failure' },
  // Card b5c83682 (LENSES-c gate (i)) spread the Group-owner arm's fields into
  // this line; the control follows the line by name and still adds the Charter text.
  { name:'metadata privacy', anchor:'      metadata: { charterVersion, sha, previousVersion, ...(groupOwner ?? {}) },',
    replacement:"      metadata: { charterVersion, sha, previousVersion, ...(groupOwner ?? {}), content: (await executor.query('SELECT content FROM project_charters WHERE project_id=$1', [projectId])).rows[0]?.content },", pattern:'creates exactly one' },
];
const receipts = [];
for (const control of controls) {
  if (original.split(control.anchor).length !== 2) throw new Error(`Mutation anchor changed: ${control.name}`);
  const receipt = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'charter-audit-mutation-')),'result.json');
  try {
    fs.writeFileSync(file,original.replace(control.anchor,control.replacement));
    const run=spawnSync(process.execPath,['node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/',
      '--runTestsByPath','src/__tests__/charterApprovalAuditLive.test.ts','--testNamePattern',control.pattern,'--json',`--outputFile=${receipt}`],{encoding:'utf8'});
    if (!fs.existsSync(receipt)) throw new Error(`Control emitted no result: ${control.name}`);
    const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
    const failures=result.testResults.flatMap(suite=>suite.assertionResults).filter(test=>test.status==='failed');
    if (run.status!==1 || failures.length!==1 || !failures[0].fullName.includes(control.pattern)) {
      throw new Error(`Unexpected control outcome: ${JSON.stringify({control:control.name,status:run.status,failures:failures.map(test=>test.fullName)})}`);
    }
    receipts.push({control:control.name,killed:true,failedTests:1,receipt});
  } finally { fs.writeFileSync(file,original); }
}
process.stdout.write(JSON.stringify({killed:receipts.length,controls:receipts})+'\n');
