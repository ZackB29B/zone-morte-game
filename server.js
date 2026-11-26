const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { pingInterval: 25000, pingTimeout: 60000 });
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.AUTH_DATA_DIR || path.join(__dirname, "data");
const usersFile = path.join(dataDir, "users.json");
const scrypt = promisify(crypto.scrypt);

app.use(express.json({ limit: "10kb" }));

// Stockage Supabase (prioritaire). En développement sans variables, conserve le
// mode fichier local pour ne pas bloquer le lancement du jeu.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
let users = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(usersFile, "utf8"));
  if (Array.isArray(saved)) users = new Map(saved.map(user => [user.usernameKey, user]));
} catch (error) {
  if (error.code !== "ENOENT") console.error("Impossible de lire l'ancienne base locale:", error.message);
}
let usersWriteQueue = Promise.resolve();
function persistUsers() {
  usersWriteQueue = usersWriteQueue.then(async () => {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const temp = usersFile + ".tmp";
    await fs.promises.writeFile(temp, JSON.stringify([...users.values()]), { mode: 0o600 });
    await fs.promises.rename(temp, usersFile);
  });
  return usersWriteQueue;
}
async function supabaseRequest(table, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${options.query || ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.hint || `Supabase HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function findUser(usernameKey) {
  if (!useSupabase) return users.get(usernameKey) || null;
  const rows = await supabaseRequest("zm_users", { query: `?select=username,username_key,salt,password_hash,data&username_key=eq.${encodeURIComponent(usernameKey)}&limit=1` });
  const row = rows && rows[0];
  return row ? { username: row.username, usernameKey: String(row.username_key || row.username || "").toLowerCase(), salt: row.salt, passwordHash: row.password_hash, data: row.data || {} } : null;
}
async function findUserByUsername(username) {
  const key = String(username || "").trim().toLowerCase();
  const exact = await findUser(key);
  if (exact) return exact;
  if (!useSupabase || !key) return null;
  const params = new URLSearchParams({ select: "username,username_key,salt,password_hash,data", username: `ilike.${key}`, limit: "1" });
  const rows = await supabaseRequest("zm_users", { query: `?${params.toString()}` });
  const row = rows && rows[0];
  return row ? { username: row.username, usernameKey: String(row.username_key || row.username || "").toLowerCase(), salt: row.salt, passwordHash: row.password_hash, data: row.data || {} } : null;
}
async function createUser(user) {
  if (!useSupabase) {
    if (users.has(user.usernameKey)) return false;
    users.set(user.usernameKey, user);
    await persistUsers();
    return true;
  }
  try {
    await supabaseRequest("zm_users", { method: "POST", prefer: "return=minimal", body: {
      username: user.username, username_key: user.usernameKey, salt: user.salt,
      password_hash: user.passwordHash, data: user.data
    }});
    return true;
  } catch (error) {
    if (error.status === 409) return false;
    throw error;
  }
}
async function saveUserData(usernameKey, data) {
  if (!useSupabase) {
    const user = users.get(usernameKey);
    if (!user) return false;
    user.data = data;
    await persistUsers();
    return true;
  }
  await supabaseRequest("zm_users", { method: "PATCH", query: `?username_key=eq.${encodeURIComponent(usernameKey)}`, prefer: "return=minimal", body: { data } });
  return true;
}

// Profil spécial demandé pour le compte ZackB29B : grade Ghost et niveau 20 minimum.
// Les statistiques, armes et données sociales existantes sont conservées.
async function applyZackGhostProfile(user) {
  if (!user || String(user.usernameKey || user.username || "").toLowerCase() !== "zackb29b") return user;
  const data = { ...(user.data || {}), xp: Math.max(180500, Number(user.data && user.data.xp) || 0), rankTitle: "Ghost" };
  await saveUserData("zackb29b", data);
  user.data = data;
  return user;
}
async function findUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!useSupabase) {
    for (const user of users.values()) {
      if (String(user.data?.email || "").toLowerCase() === normalized) return user;
    }
    return null;
  }
  const params = new URLSearchParams({ select: "username,username_key,salt,password_hash,data", "data->>email": `eq.${normalized}`, limit: "1" });
  const rows = await supabaseRequest("zm_users", { query: `?${params.toString()}` });
  const row = rows && rows[0];
  return row ? { username: row.username, usernameKey: String(row.username_key || row.username || "").toLowerCase(), salt: row.salt, passwordHash: row.password_hash, data: row.data || {} } : null;
}
async function updateUserPassword(user, salt, passwordHash, data) {
  if (!useSupabase) {
    const stored = users.get(user.usernameKey);
    if (!stored) return false;
    stored.salt = salt;
    stored.passwordHash = passwordHash;
    stored.data = data;
    await persistUsers();
    return true;
  }
  await supabaseRequest("zm_users", { method: "PATCH", query: `?username_key=eq.${encodeURIComponent(user.usernameKey)}`, prefer: "return=minimal", body: { salt, password_hash: passwordHash, data } });
  return true;
}
function gmailConfigured() {
  return Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_USER);
}
async function sendGmailMessage(to, subject, textBody) {
  if (!gmailConfigured()) throw new Error("Configuration Gmail API incomplète");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) throw new Error(`Échec OAuth Gmail (${tokenResponse.status}): ${tokenData.error || "jeton absent"}`);
  const from = process.env.GMAIL_USER;
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const rawMessage = [
    `From: Zone Morte <${from}>`, `To: ${to}`, `Subject: ${subjectEncoded}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "",
    textBody
  ].join("\r\n");
  const raw = Buffer.from(rawMessage, "utf8").toString("base64url");
  const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw })
  });
  if (!sendResponse.ok) {
    const detail = await sendResponse.text();
    throw new Error(`Échec API Gmail (${sendResponse.status}): ${detail.slice(0, 500)}`);
  }
}
if (useSupabase) console.log("Stockage des comptes activé : Supabase.");
else console.warn("Supabase non configuré : stockage local temporaire. Configure SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sur Render.");

