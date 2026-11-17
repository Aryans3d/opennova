const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { LLM } = require('../src/llm/client');
const { resolveRole, PROVIDERS } = require('../src/llm/providers');
const { extractToolCalls } = require('../src/llm/openai-compatible');
const { cleanSchema } = require('../src/llm/gemini');

const TOOLS = [
    { name: 'obtain', description: 'get an item', parameters: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['item'] } },
    { name: 'eat', description: 'eat food', parameters: { type: 'object', properties: {} } }
];
const REQUEST = { system: 'You are a test bot.', messages: [{ role: 'user', content: 'get me 3 sticks' }], tools: TOOLS };

const servers = new Set();
test.afterEach(() => {
    // Close anything a failed assertion left open, so the run cannot hang.
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    servers.clear();
});

/** Start a mock API; `handler(req, body)` returns {status, json}. */
function mock(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : {};
            seen.push({ url: req.url, headers: req.headers, body });
            const out = handler(req, body, seen.length);
            res.writeHead(out.status || 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.json));
        });
    });
    servers.add(server);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => { servers.delete(server); server.closeAllConnections(); server.close(r); }) });
    }));
}

test('every main provider has a preset', () => {
    for (const p of ['anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'together', 'ollama', 'lmstudio', 'custom']) {
        assert.ok(PROVIDERS[p], p);
    }
    assert.throws(() => resolveRole({ provider: 'nope', model: 'x' }), /unknown LLM provider/);
    assert.throws(() => resolveRole({ provider: 'custom', model: 'x' }), /baseURL/);
    assert.strictEqual(resolveRole({ provider: 'ollama', model: 'qwen3:14b' }).needsKey, false);
});

test('a hosted provider without its key is reported, not used', () => {
    delete process.env.OPENAI_API_KEY;
    const llm = new LLM({ fast: { provider: 'openai', model: 'some-model' } });
    assert.strictEqual(llm.enabled, false);
    assert.match(llm.problems[0], /OPENAI_API_KEY/);
});

test('openai-compatible: request shape and tool call parsing', async () => {
    const api = await mock(() => ({
        json: {
            model: 'm1',
            choices: [{ finish_reason: 'tool_calls', message: { content: 'On it.', tool_calls: [{ id: '1', type: 'function', function: { name: 'obtain', arguments: '{"item":"stick","count":3}' } }] } }],
            usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } }
        }
    }));
    process.env.TEST_KEY = 'sk-test';
    const llm = new LLM({ fast: { provider: 'custom', model: 'm1', baseURL: api.url + '/v1/', apiKeyEnv: 'TEST_KEY' } });
    const res = await llm.complete('fast', REQUEST);
    await api.close();
    assert.strictEqual(res.text, 'On it.');
    assert.deepStrictEqual(res.toolCalls, [{ name: 'obtain', args: { item: 'stick', count: 3 } }]);
    assert.deepStrictEqual(res.usage, { input: 100, output: 20, cached: 80 });
    const sent = api.seen[0];
    assert.strictEqual(sent.url, '/v1/chat/completions');
    assert.strictEqual(sent.headers.authorization, 'Bearer sk-test');
    assert.strictEqual(sent.body.messages[0].role, 'system');
    assert.strictEqual(sent.body.tools[0].function.name, 'obtain');
    assert.strictEqual(sent.body.max_tokens, 4096);
});

test('openai preset uses max_completion_tokens', async () => {
    const api = await mock(() => ({ json: { choices: [{ message: { content: 'hi' } }] } }));
    process.env.OPENAI_API_KEY = 'k';
    const llm = new LLM({ fast: { provider: 'openai', model: 'x', baseURL: api.url } });
    await llm.complete('fast', REQUEST);
    await api.close();
    delete process.env.OPENAI_API_KEY;
    assert.ok('max_completion_tokens' in api.seen[0].body);
    assert.ok(!('max_tokens' in api.seen[0].body));
});

test('local models that print tool calls as text are still understood', async () => {
    const api = await mock(() => ({
        json: { choices: [{ message: { content: '<think>hmm</think>Sure!\n<tool_call>\n{"name": "obtain", "arguments": {"item": "stick"}}\n</tool_call>' } }] }
    }));
    const llm = new LLM({ fast: { provider: 'ollama', model: 'qwen3:8b', baseURL: api.url } });
    const res = await llm.complete('fast', REQUEST);
    await api.close();
    assert.deepStrictEqual(res.toolCalls, [{ name: 'obtain', args: { item: 'stick' } }]);
    assert.strictEqual(res.text, 'Sure!');
    assert.strictEqual(api.seen[0].headers.authorization, undefined);
});

test('extractToolCalls ignores JSON that is not a known tool', () => {
    const names = new Set(['obtain']);
    assert.strictEqual(extractToolCalls('{"name":"rm_rf","arguments":{}}', names).calls.length, 0);
    assert.strictEqual(extractToolCalls('```json\n[{"name":"obtain","arguments":{"item":"a"}},{"name":"obtain","parameters":{"item":"b"}}]\n```', names).calls.length, 2);
    assert.strictEqual(extractToolCalls('just words', names).calls.length, 0);
});

