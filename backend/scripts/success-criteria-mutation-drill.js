/** Disposable-DB mutation control. Run from backend in an isolated checkout.
 * Restores both source files even if the live gate fails unexpectedly. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
if (!process.env.RELAYHALL_TEST_DB_URL) throw new Error('Disposable RELAYHALL_TEST_DB_URL required');
const criteriaDb = new URL(process.env.RELAYHALL_TEST_DB_URL);
const ciService = process.env.CI === 'true' && criteriaDb.hostname === 'postgres' && criteriaDb.pathname === '/relayhall_ci';
const local = ['localhost', '127.0.0.1', '[::1]'].includes(criteriaDb.hostname) && /test|contract|fixture/.test(criteriaDb.pathname);
if ((!local && !ciService) || /^(relayhall|relayhall_dev|relayhall_tst|relayhall_prod)$/.test(criteriaDb.pathname.slice(1))) throw new Error('Disposable database required');
const files = ['src/utils/taskColumnContract.ts', 'src/services/TaskManagerDB.ts'];
const originals = files.map(file => fs.readFileSync(file, 'utf8'));
const contract = originals[0].replace("success_criteria: serverWritten('successCriteria', 'success_criteria')", "success_criteria: publicColumn('successCriteria')");
const manager = originals[1].replace("      if (updates.reviewHistory !== undefined)", "      if (updates.successCriteria !== undefined) addField('success_criteria', JSON.stringify(updates.successCriteria));\n      if (updates.reviewHistory !== undefined)");
if (contract === originals[0] || manager === originals[1]) throw new Error('Mutation anchor changed');
const receipt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'criteria-mutation-')), 'result.json');
try {
  fs.writeFileSync(files[0], contract); fs.writeFileSync(files[1], manager);
  const run = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
    '--runTestsByPath', 'src/__tests__/taskServerWrittenColumnsLive.test.ts', '--testNamePattern=server-written column success_criteria.*PATCH /tasks/:id.*successCriteria', '--json', `--outputFile=${receipt}`], { encoding: 'utf8' });
  if (!fs.existsSync(receipt)) throw new Error(`No gate receipt: ${run.error?.message || run.stderr?.slice(-2000)}`);
  const result = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const failed = result.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed');
  if (run.status !== 1 || failed.length !== 1 || !failed[0].fullName.includes('successCriteria')
    || !failed[0].failureMessages.some(message => message.includes('Independent criteria remain unchanged') && message.includes('200'))) {
    throw new Error(`Mutation did not produce exactly the intended persisted-column red proof: ${JSON.stringify({ status: run.status, failed: failed.map(test => test.fullName) })}`);
  }
  process.stdout.write(JSON.stringify({ mutation: 'implementer PATCH reaches success_criteria', killed: true, failedTests: 1, receipt }) + '\n');
} finally { files.forEach((file, index) => fs.writeFileSync(file, originals[index])); }
