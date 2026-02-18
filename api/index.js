// Vercel Edge Function for psub - Compatible with Cloudflare Worker version
export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sfo1']
};

// Environment - set BACKEND in Vercel dashboard
const BACKEND = process.env.BACKEND || 'https://api.v1.mk';

// Memory cache for Vercel (since Vercel doesn't support R2/KV like Cloudflare)
const memoryCache = new Map();

function generateRandomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Parse subscription data format
function parseData(data) {
  try {
    // Try to detect format
    const trimmed = data.trim();

    // Check if it's base64
    const base64Pattern = /^[A-Za-z0-9+/=\s]+$/;
    if (base64Pattern.test(trimmed) && trimmed.length > 20) {
      try {
        const decoded = atob(trimmed.replace(/\s/g, ''));
        if (decoded.includes('://')) {
          return { format: 'base64', data: decoded };
        }
      } catch (e) {
        // Not valid base64
      }
    }

    // Check if it's YAML (Clash config)
    if (trimmed.includes('proxies:') || trimmed.includes('Proxy:')) {
      return { format: 'yaml', data: trimmed };
    }

    // Check if it's direct node links
    if (/^(ssr?|vmess1?|trojan|vless|hysteria|hysteria2|tg):\/\//.test(trimmed)) {
      return { format: 'direct', data: trimmed };
    }

    return { format: 'unknown', data: trimmed };
  } catch (e) {
    return { format: 'unknown', data: data };
  }
}

// Extract host from URL
function getHost(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// Process subscription and replace with local URLs
async function processSubscription(request, url, backend) {
  const host = getHost(request);
  const subDir = 'subscription';
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response('Missing url parameter', { status: 400 });
  }

  const replacedURIs = [];
  const keys = [];
  const urlParts = targetUrl.split('|').filter(part => part.trim() !== '');

  if (urlParts.length === 0) {
    return new Response('There are no valid links', { status: 400 });
  }

  for (const urlPart of urlParts) {
    const key = generateRandomStr(16);

    if (urlPart.startsWith('https://') || urlPart.startsWith('http://')) {
      // Fetch subscription from URL
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const response = await fetch(urlPart, {
          method: 'GET',
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          continue;
        }

        const content = await response.text();
        if (!content || content.trim().length === 0) {
          continue;
        }

        // Parse the content
        const parsed = parseData(content);

        // Store headers
        const headers = Object.fromEntries(response.headers);
        memoryCache.set(key + '_headers', JSON.stringify(headers));

        if (parsed.format === 'base64') {
          // Handle base64 format
          const links = parsed.data.split(/\r?\n/).filter(link => link.trim() !== '');

          for (const link of links) {
            const nodeKey = generateRandomStr(16);
            memoryCache.set(nodeKey, link);
            memoryCache.set(nodeKey + '_headers', JSON.stringify({ 'Content-Type': 'text/plain' }));
            replacedURIs.push(`${host}/${subDir}/${nodeKey}`);
          }
        } else if (parsed.format === 'yaml') {
          // Handle YAML format - store as-is for now
          memoryCache.set(key, content);
          memoryCache.set(key + '_headers', JSON.stringify({ 'Content-Type': 'text/plain;charset=UTF-8' }));
          replacedURIs.push(`${host}/${subDir}/${key}`);
        } else {
          // Unknown format - store as-is
          memoryCache.set(key, content);
          memoryCache.set(key + '_headers', JSON.stringify({ 'Content-Type': 'text/plain;charset=UTF-8' }));
          replacedURIs.push(`${host}/${subDir}/${key}`);
        }
      } catch (e) {
        console.error('Fetch error:', e.message);
        continue;
      }
    } else if (/^(ssr?|vmess1?|trojan|vless|hysteria|hysteria2|tg):\/\//.test(urlPart)) {
      // Direct node link - store it
      memoryCache.set(key, urlPart);
      memoryCache.set(key + '_headers', JSON.stringify({ 'Content-Type': 'text/plain' }));
      replacedURIs.push(`${host}/${subDir}/${key}`);
    } else {
      // Try to parse as base64 encoded content
      try {
        const decoded = atob(urlPart.replace(/\s/g, ''));
        const parsed = parseData(decoded);

        if (parsed.format === 'base64') {
          const links = parsed.data.split(/\r?\n/).filter(link => link.trim() !== '');

          for (const link of links) {
            const nodeKey = generateRandomStr(16);
            memoryCache.set(nodeKey, link);
            memoryCache.set(nodeKey + '_headers', JSON.stringify({ 'Content-Type': 'text/plain' }));
            replacedURIs.push(`${host}/${subDir}/${nodeKey}`);
          }
        }
      } catch (e) {
        // Not valid base64, store as-is
        memoryCache.set(key, urlPart);
        memoryCache.set(key + '_headers', JSON.stringify({ 'Content-Type': 'text/plain' }));
        replacedURIs.push(`${host}/${subDir}/${key}`);
      }
    }
  }

  if (replacedURIs.length === 0) {
    return new Response('Error: All subscription links are invalid or returned empty content.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Return the replaced URIs as base64
  const result = btoa(replacedURIs.join('\r\n'));
  return new Response(result, {
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const host = getHost(request);

  // Root - return simple info
  if (url.pathname === '/' || url.pathname === '') {
    return new Response(`<!DOCTYPE html>
<html>
<head><title>psub</title></head>
<body>
<h1>psub - Subscription Converter</h1>
<p>Backend API is running correctly.</p>
<p>Use: /sub?url=YOUR_SUBSCRIPTION_URL</p>
<p>Version: /version</p>
</body>
</html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Version endpoint
  if (url.pathname === '/version') {
    try {
      const backend = BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1");
      
      // Fetch backend version with explicit settings
      const response = await fetch(`${backend}/version`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/plain,*/*',
          'Accept-Encoding': 'identity'
        },
        cache: 'no-store'
      });

      // Read response as bytes and convert to string
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i++) {
        text += String.fromCharCode(bytes[i]);
      }
      
      // If backend returns empty, use fallback
      if (!text || text.trim().length === 0) {
        text = 'subconverter backend (version unknown)';
      }

      return new Response(text, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({
        error: 'Backend unavailable',
        message: e.message,
        backend: BACKEND
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }

  // Subscription content endpoint
  if (url.pathname.startsWith('/subscription/')) {
    const key = url.pathname.replace('/subscription/', '');

    if (!key || key.includes('/') || key.includes('..')) {
      return new Response('Invalid key', { status: 400 });
    }

    const content = memoryCache.get(key);
    const headersStr = memoryCache.get(key + '_headers');

    if (!content) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = headersStr ? JSON.parse(headersStr) : { 'Content-Type': 'text/plain;charset=UTF-8' };

    return new Response(content, {
      headers: {
        ...headers,
        'Access-Control-Allow-Origin': '*',
      }
    });
  }

  // Subscription conversion endpoint
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not found', { status: 404 });
}
