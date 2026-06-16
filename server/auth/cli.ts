/**
 * Enrollment CLI — run on the box, the root of trust. `enroll` mints a one-time
 * code and renders it as a string + a QR encoding the enroll URL; a new device
 * trades the code for a durable token via the PWA. `list` / `revoke <label>` /
 * `revoke-all` manage enrolled devices. The running server honors every change
 * live (the token store is mtime-cached).
 *
 *   bun server/auth/cli.ts enroll [label]
 *   bun server/auth/cli.ts list
 *   bun server/auth/cli.ts revoke <label>
 *   bun server/auth/cli.ts revoke-all
 */
import { loadConfig } from "../config";
import { mintEnrollCode, ENROLL_TTL_MS } from "./enroll";
import { listDevices, revokeByLabel, revokeByTokenPrefix, revokeAll } from "./tokens";

async function qr(text: string): Promise<string | null> {
  try {
    const QRCode = (await import("qrcode")).default;
    return await QRCode.toString(text, { type: "terminal", small: true });
  } catch {
    return null; // qrcode not installed — degrade to URL-only
  }
}

const cmd = process.argv[2];
const now = Date.now();

if (cmd === "enroll") {
  const cfg = loadConfig();
  const { code, expiresAt } = await mintEnrollCode(now);
  const url = `${cfg.auth.enrollUrl}/#code=${code}`;
  const ascii = await qr(url);
  console.log("\nBifrost — enroll a device\n");
  if (ascii) {
    console.log("Scan this from the device’s camera:\n");
    console.log(ascii);
  }
  console.log(`Or open on the device:  ${url}`);
  console.log(`Code (to paste):        ${code}`);
  console.log(
    `Expires:                ${new Date(expiresAt).toLocaleTimeString()} ` +
      `(${ENROLL_TTL_MS / 60000} min, single use)\n`,
  );
} else if (cmd === "list") {
  const devices = await listDevices();
  if (!devices.length) {
    console.log("No enrolled devices.");
  } else {
    for (const d of devices) {
      console.log(`${d.id}  ${d.label.padEnd(10)}  ${new Date(d.createdAt).toLocaleString()}`);
    }
  }
} else if (cmd === "revoke") {
  const label = process.argv[3];
  if (!label) {
    console.error("usage: bun server/auth/cli.ts revoke <label>");
    process.exit(1);
  }
  const n = await revokeByLabel(label);
  console.log(`Revoked ${n} device(s) labelled "${label}".`);
} else if (cmd === "revoke-id") {
  const id = process.argv[3];
  if (!id) {
    console.error("usage: bun server/auth/cli.ts revoke-id <id from `list`>");
    process.exit(1);
  }
  const n = await revokeByTokenPrefix(id);
  console.log(`Revoked ${n} device(s) with id ${id}.`);
} else if (cmd === "revoke-all") {
  await revokeAll();
  console.log("Revoked all devices. Every device must re-enroll.");
} else {
  console.error(
    "usage: bun server/auth/cli.ts <enroll [label] | list | revoke <label> | revoke-id <id> | revoke-all>",
  );
  process.exit(1);
}
