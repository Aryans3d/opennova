/**
 * Provider presets. A role in config names a provider and a model:
 *
 *   { "provider": "anthropic", "model": "claude-haiku-5-5" }
 *   { "provider": "ollama",    "model": "qwen3:14b" }
 *   { "provider": "custom",    "model": "...", "baseURL": "https://host/v1", "apiKeyEnv": "MY_KEY" }
 *
 * `kind` selects the wire format (adapter). Everything that speaks the
 * OpenAI chat-completions format shares one adapter.
 */

const PROVIDERS = {
    anthropic: { kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', local: false },
    openai: { kind: 'openai', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', tokenParam: 'max_completion_tokens' },
    gemini: { kind: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnv: 'GEMINI_API_KEY', altKeyEnv: 'GOOGLE_API_KEY' },
    google: { kind: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnv: 'GEMINI_API_KEY', altKeyEnv: 'GOOGLE_API_KEY' },
    openrouter: { kind: 'openai', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    groq: { kind: 'openai', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
    deepseek: { kind: 'openai', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    mistral: { kind: 'openai', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY' },
    xai: { kind: 'openai', baseURL: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' },
    together: { kind: 'openai', baseURL: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
    ollama: { kind: 'openai', baseURL: 'http://localhost:11434/v1', local: true },
    lmstudio: { kind: 'openai', baseURL: 'http://localhost:1234/v1', local: true },
    custom: { kind: 'openai' }
};

/**
 * Merge a role's config with its preset and resolve the API key from the
 * environment. Keys are never read from the config file.
 */
function resolveRole(role) {
    if (!role || !role.provider || !role.model) return null;
    const preset = PROVIDERS[role.provider.toLowerCase()];
    if (!preset) throw new Error(`unknown LLM provider "${role.provider}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
    const merged = { ...preset, ...role, provider: role.provider.toLowerCase() };
    const envName = merged.apiKeyEnv;
    merged.apiKey = (envName && process.env[envName]) || (merged.altKeyEnv && process.env[merged.altKeyEnv]) || null;
    if (merged.kind !== 'anthropic' && !merged.baseURL) throw new Error(`provider "${role.provider}" needs a baseURL`);
    if (merged.baseURL) merged.baseURL = merged.baseURL.replace(/\/+$/, '');
    merged.needsKey = !merged.local && merged.kind !== 'anthropic' && merged.provider !== 'custom';
    return merged;
}

module.exports = { PROVIDERS, resolveRole };
