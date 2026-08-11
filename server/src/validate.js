// Spawn `aisix validate --resources <file>` and parse its error report.
import { spawn } from 'node:child_process';

export function runValidate(binPath, filePath, extraEnv) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    const args = ['validate', '--resources', filePath];
    try {
      // On Windows, `.cmd`/`.bat` shims can't be spawned directly — route
      // them through cmd.exe so a wrapper script works as aisixBin too.
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath)) {
        child = spawn('cmd.exe', ['/d', '/s', '/c', binPath, ...args], {
          env: { ...process.env, ...extraEnv },
          windowsHide: true,
        });
      } else {
        child = spawn(binPath, args, {
          env: { ...process.env, ...extraEnv },
          windowsHide: true,
        });
      }
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', message: `无法启动 aisix 二进制: ${e.message}` });
      return;
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      resolve({
        code: -1,
        stdout,
        stderr,
        message: `aisix 二进制未找到或无法执行: ${e.message}（检查 aisixBin 配置）`,
      });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

// Parse the aggregated stderr report. Lines look like:
//   resources file <path>: N error(s):
//     - models[2] ("gpt-4o"): message
const ERROR_LINE = /^\s*-\s+(.+?):\s+(.*)$/;

export function parseErrors(stderr) {
  const errors = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line);
    if (m) errors.push({ scope: m[1].trim(), message: m[2].trim() });
  }
  if (errors.length === 0 && stderr && stderr.trim()) {
    errors.push({ scope: '(validate)', message: stderr.trim() });
  }
  return errors;
}

// Map an aisix error scope to a friendly Chinese label.
// e.g. `models[2] ("gpt-4o")` -> `模型 "gpt-4o"（第 3 项）`
export function friendlyScope(scope) {
  const m = /^([a-z_]+)\[(\d+)\]\s+\(?"?([^")]*)"?\)?$/.exec(scope);
  if (m) {
    const kindLabels = {
      provider_keys: 'Provider Key',
      models: '模型',
      api_keys: '调用方 API Key',
      guardrails: '护栏',
      mcp_servers: 'MCP 服务器',
      a2a_agents: 'A2A Agent',
      cache_policies: '缓存策略',
      observability_exporters: '可观测性导出器',
      rate_limit_policies: '限流策略',
      oidc_providers: 'OIDC Provider',
      claim_mappings: 'Claim 映射',
    };
    const label = kindLabels[m[1]] || m[1];
    const name = m[3] || '';
    const idx = Number(m[2]) + 1;
    return name ? `${label} "${name}"（第 ${idx} 项）` : `${label}（第 ${idx} 项）`;
  }
  if (scope === '(file)' || scope === 'file') return '配置文件整体';
  return scope;
}