test('transient errors are retried, auth errors disable the client', async () => {
    const api = await mock((req, body, n) => (n < 2 ? { status: 503, json: { error: { message: 'busy' } } } : { json: { choices: [{ message: { content: 'ok' } }] } }));
    const llm = new LLM({ fast: { provider: 'ollama', model: 'x', baseURL: api.url } });
    const res = await llm.complete('fast', REQUEST);
    assert.strictEqual(res.text, 'ok');
    assert.strictEqual(api.seen.length, 2);
    await api.close();

    const denied = await mock(() => ({ status: 401, json: { error: { message: 'bad key' } } }));
    const llm2 = new LLM({ fast: { provider: 'ollama', model: 'x', baseURL: denied.url } });
    await assert.rejects(llm2.complete('fast', REQUEST), e => e.kind === 'auth');
    assert.strictEqual(llm2.enabled, false);
    await assert.rejects(llm2.complete('fast', REQUEST), e => e.kind === 'auth');
    assert.strictEqual(denied.seen.length, 1, 'no second request after a rejected key');
    await denied.close();
});

test('hourly budget stops further calls', async () => {
    const api = await mock(() => ({ json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }));
    const llm = new LLM({ fast: { provider: 'ollama', model: 'x', baseURL: api.url }, budget: { callsPerHour: 2 } });
    await llm.complete('fast', REQUEST);
    await llm.complete('fast', REQUEST);
    await assert.rejects(llm.complete('fast', REQUEST), e => e.kind === 'budget');
    assert.deepStrictEqual(llm.spent(), { calls: 2, tokens: 30 });
    await api.close();
});

test('gemini: request shape and function call parsing', async () => {
    const api = await mock(() => ({
        json: {
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Getting sticks.' }, { functionCall: { name: 'obtain', args: { item: 'stick', count: 3 } } }] } }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 }
        }
    }));
    process.env.GEMINI_API_KEY = 'g-key';
    const llm = new LLM({ fast: { provider: 'gemini', model: 'gemini-test', baseURL: api.url } });
    const res = await llm.complete('fast', REQUEST);
    await api.close();
    delete process.env.GEMINI_API_KEY;
    assert.strictEqual(res.text, 'Getting sticks.');
    assert.deepStrictEqual(res.toolCalls, [{ name: 'obtain', args: { item: 'stick', count: 3 } }]);
    const sent = api.seen[0];
    assert.strictEqual(sent.url, '/models/gemini-test:generateContent');
    assert.strictEqual(sent.headers['x-goog-api-key'], 'g-key');
    assert.strictEqual(sent.body.systemInstruction.parts[0].text, 'You are a test bot.');
    const decls = sent.body.tools[0].functionDeclarations;
    assert.strictEqual(decls[0].parameters.properties.count.minimum, 1);
    assert.strictEqual(decls[1].parameters, undefined, 'no empty parameter object for no-arg tools');
});

test('gemini schema cleaning drops unsupported keywords', () => {
    const cleaned = cleanSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', default: 'x', minLength: 1, enum: ['x'] } } });
    assert.deepStrictEqual(cleaned, { type: 'object', properties: { a: { type: 'string', enum: ['x'] } } });
});

test('anthropic: cached system block, tools, effort, and parsed tool_use', async () => {
    const api = await mock(() => ({
        json: {
            id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'tool_use',
            content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'tu_1', name: 'obtain', input: { item: 'stick', count: 3 } }],
            usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }
        }
    }));
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const llm = new LLM({ fast: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', baseURL: api.url, maxRetries: 0 } });
    const res = await llm.complete('fast', REQUEST);
    assert.strictEqual(res.text, 'On it.');
    assert.deepStrictEqual(res.toolCalls, [{ name: 'obtain', args: { item: 'stick', count: 3 } }]);
    assert.deepStrictEqual(res.usage, { input: 940, output: 12, cached: 900 });
    const sent = api.seen[0];
    assert.match(sent.url, /^\/v1\/messages/);
    // The SDK chooses the auth header; only check that the key was sent.
    assert.ok([sent.headers['x-api-key'], sent.headers.authorization].some(h => String(h).includes('sk-ant-test')));
    assert.deepStrictEqual(sent.body.system, [{ type: 'text', text: 'You are a test bot.', cache_control: { type: 'ephemeral' } }]);
    assert.strictEqual(sent.body.tools[0].input_schema.type, 'object');
    assert.deepStrictEqual(sent.body.output_config, { effort: 'low' });
    assert.strictEqual(sent.body.fallbacks, undefined, 'Haiku has no server-side fallback');
    assert.strictEqual(sent.body.thinking, undefined);
    assert.strictEqual(sent.body.temperature, undefined);
    await api.close();
});

test('anthropic: Opus opts into the refusal fallback and refusals are surfaced', async () => {
    const api = await mock(() => ({
        json: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [], usage: { input_tokens: 5, output_tokens: 0 } }
    }));
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const llm = new LLM({ smart: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', baseURL: api.url, maxRetries: 0 } });
    const res = await llm.complete('smart', REQUEST);
    assert.strictEqual(res.refused, true);
    const sent = api.seen[0];
    assert.strictEqual(sent.body.fallbacks, 'default');
    assert.match(String(sent.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    await api.close();
    delete process.env.ANTHROPIC_API_KEY;
});

test('asking for a role that is not configured falls back to the other', async () => {
    const api = await mock(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
    const llm = new LLM({ fast: { provider: 'ollama', model: 'x', baseURL: api.url } });
    const res = await llm.complete('smart', REQUEST);
    assert.strictEqual(res.role, 'fast');
    assert.strictEqual(llm.has('smart'), false);
    await api.close();
});
