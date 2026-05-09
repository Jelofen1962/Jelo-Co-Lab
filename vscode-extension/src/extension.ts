import * as vscode from "vscode";
import * as path from "path";
import * as WebSocket from "ws";

let ws: WebSocket | undefined;
let isApplyingRemote = false;
let currentFilePath: string | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempts = 0;

let connectionStatusBar: vscode.StatusBarItem;
let workspaceStatusBar: vscode.StatusBarItem;

// Decoration types for remote user cursors
const cursorDecorations = new Map<string, vscode.TextEditorDecorationType>();

function getConfig() {
  const config = vscode.workspace.getConfiguration("collab");
  return {
    serverUrl: String(config.get("serverUrl") || "ws://localhost:3000"),
    workspaceId: String(config.get("workspaceId") || "demo-workspace"),
    userId: String(config.get("userId") || "user-a"),
    token: String(config.get("token") || ""),
  };
}

async function setConfig() {
  const current = getConfig();

  const serverUrl = await vscode.window.showInputBox({ prompt: "Server URL (ws://...)", value: current.serverUrl });
  if (!serverUrl) return;

  const workspaceId = await vscode.window.showInputBox({ prompt: "Workspace ID", value: current.workspaceId });
  if (!workspaceId) return;

  const token = await vscode.window.showInputBox({ prompt: "Workspace Token (Secret)", value: current.token });
  if (token === undefined) return;

  const userId = await vscode.window.showInputBox({ prompt: "User ID", value: current.userId });
  if (!userId) return;

  const cfg = vscode.workspace.getConfiguration("collab");
  await cfg.update("serverUrl", serverUrl, vscode.ConfigurationTarget.Workspace);
  await cfg.update("workspaceId", workspaceId, vscode.ConfigurationTarget.Workspace);
  await cfg.update("token", token, vscode.ConfigurationTarget.Workspace);
  await cfg.update("userId", userId, vscode.ConfigurationTarget.Workspace);

  vscode.window.showInformationMessage("Collab configuration saved.");
  updateStatusBar();
}

function getWorkspaceRoot(docUri?: vscode.Uri): string | undefined {
  if (!docUri) return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(docUri);
  return folder ? folder.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toRelativePath(doc: vscode.TextDocument): string | undefined {
  const root = getWorkspaceRoot(doc.uri);
  if (!root || doc.uri.scheme !== "file") return undefined;
  const rel = path.relative(root, doc.uri.fsPath).replace(/\\/g, "/");
  if (rel.startsWith("..")) return undefined;
  return rel;
}

function updateStatusBar(status: "Disconnected" | "Connecting" | "Connected" = "Disconnected") {
  const { workspaceId, serverUrl } = getConfig();
  workspaceStatusBar.text = `$(folder) ${workspaceId}`;
  workspaceStatusBar.tooltip = `Server: ${serverUrl}`;
  workspaceStatusBar.show();

  if (status === "Connected") {
    connectionStatusBar.text = `$(plug) Collab: Connected`;
    connectionStatusBar.backgroundColor = undefined;
  } else if (status === "Connecting") {
    connectionStatusBar.text = `$(sync~spin) Collab: Reconnecting...`;
    connectionStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    connectionStatusBar.text = `$(circle-slash) Collab: Disconnected`;
    connectionStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  connectionStatusBar.show();
}

async function joinFile(editor: vscode.TextEditor) {
  const rel = toRelativePath(editor.document);
  if (!rel) return;

  currentFilePath = rel;
  const { workspaceId, userId, token } = getConfig();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "join",
        workspaceId,
        token,
        userId,
        filePath: rel,
      }),
    );
  }
}

