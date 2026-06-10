export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sin2', 'sfo1', 'sfo2'],
};

// 全局默认后端（Vercel Dashboard 环境变量）
const DEFAULT_BACKEND = process.env.BACKEND || 'https://api.v1.mk';

// 请求级隔离缓存池（Edge 函数每次调用独立，请求结束自动清理）
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
const LINK_REGEX = /((?:$[\da-fA-F:]+$)|(?:[\da-fA-F:]+)|(?:[\d.]+)|(?:[\w\.-]+))/g;
const UUID_REGEX = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}/gi;

function applyObfuscationToContent(content, mappingTable) {
  if (!content) return '';
  let result = content.replace(LINK_REGEX, (match) => {
    const fake = generateRandomStr(10) + '.com';
    mappingTable[fake] = normalizeHost(match);
    return fake;
  });
  result = result.replace(UUID_REGEX, (match) => {
    const fake = generateRandomUUID();
    mappingTable[fake] = match;
    return fake;
  });
  return result;
}

function applyRecoveryToContent(content, mappingTable) {
  if (!content) return '';
  let result = content;
  for (const [fake, original] of Object.entries(mappingTable)) {
    if (!original || !fake) continue;
    result = result.replace(new RegExp(escapeRegExp(fake), 'g'), original);
  }
  return result;
}

function normalizeHost(host) {
  if (!host) return host;
  try { host = decodeURIComponent(host); } catch (e) {}
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
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
async function processSubscription(request, url, defaultBackend) {
  // 清理请求级状态
  requestScope.cache.clear();
  requestScope.mappings.clear();
  requestScope.cacheCounter = 0;

  // 🔧 临时后端覆盖功能：&bd=临时后端
  const bdParam = url.searchParams.get('bd');
  let effectiveBackend = defaultBackend;
  if (bdParam) {
    effectiveBackend = bdParam;
    // 安全校验：若包含协议头则视为绝对路径，否则视为相对路径或标识名
    if (bdParam.includes('://')) {
      try { new URL(bdParam); } catch { /* 允许非标准格式，后端容错处理 */ }
    }
  }

  const host = `${url.protocol}//${url.host}`;
  const targetUrl = url.searchParams.get('url') || url.searchParams.get('sub');
  const targetFormat = url.searchParams.get('target');
  const otherParams = new URLSearchParams(url.search);

  // 1. 无 URL 参数时，直接透传后端
  if (!targetUrl) {
    try {
      const backendUrl = `${effectiveBackend.replace(/https?:\/\/[^/]+/, '')}${url.pathname}${url.search}`;
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

  // 2. 预混淆：替换 IP/域名/UUID
  const rawLinks = targetUrl.split('|').filter(l => l.trim().length > 0);
  const obfuscatedContent = rawLinks.map(l => applyObfuscationToContent(l, requestScope.mappings)).join('\r\n');

  // 3. 构建临时映射缓存键
  const mappingKey = `map_${requestScope.cacheCounter++}`;
  requestScope.cache.set(mappingKey, requestScope.mappings);

  // 4. 拼接目标请求 URL（仅转发混淆后的内容）
  const params = new URLSearchParams(otherParams);
  params.set('url', obfuscatedContent);
  params.set('sub', obfuscatedContent);
  params.delete('target');
  const finalQuery = params.toString();
  const backendUrl = `${effectiveBackend.replace(/https?:\/\/[^/]+/, '')}${url.pathname}?${finalQuery}`;

  // 5. 转发请求至后端（使用临时后端）
  let backendRes = null;
  let backendContent = '';
  try {
    backendRes = await fetchWithTimeout(backendUrl);
    if (!backendRes.ok) throw new Error(`Backend conversion failed: ${backendRes.status}`);
    backendContent = await backendRes.text();
  } catch (e) {
    return new Response(`Conversion error: ${e.message}`, { status: 500 });
  }

  // 6. 后处理：恢复原始 IP/域名/UUID
  let recoveredContent = backendContent;
  if (requestScope.mappings.size > 0) {
    recoveredContent = applyRecoveryToContent(backendContent, requestScope.mappings);
  }

  // 7. 清理缓存，防止跨请求泄露
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
    if (url.pathname === '/version') {
      try {
        const res = await fetchWithTimeout(`${DEFAULT_BACKEND.replace(/https?:\/\/[^/]+/, '')}/version`);
        const txt = await res.text();
        return new Response(txt.trim(), { status: 200, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
      } catch (e) { return new Response('Unknown', { status: 200, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } }); }
    }
    return new Response(`<!DOCTYPE html><html><head><title>psub</title></head><body><h1>psub</h1><p>Proxy Converter (Obfuscate -> Convert -> Recover)</p><p>Usage: /sub?url=YOUR_SUB&target=clash&bd=临时后端</p></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  if (url.pathname.startsWith('/sub')) {
    // 将默认后端传入处理函数，函数内部会自动解析 &bd= 参数
    return await processSubscription(request, url, DEFAULT_BACKEND);
  }

  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}
