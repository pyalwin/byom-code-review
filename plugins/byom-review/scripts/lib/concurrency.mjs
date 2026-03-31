const DEFAULT_STRAGGLER_TIMEOUT_MS = 300_000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 300_000;

export function getTimeoutConfig() {
  const straggler = Number(process.env.BYOM_STRAGGLER_TIMEOUT_MS) || DEFAULT_STRAGGLER_TIMEOUT_MS;
  const global = Number(process.env.BYOM_GLOBAL_TIMEOUT_MS) || DEFAULT_GLOBAL_TIMEOUT_MS;
  return { straggler, global };
}

/**
 * Run async tasks with bounded concurrency and straggler detection.
 *
 * @param {Array<{ key: string, fn: (signal: AbortSignal) => Promise<T> }>} tasks
 * @param {{ concurrency?: number, stragglerMs?: number, globalMs?: number }} options
 * @returns {Promise<Array<{ key: string, value?: T, error?: Error, timedOut?: boolean }>>}
 */
export async function asyncPoolWithStragglerTimeout(tasks, options = {}) {
  const concurrency = options.concurrency ?? 3;
  const { straggler: defaultStragglerMs, global: defaultGlobalMs } = getTimeoutConfig();
  const stragglerMs = options.stragglerMs ?? defaultStragglerMs;
  const globalMs = options.globalMs ?? defaultGlobalMs;

  const globalController = new AbortController();
  const results = new Array(tasks.length);
  let completedCount = 0;
  let hasSuccess = false;
  let stragglerTimer = null;
  let globalTimer = null;

  function clearTimers() {
    if (stragglerTimer) clearTimeout(stragglerTimer);
    if (globalTimer) clearTimeout(globalTimer);
    stragglerTimer = null;
    globalTimer = null;
  }

  function armStragglerTimer() {
    if (stragglerTimer) clearTimeout(stragglerTimer);
    stragglerTimer = setTimeout(() => {
      globalController.abort();
    }, stragglerMs);
  }

  globalTimer = setTimeout(() => {
    globalController.abort();
  }, globalMs);

  async function runTask(index) {
    const { key, fn } = tasks[index];
    try {
      const value = await fn(globalController.signal);
      results[index] = { key, value };
      hasSuccess = true;
    } catch (error) {
      if (globalController.signal.aborted) {
        results[index] = { key, timedOut: true, error };
      } else {
        results[index] = { key, error };
      }
    } finally {
      completedCount += 1;
      if (completedCount === tasks.length) {
        clearTimers();
      } else if (hasSuccess) {
        armStragglerTimer();
      }
    }
  }

  const executing = new Set();
  let nextIndex = 0;

  async function enqueue() {
    while (nextIndex < tasks.length && !globalController.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const promise = runTask(index).then(() => {
        executing.delete(promise);
      });
      executing.add(promise);
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }
  }

  await enqueue();
  await Promise.allSettled(executing);

  clearTimers();

  for (let i = 0; i < results.length; i += 1) {
    if (!results[i]) {
      results[i] = { key: tasks[i].key, timedOut: true, error: new Error("Aborted before dispatch") };
    }
  }

  return results;
}
