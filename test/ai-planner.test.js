import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanner } from '../ai-planner.js';

// Fake Anthropic-shaped client. NEVER hits the network.
const fakeClient = (impl) => ({ messages: { create: impl } });
const reply = (text, usage = {}) => ({ content: [{ type: 'text', text }], usage });

test('consult: parses the JSON body and normalises usage', async () => {
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    client: fakeClient(async () => reply('{"decision":"PLAN","bullLevel":105,"bearLevel":95}',
      { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 })),
  });
  const r = await p.consult('sys', 'user');
  assert.equal(r.json.bullLevel, 105);
  assert.deepEqual(r.usage, {
    inputTokens: 10, outputTokens: 20, cacheRead: 5, cacheCreation: 0, reasoningTokens: 0,
  });
});

// The four original fields silently dropped every other key the provider sent,
// which is how a 7258-token answer could not be told apart from a 7258-token
// THOUGHT. Each spelling below is a real one across DeepSeek / OpenAI-compatible
// endpoints; taking the first NUMBER (not the first defined value) is what stops
// a present-but-null field masking a populated one further down.
test('consult: captures reasoning tokens however the provider spells them', async () => {
  const shapes = [
    { reasoning_tokens: 7000 },
    { output_tokens_details: { reasoning_tokens: 7000 } },
    { completion_tokens_details: { reasoning_tokens: 7000 } },
    { reasoning_tokens: null, completion_tokens_details: { reasoning_tokens: 7000 } },
  ];
  for (const usage of shapes) {
    const p = new AiPlanner('k', 'm', { client: fakeClient(async () => reply('{"a":1}', usage)) });
    assert.equal((await p.consult('s', 'u')).usage.reasoningTokens, 7000, JSON.stringify(usage));
  }
});

test('consult: a provider that reports no reasoning field yields 0, never NaN', async () => {
  const p = new AiPlanner('k', 'm', {
    client: fakeClient(async () => reply('{"a":1}', { output_tokens: 20 })),
  });
  // 0 is meaningful here: it says the output IS the answer, so brevity
  // instructions are the right lever. NaN would read as 'unknown' and mislead.
  assert.equal((await p.consult('s', 'u')).usage.reasoningTokens, 0);
});

test('consult: strips markdown fences the model adds anyway', async () => {
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    client: fakeClient(async () => reply('```json\n{"decision":"PLAN","bullLevel":1}\n```')),
  });
  assert.equal((await p.consult('s', 'u')).json.bullLevel, 1);
});

test('consult: concatenates text blocks and ignores non-text ones', async () => {
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    client: fakeClient(async () => ({
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"decision":"PLAN"}' }],
      usage: {},
    })),
  });
  assert.equal((await p.consult('s', 'u')).json.decision, 'PLAN');
});

test('consult: reads DeepSeek-native cache field when the Anthropic one is absent', async () => {
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    client: fakeClient(async () => reply('{"a":1}', { prompt_cache_hit_tokens: 42 })),
  });
  assert.equal((await p.consult('s', 'u')).usage.cacheRead, 42);
});

test('consult: retries a transient failure then succeeds', async () => {
  let calls = 0;
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    backoffMs: 0,
    client: fakeClient(async () => {
      calls++;
      if (calls < 3) throw new Error('502 upstream');
      return reply('{"decision":"PLAN","bullLevel":7}');
    }),
  });
  assert.equal((await p.consult('s', 'u')).json.bullLevel, 7);
  assert.equal(calls, 3, 'should have taken exactly 3 attempts');
});

test('consult: gives up after 3 attempts and throws', async () => {
  let calls = 0;
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    backoffMs: 0,
    client: fakeClient(async () => { calls++; throw new Error('down'); }),
  });
  await assert.rejects(() => p.consult('s', 'u'), /after 3 attempts/);
  assert.equal(calls, 3, 'must not exceed the retry cap');
});

test('consult: unparseable output is retried, not returned', async () => {
  let calls = 0;
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    backoffMs: 0,
    client: fakeClient(async () => { calls++; return reply('I cannot help with that.'); }),
  });
  await assert.rejects(() => p.consult('s', 'u'));
  assert.equal(calls, 3, 'a non-JSON reply is a failed attempt, not a success');
});

test('consult: backoff grows between attempts', async () => {
  const waits = [];
  let calls = 0;
  const p = new AiPlanner('k', 'deepseek-v4-flash', {
    backoffMs: 10,
    sleep: async (ms) => { waits.push(ms); },
    client: fakeClient(async () => { calls++; throw new Error('x'); }),
  });
  await assert.rejects(() => p.consult('s', 'u'));
  assert.deepEqual(waits, [10, 20], 'exponential, and no sleep after the final attempt');
});
