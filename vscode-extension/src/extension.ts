import * as vscode from "vscode";
import * as path from "path";
import * as WebSocket from "ws";

let ws: WebSocket | undefined;
let isRemoteAction = false;
let isApplyingRemote = false;
let currentFilePath: string | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempts = 0;
let isManualDisconnect = false;
let isJoinPending = false;

let connectionStatusBar: vscode.StatusBarItem;
let workspaceStatusBar: vscode.StatusBarItem;

const cursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
const MAX_FILE_BYTES = 700_000;

function shouldSyncPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || parts.some((part) => !part || part === "." || part === "..")) return false;
  const blockedDirs = new Set([".git", ".vscode", "node_modules", ".idea", ".next", "dist", "build", "coverage"]);
  if (parts.some((part) => blockedDirs.has(part.toLowerCase()))) return false;
  const filename = parts[parts.length - 1].toLowerCase();
  if (/^\.env($|\.)/.test(filename) || /\.(pem|key|p12|pfx|keystore)$/i.test(filename)) return false;
  if (["id_rsa", "id_ed25519", "credentials.json", "secrets.json"].includes(filename)) return false;
  return true;
}

let extensionContext: vscode.ExtensionContext;
let generatedUserId = "user";

function getConfig() {
  const config = vscode.workspace.getConfiguration("collab");
  return {
    serverUrl: String(config.get("serverUrl") || "ws://localhost:3000"),
    workspaceId: String(config.get("workspaceId") || "demo-workspace"),
    userId: String(config.get("userId") || generatedUserId),
  };
}

