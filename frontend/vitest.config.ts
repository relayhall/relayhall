import { defineConfig } from 'vitest/config';

// The literal gate command is `npx vitest run` with no environment preamble;
// an inherited NODE_ENV=production would otherwise select React's production
// build (breaking act()) and flip Vite's resolve conditions for node builtins
// (review f4ec788c B3). Pin the environment at config load, before Vite reads
// it, so the gate is deterministic under any caller.
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Card 7d38a6e0, round-1 review F4: ONE file is excluded from the default
    // run, and the exclusion lives on the 'test:unit' script rather than here.
    // src/components/tasks/taskDueDateTimezone.test.tsx measures the deadline
    // control across a daylight-saving GAP and FOLD and FAILS - never skips -
    // in a zone that has neither; the default run and CI are UTC. 'npm run
    // test:unit:tz' sets Europe/Warsaw, which has both on the same clock
    // reading, and runs it as its own unconditional CI step. A config-level exclude would hide it from that
    // script too, because vitest applies exclude before a filename filter.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    // The literal gate command is `npx vitest run` with no environment
    // preamble; an inherited NODE_ENV=production would otherwise select
    // React's production build and break act() (review f4ec788c B3). Pin the
    // test environment so the gate is deterministic under any caller.
    env: { NODE_ENV: 'test' },
  },
});
