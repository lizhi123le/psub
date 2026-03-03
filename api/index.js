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

function generateRandomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == "x" ? r : (r & 3) | 8;
    return v.toString(16);
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function urlSafeBase64Encode(input) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function urlSafeBase64Decode(input) {
  try {
    const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
    const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    return base64ToUtf8(base64);
  } catch (e) {
    try {
      return base64ToUtf8(input);
    } catch (e2) {
      return input;
    }
  }
}

function base64ToUtf8(str) {
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    return atob(str);
  }
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// Robustly extract 'url' parameter using greedy matching to prevent truncation by internal '&'
function getFullUrl(requestUrl) {
  const url = new URL(requestUrl);
  const search = url.search;
  if (!search) return url.searchParams.get('url');

  // psub / subconverter top-level reserved parameters - comprehensive whitelist
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
    // Only cut if the reserved parameter is preceded by '&'
    let rIdx = remaining.indexOf('&' + r);
    if (rIdx !== -1 && rIdx < bestCut) {
      bestCut = rIdx;
    }
  }

  let finalUrl = remaining.substring(0, bestCut);

  // Deciding between greedy results and standard extraction
  const stdUrl = url.searchParams.get('url');
  if (stdUrl && stdUrl.includes('://') && stdUrl.length > finalUrl.length) {
    return stdUrl;
  }

  try {
    return decodeURIComponent(finalUrl);
  } catch (e) {
    return finalUrl;
  }
}

// Parse subscription data format
function parseData(data) {
  if (data.includes("proxies:")) return { format: "yaml", data: data };
  try {
    const decoded = urlSafeBase64Decode(data.trim());
    if (decoded.includes("://") || decoded.includes("proxies:")) return { format: "base64", data: decoded };
  } catch (e) {}
  return { format: "unknown", data: data };
}

// Obfuscation Functions
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
      const auth = atob(authBase64);
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

