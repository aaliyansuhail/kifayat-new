// Verifies POST /api/seller/upload-media end to end:
//   - logs in as the seller over HTTP and keeps the session cookie
//   - uploads a real PNG + a real WebM, expects 201 with /uploads/seller-media URLs
//   - uploads a spoofed "evil.png" (HTML bytes) and expects it to be rejected
//   - checks the files are actually served back from the static mount
//   - purges anything it uploaded so the repo stays clean
const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE = process.env.BASE_URL || "http://localhost:3001";
const EMAIL = "faiza@kifayat.co";
const PASSWORD = "faiza1234@kifayat.co";

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "seller-media");

// Minimal valid 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// Minimal EBML header — enough for the WebM magic-byte sniff.
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
  Buffer.from("webm", "latin1"),
  Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]),
]);

let cookie = "";
const created = [];
const failures = [];

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const raw = res.headers.get("set-cookie") || "";
  cookie = raw
    .split(/,(?=\s*[^;]+?=)/)
    .map((c) => c.split(";")[0].trim())
    .join("; ");
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function upload(parts) {
  const form = new FormData();
  for (const p of parts) {
    form.append("files", new Blob([p.buffer], { type: p.type }), p.name);
  }
  const res = await fetch(`${BASE}/api/seller/upload-media`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function main() {
  // ── unauthenticated must be rejected ──────────────────────────────────────
  const anonRes = await fetch(`${BASE}/api/seller/upload-media`, { method: "POST" });
  check(
    "unauthenticated upload is rejected",
    anonRes.status === 401,
    `status ${anonRes.status}`,
  );

  const { res: loginRes, body: loginBody } = await login();
  check("seller login succeeds", loginRes.ok && !!cookie, `status ${loginRes.status}`);
  if (!loginRes.ok) {
    console.error("login body:", JSON.stringify(loginBody).slice(0, 300));
    return finish();
  }

  // ── happy path: png + webm ────────────────────────────────────────────────
  const ok = await upload([
    { name: "card.png", buffer: PNG, type: "image/png" },
    { name: "demo.webm", buffer: WEBM, type: "video/webm" },
  ]);
  check("mixed image+video upload returns 201", ok.res.status === 201, `status ${ok.res.status}`);
  const files = ok.body.files || [];
  check("two files accepted", files.length === 2, `got ${files.length}`);
  const png = files.find((f) => f.type === "image");
  const webm = files.find((f) => f.type === "video");
  check("image tagged image", !!png && png.mimeType === "image/png");
  check("video tagged video", !!webm && webm.mimeType === "video/webm");
  check(
    "urls are /uploads/seller-media paths",
    files.every((f) => /^\/uploads\/seller-media\/[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(f.url)),
    files.map((f) => f.url).join(" "),
  );
  check("client filename not reused", files.every((f) => !f.url.includes("card")), "");

  for (const f of files) {
    const disk = path.join(UPLOAD_DIR, path.basename(f.url));
    if (!fs.existsSync(disk)) {
      check(`file on disk: ${path.basename(f.url)}`, false);
      continue;
    }
    created.push(disk);
    const served = await fetch(`${BASE}${f.url}`);
    check(`served ${path.basename(f.url)}`, served.ok, `status ${served.status}`);
  }

  // ── spoofed content type must be rejected ────────────────────────────────
  const evil = await upload([
    { name: "totally-an-image.png", buffer: Buffer.from("<script>alert(1)</script>"), type: "image/png" },
  ]);
  check(
    "spoofed HTML rejected with 400",
    evil.res.status === 400,
    `status ${evil.res.status}`,
  );
  const leftovers = fs
    .readdirSync(UPLOAD_DIR)
    .filter((n) => n.startsWith("tmp-"));
  check("no temp files left behind", leftovers.length === 0, leftovers.join(" "));

  // ── empty request ────────────────────────────────────────────────────────
  const empty = await upload([]);
  check("empty upload rejected", empty.res.status === 400, `status ${empty.res.status}`);

  finish();
}

function finish() {
  for (const f of created) fs.rmSync(f, { force: true });
  console.log(
    failures.length
      ? `\n${failures.length} check(s) failed: ${failures.join(", ")}`
      : "\nAll seller media upload checks passed.",
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error("verify failed:", err);
  finish();
});