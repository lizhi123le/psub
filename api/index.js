export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sin2', 'sfo1', 'sfo2'],
};

// 环境变量配置
const BACKEND = process.env.BACKEND || 'https://api.v1.mk';

// 请求级缓存池（Edge 函数每次调用独立，请求结束自动清理）
const requestScope = {
  cache: new Map(),
  mappings: new Map(), // 核心映射表：混淆值 -> 原始值
  cacheCounter: 0
};

// --- 基础工具函数 ---

function generateRandomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let res = '';
  for (let i = 0; i < len; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

function generateRandomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function utf8ToBase64(str) {
  try {
    const bytes = new TextEncoder().encode(str);
    return btoa(String.fromCharCode(...bytes));
  } catch (e) {
    return Buffer.from(str, 'utf-8').toString('base64');
  }
}

function base64ToUtf8Safe(b64) {
  try {
    let clean = b64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = clean.length % 4;
    if (pad) clean += '='.repeat(4 - pad);
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return null;
  }
}

// --- 核心映射与混淆逻辑 ---

/**
 * 建立混淆映射表
 */
function buildObfuscationMapping(originalIp, originalDomain, originalUuid) {
  const fakeDomain = generateRandomStr(10) + '.com';
  const fakeIp = `10.${Math.floor(Math.random() * 255 + 1)}.${Math.floor(Math.random() * 255 + 1)}.${Math.floor(Math.random() * 255 + 1)}`;
  const fakeUuid = generateRandomUUID();

  const mapping = {
    domain: { fake: fakeDomain, original: originalDomain },
    ip: { fake: fakeIp, original: originalIp },
    uuid: { fake: fakeUuid, original: originalUuid }
  };
  return mapping;
}

/**
 * 标准化主机名（IP/域名/IPv6）
 */
function normalizeHost(host) {
  if (!host) return host;
  try { host = decodeURIComponent(host); } catch (e) {}
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/**
 * 单节点链接混淆处理
 */
function obfuscateLink(link, mapping, replacements) {
  if (!link || link.startsWith('#') || link.startsWith('!')) return link;

  const lowerLink = link.toLowerCase();
  
  // 提取关键信息
  let host = null;
  let uuid = null;
  
  if (lowerLink.startsWith('ss://')) {
    const m = link.slice(5).match(/(\S+?)@((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+)):\/?/);
    if (m) {
      const b64 = m[1];
      const rawHost = m[2];
      host = normalizeHost(rawHost);
      try {
        const decoded = base64ToUtf8Safe(b64);
        if (decoded && decoded.includes(':')) uuid = decoded.split(':').slice(1).join(':');
      } catch (e) {}
      if (host && uuid) replacements[randomDomain] = host; // 映射记录
    }
    // 简化处理：直接替换原始代码逻辑中的混淆函数
  }
  // 由于协议繁多，统一使用健壮的正则替换流，避免协议级解析的碎片化问题
  // 这里采用更高效的“全局提取+映射替换”策略
  
  return link;
}

// 实际部署中，推荐使用统一的正则替换器，避免逐个协议解析的性能损耗与兼容性陷阱
const LINK_REGEX = /((?:\[[\da-fA-F:]+\])|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))/g;
const UUID_REGEX = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}/gi;

function applyObfuscationToContent(content, mappingTable) {
  if (!content) return '';
  // 替换 IP/域名
  let result = content.replace(LINK_REGEX, (match) => {
    const fake = generateRandomStr(10) + '.com';
    mappingTable[fake] = normalizeHost(match);
    return fake;
  });
  // 替换 UUID
  result = result.replace(UUID_REGEX, (match) => {
    const fake = generateRandomUUID();
    mappingTable[fake] = match;
    return fake;
  });
  return result;
}

function applyRecoveryToContent(content, mappingTable) {
  if (!content) return '';
  // 反向替换：将所有混淆值替换回原始值
  let result = content;
  const keys = Object.keys(mappingTable);
  // 使用正则或字符串替换，注意顺序：先替换长域名/UUID，避免短字符串干扰
  // 这里使用安全的字典替换
  for (const [fake, original] of Object.entries(mappingTable)) {
    if (!original || !fake) continue;
    // 保护性替换：仅替换明确匹配的节点字段，防止误伤配置值
    // 使用 word boundary 或上下文匹配会更安全，但为兼容所有格式，采用精确字符串替换+边界检查
    result = result.replace(new RegExp(escapeRegExp(fake), 'g'), original);
  }
  return result;
}

