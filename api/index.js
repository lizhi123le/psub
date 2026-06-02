export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sfo1']
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
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (e) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
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
  if (!data) return { format: "unknown", data: data };
  if (data.includes("proxies:")) return { format: "yaml", data: data };
  try {
    const decoded = base64ToUtf8Safe(data.trim());
    if (decoded.includes("://") || decoded.includes("proxies:")) return { format: "base64", data: decoded };
  } catch (e) {}
  return { format: "unknown", data: data };
}

// Normalize hostname: decodeURI, strip IPv6 brackets, handle URL-encoded brackets
function normalizeServer(server) {
  if (!server) return server;
  try {
    server = decodeURIComponent(server);
  } catch (e) {}
  const h = String(server);
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);
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
  if (link.startsWith("ss://")) return replaceSS(link, replacements, isRecovery);
  if (link.startsWith("ssr://")) return replaceSSR(link, replacements, isRecovery);
  if (link.startsWith("vmess://")) return replaceVmess(link, replacements, isRecovery);
  if (link.startsWith("trojan://") || link.startsWith("vless://")) return replaceTrojan(link, replacements, isRecovery);
  if (link.startsWith("hysteria://")) return replaceHysteria(link, replacements, isRecovery);
  if (link.startsWith("hysteria2://")) return replaceHysteria2(link, replacements, isRecovery);
  if (link.startsWith("socks://") || link.startsWith("socks5://")) return replaceSocks(link, replacements, isRecovery);
  return link;
}

// --- Protocol-specific replacement functions ---

