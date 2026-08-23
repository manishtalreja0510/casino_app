/**
 * Integration-suite environment.
 *
 * Scheduled work is off here. It is a *role* an instance takes on (see
 * `SCHEDULED_WORK_ENABLED`), and a test process that quietly took it on gets two
 * background writers racing every suite: the Crash round loop opening real rounds, and the
 * matchmaking sweep forming real matches. Both move test credits and write audit rows
 * between a test's arrange and assert steps.
 *
 * That is not hypothetical — it corrupted this repository's local audit chain once, when a
 * tamper-detection test assumed it was the only writer and "restored" a row that belonged
 * to a background formation. The suites drive both mechanisms explicitly instead, which is
 * also the only way to test a specific round outcome.
 */
process.env.SCHEDULED_WORK_ENABLED ??= 'false';
