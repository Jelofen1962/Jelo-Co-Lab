import * as vscode from "vscode";
import * as path from "path";

type FileMeta = {
  version: number;
  updatedAt: number;
  updatedBy?: string;
};

type LockInfo = {
  userId: string;
  timestamp: number;
};

let syncTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let isStarted = false;
let suppressLocalChanges = false;

const dirtyFiles = new Set<string>();
const localVersions = new Map<string, number>();
const lockedByMe = new Set<string>();
const readOnlyFiles = new Set<string>();
let lastSyncTs = 0;

function getConfig() {
  const config = vscode.workspace.getConfiguration("collab");
  return {
    serverUrl: String(config.get("serverUrl") || "http://localhost:3000"),
    workspaceId: String(config.get("workspaceId") || "demo-workspace"),
    userId: String(config.get("userId") || "user-a")
  };
}

async function apiGet<T = any>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as T;  // ← FIX: assert instead of assign
  return data;
}


async function apiPost<T = any>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let data: T;

  try {
    data = text ? JSON.parse(text) : ({} as T);
  } catch {
    throw new Error(`Invalid JSON from server: ${text}`);
  }

  if (!res.ok) {
    throw new Error((data as any).error || text || "Unknown error");
  }

  return data;
}


function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toRelativePath(doc: vscode.TextDocument): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  if (doc.uri.scheme !== "file") return undefined;
  const fsPath = doc.uri.fsPath;
  const rel = path.relative(root, fsPath).replace(/\\/g, "/");
  if (rel.startsWith("..")) return undefined;
  return rel;
}

