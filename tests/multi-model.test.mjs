import test from "node:test";
import assert from "node:assert/strict";

import { asyncPoolWithStragglerTimeout } from "../plugins/byom-review/scripts/lib/concurrency.mjs";
import { renderMultiModelResult } from "../plugins/byom-review/scripts/lib/render.mjs";

// --- parseModelsList (tested via the companion script's internal function) ---
// We test the validation logic inline since parseModelsList is not exported.
// Instead we test the pool + render layers directly.

// --- asyncPoolWithStragglerTimeout ---

test("pool runs all tasks and returns results", async () => {
  const tasks = [
    { key: "a", fn: async () => "result-a" },
    { key: "b", fn: async () => "result-b" },
    { key: "c", fn: async () => "result-c" }
  ];

  const results = await asyncPoolWithStragglerTimeout(tasks, {
    concurrency: 2,
    stragglerMs: 5000,
    globalMs: 10000
  });

  assert.equal(results.length, 3);
  assert.equal(results[0].value, "result-a");
  assert.equal(results[1].value, "result-b");
  assert.equal(results[2].value, "result-c");
  assert.ok(!results[0].error);
});

test("pool respects concurrency limit", async () => {
  let maxConcurrent = 0;
  let running = 0;

  const tasks = Array.from({ length: 5 }, (_, i) => ({
    key: `task-${i}`,
    fn: async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 50));
      running -= 1;
      return i;
    }
  }));

  await asyncPoolWithStragglerTimeout(tasks, {
    concurrency: 2,
    stragglerMs: 5000,
    globalMs: 10000
  });

  assert.ok(maxConcurrent <= 2, `Expected max concurrency <= 2, got ${maxConcurrent}`);
});

test("pool captures per-task errors without failing others", async () => {
  const tasks = [
    { key: "good", fn: async () => "ok" },
    { key: "bad", fn: async () => { throw new Error("boom"); } },
    { key: "also-good", fn: async () => "fine" }
  ];

  const results = await asyncPoolWithStragglerTimeout(tasks, {
    concurrency: 3,
    stragglerMs: 5000,
    globalMs: 10000
  });

  assert.equal(results[0].value, "ok");
  assert.ok(results[1].error);
  assert.equal(results[1].error.message, "boom");
  assert.equal(results[2].value, "fine");
});

test("pool aborts straggler after timeout", async () => {
  const tasks = [
    { key: "fast", fn: async () => "done" },
    {
      key: "slow",
      fn: async (signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 10000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
    }
  ];

  const results = await asyncPoolWithStragglerTimeout(tasks, {
    concurrency: 2,
    stragglerMs: 100,
    globalMs: 30000
  });

  assert.equal(results[0].value, "done");
  assert.ok(results[1].timedOut, "Slow task should be marked as timed out");
});

test("pool applies global timeout when no task succeeds", async () => {
  const tasks = [
    {
      key: "hang-1",
      fn: async (signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 60000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
    },
    {
      key: "hang-2",
      fn: async (signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 60000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
    }
  ];

  const start = Date.now();
  const results = await asyncPoolWithStragglerTimeout(tasks, {
    concurrency: 2,
    stragglerMs: 5000,
    globalMs: 200
  });
  const elapsed = Date.now() - start;

  assert.ok(results[0].timedOut, "First task should be timed out");
  assert.ok(results[1].timedOut, "Second task should be timed out");
  assert.ok(elapsed < 2000, `Should complete quickly via global timeout, took ${elapsed}ms`);
});

test("pool handles all tasks failing with errors", async () => {
  const tasks = [
    { key: "err-1", fn: async () => { throw new Error("fail-1"); } },
    { key: "err-2", fn: async () => { throw new Error("fail-2"); } }
  ];

  const results = await asyncPoolWithStragglerTimeout(tasks, {
    concurrency: 2,
    stragglerMs: 5000,
    globalMs: 10000
  });

  assert.ok(results[0].error);
  assert.ok(results[1].error);
  assert.equal(results[0].error.message, "fail-1");
  assert.equal(results[1].error.message, "fail-2");
});

// --- renderMultiModelResult ---

function makeSuccessResult(model, verdict = "approve") {
  return {
    model,
    status: "success",
    review: {
      result: {
        parsed: {
          verdict,
          summary: `Review from ${model}`,
          findings: [],
          next_steps: []
        },
        parseError: null,
        rawOutput: ""
      }
    },
    usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
    error: null,
    durationMs: 3000
  };
}

function makeFailureResult(model, status = "error") {
  return {
    model,
    status,
    review: null,
    usage: null,
    error: status === "timeout" ? "Aborted: straggler timeout" : "API error",
    durationMs: null
  };
}

test("renderMultiModelResult renders successful reviews", () => {
  const results = [
    makeSuccessResult("openai/gpt-4o"),
    makeSuccessResult("anthropic/claude-sonnet-4", "needs-attention")
  ];

  const output = renderMultiModelResult(results, {
    reviewLabel: "Review",
    targetLabel: "working tree diff"
  });

  assert.ok(output.includes("Model: openai/gpt-4o"));
  assert.ok(output.includes("Model: anthropic/claude-sonnet-4"));
  assert.ok(output.includes("Multi-Model Summary:"));
  assert.ok(output.includes("2 requested, 2 completed, 0 failed"));
});

test("renderMultiModelResult renders failed models section", () => {
  const results = [
    makeSuccessResult("openai/gpt-4o"),
    makeFailureResult("google/gemini-2.0-flash", "timeout")
  ];

  const output = renderMultiModelResult(results, {
    reviewLabel: "Review",
    targetLabel: "working tree diff"
  });

  assert.ok(output.includes("Failed Models:"));
  assert.ok(output.includes("google/gemini-2.0-flash"));
  assert.ok(output.includes("straggler timeout"));
  assert.ok(output.includes("2 requested, 1 completed, 1 failed"));
});

test("renderMultiModelResult handles all failures", () => {
  const results = [
    makeFailureResult("model-a", "error"),
    makeFailureResult("model-b", "timeout")
  ];

  const output = renderMultiModelResult(results, {
    reviewLabel: "Review",
    targetLabel: "working tree diff"
  });

  assert.ok(output.includes("Failed Models:"));
  assert.ok(output.includes("2 requested, 0 completed, 2 failed"));
});

test("renderMultiModelResult computes aggregate cost from usage", () => {
  const results = [
    makeSuccessResult("model-a"),
    makeSuccessResult("model-b")
  ];
  results[0].usage.cost = 0.005;
  results[1].usage.cost = 0.003;

  const output = renderMultiModelResult(results, {
    reviewLabel: "Review",
    targetLabel: "working tree diff"
  });

  assert.ok(output.includes("$0.008000"));
});

test("renderMultiModelResult tolerates null usage on failed models", () => {
  const results = [
    makeSuccessResult("model-a"),
    makeFailureResult("model-b", "error")
  ];

  const output = renderMultiModelResult(results, {
    reviewLabel: "Review",
    targetLabel: "working tree diff"
  });

  assert.ok(output.includes("Total cost:"));
  assert.ok(output.includes("1 completed"));
});
