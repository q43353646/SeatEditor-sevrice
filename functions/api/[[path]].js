// Cloudflare Pages Functions — 统一处理 /api/* 请求
// 环境变量在 Cloudflare Pages 控制台 → Settings → Environment variables 中配置：
//   SUPABASE_URL         例: https://xxxx.supabase.co
//   SUPABASE_ANON_KEY    anon public key
//   SUPABASE_SERVICE_KEY service_role key（保密！）
//   JWT_SECRET           自定义随机字符串
//   SEAT_ROOM            默认房间ID，默认 default

const ROOM_DEFAULT = 'default';

// ---------- 工具函数 ----------

function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(secret, dataStr) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataStr));
  return b64urlEncode(sig);
}

async function hmacVerify(secret, dataStr, sigB64url) {
  const expected = await hmacSign(secret, dataStr);
  return expected === sigB64url;
}

async function signJWT(payload, secret) {
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, header + '.' + body);
  return header + '.' + body + '.' + sig;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const ok = await hmacVerify(secret, parts[0] + '.' + parts[1], parts[2]);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    return payload;
  } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function sbFetch(env, path, options = {}, useService = false) {
  const key = useService ? env.SUPABASE_SERVICE_KEY : env.SUPABASE_ANON_KEY;
  const headers = Object.assign({
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json'
  }, options.headers || {});
  const res = await fetch(env.SUPABASE_URL + '/rest/v1' + path, Object.assign({}, options, { headers }));
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

// ---------- 路由 ----------

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;        // /api/login, /api/users, /api/users/3, /api/query/138..., /api/config
  const method = request.method;
  const room = env.SEAT_ROOM || ROOM_DEFAULT;

  // CORS（同源其实不需要，加上以防万一）
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization'
      }
    });
  }

  try {
    // GET /api/config — 下发前端 Supabase 配置（anon key 公开）
    if (path === '/api/config' && method === 'GET') {
      return json({ url: env.SUPABASE_URL, key: env.SUPABASE_ANON_KEY, room });
    }

    // POST /api/login
    if (path === '/api/login' && method === 'POST') {
      const { username, password } = await request.json();
      const hash = await sha256Hex(password);
      const rows = await sbFetch(env, `/users?username=eq.${encodeURIComponent(username)}&select=*`, {}, true);
      if (!rows.length || rows[0].password_hash !== hash) {
        return json({ error: '用户名或密码错误' }, 401);
      }
      const token = await signJWT(
        { id: rows[0].id, username: rows[0].username, role: rows[0].role },
        env.JWT_SECRET
      );
      return json({ token, role: rows[0].role, username: rows[0].username });
    }

    // 以下接口需要登录
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const payload = token ? await verifyJWT(token, env.JWT_SECRET) : null;
    if (!payload) return json({ error: '未登录' }, 401);

    // GET /api/users — 用户列表（仅管理员）
    if (path === '/api/users' && method === 'GET') {
      if (payload.role !== 'admin') return json({ error: '无权限' }, 403);
      const rows = await sbFetch(env, '/users?select=id,username,role,created_at&order=id.desc', {}, true);
      return json(rows);
    }

    // POST /api/users — 新增用户（仅管理员）
    if (path === '/api/users' && method === 'POST') {
      if (payload.role !== 'admin') return json({ error: '无权限' }, 403);
      const { username, password, role } = await request.json();
      const hash = await sha256Hex(password);
      const row = await sbFetch(env, '/users', {
        method: 'POST',
        body: JSON.stringify({ username, password_hash: hash, role: role || 'user' })
      }, true);
      return json(row);
    }

    // DELETE /api/users/:id
    let m = path.match(/^\/api\/users\/(\d+)$/);
    if (m && method === 'DELETE') {
      if (payload.role !== 'admin') return json({ error: '无权限' }, 403);
      await sbFetch(env, `/users?id=eq.${m[1]}`, { method: 'DELETE' }, true);
      return json({ ok: true });
    }

    // GET /api/query/:phone — 按手机号查座位（登录用户可用）
    m = path.match(/^\/api\/query\/(.+)$/);
    if (m && method === 'GET') {
      const phone = m[1];
      const [mapRows, personRows] = await Promise.all([
        sbFetch(env, `/app_state?room=eq.${room}&select=data->publicMap`),
        sbFetch(env, `/people?room=eq.${room}&phone=eq.${encodeURIComponent(phone)}`)
      ]);
      return json({ publicMap: mapRows[0]?.publicMap || null, person: personRows[0] || null });
    }

    return json({ error: 'Not Found' }, 404);
  } catch (e) {
    return json({ error: e.message || 'Server Error' }, 500);
  }
}
