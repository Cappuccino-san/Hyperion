import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getPersistenceCacheDir } from "@/lib/persistenceStore";

export type ExecutionRole = "leader" | "observer" | "auto";

export interface ExecutionLeasePayload {
  instanceId: string;
  pid: number;
  hostname: string;
  acquiredAtMs: number;
  expiresAtMs: number;
  heartbeatAtMs: number;
}

const LEASE_FILENAME = "execution-leader.lease.json";
export const DEFAULT_EXECUTION_LEASE_TTL_MS = 60_000;

const globalForLease = globalThis as unknown as {
  __hyperionInstanceId?: string;
};

export function getProcessInstanceId(): string {
  if (!globalForLease.__hyperionInstanceId) {
    const rand = crypto.randomBytes(4).toString("hex");
    globalForLease.__hyperionInstanceId = `${os.hostname()}-${process.pid}-${rand}`;
  }
  return globalForLease.__hyperionInstanceId;
}

export function getExecutionRole(): ExecutionRole {
  const raw = (process.env.HYPERION_EXECUTION_ROLE || "auto").trim().toLowerCase();
  if (raw === "leader" || raw === "observer" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function getExecutionLeasePath(): string {
  return path.join(getPersistenceCacheDir(), LEASE_FILENAME);
}

function readLeasePayloadSafe(leasePath: string): ExecutionLeasePayload | null {
  if (!fs.existsSync(leasePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(leasePath, "utf-8")) as ExecutionLeasePayload;
    if (
      parsed &&
      typeof parsed.instanceId === "string" &&
      typeof parsed.expiresAtMs === "number"
    ) {
      return parsed;
    }
  } catch {
    // Transient or malformed read
  }
  return null;
}

/**
 * Cross-process single-leader execution lease over `.cache/execution-leader.lease.json`.
 * Uses `O_EXCL | O_CREAT` atomic file creation + read-back verification to prevent split-brain
 * dual-runtime BTO/STC collisions when Docker and local host processes share `./.cache`.
 */
export function acquireCrossProcessExecutionLease(params?: {
  instanceId?: string;
  ttlMs?: number;
  nowMs?: number;
  forceRole?: ExecutionRole;
}): { acquired: boolean; holderInstanceId: string | null; role: ExecutionRole } {
  const role = params?.forceRole ?? getExecutionRole();
  const instanceId = params?.instanceId ?? getProcessInstanceId();

  if (role === "observer") {
    const existing = readLeasePayloadSafe(getExecutionLeasePath());
    return {
      acquired: false,
      holderInstanceId: existing?.instanceId ?? null,
      role,
    };
  }

  const nowMs = params?.nowMs ?? Date.now();
  const ttlMs = Math.max(5_000, params?.ttlMs ?? DEFAULT_EXECUTION_LEASE_TTL_MS);
  const leasePath = getExecutionLeasePath();
  const dir = path.dirname(leasePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return { acquired: false, holderInstanceId: null, role };
    }
  }

  const existing = readLeasePayloadSafe(leasePath);
  if (existing && existing.instanceId !== instanceId && existing.expiresAtMs > nowMs) {
    return {
      acquired: false,
      holderInstanceId: existing.instanceId,
      role,
    };
  }

  // If expired or held by us, remove/refresh atomically
  if (existing && (existing.instanceId === instanceId || existing.expiresAtMs <= nowMs)) {
    try {
      fs.unlinkSync(leasePath);
    } catch {
      // Another contender may have unlinked simultaneously
    }
  }

  const payload: ExecutionLeasePayload = {
    instanceId,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAtMs: existing?.instanceId === instanceId ? existing.acquiredAtMs : nowMs,
    heartbeatAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };

  try {
    const fd = fs.openSync(
      leasePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o644
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Lost the O_EXCL race to another process
    const winner = readLeasePayloadSafe(leasePath);
    return {
      acquired: winner?.instanceId === instanceId && (winner.expiresAtMs ?? 0) > nowMs,
      holderInstanceId: winner?.instanceId ?? null,
      role,
    };
  }

  // Read-back verification against external filesystem race
  const verified = readLeasePayloadSafe(leasePath);
  if (verified && verified.instanceId === instanceId) {
    return {
      acquired: true,
      holderInstanceId: instanceId,
      role,
    };
  }

  return {
    acquired: false,
    holderInstanceId: verified?.instanceId ?? null,
    role,
  };
}

export function isExecutionLeader(params?: {
  instanceId?: string;
  nowMs?: number;
}): boolean {
  if (getExecutionRole() === "observer") return false;
  const instanceId = params?.instanceId ?? getProcessInstanceId();
  const nowMs = params?.nowMs ?? Date.now();
  const existing = readLeasePayloadSafe(getExecutionLeasePath());
  return Boolean(existing && existing.instanceId === instanceId && existing.expiresAtMs > nowMs);
}

export function releaseCrossProcessExecutionLease(instanceId?: string): boolean {
  const id = instanceId ?? getProcessInstanceId();
  const leasePath = getExecutionLeasePath();
  const existing = readLeasePayloadSafe(leasePath);
  if (!existing || existing.instanceId !== id) {
    return false;
  }
  try {
    fs.unlinkSync(leasePath);
    return true;
  } catch {
    return false;
  }
}