// Sessions opaques conservées en mémoire (une relance du serveur déconnecte les comptes).
const sessions = new Map();
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();
function getCookie(req, name) {
  const entry = (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `zm_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
}
function currentUser(req) {
  const token = getCookie(req, "zm_session");
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  return session.username;
}
function authRateLimited(req) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  let item = authAttempts.get(ip);
  if (!item || item.until <= now) item = { count: 0, until: now + 15 * 60 * 1000 };
  item.count++;
  authAttempts.set(ip, item);
  return item.count > 20;
}
function issueSession(res, username) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_MS });
  setSessionCookie(res, token);
}

app.post("/api/auth/register", async (req, res) => {
  try {
    if (authRateLimited(req)) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Entre une adresse e-mail valide." });
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Le pseudo doit contenir 3 à 20 caractères (lettres, chiffres ou _)." });
    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 128) return res.status(400).json({ error: "Le mot de passe doit contenir entre 8 et 128 caractères." });
    if (password !== confirmPassword) return res.status(400).json({ error: "Les mots de passe ne correspondent pas." });
    const usernameKey = username.toLowerCase();
    if (await findUser(usernameKey)) return res.status(409).json({ error: "Ce pseudo est déjà utilisé." });
    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    const user = {
      username, usernameKey, salt: salt.toString("hex"), passwordHash: passwordHash.toString("hex"),
      data: { email, weapons: { pistol: 1 }, unlocked: { pistol: true }, loadout: 'pistol', loadoutSlots: ['pistol'], xp: 0, games: 0, wins: 0, kills: 0 }
    };
    if (!(await createUser(user))) return res.status(409).json({ error: "Ce pseudo est déjà utilisé." });
    issueSession(res, username);
    res.status(201).json({ username });
  } catch (error) {
    console.error("Erreur inscription:", error);
    res.status(500).json({ error: "Impossible de créer le compte pour le moment. Vérifie la configuration Supabase." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (authRateLimited(req)) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = await findUser(username.toLowerCase());
    if (!user || Buffer.byteLength(password, "utf8") > 128) return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    const candidate = await scrypt(password, Buffer.from(user.salt, "hex"), 64);
    const expected = Buffer.from(user.passwordHash, "hex");
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    }
    await applyZackGhostProfile(user);
    issueSession(res, user.username);
    res.json({ username: user.username });
  } catch (error) {
    console.error("Erreur connexion:", error);
    res.status(500).json({ error: "Impossible de se connecter pour le moment." });
  }
});


app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    if (authRateLimited(req)) return res.status(429).json({ error: "Trop de demandes. Réessaie dans quelques minutes." });
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Adresse e-mail invalide." });
    // Réponse identique que l'adresse existe ou non pour ne pas révéler les comptes.
    const user = await findUserByEmail(email);
    if (user) {
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + 30 * 60 * 1000;
      const data = { ...(user.data || {}), passwordResetHash: crypto.createHash("sha256").update(token).digest("hex"), passwordResetExpires: expiresAt };
      await saveUserData(user.usernameKey, data);
      const baseUrl = (process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
      const resetUrl = `${baseUrl}/?reset_user=${encodeURIComponent(user.username)}&reset_token=${encodeURIComponent(token)}`;
      const message = `Bonjour ${user.username},\n\nTu as demandé à réinitialiser le mot de passe de ton compte Zone Morte.\n\nOuvre ce lien dans les 30 minutes :\n${resetUrl}\n\nSi tu n'es pas à l'origine de cette demande, ignore cet e-mail. Ton mot de passe ne changera pas.\n\nZone Morte`;
      await sendGmailMessage(email, "Réinitialisation du mot de passe - Zone Morte", message);
    }
    return res.json({ ok: true, message: "Si cette adresse est associée à un compte, un e-mail sera envoyé." });
  } catch (error) {
    console.error("Erreur récupération mot de passe:", error);
    return res.status(503).json({ error: "L'envoi de l'e-mail est temporairement indisponible. Réessaie plus tard." });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    if (authRateLimited(req)) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";
    if (!username || !/^[A-Za-z0-9_]{3,20}$/.test(username) || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return res.status(400).json({ error: "Lien de réinitialisation invalide." });
    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 128) return res.status(400).json({ error: "Le mot de passe doit contenir entre 8 et 128 caractères." });
    if (password !== confirmPassword) return res.status(400).json({ error: "Les mots de passe ne correspondent pas." });
    const user = await findUserByUsername(username);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    if (!user || !user.data?.passwordResetHash || user.data.passwordResetHash !== tokenHash || Number(user.data.passwordResetExpires || 0) < Date.now()) {
      return res.status(400).json({ error: "Ce lien est invalide ou a expiré. Demande un nouvel e-mail." });
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    const data = { ...(user.data || {}) };
    delete data.passwordResetHash;
    delete data.passwordResetExpires;
    await updateUserPassword(user, salt.toString("hex"), passwordHash.toString("hex"), data);
    issueSession(res, user.username);
    return res.json({ ok: true, username: user.username });
  } catch (error) {
    console.error("Erreur réinitialisation mot de passe:", error);
    return res.status(500).json({ error: "Impossible de réinitialiser le mot de passe pour le moment." });
  }
});

app.get("/api/auth/me", (req, res) => {
  const username = currentUser(req);
  if (!username) return res.status(401).json({ error: "Non connecté." });
  res.json({ username });
});

app.post("/api/auth/logout", (req, res) => {
  sessions.delete(getCookie(req, "zm_session"));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `zm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  res.json({ ok: true });
});

