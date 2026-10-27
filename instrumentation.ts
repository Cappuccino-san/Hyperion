export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureLiveBotRunning } = await import("@/lib/liveBotDaemon");
    ensureLiveBotRunning();
  }
}
