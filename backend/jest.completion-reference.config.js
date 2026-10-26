require('./scripts/completion-reference-endpoint').assertCompletionReferenceEndpoint(process.env);
const base = require('./jest.config');
module.exports = {...base, testMatch: process.env.LIFECYCLE_NEGATIVE==='1' ? ['**/__tests__/completionReferenceLifecycleLive.test.ts'] : ['**/__tests__/mixedCompletionCleanupLive.test.ts','**/__tests__/completionReferenceLifecycleLive.test.ts','**/__tests__/lifecycleEntrySchedulerLive.test.ts','**/__tests__/completionReferenceFencingLive.test.ts'], testPathIgnorePatterns: ['/node_modules/']};
