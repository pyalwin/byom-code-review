const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "minimax/minimax-m2.7";
const API_KEY_ENV = "OPENROUTER_API_KEY";
const DEFAULT_MODEL_ENV = "BYOM_DEFAULT_MODEL";

export { API_KEY_ENV, DEFAULT_MODEL_ENV, DEFAULT_MODEL };

export class OpenRouterClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env[API_KEY_ENV] || "";
    this.baseUrl = options.baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;
    this.defaultModel = options.defaultModel || process.env[DEFAULT_MODEL_ENV] || DEFAULT_MODEL;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  async chatCompletion({ messages, model, responseFormat, temperature, maxTokens, signal }) {
    if (!this.apiKey) {
      throw new Error(
        `OPENROUTER_API_KEY is not set. Get one at https://openrouter.ai/keys and set it in your environment.`
      );
    }

    const body = {
      model: model || this.defaultModel,
      messages
    };

    if (responseFormat) {
      body.response_format = responseFormat;
    }
    if (temperature != null) {
      body.temperature = temperature;
    }
    if (maxTokens != null) {
      body.max_tokens = maxTokens;
    }

    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/jkrish/byom-code-review",
        "X-Title": "byom-code-review"
      },
      body: JSON.stringify(body)
    };
    if (signal) {
      fetchOptions.signal = signal;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, fetchOptions);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let detail = "";
      try {
        const parsed = JSON.parse(errorBody);
        detail = parsed.error?.message || parsed.error || errorBody;
      } catch {
        detail = errorBody;
      }
      throw new Error(
        `OpenRouter API error (${response.status}): ${detail}`
      );
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      model: data.model ?? body.model,
      usage: data.usage ?? null,
      id: data.id ?? null
    };
  }

  async listModels() {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/jkrish/byom-code-review",
        "X-Title": "byom-code-review"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to list models (${response.status})`);
    }

    const data = await response.json();
    return data.data ?? [];
  }

  /**
   * Check which models support structured_outputs (json_schema response format).
   * Returns a Set of model IDs that support it.
   */
  async getStructuredOutputSupport(modelIds) {
    try {
      const allModels = await this.listModels();
      const lookup = new Map(allModels.map((m) => [m.id, m]));
      const supported = new Set();
      for (const id of modelIds) {
        const meta = lookup.get(id);
        if (meta?.supported_parameters?.includes("structured_outputs")) {
          supported.add(id);
        }
      }
      return supported;
    } catch {
      // If the models endpoint fails, assume all support it and let the
      // runtime fallback handle any that don't.
      return new Set(modelIds);
    }
  }

  async validateApiKey() {
    try {
      const models = await this.listModels();
      return { valid: true, modelCount: models.length };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
}
