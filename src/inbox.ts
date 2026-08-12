import { existsSync } from "node:fs";
import { join } from "node:path";
import { StateError } from "./errors.js";
import {
  ensureSessionDir,
  readJsonFile,
  sessionDir,
  writeJsonAtomic,
  type JsonObject,
} from "./state.js";

export const INBOX_VERSION = 1;
export const INBOX_MAX_MESSAGES = 100;
export const INBOX_MAX_BYTES = 8 * 1024 * 1024;
const INBOX_FILENAME = "inbox.json";

export type InboxKind = "direct" | "broadcast";

export type InboxMessage = {
  id: string;
  receivedAt: string;
  from: string;
  fromName: string;
  kind: InboxKind;
  to: string | null;
  text: string;
  notificationTruncated: boolean;
};

export type Inbox = {
  version: 1;
  messages: InboxMessage[];
};

export function emptyInbox(): Inbox {
  return { version: INBOX_VERSION, messages: [] };
}

export function encodedInboxSize(inbox: Inbox): number {
  return Buffer.byteLength(JSON.stringify(inbox), "utf8");
}

// Eviction drops the oldest records until the count and encoded-size bounds
// both hold. A single record larger than the total bound is kept as the sole
// record rather than being discarded.
export function evictToBounds(messages: InboxMessage[]): InboxMessage[] {
  const result = messages.slice();
  while (
    result.length > INBOX_MAX_MESSAGES ||
    encodedInboxSize({ version: INBOX_VERSION, messages: result }) >
      INBOX_MAX_BYTES
  ) {
    if (result.length <= 1) break;
    result.shift();
  }
  return result;
}

export function addMessage(
  inbox: Inbox,
  message: InboxMessage,
): { inbox: Inbox; added: boolean } {
  if (inbox.messages.some((existing) => existing.id === message.id))
    return { inbox, added: false };
  const messages = [...inbox.messages, message];
  return {
    inbox: { version: INBOX_VERSION, messages: evictToBounds(messages) },
    added: true,
  };
}

function isInboxMessage(value: unknown): value is InboxMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as JsonObject;
  if (typeof record.id !== "string" || record.id.length === 0) return false;
  if (typeof record.receivedAt !== "string") return false;
  if (Number.isNaN(Date.parse(record.receivedAt))) return false;
  if (typeof record.from !== "string" || record.from.length === 0) return false;
  if (typeof record.fromName !== "string") return false;
  if (record.kind !== "direct" && record.kind !== "broadcast") return false;
  if (record.to !== null && typeof record.to !== "string") return false;
  if (typeof record.text !== "string") return false;
  if (typeof record.notificationTruncated !== "boolean") return false;
  return true;
}

function isInbox(value: unknown): value is Inbox {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as JsonObject;
  if (record.version !== INBOX_VERSION) return false;
  if (!Array.isArray(record.messages)) return false;
  if (!record.messages.every((message) => isInboxMessage(message)))
    return false;
  return true;
}

export function readInboxFile(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
): Inbox {
  const dir = sessionDir(dataDir, workspaceHash, sessionHash);
  const path = join(dir, INBOX_FILENAME);
  if (!existsSync(path)) return emptyInbox();
  const record = readJsonFile(path);
  if (!isInbox(record)) throw new StateError("session inbox is malformed");
  return record;
}

export function writeInboxFile(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
  inbox: Inbox,
): void {
  writeJsonAtomic(
    join(ensureSessionDir(dataDir, workspaceHash, sessionHash), INBOX_FILENAME),
    inbox,
  );
}

export function recordMessage(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
  message: InboxMessage,
): { inbox: Inbox; added: boolean } {
  const current = readInboxFile(dataDir, workspaceHash, sessionHash);
  const { inbox, added } = addMessage(current, message);
  if (added) writeInboxFile(dataDir, workspaceHash, sessionHash, inbox);
  return { inbox, added };
}