// --- Social : recherche de pseudos et demandes d'amis stockées dans les données du compte ---
function socialFor(user) {
  const raw = user.data && user.data.social && typeof user.data.social === "object" ? user.data.social : {};
  return {
    friends: Array.isArray(raw.friends) ? raw.friends : [],
    incoming: Array.isArray(raw.incoming) ? raw.incoming : [],
    outgoing: Array.isArray(raw.outgoing) ? raw.outgoing : []
  };
}
async function saveSocial(user, social) {
  const data = { ...(user.data || {}), social };
  await saveUserData(user.usernameKey, data);
  user.data = data;
}
function socialUser(req) {
  const username = currentUser(req);
  return username ? findUser(username.toLowerCase()) : null;
}
app.get("/api/social/search", async (req, res) => {
  try {
    const me = await socialUser(req);
    if (!me) return res.status(401).json({ error: "Connecte-toi pour utiliser le social." });
    const rawQ = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const q = rawQ.replace(/[^a-z0-9_]/g, "");
    if (q.length < 2) return res.json({ results: [] });
    if (q.length > 20) return res.status(400).json({ error: "Pseudo trop long." });
    const mine = socialFor(me);
    let matches;
    if (useSupabase) {
      // Recherche directe dans Supabase par pseudo normalisé, insensible à la casse.
      const params = new URLSearchParams({
        select: "username,username_key",
        username_key: `ilike.%${q}%`,
        limit: "30"
      });
      const rows = await supabaseRequest("zm_users", { query: `?${params.toString()}` });
      const seen = new Set();
      matches = (Array.isArray(rows) ? rows : []).map(row => ({
        username: row.username,
        usernameKey: String(row.username_key || row.username || "").toLowerCase()
      })).filter(u => u.username && u.usernameKey && !seen.has(u.usernameKey) && seen.add(u.usernameKey));
    } else {
      matches = [...users.values()].map(u => ({ username: u.username, usernameKey: String(u.usernameKey || u.username || "").toLowerCase() }))
        .filter(u => u.username && u.usernameKey.includes(q));
    }
    const results = matches.filter(u => u.usernameKey !== me.usernameKey).slice(0, 15).map(u => ({
      username: u.username,
      status: mine.friends.includes(u.usernameKey) ? "friend" : mine.outgoing.includes(u.usernameKey) ? "pending" : mine.incoming.includes(u.usernameKey) ? "incoming" : "none"
    }));
    res.json({ results });
  } catch (error) {
    console.error("Erreur recherche sociale:", error);
    res.status(500).json({ error: "Recherche impossible pour le moment." });
  }
});
app.get("/api/social/requests", async (req, res) => {
  try {
    const me = await socialUser(req);
    if (!me) return res.status(401).json({ error: "Connecte-toi pour utiliser le social." });
    const s = socialFor(me);
    // Même hors ligne, les demandes restent sauvegardées dans la ligne du compte.
    // Si le nom d'un compte ne se résout pas, renvoie la clé enregistrée plutôt que undefined.
    const names = async keys => (await Promise.all(keys.map(async key => {
      const account = await findUser(String(key || "").toLowerCase());
      return account && account.username ? account.username : String(key || "");
    }))).filter(Boolean);
    res.json({ friends: await names(s.friends), incoming: await names(s.incoming), outgoing: await names(s.outgoing) });
  } catch (error) { console.error("Erreur demandes sociales:", error); res.status(500).json({ error: "Impossible de charger tes demandes." }); }
});
app.post("/api/social/request", async (req, res) => {
  try {
    const me = await socialUser(req);
    if (!me) return res.status(401).json({ error: "Connecte-toi pour utiliser le social." });
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Pseudo invalide." });
    const target = await findUserByUsername(username);
    if (!target) return res.status(404).json({ error: "Aucun compte avec ce pseudo." });
    if (target.usernameKey === me.usernameKey) return res.status(400).json({ error: "Tu ne peux pas t'ajouter toi-même." });
    const mine = socialFor(me), theirs = socialFor(target);
    if (mine.friends.includes(target.usernameKey)) return res.status(409).json({ error: "Ce joueur est déjà ton ami." });
    if (mine.outgoing.includes(target.usernameKey)) return res.status(409).json({ error: "Une demande est déjà en attente." });
    if (mine.incoming.includes(target.usernameKey)) return res.status(409).json({ error: "Ce joueur t'a déjà envoyé une demande : accepte-la dans Demandes reçues." });
    mine.outgoing.push(target.usernameKey); theirs.incoming.push(me.usernameKey);
    await saveSocial(me, mine); await saveSocial(target, theirs);
    res.status(201).json({ ok: true });
  } catch (error) { console.error("Erreur envoi demande:", error); res.status(500).json({ error: "Impossible d'envoyer la demande." }); }
});
app.post("/api/social/respond", async (req, res) => {
  try {
    const me = await socialUser(req);
    if (!me) return res.status(401).json({ error: "Connecte-toi pour utiliser le social." });
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const target = await findUserByUsername(username);
    if (!target || target.usernameKey === me.usernameKey) return res.status(404).json({ error: "Demande introuvable." });
    const mine = socialFor(me), theirs = socialFor(target);
    if (!mine.incoming.includes(target.usernameKey)) return res.status(404).json({ error: "Cette demande n'est plus disponible." });
    mine.incoming = mine.incoming.filter(k => k !== target.usernameKey);
    theirs.outgoing = theirs.outgoing.filter(k => k !== me.usernameKey);
    if (req.body.accept === true) { mine.friends.push(target.usernameKey); theirs.friends.push(me.usernameKey); }
    await saveSocial(me, mine); await saveSocial(target, theirs);
    res.json({ ok: true, accepted: req.body.accept === true });
  } catch (error) { console.error("Erreur réponse demande:", error); res.status(500).json({ error: "Impossible de traiter la demande." }); }
});

