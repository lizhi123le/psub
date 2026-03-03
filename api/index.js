// api/index.js
// Adapted for Vercel Edge / Serverless deployment (fixed kvGet calls and robustness)

const localCache = new Map();

function generateRandomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function generateRandomUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == "x" ? r : (r & 3) | 8;
    return v.toString(16);
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function urlSafeBase64Encode(input) {
  return utf8ToBase64(input);
}

function urlSafeBase64Decode(input) {
  try {
    return base64ToUtf8Safe(input);
  } catch (e) {
    return input;
  }
}

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

function parseData(data) {
  if (data.includes("proxies:")) return { format: "yaml", data: data };
  try {
    const decoded = urlSafeBase64Decode(data.trim());
    if (decoded.includes("://") || decoded.includes("proxies:")) return { format: "base64", data: decoded };
  } catch (e) {}
  return { format: "unknown", data: data };
}

function replaceInUri(link, replacements, isRecovery) {
  if (link.startsWith("ss://")) return replaceSS(link, replacements, isRecovery);
  if (link.startsWith("ssr://")) return replaceSSR(link, replacements, isRecovery);
  if (link.startsWith("vmess://")) return replaceVmess(link, replacements, isRecovery);
  if (link.startsWith("trojan://") || link.startsWith("vless://")) return replaceTrojan(link, replacements, isRecovery);
  if (link.startsWith("hysteria://")) return replaceHysteria(link, replacements, isRecovery);
  if (link.startsWith("hysteria2://")) return replaceHysteria2(link, replacements, isRecovery);
  if (link.startsWith("socks://") || link.startsWith("socks5://")) return replaceSocks(link, replacements, isRecovery);
  return link;
}

function replaceSS(link, replacements, isRecovery) {
  const randomPassword = generateRandomStr(12);
  const randomDomain = randomPassword + ".com";
  let tempLink = link.slice(5).split("#")[0];
  if (tempLink.includes("@")) {
    const match = tempLink.match(/(\S+?)@(\[?[\da-fA-F:]+\]?|[\d\.]+|[\w\.-]+):/);
    if (!match) return link;
    const [full, base64Data, server] = match;
    try {
      const decoded = urlSafeBase64Decode(base64Data);
      const parts = decoded.split(":");
      if (parts.length < 2) return link;
      const encryption = parts[0];
      const password = parts.slice(1).join(":");
      replacements[randomDomain] = server;
      replacements[randomPassword] = password;
      const newStr = urlSafeBase64Encode(encryption + ":" + randomPassword);
      return link.replace(base64Data, newStr).replace(server, randomDomain);
    } catch (e) { return link; }
  }
  return link;
}

