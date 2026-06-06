export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sin2', 'sfo1', 'sfo2'],
};

// Environment - set BACKEND in Vercel dashboard
const BACKEND = process.env.BACKEND || 'https://api.v1.mk';

// In-memory cache for current request scope (Edge functions are stateless across requests)
// We use a simple Map. Since Edge functions can be hot-reused, we clear it explicitly.
const requestCache = new Map();
const MAX_CACHE_ENTRIES = 100; // Prevent memory bloat in hot reuse

// Helper: Cache with LRU-like eviction (simple)
function cacheSet(key, value) {
  if (requestCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = requestCache.keys().next().value;
    requestCache.delete(firstKey);
  }
  requestCache.set(key, value);
}
function cacheGet(key) {
  return requestCache.get(key);
}
function cacheClear() {
  requestCache.clear();
}

// Robust UTF-8 <-> Base64 helpers (Compatible with Edge Runtime & Unicode/Emoji)
function utf8ToBase64(str) {
  try {
    const bytes = new TextEncoder().encode(str);
    return btoa(String.fromCharCode(...bytes));
  } catch (e) {
    // Fallback for environments where btoa fails
    return Buffer.from(str, 'utf-8').toString('base64');
  }
}

function base64ToUtf8Safe(b64) {
  try {
    // Handle URL-safe Base64
    let clean = b64.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding
    const pad = clean.length % 4;
    if (pad) clean += '='.repeat(4 - pad);
    
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return null;
  }
}

// Generate random string
function generateRandomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Generate random UUID v4
function generateRandomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Escape RegExp special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse subscription data format
function parseData(data) {
  if (!data) return { format: 'unknown', data };
  // Check raw YAML
  if (data.includes('proxies:') || data.includes('name:')) return { format: 'yaml', data };
  // Check Base64
  try {
    const decoded = base64ToUtf8Safe(data.trim());
    if (decoded && (decoded.includes('://') || decoded.includes('proxies:'))) {
      return { format: 'base64', data: decoded };
    }
  } catch (e) {}
  return { format: 'unknown', data };
}

// Normalize IPv6 server address
function normalizeServer(server) {
  if (!server) return server;
  try {
    server = decodeURIComponent(server);
  } catch (e) {}
  if (server.startsWith('[') && server.endsWith(']')) return server.slice(1, -1);
  return server;
}

// Robust extraction of the 'url' or 'sub' parameter
function getFullUrl(requestUrl) {
  const url = new URL(requestUrl);
  const search = url.search;
  if (!search) return url.searchParams.get('url') || url.searchParams.get('sub');

  // Find the start of the target URL parameter
  let urlStart = -1;
  const keys = ['url=', 'sub='];
  for (const k of keys) {
    const idx = search.indexOf(k);
    if (idx !== -1 && (idx === 0 || search[idx - 1] === '&')) {
      urlStart = idx + k.length;
      break;
    }
  }

  if (urlStart === -1) return url.searchParams.get('url') || url.searchParams.get('sub');

  // Extract until next safe delimiter or end
  let remaining = search.substring(urlStart);
  // Safe delimiters that usually start a new param
  const safeDelimiters = ['&', '#', '?'];
  let endIndex = remaining.length;
  for (const delim of safeDelimiters) {
    const idx = remaining.indexOf(delim);
    if (idx !== -1 && idx < endIndex) endIndex = idx;
  }

  const extracted = remaining.substring(0, endIndex);
  // Fallback to standard param if extraction fails or looks broken
  const stdParam = url.searchParams.get('url') || url.searchParams.get('sub');
  if (stdParam && stdParam.includes('://') && stdParam.length > extracted.length) {
    return decodeURIComponent(stdParam);
  }

  try {
    return decodeURIComponent(extracted);
  } catch (e) {
    return extracted;
  }
}

// Fetch with timeout & proper headers
async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SubscriptionProxy/1.0)',
        'Accept': '*/*'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('Fetch timeout');
    throw e;
  }
}

