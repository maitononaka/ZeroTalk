const SESSION_TTL = 60 * 60 * 24 * 30;
const OAUTH_STATE_TTL = 60 * 10;
const AUTH_TICKET_TTL = 60 * 5;
const MAX_MESSAGE_LENGTH = 4000;

function now() { return Math.floor(Date.now() / 1000); }
function uuid() { return crypto.randomUUID(); }

function json(data, status = 200, origin = '*', extra = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'false',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    ...extra,
  });
  return new Response(JSON.stringify(data), { status, headers });
}

function redirect(url) {
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function randomSlug() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '').slice(0, 12);
}

async function createUser(env, { googleSub = null, displayName = '', avatarUrl = '' } = {}) {
  const id = uuid();
  const t = now();
  let slug = randomSlug();
  for (let i = 0; i < 4; i++) {
    const hit = await env.DB.prepare('SELECT id FROM users WHERE profile_slug = ?').bind(slug).first();
    if (!hit) break;
    slug = randomSlug();
  }
  await env.DB.prepare(`INSERT INTO users
    (id, google_sub, display_name, avatar_url, profile_slug, bio, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?)`)
    .bind(id, googleSub, displayName, avatarUrl, slug, t, t).run();
  return { id, google_sub: googleSub, display_name: displayName, avatar_url: avatarUrl, profile_slug: slug, bio: '' };
}

async function createSession(env, userId) {
  const id = uuid();
  const t = now();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? OR expires_at < ?').bind(userId, t).run();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, t + SESSION_TTL, t).run();
  return id;
}

async function getUserBySession(env, request) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const t = now();
  const row = await env.DB.prepare(`SELECT u.id, u.google_sub, u.display_name, u.avatar_url, u.profile_slug, u.bio
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`)
    .bind(token, t).first();
  return row || null;
}

async function requireUser(env, request) {
  const user = await getUserBySession(env, request);
  if (!user) throw json({ error: 'UNAUTHORIZED' }, 401, originFor(env, request));
  return user;
}

function originFor(env, request) {
  const origin = request.headers.get('origin');
  const allowed = new URL(env.APP_ORIGIN).origin;
  if (!origin) return allowed;
  return origin === allowed ? origin : allowed;
}

