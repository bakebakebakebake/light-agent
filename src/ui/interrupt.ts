/**
 * Interrupt handling (docs/08).
 *
 * A single AbortController is the interrupt channel: pressing Ctrl-C during a
 * turn aborts it, which propagates into the model stream and any running tool
 * via their AbortSignal. The loop sees the signal and stops gracefully,
 * returning control to the prompt rather than killing the process.
 */
export class InterruptController {
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  abort(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  /** Fresh controller for the next turn (a new prompt). */
  reset(): void {
    this.controller = new AbortController();
  }
}

/**
 * Wire interruption to the controller for the duration of a turn. Returns a
 * disposer that removes the listener.
 *
 * We use SIGINT (Ctrl-C) as the interrupt channel rather than raw keypress
 * events: readline owns the terminal in cooked mode (so line editing, history,
 * and Tab completion work and input isn't double-echoed), which means we must
 * not also subscribe to raw 'keypress'. While a turn is running readline is
 * idle (we're awaiting the loop), so claiming SIGINT here is safe; the cleanup
 * restores readline's own Ctrl-C handling for the next prompt.
 *
 * First Ctrl-C aborts the active turn (graceful — the loop sees the signal and
 * returns control to the prompt). A second Ctrl-C within 1.5s exits the
 * process, matching the familiar "press again to quit" convention.
 */
export function listenForInterrupt(
  controller: InterruptController,
): () => void {
  let lastSigint = 0;
  const onSigint = (): void => {
    const now = Date.now();
    if (controller.aborted && now - lastSigint < 1500) {
      // Already aborting and the user insisted — leave.
      process.stdout.write("\n");
      process.exit(130);
    }
    lastSigint = now;
    controller.abort();
  };

  process.on("SIGINT", onSigint);
  return () => {
    process.off("SIGINT", onSigint);
  };
}