// Protocol replacement logic
function replaceInUri(link, replacements, isRecovery = false) {
  if (!link) return link;
  if (link.startsWith('ss://')) return _replaceSS(link, replacements, isRecovery);
  if (link.startsWith('ssr://')) return _replaceSSR(link, replacements, isRecovery);
  if (link.startsWith('vmess://')) return replaceVmess(link, replacements, isRecovery);
  if (link.startsWith('trojan://') || link.startsWith('vless://')) return replaceTrojan(link, replacements, isRecovery);
  if (link.startsWith('hysteria://')) return replaceHysteria(link, replacements, isRecovery);
  if (link.startsWith('hysteria2://') || link.startsWith('hy2://')) return replaceHysteria2(link, replacements, isRecovery);
  if (link.startsWith('socks://') || link.startsWith('socks5://')) return replaceSocks(link, replacements, isRecovery);
  if (link.startsWith('tg://')) return link; // Telegram links usually passthrough
  return link;
}

function _replaceSS(link, replacements, isRecovery) {
  const randomPass = generateRandomStr(12);
  const randomDomain = randomPass + '.com';
  let tempLink = link.slice(5).split('#')[0];
  const match = tempLink.match(/(\S+?)@((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)):/);
  if (!match) return link;
  
  const base64Data = match[1];
  const serverRaw = match[2];
  const decoded = base64ToUtf8Safe(base64Data);
  if (!decoded) return link;
  
  const parts = decoded.split(':');
  if (parts.length < 2) return link;
  
  const encryption = parts[0];
  const password = parts.slice(1).join(':');
  const server = normalizeServer(serverRaw);
  
  if (replacements) {
    replacements[randomDomain] = server;
    replacements[randomPass] = password;
  }
  
  const newStr = utf8ToBase64(encryption + ':' + randomPass);
  return link.replace(base64Data, newStr).replace(serverRaw, randomDomain);
}

function replaceVmess(link, replacements, isRecovery) {
  let tempLink = link.replace('vmess://', '');
  try {
    const decoded = base64ToUtf8Safe(tempLink);
    if (!decoded) return link;
    const jsonData = JSON.parse(decoded);
    const serverRaw = jsonData.add;
    const uuid = jsonData.id;
    if (!serverRaw || !uuid) return link;
    
    const server = normalizeServer(serverRaw);
    const randomDomain = generateRandomStr(10) + '.com';
    const randomUUID = generateRandomUUID();
    
    if (replacements) {
      replacements[randomDomain] = server;
      replacements[randomUUID] = uuid;
    }
    
    jsonData.add = randomDomain;
    jsonData.id = randomUUID;
    return 'vmess://' + utf8ToBase64(JSON.stringify(jsonData));
  } catch (e) {
    return link;
  }
}

function replaceTrojan(link, replacements, isRecovery) {
  const re = /^(vless|trojan):\/\/([^@]+)@((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)):\/?/;
  const match = link.match(re);
  if (!match) return link;
  
  const uuid = match[2];
  const rawHost = match[3];
  const server = normalizeServer(rawHost);
  if (!uuid || !server) return link;
  
  const randomDomain = generateRandomStr(10) + '.com';
  const randomUUID = generateRandomUUID();
  
  if (replacements) {
    replacements[randomDomain] = server;
    replacements[randomUUID] = uuid;
  }
  
  return link.replace(uuid, randomUUID).replace(rawHost, randomDomain);
}

