// One case per check, plus two that guard the set itself.
//
// The tests assert CODES, not wording: the copy lives in the locales and is
// checked by web/test/resourceCatalog.test.js. Asserting prose here would make
// the suite fail on a reword and pass on a missing translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEffectChecks, CHECK_CODES, CHECK_PARAMS } from '../src/effectChecks.js';

const codes = (doc) => runEffectChecks(doc).map((c) => c.code);

test('an empty document raises nothing', () => {
  assert.deepEqual(runEffectChecks({}), []);
  assert.deepEqual(runEffectChecks(null), []);
});

test('a guardrail with no attachment is reported', () => {
  // The rule exists but watches no traffic: the most common "I configured it
  // and nothing happened".
  const doc = { guardrails: [{ id: 'g1', name: 'block-pii', enabled: true }] };
  assert.deepEqual(codes(doc), ['guardrailNoAttachment']);
});

test('a disabled guardrail with no attachment is not reported', () => {
  const doc = { guardrails: [{ id: 'g1', name: 'block-pii', enabled: false }] };
  assert.deepEqual(codes(doc), []);
});

test('an attachment pointing at a missing guardrail is reported', () => {
  const doc = {
    guardrails: [{ id: 'g1', name: 'block-pii' }],
    guardrail_attachments: [
      { guardrail_id: 'g1', scope_type: 'env', priority: 1 },
      { guardrail_id: 'ghost', scope_type: 'env', priority: 1 },
    ],
  };
  assert.deepEqual(codes(doc), ['attachmentDanglingGuardrail']);
});

test('an attachment without a priority is reported', () => {
  // Required with no default: the row fails to load entirely.
  const doc = {
    guardrails: [{ id: 'g1', name: 'block-pii' }],
    guardrail_attachments: [{ guardrail_id: 'g1', scope_type: 'env' }],
  };
  assert.deepEqual(codes(doc), ['attachmentNoPriority']);
});

test('a provider key with no api_base and no built-in default is reported', () => {
  const doc = { provider_keys: [{ id: 'p1', display_name: 'deepseek', provider: 'deepseek', api_key: 'k' }] };
  assert.deepEqual(codes(doc), ['providerKeyNoApiBase']);
});

test('provider keys that do have a default base are not reported', () => {
  assert.deepEqual(codes({ provider_keys: [{ id: 'p', display_name: 'a', provider: 'openai', api_key: 'k' }] }), []);
  assert.deepEqual(codes({ provider_keys: [{ id: 'p', display_name: 'b', adapter: 'openai', api_key: 'k' }] }), []);
  assert.deepEqual(
    codes({ provider_keys: [{ id: 'p', display_name: 'c', provider: 'deepseek', api_base: 'https://x', api_key: 'k' }] }),
    []
  );
});

test('budgets in this file are reported as not enforced', () => {
  const doc = { budgets: [{ scope: 'team', scope_ref: 't1', period: 'day' }, { scope: 'env', period: 'day' }] };
  assert.deepEqual(codes(doc), ['budgetInFileMode']);
  const finding = runEffectChecks(doc)[0];
  assert.equal(finding.params.n, 2);
});

test('MCP access that is closed by default is reported', () => {
  // No env policy, no team policy, no per-key grant: the intersection is empty.
  const doc = { mcp_servers: [{ name: 'ops', url: 'https://tools/mcp' }] };
  assert.deepEqual(codes(doc), ['mcpDefaultDeny']);
});

test('MCP access is not reported once any layer grants something', () => {
  const base = { mcp_servers: [{ name: 'ops', url: 'https://tools/mcp' }] };
  assert.deepEqual(codes({ ...base, mcp_policies: [{ scope: 'env', allow: ['*'] }] }), []);
  assert.deepEqual(codes({ ...base, api_keys: [{ id: 'k', display_name: 'k', mcp_access: { allow: ['ops__*'] } }] }), []);
});

test('an MCP policy that permits nothing is reported, both spellings', () => {
  assert.deepEqual(codes({ mcp_policies: [{ scope: 'env', allow: [] }] }), ['mcpPolicyEmptyAllow']);
  // allow_ids present at all is authoritative, even when empty.
  assert.deepEqual(codes({ mcp_policies: [{ scope: 'team', scope_ref: 't', allow: ['*'], allow_ids: [] }] }), [
    'mcpPolicyEmptyAllow',
  ]);
});