function updateRemoteCursor(userId: string, color: string, startLine: number, startChar: number, endLine: number, endChar: number) {
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
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const { serverUrl } = getConfig();
  const wsUrl = serverUrl.replace("http", "ws");

  updateStatusBar("Connecting");
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    reconnectAttempts = 0;
    updateStatusBar("Connected");
    if (vscode.window.activeTextEditor) {
      joinFile(vscode.window.activeTextEditor);
    }
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const editor = vscode.window.activeTextEditor;
      
      // Safety Check: Ensure active file matches message file path
      if (msg.filePath && editor && toRelativePath(editor.document) !== msg.filePath) {
        return;
      }

      if (msg.type === "init" && editor) {
        isApplyingRemote = true;
        const fullRange = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(editor.document.getText().length),
        );
        await editor.edit((editBuilder) => {
          editBuilder.replace(fullRange, msg.content);
        });
        isApplyingRemote = false;
      }

      if (msg.type === "edit" && editor) {
        isApplyingRemote = true;
        await editor.edit((editBuilder) => {
          for (const change of msg.changes) {
            const range = new vscode.Range(
              change.range[0].line, change.range[0].character,
              change.range[1].line, change.range[1].character,
            );
            editBuilder.replace(range, change.text);
          }
        });
        isApplyingRemote = false;
      }

      if (msg.type === "cursor") {
        updateRemoteCursor(msg.userId, msg.color, msg.startLine, msg.startChar, msg.endLine, msg.endChar);
      }

      if (msg.type === "leave") {
        removeRemoteCursor(msg.userId);
      }
      
      if (msg.type === "error") {
        vscode.window.showErrorMessage(`Collab Server: ${msg.message}`);
      }
    } catch (e) {
      console.error("Collab WS Error parsing message", e);
    }
  });

  ws.on("error", (error) => {
    vscode.window.showWarningMessage(`Collab WebSocket Error: ${error.message}`);
  });

  ws.on("close", () => {
    updateStatusBar("Disconnected");
    cursorDecorations.forEach((dec) => dec.dispose());
    cursorDecorations.clear();
    
    // Exponential backoff reconnect
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  });
}

export function activate(context: vscode.ExtensionContext) {
  connectionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  workspaceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  workspaceStatusBar.command = "collab.setConfig";
  context.subscriptions.push(connectionStatusBar, workspaceStatusBar);

  const startCommand = vscode.commands.registerCommand("collab.start", connect);
  const configCommand = vscode.commands.registerCommand("collab.setConfig", setConfig);
  
  const quickStartCommand = vscode.commands.registerCommand("collab.quickStart", async () => {
    const cfg = vscode.workspace.getConfiguration("collab");
    await cfg.update("serverUrl", "ws://localhost:3000", vscode.ConfigurationTarget.Workspace);
    await cfg.update("workspaceId", vscode.workspace.name || "default", vscode.ConfigurationTarget.Workspace);
    await cfg.update("userId", process.env.USER || process.env.USERNAME || "user", vscode.ConfigurationTarget.Workspace);
    connect();
  });

  context.subscriptions.push(startCommand, configCommand, quickStartCommand);
  updateStatusBar();

  // Handle local text changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isApplyingRemote || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (event.document.isClosed || event.document.isUntitled) return; // safety

      const rel = toRelativePath(event.document);
      if (rel !== currentFilePath) return;

      const changes = event.contentChanges.map((c) => ({
        text: c.text,
        range: [
          { line: c.range.start.line, character: c.range.start.character },
          { line: c.range.end.line, character: c.range.end.character },
        ],
      }));

      ws.send(JSON.stringify({
        type: "edit",
        filePath: rel,
        changes,
        fullContent: event.document.getText(),
      }));
    }),
  );

  // Handle local cursor moves
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const rel = toRelativePath(event.textEditor.document);
      if (rel !== currentFilePath) return;

      const selection = event.selections[0];
      ws.send(JSON.stringify({
        type: "cursor",
        filePath: rel,
        startLine: selection.anchor.line,
        startChar: selection.anchor.character,
        endLine: selection.active.line,
        endChar: selection.active.character,
      }));
    }),
  );

  // Handle file switching
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "leave" }));
    ws.close();
  }
  clearTimeout(reconnectTimer);
  cursorDecorations.forEach((dec) => dec.dispose());
}