async function parseBody(request) {
  try { return await request.json(); } catch { return {}; }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = originFor(env, request);

  if (request.method === 'OPTIONS') return json({ ok: true }, 200, origin);

  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, service: 'zerochat-api', time: now() }, 200, origin);
  }

  if (path === '/api/session/anonymous' && request.method === 'POST') {
    const body = await parseBody(request);
    const deviceId = cleanText(body.device_id, 128);
    if (!deviceId) return json({ error: 'DEVICE_ID_REQUIRED' }, 400, origin);

    let deviceRow = await env.DB.prepare(`SELECT u.id, u.google_sub, u.display_name, u.avatar_url, u.profile_slug, u.bio
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id = ? AND s.expires_at > ?`)
      .bind(deviceId, 0).first();

    // device_id is not a session token; this lookup intentionally only checks a legacy placeholder and will usually miss.
    if (!deviceRow) deviceRow = await env.DB.prepare('SELECT id, google_sub, display_name, avatar_url, profile_slug, bio FROM users WHERE id = ?').bind('__never__').first();

    const user = await createUser(env, {});
    const token = await createSession(env, user.id);
    return json({ session_token: token, user }, 201, origin);
  }

  if (path === '/api/me' && request.method === 'GET') {
    const user = await getUserBySession(env, request);
    return json({ user }, 200, origin);
  }

  if (path === '/api/profile' && request.method === 'POST') {
    const user = await requireUser(env, request);
    const body = await parseBody(request);
    const displayName = cleanText(body.display_name, 60);
    const bio = cleanText(body.bio, 160);
    await env.DB.prepare('UPDATE users SET display_name = ?, bio = ?, updated_at = ? WHERE id = ?')
      .bind(displayName, bio, now(), user.id).run();
    const updated = await env.DB.prepare('SELECT id, google_sub, display_name, avatar_url, profile_slug, bio FROM users WHERE id = ?').bind(user.id).first();
    return json({ user: updated }, 200, origin);
  }

  if (path === '/api/auth/google/start' && request.method === 'POST') {
    const body = await parseBody(request);
    const deviceId = cleanText(body.device_id, 128);
    if (!deviceId) return json({ error: 'DEVICE_ID_REQUIRED' }, 400, origin);
    let currentUser = null;
    try { currentUser = await getUserBySession(env, request); } catch {}
    const state = uuid();
    const t = now();
    await env.DB.prepare(`INSERT INTO oauth_states (state, device_id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(state, deviceId, currentUser?.id ?? null, t + OAUTH_STATE_TTL, t).run();
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    google.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
    google.searchParams.set('response_type', 'code');
    google.searchParams.set('scope', 'openid profile');
    google.searchParams.set('state', state);
    google.searchParams.set('access_type', 'online');
    google.searchParams.set('prompt', 'select_account');
    return json({ url: google.toString() }, 200, origin);
  }

  if (path === '/api/auth/google/callback' && request.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return new Response('Missing OAuth response.', { status: 400 });
    const stateRow = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?').bind(state, now()).first();
    await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    if (!stateRow) return new Response('OAuth state expired or invalid.', { status: 400 });

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResp.ok) return new Response('Google token exchange failed.', { status: 502 });
    const token = await tokenResp.json();
    const infoResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!infoResp.ok) return new Response('Google userinfo failed.', { status: 502 });
    const info = await infoResp.json();
    const googleSub = String(info.sub || '');
    if (!googleSub) return new Response('Google account id missing.', { status: 400 });

    const t = now();
    let user = await env.DB.prepare('SELECT id, google_sub, display_name, avatar_url, profile_slug, bio FROM users WHERE google_sub = ?').bind(googleSub).first();

    if (!user && stateRow.user_id) {
      const current = await env.DB.prepare('SELECT id, google_sub, display_name, avatar_url, profile_slug, bio FROM users WHERE id = ?').bind(stateRow.user_id).first();
      if (current && !current.google_sub) {
        await env.DB.prepare('UPDATE users SET google_sub=?, display_name=?, avatar_url=?, updated_at=? WHERE id=?')
          .bind(googleSub, cleanText(info.name || current.display_name, 60), cleanText(info.picture || current.avatar_url, 500), t, current.id).run();
        user = await env.DB.prepare('SELECT id, google_sub, display_name, avatar_url, profile_slug, bio FROM users WHERE id = ?').bind(current.id).first();
      }
    }

    if (!user) {
      user = await createUser(env, {
        googleSub,
        displayName: cleanText(info.name, 60),
        avatarUrl: cleanText(info.picture, 500),
      });
    }

    const ticket = uuid();
    await env.DB.prepare(`INSERT INTO auth_tickets (ticket, device_id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(ticket, stateRow.device_id, user.id, t + AUTH_TICKET_TTL, t).run();
    return redirect(`${env.APP_URL}/#auth=${encodeURIComponent(ticket)}`);
  }

  if (path === '/api/auth/google/exchange' && request.method === 'POST') {
    const body = await parseBody(request);
    const deviceId = cleanText(body.device_id, 128);
    const ticket = cleanText(body.ticket, 128);
    if (!deviceId || !ticket) return json({ error: 'MISSING_TICKET' }, 400, origin);
    const row = await env.DB.prepare(`SELECT ticket, device_id, user_id FROM auth_tickets WHERE ticket = ? AND device_id = ? AND expires_at > ?`)
      .bind(ticket, deviceId, now()).first();
    if (!row) return json({ error: 'INVALID_TICKET' }, 401, origin);
    await env.DB.prepare('DELETE FROM auth_tickets WHERE ticket = ?').bind(ticket).run();
    const session = await createSession(env, row.user_id);
    const user = await env.DB.prepare('SELECT id, google_sub, display_name, avatar_url, profile_slug, bio FROM users WHERE id = ?').bind(row.user_id).first();
    return json({ session_token: session, user }, 200, origin);
  }

  if (path === '/api/chats' && request.method === 'GET') {
    const user = await requireUser(env, request);
    const rows = await env.DB.prepare(`SELECT c.id, c.retention_seconds, c.updated_at,
      CASE WHEN c.user_a = ? THEN u2.id ELSE u1.id END AS other_id,
      CASE WHEN c.user_a = ? THEN u2.display_name ELSE u1.display_name END AS other_name,
      CASE WHEN c.user_a = ? THEN u2.avatar_url ELSE u1.avatar_url END AS other_avatar,
      CASE WHEN c.user_a = ? THEN u2.profile_slug ELSE u1.profile_slug END AS other_slug,
      (SELECT body FROM messages m WHERE m.chat_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages m WHERE m.chat_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message_at
      FROM chats c
      JOIN users u1 ON u1.id=c.user_a JOIN users u2 ON u2.id=c.user_b
      WHERE c.user_a=? OR c.user_b=? ORDER BY c.updated_at DESC`)
      .bind(user.id,user.id,user.id,user.id,user.id,user.id).all();
    return json({ chats: rows.results }, 200, origin);
  }

  if (path === '/api/chats' && request.method === 'POST') {
    const user = await requireUser(env, request);
    const body = await parseBody(request);
    const contact = cleanText(body.contact, 80);
    const retention = Number(body.retention_seconds);
    const retentionSeconds = [3600, 86400, 604800].includes(retention) ? retention : 86400;
    if (!contact) return json({ error: 'CONTACT_REQUIRED' }, 400, origin);
    const other = await env.DB.prepare('SELECT id, display_name, avatar_url, profile_slug FROM users WHERE profile_slug=?').bind(contact).first();
    if (!other) return json({ error: 'CONTACT_NOT_FOUND' }, 404, origin);
    if (other.id === user.id) return json({ error: 'SELF_CHAT' }, 400, origin);
    const [a, b] = [user.id, other.id].sort();
    let chat = await env.DB.prepare('SELECT id, retention_seconds FROM chats WHERE user_a=? AND user_b=?').bind(a,b).first();
    if (!chat) {
      const id = uuid();
      const t = now();
      await env.DB.prepare(`INSERT INTO chats (id,user_a,user_b,retention_seconds,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
        .bind(id,a,b,retentionSeconds,t,t).run();
      chat = { id, retention_seconds: retentionSeconds };
    } else {
      await env.DB.prepare('UPDATE chats SET retention_seconds=?, updated_at=? WHERE id=?').bind(retentionSeconds, now(), chat.id).run();
    }
    return json({ chat, other }, 201, origin);
  }

  const chatMatch = path.match(/^\/api\/chats\/([^/]+)(?:\/messages)?$/);
  const messagesMatch = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (chatMatch) {
    const chatId = chatMatch[1];
    const user = await requireUser(env, request);
    const chat = await env.DB.prepare(`SELECT id, user_a, user_b, retention_seconds, created_at, updated_at FROM chats
      WHERE id=? AND (user_a=? OR user_b=?)`).bind(chatId,user.id,user.id).first();
    if (!chat) return json({ error: 'CHAT_NOT_FOUND' }, 404, origin);

    if (messagesMatch && request.method === 'GET') {
      const after = Math.max(0, Number(url.searchParams.get('after') || 0));
      await env.DB.prepare('DELETE FROM messages WHERE expires_at <= ?').bind(now()).run();
      const rows = await env.DB.prepare(`SELECT m.id,m.chat_id,m.sender_id,m.body,m.created_at,
        u.display_name AS sender_name, u.avatar_url AS sender_avatar
        FROM messages m JOIN users u ON u.id=m.sender_id
        WHERE m.chat_id=? AND m.id>? AND m.expires_at>? ORDER BY m.id ASC LIMIT 200`)
        .bind(chatId,after,now()).all();
      return json({ messages: rows.results }, 200, origin);
    }

    if (messagesMatch && request.method === 'POST') {
      const body = await parseBody(request);
      const text = cleanText(body.body, MAX_MESSAGE_LENGTH);
      if (!text) return json({ error: 'EMPTY_MESSAGE' }, 400, origin);
      const t = now();
      await env.DB.prepare(`INSERT INTO messages (chat_id,sender_id,body,created_at,expires_at) VALUES (?,?,?,?,?)`)
        .bind(chatId,user.id,text,t,t + chat.retention_seconds).run();
      await env.DB.prepare('UPDATE chats SET updated_at=? WHERE id=?').bind(t,chatId).run();
      const msg = await env.DB.prepare(`SELECT m.id,m.chat_id,m.sender_id,m.body,m.created_at,u.display_name AS sender_name,u.avatar_url AS sender_avatar
        FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=last_insert_rowid()`).first();
      return json({ message: msg }, 201, origin);
    }

    if (request.method === 'DELETE' && !messagesMatch) {
      await env.DB.prepare('DELETE FROM chats WHERE id=?').bind(chatId).run();
      return json({ ok: true }, 200, origin);
    }
  }

  return json({ error: 'NOT_FOUND' }, 404, origin);
}

export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) return await handleApi(request, env);
      return new Response('ZeroChat API', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (err) {
      console.error(err);
      const origin = env.APP_ORIGIN || '*';
      if (err instanceof Response) return err;
      return json({ error: 'INTERNAL_ERROR' }, 500, origin);
    }
  },

  async scheduled(_event, env) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE expires_at <= ?').bind(t),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(t),
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(t),
      env.DB.prepare('DELETE FROM auth_tickets WHERE expires_at <= ?').bind(t),
    ]);
  },
};