// Extract host from URL
function getHost(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// Process subscription and forward to backend
async function processSubscription(request, url, backend) {
  const targetUrl = getFullUrl(request.url);

  if (!targetUrl) {
    const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const backendUrl = `${backendBase}/sub${url.search}`;
    try {
      const response = await fetch(backendUrl, {
        method: 'GET',
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
        }
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }

  const host = getHost(request);
  // Use a simple internal path to reduce confusion
  const subInternalDir = 'internal';
  const replacements = {};
  const replacedURIs = [];
  const keys = [];

  const urlParts = targetUrl.split('|').filter(part => part.trim() !== '');

  for (const part of urlParts) {
    const key = generateRandomStr(16);
    let plaintextData = "";
    let responseHeaders = {};

    if (part.startsWith('http://') || part.startsWith('https://')) {
      try {
        const response = await fetch(part, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
          }
        });
        if (response.ok) {
          plaintextData = await response.text();
          // Convert Headers to plain object safely
          const hdrs = {};
          for (const [k, v] of response.headers.entries()) hdrs[k] = v;
          responseHeaders = hdrs;
        } else {
          console.error("Remote fetch not ok:", part, response.status);
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

      // store obfuscated content in memory cache
      memoryCache.set(key, obfuscatedData);
      memoryCache.set(key + "_headers", JSON.stringify(responseHeaders));
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

    // Strict whitelist of psub / subconverter parameters
    const whitelist = [
      'target', 'config', 'emoji', 'list', 'udp', 'tfo', 'scv', 'fdn',
      'sort', 'dev', 'bd', 'insert', 'exclude', 'append_info', 'expand',
      'new_name', 'rename', 'filename', 'path', 'prefix', 'suffix', 'ver',
      'xudp', 'doh', 'rule', 'script', 'node', 'group', 'filter'
    ];

    for (const [key, value] of incomingParams.entries()) {
      if (whitelist.includes(key)) {
        originalParams.set(key, value);
      }
    }
    originalParams.set('url', newUrl);

    const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const backendUrl = `${backendBase}/sub?${originalParams.toString()}`;

    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    });

    let content = await response.text();

    // If backend indicates no nodes or returns an error that likely stems from inability to fetch internal URLs,
    // attempt to assemble and return the obfuscated content directly from our memoryCache as a fallback.
    const backendIndicatesNoNodes = /no nodes were found|no valid nodes found|not found/i.test(content);
    if (!response.ok || backendIndicatesNoNodes) {
      // Try to assemble content directly from cache
      try {
        const assembledParts = [];
        for (const k of keys) {
          const c = memoryCache.get(k);
          if (c) assembledParts.push(c);
        }
        if (assembledParts.length > 0) {
          // If target requested base64, keep base64; otherwise decode base64 parts if they are base64
          const target = incomingParams.get('target');
          // Heuristic: if backend wanted base64, return base64; else return decoded/plain
          if (target === 'base64') {
            content = assembledParts.join('|');
          } else {
            // try to decode base64 parts where possible
            const decodedParts = assembledParts.map(p => {
              // if looks like base64 (contains newlines or '://' after decode), attempt decode
              try {
                const dec = urlSafeBase64Decode(p);
                if (dec && (dec.includes('://') || dec.includes('proxies:') || dec.includes('port:'))) return dec;
              } catch (e) {}
              return p;
            });
            content = decodedParts.join('\r\n');
          }
          // Return assembled content directly
          const responseHeaders = new Headers();
          responseHeaders.set("Content-Type", "text/plain; charset=utf-8");
          responseHeaders.set("Access-Control-Allow-Origin", "*");

          // Clean up cache after returning
          for (const k of keys) {
            memoryCache.delete(k);
            memoryCache.delete(k + "_headers");
          }

          return new Response(content, {
            status: 200,
            headers: responseHeaders
          });
        }
      } catch (e) {
        console.error("Fallback assembly failed:", e && e.message ? e.message : e);
      }
      // If fallback failed, return backend's original response (error)
      return new Response(content, { status: response.status || 500 });
    }

    // --- Recovery Phase ---
    if (Object.keys(replacements).length > 0) {
      const recoveryRegex = new RegExp(
        Object.keys(replacements).map(escapeRegExp).join("|"),
        "g"
      );

      const target = url.searchParams.get("target");

      try {
        // 先尝试 Base64 解码
        const decoded = urlSafeBase64Decode(content);
        // 如果解码成功且包含特征字符 (或者原本就是 base64 响应)
        if (decoded && (decoded.includes("://") || decoded.includes("proxies:") || decoded.includes("port:"))) {
           const recovered = decoded.replace(recoveryRegex, (match) => replacements[match] || match);
           // 只有当明确要求 target=base64 时才重编码，否则返回明文
           if (target === "base64") {
             content = utf8ToBase64(recovered);
           } else {
             content = recovered;
           }
        } else {
          // 如果不是 base64，直接替换
          content = content.replace(recoveryRegex, (match) => replacements[match] || match);
        }
      } catch (e) {
        // 解码失败则作为明文替换
        content = content.replace(recoveryRegex, (match) => replacements[match] || match);
      }
    }

    // Clean up cache
    for (const k of keys) {
      memoryCache.delete(k);
      memoryCache.delete(k + "_headers");
    }

    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", "text/plain; charset=utf-8");
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(content, {
      status: response.status,
      headers: responseHeaders
    });
  } catch (e) {
    console.error("processSubscription error:", e && e.message ? e.message : e);
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const host = getHost(request);

  // Home page handler
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const frontendUrl = "https://raw.githubusercontent.com/lizhi123le/psub/refs/heads/main/index.html";
      const res = await fetch(frontendUrl);
      if (res.ok) {
        let html = await res.text();
        html = html.replace(/https:\/\/bulianglin2023\.dev/g, host);
        html = html.replace(/bulianglin2023\.dev/g, url.host);
        html = html.replace(/https%3A%2F%2Fbulianglin2023\.dev/g, encodeURIComponent(host));
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    } catch (e) {}

    return new Response(`<!DOCTYPE html><html><head><title>psub</title></head><body><h1>psub</h1><p>Running.</p></body></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Version endpoint
  if (url.pathname === '/version') {
    try {
      const backend = BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1");
      const response = await fetch(`${backend}/version`);
      return new Response(await response.text(), { status: response.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }

  // 内部临时订阅端点
  if (url.pathname.includes("/internal/")) {
    const pathSegments = url.pathname.split("/").filter(s => s);
    const key = pathSegments[pathSegments.length - 1];

    let content = memoryCache.get(key);
    let headersJson = memoryCache.get(key + "_headers");

    if (!content) return new Response("Not Found", { status: 404 });

    const headers = new Headers(headersJson ? JSON.parse(headersJson) : { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(content, { headers });
  }

  // Subscription conversion endpoint
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not Found', { status: 404 });
}