function replaceSS(link, replacements, isRecovery) {
  const randomPassword = generateRandomStr(12);
  const randomDomain = generateRandomStr(16) + ".com";
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

function replaceSSR(link, replacements, isRecovery) {
  try {
    let data = link.slice(6).replace("\r", "").split("#")[0];
    let decoded = base64ToUtf8Safe(data);
    const match = decoded.match(/((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\w\.-]+)):(\d+?):(\S+?):(\S+?):(\S+?):(\S+)\//);
    if (!match) return link;
    const serverRaw = match[1];
    const server = normalizeServer(serverRaw);
    const passwordEncoded = match[6];

    if (isRecovery) {
      const originalServer = replacements && replacements[server];
      const originalPass = replacements && replacements[base64ToUtf8Safe(passwordEncoded)];
      if (!originalServer || !originalPass) return link;
      const recovered = decoded.replace(serverRaw, originalServer).replace(passwordEncoded, utf8ToBase64(originalPass));
      return "ssr://" + utf8ToBase64(recovered);
    } else {
      const randomDomain = generateRandomStr(12) + ".com";
      const randomPass = generateRandomStr(12);
      if (replacements) {
        replacements[randomDomain] = server;
        replacements[randomPass] = base64ToUtf8Safe(passwordEncoded);
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
      const server = normalizeServer(serverRaw);
      if (replacements) replacements[fakeIP] = server;
      const randomPass = generateRandomStr(12);
      const port = serverMatch[3];
      if (pass && replacements) replacements[randomPass] = pass;
      return `socks://${utf8ToBase64(user + ":" + randomPass)}@${fakeIP}:${port}${hashPart}`;
    } else {
      const serverMatch = temp.match(/^(((?:\[[\da-fA-F:]+\])|(?:[\d\-\w\.]+))):(\d+)$/);
      if (!serverMatch) return link;
      const serverRaw = serverMatch[1];
      const server = normalizeServer(serverRaw);
      if (replacements) replacements[fakeIP] = server;
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
    if (replacements) replacements[randomDomain] = server;
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
      replacements[randomDomain] = server;
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

// ============================================================
// Universal proxy link parser - converts any proxy URI to node object
// ============================================================

// YAML quote helper (for Clash output - avoid IPv6 brackets being parsed as array)
function yq(v) {
  if (v == null) return '""';
  const s = String(v);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Alias for normalizeServer (used by format generators)
function normalizeServerHost(hostname) {
  return normalizeServer(hostname);
}

// Parse any proxy link into a node object for format conversion
function parseProxyLink(link) {
  if (!link) return null;
  try {
    // VLESS
    if (link.startsWith('vless://')) {
      const url = new URL(link);
      const p = new URLSearchParams(url.search);
      return {
        proto: 'vless',
        name: decodeURIComponent(url.hash.substring(1)) || (url.hostname + ':' + url.port),
        uuid: url.username,
        server: normalizeServerHost(url.hostname),
        port: parseInt(url.port) || 443,
        tls: p.get('security') === 'tls' || p.get('security') === 'reality',
        network: p.get('type') || 'ws',
        path: p.get('path') || '/',
        host: normalizeServerHost(p.get('host') || url.hostname),
        sni: normalizeServerHost(p.get('sni') || p.get('host') || url.hostname),
        alpn: (p.get('alpn') || '').split(',').map(s => s.trim()).filter(Boolean),
        fp: p.get('fp') || 'chrome',
        flow: p.get('flow') || '',
        encryption: p.get('encryption') || 'none',
        ech: p.get('ech') || ''
      };
    }
    // Trojan
    if (link.startsWith('trojan://')) {
      const url = new URL(link);
      const p = new URLSearchParams(url.search);
      return {
        proto: 'trojan',
        name: decodeURIComponent(url.hash.substring(1)) || (url.hostname + ':' + url.port),
        password: decodeURIComponent(url.username),
        server: normalizeServerHost(url.hostname),
        port: parseInt(url.port) || 443,
        tls: true,
        network: p.get('type') || 'ws',
        path: p.get('path') || '/',
        host: normalizeServerHost(p.get('host') || url.hostname),
        sni: normalizeServerHost(p.get('sni') || p.get('host') || url.hostname),
        alpn: (p.get('alpn') || '').split(',').map(s => s.trim()).filter(Boolean),
        fp: p.get('fp') || 'chrome',
        ech: p.get('ech') || ''
      };
    }
    // VMess
    if (link.startsWith('vmess://')) {
      const b64 = link.slice(8);
      let decoded;
      try { decoded = base64ToUtf8Safe(b64); } catch (e) { decoded = ''; }
      // Check if it's JSON format
      if (decoded.startsWith('{')) {
        const j = JSON.parse(decoded);
        return {
          proto: 'vmess',
          name: j.ps || j.remarks || (j.add + ':' + j.port),
          uuid: j.id,
          server: normalizeServerHost(j.add),
          port: parseInt(j.port) || 443,
          tls: j.tls === 'tls' || j.security === 'tls',
          network: j.net || 'ws',
          path: j.path || '/',
          host: normalizeServerHost(j.host || j.add),
          sni: normalizeServerHost(j.sni || j.host || j.add),
          aid: parseInt(j.aid) || 0,
          encryption: j.security || 'auto'
        };
      }
      // Non-JSON vmess (rare, but handle)
      if (decoded.includes('@')) {
        const parts = decoded.split('@');
        const auth = parts[0];
        const rest = parts[1];
        const colonIdx = rest.lastIndexOf(':');
        const serverPort = colonIdx !== -1 ? rest.substring(0, colonIdx) : rest;
        const port = colonIdx !== -1 ? rest.substring(colonIdx + 1) : '443';
        return {
          proto: 'vmess',
          name: serverPort + ':' + port,
          uuid: auth,
          server: normalizeServerHost(serverPort),
          port: parseInt(port) || 443,
          tls: false,
          network: 'ws',
          path: '/',
          host: normalizeServerHost(serverPort)
        };
      }
      return null;
    }
    // ShadowSocks (ss://)
    if (link.startsWith('ss://')) {
      const hashIdx = link.indexOf('#');
      const name = hashIdx !== -1 ? decodeURIComponent(link.slice(hashIdx + 1)) : '';
      const cleanLink = hashIdx !== -1 ? link.slice(0, hashIdx) : link;
      const afterProtocol = cleanLink.slice(5);
      // Format: ss://base64(method:password)@server:port or ss://base64(method:password@server:port)
      if (afterProtocol.includes('@')) {
        const atIdx = afterProtocol.indexOf('@');
        const b64Part = afterProtocol.slice(0, atIdx);
        const serverPortStr = afterProtocol.slice(atIdx + 1);
        const colonIdx = serverPortStr.lastIndexOf(':');
        const server = colonIdx !== -1 ? serverPortStr.slice(0, colonIdx) : serverPortStr;
        const port = colonIdx !== -1 ? serverPortStr.slice(colonIdx + 1) : '443';
        let decoded;
        try { decoded = base64ToUtf8Safe(b64Part); } catch (e) { decoded = ''; }
        const methodColon = decoded.indexOf(':');
        const method = methodColon !== -1 ? decoded.slice(0, methodColon) : decoded;
        const password = methodColon !== -1 ? decoded.slice(methodColon + 1) : '';
        return {
          proto: 'ss',
          name: name || (server + ':' + port),
          server: normalizeServerHost(server),
          port: parseInt(port) || 443,
          method: method || 'aes-256-gcm',
          password: password
        };
      }
      // SIP002 format: ss://base64(method:password)@server:port
      const b64Part = afterProtocol.split('@')[0];
      let decoded;
      try { decoded = base64ToUtf8Safe(b64Part); } catch (e) { decoded = ''; }
      const methodColon = decoded.indexOf(':');
      const method = methodColon !== -1 ? decoded.slice(0, methodColon) : decoded;
      const password = methodColon !== -1 ? decoded.slice(methodColon + 1) : '';
      return {
        proto: 'ss',
        name: name || 'ss-node',
        server: 'localhost',
        port: 443,
        method: method || 'aes-256-gcm',
        password: password
      };
    }
    // ShadowSocksR (ssr://)
    if (link.startsWith('ssr://')) {
      const b64 = link.slice(6);
      let decoded;
      try { decoded = base64ToUtf8Safe(b64); } catch (e) { decoded = ''; }
      const hashIdx = decoded.indexOf('#');
      const name = hashIdx !== -1 ? decodeURIComponent(decoded.slice(hashIdx + 1)) : '';
      const clean = hashIdx !== -1 ? decoded.slice(0, hashIdx) : decoded;
      const parts = clean.split(':');
      if (parts.length >= 6) {
        const server = parts[0];
        const port = parts[1];
        const protocol = parts[2];
        const method = parts[3];
        const obfs = parts[4];
        const rest = parts.slice(5).join(':');
        const slashIdx = rest.indexOf('/');
        const passwordB64 = slashIdx !== -1 ? rest.slice(0, slashIdx) : rest;
        let password;
        try { password = base64ToUtf8Safe(passwordB64); } catch (e) { password = passwordB64; }
        return {
          proto: 'ssr',
          name: name || (server + ':' + port),
          server: normalizeServerHost(server),
          port: parseInt(port) || 443,
          method: method || 'aes-256-cfb',
          password: password,
          protocol: protocol || 'origin',
          obfs: obfs || 'plain'
        };
      }
      return null;
    }
    // Hysteria
    if (link.startsWith('hysteria://') || link.startsWith('hy://')) {
      const url = new URL(link.replace(/^hy:\/\//, 'hysteria://'));
      const p = new URLSearchParams(url.search);
      return {
        proto: 'hysteria',
        name: decodeURIComponent(url.hash.substring(1)) || (url.hostname + ':' + url.port),
        server: normalizeServerHost(url.hostname),
        port: parseInt(url.port) || 443,
        protocol: p.get('protocol') || 'udp',
        up: p.get('up') || p.get('up_mbps') || '50',
        down: p.get('down') || p.get('down_mbps') || '100',
        alpn: (p.get('alpn') || '').split(',').map(s => s.trim()).filter(Boolean),
        obfs: p.get('obfs') || ''
      };
    }
    // Hysteria2
    if (link.startsWith('hysteria2://') || link.startsWith('hy2://')) {
      const url = new URL(link.replace(/^hy2:\/\//, 'hysteria2://'));
      const p = new URLSearchParams(url.search);
      const password = url.username;
      return {
        proto: 'hysteria2',
        name: decodeURIComponent(url.hash.substring(1)) || (url.hostname + ':' + url.port),
        password: password,
        server: normalizeServerHost(url.hostname),
        port: parseInt(url.port) || 443,
        up: p.get('up') || p.get('up_mbps') || '50',
        down: p.get('down') || p.get('down_mbps') || '100',
        obfs: p.get('obfs') || '',
        obfs_password: p.get('obfs-password') || '',
        sni: normalizeServerHost(p.get('sni') || url.hostname)
      };
    }
    // SOCKS
    if (link.startsWith('socks://') || link.startsWith('socks5://')) {
      const clean = link.replace(/^socks5?:\/\//, '');
      const hashIdx = clean.indexOf('#');
      const name = hashIdx !== -1 ? decodeURIComponent(clean.slice(hashIdx + 1)) : '';
      const serverPortStr = hashIdx !== -1 ? clean.slice(0, hashIdx) : clean;
      const atIdx = serverPortStr.indexOf('@');
      if (atIdx !== -1) {
        const authB64 = serverPortStr.slice(0, atIdx);
        const sp = serverPortStr.slice(atIdx + 1);
        const colonIdx = sp.lastIndexOf(':');
        const server = colonIdx !== -1 ? sp.slice(0, colonIdx) : sp;
        const port = colonIdx !== -1 ? sp.slice(colonIdx + 1) : '443';
        let auth;
        try { auth = base64ToUtf8Safe(authB64); } catch (e) { auth = ''; }
        const userColon = auth.indexOf(':');
        const username = userColon !== -1 ? auth.slice(0, userColon) : auth;
        const password = userColon !== -1 ? auth.slice(userColon + 1) : '';
        return {
          proto: 'socks5',
          name: name || (server + ':' + port),
          server: normalizeServerHost(server),
          port: parseInt(port) || 443,
          username: username,
          password: password
        };
      }
      const colonIdx = serverPortStr.lastIndexOf(':');
      const server = colonIdx !== -1 ? serverPortStr.slice(0, colonIdx) : serverPortStr;
      const port = colonIdx !== -1 ? serverPortStr.slice(colonIdx + 1) : '443';
      return {
        proto: 'socks5',
        name: name || (server + ':' + port),
        server: normalizeServerHost(server),
        port: parseInt(port) || 443
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ============================================================
// Local output format generators (no backend dependency)
// ============================================================

// Build a single Clash node YAML block from a parsed node
function buildClashNodeLine(n) {
  const lines = [];
  const server = normalizeServerHost(n.server);
  const host = normalizeServerHost(n.host) || server;
  const sni = normalizeServerHost(n.sni) || host;

  lines.push(`  - name: ${yq(n.name)}`);

  if (n.proto === 'vless' || n.proto === 'vmess') {
    lines.push(`    type: ${n.proto}`);
    lines.push(`    server: ${yq(server)}`);
    lines.push(`    port: ${n.port}`);
    lines.push(`    uuid: ${n.uuid}`);
    lines.push(`    udp: true`);
    if (n.flow) lines.push(`    flow: ${yq(n.flow)}`);
    lines.push(`    tls: ${n.tls ? 'true' : 'false'}`);
    lines.push(`    client-fingerprint: ${yq(n.fp || 'chrome')}`);
    if (n.aid !== undefined) lines.push(`    alter-id: ${n.aid}`);
  } else if (n.proto === 'trojan') {
    lines.push(`    type: trojan`);
    lines.push(`    server: ${yq(server)}`);
    lines.push(`    port: ${n.port}`);
    lines.push(`    password: ${yq(n.password)}`);
    lines.push(`    udp: true`);
    lines.push(`    client-fingerprint: ${yq(n.fp || 'chrome')}`);
  } else if (n.proto === 'ss') {
    lines.push(`    type: ss`);
    lines.push(`    server: ${yq(server)}`);
    lines.push(`    port: ${n.port}`);
    lines.push(`    cipher: ${n.method || 'aes-256-gcm'}`);
    lines.push(`    password: ${yq(n.password)}`);
  } else if (n.proto === 'ssr') {
    lines.push(`    type: ssr`);
    lines.push(`    server: ${yq(server)}`);
    lines.push(`    port: ${n.port}`);
    lines.push(`    cipher: ${n.method || 'aes-256-cfb'}`);
    lines.push(`    password: ${yq(n.password)}`);
    lines.push(`    protocol: ${n.protocol || 'origin'}`);
    lines.push(`    obfs: ${n.obfs || 'plain'}`);
  } else if (n.proto === 'hysteria' || n.proto === 'hysteria2') {
    lines.push(`    type: hysteria2`);
    lines.push(`    server: ${yq(server)}`);
    lines.push(`    port: ${n.port}`);
    if (n.password) lines.push(`    password: ${yq(n.password)}`);
    lines.push(`    up: ${n.up || '50'}`);
    lines.push(`    down: ${n.down || '100'}`);
    if (n.sni) lines.push(`    sni: ${yq(n.sni)}`);
    if (n.obfs) lines.push(`    obfs: ${yq(n.obfs)}`);
    if (n.obfs_password) lines.push(`    obfs-password: ${yq(n.obfs_password)}`);
  } else if (n.proto === 'socks5') {
    lines.push(`    type: socks5`);
    lines.push(`    server: ${yq(server)}`);
    lines.push(`    port: ${n.port}`);
    if (n.username) lines.push(`    username: ${yq(n.username)}`);
    if (n.password) lines.push(`    password: ${yq(n.password)}`);
    lines.push(`    udp: true`);
  } else {
    lines.push(`    type: ${n.proto}`);
    lines.push(`    server: ${yq(server)}`);
    lines.push(`    port: ${n.port}`);
  }

  if ((n.proto === 'vless' || n.proto === 'trojan') && n.tls) {
    lines.push(`    servername: ${yq(sni)}`);
    if (n.alpn && n.alpn.length) {
      lines.push(`    alpn: [${n.alpn.map(a => yq(a)).join(', ')}]`);
    }
    lines.push(`    skip-cert-verify: false`);
  }

  if (n.network === 'ws' || n.network === 'xhttp' || (n.proto === 'vmess' && n.network === 'ws')) {
    lines.push(`    network: ws`);
    lines.push(`    ws-opts:`);
    lines.push(`      path: ${yq(n.path || '/')}`);
    lines.push(`      headers:`);
    lines.push(`        Host: ${yq(host)}`);
  } else if (n.network === 'grpc') {
    lines.push(`    network: grpc`);
    lines.push(`    grpc-opts:`);
    lines.push(`      grpc-service-name: ${yq(n.path || '')}`);
  }

  return lines.join('\n');
}

// Clash proxy group helper: group references + all node names
function clashSelectProxies(names, opts = {}) {
  const { directFirst = false, extraGroups = [] } = opts;
  const nodeLines = names.length
    ? names.map(n => `      - ${yq(n)}`).join('\n')
    : '      - DIRECT';
  const lines = [];
  if (directFirst) {
    lines.push('      - "🎯 全球直连"', '      - "🚀 节点选择"');
  } else {
    lines.push('      - "🚀 节点选择"', '      - "🎯 全球直连"');
  }
  for (const g of extraGroups) lines.push(`      - ${yq(g)}`);
  lines.push(nodeLines);
  return lines.join('\n');
}

// Generate full Clash YAML config with DNS, rules, and proxy groups
function generateClashYaml(links) {
  const nodes = links.map(parseProxyLink).filter(n => n !== null);
  const names = nodes.map(n => n.name);
  if (nodes.length === 0) return 'proxies: []';

  const dnsServer = 'https://223.5.5.5/dns-query';

  const head = [
    'mixed-port: 7890',
    'allow-lan: true',
    'mode: rule',
    'log-level: info',
    'ipv6: true',
    'external-controller: 127.0.0.1:9090',
    'unified-delay: true',
    'tcp-concurrent: true',
    'geodata-mode: true',
    'geo-auto-update: true',
    'geo-update-interval: 24',
    'geox-url:',
    '  geoip: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"',
    '  geosite: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"',
    '  mmdb: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb"',
    '  asn: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb"',
    'sniffer:',
    '  enable: true',
    '  force-dns-mapping: true',
    '  parse-pure-ip: true',
    '  sniff:',
    '    HTTP:',
    '      ports: [80, 8080-8880]',
    '      override-destination: true',
    '    TLS:',
    '      ports: [443, 8443]',
    '    QUIC:',
    '      ports: [443, 8443]',
    'dns:',
    '  enable: true',
    '  listen: 0.0.0.0:1053',
    '  ipv6: true',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
    '  fake-ip-filter:',
    '    - "*.lan"',
    '    - "+.local"',
    '    - "+.market.xiaomi.com"',
    '    - "+.msftconnecttest.com"',
    '    - "+.msftncsi.com"',
    '    - "localhost.ptlogin2.qq.com"',
    '    - "+.srv.nintendo.net"',
    '    - "+.stun.playstation.net"',
    '    - "+.xboxlive.com"',
    '  default-nameserver:',
    '    - 223.5.5.5',
    '    - 119.29.29.29',
    '  nameserver:',
    `    - ${dnsServer}`,
    '    - https://119.29.29.29/dns-query',
    '  fallback:',
    '    - https://1.1.1.1/dns-query',
    '    - https://8.8.8.8/dns-query',
    '  fallback-filter:',
    '    geoip: true',
    '    geoip-code: CN',
    '    ipcidr:',
    '      - 240.0.0.0/4',
    ''
  ];

  const proxiesBlock = ['proxies:'];
  for (const n of nodes) {
    proxiesBlock.push(buildClashNodeLine(n));
  }

  const nodeOnly = names.length ? names.map(n => `      - ${yq(n)}`).join('\n') : '      - DIRECT';
  const proxyGroups = [
    'proxy-groups:',
    '  - name: "🚀 节点选择"',
    '    type: select',
    '    proxies:',
    '      - "🎯 全球直连"',
    nodeOnly,
    '  - name: "🌍 国外媒体"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names),
    '  - name: "📺 哔哩哔哩"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names, { directFirst: true }),
    '  - name: "📹 油管视频"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names, { extraGroups: ['🌍 国外媒体'] }),
    '  - name: "🎬 奈飞视频"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names, { extraGroups: ['🌍 国外媒体'] }),
    '  - name: "📲 电报信息"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names),
    '  - name: "🌐 谷歌服务"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names),
    '  - name: "🤖 OpenAI"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names),
    '  - name: "Ⓜ️ 微软服务"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names, { directFirst: true }),
    '  - name: "🍎 苹果服务"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names, { directFirst: true }),
    '  - name: "🎯 全球直连"',
    '    type: select',
    '    proxies:',
    '      - DIRECT',
    '  - name: "🛑 全球拦截"',
    '    type: select',
    '    proxies:',
    '      - REJECT',
    '      - DIRECT',
    '  - name: "🍃 应用净化"',
    '    type: select',
    '    proxies:',
    '      - REJECT',
    '      - DIRECT',
    '  - name: "🐟 漏网之鱼"',
    '    type: select',
    '    proxies:',
    clashSelectProxies(names),
    ''
  ];

  // Loyalsoldier rule-providers (CDN: jsDelivr)
  const RP_BASE = 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release';
  const provider = (name, behavior) => [
    `  ${name}:`,
    '    type: http',
    `    behavior: ${behavior}`,
    `    url: "${RP_BASE}/${name}.txt"`,
    `    path: ./rulesets/loyalsoldier/${name}.txt`,
    '    interval: 86400'
  ].join('\n');

  const ruleProviders = [
    'rule-providers:',
    provider('reject', 'domain'),
    provider('icloud', 'domain'),
    provider('apple', 'domain'),
    provider('google', 'domain'),
    provider('proxy', 'domain'),
    provider('direct', 'domain'),
    provider('private', 'domain'),
    provider('gfw', 'domain'),
    provider('greatfire', 'domain'),
    provider('tld-not-cn', 'domain'),
    provider('telegramcidr', 'ipcidr'),
    provider('cncidr', 'ipcidr'),
    provider('lancidr', 'ipcidr'),
    provider('applications', 'classical'),
    ''
  ];

  const rules = [
    'rules:',
    '  - DOMAIN-SUFFIX,acl4.ssr,🎯 全球直连',
    '  - DOMAIN-SUFFIX,local,🎯 全球直连',
    '  - DOMAIN,clash.razord.top,🎯 全球直连',
    '  - DOMAIN,yacd.haishan.me,🎯 全球直连',
    '  - DOMAIN,yacd.metacubex.one,🎯 全球直连',
    '  - DOMAIN,d.metacubex.one,🎯 全球直连',
    '  - DOMAIN-SUFFIX,googleapis.cn,🌐 谷歌服务',
    '  - DOMAIN-SUFFIX,gstatic.com,🌐 谷歌服务',
    '  - DOMAIN-SUFFIX,xn--ngstr-lra8j.com,🌐 谷歌服务',
    '  - DOMAIN-SUFFIX,googlevideo.com,📹 油管视频',
    '  - DOMAIN-SUFFIX,googleusercontent.com,🌐 谷歌服务',
    '  - DOMAIN-KEYWORD,youtube,📹 油管视频',
    '  - DOMAIN-SUFFIX,youtube.com,📹 油管视频',
    '  - DOMAIN-SUFFIX,youtu.be,📹 油管视频',
    '  - DOMAIN-KEYWORD,netflix,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,nflxext.com,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,nflxso.net,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,nflxvideo.net,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,nflximg.com,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,nflximg.net,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,netflix.com,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,netflix.net,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,bilibili.com,📺 哔哩哔哩',
    '  - DOMAIN-SUFFIX,bilivideo.com,📺 哔哩哔哩',
    '  - DOMAIN-SUFFIX,hdslb.com,📺 哔哩哔哩',
    '  - DOMAIN-KEYWORD,openai,🤖 OpenAI',
    '  - DOMAIN-KEYWORD,chatgpt,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,openai.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,chatgpt.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,oaistatic.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,oaiusercontent.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,anthropic.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,claude.ai,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,perplexity.ai,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,gemini.google.com,🤖 OpenAI',
    '  - RULE-SET,applications,🎯 全球直连',
    '  - RULE-SET,private,🎯 全球直连',
    '  - RULE-SET,reject,🛑 全球拦截',
    '  - RULE-SET,icloud,🍎 苹果服务',
    '  - RULE-SET,apple,🍎 苹果服务',
    '  - RULE-SET,google,🌐 谷歌服务',
    '  - RULE-SET,proxy,🚀 节点选择',
    '  - RULE-SET,gfw,🚀 节点选择',
    '  - RULE-SET,greatfire,🚀 节点选择',
    '  - RULE-SET,tld-not-cn,🚀 节点选择',
    '  - RULE-SET,direct,🎯 全球直连',
    '  - RULE-SET,lancidr,🎯 全球直连,no-resolve',
    '  - RULE-SET,cncidr,🎯 全球直连,no-resolve',
    '  - RULE-SET,telegramcidr,📲 电报信息,no-resolve',
    '  - GEOIP,LAN,🎯 全球直连,no-resolve',
    '  - GEOIP,CN,🎯 全球直连,no-resolve',
    '  - MATCH,🐟 漏网之鱼'
  ];

  return [
    head.join('\n'),
    proxiesBlock.join('\n'),
    '',
    proxyGroups.join('\n'),
    ruleProviders.join('\n'),
    rules.join('\n'),
    ''
  ].join('\n');
}

// Generate Surge INI ([Proxy] section only)
function generateSurgeIni(links) {
  const nodes = links.map(parseProxyLink).filter(n => n !== null);
  const names = nodes.map(n => n.name);
  const lines = [
    '[General]',
    'loglevel = notify',
    'internet-test-url = http://www.apple.com/library/test/success.html',
    'proxy-test-url = http://www.gstatic.com/generate_204',
    'test-timeout = 3',
    'dns-server = 223.5.5.5, 119.29.29.29, system',
    'encrypted-dns-server = https://223.5.5.5/dns-query, https://1.12.12.12/dns-query',
    'ipv6 = true',
    'allow-wifi-access = false',
    'wifi-access-http-port = 6152',
    'wifi-access-socks5-port = 6153',
    'skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local, captive.apple.com',
    'exclude-simple-hostnames = true',
    'show-error-page-for-reject = true',
    '',
    '[Proxy]'
  ];
  if (nodes.length === 0) {
    lines.push('Direct = direct');
  } else {
    for (const n of nodes) {
      if (n.proto === 'vless') {
        const parts = [`${n.name} = vless`, `${n.server}`, `${n.port}`, `uuid=${n.uuid}`, `flow=${n.flow || 'none'}`, `tls=${n.tls ? 'true' : 'false'}`, `ws=true`, `ws-path=${n.path || '/'}`, `ws-host=${n.host || n.server}`];
        if (n.tls) parts.push(`sni=${n.sni || n.host || n.server}`);
        lines.push(parts.join(', '));
      } else if (n.proto === 'trojan') {
        lines.push(`${n.name} = trojan, ${n.server}, ${n.port}, password=${n.password}, sni=${n.sni || n.host || n.server}, ws=true, ws-path=${n.path || '/'}, ws-headers=Host:${n.host || n.server}, skip-cert-verify=false, tfo=true`);
      } else if (n.proto === 'vmess') {
        lines.push(`${n.name} = vmess, ${n.server}, ${n.port}, username=${n.uuid}, ws=true, ws-path=${n.path || '/'}, ws-headers=Host:${n.host || n.server}, over-tls=${n.tls ? 'true' : 'false'}`);
      } else if (n.proto === 'ss') {
        lines.push(`${n.name} = ss, ${n.server}, ${n.port}, encrypt-method=${n.method || 'aes-256-gcm'}, password=${n.password}`);
      } else if (n.proto === 'ssr') {
        lines.push(`${n.name} = ssr, ${n.server}, ${n.port}, protocol=${n.protocol || 'origin'}, protocol-param=, obfs=${n.obfs || 'plain'}, obfs-host=, encrypt-method=${n.method || 'aes-256-cfb'}, password=${n.password}`);
      } else if (n.proto === 'socks5') {
        lines.push(`${n.name} = socks5, ${n.server}, ${n.port}${n.username ? ', username=' + n.username : ''}${n.password ? ', password=' + n.password : ''}`);
      }
    }
  }
  lines.push('');
  lines.push('[Proxy Group]');
  const list = names.length ? names.join(', ') : 'DIRECT';
  lines.push(`🚀 节点选择 = select, 🎯 全球直连, ${list}`);
  lines.push(`🌍 国外媒体 = select, ${iniPolicyList(names)}`);
  lines.push(`📺 哔哩哔哩 = select, ${iniPolicyList(names, { directFirst: true })}`);
  lines.push(`📹 油管视频 = select, ${iniPolicyList(names, { extraGroups: ['🌍 国外媒体'] })}`);
  lines.push(`🎬 奈飞视频 = select, ${iniPolicyList(names, { extraGroups: ['🌍 国外媒体'] })}`);
  lines.push(`📲 电报信息 = select, ${iniPolicyList(names)}`);
  lines.push(`🌐 谷歌服务 = select, ${iniPolicyList(names)}`);
  lines.push(`🤖 OpenAI = select, ${iniPolicyList(names)}`);
  lines.push(`Ⓜ️ 微软服务 = select, ${iniPolicyList(names, { directFirst: true })}`);
  lines.push(`🍎 苹果服务 = select, ${iniPolicyList(names, { directFirst: true })}`);
  lines.push(`🎯 全球直连 = select, DIRECT`);
  lines.push(`🛑 全球拦截 = select, REJECT, DIRECT`);
  lines.push(`🐟 漏网之鱼 = select, ${iniPolicyList(names)}`);
  lines.push('');
  lines.push('[Rule]');
  lines.push(`RULE-SET,${aclRule('LocalAreaNetwork')},🎯 全球直连`);
  lines.push(`RULE-SET,${aclRule('UnBan')},🎯 全球直连`);
  lines.push(`RULE-SET,${aclRule('BanAD')},🛑 全球拦截`);
  lines.push(`RULE-SET,${aclRule('BanProgramAD')},🛑 全球拦截`);
  lines.push(`RULE-SET,${aclRule('GoogleFCM')},🌐 谷歌服务`);
  lines.push(`RULE-SET,${aclRule('GoogleCN')},🎯 全球直连`);
  lines.push(`RULE-SET,${aclRule('SteamCN')},🎯 全球直连`);
  lines.push(`RULE-SET,${aclRule('Microsoft')},Ⓜ️ 微软服务`);
  lines.push(`RULE-SET,${aclRule('Apple')},🍎 苹果服务`);
  lines.push(`RULE-SET,${aclRule('Telegram')},📲 电报信息`);
  lines.push(`RULE-SET,${aclRule('OpenAi')},🤖 OpenAI`);
  lines.push(`RULE-SET,${aclRule('Claude')},🤖 OpenAI`);
  lines.push(`RULE-SET,${aclRule('Copilot')},🤖 OpenAI`);
  lines.push(`RULE-SET,${aclRule('Netflix')},🌍 国外媒体`);
  lines.push(`RULE-SET,${aclRule('YouTube')},🌍 国外媒体`);
  lines.push(`RULE-SET,${aclRule('Disney')},🌍 国外媒体`);
  lines.push(`RULE-SET,${aclRule('Spotify')},🌍 国外媒体`);
  lines.push(`RULE-SET,${aclRule('TikTok')},🌍 国外媒体`);
  lines.push(`RULE-SET,${aclRule('BiliBili')},📺 哔哩哔哩`);
  lines.push(`RULE-SET,${aclRule('ProxyMedia')},🌍 国外媒体`);
  lines.push(`RULE-SET,${aclRule('ProxyGFWlist')},🚀 节点选择`);
  lines.push(`RULE-SET,${aclRule('ChinaDomain')},🎯 全球直连`);
  lines.push(`RULE-SET,${aclRule('ChinaCompanyIp')},🎯 全球直连`);
  lines.push(`RULE-SET,${aclRule('ChinaIp')},🎯 全球直连`);
  lines.push('GEOIP,CN,🎯 全球直连');
  lines.push('FINAL,🐟 漏网之鱼,dns-failed');
  return lines.join('\n');
}

// ACL4SSR rule base URL (for Surge/Loon remote rules)
const ACL_BASE = 'https://fastly.jsdelivr.net/gh/ACL4SSR/ACL4SSR@master/Clash';
const aclRule = (name) => `${ACL_BASE}/${name}.list`;

// Surge/Loon policy group list helper
function iniPolicyList(names, opts = {}) {
  const { directFirst = false, extraGroups = [], compact = false } = opts;
  const sep = compact ? ',' : ', ';
  const list = names.length ? names.join(sep) : 'DIRECT';
  const parts = [];
  if (directFirst) parts.push('🎯 全球直连', '🚀 节点选择');
  else parts.push('🚀 节点选择', '🎯 全球直连');
  parts.push(...extraGroups);
  if (names.length) parts.push(list);
  return parts.join(sep);
}

// Generate Loon config (full config with General/Proxy/Proxy Group/Remote Rule/Rule)
function generateLoonIni(links) {
  const nodes = links.map(parseProxyLink).filter(n => n !== null);
  const names = nodes.map(n => n.name);
  const lines = [
    '[General]',
    'ip-mode = dual',
    'dns-server = 223.5.5.5,119.29.29.29,system',
    'doh-server = https://223.5.5.5/dns-query, https://1.12.12.12/dns-query',
    'allow-udp-proxy = true',
    'allow-wifi-access = false',
    'sni-sniffing = true',
    'skip-proxy = 127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local,captive.apple.com',
    'bypass-tun = 10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.0.2.0/24,192.88.99.0/24,192.168.0.0/16,198.51.100.0/24,203.0.113.0/24,224.0.0.0/4,255.255.255.255/32',
    '',
    '[Proxy]'
  ];
  for (const n of nodes) {
    if (n.proto === 'vless') {
      const parts = [`${n.name} = vless`, `${n.server}`, `${n.port}`, `udp=true`, `username=${n.uuid}`, `transport=${n.network || 'ws'}`, `path=${n.path || '/'}`, `host=${n.host || n.server}`, `over-tls=${n.tls ? 'true' : 'false'}`];
      if (n.tls) {
        parts.push(`tls-name=${n.sni || n.host || n.server}`);
        if (n.alpn && n.alpn.length) parts.push(`alpn=${n.alpn.join(':')}`);
        parts.push(`skip-cert-verify=false`);
      }
      lines.push(parts.join(','));
    } else if (n.proto === 'trojan') {
      const parts = [`${n.name} = trojan`, `${n.server}`, `${n.port}`, `password=${n.password}`, `transport=ws`, `path=${n.path || '/'}`, `host=${n.host || n.server}`, `over-tls=true`, `tls-name=${n.sni || n.host || n.server}`];
      if (n.alpn && n.alpn.length) parts.push(`alpn=${n.alpn.join(':')}`);
      parts.push(`skip-cert-verify=false`);
      lines.push(parts.join(','));
    } else if (n.proto === 'vmess') {
      const parts = [`${n.name} = vmess`, `${n.server}`, `${n.port}`, `username=${n.uuid}`, `transport=${n.network || 'ws'}`, `path=${n.path || '/'}`, `host=${n.host || n.server}`, `over-tls=${n.tls ? 'true' : 'false'}`];
      if (n.tls) {
        parts.push(`tls-name=${n.sni || n.host || n.server}`);
        if (n.alpn && n.alpn.length) parts.push(`alpn=${n.alpn.join(':')}`);
        parts.push(`skip-cert-verify=false`);
      }
      lines.push(parts.join(','));
    } else if (n.proto === 'ss') {
      lines.push(`${n.name} = ss,${n.server},${n.port},encrypt-method=${n.method || 'aes-256-gcm'},password=${n.password}${n.plugin ? ',plugin=' + n.plugin : ''}`);
    } else if (n.proto === 'ssr') {
      lines.push(`${n.name} = ssr,${n.server},${n.port},protocol=${n.protocol || 'origin'},protocol-param=,obfs=${n.obfs || 'plain'},obfs-host=,encrypt-method=${n.method || 'aes-256-cfb'},password=${n.password}`);
    } else if (n.proto === 'socks5') {
      lines.push(`${n.name} = socks5,${n.server},${n.port}${n.username ? ',username=' + n.username : ''}${n.password ? ',password=' + n.password : ''}`);
    }
  }
  lines.push('');
  lines.push('[Proxy Group]');
  const list = names.length ? names.join(',') : 'DIRECT';
  lines.push(`🚀 节点选择 = select,🎯 全球直连,${list}`);
  lines.push(`🌍 国外媒体 = select,${iniPolicyList(names, { compact: true })}`);
  lines.push(`📺 哔哩哔哩 = select,${iniPolicyList(names, { directFirst: true, compact: true })}`);
  lines.push(`📹 油管视频 = select,${iniPolicyList(names, { extraGroups: ['🌍 国外媒体'], compact: true })}`);
  lines.push(`🎬 奈飞视频 = select,${iniPolicyList(names, { extraGroups: ['🌍 国外媒体'], compact: true })}`);
  lines.push(`📲 电报信息 = select,${iniPolicyList(names, { compact: true })}`);
  lines.push(`🌐 谷歌服务 = select,${iniPolicyList(names, { compact: true })}`);
  lines.push(`🤖 OpenAI = select,${iniPolicyList(names, { compact: true })}`);
  lines.push(`Ⓜ️ 微软服务 = select,${iniPolicyList(names, { directFirst: true, compact: true })}`);
  lines.push(`🍎 苹果服务 = select,${iniPolicyList(names, { directFirst: true, compact: true })}`);
  lines.push(`🎯 全球直连 = select,DIRECT`);
  lines.push(`🛑 全球拦截 = select,REJECT,DIRECT`);
  lines.push(`🐟 漏网之鱼 = select,${iniPolicyList(names, { compact: true })}`);
  lines.push('');
  lines.push('[Remote Rule]');
  lines.push(`${aclRule('LocalAreaNetwork')}, policy=🎯 全球直连, tag=局域网, enabled=true`);
  lines.push(`${aclRule('BanAD')}, policy=🛑 全球拦截, tag=广告拦截, enabled=true`);
  lines.push(`${aclRule('BanProgramAD')}, policy=🛑 全球拦截, tag=应用广告, enabled=true`);
  lines.push(`${aclRule('GoogleCN')}, policy=🎯 全球直连, tag=GoogleCN, enabled=true`);
  lines.push(`${aclRule('SteamCN')}, policy=🎯 全球直连, tag=SteamCN, enabled=true`);
  lines.push(`${aclRule('Microsoft')}, policy=Ⓜ️ 微软服务, tag=微软, enabled=true`);
  lines.push(`${aclRule('Apple')}, policy=🍎 苹果服务, tag=苹果, enabled=true`);
  lines.push(`${aclRule('Telegram')}, policy=📲 电报信息, tag=电报, enabled=true`);
  lines.push(`${aclRule('OpenAi')}, policy=🤖 OpenAI, tag=OpenAI, enabled=true`);
  lines.push(`${aclRule('Netflix')}, policy=🌍 国外媒体, tag=Netflix, enabled=true`);
  lines.push(`${aclRule('YouTube')}, policy=🌍 国外媒体, tag=YouTube, enabled=true`);
  lines.push(`${aclRule('Disney')}, policy=🌍 国外媒体, tag=Disney, enabled=true`);
  lines.push(`${aclRule('Spotify')}, policy=🌍 国外媒体, tag=Spotify, enabled=true`);
  lines.push(`${aclRule('TikTok')}, policy=🌍 国外媒体, tag=TikTok, enabled=true`);
  lines.push(`${aclRule('BiliBili')}, policy=📺 哔哩哔哩, tag=哔哩哔哩, enabled=true`);
  lines.push(`${aclRule('ProxyMedia')}, policy=🌍 国外媒体, tag=代理媒体, enabled=true`);
  lines.push(`${aclRule('ProxyGFWlist')}, policy=🚀 节点选择, tag=代理列表, enabled=true`);
  lines.push(`${aclRule('ChinaDomain')}, policy=🎯 全球直连, tag=中国域名, enabled=true`);
  lines.push(`${aclRule('ChinaIp')}, policy=🎯 全球直连, tag=中国IP, enabled=true`);
  lines.push('');
  lines.push('[Rule]');
  lines.push('GEOIP,CN,🎯 全球直连');
  lines.push('FINAL,🐟 漏网之鱼');
  return lines.join('\n');
}

// Generate Quantumult X config ([server_local] section only)
function generateQuanxConf(links) {
  const nodes = links.map(parseProxyLink).filter(n => n !== null);
  const names = nodes.map(n => n.name);
  const QX_BASE = 'https://fastly.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/QuantumultX';
  const lines = [
    '[general]',
    'network_check_url=http://www.gstatic.com/generate_204',
    'server_check_url=http://www.gstatic.com/generate_204',
    'profile_img_url=https://fastly.jsdelivr.net/gh/byJoey/cfnew@main/snippets/logo.png',
    'dns_exclusion_list=*.cmpassport.com, *.jegotrip.com.cn, *.icloud.com, *.icloud.com.cn, *.apple.com, *.weibo.com, *.qq.com',
    'running_mode_trigger=filter',
    '',
    '[dns]',
    'server=223.5.5.5',
    'server=119.29.29.29',
    'server=https://223.5.5.5/dns-query',
    'server=https://1.12.12.12/dns-query',
    '',
    '[server_local]'
  ];
  if (nodes.length === 0) return lines.join('\n');
  for (const n of nodes) {
    if (n.proto === 'vless') {
      const parts = [`${n.server}:${n.port}`, `method=none`, `password=${n.uuid}`, `obfs=${n.tls ? 'wss' : 'ws'}`, `obfs-host=${n.host || n.server}`, `obfs-uri=${n.path || '/'}`];
      if (n.tls) parts.push(`tls-verification=true`, `tls13=true`);
      parts.push(`tag=${n.name}`);
      lines.push(`vless=${parts.join(', ')}`);
    } else if (n.proto === 'trojan') {
      const parts = [`${n.server}:${n.port}`, `password=${n.password}`, `over-tls=true`, `tls-host=${n.sni || n.host || n.server}`, `obfs=wss`, `obfs-host=${n.host || n.server}`, `obfs-uri=${n.path || '/'}`, `tls-verification=true`, `tag=${n.name}`];
      lines.push(`trojan=${parts.join(', ')}`);
    } else if (n.proto === 'vmess') {
      const parts = [`${n.server}:${n.port}`, `method=${n.encryption || 'none'}`, `password=${n.uuid}`, `obfs=${n.tls ? 'wss' : 'ws'}`, `obfs-host=${n.host || n.server}`, `obfs-uri=${n.path || '/'}`];
      if (n.tls) parts.push(`tls-verification=true`, `tls13=true`);
      parts.push(`tag=${n.name}`);
      lines.push(`vmess=${parts.join(', ')}`);
    } else if (n.proto === 'ss') {
      lines.push(`shadowsocks=${n.server}:${n.port}, method=${n.method || 'aes-256-gcm'}, password=${n.password}, tag=${n.name}`);
    } else if (n.proto === 'ssr') {
      lines.push(`shadowsocks=${n.server}:${n.port}, method=${n.method || 'aes-256-cfb'}, password=${n.password}, protocol=${n.protocol || 'origin'}, obfs=${n.obfs || 'plain'}, tag=${n.name}`);
    }
  }
  lines.push('');
  lines.push('[policy]');
  const list = names.length ? names.join(', ') : 'direct';
  lines.push(`static=🚀 节点选择, ${list}, direct, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Proxy.png`);
  lines.push(`static=🌍 国外媒体, ${iniPolicyList(names)}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/ForeignMedia.png`);
  lines.push(`static=📺 哔哩哔哩, ${iniPolicyList(names, { directFirst: true })}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/bilibili.png`);
  lines.push(`static=📹 油管视频, ${iniPolicyList(names, { extraGroups: ['🌍 国外媒体'] })}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/YouTube.png`);
  lines.push(`static=🎬 奈飞视频, ${iniPolicyList(names, { extraGroups: ['🌍 国外媒体'] })}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Netflix.png`);
  lines.push(`static=📲 电报信息, ${iniPolicyList(names)}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Telegram.png`);
  lines.push(`static=🌐 谷歌服务, ${iniPolicyList(names)}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Google.png`);
  lines.push(`static=🤖 OpenAI, ${iniPolicyList(names)}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/ChatGPT.png`);
  lines.push(`static=Ⓜ️ 微软服务, ${iniPolicyList(names, { directFirst: true })}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Microsoft.png`);
  lines.push(`static=🍎 苹果服务, ${iniPolicyList(names, { directFirst: true })}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Apple.png`);
  lines.push(`static=🎯 全球直连, direct, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Direct.png`);
  lines.push(`static=🛑 全球拦截, reject, direct, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Advertising.png`);
  lines.push(`static=🐟 漏网之鱼, ${iniPolicyList(names)}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Final.png`);
  lines.push('');
  lines.push('[filter_remote]');
  lines.push(`${QX_BASE}/Lan/Lan.list, tag=局域网, force-policy=🎯 全球直连, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Advertising/Advertising.list, tag=广告拦截, force-policy=🛑 全球拦截, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Microsoft/Microsoft.list, tag=微软, force-policy=Ⓜ️ 微软服务, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Apple/Apple.list, tag=苹果, force-policy=🍎 苹果服务, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Telegram/Telegram.list, tag=电报, force-policy=📲 电报信息, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Google/Google.list, tag=谷歌, force-policy=🌐 谷歌服务, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/OpenAI/OpenAI.list, tag=OpenAI, force-policy=🤖 OpenAI, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Claude/Claude.list, tag=Claude, force-policy=🤖 OpenAI, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/YouTube/YouTube.list, tag=YouTube, force-policy=🌍 国外媒体, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Netflix/Netflix.list, tag=Netflix, force-policy=🌍 国外媒体, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Disney/Disney.list, tag=Disney, force-policy=🌍 国外媒体, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Spotify/Spotify.list, tag=Spotify, force-policy=🌍 国外媒体, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/TikTok/TikTok.list, tag=TikTok, force-policy=🌍 国外媒体, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/BiliBili/BiliBili.list, tag=哔哩哔哩, force-policy=📺 哔哩哔哩, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/Global/Global.list, tag=全球加速, force-policy=🚀 节点选择, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push(`${QX_BASE}/ChinaMax/ChinaMax.list, tag=中国直连, force-policy=🎯 全球直连, update-interval=86400, opt-parser=false, enabled=true`);
  lines.push('');
  lines.push('[filter_local]');
  lines.push('geoip, cn, 🎯 全球直连');
  lines.push('final, 🐟 漏网之鱼');
  return lines.join('\n');
}

// Generate full Sing-box JSON config with DNS, inbounds, route, and experimental
function generateSingBoxJson(links) {
  const nodes = links.map(parseProxyLink).filter(n => n !== null);
  const outboundTags = nodes.map(n => n.name);
  const dnsServer = 'https://223.5.5.5/dns-query';

  const SRS_BASE_SITE = 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite';
  const SRS_BASE_IP = 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geoip';
  const siteRule = (tag) => ({ tag: `geosite-${tag}`, type: 'remote', format: 'binary', url: `${SRS_BASE_SITE}/${tag}.srs`, download_detour: 'direct' });
  const ipRule = (tag) => ({ tag: `geoip-${tag}`, type: 'remote', format: 'binary', url: `${SRS_BASE_IP}/${tag}.srs`, download_detour: 'direct' });

  // Build node outbounds (all protocols)
  const nodeOutbounds = [];
  for (const n of nodes) {
    const out = { tag: n.name, server: normalizeServerHost(n.server), server_port: n.port };
    if (n.proto === 'vless') {
      out.type = 'vless';
      out.uuid = n.uuid;
      if (n.flow) out.flow = n.flow;
    } else if (n.proto === 'trojan') {
      out.type = 'trojan';
      out.password = n.password;
    } else if (n.proto === 'vmess') {
      out.type = 'vmess';
      out.uuid = n.uuid;
      out.alter_id = n.aid || 0;
      out.security = n.encryption || 'auto';
    } else if (n.proto === 'ss') {
      out.type = 'shadowsocks';
      out.method = n.method || 'aes-256-gcm';
      out.password = n.password;
    } else if (n.proto === 'ssr') {
      out.type = 'shadowsocksr';
      out.method = n.method || 'aes-256-cfb';
      out.password = n.password;
    } else {
      out.type = n.proto;
    }

    if ((n.proto === 'vless' || n.proto === 'trojan') && n.tls) {
      out.tls = { enabled: true, server_name: n.sni || n.host || n.server, insecure: false };
      if (n.fp) out.tls.utls = { enabled: true, fingerprint: n.fp };
      if (n.alpn && n.alpn.length) out.tls.alpn = n.alpn;
    }

    if (n.network === 'ws' || (n.proto === 'vmess' && n.network === 'ws')) {
      out.transport = { type: 'ws', path: n.path || '/', headers: { Host: n.host || n.server } };
    } else if (n.network === 'grpc') {
      out.transport = { type: 'grpc', service_name: n.path || '' };
    }

    nodeOutbounds.push(out);
  }

  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: dnsServer, detour: 'select' },
        { tag: 'local', address: '223.5.5.5', detour: 'direct' },
        { tag: 'fakeip', address: 'fakeip' },
        { tag: 'block', address: 'rcode://success' }
      ],
      rules: [
        { outbound: 'any', server: 'local' },
        { rule_set: 'geosite-category-ads-all', server: 'block' },
        { rule_set: 'geosite-cn', server: 'local' },
        { query_type: ['A', 'AAAA'], server: 'fakeip' }
      ],
      fakeip: { enabled: true, inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' },
      independent_cache: true,
      strategy: 'ipv4_only'
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 2080,
        sniff: true,
        sniff_override_destination: true
      },
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'sing-box',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: 'mixed',
        sniff: true,
        sniff_override_destination: true
      }
    ],
    outbounds: [
      { type: 'selector', tag: 'select', outbounds: ['direct', ...outboundTags], default: outboundTags[0] || 'direct' },
      { type: 'selector', tag: '🌍 国外媒体', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: '📲 电报信息', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🌐 谷歌服务', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🤖 OpenAI', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: 'Ⓜ️ 微软服务', outbounds: ['direct', 'select', ...outboundTags] },
      { type: 'selector', tag: '🍎 苹果服务', outbounds: ['direct', 'select', ...outboundTags] },
      { type: 'selector', tag: '📺 哔哩哔哩', outbounds: ['direct', 'select', ...outboundTags] },
      { type: 'selector', tag: '📹 油管视频', outbounds: ['select', '🌍 国外媒体', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🎬 奈飞视频', outbounds: ['select', '🌍 国外媒体', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🎯 全球直连', outbounds: ['direct'] },
      { type: 'selector', tag: '🐟 漏网之鱼', outbounds: ['select', 'direct', ...outboundTags] },
      ...nodeOutbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' }
    ],
    route: {
      rule_set: [
        siteRule('cn'),
        siteRule('private'),
        siteRule('apple'),
        siteRule('apple-cn'),
        siteRule('microsoft'),
        siteRule('microsoft@cn'),
        siteRule('google'),
        siteRule('telegram'),
        siteRule('openai'),
        siteRule('anthropic'),
        siteRule('youtube'),
        siteRule('netflix'),
        siteRule('disney'),
        siteRule('spotify'),
        siteRule('tiktok'),
        siteRule('twitter'),
        siteRule('facebook'),
        siteRule('github'),
        siteRule('geolocation-!cn'),
        siteRule('category-ads-all'),
        ipRule('cn'),
        ipRule('private'),
        ipRule('telegram')
      ],
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: 'geosite-category-ads-all', outbound: 'block' },
        { rule_set: 'geosite-private', outbound: 'direct' },
        { rule_set: 'geosite-apple-cn', outbound: 'direct' },
        { rule_set: 'geosite-microsoft@cn', outbound: 'direct' },
        { rule_set: 'geosite-apple', outbound: '🍎 苹果服务' },
        { rule_set: 'geosite-microsoft', outbound: 'Ⓜ️ 微软服务' },
        { rule_set: 'geosite-openai', outbound: '🤖 OpenAI' },
        { rule_set: 'geosite-anthropic', outbound: '🤖 OpenAI' },
        { rule_set: 'geosite-telegram', outbound: '📲 电报信息' },
        { rule_set: 'geoip-telegram', outbound: '📲 电报信息' },
        { rule_set: 'geosite-google', outbound: '🌐 谷歌服务' },
        { rule_set: 'geosite-youtube', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-netflix', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-disney', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-spotify', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-tiktok', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-twitter', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-facebook', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-github', outbound: 'select' },
        { rule_set: 'geosite-geolocation-!cn', outbound: 'select' },
        { rule_set: 'geosite-cn', outbound: 'direct' },
        { rule_set: 'geoip-cn', outbound: 'direct' },
        { ip_is_private: true, outbound: 'direct' }
      ],
      final: '🐟 漏网之鱼',
      auto_detect_interface: true
    },
    experimental: {
      cache_file: { enabled: true, store_fakeip: true },
      clash_api: { external_controller: '127.0.0.1:9090' }
    }
  };

  return JSON.stringify(config, null, 2);
}

// Generate Base64 encoded plain links
function generateBase64(links) {
  return utf8ToBase64(links.join('\n'));
}

// Process subscription and replace with local URLs
async function processSubscription(request, url, backend) {
  const host = getHost(request);
  const subDir = 'internal';

  // Use getFullUrl to robustly extract long/tricky url params
  const targetUrl = getFullUrl(request.url) || url.searchParams.get('url');
  const target = url.searchParams.get('target');

  // If still no targetUrl, forward to backend /sub and return its response
  if (!targetUrl) {
    try {
      const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
      const backendUrl = `${backendBase}${url.pathname}${url.search}`;
      const response = await fetch(backendUrl, {
        method: 'GET',
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
          'Accept': 'text/plain,*/*'
        },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined
      });

      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      return new Response(`Error forwarding to backend: ${e && e.message ? e.message : String(e)}`, { status: 500 });
    }
  }

  // Parse the subscription URL
  const urlParts = targetUrl.split('|').filter(p => p.trim() !== '');

  if (urlParts.length === 0) {
    return new Response('There are no valid links', { status: 400 });
  }

  // IMPORTANT: Always fetch subscription content directly first,
  // then optionally forward local cache URLs to backend for conversion.
  // This ensures fallback data is available when backend cannot reach certain URLs.
  const replacedURIs = [];
  // Accumulate replacements across all URL parts for later recovery
  const accumulatedReplacements = {};
  // Collect all obfuscated proxy links for local format conversion
  const allNodeLinks = [];

  for (const rawPart of urlParts) {
    const key = generateRandomStr(16);

    if (rawPart.startsWith('http://') || rawPart.startsWith('https://')) {
      try {
        let signal;
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
          signal = AbortSignal.timeout(30000);
        } else {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 30000);
          signal = controller.signal;
        }

        const response = await fetch(rawPart, {
          method: 'GET',
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0'
          },
          signal
        });

        if (!response.ok) continue;

        const content = await response.text();
        if (!content || content.trim().length === 0) continue;

        const parsed = parseData(content);
        
        let obfuscatedData = content;

        if (parsed.format === 'base64') {
          const links = parsed.data.split(/\r?\n/).filter(l => l.trim());
          const replacements = {};
          const out = [];
          for (const link of links) {
            const nl = replaceInUri(link, replacements, false);
            out.push(nl || link);
          }
          // Merge per-part replacements into global accumulated set
          Object.assign(accumulatedReplacements, replacements);
          // Collect obfuscated links for local format conversion
          allNodeLinks.push(...out);
          obfuscatedData = (target === 'base64') ? utf8ToBase64(out.join('\r\n')) : out.join('\r\n');
        } else if (parsed.format === 'yaml') {
          obfuscatedData = replaceYAMLContent(content, accumulatedReplacements);
        } else {
          // Unknown format - check if content is plain text proxy links
          const lines = content.split(/\r?\n/).filter(l => l.trim());
          const proxyLinks = [];
          const nonProxyLines = [];
          const proxyPattern = /^(ssr?|vmess|trojan|vless|hysteria|hysteria2|hy|socks5?):\/\//i;
          for (const line of lines) {
            const trimmed = line.trim();
            if (proxyPattern.test(trimmed)) {
              proxyLinks.push(trimmed);
            } else {
              nonProxyLines.push(line);
            }
          }
          if (proxyLinks.length > 0) {
            const replacements = {};
            const out = [];
            for (const link of proxyLinks) {
              const nl = replaceInUri(link, replacements, false);
              out.push(nl || link);
            }
            Object.assign(accumulatedReplacements, replacements);
            allNodeLinks.push(...out);
            obfuscatedData = [...out, ...nonProxyLines].join('\r\n');
          }
        }

        memoryCacheSet(key, { content: obfuscatedData });
        replacedURIs.push(`${host}/${subDir}/${key}`);
      } catch (e) {
        console.error('Fetch error:', e && e.message ? e.message : String(e));
        continue;
      }
    } else if (/^(ssr?|vmess|trojan|vless|hysteria|hysteria2|hy|socks5?):\/\//i.test(rawPart)) {
      memoryCacheSet(key, { content: rawPart });
      replacedURIs.push(`${host}/${subDir}/${key}`);
      allNodeLinks.push(rawPart);
    }
  }

  if (replacedURIs.length === 0) {
    return new Response('Error: All subscription links are invalid or returned empty content.', { 
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // If target exists: convert format.
  // Primary path: local format conversion (no external dependency).
  // Fallback: forward to external backend only when backend host differs from deployment.
  if (target) {
    // Check if BACKEND points to our own deployment (self-referencing)
    const isSelfBackend = (() => {
      try {
        const backendHost = new URL(backend).host;
        const requestHost = url.host;
        return backendHost === requestHost;
      } catch (e) { return false; }
    })();

    if (!isSelfBackend) {
      // External backend and no local links → try backend forwarding
      try {
        const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
        const backendParams = new URLSearchParams(url.searchParams);
        backendParams.set('url', targetUrl);
        let backendUrl = `${backendBase}/sub?${backendParams.toString()}`;

        const fetchOptions = {
          method: 'GET',
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
            'Accept': 'text/plain,*/*'
          },
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined
        };

        let response = await fetch(backendUrl, fetchOptions);

        // If backend can't reach original source, retry with internal cache URL
        if (!response.ok) {
          const internalUrl = replacedURIs.join('|');
          const internalParams = new URLSearchParams(url.searchParams);
          internalParams.set('url', internalUrl);
          backendUrl = `${backendBase}/sub?${internalParams.toString()}`;
          response = await fetch(backendUrl, fetchOptions);
        }

        if (response.ok) {
          let content = await response.text();

          let parsedContext = null;
          try { parsedContext = parseData(content); } catch (e) {}
          const testContent = parsedContext && parsedContext.format === 'base64' ? parsedContext.data : content;
          const backendIndicatesNoNodes = testContent.length < 200 && /no nodes were found|no valid nodes found/i.test(testContent);
          if (!backendIndicatesNoNodes) {
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

              const parsedCtx = parseData(content);
              if (parsedCtx.format === 'base64') {
                const replaced = replaceDomains(parsedCtx.data);
                content = (target === 'base64') ? utf8ToBase64(replaced) : replaced;
              } else {
                content = replaceDomains(content);
              }
            } catch (e) {
              console.error('Domain replace error:', e);
            }

            if (Object.keys(accumulatedReplacements).length > 0) {
              try {
                const recoveryRegex = new RegExp(Object.keys(accumulatedReplacements).map(escapeRegExp).join("|"), "g");
                try {
                  const decoded = base64ToUtf8Safe(content);
                  if (decoded && (decoded.includes("://") || decoded.includes("proxies:") || decoded.includes("port:"))) {
                    content = decoded.replace(recoveryRegex, (m) => accumulatedReplacements[m] || m);
                    if (target === "base64") content = utf8ToBase64(content);
                  } else {
                    content = content.replace(recoveryRegex, (m) => accumulatedReplacements[m] || m);
                  }
                } catch (e) {
                  content = content.replace(recoveryRegex, (m) => accumulatedReplacements[m] || m);
                }
              } catch (e) {}
            }

            for (const uri of replacedURIs) {
              const ck = uri.split('internal/')[1];
              memoryCacheDelete(ck);
            }

            return new Response(content, {
              status: 200,
              headers: {
                'Content-Type': response.headers.get('Content-Type') || 'text/plain',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
        }
      } catch (e) {
        console.error('Backend conversion error:', e && e.message ? e.message : String(e));
      }
    }

    // Local format conversion (primary path for self-backend, fallback for external backend)
    if (allNodeLinks.length > 0) {
      try {
        // Step 1: generate formatted output from obfuscated links
        // (parseProxyLink inside each generator handles Base64 decoding correctly)
        let localContent;
        let contentType = 'text/plain; charset=utf-8';

        switch (target.toLowerCase()) {
          case 'clash':
          case 'clashr':
          case 'stash':
          case 'meta':
          case 'clashmeta':
            localContent = generateClashYaml(allNodeLinks);
            contentType = 'text/yaml; charset=utf-8';
            break;
          case 'surge':
          case 'surge2':
          case 'surge3':
          case 'surge4':
            localContent = generateSurgeIni(allNodeLinks);
            contentType = 'text/plain; charset=utf-8';
            break;
          case 'loon':
            localContent = generateLoonIni(allNodeLinks);
            contentType = 'text/plain; charset=utf-8';
            break;
          case 'quantumult':
            // Old Quantumult format → Base64 encoded list
            localContent = generateBase64(allNodeLinks);
            break;
          case 'quanx':
          case 'quantumultx':
            localContent = generateQuanxConf(allNodeLinks);
            contentType = 'text/plain; charset=utf-8';
            break;
          case 'singbox':
          case 'sing-box':
            localContent = await generateSingBoxJson(allNodeLinks);
            contentType = 'application/json; charset=utf-8';
            break;
          case 'ss':
          case 'ssr':
          case 'v2ray':
            localContent = generateBase64(allNodeLinks);
            break;
          default:
            localContent = generateBase64(allNodeLinks);
        }

        // Step 2: recover original server/uuid/password from generated output
        // (values appear as plain text in the generated format, so text-level replace works)
        if (Object.keys(accumulatedReplacements).length > 0) {
          const recoveryRegex = new RegExp(
            Object.keys(accumulatedReplacements).map(escapeRegExp).join("|"), "g"
          );
          if (target.toLowerCase() === 'base64' || target.toLowerCase() === 'ss' || target.toLowerCase() === 'ssr' || target.toLowerCase() === 'v2ray') {
            // Base64 output → decode, recover, re-encode
            try {
              const decoded = base64ToUtf8Safe(localContent);
              if (decoded && (decoded.includes("://") || decoded.includes("proxies:"))) {
                localContent = utf8ToBase64(
                  decoded.replace(recoveryRegex, (m) => accumulatedReplacements[m] || m)
                );
              }
            } catch (e) {}
          } else {
            // Plain text output (Clash YAML, Surge INI, QuanX, Sing-box JSON)
            localContent = localContent.replace(recoveryRegex, (m) => accumulatedReplacements[m] || m);
          }
        }

        // Clean up memoryCache
        for (const uri of replacedURIs) {
          const ck = uri.split('internal/')[1];
          memoryCacheDelete(ck);
        }

        return new Response(localContent, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        console.error('Local format conversion error:', e && e.message ? e.message : String(e));
        // Fall through to assemble from local cache
      }
    }
  }

  // No target OR conversion failed → assemble from local cache as plain text
  const assembled = [];
  const keysToDelete = [];
  for (const k of replacedURIs) {
    try {
      const cacheKey = k.split('internal/')[1];
      const value = memoryCache.get(cacheKey);
      if (value && value.content) {
        assembled.push(value.content);
        keysToDelete.push(cacheKey);
      }
    } catch (e) {
      continue;
    }
  }

  if (assembled.length > 0) {
    for (const kk of keysToDelete) {
      memoryCacheDelete(kk);
    }

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

  // Internal cache endpoint - serves cached obfuscated content for backend conversion
  if (url.pathname.startsWith('/internal/')) {
    const key = url.pathname.split('/internal/').pop() || '';
    if (key) {
      const value = memoryCache.get(key);
      if (value && value.content) {
        return new Response(value.content, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }
    return new Response('Not found', { status: 404 });
  }

  // Subscription conversion endpoint
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not found', { status: 404 });
}
