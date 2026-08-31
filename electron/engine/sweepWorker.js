/* The thread a sweep runs on.
 *
 * A sweep is minutes to hours of solid computation. Run in the main process it
 * would hold the event loop for all of it: no IPC, no window events, no
 * progress — an application that looks crashed while it works. So it runs
 * here, and the main process keeps answering.
 *
 * The bars are read in this thread rather than sent to it. A year of 5-minute
 * bars plus the minutes underneath them is over half a million objects, and
 * structured-cloning that across the boundary costs more than reading the file
 * again. Only the request goes in and only the result comes back.
 *
 * Stopping is cooperative and has to be. A worker can be terminated outright,
 * but that loses the combinations already finished; the flag is checked
 * between runs, so stopping is quick without throwing away the work.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { readBars, BASE_TIMEFRAME } from '../data/store/barStore.js';
import { runSweep, SweepCancelled } from './sweepRunner.js';

/* SharedArrayBuffer rather than a message: a stop sent as a message would sit
 * in this thread's queue behind nothing — the thread never yields to read it
 * while the loop is running. A shared byte can be read mid-loop. */
const stopFlag = workerData.stopFlag ? new Uint8Array(workerData.stopFlag) : null;

async function main() {
  const {
    dataDir, symbol, timeframe, from, to, strategy, ranges, base, balance,
    trainFraction, metric, minTrades, showCount,
  } = workerData.request;

  parentPort.postMessage({ type: 'stage', stage: 'loading' });

  // Closed bars only — the engine must never see the bar currently forming.
  const bars = await readBars(dataDir, symbol, timeframe, from, to, true);
  if (bars.length === 0) {
    throw new Error('No bars in that range — download the data for this symbol first');
  }

  /* Minutes underneath, so a bar that touches both stop and target is resolved
   * by replaying it. Skipped when the strategy already runs on minutes. */
  const baseBars = timeframe === BASE_TIMEFRAME
    ? null
    : await readBars(dataDir, symbol, BASE_TIMEFRAME, from, to + 86_400_000, true);

  parentPort.postMessage({ type: 'stage', stage: 'running', bars: bars.length });

  const result = runSweep({
    strategy,
    ranges,
    base,
    bars,
    baseBars,
    from,
    to,
    balance,
    trainFraction,
    metric,
    minTrades,
    showCount,
    onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
    shouldStop: () => stopFlag != null && stopFlag[0] === 1,
  });

  parentPort.postMessage({ type: 'done', result });
}

main().catch((err) => {
  parentPort.postMessage({
    type: err instanceof SweepCancelled ? 'cancelled' : 'error',
    message: err.message,
  });
});
