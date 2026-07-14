import fc from 'fast-check';

// §18.2: all suites deterministic — seeded randomness everywhere. Override
// with FC_SEED to explore a different corner of the space locally.
const seed = process.env.FC_SEED !== undefined ? Number(process.env.FC_SEED) : 42;
fc.configureGlobal({ seed, numRuns: 100 });
