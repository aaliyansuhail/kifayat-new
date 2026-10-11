// TEMP: derive the Firebase *web* app config (public) from the service account.
require("dotenv").config();
const { GoogleAuth } = require("google-auth-library");

const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
// Same normalization firebaseAdmin.js applies (literal \\n -> real newline).
if (SA.private_key) SA.private_key = SA.private_key.replace(/\\n/g, "\n");
const PROJECT = SA.project_id;

// Prove the key parses before spending a network round-trip.
require("crypto").createPrivateKey(SA.private_key);
console.log("private key parses OK");
const BASE = "https://firebase.googleapis.com/v1beta1";

async function token() {
  const auth = new GoogleAuth({
    credentials: SA,
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/firebase",
    ],
  });
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  return t.token;
}

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  console.log("project:", PROJECT);

  const list = await api(`/projects/${PROJECT}/webApps`);
  console.log("LIST status:", list.status);
  if (list.status !== 200) {
    console.log("LIST body:", JSON.stringify(list.body).slice(0, 800));
    return;
  }
  const apps = list.body.apps || [];
  console.log("web apps found:", apps.map((a) => `${a.appId} (${a.displayName})`).join(", ") || "(none)");

  let appId = apps[0]?.appId;
  if (!appId) {
    console.log("creating a web app...");
    const created = await api(`/projects/${PROJECT}/webApps`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Kifayat Web" }),
    });
    console.log("CREATE status:", created.status, JSON.stringify(created.body).slice(0, 400));
    const opName = created.body?.name;
    if (opName) {
      // poll the long-running operation
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const op = await api(`/${opName}`);
        if (op.body?.done) {
          appId = op.body?.response?.appId;
          console.log("app created:", appId);
          break;
        }
      }
    }
  }

  if (!appId) { console.log("no appId; stopping"); return; }

  const cfg = await api(`/projects/${PROJECT}/webApps/${appId}/config`);
  console.log("CONFIG status:", cfg.status);
  console.log(JSON.stringify(cfg.body, null, 2).slice(0, 1500));
})().catch((e) => console.error("ERR:", e.message));
