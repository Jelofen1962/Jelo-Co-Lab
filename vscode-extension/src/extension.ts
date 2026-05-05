import * as vscode from "vscode";
import * as path from "path";
import * as WebSocket from "ws";

let ws: WebSocket | undefined;
let isApplyingRemote = false;
let currentFilePath: string | undefined;

async function setConfig() {
  const current = getConfig();

  const serverUrl = await vscode.window.showInputBox({
    prompt: "Server URL (ws://...)",
    value: current.serverUrl
  });
  if (!serverUrl) return;

  const workspaceId = await vscode.window.showInputBox({
    prompt: "Workspace ID",
    value: current.workspaceId
  });
  if (!workspaceId) return;

  const userId = await vscode.window.showInputBox({
    prompt: "User ID",
    value: current.userId
  });
  if (!userId) return;

  const cfg = vscode.workspace.getConfiguration("collab");

  await cfg.update("serverUrl", serverUrl, vscode.ConfigurationTarget.Workspace);
  await cfg.update("workspaceId", workspaceId, vscode.ConfigurationTarget.Workspace);
  await cfg.update("userId", userId, vscode.ConfigurationTarget.Workspace);

  vscode.window.showInformationMessage("Collab configuration saved.");
}


// Decoration types for remote user cursors
const cursorDecorations = new Map<string, vscode.TextEditorDecorationType>();


function getConfig() {
  const config = vscode.workspace.getConfiguration("collab");
  return {
    serverUrl: String(config.get("serverUrl") || "ws://localhost:3000"),
    workspaceId: String(config.get("workspaceId") || "demo-workspace"),
    userId: String(config.get("userId") || "user-a"),
  };
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toRelativePath(doc: vscode.TextDocument): string | undefined {
  const root = getWorkspaceRoot();
  if (!root || doc.uri.scheme !== "file") return undefined;
  const rel = path.relative(root, doc.uri.fsPath).replace(/\\/g, "/");
  if (rel.startsWith("..")) return undefined;
  return rel;
}

async function joinFile(editor: vscode.TextEditor) {
  const rel = toRelativePath(editor.document);
  if (!rel) return;

  currentFilePath = rel;
  const { workspaceId, userId } = getConfig();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "join",
        workspaceId,
        userId,
        filePath: rel,
      }),
    );
  }
}

function updateRemoteCursor(
  userId: string,
  color: string,
  line: number,
  character: number,
  selectionLength: number = 0,
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (!cursorDecorations.has(userId)) {
    const decorationType = vscode.window.createTextEditorDecorationType({
      border: `2px solid ${color}`,
      borderWidth: "0 0 0 2px",
      backgroundColor: selectionLength > 0 ? `${color}33` : undefined,
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
  const range = new vscode.Range(
    line,
    character,
    line,
    character + selectionLength,
  );
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

export function activate(context: vscode.ExtensionContext) {
  const startCommand = vscode.commands.registerCommand("collab.start", () => {
    const { serverUrl } = getConfig();
    const wsUrl = serverUrl.replace("http", "ws");

    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      vscode.window.showInformationMessage("Connected to Collab Server.");
      if (vscode.window.activeTextEditor) {
        joinFile(vscode.window.activeTextEditor);
      }
    });

    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "init") {
        isApplyingRemote = true;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length),
          );
          await editor.edit((editBuilder) => {
            editBuilder.replace(fullRange, msg.content);
          });
        }
        isApplyingRemote = false;
      }

      if (msg.type === "edit") {
        isApplyingRemote = true;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await editor.edit((editBuilder) => {
            for (const change of msg.changes) {
              const range = new vscode.Range(
                change.range[0].line,
                change.range[0].character,
                change.range[1].line,
                change.range[1].character,
              );
              editBuilder.replace(range, change.text);
            }
          });
        }
        isApplyingRemote = false;
      }

      if (msg.type === "cursor") {
        updateRemoteCursor(
          msg.userId,
          msg.color,
          msg.line,
          msg.character,
          msg.selectionLength,
        );
      }

      if (msg.type === "leave") {
        removeRemoteCursor(msg.userId);
      }
    });

    ws.on("close", () => {
      vscode.window.showErrorMessage("Disconnected from Collab Server.");
    });
  });
  const configCommand = vscode.commands.registerCommand("collab.setConfig", setConfig);

  context.subscriptions.push(startCommand, configCommand);


  // Handle local text changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isApplyingRemote || !ws || ws.readyState !== WebSocket.OPEN) return;

      const rel = toRelativePath(event.document);
      if (rel !== currentFilePath) return;

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
          changes,
          fullContent: event.document.getText(),
        }),
      );
    }),
  );

  // Handle local cursor moves
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const rel = toRelativePath(event.textEditor.document);
      if (rel !== currentFilePath) return;

      const selection = event.selections[0];
      ws.send(
        JSON.stringify({
          type: "cursor",
          line: selection.active.line,
          character: selection.active.character,
          selectionLength: Math.abs(
            selection.active.character - selection.anchor.character,
          ),
        }),
      );
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
  if (ws) ws.close();
  cursorDecorations.forEach((dec) => dec.dispose());
}
