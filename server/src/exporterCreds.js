// Credential-reference resolution for observability exporters.
//
// WHY THIS MODULE EXISTS
// An exporter's `credential_ref` is NOT a secret — it is a reference NAME. At
// delivery time the gateway (data plane) resolves it against its OWN process
// environment using a name convention that appears nowhere in the resource:
//
//   aliyun_sls    -> SLS_CRED_<SLUG>_AK_ID
//                   SLS_CRED_<SLUG>_AK_SECRET
//   datadog       -> DD_CRED_<SLUG>_API_KEY
//   object_store  -> OBJSTORE_CRED_<SLUG>_AWS_ACCESS_KEY_ID
//                   OBJSTORE_CRED_<SLUG>_AWS_SECRET_ACCESS_KEY
//                   OBJSTORE_CRED_<SLUG>_AWS_SESSION_TOKEN        (optional)
//                   OBJSTORE_CRED_<SLUG>_GCS_SERVICE_ACCOUNT_KEY
//                   OBJSTORE_CRED_<SLUG>_AZURE_ACCOUNT
//                   OBJSTORE_CRED_<SLUG>_AZURE_ACCESS_KEY
//
// <SLUG> is the reference upper-cased with every non-ASCII-alphanumeric byte
// folded to `_` — no trimming, no collapsing of repeats. A user who types their
// API key into the `credential_ref` box (the natural mistake) gets a reference
// that can never resolve. This module turns that convention into something the
// UI can show, so the operator learns WHICH variables to inject and whether the
// gateway is likely to find them.
//
// Source of truth (aisix gateway):
//   crates/aisix-obs/src/sink/sls.rs          resolve_sls_credential
//   crates/aisix-obs/src/sink/datadog.rs      resolve_datadog_credential
//   crates/aisix-obs/src/sink/object_store.rs resolve_object_store_credential
//
// The prefixes are deliberately NOT `AISIX_`: the gateway's config loader owns
// that namespace (`Environment::with_prefix("AISIX")`), so an `AISIX_`-named
// secret would be reinterpreted as a config override. docker/entrypoint.sh also
// scrubs every `AISIX_*` var before starting the gateway.
//
// SECRET VALUES NEVER LEAVE THIS MODULE: only variable names and a boolean
// "is it set", mirroring the names-only discipline of secrets.js.

// Mirror of the gateway's slug rule. Keep byte-for-byte identical to
// `credential_ref.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })`.
// Note the differences from secrets.js#slugFrom: no trim, no collapsing of
// runs, no length cap, no fallback for the empty string.
export function credentialSlug(ref) {
  return [...String(ref ?? '')]
    .map((c) => (/^[A-Za-z0-9]$/.test(c) ? c.toUpperCase() : '_'))
    .join('');
}

/**
 * Environment variables the gateway needs for one exporter.
 *
 * @param {{kind?: string, ref?: string, provider?: string, authMode?: string}} cfg
 * @returns {{vars: {name: string, required: boolean, label: string}[], note?: string}}
 */