test('a cache applies_to the gateway would widen to everything is reported', () => {
  // A typo here silently takes the policy from one model to the whole environment.
  const doc = { cache_policies: [{ name: 'faq', applies_to: 'modal:gpt-4o' }] };
  assert.deepEqual(codes(doc), ['cacheAppliesToUnknown']);
  assert.equal(runEffectChecks(doc)[0].params.value, 'modal:gpt-4o');
});

test('valid and absent applies_to values are not reported', () => {
  for (const applies_to of ['all', 'model:gpt-4o', 'api_key:k1', '', undefined]) {
    assert.deepEqual(codes({ cache_policies: [{ name: 'c', applies_to }] }), [], `applies_to=${applies_to}`);
  }
});

test('a rate limit policy mixing the two forms is reported', () => {
  const doc = {
    rate_limit_policies: [{ name: 'r', scope: 'env', window: '1m', max_requests: 10, limits: { rpm: 5 } }],
  };
  assert.deepEqual(codes(doc), ['rateLimitMixedForms']);
});

test('rate limit fields that do not exist are reported', () => {
  // There is no per-hour token limit; tph is ignored and the policy applies
  // whatever fields were left.
  const doc = {
    rate_limit_policies: [{ name: 'r', scope: 'env', window: '1m', max_requests: 10, tph: 100 }],
  };
  assert.deepEqual(codes(doc), ['rateLimitUnknownField']);
  assert.equal(runEffectChecks(doc)[0].params.fields, 'tph');
});

test('a team or member no key points at is reported', () => {
  assert.deepEqual(codes({ teams: [{ id: 't1', name: 'research' }] }), ['teamNoKey']);
  assert.deepEqual(codes({ users: [{ id: 'u1', name: 'zhangsan' }] }), ['memberNoKey']);
});

test('teams and members that a key references are not reported', () => {
  const doc = {
    teams: [{ id: 't1', name: 'research' }],
    users: [{ id: 'u1', name: 'zhangsan' }],
    api_keys: [{ id: 'k1', display_name: 'k', team_id: 't1', user_id: 'u1' }],
  };
  assert.deepEqual(codes(doc), []);
});

test('a claim mapping naming an unknown provider is reported', () => {
  const doc = { claim_mappings: [{ name: 'dept', jwt_provider: 'nope', match: [], resolve: { api_key_id: 'k' } }] };
  assert.deepEqual(codes(doc), ['claimMappingProviderMissing']);
  const withProvider = { ...doc, oidc_providers: [{ name: 'nope' }] };
  assert.deepEqual(codes(withProvider), []);
});

test('a price row no model references is reported', () => {
  const doc = { pricing: [{ key: 'deepseek/chat', input_per_1k: 0.001, output_per_1k: 0.002 }] };
  assert.deepEqual(codes(doc), ['pricingUnused']);
  const used = { ...doc, models: [{ display_name: 'chat', pricing_key: 'deepseek/chat' }] };
  assert.deepEqual(codes(used), []);
});

test('a fully wired document raises nothing', () => {
  // The noise test: hints that fire on a healthy config are worse than no hints.
  const doc = {
    provider_keys: [{ id: 'p1', display_name: 'openai', provider: 'openai', api_key: 'k' }],
    models: [{ display_name: 'gpt-4o', pricing_key: 'openai/gpt-4o' }],
    api_keys: [
      { id: 'k1', display_name: 'k', team_id: 't1', user_id: 'u1', mcp_access: { allow: ['ops__*'] } },
    ],
    teams: [{ id: 't1', name: 'research' }],
    users: [{ id: 'u1', name: 'zhangsan' }],
    guardrails: [{ id: 'g1', name: 'block-pii', enabled: true }],
    guardrail_attachments: [{ guardrail_id: 'g1', scope_type: 'model', scope_id: 'gpt-4o', priority: 10 }],
    mcp_servers: [{ name: 'ops', url: 'https://tools/mcp' }],
    mcp_policies: [{ scope: 'env', allow: ['*'] }],
    cache_policies: [{ name: 'faq', applies_to: 'model:gpt-4o' }],
    rate_limit_policies: [{ name: 'rpm', scope: 'env', window: '1m', max_requests: 100 }],
    oidc_providers: [{ name: 'corp-sso' }],
    claim_mappings: [{ name: 'dept', jwt_provider: 'corp-sso', match: [], resolve: { api_key_id: 'k1' } }],
    pricing: [{ key: 'openai/gpt-4o' }],
    budgets: [],
  };
  assert.deepEqual(runEffectChecks(doc), []);
});

