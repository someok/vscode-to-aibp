/**
 * VSCode OpenCode AIBP Sender — 扩展入口
 *
 * 触发:
 *   Cmd+. / Ctrl+. 代码操作菜单 → 「💬 发送给 AIBP」
 *   Shift+Alt+Enter 快捷键
 *
 * 流程:
 *   1. discoverAsync() → 选择 opencode 实例
 *   2. 打开临时文件，内容预填选中文本（无选中则为空）
 *   3. 用户自由编辑
 *   4. 状态栏点击发送（或 Shift+Enter）
 *   5. save → 关闭 → 删除临时文件 → 焦点回归
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { discoverAsync, send, RegFile, ContextPayload, Selection } from "./aibp";

const OPCODE_SEND_KIND = vscode.CodeActionKind.QuickFix;
const CONTEXT_KEY_INPUT_OPEN = "vscodeToAibpInputOpen";
const USER_INPUT_SEPARATOR = "\n\n---下面为用户输入内容---\n\n";

let cachedReceiver: { name: string; socket: string } | null = null;
let outputChannel: vscode.OutputChannel | undefined;

interface InputDocMeta {
  receiver: RegFile;
  contextPayload: ContextPayload;
  tempFilePath: string;
}

const inputDocMetas = new Map<string, InputDocMeta>();
let inputDocCount = 0;
let statusBarItem: vscode.StatusBarItem | undefined;

async function setInputContext(open: boolean) {
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY_INPUT_OPEN, open);
}

// ── 激活 ──

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("VSCode to AIBP");
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-to-aibp.send", () => openInputDocument())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-to-aibp.sendInput", () => sendFromInputDocument())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-to-aibp.switchReceiver", () => switchReceiver())
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider("*", new OpenCodeCodeActionProvider(), {
      providedCodeActionKinds: [OPCODE_SEND_KIND],
    })
  );

  // 输入文档关闭时清理（含删除临时文件）
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      cleanupInputDocIfUnused(doc.uri.toString());
    })
  );

  // 标签页关闭时清理：扩展自己打开的文档在关闭标签页时不一定触发 onDidCloseTextDocument
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        const uri = getInputDocUriFromTab(tab);
        if (uri) cleanupInputDocIfUnused(uri);
      }
    })
  );
}

export function deactivate() {}

// ===== CodeActionProvider =====

class OpenCodeCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    _document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    if (range.isEmpty) return [];
    const action = new vscode.CodeAction("💬 发送给 AIBP", OPCODE_SEND_KIND);
    action.command = { command: "vscode-to-aibp.send", title: "发送给 AIBP" };
    action.isPreferred = true;
    return [action];
  }
}

// ===== 打开输入文档 =====

async function openInputDocument() {
  if (await showExistingInputDocument()) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("AIBP: 没有打开的编辑器");
    return;
  }

  // 1. 发现实例
  const receivers = await discoverAsync();
  if (receivers.length === 0) {
    const action = await vscode.window.showErrorMessage(
      "没有发现正在运行的 AIBP 实例。请先在 OpenCode 或 Pi 中集成 AIBP。",
      "重试"
    );
    if (action === "重试") return openInputDocument();
    return;
  }

  // 2. 选择目标
  let receiver: RegFile | undefined = receivers[0];
  if (receivers.length > 1) {
    receiver = await resolveReceiver(receivers);
    if (!receiver) return;
  }
  if (!receiver) return;
  cachedReceiver = { name: receiver.name, socket: receiver.socket };

  // 3. 收集上下文
  const doc = editor.document;
  const filePath = doc.uri.fsPath;

  const cursor = {
    line: editor.selection.active.line + 1,
    col: editor.selection.active.character + 1,
  };

  let selection: Selection | undefined;
  let initialContent = "";
  if (!editor.selection.isEmpty) {
    const selText = doc.getText(editor.selection);
    selection = {
      start: { line: editor.selection.start.line + 1, col: editor.selection.start.character + 1 },
      end: { line: editor.selection.end.line + 1, col: editor.selection.end.character + 1 },
      text: selText,
    };
    initialContent = `${selText}${USER_INPUT_SEPARATOR}`;
  }

  const contextPayload: ContextPayload = {
    path: filePath,
    cursor,
    selection,
  };

  // 4. 创建临时文件（替代 untitled 文档，消除 dirty 保存提示）
  const tempFilePath = path.join(
    os.tmpdir(),
    `aibp-input-${Date.now()}.md`
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(tempFilePath),
    Buffer.from(initialContent, "utf8")
  );

  const tempUri = vscode.Uri.file(tempFilePath);
  const inputDoc = await vscode.workspace.openTextDocument(tempUri);
  const uri = inputDoc.uri.toString();

  inputDocMetas.set(uri, {
    receiver,
    contextPayload,
    tempFilePath,
  });

  if (inputDocCount === 0) {
    await setInputContext(true);
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    updateStatusBarReceiver(receiver);
    statusBarItem.tooltip = "点击发送 · 关闭取消；可通过命令面板切换接收实例";
    statusBarItem.command = "vscode-to-aibp.sendInput";
    statusBarItem.show();
  }
  inputDocCount++;

  const inputEditor = await vscode.window.showTextDocument(inputDoc, { preview: false });
  const end = inputDoc.positionAt(inputDoc.getText().length);
  inputEditor.selection = new vscode.Selection(end, end);
  inputEditor.revealRange(
    new vscode.Range(end, end),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

async function showExistingInputDocument(): Promise<boolean> {
  // 兜底清理：标签页已关闭、但关闭事件未触发的残留条目
  for (const uri of [...inputDocMetas.keys()]) {
    cleanupInputDocIfUnused(uri);
  }

  const existingUri = inputDocMetas.keys().next().value;
  if (!existingUri) return false;

  const inputDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(existingUri));
  await vscode.window.showTextDocument(inputDoc, { preview: false });
  return true;
}

async function resolveReceiver(
  receivers: Awaited<ReturnType<typeof discoverAsync>>
): Promise<RegFile | undefined> {
  if (cachedReceiver) {
    const found = receivers.find((r) => r.socket === cachedReceiver!.socket);
    if (found) return found;
    cachedReceiver = null;
  }

  return pickReceiver(receivers, "选择要发送的 AIBP 实例");
}

async function pickReceiver(
  receivers: RegFile[],
  placeHolder: string
): Promise<RegFile | undefined> {
  const items = receivers.map((r) => ({
    label: r.name,
    description: `PID ${r.pid}`,
    detail: r.cwd ? `工作区: ${r.cwd}` : undefined,
    receiver: r,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
  });
  return picked?.receiver;
}

async function switchReceiver() {
  const receivers = await discoverAsync();
  if (receivers.length === 0) {
    vscode.window.showErrorMessage("没有发现正在运行的 AIBP 实例。");
    return;
  }

  const receiver = await pickReceiver(receivers, "选择要切换到的 AIBP 实例");
  if (!receiver) return;

  cachedReceiver = { name: receiver.name, socket: receiver.socket };

  for (const meta of inputDocMetas.values()) {
    meta.receiver = receiver;
  }
  updateStatusBarReceiver(receiver);

  vscode.window.showInformationMessage(`已切换 AIBP 实例为 [${receiver.name}]`);
}

function updateStatusBarReceiver(receiver: RegFile) {
  if (statusBarItem) {
    statusBarItem.text = `$(send) 发送给 AIBP [${receiver.name}]`;
  }
}

// ===== 发送 =====

async function sendFromInputDocument() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const uri = editor.document.uri.toString();
  const meta = inputDocMetas.get(uri);
  if (!meta) return;

  const { receiver, contextPayload, tempFilePath } = meta;
  const message = extractUserMessage(editor.document.getText(), contextPayload.selection);
  if (message === undefined) {
    vscode.window.showErrorMessage("AIBP: 请保留“---下面为用户输入内容---”分隔线，并在其下方填写补充内容。");
    return;
  }

  const payload: ContextPayload = {
    ...contextPayload,
    message: message || undefined,
  };
  logPayload(payload);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在发送给 AIBP [${receiver.name}]...`,
      cancellable: false,
    },
    async () => {
      await send(receiver, payload);
    }
  );

  // 保存到临时文件以消除 dirty 标记（避免关闭时弹保存提示）
  try {
    await editor.document.save();
  } catch {
    // 忽略保存失败
  }

  cleanupInputDoc(uri);
  tryDeleteTempFile(tempFilePath);

  // 关闭输入文档
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (tab) {
    await vscode.window.tabGroups.close(tab);
  }

  vscode.window.showInformationMessage(`✓ 已发送给 AIBP [${receiver.name}]`);
}

function logPayload(payload: ContextPayload) {
  if (!outputChannel) return;
  outputChannel.appendLine(`[${new Date().toISOString()}] 发送 payload:`);
  outputChannel.appendLine(JSON.stringify(payload, null, 2));
}

function extractUserMessage(content: string, selection?: Selection): string | undefined {
  if (!selection?.text) return content.trim();

  const separator = USER_INPUT_SEPARATOR.trim();
  const separatorIndex = content.lastIndexOf(separator);
  if (separatorIndex < 0) return undefined;
  return content.slice(separatorIndex + separator.length).trim();
}

// ===== 清理 =====

/** 判断输入文档是否仍显示在编辑器标签页中 */
function isInputDocOpenInTabs(uri: string): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => {
      const input = tab.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === uri;
    })
  );
}