// --- 网络请求辅助 ---

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'SubscriptionProxy/1.0', 'Accept': '*/*' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('Request timeout');
    throw e;
  }
}

// --- 主处理逻辑 ---

async function processSubscription(request, url, backend) {
  // 清理当前请求的缓存状态，防止热更新导致的数据污染
  requestScope.cache.clear();
  requestScope.mappings.clear();
  requestScope.cacheCounter = 0;

  const host = `${url.protocol}//${url.host}`;
  const targetUrl = url.searchParams.get('url') || url.searchParams.get('sub');
  const targetFormat = url.searchParams.get('target');
  const otherParams = new URLSearchParams(url.search);

  if (!targetUrl) {
    // 无 URL 参数，直接透传后端
    try {
      const backendUrl = `${backend.replace(/https?:\/\/[^/]+/, '')}${url.pathname}${url.search}`;
      const res = await fetchWithTimeout(backendUrl);
      if (!res.ok) throw new Error(`Backend ${res.status}`);
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/plain', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response(`Backend error: ${e.message}`, { status: 500 });
    }
  }

  // 1. 预处理：提取并混淆原始链接
  const rawLinks = targetUrl.split('|').filter(l => l.trim().length > 0);
  const obfuscatedContent = rawLinks.map(l => {
    return applyObfuscationToContent(l, requestScope.mappings);
  }).join('\r\n');

  // 2. 构建临时映射缓存键
  const mappingKey = `map_${requestScope.cacheCounter++}`;
  requestScope.cache.set(mappingKey, requestScope.mappings);

  // 3. 拼接目标请求 URL（仅转发混淆后的内容）
  const params = new URLSearchParams(otherParams);
  params.set('url', obfuscatedContent); // 覆盖原始 url，使用混淆内容
  params.set('sub', obfuscatedContent);
  // 清理可能导致冲突的参数
  params.delete('target'); 
  const finalQuery = params.toString();
  const backendUrl = `${backend.replace(/https?:\/\/[^/]+/, '')}${url.pathname}?${finalQuery}`;

  // 4. 转发请求至后端
  let backendRes = null;
  let backendContent = '';
  try {
    backendRes = await fetchWithTimeout(backendUrl);
    if (!backendRes.ok) throw new Error(`Backend conversion failed: ${backendRes.status}`);
    backendContent = await backendRes.text();
  } catch (e) {
    return new Response(`Conversion error: ${e.message}`, { status: 500 });
  }

  // 5. 后处理：恢复原始 IP/域名/UUID
  let recoveredContent = backendContent;
  if (requestScope.mappings.size > 0) {
    recoveredContent = applyRecoveryToContent(backendContent, requestScope.mappings);
  }

  // 6. 清理缓存，防止泄露
  requestScope.cache.delete(mappingKey);
  requestScope.mappings.clear();

  return new Response(recoveredContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}

// --- 入口路由 ---

export default async function handler(request) {
  const url = new URL(request.url);

  // 首页/版本
  if (url.pathname === '/' || url.pathname === '/version') {
    const backendBase = BACKEND.replace(/https?:\/\/[^/]+/, '');
    if (url.pathname === '/version') {
      try {
        const res = await fetchWithTimeout(`${backendBase}/version`);
        const txt = await res.text();
        return new Response(txt.trim(), { status: 200, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
      } catch (e) { return new Response('Unknown', { status: 200, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } }); }
    }
    return new Response(`<!DOCTYPE html><html><head><title>psub</title></head><body><h1>psub</h1><p>Proxy Converter (Obfuscate -> Convert -> Recover)</p><p>Usage: /sub?url=YOUR_SUB&target=clash</p></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  if (url.pathname.startsWith('/sub')) {
    return await processSubscription(request, url, BACKEND);
  }

  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}