async function setConfig() {
  const current = getConfig();
  const serverUrl = await vscode.window.showInputBox({
    prompt: "Server URL (ws://localhost for local use, wss:// for remote servers)",
    value: current.serverUrl,
    ignoreFocusOut: true,
  });
  if (!serverUrl) return;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(serverUrl.trim());
    if (!["ws:", "wss:"].includes(parsedUrl.protocol)) throw new Error("Use ws:// or wss://");
    if (parsedUrl.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname)) {
      throw new Error("Remote servers must use wss://");
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Invalid server URL: ${(error as Error).message}`);
    return;
  }

  const workspaceId = await vscode.window.showInputBox({
    prompt: "Workspace ID (letters, numbers, _ and -)",
    value: current.workspaceId,
  });
  if (!workspaceId) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workspaceId)) {
    vscode.window.showErrorMessage("Workspace ID must be 1-64 characters and contain only letters, numbers, _ or -.");
    return;
  }

  const token = await vscode.window.showInputBox({
    prompt: "Server token (at least 24 characters; stored securely)",
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) return;
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(token)) {
    vscode.window.showErrorMessage("The server token must be 24-256 characters using letters, numbers, _ or -.");
    return;
  }

  const userId = await vscode.window.showInputBox({ prompt: "Your unique user ID", value: current.userId });
  if (!userId) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,63}$/.test(userId)) {
    vscode.window.showErrorMessage("User ID must be 1-64 characters and use letters, numbers, spaces, dot, _ or -.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("collab");
  await cfg.update("serverUrl", parsedUrl.toString(), vscode.ConfigurationTarget.Workspace);
  await cfg.update("workspaceId", workspaceId, vscode.ConfigurationTarget.Workspace);
  await extensionContext.secrets.store("collab.workspaceToken", token);
  generatedUserId = userId;
  await extensionContext.globalState.update("collab.generatedUserId", userId);

  isManualDisconnect = true;
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000, "Configuration changed");
  ws = undefined;
  updateStatusBar("Disconnected");
  vscode.window.showInformationMessage("Configuration saved securely. Start the connection to apply it.");
}

function getWorkspaceRoot(docUri?: vscode.Uri): string | undefined {
  if (!docUri) return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(docUri);
  return folder
    ? folder.uri.fsPath
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toRelativePath(doc: vscode.TextDocument): string | undefined {
  const root = getWorkspaceRoot(doc.uri);
  if (!root || doc.uri.scheme !== "file") return undefined;
  const rel = path.relative(root, doc.uri.fsPath).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) || !shouldSyncPath(rel)) return undefined;
  return rel;
}

function updateStatusBar(
  status: "Disconnected" | "Connecting" | "Connected" = "Disconnected",
) {
  const { workspaceId, serverUrl } = getConfig();
  workspaceStatusBar.text = `$(folder) ${workspaceId}`;
  workspaceStatusBar.tooltip = `Server: ${serverUrl}`;
  workspaceStatusBar.show();

  if (status === "Connected") {
    connectionStatusBar.text = `$(plug) Collab: Connected`;
    connectionStatusBar.backgroundColor = undefined;
  } else if (status === "Connecting") {
    connectionStatusBar.text = `$(sync~spin) Collab: Connecting...`;
    connectionStatusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  } else {
    connectionStatusBar.text = `$(circle-slash) Collab: Disconnected`;
    connectionStatusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
  }
  connectionStatusBar.show();
}

async function joinFile(editor: vscode.TextEditor) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const rel = toRelativePath(editor.document);
  if (!rel || !shouldSyncPath(rel)) {
    isJoinPending = false;
    isManualDisconnect = true;
    updateStatusBar("Disconnected");
    vscode.window.showWarningMessage("This file is outside the workspace or excluded from synchronization. Open an eligible workspace file and reconnect.");
    ws.close(1000, "No eligible workspace file");
    return;
  }

  const { workspaceId, userId } = getConfig();
  const token = await extensionContext.secrets.get("collab.workspaceToken");
  if (!token) {
    isManualDisconnect = true;
    vscode.window.showErrorMessage("Set your server token using Jelo Co-Lab: Set Configuration.");
    ws.close(1008, "Missing token");
    return;
  }

  currentFilePath = rel;
  isJoinPending = true;
  updateStatusBar("Connecting");
  ws.send(JSON.stringify({ type: "join", workspaceId, token, userId, filePath: rel }));
}

function updateRemoteCursor(
  userId: string,
  color: string,
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (!cursorDecorations.has(userId)) {
    const decorationType = vscode.window.createTextEditorDecorationType({
      border: `2px solid ${color}`,
      borderWidth: "0 0 0 2px",
      backgroundColor: `${color}33`,
      after: {
        contentText: ` ${userId} `,
        backgroundColor: color,
        color: "#fff",
        margin: "0 0 0 2px",
      },
    });
    cursorDecorations.set(userId, decorationType);
  }

  const decorationType = cursorDecorations.get(userId)!;
  const range = new vscode.Range(startLine, startChar, endLine, endChar);
  editor.setDecorations(decorationType, [range]);
}

function removeRemoteCursor(userId: string) {
  const decorationType = cursorDecorations.get(userId);
  if (decorationType) {
    const editor = vscode.window.activeTextEditor;
    if (editor) editor.setDecorations(decorationType, []);
    decorationType.dispose();
    cursorDecorations.delete(userId);
  }
}

function connect() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const { serverUrl } = getConfig();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(serverUrl);
    if (!['ws:', 'wss:'].includes(parsedUrl.protocol)) throw new Error("Use ws:// or wss://");
    if (parsedUrl.protocol === "ws:" && !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) {
      throw new Error("Remote servers must use wss:// (TLS)." );
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Invalid collaboration server URL: ${(error as Error).message}`);
    return;
  }
  const wsUrl = parsedUrl.toString();

  updateStatusBar("Connecting");
  isManualDisconnect = false;
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    reconnectAttempts = 0;
    updateStatusBar("Connecting");
    if (vscode.window.activeTextEditor) void joinFile(vscode.window.activeTextEditor);
    else {
      isManualDisconnect = true;
      vscode.window.showWarningMessage("Open a workspace file before connecting to Jelo Co-Lab.");
      ws?.close(1000, "No active file");
    }
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const editor = vscode.window.activeTextEditor;

      if (msg.type === "file_created" || msg.type === "sync_file") {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || typeof msg.path !== "string" || !shouldSyncPath(msg.path) || !Array.isArray(msg.content)) return;
        const rootUri = workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, ...msg.path.split(/[\\/]/));
        const contentUint8 = new Uint8Array(msg.content);
        const parentUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
        isRemoteAction = true;
        try {
          await vscode.workspace.fs.createDirectory(parentUri);
          if (msg.type === "file_created") {
            await vscode.workspace.fs.writeFile(fileUri, contentUint8);
          } else {
            try {
              const localStat = await vscode.workspace.fs.stat(fileUri);
              if (Number.isFinite(msg.mtime) && msg.mtime > localStat.mtime) await vscode.workspace.fs.writeFile(fileUri, contentUint8);
            } catch {
              await vscode.workspace.fs.writeFile(fileUri, contentUint8);
            }
          }
        } finally {
          isRemoteAction = false;
        }
        return;
      }

      if (msg.type === "joined") {
        if (msg.filePath !== currentFilePath) return;
        isJoinPending = false;
        updateStatusBar("Connected");
        const active = vscode.window.activeTextEditor;
        if (!msg.hasRemoteFile && active && toRelativePath(active.document) === currentFilePath) {
          const bytes = Buffer.from(active.document.getText(), "utf8");
          ws?.send(JSON.stringify({ type: "file_created", path: currentFilePath, content: Array.from(bytes) }));
        }
        return;
      }

      if (
        msg.filePath &&
        editor &&
        toRelativePath(editor.document) !== msg.filePath
      ) {
        return;
      }

      if (msg.type === "init" && editor && msg.filePath === currentFilePath) {
        if (editor.document.isDirty) {
          vscode.window.showWarningMessage("Jelo Co-Lab kept your unsaved local changes instead of replacing them with the server snapshot.");
          return;
        }
        isApplyingRemote = true;
        try {
          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length),
          );
          await editor.edit((editBuilder) => editBuilder.replace(fullRange, msg.content));
        } finally {
          isApplyingRemote = false;
        }
      }

      if (msg.type === "edit" && editor && Array.isArray(msg.changes)) {
        isApplyingRemote = true;
        try {
          await editor.edit((editBuilder) => {
            for (const change of msg.changes) {
              if (!change || !Array.isArray(change.range) || change.range.length !== 2 || typeof change.text !== "string") continue;
              const range = new vscode.Range(
                change.range[0].line,
                change.range[0].character,
                change.range[1].line,
                change.range[1].character,
              );
              editBuilder.replace(range, change.text);
            }
          });
        } finally {
          isApplyingRemote = false;
        }
      }

      if (msg.type === "cursor") {
        updateRemoteCursor(
          msg.userId,
          msg.color,
          msg.startLine,
          msg.startChar,
          msg.endLine,
          msg.endChar,
        );
      }

      if (msg.type === "leave") {
        removeRemoteCursor(msg.userId);
      }

      if (msg.type === "error") {
        vscode.window.showErrorMessage(`Jelo Co-Lab: ${msg.message}`);
        if (isJoinPending) {
          isJoinPending = false;
          isManualDisconnect = true;
          updateStatusBar("Disconnected");
          ws?.close(1008, "Workspace join failed");
        }
      }
    } catch (e) {
      console.error("Collab WS Error parsing message", e);
    }
  });

  ws.on("error", (error) => {
    vscode.window.showWarningMessage(
      `Collab WebSocket Error: ${error.message}`,
    );
  });

  ws.on("close", () => {
    isJoinPending = false;
    updateStatusBar("Disconnected");
    cursorDecorations.forEach((dec) => dec.dispose());
    cursorDecorations.clear();

    if (!isManualDisconnect) {
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  const identityKey = "collab.generatedUserId";
  const configuredUserId = vscode.workspace.getConfiguration("collab").get<string>("userId");
  generatedUserId = configuredUserId || context.globalState.get<string>(identityKey) || `user-${require("crypto").randomUUID().slice(0, 8)}`;
  if (!configuredUserId) void context.globalState.update(identityKey, generatedUserId);
  connectionStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  workspaceStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  workspaceStatusBar.command = "collab.setConfig";
  context.subscriptions.push(connectionStatusBar, workspaceStatusBar);

  const startCommand = vscode.commands.registerCommand("collab.start", connect);
  const configCommand = vscode.commands.registerCommand(
    "collab.setConfig",
    setConfig,
  );

  const quickStartCommand = vscode.commands.registerCommand(
    "collab.quickStart",
    async () => {
      const cfg = vscode.workspace.getConfiguration("collab");
      await cfg.update(
        "serverUrl",
        "ws://localhost:3000",
        vscode.ConfigurationTarget.Workspace,
      );
      const workspaceId = (vscode.workspace.name || "default")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/^[^a-zA-Z0-9]+/, "")
        .slice(0, 64) || "default";
      await cfg.update("workspaceId", workspaceId, vscode.ConfigurationTarget.Workspace);
      connect();
    },
  );

  let disconnectCmd = vscode.commands.registerCommand(
    "collab.disconnect",
    () => {
      isManualDisconnect = true;
      clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000, "Disconnected by user");
        clearTimeout(reconnectTimer);
        vscode.window.showInformationMessage("Disconnected from Collab workspace.");
      } else {
        updateStatusBar("Disconnected");
        vscode.window.showInformationMessage("Connection stopped.");
      }
    },
  );

  let fileCreateListener = vscode.workspace.onDidCreateFiles(async (event) => {
    const currentWs = ws;
    if (isRemoteAction || !currentWs || currentWs.readyState !== WebSocket.OPEN)
      return;

    for (const file of event.files) {
      const relativePath = vscode.workspace.asRelativePath(file);

      if (!shouldSyncPath(relativePath)) {
        continue;
      }

      const fileData = await vscode.workspace.fs.readFile(file);
      if (fileData.byteLength > MAX_FILE_BYTES) {
        vscode.window.showWarningMessage(`${relativePath} was not synchronized because it exceeds the Phase 1 file limit (${MAX_FILE_BYTES} bytes).`);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        currentWs.send(JSON.stringify({ type: "file_created", path: relativePath, content: Array.from(fileData) }), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  let pushDirCmd = vscode.commands.registerCommand(
    "collab.pushDir",
    async () => {
      const currentWs = ws;
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
        return vscode.window.showErrorMessage("Connect to Jelo Co-Lab first.");
      }
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) return;

      const files: vscode.Uri[] = [];
      const rootUri = workspaceFolders[0].uri;
      async function collectFiles(dirUri: vscode.Uri): Promise<void> {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(dirUri)) {
          const fileUri = vscode.Uri.joinPath(dirUri, name);
          const relativePath = vscode.workspace.asRelativePath(fileUri);
          if (!shouldSyncPath(relativePath)) continue;
          if (type === vscode.FileType.Directory) await collectFiles(fileUri);
          else if (type === vscode.FileType.File) files.push(fileUri);
        }
      }

      try {
        await collectFiles(rootUri);
        let sent = 0;
        let skipped = 0;
        let cancelled = false;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Jelo Co-Lab: Syncing workspace", cancellable: true },
          async (progress, cancellation) => {
            for (const fileUri of files) {
              if (cancellation.isCancellationRequested) { cancelled = true; break; }
              if (currentWs.readyState !== WebSocket.OPEN) throw new Error("Connection closed during transfer");
              const relativePath = vscode.workspace.asRelativePath(fileUri);
              const content = await vscode.workspace.fs.readFile(fileUri);
              if (content.byteLength > MAX_FILE_BYTES) {
                skipped += 1;
                continue;
              }
              const stat = await vscode.workspace.fs.stat(fileUri);
              await new Promise<void>((resolve, reject) => {
                currentWs.send(JSON.stringify({ type: "sync_file", path: relativePath, mtime: stat.mtime, content: Array.from(content) }), (error) => {
                  if (error) reject(error);
                  else resolve();
                });
              });
              sent += 1;
              progress.report({ message: `${sent}/${files.length} files sent` });
              // ponytail: 25 ms pacing stays below the server's 50 messages/second token bucket; add acknowledgements and resumable batches in Phase 2.
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          },
        );
        const skippedText = skipped ? ` ${skipped} oversized files skipped.` : "";
        const transferText = cancelled ? `Sync canceled after ${sent}/${files.length} files.` : `Sync sent ${sent}/${files.length} files.`;
        vscode.window.showInformationMessage(`Jelo Co-Lab: ${transferText}${skippedText}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Jelo Co-Lab transfer failed: ${(error as Error).message}`);
      }
    },
  );

  context.subscriptions.push(
    disconnectCmd,
    fileCreateListener,
    pushDirCmd,
    startCommand,
    configCommand,
    quickStartCommand,
  );
  updateStatusBar();

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isApplyingRemote || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (event.document.isClosed || event.document.isUntitled) return;

      const rel = toRelativePath(event.document);
      if (rel !== currentFilePath) return;
      if (!rel || !shouldSyncPath(rel)) {
        return; 
      }

      const changes = event.contentChanges.map((c) => ({
        text: c.text,
        range: [
          { line: c.range.start.line, character: c.range.start.character },
          { line: c.range.end.line, character: c.range.end.character },
        ],
      }));

      ws.send(
        JSON.stringify({
          type: "edit",
          filePath: rel,
          changes,
          fullContent: event.document.getText(),
        }),
      );
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const rel = toRelativePath(event.textEditor.document);
      if (rel !== currentFilePath) return;
      if (!rel || !shouldSyncPath(rel)) {
        return; 
      }

      const selection = event.selections[0];
      ws.send(
        JSON.stringify({
          type: "cursor",
          filePath: rel,
          startLine: selection.anchor.line,
          startChar: selection.anchor.character,
          endLine: selection.active.line,
          endChar: selection.active.character,
        }),
      );
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        cursorDecorations.forEach((dec) => dec.dispose());
        cursorDecorations.clear();
        joinFile(editor);
      }
    }),
  );
}

export function deactivate() {
  isManualDisconnect = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "leave" }));
    ws.close();
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
  clearTimeout(reconnectTimer);
  cursorDecorations.forEach((dec) => dec.dispose());
}
