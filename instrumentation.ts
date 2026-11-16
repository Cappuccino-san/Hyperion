export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { hydratePersistenceOnBoot } = await import("@/lib/persistenceStore");
    await hydratePersistenceOnBoot().catch(() => {});
    const { ensureLiveBotRunning } = await import("@/lib/liveBotDaemon");
    ensureLiveBotRunning();
  }
}