async function setConfig() {
  const current = getConfig();

  const serverUrl = await vscode.window.showInputBox({
    prompt: "Server URL",
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

  vscode.window.showInformationMessage("Collab config saved.");
}

async function acquireLockForActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const rel = toRelativePath(editor.document);
  if (!rel) return;

  const { serverUrl, workspaceId, userId } = getConfig();

  try {
    const result = await apiPost(`${serverUrl}/lock/acquire`, {
      workspaceId,
      userId,
      filePath: rel
    });

    if (result.locked) {
      lockedByMe.add(rel);
      readOnlyFiles.delete(rel);
      vscode.window.setStatusBarMessage(`$(lock) Lock acquired: ${rel}`, 2000);
    } else {
      lockedByMe.delete(rel);
      readOnlyFiles.add(rel);
      vscode.window.showWarningMessage(
        `File is locked by ${result.owner}. Read-only mode enforced for ${rel}`
      );
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Lock acquire failed: ${e.message}`);
  }
}

async function heartbeatLocks() {
  const { serverUrl, workspaceId, userId } = getConfig();
  for (const rel of [...lockedByMe]) {
    try {
      const result = await apiPost(`${serverUrl}/lock/heartbeat`, {
        workspaceId,
        userId,
        filePath: rel
      });
      if (!result.held) {
        lockedByMe.delete(rel);
        readOnlyFiles.add(rel);
      }
    } catch {
      // ignore transient
    }
  }
}

async function releaseAllLocks() {
  const { serverUrl, workspaceId, userId } = getConfig();
  for (const rel of [...lockedByMe]) {
    try {
      await apiPost(`${serverUrl}/lock/release`, {
        workspaceId,
        userId,
        filePath: rel
      });
    } catch {
      // ignore
    }
  }
  lockedByMe.clear();
}

async function pushDirtyFiles() {
  const { serverUrl, workspaceId, userId } = getConfig();

  for (const rel of [...dirtyFiles]) {
    const doc = vscode.workspace.textDocuments.find(d => toRelativePath(d) === rel);
    if (!doc) continue;

    if (readOnlyFiles.has(rel)) {
      continue;
    }

    try {
      const version = localVersions.get(rel) ?? 0;
      const result = await apiPost(`${serverUrl}/file/push`, {
        workspaceId,
        userId,
        filePath: rel,
        content: doc.getText(),
        version
      });
      localVersions.set(rel, result.version);
      dirtyFiles.delete(rel);
      lastSyncTs = Math.max(lastSyncTs, result.updatedAt || 0);
    } catch (e: any) {
      if (String(e.message).includes("Version conflict")) {
        vscode.window.showWarningMessage(`Conflict on ${rel}. Pulling remote version.`);
        await pullChanges();
      } else if (String(e.message).includes("locked")) {
        readOnlyFiles.add(rel);
        vscode.window.showWarningMessage(`Push denied. ${rel} is not locked by you.`);
      }
    }
  }
}

async function writeFileFromServer(rel: string, content: string, version: number) {
  const root = getWorkspaceRoot();
  if (!root) return;

  const uri = vscode.Uri.file(path.join(root, rel));
  const edit = new vscode.WorkspaceEdit();

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    suppressLocalChanges = true;
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    edit.replace(uri, fullRange, content);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    localVersions.set(rel, version);
    dirtyFiles.delete(rel);
  } catch {
    suppressLocalChanges = true;
    edit.createFile(uri, { ignoreIfExists: true, overwrite: true });
    edit.insert(uri, new vscode.Position(0, 0), content);
    await vscode.workspace.applyEdit(edit);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
    localVersions.set(rel, version);
    dirtyFiles.delete(rel);
  } finally {
    setTimeout(() => {
      suppressLocalChanges = false;
    }, 200);
  }
}

async function pullChanges() {
  const { serverUrl, workspaceId, userId } = getConfig();

  try {
    const result = await apiGet(
      `${serverUrl}/changes?workspaceId=${encodeURIComponent(workspaceId)}&since=${lastSyncTs}`
    );

    for (const file of result.files || []) {
      if (file.updatedBy === userId) {
        localVersions.set(file.filePath, file.version);
        lastSyncTs = Math.max(lastSyncTs, file.updatedAt || 0);
        continue;
      }

      if (dirtyFiles.has(file.filePath)) {
        vscode.window.showWarningMessage(
          `Remote update skipped for dirty local file ${file.filePath}. Resolve manually.`
        );
        lastSyncTs = Math.max(lastSyncTs, file.updatedAt || 0);
        continue;
      }

      await writeFileFromServer(file.filePath, file.content, file.version);
      lastSyncTs = Math.max(lastSyncTs, file.updatedAt || 0);
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
  }
}

async function revertIfReadOnly(doc: vscode.TextDocument) {
  const rel = toRelativePath(doc);
  if (!rel) return;
  if (!readOnlyFiles.has(rel)) return;

  suppressLocalChanges = true;
  try {
    await vscode.commands.executeCommand("workbench.action.files.revert");
    vscode.window.showWarningMessage(`Read-only enforced. Reverted changes in ${rel}`);
  } finally {
    setTimeout(() => {
      suppressLocalChanges = false;
    }, 200);
  }
}

async function initialSync() {
  const { serverUrl, workspaceId } = getConfig();
  await apiPost(`${serverUrl}/workspace/init`, { workspaceId });

  const manifest = await apiGet(
    `${serverUrl}/manifest?workspaceId=${encodeURIComponent(workspaceId)}`
  );

  for (const [rel, meta] of Object.entries(manifest.files || {}) as [string, FileMeta][]) {
    localVersions.set(rel, meta.version);
    lastSyncTs = Math.max(lastSyncTs, meta.updatedAt || 0);
  }

  const userId = getConfig().userId;
  for (const [rel, lock] of Object.entries(manifest.locks || {}) as [string, LockInfo][]) {
    if (lock.userId !== userId) {
      readOnlyFiles.add(rel);
    }
  }

  await pullChanges();
}

async function start() {
  if (isStarted) {
    vscode.window.showInformationMessage("Collab already started.");
    return;
  }

  try {
    await initialSync();

    syncTimer = setInterval(async () => {
      await pushDirtyFiles();
      await pullChanges();
    }, 5000);

    heartbeatTimer = setInterval(async () => {
      await heartbeatLocks();
    }, 5000);

    isStarted = true;
    vscode.window.showInformationMessage("Collab MVP started.");
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to start Collab: ${e.message}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("collab.setConfig", setConfig),
    vscode.commands.registerCommand("collab.start", start),

    vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (!editor) return;
      await acquireLockForActiveEditor();
    }),

    vscode.workspace.onDidChangeTextDocument(async event => {
      if (suppressLocalChanges) return;
      const rel = toRelativePath(event.document);
      if (!rel) return;

      if (readOnlyFiles.has(rel)) {
        await revertIfReadOnly(event.document);
        return;
      }

      dirtyFiles.add(rel);
    }),

    {
      dispose: () => {
        if (syncTimer) clearInterval(syncTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        releaseAllLocks();
      }
    }
  );
}

export function deactivate() {
  if (syncTimer) clearInterval(syncTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  releaseAllLocks();
}
