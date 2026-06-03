export const config = {
  runtime: 'edge',
  regions: ['sin1']
};

// Environment - set BACKEND in Vercel dashboard
const BACKEND = process.env.BACKEND || 'https://api.v1.mk';


// Memory cache for Vercel subscription content storage
// Stored value: { content: string, headers?: object, createdAt: number, timeoutId?: number }
const memoryCache = new Map();

// TTL for memoryCache entries (milliseconds)
const MEMORY_CACHE_TTL = 60 * 1000; // 60 seconds

// Helper to store into memoryCache with automatic expiry
function memoryCacheSet(key, value) {
  // Clear existing timeout if present
  const existing = memoryCache.get(key);
  if (existing && existing.timeoutId) {
    try { clearTimeout(existing.timeoutId); } catch (e) {}
  }
  const timeoutId = setTimeout(() => {
    try { memoryCache.delete(key); } catch (e) {}
  }, MEMORY_CACHE_TTL);

  memoryCache.set(key, { ...value, createdAt: Date.now(), timeoutId });
}

// Helper to delete memoryCache entry immediately and clear timeout
function memoryCacheDelete(key) {
  const v = memoryCache.get(key);
  if (v && v.timeoutId) {
    try { clearTimeout(v.timeoutId); } catch (e) {}
  }
  memoryCache.delete(key);
}

// UTF-8 <-> Base64 helpers (standard base64, compatible with base64ToUtf8Safe)
function utf8ToBase64(str) {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
}

function base64ToUtf8Safe(b64) {
  const cleaned = b64.replace(/\s/g, '');
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
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
  if (!data) return { format: "unknown", data: data };
  if (data.includes("proxies:")) return { format: "yaml", data: data };
  try {
    const decoded = base64ToUtf8Safe(data.trim());
    if (decoded.includes("://") || decoded.includes("proxies:")) return { format: "base64", data: decoded };
  } catch (e) {}
  return { format: "unknown", data: data };
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

// Helper to extract host from request
function getHost(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

// Replace function for different protocols with obfuscation helpers
function replaceInUri(link, replacements, isRecovery) {
  if (!link) return link;
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
      if (replacements && server) replacements[randomDomain] = server;
      if (replacements && password) replacements[randomPassword] = password;
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
    if (replacements && server) replacements[randomDomain] = server;
    if (replacements && uuid) replacements[randomUUID] = uuid;
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
    const original = replacements && (replacements[server] || replacements[rawHost]);
    return original ? link.replace(rawHost, original) : link;
  } else {
    const randomDomain = generateRandomStr(10) + ".com";
    const randomUUID = generateRandomUUID();
    if (replacements) {
      replacements[randomDomain] = server;
      replacements[randomUUID] = uuid;
    }
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
      const originalServer = replacements && (replacements[serverRaw] || replacements[server]);
      const originalPass = passwordEncoded ? base64ToUtf8Safe(passwordEncoded) : null;
      if (!originalServer || !originalPass) return link;
      const recovered = decoded.replace(serverRaw, originalServer).replace(passwordEncoded, utf8ToBase64(originalPass));
      return "ssr://" + utf8ToBase64(recovered);
    } else {
      const randomDomain = generateRandomStr(12) + ".com";
      const randomPass = generateRandomStr(12);
      if (replacements) {
        replacements[randomDomain] = serverRaw;
        replacements[randomPass] = passwordEncoded;
      }
      const replaced = decoded.replace(serverRaw, randomDomain).replace(passwordEncoded, utf8ToBase64(randomPass));
      return "ssr://" + utf8ToBase64(replaced);
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
      if (replacements) replacements[fakeIP] = serverRaw;
      const randomPass = generateRandomStr(12);
      const port = serverMatch[3];
      if (pass && replacements) replacements[randomPass] = pass;
      return `socks://${utf8ToBase64(user + ":" + randomPass)}@${fakeIP}:${port}${hashPart}`;
    } else {
      const serverMatch = temp.match(/^(((?:\[[\da-fA-F:]+\])|(?:[\d\-\w\.]+))):(\d+)$/);
      if (!serverMatch) return link;
      const serverRaw = serverMatch[1];
      if (replacements) replacements[fakeIP] = serverRaw;
      return `socks://${fakeIP}:${serverMatch[3]}${hashPart}`;
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
    const original = replacements && (replacements[server] || replacements[rawHost]);
    return original ? link.replace(rawHost, original) : link;
  } else {
    const randomDomain = generateRandomStr(12) + ".com";
    if (replacements) replacements[randomDomain] = rawHost;
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
    const original = replacements && (replacements[server] || replacements[rawHost]);
    return original ? link.replace(rawHost, original) : link;
  } else {
    const randomDomain = generateRandomStr(10) + ".com";
    const randomUUID = generateRandomUUID();
    if (replacements) {
      replacements[randomDomain] = rawHost;
      replacements[randomUUID] = uuid;
    }
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
      if (replacements) replacements[randomDomain] = normalized;
      return `server: ${randomDomain}`;
    }
    return match;
  });
  const uuidRegex = /uuid:\s*(\S+)/g;
  result = result.replace(uuidRegex, (match, uuid) => {
    const randomUUID = generateRandomUUID();
    if (replacements) replacements[randomUUID] = uuid;
    return `uuid: ${randomUUID}`;
  });
  const passRegex = /password:\s*(\S+)/g;
  result = result.replace(passRegex, (match, pass) => {
    const randomPass = generateRandomStr(12);
    if (replacements) replacements[randomPass] = pass;
    return `password: ${randomPass}`;
  });
  return result;
}

