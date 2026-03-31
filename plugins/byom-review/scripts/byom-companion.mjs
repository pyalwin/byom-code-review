#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { OpenRouterClient, API_KEY_ENV, DEFAULT_MODEL_ENV, DEFAULT_MODEL } from "./lib/openrouter.mjs";
import { readOutputSchema, runReview } from "./lib/review-engine.mjs";
import { renderReviewResult, renderMultiModelResult } from "./lib/render.mjs";
import { asyncPoolWithStragglerTimeout } from "./lib/concurrency.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/byom-companion.mjs setup [--json]",
      "  node scripts/byom-companion.mjs review [--model <id>] [--models <id,id,...>] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/byom-companion.mjs adversarial-review [--model <id>] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function ensureApiKeyReady() {
  if (!process.env[API_KEY_ENV]) {
    throw new Error(
      `${API_KEY_ENV} is not set. Get an API key at https://openrouter.ai/keys and export it in your environment.`
    );
  }
}

function buildSetupReport() {
  const apiKey = process.env[API_KEY_ENV] ?? "";
  const defaultModel = process.env[DEFAULT_MODEL_ENV] || DEFAULT_MODEL;
  const hasKey = Boolean(apiKey);

  const nextSteps = [];
  if (!hasKey) {
    nextSteps.push(`Set ${API_KEY_ENV} with your OpenRouter API key from https://openrouter.ai/keys`);
  }

  return {
    ready: hasKey,
    apiKeyConfigured: hasKey,
    defaultModel,
    nextSteps
  };
}

