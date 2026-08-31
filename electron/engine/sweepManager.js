/* Owns the sweep worker: one at a time, with progress and a stop button.
 *
 * One at a time on purpose. Two sweeps would compete for the same cores and
 * both finish later than either would alone, and the UI has one place to show
 * progress. Asking for a second while one runs is refused rather than queued —
 * a queue would leave someone waiting on work they cannot see.
 *
 * Stopping goes through a SharedArrayBuffer rather than a message. The worker
 * never yields to its message queue while the loop is running, so a posted
 * stop would not be read until the sweep had already finished. A shared byte
 * can be read between combinations.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./sweepWorker.js', import.meta.url));

let active = null;   // { worker, stop, onEvent, request }

export function isSweepRunning() {
  return active !== null;
}

/**
 * Starts a sweep and resolves with its result.
 *
 * @param {object} request     everything the worker needs; see sweepWorker
 * @param {(e:object)=>void} onEvent  progress and stage messages
 */
export function startSweep(request, onEvent) {
  if (active) throw new Error('A sweep is already running');

  /* One byte, shared with the worker. Allocated per sweep so a stop meant for
   * one can never linger and stop the next. */
  const stopFlag = new SharedArrayBuffer(1);
  const stop = new Uint8Array(stopFlag);

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { request, stopFlag } });
    active = { worker, stop, onEvent, request };

    // Whatever happens, the slot has to be released or nothing can run again.
    const finish = (fn, value) => {
      active = null;
      worker.terminate().catch(() => {});
      fn(value);
    };

    worker.on('message', (message) => {
      if (message.type === 'done') {
        finish(resolve, { ...message.result, cancelled: false });
        return;
      }
      if (message.type === 'cancelled') {
        /* Not an error: the user asked. Resolving with a flag lets the caller
         * tell "you stopped it" from "it broke", which a rejection cannot. */
        finish(resolve, { cancelled: true });
        return;
      }
      if (message.type === 'error') {
        finish(reject, new Error(message.message));
        return;
      }
      onEvent?.(message);
    });

    worker.on('error', (err) => finish(reject, err));

    worker.on('exit', (code) => {
      // Only reached when nothing above already settled the promise.
      if (active?.worker === worker) {
        finish(reject, new Error(`The sweep stopped unexpectedly (exit ${code})`));
      }
    });
  });
}

/** Asks the running sweep to stop after the combination it is on. */
export function stopSweep() {
  if (!active) return false;
  active.stop[0] = 1;
  return true;
}