// Process subscription and replace with local URLs
async function processSubscription(request, url, backend) {
  const targetUrl = getFullUrl(request.url);
  if (!targetUrl) {
    const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const backendUrl = `${backendBase}/sub${url.search}`;
    try {
      const response = await fetch(backendUrl, {
        method: 'GET',
        headers: { 'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0' }
      });
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response(`Error forwarding to backend: ${e.message}`, { status: 500 });
    }
  }

  const host = getHost(request);
  const subInternalDir = 'internal';
  const replacements = {};
  const replacedURIs = [];
  const keys = [];
  const fetchErrors = [];

  const urlParts = targetUrl.split('|').filter(p => p.trim() !== '');
  let lastYieldTime = Date.now();

  for (const part of urlParts) {
    if (Date.now() - lastYieldTime > 5) { await new Promise(r => setTimeout(r, 0)); lastYieldTime = Date.now(); }
    const key = generateRandomStr(16);
    let plaintextData = "";
    let responseHeaders = {};

    if (part.startsWith('http://') || part.startsWith('https://')) {
      try {
        let signal;
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
          signal = AbortSignal.timeout(30000);
        } else {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 30000);
          signal = controller.signal;
        }

        const resp = await fetch(part, {
          method: 'GET',
          headers: { "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0" },
          signal
        });
        if (resp.ok) {
          plaintextData = await resp.text();
          const hdrs = {};
          const forbiddenHeaders = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'content-range'];
          for (const [k, v] of resp.headers.entries()) {
            if (!forbiddenHeaders.includes(k.toLowerCase())) {
              hdrs[k] = v;
            }
          }
          responseHeaders = hdrs;
        } else {
          console.error('remote fetch not ok', part, resp.status);
          fetchErrors.push(`${part}: HTTP ${resp.status} ${resp.statusText || ''}`);
          continue;
        }
      } catch (e) {
        console.error("Fetch failed:", part, e && e.message ? e.message : e);
        fetchErrors.push(`${part}: Fetch failed: ${e.message || e}`);
        continue;
      }
    } else {
      plaintextData = part;
    }

    if (plaintextData) {
      const parsed = parseData(plaintextData);
      let obfuscatedData = plaintextData;

      if (parsed.format === "base64") {
        const links = parsed.data.split(/\r?\n/).filter(l => l.trim());
        const newLinks = [];
        for (const link of links) {
          if (Date.now() - lastYieldTime > 5) { await new Promise(r => setTimeout(r, 0)); lastYieldTime = Date.now(); }
          const nl = replaceInUri(link, replacements, false);
          newLinks.push(nl || link);
        }
        obfuscatedData = utf8ToBase64(newLinks.join("\r\n"));
      } else if (parsed.format === "yaml") {
        obfuscatedData = replaceYAMLContent(plaintextData, replacements);
      }

      memoryCacheSet(key, { content: obfuscatedData, headers: responseHeaders });
      keys.push(key);
      replacedURIs.push(`${host}/${subInternalDir}/${key}`);
    }
  }

  if (replacedURIs.length === 0) {
    return new Response("No valid nodes found. Errors:\n" + fetchErrors.join("\n"), { status: 400 });
  }

  try {
    const newUrl = replacedURIs.join('|');
    const incomingParams = new URL(request.url).searchParams;
    const originalParams = new URLSearchParams();

    const whitelist = [
      'target', 'config', 'emoji', 'list', 'udp', 'tfo', 'scv', 'fdn',
      'sort', 'dev', 'bd', 'insert', 'exclude', 'append_info', 'expand',
      'new_name', 'rename', 'filename', 'path', 'prefix', 'suffix', 'ver',
      'xudp', 'doh', 'rule', 'script', 'node', 'group', 'filter'
    ];

    for (const [k, v] of incomingParams.entries()) {
      if (whitelist.includes(k)) originalParams.set(k, v);
    }
    originalParams.set('url', newUrl);

    const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const backendUrl = `${backendBase}/sub?${originalParams.toString()}`;

    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    let content = await response.text();
    
    // Replace backend domains with current host dynamically
    let parsedContext = null;
    try {
      const backendHost = new URL(backend).host;
      const backendRegex = new RegExp(escapeRegExp(backendHost), 'g');
      const replaceDomains = (str) => {
        return str
          .replace(/https:\/\/bulianglin2023\.dev/g, host)
          .replace(/bulianglin2023\.dev/g, url.host)
          .replace(new RegExp(`https://${escapeRegExp(backendHost)}`, 'g'), host)
          .replace(backendRegex, url.host)
          .replace(/http:\/\/127\.0\.0\.1:25500/g, host)
          .replace(/127\.0\.0\.1:25500/g, url.host);
      };
      
      parsedContext = parseData(content);
      if (parsedContext.format === 'base64') {
        const replaced = replaceDomains(parsedContext.data);
        content = utf8ToBase64(replaced);
      } else {
        content = replaceDomains(content);
      }
    } catch (e) {
      console.error('Domain replace error:', e);
    }

    // Test for backend error in decoded content (not base64-encoded content)
    const testContent = parsedContext && parsedContext.format === 'base64' ? parsedContext.data : content;
    const backendIndicatesNoNodes = /no nodes were found|no valid nodes found|not found/i.test(testContent);
    if (!response.ok || backendIndicatesNoNodes) {
      const assembled = [];
      let lastYieldTime = Date.now();
      for (const k of keys) {
        if (Date.now() - lastYieldTime > 5) { await new Promise(r => setTimeout(r, 0)); lastYieldTime = Date.now(); }
        const val = memoryCache.get(k);
        if (val && val.content) assembled.push(val.content);
      }
      if (assembled.length > 0) {
        const target = incomingParams.get('target');
        if (target === 'base64') {
          content = assembled.join('|');
        } else {
          let lastYieldTime = Date.now();
          const decodedParts = [];
          for (const p of assembled) {
            if (Date.now() - lastYieldTime > 5) { await new Promise(r => setTimeout(r, 0)); lastYieldTime = Date.now(); }
            try {
              const dec = base64ToUtf8Safe(p);
              if (dec && (dec.includes('://') || dec.includes('proxies:') || dec.includes('port:'))) decodedParts.push(dec);
              else decodedParts.push(p);
            } catch (e) {
              decodedParts.push(p);
            }
          }
          content = decodedParts.join('\r\n');
        }

        let lastYieldTime = Date.now();
        for (const k of keys) {
          if (Date.now() - lastYieldTime > 5) { await new Promise(r => setTimeout(r, 0)); lastYieldTime = Date.now(); }
          memoryCacheDelete(k);
        }

        return new Response(content, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
      return new Response(content, { status: response.status || 500 });
    }

    if (Object.keys(replacements).length > 0) {
      const recoveryRegex = new RegExp(Object.keys(replacements).map(escapeRegExp).join("|"), "g");
      const target = url.searchParams.get("target");
      let lastYieldTime = Date.now();
      try {
        const decoded = base64ToUtf8Safe(content);
        if (decoded && (decoded.includes("://") || decoded.includes("proxies:") || decoded.includes("port:"))) {
          const lines = decoded.split(/\r?\n/);
          const recovered = [];
          for (const line of lines) {
            if (Date.now() - lastYieldTime > 5) { await new Promise(r => setTimeout(r, 0)); lastYieldTime = Date.now(); }
            recovered.push(line.replace(recoveryRegex, (m) => replacements[m] || m));
          }
          const namedTargets = ['clash', 'surge', 'quan', 'quanx', 'loon', 'ss', 'ssr', 'v2ray', 'singbox', 'proxy'];
          const isNamedFormat = target && namedTargets.includes(target.toLowerCase());
          content = (target === "base64" || target === "mixed" || (!isNamedFormat && parsedContext && parsedContext.format === "base64")) ? utf8ToBase64(recovered.join("\r\n")) : recovered.join("\r\n");
        } else {
          content = content.replace(recoveryRegex, (m) => replacements[m] || m);
        }
      } catch (e) {
        content = content.replace(recoveryRegex, (m) => replacements[m] || m);
      }
    }

    let lastYieldTime = Date.now();
    for (const k of keys) {
      if (Date.now() - lastYieldTime > 5) { await new Promise(r => setTimeout(r, 0)); lastYieldTime = Date.now(); }
      memoryCacheDelete(k);
    }

    return new Response(content, {
      status: response.status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  } catch (e) {
    console.error('processSubscription error', e);
    return new Response(`Error: ${e.message || e}`, { status: 500 });
  }
}

// Main handler
export default async function handler(request) {
  const url = new URL(request.url);
  
  // Root - return index.html template
  if (url.pathname === '/' || url.pathname === '') {
    try {
      const frontendUrl = "https://raw.githubusercontent.com/lizhi123le/psub/refs/heads/main/index.html";
      const res = await fetch(frontendUrl);
      if (res.ok) {
        let content = await res.text();
        const host = `${url.protocol}//${url.host}`;
        try {
          const backendHost = new URL(BACKEND).host;
          const backendRegex = new RegExp(escapeRegExp(backendHost), 'g');
          content = content
            .replace(/https:\/\/bulianglin2023\.dev/g, host)
            .replace(/bulianglin2023\.dev/g, url.host);
        } catch (e) {
          console.error('Frontend replacement error:', e);
        }
        return new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    } catch (e) {
      console.error('Error loading index.html:', e);
    }
    
    // Fallback minimal page
    let html = `<!DOCTYPE html>`;
    html += '<html><head><title>psub</title></head><body>';
    html += '<h1>psub</h1><p>Subscription Converter (Vercel Edge Enhanced)</p>';
    html += '<p>Backend API: <code>' + BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1") + '</code></p>';
    html += '<p>Use: /sub?url=YOUR_SUBSCRIPTION_URL</p>';
    html += '<p>Version: /version</p></body></html>';

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
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

  // Internal temporary subscription endpoint
  if (url.pathname.includes("/internal/")) {
    const pathSegments = url.pathname.split("/").filter(s => s);
    const key = pathSegments[pathSegments.length - 1];

    const value = memoryCache.get(key);
    if (!value || !value.content) return new Response("Not Found", { status: 404 });

    const headersObj = value.headers || { "Content-Type": "text/plain; charset=utf-8" };
    const headers = new Headers(headersObj);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(value.content, { headers });
  }

  // Subscription conversion endpoint
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not found', { status: 404 });
}