// --- Codes de récompense : gérés côté serveur, une utilisation par compte et par code ---
const REWARD_CODES = ['ANIEL26', 'ZONE26', 'DROP2026'];
const RANDOM_REWARD_POOL = ['pistol_mk2', 'pistol_heavy', 'pistol_silenced', 'smg_vector', 'smg_mp5', 'rifle', 'rifle_burst', 'rifle_scar', 'rifle_aug', 'shotgun', 'shotgun_auto', 'shotgun_slug', 'shotgun_tactical', 'dmr_scout', 'sniper', 'sniper_dragunov'];
const BOSS_REWARD_CODE = 'BOSS26';
const BOSS_REWARD_USER = 'zackb29b';
app.post('/api/redeem-code', async (req, res) => {
  try {
    const username = currentUser(req);
    if (!username) return res.status(401).json({ error: 'Connecte-toi pour utiliser un code.' });
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    const isBoss = code === BOSS_REWARD_CODE;
    if (!REWARD_CODES.includes(code) && !isBoss) return res.status(400).json({ error: 'Code invalide.' });
    if (isBoss && username.toLowerCase() !== BOSS_REWARD_USER) return res.status(403).json({ error: 'Ce code est réservé au compte ZackB29B.' });
    const user = await findUser(username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    const data = user.data || {};
    const redeemed = Array.isArray(data.redeemedCodes) ? data.redeemedCodes : [];
    if (redeemed.includes(code)) return res.status(409).json({ error: 'Tu as déjà utilisé ce code.' });
    const weaponId = isBoss ? 'sniper_heavy' : RANDOM_REWARD_POOL[crypto.randomInt(RANDOM_REWARD_POOL.length)];
    const weapons = { ...(data.weapons || { pistol: 1 }) };
    const unlocked = { pistol: true, ...(data.unlocked || {}) };
    const slots = Array.isArray(data.loadoutSlots) ? [...data.loadoutSlots] : ['pistol'];
    weapons[weaponId] = (weapons[weaponId] || 0) + 1;
    unlocked[weaponId] = true;
    if (!slots.includes(weaponId) && slots.length < 6) slots.push(weaponId);
    const updated = { ...data, weapons, unlocked, loadoutSlots: slots.slice(0, 6), loadout: data.loadout || 'pistol', redeemedCodes: [...redeemed, code] };
    await saveUserData(username.toLowerCase(), updated);
    res.json({ ok: true, code, weaponId, message: isBoss ? 'Récompense spéciale accordée !' : 'Code validé : arme débloquée !', data: updated });
  } catch (error) {
    console.error('Erreur code récompense:', error);
    res.status(500).json({ error: 'Impossible de valider le code pour le moment.' });
  }
});

// --- Synchronisation des données de jeu utilisateur ---
app.get("/api/user/data", async (req, res) => {
  try {
    const username = currentUser(req);
    if (!username) return res.status(401).json({ error: "Non connecté." });
    let user = await findUser(username.toLowerCase());
    if (user) user = await applyZackGhostProfile(user);
    res.json(user ? (user.data || { weapons: { pistol: 1 }, unlocked: { pistol: true }, loadout: 'pistol', loadoutSlots: ['pistol'], xp: 0, games: 0, wins: 0, kills: 0 }) : {});
  } catch (error) {
    console.error("Erreur lecture progression:", error);
    res.status(500).json({ error: "Impossible de charger la progression." });
  }
});

app.post("/api/user/data", async (req, res) => {
  try {
    const username = currentUser(req);
    if (!username) return res.status(401).json({ error: "Non connecté." });
    const user = await findUser(username.toLowerCase());
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
    const bodyData = req.body;
    let data = user.data || { weapons: { pistol: 1 }, unlocked: { pistol: true }, loadout: 'pistol', loadoutSlots: ['pistol'], xp: 0, games: 0, wins: 0, kills: 0 };
    if (bodyData && typeof bodyData === "object" && !Array.isArray(bodyData)) {
      data = {
        ...(user.data || {}),
        weapons: (bodyData.weapons && typeof bodyData.weapons === "object" && !Array.isArray(bodyData.weapons)) ? bodyData.weapons : (data.weapons || { pistol: 1 }),
        unlocked: (bodyData.unlocked && typeof bodyData.unlocked === 'object' && !Array.isArray(bodyData.unlocked)) ? { pistol: true, ...bodyData.unlocked } : (data.unlocked || { pistol: true }),
        loadout: ['pistol', 'pistol_mk2', 'pistol_heavy', 'pistol_silenced', 'rifle', 'rifle_burst', 'rifle_scar', 'rifle_aug', 'rifle_lmg', 'smg_vector', 'smg_mp5', 'shotgun', 'shotgun_auto', 'shotgun_slug', 'shotgun_tactical', 'sniper', 'sniper_heavy', 'dmr_scout', 'sniper_dragunov'].includes(bodyData.loadout) ? bodyData.loadout : (data.loadout || 'pistol'),
        loadoutSlots: Array.isArray(bodyData.loadoutSlots) ? [...new Set(bodyData.loadoutSlots.filter(k => ['pistol', 'pistol_mk2', 'pistol_heavy', 'pistol_silenced', 'rifle', 'rifle_burst', 'rifle_scar', 'rifle_aug', 'rifle_lmg', 'smg_vector', 'smg_mp5', 'shotgun', 'shotgun_auto', 'shotgun_slug', 'shotgun_tactical', 'sniper', 'sniper_heavy', 'dmr_scout', 'sniper_dragunov'].includes(k)))].slice(0, 6) : (data.loadoutSlots || ['pistol']),
        xp: Number.isFinite(Number(bodyData.xp)) ? Math.max(0, Number(bodyData.xp)) : (data.xp || 0),
        games: Number.isFinite(Number(bodyData.games)) ? Math.max(0, Number(bodyData.games)) : (data.games || 0),
        wins: Number.isFinite(Number(bodyData.wins)) ? Math.max(0, Number(bodyData.wins)) : (data.wins || 0),
        kills: Number.isFinite(Number(bodyData.kills)) ? Math.max(0, Number(bodyData.kills)) : (data.kills || 0),
        social: (user.data && user.data.social && typeof user.data.social === "object") ? user.data.social : (data.social || { friends: [], incoming: [], outgoing: [] }),
        redeemedCodes: Array.isArray(user.data && user.data.redeemedCodes) ? user.data.redeemedCodes : (Array.isArray(data.redeemedCodes) ? data.redeemedCodes : [])
      };
      data.loadoutSlots = data.loadoutSlots.filter(k => k === 'pistol' || (data.unlocked && data.unlocked[k]));
      if (!data.loadoutSlots.includes('pistol')) data.loadoutSlots.unshift('pistol');
      data.loadoutSlots = data.loadoutSlots.slice(0, 6);
      if (!data.unlocked || !data.unlocked[data.loadout]) data.loadout = data.loadoutSlots[0] || "pistol";
      data.unlocked = { pistol: true, ...data.unlocked };
      await saveUserData(username.toLowerCase(), data);
    }
    res.json({ ok: true, data });
  } catch (error) {
    console.error("Erreur sauvegarde progression:", error);
    res.status(500).json({ error: "Impossible de sauvegarder la progression." });
  }
});

// La page de jeu (public/index.html) et grenades.js sont servis tels quels : plus d'injection côté serveur.
app.use(express.static(publicDir));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "jeu-multijoueur", pid: process.pid, online: typeof onlineApi !== "undefined" ? onlineApi.stats() : null }));