function replaceVmess(link, replacements, isRecovery) {
  let tempLink = link.replace("vmess://", "");
  try {
    const decoded = urlSafeBase64Decode(tempLink);
    const jsonData = JSON.parse(decoded);
    const server = jsonData.add;
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
  const match = link.match(/(vless|trojan):\/\/(.*?)@(\[?[\da-fA-F:]+\]?|[\d\.]+|[\w\.-]+):/);
  if (!match) return link;
  const [full, proto, uuid, server] = match;
  const randomDomain = generateRandomStr(10) + ".com";
  const randomUUID = generateRandomUUID();
  replacements[randomDomain] = server;
  replacements[randomUUID] = uuid;
  return link.replace(uuid, randomUUID).replace(server, randomDomain);
}

function replaceSSR(link, replacements, isRecovery) {
  try {
    let data = link.slice(6).replace("\r", "").split("#")[0];
    let decoded = urlSafeBase64Decode(data);
    const match = decoded.match(/([\[\]\da-fA-F:\.]+|[\w\.-]+):(\d+?):(\S+?):(\S+?):(\S+?):(\S+)\//);
    if (!match) return link;
    const [, server, port, proto, method, obfs, password] = match;

    if (isRecovery) {
      const originalServer = replacements[server];
      const originalPass = replacements[urlSafeBase64Decode(password)];
      if (!originalServer || !originalPass) return link;
      return "ssr://" + urlSafeBase64Encode(decoded.replace(server, originalServer).replace(password, urlSafeBase64Encode(originalPass)));
    } else {
      const randomDomain = generateRandomStr(12) + ".com";
      const randomPass = generateRandomStr(12);
      replacements[randomDomain] = server;
      replacements[randomPass] = urlSafeBase64Decode(password);
      return "ssr://" + urlSafeBase64Encode(decoded.replace(server, randomDomain).replace(password, urlSafeBase64Encode(randomPass)));
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
    const randomPass = generateRandomStr(12);

    if (atIndex !== -1) {
      const authBase64 = temp.slice(0, atIndex);
      const serverPort = temp.slice(atIndex + 1);
      const auth = base64ToUtf8Safe(authBase64);
      const [user, pass] = auth.split(":");
      const serverMatch = serverPort.match(/^(\[?[\da-fA-F:]+\]?|[\d\.]+|[\w\.-]+):(\d+)$/);
      if (!serverMatch) return link;
      const [, server, port] = serverMatch;
      replacements[fakeIP] = server;
      if (pass) replacements[randomPass] = pass;
      return `socks://${utf8ToBase64(user + ":" + randomPass)}@${fakeIP}:${port}${hashPart}`;
    } else {
      const serverMatch = temp.match(/^(\[?[\da-fA-F:]+\]?|[\d\.]+|[\w\.-]+):(\d+)$/);
      if (!serverMatch) return link;
      const [, server, port] = serverMatch;
      replacements[fakeIP] = server;
      return `socks://${fakeIP}:${port}${hashPart}`;
    }
  } catch (e) { return link; }
}

function replaceHysteria(link, replacements, isRecovery) {
  const match = link.match(/hysteria:\/\/(\[?[\da-fA-F:]+\]?|[\d\.]+|[\w\.-]+):/);
  if (!match) return link;
  const server = match[1];
  if (isRecovery) {
    const original = replacements[server];
    return original ? link.replace(server, original) : link;
  } else {
    const randomDomain = generateRandomStr(12) + ".com";
    replacements[randomDomain] = server;
    return link.replace(server, randomDomain);
  }
}

function replaceHysteria2(link, replacements, isRecovery) {
  const match = link.match(/(hysteria2):\/\/(.*)@(\[?[\da-fA-F:]+\]?|[\d\.]+|[\w\.-]+):/);
  if (!match) return link;
  const [full, proto, uuid, server] = match;
  const randomDomain = generateRandomStr(10) + ".com";
  const randomUUID = generateRandomUUID();
  replacements[randomDomain] = server;
  replacements[randomUUID] = uuid;
  return link.replace(uuid, randomUUID).replace(server, randomDomain);
}

function replaceYAMLContent(content, replacements) {
  let result = content;
  const serverRegex = /server:\s*(\S+)/g;
  result = result.replace(serverRegex, (match, server) => {
    if (server.includes(".") || server.includes(":")) {
       const randomDomain = generateRandomStr(12) + ".com";
       replacements[randomDomain] = server;
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

// KV helpers: use optional global SUB_BUCKET-like client if provided, otherwise fallback to in-memory Map
async function kvPut(key, value) {
  if (!key) {
    console.error('kvPut called with empty key');
    return;
  }
  try {
    if (globalThis.SUB_BUCKET && typeof globalThis.SUB_BUCKET.put === 'function') {
      await globalThis.SUB_BUCKET.put(key, value);
    } else {
      localCache.set(key, value);
      setTimeout(() => localCache.delete(key), 60000);
    }
  } catch (e) {
    console.error('KV put error', e);
  }
}

async function kvGet(key) {
  if (!key) return null;
  if (localCache.has(key)) return localCache.get(key);
  try {
    if (globalThis.SUB_BUCKET && typeof globalThis.SUB_BUCKET.get === 'function') {
      const v = await globalThis.SUB_BUCKET.get(key);
      if (v !== null && v !== undefined) {
        localCache.set(key, v);
        setTimeout(() => localCache.delete(key), 60000);
      }
      return v;
    } else {
      return null;
    }
  } catch (e) {
    console.error('KV get error', e);
    return null;
  }
}

function getHost(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

async function processSubscription(request, urlObj, backend) {
  const targetUrl = getFullUrl(request.url);
  if (!targetUrl) {
    const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const backendUrl = `${backendBase}/sub${urlObj.search}`;
    try {
      const response = await fetch(backendUrl, {
        method: 'GET',
        headers: { 'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0' }
      });
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }

  const host = getHost(request);
  const subInternalDir = 'internal';
  const replacements = {};
  const replacedURIs = [];
  const keys = [];

  const urlParts = targetUrl.split('|').filter(p => p.trim() !== '');

  for (const part of urlParts) {
    const key = generateRandomStr(16);
    let plaintextData = "";
    let responseHeaders = {};

    if (part.startsWith('http://') || part.startsWith('https://')) {
      try {
        const resp = await fetch(part, {
          headers: { "User-Agent": request.headers.get("user-agent") || "Mozilla/5.0" }
        });
        if (resp.ok) {
          plaintextData = await resp.text();
          const hdrs = {};
          for (const [k, v] of resp.headers.entries()) hdrs[k] = v;
          responseHeaders = hdrs;
        } else {
          console.error('remote fetch not ok', part, resp.status);
          continue;
        }
      } catch (e) {
        console.error("Fetch failed:", part, e && e.message ? e.message : e);
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
          const nl = replaceInUri(link, replacements, false);
          newLinks.push(nl || link);
        }
        obfuscatedData = utf8ToBase64(newLinks.join("\r\n"));
      } else if (parsed.format === "yaml") {
        obfuscatedData = replaceYAMLContent(plaintextData, replacements);
      }

      await kvPut(key, obfuscatedData);
      await kvPut(key + "_headers", JSON.stringify(responseHeaders));
      keys.push(key);
      replacedURIs.push(`${host}/${subInternalDir}/${key}`);
    }
  }

  if (replacedURIs.length === 0) {
    return new Response("No valid nodes found", { status: 400 });
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

    const backendIndicatesNoNodes = /no nodes were found|no valid nodes found|not found/i.test(content);
    if (!response.ok || backendIndicatesNoNodes) {
      const assembled = [];
      for (const k of keys) {
        const c = await kvGet(k);
        if (c) assembled.push(c);
      }
      if (assembled.length > 0) {
        const target = incomingParams.get('target');
        if (target === 'base64') {
          content = assembled.join('|');
        } else {
          const decodedParts = assembled.map(p => {
            try {
              const dec = urlSafeBase64Decode(p);
              if (dec && (dec.includes('://') || dec.includes('proxies:') || dec.includes('port:'))) return dec;
            } catch (e) {}
            return p;
          });
          content = decodedParts.join('\r\n');
        }

        // cleanup
        for (const k of keys) {
          try {
            if (globalThis.SUB_BUCKET && typeof globalThis.SUB_BUCKET.delete === 'function') {
              await globalThis.SUB_BUCKET.delete(k);
              await globalThis.SUB_BUCKET.delete(k + "_headers");
            }
          } catch (e) {}
          localCache.delete(k); localCache.delete(k + "_headers");
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
      const target = urlObj.searchParams.get("target");
      try {
        const decoded = urlSafeBase64Decode(content);
        if (decoded && (decoded.includes("://") || decoded.includes("proxies:") || decoded.includes("port:"))) {
          const recovered = decoded.replace(recoveryRegex, (m) => replacements[m] || m);
          content = (target === "base64") ? utf8ToBase64(recovered) : recovered;
        } else {
          content = content.replace(recoveryRegex, (m) => replacements[m] || m);
        }
      } catch (e) {
        content = content.replace(recoveryRegex, (m) => replacements[m] || m);
      }
    }

    // cleanup
    for (const k of keys) {
      try {
        if (globalThis.SUB_BUCKET && typeof globalThis.SUB_BUCKET.delete === 'function') {
          await globalThis.SUB_BUCKET.delete(k);
          await globalThis.SUB_BUCKET.delete(k + "_headers");
        }
      } catch (e) {}
      localCache.delete(k); localCache.delete(k + "_headers");
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

// Vercel Edge / Serverless handler
export default async function handler(request) {
  const BACKEND = (typeof process !== 'undefined' && process.env && process.env.BACKEND) ? process.env.BACKEND : 'https://api.v1.mk';
  const url = new URL(request.url);
  const host = getHost(request);

  // Home page handler with replacements requested by user
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const frontendUrl = "https://raw.githubusercontent.com/lizhi123le/psub/refs/heads/main/index.html";
      const res = await fetch(frontendUrl);
      if (res.ok) {
        let html = await res.text();
        // Replace occurrences of bulianglin2023.dev with current host
        html = html.replace(/https:\/\/bulianglin2023\.dev/g, host);
        html = html.replace(/bulianglin2023\.dev/g, url.host);
        html = html.replace(/https%3A%2F%2Fbulianglin2023\.dev/g, encodeURIComponent(host));
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    } catch (e) {
      // fall through to default minimal page
    }
    return new Response(`<!DOCTYPE html><html><head><title>psub</title></head><body><h1>psub</h1><p>Running.</p></body></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Version endpoint
  if (url.pathname === '/version') {
    try {
      const backendBase = BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1");
      const response = await fetch(`${backendBase}/version`);
      const text = await response.text();
      return new Response(text, { status: response.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }

  // Internal temporary subscription endpoint
  if (url.pathname.includes("/internal/")) {
    const pathSegments = url.pathname.split("/").filter(s => s);
    const key = pathSegments[pathSegments.length - 1];

    const content = await kvGet(key);
    if (!content) {
      console.error('internal: kvGet returned empty for key', key);
      return new Response("Not Found", { status: 404 });
    }

    const headersJson = await kvGet(key + "_headers");
    let headersObj = { "Content-Type": "text/plain; charset=utf-8" };
    try {
      if (headersJson) headersObj = JSON.parse(headersJson);
    } catch (e) {
      console.error('internal: failed to parse headers JSON for key', key, e);
    }

    const headers = new Headers(headersObj);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(content, { headers });
  }

  // Subscription conversion endpoint
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not Found', { status: 404 });
}