test('every declared code is reachable, and nothing undeclared is emitted', () => {
  // Two documents, because mcpDefaultDeny (no policy at all) and
  // mcpPolicyEmptyAllow (a policy permitting nothing) cannot both hold.
  const docA = {
    guardrails: [{ id: 'g-unattached', name: 'u' }, { id: 'g-ok', name: 'ok' }],
    guardrail_attachments: [
      { guardrail_id: 'g-ok', scope_type: 'env', priority: 1 },
      { guardrail_id: 'g-ok', scope_type: 'model' },
      { guardrail_id: 'ghost', scope_type: 'env', priority: 1 },
    ],
    provider_keys: [{ id: 'p', display_name: 'bad', provider: 'deepseek', api_key: 'k' }],
    budgets: [{ scope: 'env', period: 'day' }],
    mcp_servers: [{ name: 'ops', url: 'https://tools/mcp' }],
    mcp_policies: [{ scope: 'env', allow: [] }],
    cache_policies: [{ name: 'c', applies_to: 'modal:x' }],
    rate_limit_policies: [
      { name: 'r1', scope: 'env', window: '1m', max_requests: 1, limits: { rpm: 1 } },
      { name: 'r2', scope: 'env', window: '1m', max_requests: 1, tps: 1 },
    ],
    teams: [{ id: 't1', name: 't' }],
    users: [{ id: 'u1', name: 'u' }],
    claim_mappings: [{ name: 'm', jwt_provider: 'nope' }],
    pricing: [{ key: 'unused/x' }],
  };
  const docB = { mcp_servers: [{ name: 'ops', url: 'https://tools/mcp' }] };

  const emitted = new Set([...codes(docA), ...codes(docB)]);
  assert.deepEqual([...emitted].sort(), [...CHECK_CODES].sort());
});

test('findings carry the kind and the params the UI needs', () => {
  const [finding] = runEffectChecks({ teams: [{ id: 't1', name: 'research' }] });
  assert.deepEqual(finding, { kind: 'teams', code: 'teamNoKey', params: { name: 'research' } });
});

test('the params each code emits match the declared contract', () => {
  // The copy is interpolated client-side, so a mismatch here renders a literal
  // "{count}" to the user. web/test/resourceCatalog.test.js checks the other
  // half: that the translations use exactly these placeholders.
  const docs = [
    {
      guardrails: [{ id: 'g', name: 'g' }, { id: 'g2', name: 'g2' }],
      guardrail_attachments: [
        { guardrail_id: 'ghost', scope_type: 'env', priority: 1 },
        { guardrail_id: 'g', scope_type: 'env' },
      ],
      provider_keys: [{ id: 'p', display_name: 'p', provider: 'deepseek', api_key: 'k' }],
      budgets: [{ scope: 'env', period: 'day' }],
      mcp_servers: [{ name: 's', url: 'https://x' }],
      mcp_policies: [{ scope: 'env', allow: [] }],
      cache_policies: [{ name: 'c', applies_to: 'nope' }],
      rate_limit_policies: [
        { name: 'r1', scope: 'env', window: '1m', limits: {} },
        { name: 'r2', scope: 'env', window: '1m', tps: 1 },
      ],
      teams: [{ id: 't', name: 't' }],
      users: [{ id: 'u', name: 'u' }],
      claim_mappings: [{ name: 'm', jwt_provider: 'nope' }],
      pricing: [{ key: 'k' }],
    },
    { mcp_servers: [{ name: 's', url: 'https://x' }] },
  ];
  const seen = new Map();
  for (const doc of docs) {
    for (const f of runEffectChecks(doc)) {
      const declared = [...(CHECK_PARAMS[f.code] ?? [])].sort();
      assert.deepEqual(
        Object.keys(f.params).sort(),
        declared,
        `${f.code} emitted params ${JSON.stringify(Object.keys(f.params))}, contract says ${JSON.stringify(declared)}`
      );
      seen.set(f.code, true);
    }
  }
  assert.equal(seen.size, CHECK_CODES.length, 'the fixtures must reach every code');
});

test('a row with no name still yields a usable label', () => {
  const [finding] = runEffectChecks({ users: [{ id: 'u1' }] });
  assert.equal(finding.params.name, 'u1');
});
