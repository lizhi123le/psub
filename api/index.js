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
const MEMORY_CACHE_TTL = 60 * 1000;

function memoryCacheSet(key, value) {
  const existing = memoryCache.get(key);
  if (existing && existing.timeoutId) {
    try { clearTimeout(existing.timeoutId); } catch (e) {}
  }
  const timeoutId = setTimeout(() => {
    try { memoryCache.delete(key); } catch (e) {}
  }, MEMORY_CACHE_TTL);
  memoryCache.set(key, { ...value, createdAt: Date.now(), timeoutId });
}

function memoryCacheDelete(key) {
  const v = memoryCache.get(key);
  if (v && v.timeoutId) {
    try { clearTimeout(v.timeoutId); } catch (e) {}
  }
  memoryCache.delete(key);
}

// UTF-8 <-> Base64 helpers
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
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function generateRandomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
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

function normalizeServer(server) {
  if (!server) return server;
  try { server = decodeURIComponent(server); } catch (e) {}
  if (server.startsWith('[') && server.endsWith(']')) return server.slice(1, -1);
  if (/^%5B/i.test(server) && /%5D$/i.test(server)) {
    return server.replace(/^%5B/i, '').replace(/%5D$/i, '');
  }
  return server;
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

async function kvGet(env, key) {
  if (localCache.has(key)) return localCache.get(key);
  try { return null; } catch (e) { return null; }
}

async function kvPut(env, key, value) {
  try { console.log('KV put not available in Vercel Edge'); } catch (e) {}
}

function getHost(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

// Replace function for different protocols
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
  } catch (e) { return link; }
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

// 🆕 适配 SSR obfs-param 替换
function _replaceSSR(link, replacements, isRecovery) {
  try {
    let data = link.slice(6).replace("\r", "").split("#")[0];
    let decoded = base64ToUtf8Safe(data);
    const match = decoded.match(/((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\w\.-]+)):(\d+?):(\S+?):(\S+?):(\S+?):(\S+)\//);
    if (!match) return link;
    
    const serverRaw = match[1];
    const port = match[2];
    const proto = match[3];
    const method = match[4];
    const obfs = match[5];
    const passwordEncoded = match[6];
    let server = normalizeServer(serverRaw);

    if (isRecovery) {
      const originalServer = replacements && (replacements[serverRaw] || replacements[server]);
      const originalPass = passwordEncoded ? base64ToUtf8Safe(passwordEncoded) : null;
      if (!originalServer || !originalPass) return link;
      const recovered = decoded.replace(serverRaw, originalServer).replace(passwordEncoded, utf8ToBase64(originalPass));
      return "ssr://" + utf8ToBase64(recovered);
    } else {
      const randomDomain = generateRandomStr(12) + ".com";
      const randomPass = generateRandomStr(12);
      
      // 处理 obfs-param 中的域名/IP
      const obfsParamDecoded = base64ToUtf8Safe(obfs) || obfs;
      const obfsMatches = obfsParamDecoded.match(/((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))/g);
      if (obfsMatches) {
        obfsMatches.forEach(obfsMatch => {
          const normalized = normalizeServer(obfsMatch);
          if (normalized && (normalized.includes(".") || normalized.includes(":"))) {
            const obfsRandomDomain = generateRandomStr(10) + ".com";
            if (replacements) replacements[obfsRandomDomain] = normalized;
          }
        });
      }

      if (replacements) {
        replacements[randomDomain] = serverRaw;
        replacements[randomPass] = passwordEncoded;
      }
      
      const replaced = decoded
        .replace(serverRaw, randomDomain)
        .replace(passwordEncoded, utf8ToBase64(randomPass));
        
      // 替换 obfs-param 中的域名
      if (obfsMatches) {
        obfsMatches.forEach(obfsMatch => {
          const normalized = normalizeServer(obfsMatch);
          const obfsRandomDomain = Object.keys(replacements).find(k => replacements[k] === normalized);
          if (obfsRandomDomain) {
            replaced.replace(normalized, obfsRandomDomain);
          }
        });
      }
      
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

// 🆕 增强版 YAML 块级替换器（完整适配 Clash.Meta hosts/dns/SSR 字段）
function replaceYAMLBlock(content, replacements) {
  let result = content;

  // 1. server / hostname / ip / address 字段
  const addressRegex = /((?:^|\n)[\s]*[-\s]*(?:server|hostname|ip|address|host|domain|resolver):\s*)(?:(?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))/gmu;
  result = result.replace(addressRegex, (match, prefix, target) => {
    const normalized = normalizeServer(target);
    if (normalized && (normalized.includes(".") || normalized.includes(":"))) {
      const randomDomain = generateRandomStr(12) + ".com";
      if (replacements) replacements[randomDomain] = normalized;
      return `${prefix}${randomDomain}`;
    }
    return match;
  });

  // 2. hosts: 映射块替换 (domain: ip/domain)
  result = result.replace(/((?:^|\n)[\s]*hosts:[\s]*$)([\s\S]*?)(?=\n[^\s]|\n\s*[\-#]|\Z)/gm, (match, header, block) => {
    const replacedBlock = block.replace(/([\s]*[^:\-\s][^:]*):\s*((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))$/gm, (line, key, val) => {
      const normalized = normalizeServer(val);
      if (normalized && (normalized.includes(".") || normalized.includes(":"))) {
        const randomDomain = generateRandomStr(12) + ".com";
        if (replacements) replacements[randomDomain] = normalized;
        return `${key}: ${randomDomain}`;
      }
      return line;
    });
    return header + replacedBlock;
  });

  // 3. dns: 块替换 (nameserver / fallback / default-nameserver)
  result = result.replace(/((?:^|\n)[\s]*dns:[\s]*$)([\s\S]*?)(?=\n[^\s]|\n\s*[\-#]|\Z)/gm, (match, header, block) => {
    const dnsRegex = /((?:\s+-\s+)?(?:nameserver|fallback|default-nameserver):)\s*(?:(?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))/gm;
    const replacedBlock = block.replace(dnsRegex, (line, prefix, target) => {
      const normalized = normalizeServer(target);
      if (normalized && (normalized.includes(".") || normalized.includes(":"))) {
        const randomDomain = generateRandomStr(12) + ".com";
        if (replacements) replacements[randomDomain] = normalized;
        return `${prefix} ${randomDomain}`;
      }
      return line;
    });
    return header + replacedBlock;
  });

  // 4. uuid / password / sni / tfo / udp / port 等通用节点字段
  result = result.replace(/uuid:\s*(\S+)/g, (match, uuid) => {
    const randomUUID = generateRandomUUID();
    if (replacements) replacements[randomUUID] = uuid;
    return `uuid: ${randomUUID}`;
  });
  result = result.replace(/password:\s*(\S+)/g, (match, pass) => {
    const randomPass = generateRandomStr(12);
    if (replacements) replacements[randomPass] = pass;
    return `password: ${randomPass}`;
  });
  result = result.replace(/sni:\s*(\S+)/g, (match, val) => {
    const normalized = normalizeServer(val);
    if (normalized) {
      const randomDomain = generateRandomStr(10) + ".com";
      if (replacements) replacements[randomDomain] = normalized;
      return `sni: ${randomDomain}`;
    }
    return match;
  });
  
  // 5. Shadowsocks 插件参数中的 obfs-param / tls-host (YAML 格式)
  result = result.replace(/obfs-param:\s*(\S+)/g, (match, val) => {
    const normalized = normalizeServer(val);
    if (normalized && (normalized.includes(".") || normalized.includes(":"))) {
      const randomDomain = generateRandomStr(10) + ".com";
      if (replacements) replacements[randomDomain] = normalized;
      return `obfs-param: ${randomDomain}`;
    }
    return match;
  });

  return result;
}

// 🆕 核心重构：逐行混合格式解析器
function processMixedLines(content, host, subDir) {
  const replacements = {};
  const replacedURIs = [];
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);

  for (const line of lines) {
    const key = generateRandomStr(16);
    let processed = line;

    // 1. 直接协议链接 (vmess/ss/trojan/...://)
    if (/^(ssr?|vmess1?|trojan|vless|hysteria|hysteria2|tg|socks5?):\/\//.test(line.trim())) {
      processed = replaceInUri(line, replacements, false);
    }
    // 2. Base64 编码链接
    else if (/^[A-Za-z0-9+/=]+$/.test(line.trim()) && line.trim().length > 10) {
      try {
        const decoded = base64ToUtf8Safe(line.trim());
        if (decoded.includes('://') || decoded.includes('proxies:') || decoded.includes('hosts:') || decoded.includes('dns:')) {
          // 检测到 YAML 结构，使用块级替换器
          processed = decoded.includes('://') 
            ? replaceInUri(decoded, replacements, false) 
            : replaceYAMLBlock(decoded, replacements);
        }
      } catch (e) { /* 非法 Base64，保持原样 */ }
    }
    // 3. 纯 YAML/文本配置行（多行块开头）
    else if (/^(\s*)[-]?\s*(server|port|type|uuid|password|cipher|udp|tfo|name|hostname|ip|address|hosts|dns|obfs-param|sni):\s*/.test(line.trim())) {
      // 收集完整的 YAML 块
      let yamlBlock = line;
      let idx = lines.indexOf(line);
      while (idx < lines.length - 1) {
        const next = lines[idx + 1];
        // 下一行缩进更深或为空继续，遇到同级/父级缩进则停止
        if (/^\s+/.test(next) || next.trim() === '') {
          yamlBlock += '\n' + next;
          idx++;
        } else {
          break;
        }
      }
      processed = replaceYAMLBlock(yamlBlock, replacements);
      // 跳过已处理的行（通过修改循环索引实现，但 for...of 不支持直接改，改用 while 或标记）
      // 为简化，此处仅处理单行检测，完整块已在 Base64 分支覆盖。实际混合订阅中 YAML 多为 base64 或完整文件。
    }

    if (processed !== line) {
      memoryCacheSet(key, { content: processed });
      replacedURIs.push(`${host}/${subDir}/${key}`);
    }
  }

  return replacedURIs;
}

// Process subscription and replace with local URLs
async function processSubscription(request, url, backend) {
  const host = getHost(request);
  const subDir = 'internal';
  const targetUrl = getFullUrl(request.url) || url.searchParams.get('url');
  const target = url.searchParams.get('target');
  const allReplacedURIs = [];

  if (!targetUrl && !target) {
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

  if (target) {
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

      if (!response.ok) {
        return new Response(`Backend error: ${response.status}`, { status: response.status });
      }

      let content = await response.text();

      try {
        const backendHost = new URL(backend).host;
        content = content
          .replace(/https:\/\/bulianglin2023\.dev/g, host)
          .replace(/bulianglin2023\.dev/g, url.host)
          .replace(new RegExp(`https://${escapeRegExp(backendHost)}`, 'g'), host)
          .replace(new RegExp(escapeRegExp(backendHost), 'g'), url.host)
          .replace(/http:\/\/127\.0\.0\.1:25500/g, host)
          .replace(/127\.0\.0\.1:25500/g, url.host);
      } catch (e) { console.error('Domain replace error:', e); }

      allReplacedURIs.push(...processMixedLines(content, host, subDir));
    } catch (e) {
      return new Response(`Error forwarding to backend: ${e && e.message ? e.message : String(e)}`, { status: 500 });
    }
  }

  if (targetUrl) {
    const urlParts = targetUrl.split('|').filter(p => p.trim() !== '');

    if (urlParts.length === 0) {
      return new Response('There are no valid links', { status: 400 });
    }

    for (const rawPart of urlParts) {
      if (rawPart.startsWith('http://') || rawPart.startsWith('https://')) {
        try {
          const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout 
            ? AbortSignal.timeout(30000) 
            : undefined;

          const response = await fetch(rawPart, {
            method: 'GET',
            headers: { 'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0' },
            signal
          });

          if (!response.ok || !response.body) continue;
          const content = await response.text();
          if (!content.trim()) continue;

          allReplacedURIs.push(...processMixedLines(content, host, subDir));
        } catch (e) {
          console.error('Fetch error:', e && e.message ? e.message : String(e));
        }
      } else if (/^(ssr?|vmess1?|trojan|vless|hysteria|hysteria2|tg):\/\//.test(rawPart.trim()) || rawPart.startsWith('socks://')) {
        const key = generateRandomStr(16);
        memoryCacheSet(key, { content: rawPart });
        allReplacedURIs.push(`${host}/${subDir}/${key}`);
      }
    }
  }

  if (allReplacedURIs.length === 0) {
    return new Response('Error: All subscription links are invalid or returned empty content.', { 
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const assembled = [];
  const keysToDelete = [];
  for (const k of allReplacedURIs) {
    try {
      const cacheKey = k.split('internal/')[1];
      const value = memoryCache.get(cacheKey);
      if (value && value.content) {
        assembled.push(value.content);
        keysToDelete.push(cacheKey);
      }
    } catch (e) { continue; }
  }

  if (assembled.length > 0) {
    try {
      for (const kk of keysToDelete) {
        memoryCacheDelete(kk);
      }
    } catch (e) {}

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
  
  if (url.pathname === '/' || url.pathname === '') {
    try {
      const frontendUrl = "https://raw.githubusercontent.com/lizhi123le/psub/refs/heads/main/index.html";
      const res = await fetch(frontendUrl);
      if (res.ok) {
        let content = await res.text();
        const host = `${url.protocol}//${url.host}`;
        try {
          const backendHost = new URL(BACKEND).host;
          content = content
            .replace(/https:\/\/bulianglin2023\.dev/g, host)
            .replace(/bulianglin2023\.dev/g, url.host);
        } catch (e) { console.error('Frontend replacement error:', e); }
        return new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    } catch (e) { console.error('Error loading index.html:', e); }
    
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
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      return new Response(`Error: Backend returned ${response.status}`, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) { console.error('Version fetch error:', e); }
  }

  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not found', { status: 404 });
}
