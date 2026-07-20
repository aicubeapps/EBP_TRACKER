export async function handleCron(cron, env) {
  console.log(`Cron triggered: ${cron}`)
  // Stub: dispatch EBP scan based on cron schedule
  // */15 * * * *  → M15 scan
  // 0 * * * *     → 1H scan
  // 0 */4 * * *   → 4H scan
  // 0 21 * * 1-5  → Daily scan (IST market close)
  // 0 21 * * 5    → Weekly scan
}
