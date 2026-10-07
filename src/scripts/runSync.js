// Standalone spreadsheet sync — the file `npm run sync` points at but which was
// missing from the repo, so that script had been failing for anyone who ran it.
//
// Usage:
//   npm run sync
//   FORCE_SYNC=1 npm run sync        // ignore the interval cooldown
//
// Safe to run against production: runSync() is the same coalesced, logged
// operation the server performs on its own schedule, so running it by hand
// simply does the next run now.

const { runSync, maybeRunSync } = require('../services/sheetsSync');

async function main() {
  const force = String(process.env.FORCE_SYNC || '') === '1';
  if (!force) {
    // maybeRunSync respects SYNC_INTERVAL_MINUTES and shares one in-flight run
    // with the server, so this cannot stampede the Sheets API.
    const ran = await maybeRunSync(0);
    console.log(ran
      ? '[sync] completed'
      : '[sync] skipped — the last run is still inside SYNC_INTERVAL_MINUTES (set FORCE_SYNC=1 to override)');
    return;
  }
  const log = await runSync();
  console.log('[sync] completed');
  console.log(`  students synced : ${log.studentsProcessed ?? 0}`);
  console.log(`  teachers synced : ${log.teachersProcessed ?? 0}`);
  console.log(`  groups          : ${log.groupsProcessed ?? 0}`);
  console.log(`  student access  : ${log.studentRelsProcessed ?? 0}`);
  console.log(`  teacher access  : ${log.teacherRelsProcessed ?? 0}`);
  if (log.warnings && log.warnings.length) {
    console.log(`  warnings (${log.warnings.length}):`);
    for (const w of log.warnings.slice(0, 20)) console.log(`    - ${w}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[sync] failed:', e);
    process.exit(1);
  });