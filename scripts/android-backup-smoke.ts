import assert from "node:assert/strict";
import { zipSync } from "fflate";
import sharp from "sharp";
import { createManifest } from "../src/services/user-data/manifest";
import { createTicket, encryptSecret } from "../src/services/user-data/secret-ticket.service";

/** Exercises real HTTP imports and image decoding in the authenticated APK WebView. */
export async function checkAndroidBackupRestore(evaluate: <T>(expression: string) => Promise<T>) {
  const navigationId = await evaluate<number>('performance.timeOrigin');
  assert.equal(await evaluate<number>(`fetch('/api/v1/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({wallpaper:{global:null,mobile:null,opacity:0.4,fit:'cover',blur:0},activePersonaId:null})}).then(r=>r.status)`), 200);
  const original = crypto.randomUUID(), crop = crypto.randomUUID(), background = crypto.randomUUID();
  const character = crypto.randomUUID(), persona = crypto.randomUUID(), connection = crypto.randomUUID();
  const characterName = `Restored Android ${character.slice(0, 8)}`;
  const chat = crypto.randomUUID(), message = crypto.randomUUID();
  const key = `connection_${connection}_api_key`;
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#8866cc" } }).png().toBuffer();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
  const rows = (values: unknown[]) => Buffer.from(values.map(value => JSON.stringify(value)).join("\n") + "\n");
  const results: object[] = [];
  for (const withSecrets of [false, true]) {
    const archiveId = crypto.randomUUID();
    const { ticket, smk } = await createTicket(archiveId, [key]);
    const entries: Record<string, Uint8Array> = {
      "manifest.json": encode(createManifest({ archiveId, includeVectors: false,
        embeddingConfig: { provider: null, model: null, dimension: null }, producerVersion: null,
        counts: {}, missingFiles: [], hasEncryptedSecrets: withSecrets, secretsCount: withSecrets ? 1 : 0 })),
      "database/images.ndjson": rows([original, crop, background].map(id => ({ id, filename: `${id}.png`, mime_type: "image/png", user_id: "source-owner" }))),
      "database/characters.ndjson": encode({ id: character, name: characterName, user_id: "source-owner", image_id: original, extensions: JSON.stringify({ avatar_crop_image_id: crop }) }),
      "database/chats.ndjson": encode({ id: chat, character_id: character, name: characterName, user_id: "source-owner" }),
      "database/messages.ndjson": encode({ id: message, chat_id: chat, index_in_chat: 0, name: characterName, content: "Restored chat is visible without restarting." }),
      "database/personas.ndjson": encode({ id: persona, name: "Backup smoke persona", user_id: "source-owner", avatar_path: `${persona}.png` }),
      "database/connection_profiles.ndjson": encode({ id: connection, name: "Backup smoke connection", provider: "openrouter", user_id: "source-owner" }),
      "database/settings.ndjson": rows([
        { key: "wallpaper", value: JSON.stringify({ global: { type: "image", image_id: background } }), user_id: "source-owner" },
        { key: "activePersonaId", value: JSON.stringify(persona), user_id: "source-owner" },
      ]),
      [`files/avatars/${persona}.png`]: png,
    };
    for (const id of [original, crop, background]) entries[`files/images/${id}.png`] = png;
    if (withSecrets) {
      entries["secrets/index.json"] = encode({ keys: [key] });
      entries["secrets/encrypted.ndjson"] = encode(await encryptSecret(smk, key, "android-backup-smoke-secret"));
    }
    const base64 = Buffer.from(zipSync(entries)).toString("base64");
    const uploaded = await evaluate<{ httpStatus: number; jobId: string }>(`(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));
      const response=await fetch('/api/v1/user-data/import',{method:'POST',headers:{'content-type':'application/zip'},body:bytes});
      return {...await response.json(),httpStatus:response.status};
    })()`);
    assert.equal(uploaded.httpStatus, 202, "Archive upload must start a restore job");
    let state: any;
    const deadline = Date.now() + 60000;
    for (;;) {
      state = await evaluate(`fetch('/api/v1/user-data/import/${uploaded.jobId}/status').then(r=>r.json())`);
      assert.notEqual(state.status, "failed", state.error);
      if (state.status === "complete") break;
      assert.ok(Date.now() < deadline, "Restore job must finish");
      if (state.status === "awaiting_ticket") {
        const accepted = await evaluate<number>(`fetch('/api/v1/user-data/import/${uploaded.jobId}/ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(ticket)})}).then(r=>r.status)`);
        assert.equal(accepted, 200, "The decryption ticket must be accepted");
      }
      await Bun.sleep(100);
    }
    if (withSecrets) assert.equal(state.summary.secrets.imported, 1);
    const readableKey = await evaluate<boolean>(`fetch('/api/v1/connections/${connection}').then(r=>r.json()).then(c=>c.has_api_key)`);
    assert.equal(readableKey, withSecrets, "Restored credentials must decrypt and report their presence");
    const paths = [original, crop, background].flatMap(id => [`/api/v1/images/${id}`, `/api/v1/images/${id}?size=sm`, `/api/v1/images/${id}?size=lg`]);
    paths.push(`/api/v1/characters/${character}/avatar`, `/api/v1/personas/${persona}/avatar`);
    for (const path of paths) {
      assert.equal(await evaluate<boolean>(`(async()=>{const image=new Image();image.src=${JSON.stringify(path)};await image.decode();return image.naturalWidth>0})()`), true, `Restored media must decode: ${path}`);
    }
    const wallpaper = await evaluate<any>("fetch('/api/v1/settings/wallpaper').then(r=>r.json())");
    assert.equal(wallpaper.value.global.image_id, background);
    results.push({ secrets: withSecrets, status: state.status, decodedImages: paths.length, fileSummary: state.fileSummary });
  }
  const deadline = Date.now() + 10000;
  let visible = false;
  while (Date.now() < deadline) {
    visible = await evaluate<boolean>(`Array.from(document.querySelectorAll('[style]')).some(node=>node.style.backgroundImage.includes(${JSON.stringify(background)}))`);
    if (visible && await evaluate<boolean>(`document.body.textContent.includes(${JSON.stringify(characterName)})`)) break;
    visible = false;
    await Bun.sleep(250);
  }
  assert.ok(visible, "The restored chat and wallpaper must appear without reloading the app");
  assert.equal(await evaluate<number>('performance.timeOrigin'), navigationId, "Import must refresh the current page without a reload or force-close");
  return results;
}