function _replaceSSR(link, replacements, isRecovery) {
  try {
    let data = link.slice(6).replace(/\r/g, '').split('#')[0];
    const decoded = base64ToUtf8Safe(data);
    if (!decoded) return link;
    
    const match = decoded.match(/((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\w\.-]+)):(\d+?):(\S+?):(\S+?):(\S+?):(\S+)\//);
    if (!match) return link;
    
    const serverRaw = match[1];
    const port = match[2];
    const proto = match[3];
    const method = match[4];
    const obfs = match[5];
    const passwordEncoded = match[6];
    
    const randomDomain = generateRandomStr(12) + '.com';
    const randomPass = generateRandomStr(12);
    
    if (replacements) {
      replacements[randomDomain] = serverRaw;
      replacements[randomPass] = passwordEncoded;
    }
    
    const replaced = decoded
      .replace(serverRaw, randomDomain)
      .replace(passwordEncoded, utf8ToBase64(randomPass));
      
    return 'ssr://' + utf8ToBase64(replaced);
  } catch (e) {
    return link;
  }
}

function replaceSocks(link, replacements, isRecovery) {
  try {
    let temp = link.replace(/^socks5?:\/\//, '');
    const hashSplit = temp.split('#');
    const hashPart = hashSplit.length > 1 ? '#' + hashSplit[1] : '';
    temp = hashSplit[0];
    
    const atIndex = temp.indexOf('@');
    const fakeIP = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    
    if (atIndex !== -1) {
      const authBase64 = temp.slice(0, atIndex);
      const serverPort = temp.slice(atIndex + 1);
      const auth = base64ToUtf8Safe(authBase64);
      if (!auth) return link;
      const [user, pass] = auth.split(':');
      
      const serverMatch = serverPort.match(/^(((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))):(\d+)$/);
      if (!serverMatch) return link;
      
      const serverRaw = serverMatch[1];
      const port = serverMatch[3];
      if (replacements) replacements[fakeIP] = serverRaw;
      if (pass) replacements[user ? `${user}:${pass}` : pass] = pass; // Fallback logic
      
      const randomPass = generateRandomStr(12);
      const newAuth = user ? utf8ToBase64(`${user}:${randomPass}`) : '';
      return `socks://${newAuth}@${fakeIP}:${port}${hashPart}`;
    } else {
      const serverMatch = temp.match(/^(((?:\[[\da-fA-F:]+\])|(?:[\d\-\w\.]+))):(\d+)$/);
      if (!serverMatch) return link;
      const serverRaw = serverMatch[1];
      if (replacements) replacements[fakeIP] = serverRaw;
      return `socks://${fakeIP}:${serverMatch[3]}${hashPart}`;
    }
  } catch (e) {
    return link;
  }
}

function replaceHysteria(link, replacements, isRecovery) {
  const re = /^hysteria:\/\/((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)):\/?/;
  const match = link.match(re);
  if (!match) return link;
  
  const rawHost = match[1];
  const server = normalizeServer(rawHost);
  if (!server) return link;
  
  const randomDomain = generateRandomStr(12) + '.com';
  if (replacements) replacements[randomDomain] = rawHost;
  return link.replace(rawHost, randomDomain);
}

function replaceHysteria2(link, replacements, isRecovery) {
  const re = /^(hysteria2|hy2):\/\/([^@]+)@((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)):\/?/;
  const match = link.match(re);
  if (!match) return link;
  
  const uuid = match[2];
  const rawHost = match[3];
  const server = normalizeServer(rawHost);
  if (!uuid || !server) return link;
  
  const randomDomain = generateRandomStr(10) + '.com';
  const randomUUID = generateRandomUUID();
  
  if (replacements) {
    replacements[randomDomain] = rawHost;
    replacements[randomUUID] = uuid;
  }
  
  return link.replace(uuid, randomUUID).replace(rawHost, randomDomain);
}

function replaceYAMLContent(content, replacements) {
  let result = content;
  
  // Replace server addresses (handles IPv4, IPv6, domain)
  const serverRegex = /(server:\s*)(((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)))/gu;
  result = result.replace(serverRegex, (match, prefix, rawHost) => {
    const normalized = normalizeServer(rawHost);
    if (normalized && (normalized.includes('.') || normalized.includes(':'))) {
      const randomDomain = generateRandomStr(12) + '.com';
      if (replacements) replacements[randomDomain] = normalized;
      return `${prefix}"${randomDomain}"`; // Quote to be YAML safe
    }
    return match;
  });
  
  // Replace UUIDs (vmess)
  const uuidRegex = /(uuid:\s*)(\S+)/gu;
  result = result.replace(uuidRegex, (match, prefix, uuid) => {
    const randomUUID = generateRandomUUID();
    if (replacements) replacements[randomUUID] = uuid;
    return `${prefix}"${randomUUID}"`;
  });
  
  // Replace passwords (trojan, ss, etc.) - be careful not to replace inside strings like comments
  const passRegex = /(password:\s*)(\S+)/gu;
  result = result.replace(passRegex, (match, prefix, pass) => {
    if (!pass || pass.startsWith('#') || pass.startsWith('"')) return match; // Skip comments or quoted already
    const randomPass = generateRandomStr(12);
    if (replacements) replacements[randomPass] = pass;
    return `${prefix}"${randomPass}"`;
  });
  
  return result;
}

// Main Subscription Processing
async function processSubscription(request, url, backend) {
  const host = `${url.protocol}//${url.host}`;
  const subDir = 'internal';
  const replacements = {}; // Local mapping, never leaked

  // 1. Forward to backend if no target URL provided
  const targetUrl = getFullUrl(request.url) || url.searchParams.get('url');
  const targetFormat = url.searchParams.get('target');

  if (!targetUrl) {
    try {
      const backendUrl = `${backend.replace(/(https?:\/\/[^/]+).*$/, '$1')}${url.pathname}${url.search}`;
      const response = await fetchWithTimeout(backendUrl);
      if (!response.ok) throw new Error(`Backend error: ${response.status}`);
      
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      return new Response(`Error forwarding to backend: ${e.message}`, { status: 500 });
    }
  }

  // 2. If target format specified (e.g., clash), fetch from backend first for conversion
  if (targetFormat) {
    try {
      const backendUrl = `${backend.replace(/(https?:\/\/[^/]+).*$/, '$1')}${url.pathname}${url.search}`;
      const response = await fetchWithTimeout(backendUrl);
      if (!response.ok) throw new Error(`Backend conversion error: ${response.status}`);

      let content = await response.text();
      const backendHost = new URL(backend).host;
      const backendRegex = new RegExp(escapeRegExp(backendHost), 'g');

      // Replace backend domains with current host
      const replaceDomains = (str) => str
        .replace(/https:\/\/bulianglin2023\.dev/g, host)
        .replace(/bulianglin2023\.dev/g, url.host)
        .replace(new RegExp(`https://${escapeRegExp(backendHost)}`, 'g'), host)
        .replace(backendRegex, url.host)
        .replace(/http:\/\/127\.0\.0\.1:25500/g, host)
        .replace(/127\.0\.0\.1:25500/g, url.host);

      const parsed = parseData(content);
      if (parsed.format === 'base64') {
        content = utf8ToBase64(replaceDomains(parsed.data));
      } else {
        content = replaceDomains(content);
      }

      // Now apply local obfuscation
      if (parsed.format === 'yaml') {
        content = replaceYAMLContent(content, replacements);
      } else if (parsed.format === 'base64') {
        const lines = parsed.data.split(/\r?\n/).filter(l => l.trim());
        const obfuscatedLines = lines.map(line => replaceInUri(line, replacements, false) || line);
        content = utf8ToBase64(obfuscatedLines.join('\r\n'));
      }

      const key = generateRandomStr(20);
      cacheSet(key, { content, headers: Object.fromEntries(response.headers) });
      const callbackUrl = `${host}/${subDir}/${key}`;

      // Return HTML/JSON with callback URL for frontend to fetch
      return new Response(JSON.stringify({ callback: callbackUrl, content }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response(`Backend conversion error: ${e.message}`, { status: 500 });
    }
  }

  // 3. Process direct subscription URLs or raw links
  const urlParts = targetUrl.split('|').filter(p => p.trim() !== '');
  if (urlParts.length === 0) {
    return new Response('No valid subscription URLs found', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }

  const replacedURIs = [];
  const processedLinks = [];

  for (const rawPart of urlParts) {
    const key = generateRandomStr(16);
    
    if (rawPart.startsWith('http://') || rawPart.startsWith('https://')) {
      try {
        const response = await fetchWithTimeout(rawPart);
        if (!response.ok) continue;
        
        let content = await response.text();
        if (!content.trim()) continue;

        const parsed = parseData(content);
        let obfuscatedData = content;

        if (parsed.format === 'base64') {
          const lines = parsed.data.split(/\r?\n/).filter(l => l.trim());
          obfuscatedData = lines.map(line => replaceInUri(line, replacements, false) || line).join('\r\n');
        } else if (parsed.format === 'yaml') {
          obfuscatedData = replaceYAMLContent(content, replacements);
        }

        cacheSet(key, { content: obfuscatedData });
        replacedURIs.push(`${host}/${subDir}/${key}`);
      } catch (e) {
        console.error(`Fetch error for ${rawPart}:`, e.message);
        continue;
      }
    } else if (/^(ssr?|vmess1?|trojan|vless|hysteria|hysteria2|hy2|socks|tg):\/\//.test(rawPart.trim())) {
      cacheSet(key, { content: rawPart.trim() });
      replacedURIs.push(`${host}/${subDir}/${key}`);
    }
  }

  if (replacedURIs.length === 0) {
    return new Response('No valid links could be processed.', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }

  // Assemble final response
  const finalContent = [];
  for (const k of replacedURIs) {
    const cacheKey = k.split('internal/')[1];
    const val = cacheGet(cacheKey);
    if (val?.content) {
      finalContent.push(val.content);
      cacheSet(`delete:${cacheKey}`, null); // Mark for deletion
    }
  }

  // Clean up cache immediately
  for (const k of replacedURIs) {
    const cacheKey = k.split('internal/')[1];
    cacheSet(cacheKey, null); // Overwrite to free reference
  }

  return new Response(finalContent.join('\r\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}

// Main Edge Handler
export default async function handler(request) {
  const url = new URL(request.url);
  
  // Clear cache per request to prevent cross-request pollution in hot reloads
  cacheClear();

  // Root path - serve frontend or minimal info
  if (url.pathname === '/' || url.pathname === '') {
    try {
      const frontendUrl = 'https://raw.githubusercontent.com/lizhi123le/psub/refs/heads/main/index.html';
      const res = await fetch(frontendUrl);
      if (res.ok) {
        let content = await res.text();
        const host = `${url.protocol}//${url.host}`;
        const backendHost = new URL(BACKEND).host;
        content = content
          .replace(/https:\/\/bulianglin2023\.dev/g, host)
          .replace(/bulianglin2023\.dev/g, url.host)
          .replace(new RegExp(escapeRegExp(backendHost), 'g'), url.host);
        return new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    } catch (e) {
      console.error('Frontend fetch error:', e.message);
    }
    
    // Fallback HTML
    const backendBase = BACKEND.replace(/(https?:\/\/[^/]+).*$/, '$1');
    return new Response(`<!DOCTYPE html>
<html>
<head><title>psub</title></head>
<body>
  <h1>psub</h1>
  <p>Subscription Converter (Vercel Edge Optimized)</p>
  <p>Backend: <code>${backendBase}</code></p>
  <p>Usage: <code>/sub?url=YOUR_SUB</code></p>
</body>
</html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Version endpoint
  if (url.pathname === '/version') {
    try {
      const backendBase = BACKEND.replace(/(https?:\/\/[^/]+).*$/, '$1');
      const response = await fetchWithTimeout(`${backendBase}/version`);
      if (response.ok) {
        const text = await response.text();
        return new Response(text.trim(), {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    } catch (e) {
      console.error('Version fetch error:', e.message);
    }
    return new Response('Unknown', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Subscription conversion
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub/')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}
