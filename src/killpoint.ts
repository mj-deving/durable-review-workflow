// Crash injection for the harness. When KILL_AT names this point, the process announces it on
// stdout and waits. The harness answers with SIGKILL, so nothing in this process gets to flush,
// catch or clean up. For the stalled-process case the harness sends SIGUSR2 instead, and the
// process carries on from here as if it had only been slow.
export async function killpoint(name: string): Promise<void> {
  if (process.env.KILL_AT !== name) return;
  process.stdout.write(`KILLPOINT ${name}\n`);
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => {}, 1000);
    process.once("SIGUSR2", () => {
      clearInterval(keepAlive);
      resolve();
    });
  });
}