export function requiredEnvVars(cfg = {}) {
  const { kind, provider, authMode } = cfg;
  const ref = String(cfg.ref ?? '').trim();

  if (kind === 'otlp_http') {
    return {
      vars: [],
      note: 'otlp_http 不用 credential_ref —— 鉴权走 headers，且 headers 是明文存在 resources.yaml 里的。',
    };
  }

  if (kind === 'object_store' && authMode === 'cloud_identity') {
    if (provider === 'azure_blob') {
      return { vars: [], note: 'cloud_identity 只支持 s3 / gcs，Azure Blob 必须用 credential_ref。' };
    }
    return { vars: [], note: 'cloud_identity 用宿主机挂载的云身份，不需要任何环境变量。' };
  }

  if (!ref) {
    return { vars: [], note: '填入一个引用名后，这里会列出网关需要哪些环境变量。' };
  }

  const slug = credentialSlug(ref);

  if (kind === 'aliyun_sls') {
    return {
      vars: [
        { name: `SLS_CRED_${slug}_AK_ID`, required: true, label: 'AccessKey ID' },
        { name: `SLS_CRED_${slug}_AK_SECRET`, required: true, label: 'AccessKey Secret' },
      ],
    };
  }

  if (kind === 'datadog') {
    return {
      vars: [{ name: `DD_CRED_${slug}_API_KEY`, required: true, label: 'Datadog API Key' }],
    };
  }

  if (kind === 'object_store') {
    if (provider === 'gcs') {
      return {
        vars: [
          {
            name: `OBJSTORE_CRED_${slug}_GCS_SERVICE_ACCOUNT_KEY`,
            required: true,
            label: 'GCS 服务账号密钥',
          },
        ],
      };
    }
    if (provider === 'azure_blob') {
      return {
        vars: [
          { name: `OBJSTORE_CRED_${slug}_AZURE_ACCOUNT`, required: true, label: 'Azure 账号名' },
          { name: `OBJSTORE_CRED_${slug}_AZURE_ACCESS_KEY`, required: true, label: 'Azure Access Key' },
        ],
      };
    }
    // s3 (and S3-compatible: MinIO / OSS / R2)
    return {
      vars: [
        {
          name: `OBJSTORE_CRED_${slug}_AWS_ACCESS_KEY_ID`,
          required: true,
          label: 'Access Key ID',
        },
        {
          name: `OBJSTORE_CRED_${slug}_AWS_SECRET_ACCESS_KEY`,
          required: true,
          label: 'Secret Access Key',
        },
        {
          name: `OBJSTORE_CRED_${slug}_AWS_SESSION_TOKEN`,
          required: false,
          label: '临时凭据 Session Token',
        },
      ],
    };
  }

  return { vars: [] };
}

/**
 * Which of the derived variables are present in THIS process's environment.
 *
 * Scope caveat, surfaced verbatim in the API response: this reads the console
 * process env. In the documented single-container deployment the console and
 * the gateway share the container environment (docker/entrypoint.sh only
 * scrubs `AISIX_*` for the gateway subshell), so the answer is authoritative.
 * In a split deployment the console's env is NOT the gateway's, so a missing
 * variable proves nothing about the gateway.
 */
export function checkEnv(vars, env = process.env) {
  return vars.map((v) => ({ ...v, set: typeof env[v.name] === 'string' && env[v.name] !== '' }));
}

/**
 * Ready-to-paste injection snippets. Values are placeholders — the console
 * never holds them (this build only guides; it does not store exporter
 * credentials).
 */
export function buildSnippets(vars) {
  if (!vars.length) return null;
  const named = vars.filter((v) => v.required);
  const lines = named.map((v) => `${v.name}=`);
  const compose = [
    '# 加到现有 compose 的 services.aisix 下（不要整段替换）：',
    'services:',
    '  aisix:',
    '    environment:',
    ...named.map((v) => `      - ${v.name}=${placeholderFor(v)}`),
  ].join('\n');
  const dockerRun = named.map((v) => `  -e ${v.name}=${placeholderFor(v)}`).join(' \\\n');
  return {
    dotenv: lines.join('\n'),
    compose,
    dockerRun: `docker run \\\n${dockerRun} \\\n  <其余原有参数>`,
  };
}

function placeholderFor(v) {
  return `<${v.label}>`;
}

// Convenience used by the route: everything the UI needs, values never read.
export function credentialPlan(cfg = {}, env = process.env) {
  const { vars, note } = requiredEnvVars(cfg);
  const checked = checkEnv(vars, env);
  const requiredVars = checked.filter((v) => v.required);
  return {
    kind: cfg.kind ?? null,
    ref: cfg.ref ?? '',
    slug: cfg.ref ? credentialSlug(String(cfg.ref).trim()) : '',
    vars: checked,
    allRequiredSet: requiredVars.length > 0 && requiredVars.every((v) => v.set),
    note: note ?? null,
    snippets: buildSnippets(vars),
    envCheckScope: 'console',
  };
}