function renderSetupReport(report) {
  const lines = [];
  lines.push(`BYOM Code Review Setup`);
  lines.push(`─────────────────────`);
  lines.push(`API Key: ${report.apiKeyConfigured ? "✓ configured" : "✗ not set"}`);
  lines.push(`Default Model: ${report.defaultModel}`);
  lines.push(`Ready: ${report.ready ? "yes" : "no"}`);
  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`  • ${step}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const report = buildSetupReport();
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_INPUT: context.content
  });
}

function buildStandardReviewPrompt(context) {
  const template = loadPromptTemplate(ROOT_DIR, "code-review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    REVIEW_INPUT: context.content
  });
}


function parseModelsList(modelsString) {
  const raw = modelsString.split(",").map((s) => s.trim()).filter(Boolean);
  const unique = [...new Set(raw.map((s) => s.toLowerCase()))].map((lower) => raw.find((r) => r.toLowerCase() === lower));
  if (unique.length < 2) {
    throw new Error("--models requires at least 2 models for comparison.");
  }
  if (unique.length > 5) {
    throw new Error(`Maximum 5 models allowed for comparison. You provided ${unique.length}.`);
  }
  return unique;
}

async function executeMultiModelReview(request) {
  ensureApiKeyReady();
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  const context = collectReviewContext(request.cwd, target);
  const schema = readOutputSchema(REVIEW_SCHEMA_PATH);
  const systemPrompt = buildStandardReviewPrompt(context);

  const capabilityClient = new OpenRouterClient();
  const structuredOutputModels = await capabilityClient.getStructuredOutputSupport(request.models);

  const tasks = request.models.map((model) => ({
    key: model,
    fn: async (signal) => {
      const client = new OpenRouterClient();
      const start = Date.now();
      const reviewResult = await runReview({
        client,
        gitContext: context,
        systemPrompt,
        schema,
        model,
        signal,
        useJsonSchema: structuredOutputModels.has(model)
      });
      return {
        reviewResult,
        durationMs: Date.now() - start
      };
    }
  }));

  const poolResults = await asyncPoolWithStragglerTimeout(tasks, {
    concurrency: 3
  });

  const modelResults = poolResults
    .map((r) => {
      if (r.timedOut) {
        return {
          model: r.key,
          status: "timeout",
          review: null,
          usage: null,
          error: "Aborted: did not complete within straggler/global timeout",
          durationMs: null
        };
      }
      if (r.error) {
        return {
          model: r.key,
          status: "error",
          review: null,
          usage: null,
          error: r.error instanceof Error ? r.error.message : String(r.error),
          durationMs: null
        };
      }
      const { reviewResult, durationMs } = r.value;
      return {
        model: reviewResult.model,
        status: "success",
        review: {
          result: reviewResult.result,
          parsed: reviewResult.result.parsed,
          rawOutput: reviewResult.result.rawOutput,
          parseError: reviewResult.result.parseError
        },
        usage: reviewResult.usage,
        error: null,
        durationMs
      };
    })
    .sort((a, b) => a.model.toLowerCase().localeCompare(b.model.toLowerCase()));

  const successes = modelResults.filter((r) => r.status === "success");
  const hasAnySuccess = successes.length > 0;

  const payload = {
    review: "Review",
    target,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    models: modelResults.map((r) => ({
      model: r.model,
      status: r.status,
      review: r.review?.parsed ?? null,
      usage: r.usage,
      error: r.error,
      durationMs: r.durationMs
    })),
    aggregate: {
      requested: modelResults.length,
      completed: successes.length,
      failed: modelResults.length - successes.length,
      totalCost: modelResults.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0),
      totalDurationMs: Math.max(...modelResults.map((r) => r.durationMs ?? 0))
    }
  };

  const rendered = renderMultiModelResult(modelResults, {
    reviewLabel: "Review",
    targetLabel: context.target.label
  });

  return {
    exitStatus: hasAnySuccess ? 0 : 1,
    payload,
    rendered,
    summary: hasAnySuccess
      ? `Multi-model review complete: ${successes.length}/${modelResults.length} models returned results.`
      : "All models failed to return results."
  };
}

async function executeReviewRun(request) {
  ensureApiKeyReady();
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  const context = collectReviewContext(request.cwd, target);
  const schema = readOutputSchema(REVIEW_SCHEMA_PATH);
  const client = new OpenRouterClient();

  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const systemPrompt =
    reviewName === "Adversarial Review"
      ? buildAdversarialReviewPrompt(context, focusText)
      : buildStandardReviewPrompt(context);

  const modelId = request.model || client.defaultModel;
  const structuredOutputModels = await client.getStructuredOutputSupport([modelId]);

  const reviewResult = await runReview({
    client,
    gitContext: context,
    systemPrompt,
    schema,
    model: modelId,
    useJsonSchema: structuredOutputModels.has(modelId)
  });

  const parsed = reviewResult.result;
  const payload = {
    review: reviewName,
    target,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    model: reviewResult.model,
    usage: reviewResult.usage,
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError
  };

  return {
    exitStatus: reviewResult.status,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      model: reviewResult.model,
      usage: reviewResult.usage
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(parsed.rawOutput, `${reviewName} finished.`)
  };
}

async function handleReview(argv, reviewName = "Review") {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "models", "cwd"],
    booleanOptions: ["json", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  if (options.model && options.models) {
    throw new Error("Cannot use --model and --models together. Use --models for multi-model comparison.");
  }

  if (options.models && reviewName === "Adversarial Review") {
    throw new Error("--models is not supported for adversarial reviews yet.");
  }

  const cwd = resolveCommandCwd(options);

  if (options.models) {
    const models = parseModelsList(options.models);
    const execution = await executeMultiModelReview({
      cwd,
      base: options.base,
      scope: options.scope,
      models
    });

    outputResult(options.json ? execution.payload : execution.rendered, options.json);
    if (execution.exitStatus !== 0) {
      process.exitCode = execution.exitStatus;
    }
    return;
  }

  const focusText = positionals.join(" ").trim();

  const execution = await executeReviewRun({
    cwd,
    base: options.base,
    scope: options.scope,
    model: options.model,
    focusText,
    reviewName
  });

  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "review":
      await handleReview(argv, "Review");
      break;
    case "adversarial-review":
      await handleReview(argv, "Adversarial Review");
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
