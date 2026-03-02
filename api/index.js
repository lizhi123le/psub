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

  // psub / subconverter top-level reserved parameters
  const reserved = ['target=', 'config=', 'emoji=', 'list=', 'udp=', 'tfo=', 'scv=', 'fdn=', 'sort=', 'dev=', 'bd=', 'insert=', 'exclude=', 'append_info=', 'expand=', 'new_name=', 'rename=', 'filename='];
  
  let searchStr = search.substring(1);
  let urlStart = -1;
  const urlKeys = ['url=', 'sub=']; // Support both url and sub
  
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
    if (rIdx !== -1 && rIdx < bestCut) {
      bestCut = rIdx;
    }
  }

  let finalUrl = remaining.substring(0, bestCut);
  return decodeURIComponent(finalUrl);
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

// Process subscription and replace with local URLs
async function processSubscription(request, url, backend) {
  const host = getHost(request);
  const subDir = 'subscription';
  const targetUrl = getFullUrl(request.url);
  const target = url.searchParams.get('target');

  if (!targetUrl) {
    const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const backendUrl = `${backendBase}/sub${url.search}`;
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
  }

  const replacements = {};
  const replacedURIs = [];
  const keys = [];
  const urlParts = targetUrl.split('|').filter(part => part.trim() !== '');

  if (urlParts.length === 0) {
    return new Response('There are no valid links', { status: 400 });
  }

  for (const urlPart of urlParts) {
    // If target is present, bypass local processing for remote URLs to avoid 400 error on Vercel (Edge state loss)
    if (target && (urlPart.startsWith('https://') || urlPart.startsWith('http://'))) {
      replacedURIs.push(urlPart);
      continue;
    }

    const key = generateRandomStr(16);
    let plaintextData = "";
    let responseHeaders = {};

    if (urlPart.startsWith('https://') || urlPart.startsWith('http://')) {
      try {
        const response = await fetch(urlPart, {
          method: 'GET',
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
          }
        });
        if (response.ok) {
          plaintextData = await response.text();
          responseHeaders = Object.fromEntries(response.headers);
        }
      } catch (e) {
        console.error('Fetch error:', e.message);
        continue;
      }
    } else {
      plaintextData = urlPart;
    }

    if (plaintextData) {
      const parsed = parseData(plaintextData);
      let obfuscatedData = plaintextData;

      if (parsed.format === 'base64') {
        const links = parsed.data.split(/\r?\n/).filter(link => link.trim() !== '');
        const newLinks = [];
        for (const link of links) {
          newLinks.push(replaceInUri(link, replacements, false));
        }
        obfuscatedData = utf8ToBase64(newLinks.join('\r\n'));
      } else if (parsed.format === 'yaml') {
        obfuscatedData = replaceYAMLContent(plaintextData, replacements);
      }

      memoryCache.set(key, obfuscatedData);
      memoryCache.set(key + '_headers', JSON.stringify(responseHeaders || { 'Content-Type': 'text/plain;charset=UTF-8' }));
      keys.push(key);
      replacedURIs.push(`${host}/${subDir}/${key}`);
    }
  }

  if (replacedURIs.length === 0) {
    return new Response('Error: No valid nodes found', { status: 400 });
  }

  // If there's a target parameter, forward to backend for conversion
  if (target) {
    return await forwardToBackend(request, url, backend, host, subDir, replacements, keys, replacedURIs);
  }

  const result = utf8ToBase64(replacedURIs.join('\r\n'));
  return new Response(result, {
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// Forward to backend for conversion, then restore original node details
async function forwardToBackend(request, url, backend, host, subDir, replacements, keys, replacedURIs) {
  try {
    const newUrl = replacedURIs.join('|');
    const incomingParams = new URL(request.url).searchParams;
    const originalParams = new URLSearchParams();
    
    // Whitelist of psub / subconverter parameters to keep
    const psubParams = ['target', 'config', 'emoji', 'list', 'udp', 'tfo', 'scv', 'fdn', 'sort', 'dev', 'bd', 'insert', 'exclude', 'append_info', 'expand', 'new_name', 'rename', 'filename', 'path', 'prefix', 'suffix', 'ver'];
    
    for (const [key, value] of incomingParams.entries()) {
      if (psubParams.includes(key)) {
        originalParams.set(key, value);
      }
    }
    
    originalParams.set('url', newUrl);
    
    const backendBase = backend.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const backendUrl = `${backendBase}/sub?${originalParams.toString()}`;
    
    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    });

    if (!response.ok) {
      return new Response(`Backend error: ${response.status}`, { status: response.status });
    }

    let content = await response.text();
    
    // Recovery mapping
    if (Object.keys(replacements).length > 0) {
      const recoveryRegex = new RegExp(
        Object.keys(replacements).map(escapeRegExp).join("|"),
        "g"
      );
      
      const target = url.searchParams.get("target");
      
      try {
        const decoded = urlSafeBase64Decode(content);
        if (decoded && (decoded.includes("://") || decoded.includes("proxies:") || decoded.includes("port:"))) {
          const recovered = decoded.replace(recoveryRegex, (match) => replacements[match] || match);
          if (target === "base64") {
            content = utf8ToBase64(recovered);
          } else {
            content = recovered;
          }
        } else {
          content = content.replace(recoveryRegex, (match) => replacements[match] || match);
        }
      } catch (e) {
        content = content.replace(recoveryRegex, (match) => replacements[match] || match);
      }
    }
    
    // Cleanup cache
    for (const key of keys) {
      memoryCache.delete(key);
      memoryCache.delete(key + '_headers');
    }

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (e) {
    return new Response(`Error: ${e.message}`, { status: 500 });
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
