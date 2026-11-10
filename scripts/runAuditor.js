/**
 * Lightweight PM2 runner entrypoint for Hyperion Autonomous Auditor
 */
const { spawn } = require("child_process");
const path = require("path");

function runAuditCycle() {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[PM2-RUNNER ${ts}] Triggering autonomous audit cycle...`);

  const child = spawn("npx.cmd", ["tsx", "scripts/autoImprovementDaemon.ts"], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    shell: true,
  });

  child.on("close", (code) => {
    console.log(`[PM2-RUNNER] Audit cycle finished with exit code ${code}`);
  });
}

// Initial cycle
runAuditCycle();

// Recurring cycle every 15 minutes (900,000 ms)
const INTERVAL_MS = 15 * 60 * 1000;
console.log(`[PM2-RUNNER] Registered 15-minute background recurring timer.`);
setInterval(runAuditCycle, INTERVAL_MS);

