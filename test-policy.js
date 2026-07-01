const test = require('node:test');
const assert = require('node:assert/strict');
const { applySingleProviderPolicy } = require('./out/modelPolicy.js');

test('applySingleProviderPolicy returns full stack when strict is disabled', () => {
    const stack = [
        { provider: 'moonshot', model: 'kimi-k2.7-code' },
        { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }
    ];

    const result = applySingleProviderPolicy(stack, 'moonshot', false);
    assert.deepEqual(result, stack);
});

test('applySingleProviderPolicy keeps only configured provider when strict is enabled', () => {
    const stack = [
        { provider: 'moonshot', model: 'kimi-k2.7-code' },
        { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
        { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' }
    ];

    const result = applySingleProviderPolicy(stack, 'openrouter', true);
    assert.deepEqual(result, [
        { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
        { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' }
    ]);
});

test('applySingleProviderPolicy returns empty stack when no candidate matches provider', () => {
    const stack = [
        { provider: 'moonshot', model: 'kimi-k2.7-code' }
    ];

    const result = applySingleProviderPolicy(stack, 'openrouter', true);
    assert.deepEqual(result, []);
});
