/**
 * AIBP (AI Bridge Protocol v2.0) 发送端
 *
 * 协议参考: microNeo — internal/aibp/message.go
 *
 * 核心:
 *   discoverAsync() — 扫描注册表，connect 探活，返回存活 receiver 列表
 *   send() — 构建 Envelope，UNIX socket 发送，fire-and-forget
 */

import * as fs from "fs";
import * as path from "path";
import * as net from "net";

// ===== 常量 =====

const PROTOCOL_MAJOR = 2;

// ===== 类型 =====

export interface RegFile {
  name: string;       // 实例名（如 Alpha, Bravo）
  pid: number;
  transport: string;  // "unix"
  socket: string;     // socket 路径
  protocol: string;   // "aibp-2.0"
  startedAt: number;
  cwd?: string;
  labels?: string[];
}

export interface Position {
  line: number; // 1-based
  col: number; // 1-based
}

export interface Selection {
  start: Position;
  end: Position;
  text?: string; // 可选：如果不设置，opencode 端用 @path :lineN 格式
}

export interface ContextPayload {
  path: string;
  cursor: Position;
  selection?: Selection;
  message?: string;
}

// ===== 注册表目录 =====

function registryDir(): string {
  if (process.env.MNAB_REG_DIR) return process.env.MNAB_REG_DIR;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(base, `aibp-${uid}`);
}

// ===== discoverAsync: 扫描注册表 + connect 探活 =====

export async function discoverAsync(): Promise<RegFile[]> {
  const dir = registryDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const results: RegFile[] = [];

  for (const entry of entries) {
    if (!entry.startsWith("ai-") || !entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);

    let rf: RegFile;
    try {
      rf = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue; // 注册文件损坏，跳过
    }

    // 协议主版本校验（"aibp-2.0" → major=2）
    const m = /^aibp-(\d+)/.exec(rf.protocol);
    if (!m || parseInt(m[1]) !== PROTOCOL_MAJOR) continue;

    // connect 探活（权威判据）
    const alive = await socketAlive(rf.socket);
    if (alive) {
      results.push(rf);
      continue;
    }

    // connect 失败，PID 已死 → GC 僵尸注册
    if (!pidAlive(rf.pid)) {
      try { fs.unlinkSync(filePath); } catch {}
      try { fs.unlinkSync(rf.socket); } catch {}
    }
    // PID 仍活但 connect 失败 → 保留注册但视为不可用（不加入 results）
  }

  return results;
}

async function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 300);
    sock.on("connect", () => {
      clearTimeout(timeout);
      sock.end();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ===== send: 构建 Envelope → UNIX socket 发送 =====

export function send(receiver: RegFile, payload: ContextPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const envelope = {
      v: PROTOCOL_MAJOR,
      type: "context",
      sender: {
        pid: process.pid,
        name: "vscode-aibp",
        instance: "default",
      },
      ts: Date.now() / 1000,
      payload,
    };

    const line = JSON.stringify(envelope) + "\n";

    const sock = net.createConnection(receiver.socket);
    sock.on("connect", () => {
      sock.end(line, () => resolve());
    });
    sock.on("error", (err) => {
      sock.destroy();
      reject(err);
    });
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error("send timeout"));
    });
  });
}

// ===== 工具 =====

export function formatPayload(payload: ContextPayload): string {
  const sel = payload.selection;
  const selText = sel?.text?.length ? sel.text : "";

  if (sel && selText) {
    const header = `<selection path="${payload.path}" lines="${sel.start.line}-${sel.end.line}">`;
    return payload.message
      ? `${header}\n${selText}\n</selection>\n<user-input>\n${payload.message}\n</user-input>`
      : `${header}\n${selText}\n</selection>`;
  }

  const focus = sel
    ? `line${sel.start.line}-${sel.end.line}`
    : `${payload.cursor.line}`;
  return payload.message
    ? `@${payload.path} :line${focus}\n\n${payload.message}`
    : `@${payload.path} :line${focus}`;
}
