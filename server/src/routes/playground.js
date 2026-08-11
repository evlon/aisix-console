// Playground: SSE passthrough to the gateway's real proxy listener.
import { Router } from 'express';

export function playgroundRouter(ctx) {
  const router = Router();

  // POST /api/playground/chat — forwards to <proxy>/v1/chat/completions with
  // the caller's Authorization header. Body: {model, messages, callerKey,
  // stream?, ...extra}. Streaming (SSE) is piped back; client abort aborts
  // the upstream request.
  router.post('/chat', async (req, res) => {
    const { model, messages, callerKey, stream, ...extra } = req.body ?? {};
    if (!model || !Array.isArray(messages)) {
      return res.status(400).json({ error: '需要 model 和 messages' });
    }
    if (!callerKey) {
      return res.status(400).json({ error: '需要在试玩页填入一个调用方 API Key' });
    }
    const body = {
      model,
      messages,
      stream: stream ?? true,
      ...extra,
    };

    const controller = new AbortController();
    // Abort the upstream request when the RESPONSE connection closes
    // (client disconnected), not when the request body is consumed.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    // Safety net: never let a hung upstream hold the console request forever
    // (the gateway's own default upstream timeout is 100 minutes).
    const timeoutMs = ctx.cfg.playgroundTimeoutMs || 180000;
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let upstream;
      try {
        upstream = await fetch(`${ctx.cfg.gateway.proxy}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${callerKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        const cause = e?.cause?.code || e?.cause?.message || '';
        let reason = e.message;
        if (e.name === 'AbortError') reason = '请求已取消';
        else if (/ECONNREFUSED/i.test(e.message + cause)) reason = '连接被拒绝（网关代理未启动？）';
        else if (/ENOTFOUND/i.test(e.message + cause)) reason = '代理地址无法解析';
        else if (/ETIMEDOUT/i.test(e.message + cause)) reason = '连接超时';
        return res.status(502).json({ error: `无法连接网关代理 (:3000): ${reason}` });
      }

      if (upstream.status !== 200) {
        let text = '';
        try {
          text = await upstream.text();
        } catch {
          /* ignore */
        }
        return res.status(upstream.status).json({
          error: `网关返回 HTTP ${upstream.status}`,
          detail: text.slice(0, 2000),
        });
      }

      const contentType = upstream.headers.get('content-type') || '';
      if (body.stream) {
        res.setHeader('Content-Type', contentType || 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch (e) {
          if (e.name !== 'AbortError') console.error('playground stream error', e);
        } finally {
          res.end();
        }
      } else {
        const text = await upstream.text();
        res.setHeader('Content-Type', contentType || 'application/json');
        res.send(text);
      }
    } finally {
      clearTimeout(timeoutTimer);
    }
  });

  return router;
}
