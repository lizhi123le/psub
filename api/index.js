// Vercel Edge Function for psub - Compatible with Cloudflare Worker version
export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sfo1']
};

// Environment - set BACKEND in Vercel dashboard
const BACKEND = process.env.BACKEND || 'https://api.v1.mk';

// Memory cache for Vercel (since Vercel doesn't support R2/KV like Cloudflare)
const memoryCache = new Map();

// Cached version string
let cachedVersion = null;

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
  const target = url.searchParams.get('target');

  if (!targetUrl) {
    return new Response('Missing url parameter', { status: 400 });
  }

  // If there's a target parameter (like 'clash'), forward to backend for conversion first
  if (target) {
    return await forwardToBackend(request, url, backend, host, subDir);
  }

  // Original logic for non-target requests
  const replacedURIs = [];
  const urlParts = targetUrl.split('|').filter(part => part.trim() !== '');

  if (urlParts.length === 0) {
    return new Response('There are no valid links', { status: 400 });
  }

  for (const urlPart of urlParts) {
    const key = generateRandomStr(16);

    if (urlPart.startsWith('https://') || urlPart.startsWith('http://')) {
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

        if (!response.ok) continue;

        const content = await response.text();
        if (!content || content.trim().length === 0) continue;

        const parsed = parseData(content);
        const headers = Object.fromEntries(response.headers);
        memoryCache.set(key + '_headers', JSON.stringify(headers));

        if (parsed.format === 'base64') {
          const links = parsed.data.split(/\r?\n/).filter(link => link.trim() !== '');
          for (const link of links) {
            const nodeKey = generateRandomStr(16);
            memoryCache.set(nodeKey, link);
            memoryCache.set(nodeKey + '_headers', JSON.stringify({ 'Content-Type': 'text/plain' }));
            replacedURIs.push(`${host}/${subDir}/${nodeKey}`);
          }
        } else {
          memoryCache.set(key, content);
          memoryCache.set(key + '_headers', JSON.stringify({ 'Content-Type': 'text/plain;charset=UTF-8' }));
          replacedURIs.push(`${host}/${subDir}/${key}`);
        }
      } catch (e) {
        console.error('Fetch error:', e.message);
        continue;
      }
    } else if (/^(ssr?|vmess1?|trojan|vless|hysteria|hysteria2|tg):\/\//.test(urlPart)) {
      memoryCache.set(key, urlPart);
      memoryCache.set(key + '_headers', JSON.stringify({ 'Content-Type': 'text/plain' }));
      replacedURIs.push(`${host}/${subDir}/${key}`);
    }
  }

  if (replacedURIs.length === 0) {
    return new Response('Error: All subscription links are invalid or returned empty content.', { 
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const result = btoa(replacedURIs.join('\r\n'));
  return new Response(result, {
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// Forward to backend for conversion, then replace domain
async function forwardToBackend(request, url, backend, host, subDir) {
  try {
    // Build backend URL with all parameters
    const backendUrl = `${backend}${url.pathname}${url.search}`;
    
    // Debug: return the URL being fetched
    // return new Response(`Debug: ${backendUrl}`, { status: 200 });
    
    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/plain,*/*',
      }
    });

    if (!response.ok) {
      return new Response(`Backend error: ${response.status}`, { status: response.status });
    }

    // Read response as bytes and decode with UTF-8 support
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('utf-8');
    let content = decoder.decode(buffer);
    
    // Get current host without protocol for domain-only replacement
    const currentHost = url.host;
    
    // Replace bulianglin2023.dev with current host in the content
    content = content.replace(/https:\/\/bulianglin2023\.dev/g, host);
    content = content.replace(/bulianglin2023\.dev/g, currentHost);
    
    // Also replace any other known backend domains
    content = content.replace(/https:\/\/api\.v1\.mk/g, host);
    content = content.replace(/api\.v1\.mk/g, currentHost);

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'text/plain',
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (e) {
    return new Response(`Error forwarding to backend: ${e.message}`, { status: 500 });
  }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const host = getHost(request);

  // Root - return index.html with domain replacement
  if (url.pathname === '/' || url.pathname === '') {
    try {
      // In Edge Function, we need to fetch the index.html from the same origin
      const indexUrl = `${host}/index.html`;
      const response = await fetch(indexUrl);
      
      if (response.ok) {
        let html = await response.text();
        
        // Replace bulianglin2023.dev with current host - handle multiple formats
        // Format 1: https://bulianglin2023.dev
        html = html.replace(/https:\/\/bulianglin2023\.dev/g, host);
        // Format 2: bulianglin2023.dev (without protocol)
        html = html.replace(/bulianglin2023\.dev/g, url.host);
        // Format 3: URL encoded version
        html = html.replace(/https%3A%2F%2Fbulianglin2023\.dev/g, encodeURIComponent(host));
        
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    } catch (e) {
      console.error('Error loading index.html:', e);
    }
    
    // Fallback to simple page
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
      const response = await fetch(`${backend}/version`, {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (response.ok) {
        const text = await response.text();
        if (text && text.trim().length > 1) {
          return new Response(text.trim(), {
            status: 200,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }
      
      // If response not ok, return error with backend info
      return new Response(`Error: Backend returned ${response.status}`, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      console.error('Version fetch error:', e);
      return new Response(`Error: ${e.message}`, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
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
