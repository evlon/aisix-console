// Generate a random caller API key: sk- + 48 chars of base64url.
export function generateCallerKey() {
  const bytes = new Uint8Array(36);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `sk-${b64}`;
}
