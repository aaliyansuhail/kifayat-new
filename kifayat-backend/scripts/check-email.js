// Print exactly why transactional email is or is not working, and optionally
// send a real test message.
//
// Config checks cannot catch a rejected app password or a domain that is not
// verified, so the only reliable signal is a real send.
//
// Usage
//   node scripts/check-email.js                 diagnose config
//   node scripts/check-email.js --send me@x.com send a real test message
require("dotenv").config();
const {
  getEmailDiagnostics,
  sendTestEmail,
  closeEmailTransports,
} = require("../utils/email");

async function main() {
  const d = getEmailDiagnostics();

  console.log("── Email configuration ──────────────────────────────────────────");
  console.log(`  Gmail user/pass  : ${d.hasGmail ? "set" : "MISSING"}`);
  console.log(`  Gmail sender     : ${d.gmailFrom}`);
  console.log(`  reply-to         : ${d.replyTo || "(none)"}`);
  console.log(`  provider order   : ${d.providerOrder.join(" -> ") || "(none)"}`);

  if (d.problems.length === 0) {
    console.log("\n  No configuration problems detected.");
  } else {
    console.log("\n  Problems:");
    for (const p of d.problems) console.log(`   • ${p}`);
  }

  const sendIndex = process.argv.indexOf("--send");
  if (sendIndex === -1) {
    console.log("\nRun with `--send you@example.com` to send a real test message.");
    return;
  }

  const to = process.argv[sendIndex + 1];
  if (!to || !to.includes("@")) {
    console.error("\n--send needs a recipient address, e.g. --send you@example.com");
    process.exit(1);
  }

  console.log(`\n── Sending a real test message to ${to} ...`);
  const result = await sendTestEmail(to);
  if (result.ok) {
    console.log(`  OK via ${result.provider}: ${result.detail}`);
  } else {
    console.error(`  FAILED: ${result.detail}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("Email check failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The Gmail transporter is pooled, so its open socket would otherwise keep
    // the event loop alive and the process would hang after a successful send.
    await closeEmailTransports();
  });