/** 从标签页取出输入文档 URI（非输入文档返回 undefined） */
function getInputDocUriFromTab(tab: vscode.Tab): string | undefined {
  const input = tab.input;
  if (!(input instanceof vscode.TabInputText)) return undefined;
  const uri = input.uri.toString();
  return inputDocMetas.has(uri) ? uri : undefined;
}

/** 标签页已关闭时清理输入文档：删除临时文件并重置状态 */
function cleanupInputDocIfUnused(uri: string) {
  const meta = inputDocMetas.get(uri);
  if (!meta || isInputDocOpenInTabs(uri)) return;
  outputChannel?.appendLine(`[${new Date().toISOString()}] 清理输入文档: ${meta.tempFilePath}`);
  tryDeleteTempFile(meta.tempFilePath);
  cleanupInputDoc(uri);
}

function cleanupInputDoc(uri: string) {
  if (!inputDocMetas.has(uri)) return;
  inputDocMetas.delete(uri);
  inputDocCount = Math.max(0, inputDocCount - 1);
  if (inputDocCount === 0) {
    setInputContext(false);
    statusBarItem?.dispose();
    statusBarItem = undefined;
  }
}

function tryDeleteTempFile(filePath: string) {
  // 异步删除，忽略失败（文件可能已不存在）
  vscode.workspace.fs.delete(vscode.Uri.file(filePath), { useTrash: false }).then(undefined, () => {
    /* 忽略删除失败 */
  });
}
