// Vercel Edge Function for psub - Improved version based on Cloudflare Worker

export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sfo1']
};

// Environment - set BACKEND in Vercel dashboard
const BACKEND = process.env.BACKEND || 'https://api.v1.mk';

// Local cache (mimics Cloudflare Worker's localCache)
const localCache = new Map();

// Memory cache for Vercel subscription content storage
const memoryCache = new Map();

// UTF-8 <-> Base64 helpers using TextEncoder/TextDecoder
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToUtf8Safe(b64) {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Generate random string
function generateRandomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

// Generate random UUID
function generateRandomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == "x" ? r : (r & 3) | 8;
    return v.toString(16);
  });
}

// Escape RegExp special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Robust parsing of subscription data format
function parseData(data) {
  if (data.includes("proxies:")) return { format: "yaml", data: data };
  try {
    const decoded = base64ToUtf8Safe(data.trim());
    if (decoded.includes("://") || decoded.includes("proxies:")) return { format: "base64", data: decoded };
  } catch (e) {}
  return { format: "unknown", data: data };
}

// Robust UTF-8 <-> Base64 helpers using TextEncoder/TextDecoder
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToUtf8Safe(b64) {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// IPv6 normalization and host extraction helpers
function normalizeServer(server) {
  if (!server) return server;
  try {
    server = decodeURIComponent(server);
  } catch (e) {}
  if (server.startsWith('[') && server.endsWith(']')) return server.slice(1, -1);
  if (/^%5B/i.test(server) && /%5D$/i.test(server)) {
    return server.replace(/^%5B/i, '').replace(/%5D$/i, '');
  }
  return server;
}

// Greedy extraction of url param to avoid truncation by internal '&'
function getFullUrl(requestUrl) {
  const url = new URL(requestUrl);
  const search = url.search;
  if (!search) return url.searchParams.get('url');

  const reserved = [
    'target=', 'config=', 'emoji=', 'list=', 'udp=', 'tfo=', 'scv=', 'fdn=',
    'sort=', 'dev=', 'bd=', 'insert=', 'exclude=', 'append_info=', 'expand=',
    'new_name=', 'rename=', 'filename=', 'path=', 'prefix=', 'suffix=', 'ver=',
    'xudp=', 'doh=', 'rule=', 'script=', 'node=', 'group=', 'filter='
  ];

  let searchStr = search.substring(1);
  let urlStart = -1;
  const urlKeys = ['url=', 'sub='];

  for (const k of urlKeys) {
    let idx = searchStr.indexOf(k);
    if (idx !== -1 && (idx === 0 || searchStr[idx - 1] === '&')) {
      urlStart = idx + k.length;
      break;
    }
  }

  if (urlStart === -1) return url.searchParams.get('url');

  let remaining = searchStr.substring(urlStart);
  let bestCut = remaining.length;

  for (const r of reserved) {
    let rIdx = remaining.indexOf('&' + r);
    if (rIdx !== -1 && rIdx < bestCut) bestCut = rIdx;
  }

  let finalUrl = remaining.substring(0, bestCut);
  const stdUrl = url.searchParams.get('url');
  if (stdUrl && stdUrl.includes('://') && stdUrl.length > finalUrl.length) return stdUrl;

  try { return decodeURIComponent(finalUrl); } catch (e) { return finalUrl; }
}

// KV helpers (for Cloudflare Worker - Vercel doesn't have KV but we keep the structure)
async function kvGet(env, key) {
  if (localCache.has(key)) return localCache.get(key);
  try {
    // Vercel Edge doesn't have KV, but this pattern can be used in other runtime environments
    // For now, return null to simulate failure
    return null;
  } catch (e) {
    console.error('KV get error', e);
    return null;
  }
}

async function kvPut(env, key, value) {
  try {
    // Vercel doesn't have KV like Cloudflare, this is kept for compatibility
    // In a real deployment, you might need to use another KV solution
    console.log('KV put not available in Vercel Edge (mimicking Worker pattern)');
  } catch (e) {
    console.error('KV put error', e);
  }
}

// Helper to extract host from request
function getHost(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

// Robust UTF-8 <-> Base64 helpers using TextEncoder/TextDecoder
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToUtf8Safe(b64) {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Replace function for different protocols with obfuscation helpers
function replaceInUri(link, replacements, isRecovery) {
  if (link.startsWith("ss://")) return _replaceSS(link, replacements, isRecovery);
  if (link.startsWith("ssr://")) return _replaceSSR(link, replacements, isRecovery);
  if (link.startsWith("vmess://")) return replaceVmess(link, replacements, isRecovery);
  if (link.startsWith("trojan://") || link.startsWith("vless://")) return replaceTrojan(link, replacements, isRecovery);
  if (link.startsWith("hysteria://")) return replaceHysteria(link, replacements, isRecovery);
  if (link.startsWith("hysteria2://")) return replaceHysteria2(link, replacements, isRecovery);
  if (link.startsWith("socks://") || link.startsWith("socks5://")) return replaceSocks(link, replacements, isRecovery);
  return link;
}

// --- Protocol-specific replacement functions ---

function _replaceSS(link, replacements, isRecovery) {
  const randomPassword = generateRandomStr(12);
  const randomDomain = randomPassword + ".com";
  let tempLink = link.slice(5).split("#")[0];
  if (tempLink.includes("@")) {
    const match = tempLink.match(/(\S+?)@((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)):/);
    if (!match) return link;
    const base64Data = match[1];
    const serverRaw = match[2];
    try {
      const decoded = base64ToUtf8Safe(base64Data);
      const parts = decoded.split(":");
      if (parts.length < 2) return link;
      const encryption = parts[0];
      const password = parts.slice(1).join(":");
      const server = normalizeServer(serverRaw);
      replacements[randomDomain] = server;
      replacements[randomPassword] = password;
      const newStr = utf8ToBase64(encryption + ":" + randomPassword);
      return link.replace(base64Data, newStr).replace(serverRaw, randomDomain);
    } catch (e) { return link; }
  }
  return link;
}

function replaceVmess(link, replacements, isRecovery) {
  let tempLink = link.replace("vmess://", "");
  try {
    const decoded = base64ToUtf8Safe(tempLink);
    const jsonData = JSON.parse(decoded);
    const serverRaw = jsonData.add;
    const server = normalizeServer(serverRaw);
    const uuid = jsonData.id;
    const randomDomain = generateRandomStr(10) + ".com";
    const randomUUID = generateRandomUUID();
    replacements[randomDomain] = server;
    replacements[randomUUID] = uuid;
    jsonData.add = randomDomain;
    jsonData.id = randomUUID;
    return "vmess://" + utf8ToBase64(JSON.stringify(jsonData));
  } catch (e) {
    return link;
  }
}

function replaceTrojan(link, replacements, isRecovery) {
  const re = /(vless|trojan):\/\/(.*?)@((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)):/;
  const match = link.match(re);
  if (!match) return link;
  const uuid = match[2];
  const rawHost = match[3];
  const server = normalizeServer(rawHost);

  if (isRecovery) {
    const original = replacements[server];
    return original ? link.replace(rawHost, original) : link;
  } else {
    const randomDomain = generateRandomStr(10) + ".com";
    const randomUUID = generateRandomUUID();
    replacements[randomDomain] = server;
    replacements[randomUUID] = uuid;
    return link.replace(uuid, randomUUID).replace(rawHost, randomDomain);
  }
}

function _replaceSSR(link, replacements, isRecovery) {
  try {
    let data = link.slice(6).replace("\r", "").split("#")[0];
    let decoded = base64ToUtf8Safe(data);
    const match = decoded.match(/((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\w\.-]+)):(\d+?):(\S+?):(\S+?):(\S+?):(\S+)\//);
    if (!match) return link;
    const serverRaw = match[1];
    let server = normalizeServer(serverRaw);
    const port = match[2];
    const proto = match[3];
    const method = match[4];
    const obfs = match[5];
    const passwordEncoded = match[6];

    if (isRecovery) {
      const originalServer = replacements[serverRaw];
      const originalPass = base64ToUtf8Safe(passwordEncoded);
      if (!originalServer || !originalPass) return link;
      const recovered = decoded.replace(serverRaw, originalServer).replace(passwordEncoded, utf8ToBase64(originalPass));
      return "ssr://" + utf8ToBase64(recovered);
    } else {
      const randomDomain = generateRandomStr(12) + ".com";
      const randomPass = generateRandomStr(12);
      replacements[randomDomain] = serverRaw;
      replacements[randomPass] = passwordEncoded;
      const replaced = decoded.replace(serverRaw, randomDomain).replace(passwordEncoded, utf8ToBase64(randomPass));
      return "ssr://" + uuidToBase64(replaced);
    }
  } catch (e) { return link; }
}

function replaceSocks(link, replacements, isRecovery) {
  try {
    let temp = link.replace(/^socks5?:\/\//, "");
    const hashSplit = temp.split("#");
    const hashPart = hashSplit.length > 1 ? "#" + hashSplit[1] : "";
    temp = hashSplit[0];
    const atIndex = temp.indexOf("@");
    const fakeIP = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    
    if (atIndex !== -1) {
      const authBase64 = temp.slice(0, atIndex);
      const serverPort = temp.slice(atIndex + 1);
      const auth = base64ToUtf8Safe(authBase64);
      const [user, pass] = auth.split(":");
      const serverMatch = serverPort.match(/^(((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))):(\d+)$/);
      if (!serverMatch) return link;
      const serverRaw = serverMatch[1];
      replacements[fakeIP] = serverRaw;
      if (pass) replacements[randomPass] = pass;
      return `socks://${utf8ToBase64(user + ":" + randomPass)}@${fakeIP}:${port}${hashPart}`;
    } else {
      const serverMatch = temp.match(/^(((?:\[[\da-fA-F:]+\])|(?:[\d\-\w\.]+))):(\d+)$/);
      if (!serverMatch) return link;
      const serverRaw = serverMatch[1];
      replacements[fakeIP] = serverRaw;
      return `socks://${fakeIP}:${port}${hashPart}`;
    }
  } catch (e) { return link; }
}

function replaceHysteria(link, replacements, isRecovery) {
  const re = /hysteria:\/\/(((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))):/;
  const match = link.match(re);
  if (!match) return link;
  const rawHost = match[1];
  const server = normalizeServer(rawHost);

  if (isRecovery) {
    const original = replacements[serverRaw] || replacements[rawHost];
    return original ? link.replace(rawHost, original) : link;
  } else {
    const randomDomain = generateRandomStr(12) + ".com";
    replacements[randomDomain] = rawHost;
    return link.replace(rawHost, randomDomain);
  }
}

function replaceHysteria2(link, replacements, isRecovery) {
  const re = /(hysteria2):\/\/(.*)@(((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))):/;
  const match = link.match(re);
  if (!match) return link;
  const uuid = match[2];
  const rawHost = match[3];
  const server = normalizeServer(rawHost);

  if (isRecovery) {
    const original = replacements[serverRaw] || replacements[rawHost];
    return original ? link.replace(rawHost, original) : link;
  } else {
    const randomDomain = generateRandomStr(10) + ".com";
    const randomUUID = generateRandomUUID();
    replacements[randomDomain] = rawHost;
    replacements[randomUUID] = uuid;
    return link.replace(uuid, randomUUID).replace(rawHost, randomDomain);
  }
}

function replaceYAMLContent(content, replacements) {
  let result = content;
  const serverRegex = /server:\s*(((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)))/gu;
  result = result.replace(serverRegex, (match, p1) => {
    const serverRaw = p1;
    const normalized = normalizeServer(serverRaw);
    if (normalized && (normalized.includes(".") || normalized.includes(":"))) {
      const randomDomain = generateRandomStr(12) + ".com";
      replacements[randomDomain] = normalized;
      return `server: ${randomDomain}`;
    }
    return match;
  });
  const uuidRegex = /uuid:\s*(\S+)/g;
  result = result.replace(uuidRegex, (match, uuid) => {
    const randomUUID = generateRandomUUID();
    replacements[randomUUID] = uuid;
    return `uuid: ${randomUUID}`;
  });
  const passRegex = /password:\s*(\S+)/g;
  result = result.replace(passRegex, (match, pass) => {
    const randomPass = generateRandomStr(12);
    replacements[randomPass] = pass;
    return `password: ${randomPass}`;
  });
  return result;
}

// --- IPv6 normalization and host extraction helpers ---
function normalizeServer(server) {
  if (!server) return server;
  try {
    server = decodeURIComponent(server);
  } catch (e) {}
  if (server.startsWith('[') && server.endsWith(']')) return server.slice(1, -1);
  if (/^%5B/i.test(server) && /%5D$/i.test(server)) {
    return server.replace(/^%5B/i, '').replace(/%5D$/i, '');
  }
  return server;
}

// Process subscription and replace with local URLs
async function processSubscription(request, url, backend) {
  const host = getHost(request);
  const subDir = 'internal';
  const targetUrl = url.searchParams.get('url');
  const target = url.searchParams.get('target');

  if (!targetUrl) {
    return new Response('Missing url parameter', { status: 400 });
  }

  // If there's a target parameter (like 'clash'), forward to backend for conversion first
  if (target) {
    const replacements = {};
    try {
      const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
      const backendUrl = `${backendBase}${url.pathname}${url.search}`;
      const response = await fetch(backendUrl, {
        method: 'GET',
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/plain,*/*'
        },
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        return new Response(`Backend error: ${response.status}`, { status: response.status });
      }

      let content = await response.text();
      const buffer = await response.arrayBuffer();
      const decoder = new TextDecoder('utf-8');
      content = decoder.decode(buffer);

      // Replace backend domains with current host
      content = content.replace(/https:\/\/bulianglin2023\.dev/g, host).replace(/bulianglin2023\.dev/g, url.host);
      content = content.replace(/https:\/\/api\.v1\.mk/g, host).replace(/api\.v1\.mk/g, url.host);

      const parsed = parseData(content);
      let obfuscatedData = content;

      if (parsed.format === 'yaml') {
        // First do full replacement, then save to internal storage
      }

      // Save to memory cache for retrieval
      const key = generateRandomStr(20);
      memoryCache.set(key, JSON.stringify({ 
        content: obfuscatedData || content,
        headers: response.headers.raw() 
      }));
      replacedURIs.push(`${subDir}/${key}`);

      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'text/plain',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      return new Response(`Error forwarding to backend: ${e.message}`, { status: 500 });
    }
  }

  // Parse the subscription URL
  const replacedURIs = [];
  const urlParts = targetUrl.split('|').filter(p => p.trim() !== '');

  if (urlParts.length === 0) {
    return new Response('There are no valid links', { status: 400 });
  }

  for (const rawPart of urlParts) {
    const key = generateRandomStr(16);

    if (rawPart.startsWith('http://') || rawPart.startsWith('https://')) {
      try {
        const controller = new AbortController();
        AbortSignal.timeout(30000);

        const response = await fetch(rawPart, {
          method: 'GET',
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: controller.signal
        });

        if (!response.ok) continue;

        const content = await response.text();
        if (!content || content.trim().length === 0) continue;

        const parsed = parseData(content);
        
        let obfuscatedData = content;

        if (parsed.format === 'base64') {
          const links = parsed.data.split(/\r?\n/).filter(l => l.trim());
          for (const link of links) {
            const nl = replaceInUri(link, {}, false);
            if (nl && nl !== link) {
              obfuscatedData = utf8ToBase64(nl);
            } else {
              obfuscatedData = nl || link;
            }
          }
        } else if (parsed.format === 'yaml') {
          obfuscatedData = replaceYAMLContent(content, {});
        }

        memoryCache.set(key, obfuscatedData);
        replacedURIs.push(`${host}/${subDir}/${key}`);
      } catch (e) {
        console.error('Fetch error:', e.message);
        continue;
      }
    } else if (/^(ssr?|vmess1?|trojan|vless|hysteria|hysteria2|tg):\/\//.test(rawPart) || rawPart.startsWith('socks://')) {
      memoryCache.set(key, rawPart);
      replacedURIs.push(`${host}/${subDir}/${key}`);
    }
  }

  if (replacedURIs.length === 0) {
    return new Response('Error: All subscription links are invalid or returned empty content.', { 
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Collect all cached content for final response
  const assembled = [];
  for (const k of replacedURIs) {
    try {
      const value = memoryCache.get(k.substring(7));
      if (value) assembled.push(value);
    } catch (e) {
      continue;
    }
  }

  if (assembled.length > 0) {
    return new Response(assembled.join('\r\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response('Not found', { status: 404 });
}

// Main handler
export default async function handler(request) {
  const url = new URL(request.url);
  
  // Root - return index.html template
  if (url.pathname === '/' || url.pathname === '') {
    try {
      let html = `<!DOCTYPE html>`;
      html += '<html><head><title>psub</title></head><body>';
      html += '<h1>psub</h1><p>Subscription Converter (Vercel Edge Enhanced)</p>';
      html += '<p>Backend API: <code>' + BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1") + '</code></p>';
      html += '<p>Use: /sub?url=YOUR_SUBSCRIPTION_URL</p>';
      html += '<p>Version: /version</p></body></html>';

      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    } catch (e) {
      console.error('Error loading index.html:', e);
    }
  }

  // Version endpoint
  if (url.pathname === '/version') {
    try {
      const backend = BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1");
      const response = await fetch(`${backend}/version`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
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

      return new Response(`Error: Backend returned ${response.status}`, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      console.error('Version fetch error:', e);
    }
  }

  // Subscription conversion endpoint
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not found', { status: 404 });
}
