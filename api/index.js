// Vercel Edge Function for psub - Simplified version
export const config = {
  runtime: 'edge',
  regions: ['hkg1', 'sin1', 'sfo1']
};

// Environment - set BACKEND in Vercel dashboard
const BACKEND = process.env.BACKEND || 'https://api.v1.mk';

function generateRandomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default async function handler(request) {
  const url = new URL(request.url);
  
  // Root - return frontend HTML
  if (url.pathname === '/' || url.pathname === '') {
    return new Response(`<!DOCTYPE html>
<html>
<head><title>psub</title></head>
<body>
<h1>psub - Subscription Converter</h1>
<p>Use: /sub?url=YOUR_SUBSCRIPTION_URL</p>
</body>
</html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  
  // Version endpoint
  if (url.pathname === '/version') {
    try {
      const backend = BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${backend}/version`, { signal: controller.signal });
      clearTimeout(timeoutId);
      const text = await response.text();
      return new Response(text, {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Subscription conversion
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub')) {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }
    
    // Forward to backend with all parameters
    const params = new URLSearchParams();
    params.set('url', targetUrl);
    
    // Forward all other parameters
    for (const [key, value] of url.searchParams) {
      if (key !== 'url') {
        params.set(key, value);
      }
    }
    
    const backendUrl = `${BACKEND}/sub?${params.toString()}`;
    
    try {
      const response = await fetch(backendUrl, {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
          'Accept': 'text/plain,*/*',
        }
      });
      
      const content = await response.text();
      
      return new Response(content, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'text/plain',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }
  
  return new Response('Not found', { status: 404 });
}
