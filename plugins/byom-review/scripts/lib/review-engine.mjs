import { readJsonFile } from "./fs.mjs";

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "No response received from the model.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const cleaned = extractJsonFromResponse(rawOutput);

  try {
    return {
      parsed: JSON.parse(cleaned),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

function extractJsonFromResponse(text) {
  const trimmed = text.trim();

  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  return trimmed;
}

function buildStructuredOutputInstructions(schema) {
  return [
    "You MUST respond with valid JSON matching the following schema. Do not include any text outside the JSON object.",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export async function runReview({ client, gitContext, systemPrompt, schema, model, signal, useJsonSchema = true }) {
  const messages = [];

  if (useJsonSchema) {
    messages.push({ role: "system", content: systemPrompt });
  } else {
    messages.push({
      role: "system",
      content: `${systemPrompt}\n\n${buildStructuredOutputInstructions(schema)}`
    });
  }

  messages.push({
    role: "user",
    content: gitContext.content
  });

  const responseFormat = useJsonSchema
    ? {
        type: "json_schema",
        json_schema: {
          name: "review_output",
          strict: true,
          schema
        }
      }
    : { type: "json_object" };

  let result;
  try {
    result = await client.chatCompletion({
      messages,
      model,
      responseFormat,
      signal
    });
  } catch (error) {
    if (useJsonSchema && error.message?.includes("does not support")) {
      return runReview({ client, gitContext, systemPrompt, schema, model, signal, useJsonSchema: false });
    }
    throw error;
  }

  // Some models silently return empty content when they don't support json_schema —
  // retry with json_object fallback (schema injected into the prompt instead).
  if (useJsonSchema && !result.content) {
    return runReview({ client, gitContext, systemPrompt, schema, model, signal, useJsonSchema: false });
  }

  const parsed = parseStructuredOutput(result.content);

  return {
    status: parsed.parsed ? 0 : 1,
    result: parsed,
    model: result.model,
    usage: result.usage
  };
}
