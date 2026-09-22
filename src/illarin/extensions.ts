import { strFromU8, unzipSync } from "fflate";
import type { ExtensionInfo } from "lumiverse-spindle-types";
import * as managerSvc from "../spindle/manager.service";
import * as lifecycle from "../spindle/lifecycle";
import * as svc from "../services/illarin-instance.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { syncLibrary } from "./api";
import { withAccessToken } from "./tokens";
import { readBackendVersion } from "./warmup";
import type { IllarinDelivery, WithheldNotice } from "./types";

const MAX_ARCHIVE_FILES = 4096;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const NOTICE_DURATION_MS = 30_000;

interface IllarinSource {
  assetId: string;
  contentGeneration: number;
  withheldAt?: string;
}

const refusedDeliveries = new Set<string>();

function isMacJunk(name: string): boolean {
  return name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store";
}

function manifestRoot(names: readonly string[]): string {
  let root = "";
  while (!names.includes(`${root}spindle.json`)) {
    const folder = names[0]?.slice(root.length).split("/")[0];
    if (!folder || !names.every((name) => name.startsWith(`${root}${folder}/`))) {
      throw new Error("The extension archive has no spindle.json at its top or inside the one folder that holds everything");
    }
    root = `${root}${folder}/`;
  }
  return root;
}

export function readExtensionArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  let files = 0;
  let expanded = 0;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const name = entry.name.replace(/\\/g, "/");
      if (name.endsWith("/") || isMacJunk(name)) return false;
      files++;
      expanded += entry.originalSize;
      if (files > MAX_ARCHIVE_FILES) throw new Error(`The extension archive holds more than ${MAX_ARCHIVE_FILES} files`);
      if (expanded > MAX_EXPANDED_BYTES) throw new Error("The extension archive expands beyond the safe limit");
      return true;
    },
  });
  const archive = new Map(Object.entries(entries).map(([name, data]) => [name.replace(/\\/g, "/"), data]));
  const root = manifestRoot([...archive.keys()]);
  return new Map(
    [...archive]
      .filter(([name]) => name.startsWith(root))
      .map(([name, data]) => [name.slice(root.length), data]),
  );
}

function manifestIdentifier(files: ReadonlyMap<string, Uint8Array>): string {
  const manifest = JSON.parse(strFromU8(files.get("spindle.json")!)) as { identifier?: unknown };
  if (typeof manifest.identifier !== "string") throw new Error("spindle.json has no identifier");
  return manifest.identifier;
}

function illarinSource(ext: ExtensionInfo): IllarinSource | null {
  const source = ext.metadata?.illarin as IllarinSource | undefined;
  return typeof source?.assetId === "string" ? source : null;
}

function notify(userId: string, ext: ExtensionInfo, type: "warning" | "error", message: string): void {
  eventBus.emit(EventType.SPINDLE_TOAST, {
    extensionId: ext.id,
    extensionName: ext.name,
    type,
    title: "Illarin",
    message,
    duration: NOTICE_DURATION_MS,
  }, userId);
}

function emitStatus(ext: ExtensionInfo, operation: string): void {
  eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, { extensionId: ext.id, operation, name: ext.name });
}

export async function installExtensionDelivery(
  userId: string,
  delivery: IllarinDelivery,
  archive: Uint8Array,
): Promise<void> {
  const files = readExtensionArchive(archive);
  const source: IllarinSource = { assetId: delivery.assetId, contentGeneration: delivery.contentGeneration };
  const installed = await managerSvc.getExtensionByIdentifier(manifestIdentifier(files));
  if (!installed) {
    emitStatus(await managerSvc.installFromFiles(files, { illarin: source }), "installed");
  } else if (illarinSource(installed)?.assetId === delivery.assetId) {
    await updateExtension(userId, installed, files, source);
  } else {
    await refuseReplacement(userId, delivery, installed);
  }
  void reportLibraryToAll();
}

async function updateExtension(
  userId: string,
  ext: ExtensionInfo,
  files: ReadonlyMap<string, Uint8Array>,
  source: IllarinSource,
): Promise<void> {
  emitStatus(ext, "updating");
  if (lifecycle.isRunning(ext.id)) {
    await lifecycle.stopExtension(ext.id);
    await lifecycle.settleRuntimeBoundary();
  }
  const updated = await managerSvc.replaceFromFiles(ext.identifier, files);
  managerSvc.setMetadataEntry(ext.identifier, "illarin", source);
  if (ext.enabled) {
    await lifecycle.settleRuntimeBoundary();
    await lifecycle.startExtension(ext.id);
  }
  emitStatus(ext, "updated");

  const added = updated.permissions.filter((permission) =>
    !ext.permissions.includes(permission) && !updated.granted_permissions.includes(permission));
  if (added.length > 0) {
    notify(userId, updated, "warning", `This update asks for new permissions: ${added.join(", ")}. Turn them on under Extensions to allow them.`);
  }
}

async function refuseReplacement(userId: string, delivery: IllarinDelivery, installed: ExtensionInfo): Promise<never> {
  if (!refusedDeliveries.has(delivery.id)) {
    refusedDeliveries.add(delivery.id);
    const illarinUrl = (await svc.getIllarinInstance(userId))?.illarinUrl ?? "";
    const other = illarinSource(installed);
    const origin = other ? `${illarinUrl}/a/${other.assetId}` : installed.github || "another source";
    notify(
      userId,
      installed,
      "error",
      `Illarin sent ${delivery.name} (${illarinUrl}/a/${delivery.assetId}), but ${installed.identifier} is already installed from ${origin}. Nothing was changed. Remove the installed one if you want the delivery to install.`,
    );
  }
  throw new Error(`${installed.identifier} is already installed from another source`);
}

export async function recordWithheld(userId: string, notices: readonly WithheldNotice[]): Promise<void> {
  if (notices.length === 0) return;
  const extensions = await managerSvc.list();
  for (const notice of notices) {
    for (const ext of extensions) {
      const source = illarinSource(ext);
      if (source?.assetId !== notice.assetId) continue;
      managerSvc.setMetadataEntry(ext.identifier, "illarin", { ...source, withheldAt: notice.withheldAt });
      notify(userId, ext, "warning", `Illarin has withheld ${notice.name}. It stays installed as it is. Switch it off or remove it under Extensions if you no longer want it.`);
    }
  }
}

async function sendSnapshot(userId: string): Promise<void> {
  const instance = await svc.getIllarinInstance(userId);
  if (!instance?.scopes.includes("library:sync") || !svc.canInstallExtensions(userId)) return;
  const entries = (await managerSvc.list()).flatMap((ext) => {
    const source = illarinSource(ext);
    return source ? [{ assetId: source.assetId, contentGeneration: source.contentGeneration }] : [];
  });
  const applicationVersion = await readBackendVersion();
  const result = await withAccessToken(userId, (accessToken) =>
    syncLibrary(instance.illarinUrl, accessToken, { snapshot: true, applicationVersion, entries, removed: [] }));
  if (result) await recordWithheld(userId, result.withheld);
}

function warnReportFailed(err: unknown): void {
  console.warn("[Illarin] Library report failed:", err instanceof Error ? err.message : err);
}

export function reportLibrary(userId: string): Promise<void> {
  return sendSnapshot(userId).catch(warnReportFailed);
}

export function reportLibraryToAll(): Promise<void> {
  return svc.listIllarinInstances()
    .then(async (instances) => {
      for (const instance of instances) await reportLibrary(instance.userId);
    })
    .catch(warnReportFailed);
}