// Structure : roomId -> Map(socketId -> données du joueur)
const rooms = new Map();
function cleanRoomId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id) ? id : null;
}
function getRoomPlayers(roomId) {
  const room = rooms.get(roomId);
  return room ? Array.from(room.values()) : [];
}

io.on("connection", socket => {
  let currentRoom = null;
  socket.on("join-room", (rawRoomId, callback) => {
    const roomId = cleanRoomId(rawRoomId);
    if (!roomId) {
      if (typeof callback === "function") callback({ ok: false, error: "Identifiant de salon invalide." });
      return;
    }
    if (currentRoom) leaveCurrentRoom();
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const player = { id: socket.id, x: 100, y: 100 };
    rooms.get(roomId).set(socket.id, player);
    currentRoom = roomId;
    socket.join(roomId);
    if (typeof callback === "function") callback({ ok: true, playerId: socket.id, players: getRoomPlayers(roomId) });
    socket.to(roomId).emit("player-joined", player);
  });
  socket.on("player-move", position => {
    if (!currentRoom || !position || typeof position !== "object") return;
    const x = Number(position.x), y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) return;
    const room = rooms.get(currentRoom), player = room && room.get(socket.id);
    if (!player) return;
    player.x = x; player.y = y;
    socket.to(currentRoom).emit("player-moved", { id: socket.id, x, y });
  });
  socket.on("leave-room", leaveCurrentRoom);
  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const roomId = currentRoom, room = rooms.get(roomId);
    socket.leave(roomId);
    if (room) {
      room.delete(socket.id);
      socket.to(roomId).emit("player-left", { id: socket.id });
      if (room.size === 0) rooms.delete(roomId);
    }
    currentRoom = null;
  }
  socket.on("disconnect", leaveCurrentRoom);
});

// Mode en ligne : recherche de partie, salons entre amis, relais de partie (voir online.js).
// Si le joueur est connecté (cookie de session), son pseudo de compte est utilisé en ligne.
const onlineApi = require("./online")(io, {
  getAccount: socket => {
    const session = sessions.get(getCookie({ headers: socket.request.headers }, "zm_session"));
    return session && session.expiresAt > Date.now() ? session.username : null;
  }
});

httpServer.listen(PORT, "0.0.0.0", () => console.log(`Serveur multijoueur prêt sur le port ${PORT}`));
