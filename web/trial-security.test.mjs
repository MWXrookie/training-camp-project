import { createTrialServer } from "../server.mjs";

const server = createTrialServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const results = [];

function ok(name, condition) {
  results.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(name);
}

try {
  const health = await fetch(`${baseUrl}/api/trial/health`);
  const healthPayload = await health.json();
  ok("health endpoint is public", health.ok && healthPayload.ok === true);
  ok("health response has security headers", health.headers.get("x-content-type-options") === "nosniff");

  const unauthenticated = await fetch(`${baseUrl}/api/trial/analyze`, { method: "POST" });
  const unauthenticatedPayload = await unauthenticated.json();
  ok("AI endpoint rejects missing session", unauthenticated.status === 401 && unauthenticatedPayload.error.code === "access_required");

  const invalidAccess = await fetch(`${baseUrl}/api/trial/access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "wrong", consent_version: "trial_notice_v0.1" })
  });
  const invalidAccessPayload = await invalidAccess.json();
  ok("wrong access code is rejected", invalidAccess.status === 403 && invalidAccessPayload.error.code === "access_required");

  const access = await fetch(`${baseUrl}/api/trial/access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: process.env.TRIAL_ACCESS_CODE || "recall", consent_version: "trial_notice_v0.1" })
  });
  const cookie = access.headers.get("set-cookie")?.split(";")[0] || "";
  const accessPayload = await access.json();
  ok("valid access creates session", access.ok && accessPayload.authenticated === true);
  ok("session cookie is HttpOnly", access.headers.get("set-cookie")?.includes("HttpOnly") === true);

  const session = await fetch(`${baseUrl}/api/trial/session`, { headers: { Cookie: cookie } });
  ok("session endpoint recognizes cookie", (await session.json()).authenticated === true);

  const authenticated = await fetch(`${baseUrl}/api/trial/analyze`, {
    method: "POST",
    headers: { Cookie: cookie }
  });
  const authenticatedPayload = await authenticated.json();
  ok("authenticated request reaches API validation", authenticated.status === 400 && authenticatedPayload.error.code === "validation_failed");

  console.log(`trial security passed (${results.length} checks)`);
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
