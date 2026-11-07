"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const ot_1 = require("./ot");
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 48 * 1024;
const blockedDirectories = new Set([".git", ".vscode", ".jelo-state", "node_modules", ".idea", ".next", ".aws", ".ssh", ".gnupg", ".azure", ".kube", ".terraform", ".venv", "venv", ".tox", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", ".turbo", ".parcel-cache", "dist", "build", "coverage"]);
const blockedFiles = new Set(["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials.json", "secrets.json", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "authorized_keys", "known_hosts"]);
let ws;
let extensionContext;
let generatedUserId = "user";
let isManualDisconnect = false;
let workspaceJoined = false;
let reconnectAttempts = 0;
let reconnectTimer;
let incomingQueue = Promise.resolve();
let activeFilePath;
let connectionStatusBar;
let workspaceStatusBar;
const documents = new Map();
const documentUris = new Map();
const applyingRemote = new Set();
const isRemoteAction = new Map();
const subscribedFiles = new Set();
const downloads = new Map();
const completedDownloads = new Set();
const requestedDownloadPaths = new Set();
const pendingDownloadPaths = new Set();
const pendingFilePaths = new Set();
const pendingFileOperations = [];
let fileOperationRetry;
const waiters = [];
const cursorDecorations = new Map();
const collaborators = new Map();
const collaboratorFiles = new Map();
const conflicts = new Map();
const transferStates = new Map();
let transferPaused = false;
let latencyMs;
let currentRole;
let reconcileRunning = false;
class CoLabTreeItem extends vscode.TreeItem {
    constructor(label, description, contextValue, command) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.contextValue = contextValue;
        this.command = command;
        this.accessibilityInformation = { label: description ? `${label}, ${description}` : label, role: "treeitem" };
    }
}
class CoLabTreeProvider {
    constructor(kind) {
        this.kind = kind;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
    }
    refresh() { this.emitter.fire(); }
    dispose() { this.emitter.dispose(); }
    getTreeItem(item) { return item; }
    getChildren() {
        if (this.kind === "collaborators") {
            const items = [new CoLabTreeItem(`${getConfig().userId} (you)`, currentRole || "Not connected", "self")];
            for (const [userId, color] of collaborators) {
                const files = Array.from(collaboratorFiles.get(userId) || []);
                const item = new CoLabTreeItem(userId, files.length ? files.join(", ") : "Connected", "collaborator", {
                    command: "collab.showCollaboratorFiles", title: "Show collaborator documents", arguments: [userId],
                });
                item.iconPath = new vscode.ThemeIcon("account");
                item.tooltip = `${files.length ? `Active documents: ${files.join(", ")}` : "Connected"}. Presence color ${color}`;
                items.push(item);
            }
            return items;
        }
        if (this.kind === "transfers") {
            const items = [];
            if (transferPaused)
                items.push(new CoLabTreeItem("Transfers paused", "Run Resume File Transfers to continue", "paused"));
            for (const filePath of pendingFilePaths)
                items.push(new CoLabTreeItem(filePath, transferStates.get(filePath)?.state || "Queued", "transfer", {
                    command: "collab.retryTransfer", title: "Retry transfer", arguments: [filePath],
                }));
            for (const [filePath, state] of transferStates)
                if (!pendingFilePaths.has(filePath))
                    items.push(new CoLabTreeItem(filePath, state.detail || state.state, "transfer", { command: "collab.retryTransfer", title: "Retry transfer", arguments: [filePath] }));
            for (const operation of pendingFileOperations)
                items.push(new CoLabTreeItem(operation.operation === "delete" ? operation.path : `${operation.from} → ${operation.to}`, `Pending ${operation.operation}`, "file-operation"));
            return items;
        }
        return Array.from(conflicts, ([filePath, conflict]) => new CoLabTreeItem(filePath, conflict.reason, "conflict", { command: "collab.conflicts", title: "Resolve conflict", arguments: [filePath] }));
    }
}
let collaboratorProvider;
let transferProvider;
let conflictProvider;
function refreshViews() { collaboratorProvider?.refresh(); transferProvider?.refresh(); conflictProvider?.refresh(); }
function getConfig() {
    const config = vscode.workspace.getConfiguration("collab");
    return {
        serverUrl: String(config.get("serverUrl") || "ws://localhost:3000"),
        workspaceId: String(config.get("workspaceId") || "demo-workspace"),
        userId: String(config.get("userId") || generatedUserId),
    };
}
function stateKey(name) {
    const { serverUrl, workspaceId } = getConfig();
    const namespace = crypto.createHash("sha256").update(`${serverUrl}\0${workspaceId}`).digest("hex").slice(0, 20);
    return `collab.${namespace}.${name}`;
}
function safeFolderName(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 60) || "workspace";
}
function workspaceRootSegment(folder) {
    const base = safeFolderName(folder.name);
    const matching = (vscode.workspace.workspaceFolders || []).filter((item) => safeFolderName(item.name) === base);
    if (matching.length < 2)
        return base;
    return `${base}-${matching.indexOf(folder) + 1}`;
}
function matchesExcludePattern(relativePath, pattern) {
    const normalized = pattern.replace(/\\/g, "/").trim();
    if (!normalized)
        return false;
    const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "§§DOUBLESTARSLASH§§")
        .replace(/\*\*/g, "§§DOUBLESTAR§§")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/§§DOUBLESTARSLASH§§/g, "(?:.*/)?")
        .replace(/§§DOUBLESTAR§§/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(relativePath);
}
function shouldSyncPath(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || parts.some((part) => !part || part === "." || part === ".."))
        return false;
    if (parts.some((part) => blockedDirectories.has(part.toLowerCase())))
        return false;
    const filename = parts[parts.length - 1].toLowerCase();
    if (/^\.env($|\.)/.test(filename) || /\.(pem|key|p12|pfx|keystore)$/i.test(filename))
        return false;
    if (blockedFiles.has(filename))
        return false;
    const patterns = vscode.workspace.getConfiguration("collab").get("excludePatterns") || [];
    return !patterns.some((pattern) => matchesExcludePattern(normalized, pattern));
}
function toWorkspacePath(uri) {
    if (uri.scheme !== "file")
        return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder)
        return undefined;
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
    const candidate = vscode.workspace.workspaceFolders?.length === 1
        ? relative
        : `${workspaceRootSegment(folder)}/${relative}`;
    return shouldSyncPath(candidate) ? candidate : undefined;
}
function uriForWorkspacePath(filePath) {
    if (!shouldSyncPath(filePath))
        return undefined;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length)
        return undefined;
    if (folders.length === 1)
        return vscode.Uri.joinPath(folders[0].uri, ...filePath.split("/"));
    const [rootName, ...parts] = filePath.split("/");
    const folder = folders.find((item) => workspaceRootSegment(item) === rootName);
    return folder && parts.length ? vscode.Uri.joinPath(folder.uri, ...parts) : undefined;
}
function getDocument(uri) {
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
}
function markRemoteAction(filePath) {
    const previous = isRemoteAction.get(filePath);
    if (previous)
        clearTimeout(previous);
    isRemoteAction.set(filePath, setTimeout(() => isRemoteAction.delete(filePath), 2000));
}
function isRemotePathEvent(filePath) {
    for (const [remotePath] of isRemoteAction) {
        if (filePath === remotePath || filePath.startsWith(`${remotePath}/`) || remotePath.startsWith(`${filePath}/`))
            return true;
    }
    return false;
}
function getSession(document) {
    const filePath = toWorkspacePath(document.uri);
    if (!filePath)
        return undefined;
    let session = documents.get(filePath);
    if (!session) {
        const saved = extensionContext.globalState.get(stateKey("outbox")) || {};
        const restored = saved[filePath];
        session = {
            filePath, uri: document.uri, revision: restored?.revision ?? -1,
            text: document.getText(), initialized: !!restored, resuming: false,
            pending: Array.isArray(restored?.pending) ? restored.pending : [], cursors: new Map(),
        };
        documents.set(filePath, session);
    }
    else {
        session.uri = document.uri;
    }
    documentUris.set(filePath, document.uri);
    return session;
}
async function persistOutbox() {
    const saved = {};
    for (const [filePath, session] of documents) {
        if (session.pending.length)
            saved[filePath] = { revision: session.revision, pending: session.pending };
    }
    await extensionContext.globalState.update(stateKey("outbox"), saved);
}
async function persistFileQueue() {
    await extensionContext.globalState.update(stateKey("pendingFiles"), Array.from(pendingFilePaths));
}
async function persistFileOperations() {
    await extensionContext.globalState.update(stateKey("pendingFileOperations"), pendingFileOperations);
}
async function queueFileOperation(operation) {
    pendingFileOperations.push({ ...operation, operationId: crypto.randomUUID() });
    await persistFileOperations();
    await retryPendingFileOperations();
}
function retryPendingFileOperations() {
    if (fileOperationRetry)
        return fileOperationRetry;
    const socket = ws;
    if (!workspaceJoined || !socket || socket.readyState !== WebSocket.OPEN)
        return Promise.resolve();
    fileOperationRetry = (async () => {
        while (pendingFileOperations.length && ws === socket && socket.readyState === WebSocket.OPEN) {
            const operation = pendingFileOperations[0];
            const payload = operation.operation === "delete"
                ? { type: "file_delete", path: operation.path, operationId: operation.operationId }
                : { type: "file_move", from: operation.from, to: operation.to, operationId: operation.operationId };
            try {
                await requestWithAck(socket, payload, (message) => message.type === "file_operation_ack" &&
                    message.operationId === operation.operationId && message.operation === operation.operation);
                if (pendingFileOperations[0]?.operationId === operation.operationId)
                    pendingFileOperations.shift();
                await persistFileOperations();
                refreshViews();
            }
            catch (error) {
                console.warn(`Jelo Co-Lab will retry pending ${operation.operation} operation:`, error);
                return;
            }
        }
    })().finally(() => { fileOperationRetry = undefined; });
    return fileOperationRetry;
}
async function retryPendingFiles() {
    if (transferPaused || !workspaceJoined || !ws || ws.readyState !== WebSocket.OPEN)
        return;
    const attempted = new Set();
    while (pendingFilePaths.size && attempted.size < 10000) {
        const filePath = Array.from(pendingFilePaths).find((candidate) => !attempted.has(candidate));
        if (!filePath)
            break;
        attempted.add(filePath);
        if (documents.has(filePath)) {
            pendingFilePaths.delete(filePath);
            await persistFileQueue();
            continue;
        }
        const uri = uriForWorkspacePath(filePath);
        if (!uri) {
            pendingFilePaths.delete(filePath);
            await persistFileQueue();
            continue;
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type !== vscode.FileType.File) {
                pendingFilePaths.delete(filePath);
                await persistFileQueue();
                continue;
            }
            await sendWorkspaceFile(uri, filePath);
        }
        catch (error) {
            console.warn(`Jelo Co-Lab will retry ${filePath} after the next connection:`, error);
            if (/exceeds the 10 MB|excluded from synchronization|file not found|ENOENT|FileNotFound/i.test(error.message)) {
                pendingFilePaths.delete(filePath);
                await persistFileQueue();
            }
        }
    }
}
function updateStatusBar(status = "Disconnected") {
    const { workspaceId, serverUrl } = getConfig();
    workspaceStatusBar.text = `$(folder) ${workspaceId}`;
    workspaceStatusBar.tooltip = `Server: ${serverUrl}`;
    workspaceStatusBar.show();
    connectionStatusBar.text = status === "Connected" ? `$(plug) Collab: Connected (${collaborators.size + 1})`
        : status === "Connecting" ? "$(sync~spin) Collab: Connecting..." : "$(circle-slash) Collab: Disconnected";
    connectionStatusBar.backgroundColor = status === "Connected" ? undefined
        : new vscode.ThemeColor(status === "Connecting" ? "statusBarItem.warningBackground" : "statusBarItem.errorBackground");
    connectionStatusBar.tooltip = status === "Connected"
        ? `Connected. Collaborators: ${Array.from(collaborators.keys()).join(", ") || "None"}. Latency: ${latencyMs === undefined ? "measuring" : `${latencyMs} ms`}. Role: ${currentRole || "unknown"}. Click to disconnect.`
        : `Jelo Co-Lab: ${status}. Click to configure or connect.`;
    connectionStatusBar.command = status === "Connected" ? "collab.disconnect" : "collab.quickStart";
    connectionStatusBar.show();
}
function sendMessage(payload) {
    if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(payload));
}
function waitForMessage(socket, requestId, predicate, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        const waiter = {
            socket, requestId, predicate, resolve, reject,
            timer: setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0)
                    waiters.splice(index, 1);
                reject(new Error("The server did not acknowledge the operation in time."));
            }, timeoutMs),
        };
        waiters.push(waiter);
    });
}
function settleWaiters(message) {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (message.type === "error" && message.requestId === waiter.requestId) {
            clearTimeout(waiter.timer);
            waiters.splice(index, 1);
            const error = new Error(message.message || "Server rejected the request");
            error.retryAfterMs = message.retryAfterMs;
            waiter.reject(error);
        }
        else if (waiter.predicate(message)) {
            clearTimeout(waiter.timer);
            waiters.splice(index, 1);
            waiter.resolve(message);
        }
    }
}
async function requestWithAck(socket, payload, predicate, attempts = 3) {
    let lastError;
    const requestId = crypto.randomUUID();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (ws !== socket || socket.readyState !== WebSocket.OPEN)
            throw new Error("Connection closed during transfer");
        const acknowledged = waitForMessage(socket, requestId, predicate);
        try {
            socket.send(JSON.stringify({ ...payload, requestId }));
            return await acknowledged;
        }
        catch (error) {
            lastError = error;
            if (/server rejected|authentication failed|invalid|exceeds|currently open|operation ID was reused|unknown outcome/i.test(lastError.message))
                break;
        }
    }
    throw lastError || new Error("Operation failed");
}
async function requestBinaryChunk(socket, transferId, index, chunk) {
    const requestId = crypto.randomUUID();
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const acknowledged = waitForMessage(socket, requestId, (message) => message.type === "file_chunk_ack" && message.transferId === transferId && message.index === index, 30000);
        try {
            const header = Buffer.from(JSON.stringify({ type: "file_chunk_binary", transferId, index, requestId }));
            const frame = Buffer.allocUnsafe(4 + header.length + chunk.length);
            frame.writeUInt32BE(header.length, 0);
            header.copy(frame, 4);
            chunk.copy(frame, 4 + header.length);
            socket.send(frame, { binary: true });
            await acknowledged;
            return;
        }
        catch (error) {
            lastError = error;
            if (socket.readyState !== WebSocket.OPEN)
                break;
            const retryAfterMs = error.retryAfterMs;
            if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= 10000) {
                await new Promise((resolve) => setTimeout(resolve, retryAfterMs + 25));
                continue;
            }
            if (/server rejected|authentication failed|invalid|exceeds|currently open|unknown outcome/i.test(lastError.message))
                break;
        }
    }
    throw lastError || new Error("Binary file chunk was not acknowledged");
}
async function sendWorkspaceFile(uri, filePath, cancellation) {
    if (!shouldSyncPath(filePath))
        throw new Error("This path is excluded from synchronization");
    pendingFilePaths.add(filePath);
    await persistFileQueue();
    if (transferPaused) {
        transferStates.set(filePath, { state: "Queued", detail: "Transfers are paused" });
        refreshViews();
        throw new Error("Transfers are paused; file queued for resume");
    }
    transferStates.set(filePath, { state: "Preparing" });
    refreshViews();
    const socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || !workspaceJoined)
        throw new Error("Not connected; file queued for the next connection");
    const content = Buffer.from(await vscode.workspace.fs.readFile(uri));
    if (content.length > MAX_FILE_BYTES) {
        pendingFilePaths.delete(filePath);
        await persistFileQueue();
        throw new Error(`${filePath} exceeds the 10 MB file limit`);
    }
    const stat = await vscode.workspace.fs.stat(uri);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const transferKey = crypto.createHash("sha256").update(`${getConfig().workspaceId}\0${filePath}\0${sha256}`).digest("hex");
    const transferIds = extensionContext.globalState.get(stateKey("uploadTransferIds")) || {};
    const transferId = transferIds[transferKey] || crypto.randomUUID();
    if (!transferIds[transferKey]) {
        transferIds[transferKey] = transferId;
        await extensionContext.globalState.update(stateKey("uploadTransferIds"), transferIds);
    }
    try {
        transferStates.set(filePath, { state: "Uploading", detail: `${content.length.toLocaleString()} bytes` });
        refreshViews();
        const begin = await requestWithAck(socket, { type: "file_begin", transferId, path: filePath, size: content.length, mtime: stat.mtime, sha256 }, (message) => message.type === "file_begin_ack" && message.transferId === transferId);
        if (!begin.complete) {
            const startIndex = Number.isSafeInteger(begin.nextIndex) ? begin.nextIndex : 0;
            const startOffset = startIndex * CHUNK_BYTES;
            if (startOffset > content.length)
                throw new Error("Server reported an invalid resume offset");
            for (let offset = startOffset, index = startIndex; offset < content.length; offset += CHUNK_BYTES, index += 1) {
                if (cancellation?.isCancellationRequested)
                    throw new Error("Transfer cancelled");
                await requestBinaryChunk(socket, transferId, index, content.subarray(offset, offset + CHUNK_BYTES));
            }
            if (cancellation?.isCancellationRequested)
                throw new Error("Transfer cancelled");
            await requestWithAck(socket, { type: "file_end", transferId, sha256 }, (message) => message.type === "file_ack" && message.transferId === transferId);
        }
        delete transferIds[transferKey];
        await extensionContext.globalState.update(stateKey("uploadTransferIds"), transferIds);
        pendingFilePaths.delete(filePath);
        transferStates.set(filePath, { state: "Complete" });
        refreshViews();
        await persistFileQueue();
        await retryPendingFileOperations();
    }
    catch (error) {
        if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "file_cancel", transferId }));
        transferStates.set(filePath, { state: "Failed", detail: error.message });
        refreshViews();
        if (error.message === "Transfer cancelled")
            await persistFileQueue();
        throw error;
    }
}
async function replaceDocumentText(document, text) {
    if (document.getText() === text)
        return;
    const filePath = toWorkspacePath(document.uri);
    if (filePath)
        applyingRemote.add(filePath);
    try {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        if (!await vscode.workspace.applyEdit(edit))
            throw new Error("VS Code could not apply the synchronized edit");
    }
    finally {
        if (filePath)
            applyingRemote.delete(filePath);
    }
}
function isEmptyOperation(operation) {
    return operation.every((part) => part.type === "retain");
}
async function sendNextPending(session) {
    if (!workspaceJoined || !ws || ws.readyState !== WebSocket.OPEN || session.resuming)
        return;
    const pending = session.pending[0];
    if (!pending || pending.sent)
        return;
    pending.baseRevision = session.revision;
    pending.sent = true;
    try {
        sendMessage({ type: "edit", filePath: session.filePath, clientId: pending.clientId,
            opId: pending.opId, baseRevision: pending.baseRevision, ops: pending.ops });
    }
    catch {
        pending.sent = false;
    }
    await persistOutbox();
}
async function queueLocalText(session, document, changes) {
    const nextText = document.getText();
    const operation = (0, ot_1.changesToOperation)(session.text, changes, nextText);
    if (!session.initialized) {
        session.text = nextText;
        return;
    }
    if (isEmptyOperation(operation)) {
        session.text = nextText;
        return;
    }
    if (session.pending.length >= 1000) {
        vscode.window.showErrorMessage("Jelo Co-Lab has reached its offline edit queue limit. Save a local backup before continuing.");
        return;
    }
    session.text = nextText;
    const { userId } = getConfig();
    session.pending.push({ opId: crypto.randomUUID(), clientId: userId, ops: operation, baseRevision: session.revision, sent: false });
    await persistOutbox();
    await sendNextPending(session);
}
async function applyRemoteEntry(session, entry) {
    const document = getDocument(session.uri) || await vscode.workspace.openTextDocument(session.uri);
    let remoteOperation = entry.ops;
    for (const pending of session.pending) {
        const beforeRemote = remoteOperation;
        const remoteWinsTie = String(entry.clientId) < pending.clientId;
        remoteOperation = (0, ot_1.transformOperation)(beforeRemote, pending.ops, remoteWinsTie);
        const localWinsTie = pending.clientId < String(entry.clientId);
        pending.ops = (0, ot_1.transformOperation)(pending.ops, beforeRemote, localWinsTie);
    }
    const nextText = (0, ot_1.applyOperation)(document.getText(), remoteOperation);
    await replaceDocumentText(document, nextText);
    session.text = nextText;
    session.revision = entry.revision;
    if (session.pending[0]?.sent)
        session.pending[0].baseRevision = entry.revision;
    await persistOutbox();
}
async function handleResumeHistory(message) {
    const session = documents.get(message.filePath);
    if (!session)
        return;
    for (const entry of message.entries || []) {
        if (!Number.isSafeInteger(entry.revision) || entry.revision <= session.revision)
            continue;
        if (entry.baseRevision !== session.revision) {
            session.resuming = true;
            sendMessage({ type: "resync", filePath: session.filePath });
            return;
        }
        const first = session.pending[0];
        if (first && entry.clientId === first.clientId && entry.opId === first.opId) {
            session.pending.shift();
            session.revision = entry.revision;
            continue;
        }
        await applyRemoteEntry(session, entry);
    }
    if (session.revision !== message.revision) {
        session.resuming = true;
        sendMessage({ type: "resync", filePath: session.filePath });
        return;
    }
    session.resuming = false;
    if (session.pending[0])
        session.pending[0].sent = false;
    await persistOutbox();
    await sendNextPending(session);
}
async function saveRecoveryCopy(filePath, text) {
    const recoveryDirectory = vscode.Uri.joinPath(extensionContext.globalStorageUri, "recovery");
    await vscode.workspace.fs.createDirectory(recoveryDirectory);
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(recoveryDirectory, filename), Buffer.from(text, "utf8"));
}
async function resolveSnapshot(session, revision, serverText, isRecovery) {
    const document = getDocument(session.uri) || await vscode.workspace.openTextDocument(session.uri);
    const localText = document.getText();
    if (localText === serverText) {
        session.text = serverText;
        session.revision = revision;
        session.initialized = true;
        session.pending = [];
        session.resuming = false;
        await persistOutbox();
        return;
    }
    await saveRecoveryCopy(session.filePath, localText);
    const choice = await vscode.window.showWarningMessage(`The server copy of ${session.filePath} differs from your local copy. A recovery backup was saved in Jelo Co-Lab storage.`, "Keep Local Version", "Use Server Version");
    session.revision = revision;
    session.initialized = true;
    session.resuming = false;
    session.pending = [];
    session.text = serverText;
    if (choice === "Keep Local Version" || choice === undefined) {
        const operation = (0, ot_1.diffText)(serverText, document.getText());
        if (!isEmptyOperation(operation)) {
            session.pending.push({ opId: crypto.randomUUID(), clientId: getConfig().userId,
                ops: operation, baseRevision: revision, sent: false });
        }
    }
    else if (choice === "Use Server Version") {
        await replaceDocumentText(document, serverText);
        session.text = serverText;
    }
    else if (isRecovery) {
        vscode.window.showInformationMessage("Your local recovery copy was preserved. Choose a version when you reconnect.");
    }
    await persistOutbox();
    await sendNextPending(session);
}
function sendCurrentCursor(editor) {
    const filePath = toWorkspacePath(editor.document.uri);
    if (!filePath || !subscribedFiles.has(filePath))
        return;
    const selection = editor.selection;
    sendMessage({ type: "cursor", filePath,
        startLine: selection.anchor.line, startChar: selection.anchor.character,
        endLine: selection.active.line, endChar: selection.active.character });
}
function renderCursors(editor) {
    for (const decoration of cursorDecorations.values())
        editor.setDecorations(decoration, []);
    const filePath = toWorkspacePath(editor.document.uri);
    if (!filePath)
        return;
    const session = documents.get(filePath);
    if (!session)
        return;
    for (const cursor of session.cursors.values()) {
        let decoration = cursorDecorations.get(cursor.userId);
        if (!decoration) {
            decoration = vscode.window.createTextEditorDecorationType({
                border: `2px solid ${cursor.color}`, borderWidth: "0 0 0 2px",
                backgroundColor: `${cursor.color}22`,
                after: { contentText: ` ${cursor.userId} `, backgroundColor: cursor.color, color: "#fff", margin: "0 0 0 2px" },
            });
            cursorDecorations.set(cursor.userId, decoration);
        }
        const start = new vscode.Position(Math.min(cursor.startLine, editor.document.lineCount - 1), Math.min(cursor.startChar, editor.document.lineAt(Math.min(cursor.startLine, editor.document.lineCount - 1)).text.length));
        const endLine = Math.min(cursor.endLine, editor.document.lineCount - 1);
        const end = new vscode.Position(endLine, Math.min(cursor.endChar, editor.document.lineAt(endLine).text.length));
        editor.setDecorations(decoration, [new vscode.Range(start, end)]);
    }
}
function requestFileDownload(filePath) {
    if (transferPaused || !workspaceJoined || !ws || ws.readyState !== WebSocket.OPEN) {
        pendingDownloadPaths.add(filePath);
        return;
    }
    if (requestedDownloadPaths.has(filePath) || Array.from(downloads.values()).some((download) => download.path === filePath)) {
        pendingDownloadPaths.add(filePath);
        return;
    }
    requestedDownloadPaths.add(filePath);
    sendMessage({ type: "file_get", path: filePath });
}
async function applyDownloadedFile(download, content) {
    const uri = uriForWorkspacePath(download.path);
    if (!uri || !shouldSyncPath(download.path))
        return true;
    if (pendingFilePaths.has(download.path))
        return false;
    const document = getDocument(uri);
    if (document?.isDirty) {
        await saveRecoveryCopy(download.path, document.getText());
        const choice = await vscode.window.showWarningMessage(`The server has a newer copy of ${download.path}. Your unsaved local version was saved to Jelo Co-Lab recovery storage.`, "Use Server Version", "Keep Local Version");
        if (choice !== "Use Server Version")
            return false;
    }
    markRemoteAction(download.path);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, content);
    if (document && content.toString("utf8") !== document.getText()) {
        const text = content.toString("utf8");
        if (Buffer.from(text, "utf8").equals(content)) {
            await replaceDocumentText(document, text);
            await document.save();
        }
    }
    const baseline = extensionContext.globalState.get(stateKey("manifestBaseline")) || {};
    await extensionContext.globalState.update(stateKey("manifestBaseline"), {
        ...baseline, [download.path]: { localHash: download.sha256, remoteHash: download.sha256 },
    });
    return true;
}
async function handleServerMessage(message) {
    if (message.type === "heartbeat") {
        latencyMs = Date.now() - Number(message.ts || Date.now());
        sendMessage({ type: "heartbeat_ack", ts: message.ts });
        updateStatusBar("Connected");
        refreshViews();
        return;
    }
    if (message.type === "manifest_page") {
        // Manifest pages are consumed by requestWithAck waiters, not directly here.
        return;
    }
    if (["file_begin_ack", "file_chunk_ack", "file_ack", "file_operation_ack"].includes(message.type))
        return;
    if (message.type === "joined" || message.type === "file_joined") {
        if (message.type === "joined") {
            workspaceJoined = true;
            currentRole = message.role || "editor";
            reconnectAttempts = 0;
            updateStatusBar("Connected");
            refreshViews();
            for (const document of vscode.workspace.textDocuments) {
                const filePath = toWorkspacePath(document.uri);
                if (filePath && filePath !== message.filePath)
                    await subscribeDocument(document);
            }
            await retryPendingFileOperations();
            for (const editor of vscode.window.visibleTextEditors)
                sendCurrentCursor(editor);
            for (const filePath of Array.from(pendingDownloadPaths)) {
                pendingDownloadPaths.delete(filePath);
                requestFileDownload(filePath);
            }
            void retryPendingFiles();
            if (vscode.workspace.getConfiguration("collab").get("autoReconcile", true)) {
                void reconcileWorkspace(false);
            }
        }
        const session = documents.get(message.filePath);
        if (session && session.initialized && session.revision >= 0) {
            session.resuming = true;
            sendMessage({ type: "resume", filePath: session.filePath, baseRevision: session.revision });
        }
        return;
    }
    if (message.type === "init" || message.type === "resync") {
        const session = documents.get(message.filePath);
        if (!session || !Number.isSafeInteger(message.revision) || typeof message.content !== "string")
            return;
        if (message.type === "init" && session.initialized)
            return;
        await resolveSnapshot(session, message.revision, message.content, message.type === "resync");
        return;
    }
    if (message.type === "resume_history") {
        await handleResumeHistory(message);
        return;
    }
    if (message.type === "operation") {
        const session = documents.get(message.filePath);
        if (!session)
            return;
        if (message.revision <= session.revision)
            return;
        if (message.baseRevision !== session.revision) {
            session.resuming = true;
            sendMessage({ type: "resume", filePath: session.filePath, baseRevision: session.revision });
            return;
        }
        await applyRemoteEntry(session, message);
        return;
    }
    if (message.type === "ack") {
        const session = documents.get(message.filePath);
        if (!session)
            return;
        if (session.pending[0]?.opId === message.opId) {
            session.pending.shift();
            session.revision = Math.max(session.revision, message.revision);
            await persistOutbox();
            await sendNextPending(session);
        }
        return;
    }
    if (message.type === "presence") {
        const session = documents.get(message.filePath);
        if (!session)
            return;
        session.cursors.clear();
        for (const member of message.members || []) {
            collaborators.set(member.userId, member.color);
            const files = collaboratorFiles.get(member.userId) || new Set();
            files.add(message.filePath);
            collaboratorFiles.set(member.userId, files);
            if (member.cursor)
                session.cursors.set(member.userId, member.cursor);
        }
        updateStatusBar("Connected");
        if (vscode.window.activeTextEditor)
            renderCursors(vscode.window.activeTextEditor);
        refreshViews();
        return;
    }
    if (message.type === "presence_join") {
        collaborators.set(message.userId, message.color);
        const files = collaboratorFiles.get(message.userId) || new Set();
        files.add(message.filePath);
        collaboratorFiles.set(message.userId, files);
        updateStatusBar("Connected");
        refreshViews();
        return;
    }
    if (message.type === "presence_leave") {
        documents.get(message.filePath)?.cursors.delete(message.userId);
        const files = collaboratorFiles.get(message.userId);
        files?.delete(message.filePath);
        if (!files?.size) {
            collaboratorFiles.delete(message.userId);
            collaborators.delete(message.userId);
        }
        const decoration = cursorDecorations.get(message.userId);
        decoration?.dispose();
        cursorDecorations.delete(message.userId);
        if (vscode.window.activeTextEditor)
            renderCursors(vscode.window.activeTextEditor);
        updateStatusBar("Connected");
        refreshViews();
        return;
    }
    if (message.type === "cursor") {
        const session = documents.get(message.filePath);
        if (!session || typeof message.userId !== "string")
            return;
        const cursor = { userId: message.userId, color: message.color,
            startLine: message.startLine, startChar: message.startChar, endLine: message.endLine, endChar: message.endChar };
        session.cursors.set(message.userId, cursor);
        if (vscode.window.activeTextEditor && toWorkspacePath(vscode.window.activeTextEditor.document.uri) === message.filePath) {
            renderCursors(vscode.window.activeTextEditor);
        }
        return;
    }
    if (message.type === "file_available") {
        if (typeof message.path === "string" && shouldSyncPath(message.path))
            requestFileDownload(message.path);
        return;
    }
    if (message.type === "download_begin") {
        if (typeof message.transferId !== "string")
            return;
        transferStates.set(message.path, { state: "Downloading", detail: `${message.size} bytes` });
        refreshViews();
        if (!shouldSyncPath(message.path) || !Number.isSafeInteger(message.size) || message.size < 0 ||
            message.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(message.sha256)) {
            if (typeof message.path === "string")
                requestedDownloadPaths.delete(message.path);
            sendMessage({ type: "download_ack", transferId: message.transferId, phase: "begin", status: "invalid" });
            return;
        }
        requestedDownloadPaths.add(message.path);
        downloads.set(message.transferId, { path: message.path, size: message.size, sha256: message.sha256,
            mtime: message.mtime, chunks: [], chunkHashes: [], received: 0, nextIndex: 0 });
        sendMessage({ type: "download_ack", transferId: message.transferId, phase: "begin", status: "ok" });
        return;
    }
    if (message.type === "download_chunk" || message.type === "download_chunk_binary") {
        const download = downloads.get(message.transferId);
        if (!download || !Number.isSafeInteger(message.index) ||
            (message.type === "download_chunk" && typeof message.data !== "string"))
            return;
        const chunk = Buffer.isBuffer(message.binaryData) ? message.binaryData : Buffer.from(message.data, "base64");
        if (!chunk.length || chunk.length > CHUNK_BYTES || (message.type === "download_chunk" && chunk.toString("base64") !== message.data)) {
            downloads.delete(message.transferId);
            requestedDownloadPaths.delete(download.path);
            sendMessage({ type: "download_ack", transferId: message.transferId, phase: "chunk", index: message.index, status: "invalid" });
            return;
        }
        const chunkHash = crypto.createHash("sha256").update(chunk).digest("hex");
        if (message.index < download.nextIndex) {
            if (download.chunkHashes[message.index] !== chunkHash) {
                downloads.delete(message.transferId);
                sendMessage({ type: "download_ack", transferId: message.transferId, phase: "chunk", index: message.index, status: "invalid" });
            }
            else
                sendMessage({ type: "download_ack", transferId: message.transferId, phase: "chunk", index: message.index, status: "ok" });
            return;
        }
        if (message.index !== download.nextIndex || download.received + chunk.length > download.size) {
            downloads.delete(message.transferId);
            requestedDownloadPaths.delete(download.path);
            sendMessage({ type: "download_ack", transferId: message.transferId, phase: "chunk", index: message.index, status: "invalid" });
            return;
        }
        download.chunks.push(chunk);
        download.chunkHashes.push(chunkHash);
        download.received += chunk.length;
        download.nextIndex += 1;
        sendMessage({ type: "download_ack", transferId: message.transferId, phase: "chunk", index: message.index, status: "ok" });
        return;
    }
    if (message.type === "download_end") {
        const download = downloads.get(message.transferId);
        if (!download) {
            if (completedDownloads.has(message.transferId))
                sendMessage({ type: "download_ack", transferId: message.transferId, phase: "complete", status: "ok" });
            return;
        }
        if (download.received !== download.size || download.nextIndex !== message.chunks) {
            downloads.delete(message.transferId);
            requestedDownloadPaths.delete(download.path);
            sendMessage({ type: "download_ack", transferId: message.transferId, phase: "complete", status: "invalid" });
            return;
        }
        const content = Buffer.concat(download.chunks, download.received);
        const digest = crypto.createHash("sha256").update(content).digest("hex");
        if (digest !== download.sha256) {
            downloads.delete(message.transferId);
            requestedDownloadPaths.delete(download.path);
            vscode.window.showErrorMessage(`Jelo Co-Lab checksum verification failed for ${download.path}.`);
            sendMessage({ type: "download_ack", transferId: message.transferId, phase: "complete", status: "invalid" });
            return;
        }
        try {
            const applied = await applyDownloadedFile(download, content);
            downloads.delete(message.transferId);
            completedDownloads.add(message.transferId);
            while (completedDownloads.size > 100)
                completedDownloads.delete(completedDownloads.values().next().value);
            if (!applied) {
                conflicts.set(download.path, { reason: "Local unsaved edits conflict with the remote file", kind: "modify" });
                pendingFilePaths.add(download.path);
                await persistFileQueue();
            }
            sendMessage({ type: "download_ack", transferId: message.transferId, phase: "complete", status: "ok" });
            requestedDownloadPaths.delete(download.path);
            if (applied) {
                transferStates.set(download.path, { state: "Complete" });
                conflicts.delete(download.path);
            }
            if (!applied)
                void retryPendingFiles();
            refreshViews();
            if (pendingDownloadPaths.delete(download.path))
                requestFileDownload(download.path);
        }
        catch (error) {
            downloads.delete(message.transferId);
            requestedDownloadPaths.delete(download.path);
            sendMessage({ type: "download_ack", transferId: message.transferId, phase: "complete", status: "invalid" });
            vscode.window.showErrorMessage(`Could not apply synchronized file ${download.path}: ${error.message}`);
            pendingDownloadPaths.delete(download.path);
        }
        return;
    }
    if (message.type === "file_deleted") {
        const uri = uriForWorkspacePath(message.path);
        const affectedSessions = Array.from(documents.values()).filter((session) => session.filePath === message.path || session.filePath.startsWith(`${message.path}/`));
        const dirtySession = affectedSessions.find((session) => session.pending.length > 0 || getDocument(session.uri)?.isDirty);
        const dirtyDocument = dirtySession ? getDocument(dirtySession.uri) : undefined;
        const document = uri && getDocument(uri);
        if (document?.isDirty || dirtySession) {
            conflicts.set(message.path, { reason: "Remote deletion conflicts with local unsaved changes", kind: "delete" });
            refreshViews();
            await saveRecoveryCopy(message.path, (document?.isDirty ? document : dirtyDocument).getText());
            vscode.window.showWarningMessage(`Remote deletion of ${message.path} was not applied because local edits are still unsaved or awaiting synchronization. A recovery copy was saved.`);
            return;
        }
        if (uri) {
            markRemoteAction(message.path);
            await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }).then(() => undefined, () => undefined);
        }
        for (const session of affectedSessions) {
            documents.delete(session.filePath);
            documentUris.delete(session.filePath);
            subscribedFiles.delete(session.filePath);
        }
        subscribedFiles.delete(message.path);
        await persistOutbox();
        return;
    }
    if (message.type === "file_moved") {
        const from = uriForWorkspacePath(message.from);
        const to = uriForWorkspacePath(message.to);
        const sourceSession = documents.get(message.from);
        const sourceDocument = sourceSession ? getDocument(sourceSession.uri) : undefined;
        const sourceExists = !!from && await vscode.workspace.fs.stat(from).then(() => true, () => false);
        const targetExists = !!to && await vscode.workspace.fs.stat(to).then(() => true, () => false);
        if (!sourceExists && targetExists) {
            const baseline = extensionContext.globalState.get(stateKey("manifestBaseline")) || {};
            const next = { ...baseline };
            if (next[message.from]) {
                next[message.to] = next[message.from];
                delete next[message.from];
            }
            await extensionContext.globalState.update(stateKey("manifestBaseline"), next);
            return;
        }
        if (from && to && sourceExists && targetExists) {
            conflicts.set(message.from, { reason: `Remote rename to ${message.to} conflicts with an existing local path`, kind: "rename", to: message.to });
            refreshViews();
            return;
        }
        if (sourceDocument?.isDirty || (sourceSession && sourceSession.pending.length)) {
            if (sourceDocument?.isDirty)
                await saveRecoveryCopy(message.from, sourceDocument.getText());
            conflicts.set(message.from, { reason: `Remote rename to ${message.to} conflicts with local edits`, kind: "rename", to: message.to });
            refreshViews();
            return;
        }
        if (from && to && sourceExists) {
            markRemoteAction(message.from);
            markRemoteAction(message.to);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(to.fsPath)));
            await vscode.workspace.fs.rename(from, to, { overwrite: false });
        }
        if (subscribedFiles.delete(message.from))
            subscribedFiles.add(message.to);
        if (sourceSession) {
            documents.delete(message.from);
            sourceSession.filePath = message.to;
            sourceSession.uri = to || sourceSession.uri;
            documents.set(message.to, sourceSession);
            documentUris.delete(message.from);
            if (to)
                documentUris.set(message.to, to);
            await persistOutbox();
        }
        const baseline = extensionContext.globalState.get(stateKey("manifestBaseline")) || {};
        const next = { ...baseline };
        if (next[message.from]) {
            next[message.to] = next[message.from];
            delete next[message.from];
        }
        await extensionContext.globalState.update(stateKey("manifestBaseline"), next);
        return;
    }
    if (message.type === "error") {
        if (typeof message.path === "string")
            requestedDownloadPaths.delete(message.path);
        if (/authentication failed/i.test(message.message || ""))
            isManualDisconnect = true;
        vscode.window.showErrorMessage(`Jelo Co-Lab: ${message.message}`);
    }
}
function queueIncoming(data, isBinary) {
    let message;
    try {
        if (isBinary) {
            const buffer = Buffer.from(data);
            const headerLength = buffer.readUInt32BE(0);
            if (headerLength < 2 || headerLength > 4096 || 4 + headerLength >= buffer.length)
                throw new Error("Invalid binary frame");
            message = { ...JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8")), binaryData: buffer.subarray(4 + headerLength) };
            if (message.type !== "download_chunk_binary")
                throw new Error("Unsupported binary server message");
        }
        else
            message = JSON.parse(data.toString());
    }
    catch {
        vscode.window.showErrorMessage("Jelo Co-Lab received an invalid server message.");
        return;
    }
    settleWaiters(message);
    incomingQueue = incomingQueue.then(() => handleServerMessage(message))
        .catch((error) => console.error("Jelo Co-Lab incoming message error:", error));
}
async function subscribeDocument(document) {
    const session = getSession(document);
    if (!session || !workspaceJoined || !ws || ws.readyState !== WebSocket.OPEN || subscribedFiles.has(session.filePath))
        return;
    subscribedFiles.add(session.filePath);
    sendMessage({ type: "open_file", filePath: session.filePath });
}
async function checkServerHealth(serverUrl) {
    const parsed = new URL(serverUrl);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "/healthz";
    parsed.search = "";
    parsed.hash = "";
    await new Promise((resolve, reject) => {
        const client = parsed.protocol === "https:" ? https : http;
        const request = client.get(parsed, { timeout: 5000 }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { body += chunk; if (body.length > 16384)
                request.destroy(new Error("Health response too large")); });
            response.on("end", () => {
                if (response.statusCode !== 200)
                    return reject(new Error(`Health endpoint returned HTTP ${response.statusCode}`));
                try {
                    const health = JSON.parse(body);
                    if (health.status !== "ok")
                        throw new Error("Server did not report healthy");
                    resolve();
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.on("timeout", () => request.destroy(new Error("Health check timed out")));
        request.on("error", reject);
    });
}
async function getRemoteManifest(socket) {
    const all = [];
    let pages = 1;
    for (let page = 0; page < pages; page += 1) {
        const response = await requestWithAck(socket, { type: "manifest_get", page }, (message) => message.type === "manifest_page" && message.page === page, 2);
        pages = response.pages;
        if (!Array.isArray(response.entries))
            throw new Error("Server returned an invalid manifest");
        all.push(...response.entries);
    }
    return all;
}
async function getLocalManifest() {
    const files = new Map();
    let total = 0;
    async function walk(folder) {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
            const uri = vscode.Uri.joinPath(folder, name);
            const filePath = toWorkspacePath(uri);
            if (!filePath)
                continue;
            if (type === vscode.FileType.Directory) {
                await walk(uri);
                continue;
            }
            if (type !== vscode.FileType.File)
                continue;
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_FILE_BYTES || files.size >= 20000 || total + stat.size > 512 * 1024 * 1024)
                continue;
            const content = Buffer.from(await vscode.workspace.fs.readFile(uri));
            total += content.length;
            files.set(filePath, { size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex"), uri });
        }
    }
    for (const folder of vscode.workspace.workspaceFolders || [])
        await walk(folder.uri);
    return files;
}
async function reconcileWorkspace(manual) {
    if (reconcileRunning || !workspaceJoined || !ws || ws.readyState !== WebSocket.OPEN)
        return;
    reconcileRunning = true;
    const socket = ws;
    try {
        const [remoteEntries, local] = await Promise.all([getRemoteManifest(socket), getLocalManifest()]);
        const remote = new Map(remoteEntries.filter((entry) => entry.eligible && entry.sha256).map((entry) => [entry.path, entry]));
        const previous = extensionContext.globalState.get(stateKey("manifestBaseline")) || {};
        const nextBaseline = { ...previous };
        const handled = new Set();
        let downloaded = 0, uploaded = 0, unchanged = 0, conflictsFound = 0;
        // Detect an offline remote rename by matching the last known remote content hash.
        const newRemoteByHash = new Map();
        for (const [newPath, remoteFile] of remote) {
            if (Object.prototype.hasOwnProperty.call(previous, newPath))
                continue;
            const list = newRemoteByHash.get(remoteFile.sha256) || [];
            list.push(remoteFile);
            newRemoteByHash.set(remoteFile.sha256, list);
        }
        for (const [oldPath, baseline] of Object.entries(previous)) {
            if (remote.has(oldPath) || !local.has(oldPath))
                continue;
            const candidates = newRemoteByHash.get(baseline.remoteHash) || [];
            if (candidates.length !== 1)
                continue;
            const renamed = candidates[0];
            if (local.has(renamed.path) || documents.has(oldPath))
                continue;
            handled.add(oldPath);
            handled.add(renamed.path);
            conflictsFound += 1;
            conflicts.set(oldPath, { reason: `The remote file was renamed to ${renamed.path} while this workspace was offline`, kind: "rename", to: renamed.path });
            refreshViews();
            const choice = await vscode.window.showWarningMessage(`Remote rename detected: ${oldPath} → ${renamed.path}`, "Apply Remote Rename", "Keep Local Name", "Later");
            if (choice === "Apply Remote Rename") {
                const localFile = local.get(oldPath);
                const document = getDocument(localFile.uri);
                if (document?.isDirty)
                    await saveRecoveryCopy(oldPath, document.getText());
                const destination = uriForWorkspacePath(renamed.path);
                if (destination && !await vscode.workspace.fs.stat(destination).then(() => true, () => false)) {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination.fsPath)));
                    markRemoteAction(oldPath);
                    markRemoteAction(renamed.path);
                    await vscode.workspace.fs.rename(localFile.uri, destination, { overwrite: false });
                    delete nextBaseline[oldPath];
                    nextBaseline[renamed.path] = { localHash: renamed.sha256, remoteHash: renamed.sha256 };
                    conflicts.delete(oldPath);
                }
            }
            else if (choice === "Keep Local Name") {
                try {
                    await requestWithAck(socket, { type: "file_move", from: renamed.path, to: oldPath, operationId: crypto.randomUUID() }, (message) => message.type === "file_operation_ack" && message.operation === "move" && message.from === renamed.path && message.to === oldPath);
                    const localFile = local.get(oldPath);
                    if (localFile.sha256 !== renamed.sha256)
                        await sendWorkspaceFile(localFile.uri, oldPath);
                    nextBaseline[oldPath] = { localHash: localFile.sha256, remoteHash: localFile.sha256 };
                    delete nextBaseline[renamed.path];
                    conflicts.delete(oldPath);
                }
                catch (error) {
                    console.warn(`Could not preserve local name for ${oldPath}`, error);
                }
            }
        }
        const paths = new Set([...remote.keys(), ...local.keys(), ...Object.keys(previous)]);
        for (const filePath of paths) {
            if (handled.has(filePath))
                continue;
            if (socket !== ws || socket.readyState !== WebSocket.OPEN)
                break;
            const remoteFile = remote.get(filePath);
            const localFile = local.get(filePath);
            const baseline = previous[filePath];
            if (!remoteFile && !localFile) {
                delete nextBaseline[filePath];
                continue;
            }
            if (remoteFile && !localFile) {
                if (!pendingFileOperations.some((op) => op.operation === "delete" && op.path === filePath)) {
                    requestFileDownload(filePath);
                    downloaded += 1;
                }
                continue;
            }
            if (!remoteFile && localFile) {
                if (baseline) {
                    conflictsFound += 1;
                    conflicts.set(filePath, { reason: "The remote copy was deleted while this workspace was offline", kind: "delete" });
                    refreshViews();
                    const choice = await vscode.window.showWarningMessage(`Remote deletion detected: ${filePath}`, "Keep Local and Upload", "Delete Local Copy", "Later");
                    if (choice === "Keep Local and Upload") {
                        try {
                            await sendWorkspaceFile(localFile.uri, filePath);
                            uploaded += 1;
                            nextBaseline[filePath] = { localHash: localFile.sha256, remoteHash: localFile.sha256 };
                            conflicts.delete(filePath);
                        }
                        catch (error) {
                            console.error(error);
                        }
                    }
                    else if (choice === "Delete Local Copy") {
                        const content = Buffer.from(await vscode.workspace.fs.readFile(localFile.uri));
                        await saveRecoveryCopy(filePath, content.toString("utf8"));
                        markRemoteAction(filePath);
                        await vscode.workspace.fs.delete(localFile.uri, { useTrash: true });
                        delete nextBaseline[filePath];
                        conflicts.delete(filePath);
                    }
                }
                else {
                    try {
                        await sendWorkspaceFile(localFile.uri, filePath);
                        uploaded += 1;
                        nextBaseline[filePath] = { localHash: localFile.sha256, remoteHash: localFile.sha256 };
                    }
                    catch (error) {
                        console.warn(`Could not upload ${filePath} during reconciliation`, error);
                    }
                }
                continue;
            }
            if (!remoteFile || !localFile)
                continue;
            if (remoteFile.sha256 === localFile.sha256) {
                unchanged += 1;
                nextBaseline[filePath] = { localHash: localFile.sha256, remoteHash: remoteFile.sha256 };
                continue;
            }
            if (documents.has(filePath))
                continue;
            const localChanged = !baseline || localFile.sha256 !== baseline.localHash;
            const remoteChanged = !baseline || remoteFile.sha256 !== baseline.remoteHash;
            if (baseline && localChanged && !remoteChanged) {
                try {
                    await sendWorkspaceFile(localFile.uri, filePath);
                    uploaded += 1;
                    nextBaseline[filePath] = { localHash: localFile.sha256, remoteHash: localFile.sha256 };
                }
                catch (error) {
                    console.warn(`Could not upload ${filePath}`, error);
                }
            }
            else if (baseline && !localChanged && remoteChanged) {
                requestFileDownload(filePath);
                downloaded += 1;
            }
            else {
                conflictsFound += 1;
                conflicts.set(filePath, { reason: "Both local and remote files changed since the last sync", kind: "modify" });
                refreshViews();
                const choice = await vscode.window.showWarningMessage(`Both copies changed: ${filePath}`, "Use Server Version", "Keep Local Version", "Later");
                if (choice === "Use Server Version") {
                    requestFileDownload(filePath);
                    downloaded += 1;
                    conflicts.delete(filePath);
                }
                else if (choice === "Keep Local Version") {
                    try {
                        await sendWorkspaceFile(localFile.uri, filePath);
                        uploaded += 1;
                        nextBaseline[filePath] = { localHash: localFile.sha256, remoteHash: localFile.sha256 };
                        conflicts.delete(filePath);
                    }
                    catch (error) {
                        console.warn(error);
                    }
                }
            }
        }
        const latestBaseline = extensionContext.globalState.get(stateKey("manifestBaseline")) || {};
        const mergedBaseline = { ...latestBaseline };
        for (const key of new Set([...Object.keys(previous), ...Object.keys(nextBaseline)])) {
            const before = previous[key];
            const after = nextBaseline[key];
            if (JSON.stringify(before) === JSON.stringify(after))
                continue;
            if (after)
                mergedBaseline[key] = after;
            else
                delete mergedBaseline[key];
        }
        await extensionContext.globalState.update(stateKey("manifestBaseline"), mergedBaseline);
        refreshViews();
        if (manual || downloaded || uploaded || conflictsFound) {
            vscode.window.showInformationMessage(`Jelo Co-Lab reconciliation: ${uploaded} uploaded, ${downloaded} downloads queued, ${unchanged} unchanged, ${conflictsFound} conflicts.`);
        }
    }
    catch (error) {
        vscode.window.showWarningMessage(`Workspace reconciliation could not complete: ${error.message}`);
    }
    finally {
        reconcileRunning = false;
    }
}
async function openConflictCenter(filePath) {
    const paths = filePath ? [filePath] : Array.from(conflicts.keys());
    if (!paths.length) {
        vscode.window.showInformationMessage("Jelo Co-Lab: No unresolved conflicts.");
        return;
    }
    const selected = filePath || (await vscode.window.showQuickPick(paths.map((value) => ({ label: value, description: conflicts.get(value)?.reason })), { placeHolder: "Choose a synchronization conflict" }))?.label;
    if (!selected)
        return;
    const conflict = conflicts.get(selected);
    if (!conflict)
        return;
    const uri = uriForWorkspacePath(selected);
    if (conflict.kind === "delete") {
        const choice = await vscode.window.showQuickPick([
            { label: "Keep local and upload", value: "local" },
            { label: "Accept remote deletion", value: "remote" },
            ...(uri ? [{ label: "Open local file", value: "open" }] : []),
            { label: "Dismiss for now", value: "later" },
        ], { placeHolder: `Resolve remote deletion of ${selected}` });
        if (!choice || choice.value === "later")
            return;
        if (choice.value === "open" && uri) {
            await vscode.window.showTextDocument(uri);
            return;
        }
        if (choice.value === "local" && uri) {
            await sendWorkspaceFile(uri, selected);
            conflicts.delete(selected);
        }
        else if (choice.value === "remote" && uri) {
            const document = getDocument(uri);
            const content = document?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
            await saveRecoveryCopy(selected, content);
            markRemoteAction(selected);
            await vscode.workspace.fs.delete(uri, { useTrash: true });
            const baseline = extensionContext.globalState.get(stateKey("manifestBaseline")) || {};
            const next = { ...baseline };
            delete next[selected];
            await extensionContext.globalState.update(stateKey("manifestBaseline"), next);
            pendingFilePaths.delete(selected);
            await persistFileQueue();
            conflicts.delete(selected);
        }
        else if (choice.value === "remote") {
            conflicts.delete(selected);
        }
    }
    else if (conflict.kind === "rename") {
        const destinationPath = conflict.to;
        const destination = destinationPath ? uriForWorkspacePath(destinationPath) : undefined;
        const choice = await vscode.window.showQuickPick([
            { label: `Apply remote rename${destinationPath ? ` to ${destinationPath}` : ""}`, value: "remote" },
            { label: "Keep local name and restore it on server", value: "local" },
            ...(uri ? [{ label: "Open local file", value: "open" }] : []),
            { label: "Dismiss for now", value: "later" },
        ], { placeHolder: `Resolve rename of ${selected}` });
        if (!choice || choice.value === "later")
            return;
        if (choice.value === "open" && uri) {
            await vscode.window.showTextDocument(uri);
            return;
        }
        if (choice.value === "remote" && uri && destination) {
            if (await vscode.workspace.fs.stat(destination).then(() => true, () => false)) {
                vscode.window.showErrorMessage(`Cannot apply rename: ${destinationPath} already exists locally.`);
                return;
            }
            const document = getDocument(uri);
            if (document?.isDirty)
                await saveRecoveryCopy(selected, document.getText());
            markRemoteAction(selected);
            markRemoteAction(destinationPath);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination.fsPath)));
            await vscode.workspace.fs.rename(uri, destination, { overwrite: false });
            const baseline = extensionContext.globalState.get(stateKey("manifestBaseline")) || {};
            const next = { ...baseline };
            if (next[selected])
                next[destinationPath] = next[selected];
            delete next[selected];
            await extensionContext.globalState.update(stateKey("manifestBaseline"), next);
            conflicts.delete(selected);
        }
        else if (choice.value === "local" && destinationPath) {
            const socket = ws;
            if (!socket || socket.readyState !== WebSocket.OPEN)
                throw new Error("Connect before resolving this rename");
            await requestWithAck(socket, { type: "file_move", from: destinationPath, to: selected, operationId: crypto.randomUUID() }, (message) => message.type === "file_operation_ack" && message.operation === "move" && message.from === destinationPath && message.to === selected);
            if (uri)
                await sendWorkspaceFile(uri, selected);
            conflicts.delete(selected);
        }
    }
    else if (uri) {
        const choice = await vscode.window.showQuickPick([
            { label: "Open local file", value: "open" },
            { label: "Keep local and upload", value: "local" },
            { label: "Use server version", value: "remote" },
            { label: "Dismiss for now", value: "later" },
        ], { placeHolder: `Resolve ${selected}` });
        if (!choice || choice.value === "later")
            return;
        if (choice.value === "open") {
            await vscode.window.showTextDocument(uri);
            return;
        }
        if (choice.value === "local") {
            await sendWorkspaceFile(uri, selected);
            conflicts.delete(selected);
        }
        if (choice.value === "remote") {
            requestFileDownload(selected);
        }
    }
    refreshViews();
}
async function showCollaboratorFiles(userId) {
    const files = Array.from(collaboratorFiles.get(userId) || []);
    if (!files.length) {
        vscode.window.showInformationMessage(`${userId} is not currently sharing an open document.`);
        return;
    }
    const selected = await vscode.window.showQuickPick(files, { placeHolder: `Documents currently open by ${userId}` });
    if (!selected)
        return;
    const uri = uriForWorkspacePath(selected);
    if (uri)
        await vscode.window.showTextDocument(uri);
}
async function showDiagnostics() {
    const socketState = ws?.readyState === WebSocket.OPEN ? "Connected" : ws?.readyState === WebSocket.CONNECTING ? "Connecting" : "Disconnected";
    const details = [
        `Connection: ${socketState}`, `Server: ${getConfig().serverUrl}`, `Workspace: ${getConfig().workspaceId}`,
        `User: ${getConfig().userId}`, `Role: ${currentRole || "Unknown"}`,
        `Latency: ${latencyMs === undefined ? "Unknown" : `${latencyMs} ms`}`,
        `Collaborators: ${collaborators.size}`, `Pending uploads: ${pendingFilePaths.size}`,
        `Pending file operations: ${pendingFileOperations.length}`, `Pending text documents: ${Array.from(documents.values()).filter((session) => session.pending.length).length}`,
        `Unresolved conflicts: ${conflicts.size}`, `Transfers: ${transferPaused ? "Paused" : "Active"}`,
    ].join("\\n");
    const choice = await vscode.window.showInformationMessage(details, "Copy Diagnostics", "Open Output Log");
    if (choice === "Copy Diagnostics")
        await vscode.env.clipboard.writeText(details);
    if (choice === "Open Output Log")
        vscode.commands.executeCommand("workbench.action.output.toggleOutput");
}
async function setConfig() {
    const current = getConfig();
    const serverUrl = await vscode.window.showInputBox({ prompt: "Server URL (ws://localhost or remote wss://)", value: current.serverUrl, ignoreFocusOut: true });
    if (!serverUrl)
        return false;
    let parsedUrl;
    try {
        parsedUrl = new URL(serverUrl.trim());
        if (!["ws:", "wss:"].includes(parsedUrl.protocol))
            throw new Error("Use ws:// or wss://");
        if (parsedUrl.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname))
            throw new Error("Remote servers must use wss://");
    }
    catch (error) {
        vscode.window.showErrorMessage(`Invalid server URL: ${error.message}`);
        return false;
    }
    const workspaceId = await vscode.window.showInputBox({ prompt: "Shared workspace ID", value: current.workspaceId });
    if (!workspaceId)
        return false;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workspaceId)) {
        vscode.window.showErrorMessage("Workspace ID must be 1-64 letters, numbers, _ or -.");
        return false;
    }
    const token = await vscode.window.showInputBox({ prompt: "Server token (stored in VS Code SecretStorage)", password: true, ignoreFocusOut: true });
    if (token === undefined)
        return false;
    if (!/^[A-Za-z0-9_-]{24,256}$/.test(token)) {
        vscode.window.showErrorMessage("Token must be 24-256 letters, numbers, _ or -.");
        return false;
    }
    const userId = await vscode.window.showInputBox({ prompt: "Your unique collaborator ID", value: current.userId });
    if (!userId)
        return false;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,63}$/.test(userId)) {
        vscode.window.showErrorMessage("User ID must be 1-64 characters.");
        return false;
    }
    await persistOutbox();
    await persistFileQueue();
    await persistFileOperations();
    const config = vscode.workspace.getConfiguration("collab");
    await config.update("serverUrl", parsedUrl.toString(), vscode.ConfigurationTarget.Workspace);
    await config.update("workspaceId", workspaceId, vscode.ConfigurationTarget.Workspace);
    await extensionContext.secrets.store("collab.workspaceToken", token);
    generatedUserId = userId;
    await extensionContext.globalState.update("collab.generatedUserId", userId);
    isManualDisconnect = true;
    clearTimeout(reconnectTimer);
    ws?.close(1000, "Configuration changed");
    ws = undefined;
    workspaceJoined = false;
    subscribedFiles.clear();
    documents.clear();
    documentUris.clear();
    pendingFilePaths.clear();
    pendingFileOperations.length = 0;
    collaborators.clear();
    for (const document of vscode.workspace.textDocuments)
        getSession(document);
    for (const filePath of extensionContext.globalState.get(stateKey("pendingFiles")) || []) {
        if (typeof filePath === "string" && shouldSyncPath(filePath))
            pendingFilePaths.add(filePath);
    }
    for (const operation of extensionContext.globalState.get(stateKey("pendingFileOperations")) || []) {
        if (operation && typeof operation.operationId === "string" &&
            ((operation.operation === "delete" && shouldSyncPath(operation.path)) ||
                (operation.operation === "move" && shouldSyncPath(operation.from) && shouldSyncPath(operation.to))))
            pendingFileOperations.push(operation);
    }
    updateStatusBar("Disconnected");
    vscode.window.showInformationMessage("Configuration saved. Jelo Co-Lab is ready to connect.");
    return true;
}
async function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
        return;
    const active = vscode.window.activeTextEditor?.document || vscode.workspace.textDocuments.find((doc) => !!toWorkspacePath(doc.uri));
    if (!active) {
        vscode.window.showWarningMessage("Open a file inside a workspace before connecting.");
        return;
    }
    const initialSession = getSession(active);
    if (!initialSession) {
        vscode.window.showWarningMessage("The active file is excluded from synchronization.");
        return;
    }
    const token = await extensionContext.secrets.get("collab.workspaceToken");
    if (!token) {
        vscode.window.showErrorMessage("Configure your server URL, workspace ID and token first.");
        return;
    }
    const { serverUrl, workspaceId, userId } = getConfig();
    let parsedUrl;
    try {
        parsedUrl = new URL(serverUrl);
        if (!["ws:", "wss:"].includes(parsedUrl.protocol))
            throw new Error("Use ws:// or wss://");
        if (parsedUrl.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname))
            throw new Error("Remote servers require wss://");
    }
    catch (error) {
        vscode.window.showErrorMessage(`Invalid collaboration server URL: ${error.message}`);
        return;
    }
    updateStatusBar("Connecting");
    try {
        await checkServerHealth(parsedUrl.toString());
    }
    catch (error) {
        vscode.window.showErrorMessage(`Jelo Co-Lab server health check failed: ${error.message}`);
        updateStatusBar("Disconnected");
        return;
    }
    isManualDisconnect = false;
    const socket = new WebSocket(parsedUrl.toString());
    ws = socket;
    incomingQueue = Promise.resolve();
    subscribedFiles.clear();
    socket.on("open", () => {
        const pathName = initialSession.filePath;
        activeFilePath = pathName;
        subscribedFiles.add(pathName);
        socket.send(JSON.stringify({ type: "join", workspaceId, token, userId, filePath: pathName }));
    });
    socket.on("message", queueIncoming);
    socket.on("error", (error) => vscode.window.showWarningMessage(`Jelo Co-Lab connection error: ${error.message}`));
    socket.on("close", () => {
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const waiter = waiters[index];
            if (waiter.socket === socket) {
                waiters.splice(index, 1);
                clearTimeout(waiter.timer);
                waiter.reject(new Error("Connection closed"));
            }
        }
        if (ws !== socket)
            return;
        workspaceJoined = false;
        subscribedFiles.clear();
        for (const filePath of requestedDownloadPaths)
            pendingDownloadPaths.add(filePath);
        for (const download of downloads.values())
            pendingDownloadPaths.add(download.path);
        requestedDownloadPaths.clear();
        downloads.clear();
        for (const session of documents.values()) {
            session.resuming = false;
            if (session.pending[0])
                session.pending[0].sent = false;
        }
        updateStatusBar("Disconnected");
        collaborators.clear();
        collaboratorFiles.clear();
        currentRole = undefined;
        refreshViews();
        if (!isManualDisconnect) {
            reconnectAttempts += 1;
            const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 5)), 30000) + Math.floor(Math.random() * 500);
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => { void connect(); }, delay);
        }
    });
}
function disconnect() {
    isManualDisconnect = true;
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
        ws.close(1000, "Disconnected by user");
    ws = undefined;
    workspaceJoined = false;
    subscribedFiles.clear();
    collaborators.clear();
    collaboratorFiles.clear();
    currentRole = undefined;
    latencyMs = undefined;
    refreshViews();
    updateStatusBar("Disconnected");
    vscode.window.showInformationMessage("Disconnected. Local edits remain queued for the next connection.");
}
async function syncWorkspace() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !workspaceJoined) {
        vscode.window.showErrorMessage("Connect to Jelo Co-Lab first.");
        return;
    }
    const files = [];
    async function collect(folder) {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
            const uri = vscode.Uri.joinPath(folder, name);
            const filePath = toWorkspacePath(uri);
            if (!filePath)
                continue;
            if (type === vscode.FileType.Directory)
                await collect(uri);
            else if (type === vscode.FileType.File)
                files.push({ uri, filePath });
        }
    }
    try {
        for (const folder of vscode.workspace.workspaceFolders || [])
            await collect(folder.uri);
        if (!files.length) {
            vscode.window.showInformationMessage("Jelo Co-Lab: No eligible files were found.");
            return;
        }
        const manifest = await Promise.all(files.map(async (file) => {
            const stat = await vscode.workspace.fs.stat(file.uri);
            return { ...file, size: stat.size };
        }));
        const items = manifest.map((file) => ({
            label: file.filePath,
            description: `${(file.size / 1024).toFixed(1)} KB${documents.has(file.filePath) ? " · live document" : ""}`,
            picked: !documents.has(file.filePath),
        }));
        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true, ignoreFocusOut: true,
            placeHolder: `Transfer manifest: ${manifest.length} eligible files. Select the files to synchronize.`,
        });
        if (!selected)
            return;
        const selectedPaths = new Set(selected.map((item) => item.label));
        const selectedFiles = manifest.filter((file) => selectedPaths.has(file.filePath));
        let sent = 0, skipped = manifest.length - selectedFiles.length, failed = 0, cancelled = false;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Jelo Co-Lab: Synchronizing workspace", cancellable: true }, async (progress, cancellation) => {
            for (const file of selectedFiles) {
                if (cancellation.isCancellationRequested) {
                    cancelled = true;
                    break;
                }
                if (documents.has(file.filePath)) {
                    skipped += 1;
                    continue;
                }
                try {
                    await sendWorkspaceFile(file.uri, file.filePath, cancellation);
                    sent += 1;
                }
                catch (error) {
                    failed += 1;
                    console.error(`Sync failed for ${file.filePath}`, error);
                }
                progress.report({ message: `${sent} sent · ${skipped} skipped · ${failed} failed`, increment: 100 / Math.max(1, selectedFiles.length) });
            }
        });
        vscode.window.showInformationMessage(`Jelo Co-Lab: ${sent} files synchronized, ${skipped} excluded or unselected, ${failed} failed${cancelled ? " (canceled)" : ""}.`);
    }
    catch (error) {
        vscode.window.showErrorMessage(`Workspace synchronization failed: ${error.message}`);
    }
}
async function activate(context) {
    extensionContext = context;
    for (const filePath of context.globalState.get(stateKey("pendingFiles")) || []) {
        if (typeof filePath === "string" && shouldSyncPath(filePath))
            pendingFilePaths.add(filePath);
    }
    for (const operation of context.globalState.get(stateKey("pendingFileOperations")) || []) {
        if (operation && typeof operation.operationId === "string" &&
            ((operation.operation === "delete" && shouldSyncPath(operation.path)) ||
                (operation.operation === "move" && shouldSyncPath(operation.from) && shouldSyncPath(operation.to)))) {
            pendingFileOperations.push(operation);
        }
    }
    generatedUserId = vscode.workspace.getConfiguration("collab").get("userId") ||
        context.globalState.get("collab.generatedUserId") || `user-${crypto.randomUUID().slice(0, 8)}`;
    if (!vscode.workspace.getConfiguration("collab").get("userId"))
        void context.globalState.update("collab.generatedUserId", generatedUserId);
    connectionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    workspaceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    workspaceStatusBar.command = "collab.setConfig";
    connectionStatusBar.command = "collab.quickStart";
    context.subscriptions.push(connectionStatusBar, workspaceStatusBar);
    collaboratorProvider = new CoLabTreeProvider("collaborators");
    transferProvider = new CoLabTreeProvider("transfers");
    conflictProvider = new CoLabTreeProvider("conflicts");
    context.subscriptions.push(vscode.window.registerTreeDataProvider("jelo.collaborators", collaboratorProvider), vscode.window.registerTreeDataProvider("jelo.transfers", transferProvider), vscode.window.registerTreeDataProvider("jelo.conflicts", conflictProvider), collaboratorProvider, transferProvider, conflictProvider);
    context.subscriptions.push(vscode.commands.registerCommand("collab.start", connect), vscode.commands.registerCommand("collab.setConfig", setConfig), vscode.commands.registerCommand("collab.quickStart", () => vscode.commands.executeCommand("collab.onboarding")), vscode.commands.registerCommand("collab.showCollaboratorFiles", (userId) => showCollaboratorFiles(userId)), vscode.commands.registerCommand("collab.disconnect", disconnect), vscode.commands.registerCommand("collab.pushDir", syncWorkspace), vscode.commands.registerCommand("collab.retryPending", async () => {
        await retryPendingFileOperations();
        for (const session of documents.values()) {
            if (session.pending[0])
                session.pending[0].sent = false;
            await sendNextPending(session);
        }
        await retryPendingFiles();
    }), vscode.commands.registerCommand("collab.onboarding", async () => {
        const configured = await setConfig();
        if (!configured)
            return;
        const folders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.name);
        const action = await vscode.window.showInformationMessage(`Ready to connect to ${getConfig().workspaceId}. Local folders: ${folders.join(", ") || "None"}. Files excluded by policy will not be shared.`, "Connect", "Cancel");
        if (action === "Connect")
            await connect();
    }), vscode.commands.registerCommand("collab.reconcile", () => reconcileWorkspace(true)), vscode.commands.registerCommand("collab.conflicts", (filePath) => openConflictCenter(filePath)), vscode.commands.registerCommand("collab.retryTransfer", async (filePath) => {
        const uri = uriForWorkspacePath(filePath);
        if (uri) {
            pendingFilePaths.add(filePath);
            await persistFileQueue();
            await sendWorkspaceFile(uri, filePath);
        }
        else
            requestFileDownload(filePath);
    }), vscode.commands.registerCommand("collab.pauseTransfers", () => { transferPaused = true; refreshViews(); vscode.window.showInformationMessage("Jelo Co-Lab transfers paused."); }), vscode.commands.registerCommand("collab.resumeTransfers", async () => {
        transferPaused = false;
        refreshViews();
        for (const filePath of Array.from(pendingDownloadPaths)) {
            pendingDownloadPaths.delete(filePath);
            requestFileDownload(filePath);
        }
        await retryPendingFiles();
    }), vscode.commands.registerCommand("collab.showDiagnostics", showDiagnostics), vscode.commands.registerCommand("collab.leaveWorkspace", disconnect));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => { void subscribeDocument(document); }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
        const filePath = toWorkspacePath(document.uri);
        if (!filePath || !subscribedFiles.has(filePath))
            return;
        subscribedFiles.delete(filePath);
        sendMessage({ type: "close_file", filePath });
        documents.get(filePath)?.cursors.clear();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        const filePath = toWorkspacePath(event.document.uri);
        if (!filePath || applyingRemote.has(filePath) || event.document.isClosed || event.document.isUntitled)
            return;
        if (currentRole === "viewer") {
            vscode.window.setStatusBarMessage("Jelo Co-Lab: your workspace role is read-only", 2500);
            return;
        }
        const session = getSession(event.document);
        if (session)
            void queueLocalText(session, event.document, event.contentChanges).catch((error) => console.error("Could not queue local edit", error));
    }));
    context.subscriptions.push(vscode.workspace.onDidCreateFiles(async (event) => {
        for (const uri of event.files) {
            const filePath = toWorkspacePath(uri);
            if (!filePath || isRemotePathEvent(filePath))
                continue;
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.File)
                    await sendWorkspaceFile(uri, filePath);
            }
            catch (error) {
                vscode.window.showWarningMessage(`Could not synchronize ${filePath}: ${error.message}`);
            }
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(async (event) => {
        for (const uri of event.files) {
            const filePath = toWorkspacePath(uri);
            if (filePath && !isRemotePathEvent(filePath)) {
                for (const pendingPath of Array.from(pendingFilePaths)) {
                    if (pendingPath === filePath || pendingPath.startsWith(`${filePath}/`))
                        pendingFilePaths.delete(pendingPath);
                }
                void persistFileQueue();
                void queueFileOperation({ operation: "delete", path: filePath }).catch((error) => vscode.window.showWarningMessage(`Could not queue deletion of ${filePath}: ${error.message}`));
                for (const key of Array.from(documents.keys())) {
                    if (key === filePath || key.startsWith(`${filePath}/`)) {
                        documents.delete(key);
                        documentUris.delete(key);
                        subscribedFiles.delete(key);
                    }
                }
                void persistOutbox();
                void persistFileQueue();
                refreshViews();
            }
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(async (event) => {
        for (const item of event.files) {
            const oldPath = toWorkspacePath(item.oldUri);
            const newPath = toWorkspacePath(item.newUri);
            if (!oldPath || !newPath || isRemotePathEvent(oldPath) || isRemotePathEvent(newPath))
                continue;
            let stat;
            try {
                stat = await vscode.workspace.fs.stat(item.newUri);
            }
            catch {
                continue;
            }
            if (stat.type === vscode.FileType.File) {
                if (pendingFilePaths.delete(oldPath))
                    pendingFilePaths.add(newPath);
                void persistFileQueue();
                void queueFileOperation({ operation: "move", from: oldPath, to: newPath }).catch((error) => vscode.window.showWarningMessage(`Could not queue rename of ${oldPath}: ${error.message}`));
                const session = documents.get(oldPath);
                if (session) {
                    documents.delete(oldPath);
                    session.filePath = newPath;
                    session.uri = item.newUri;
                    documents.set(newPath, session);
                    documentUris.delete(oldPath);
                    documentUris.set(newPath, item.newUri);
                    if (subscribedFiles.delete(oldPath))
                        subscribedFiles.add(newPath);
                    void persistOutbox();
                }
            }
            else {
                const moves = [];
                async function collect(folder) {
                    for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
                        const child = vscode.Uri.joinPath(folder, name);
                        if (type === vscode.FileType.Directory)
                            await collect(child);
                        else if (type === vscode.FileType.File) {
                            const relative = path.relative(item.newUri.fsPath, child.fsPath).replace(/\\/g, "/");
                            moves.push({ from: `${oldPath}/${relative}`, to: `${newPath}/${relative}` });
                        }
                    }
                }
                await collect(item.newUri);
                for (const move of moves) {
                    if (pendingFilePaths.delete(move.from))
                        pendingFilePaths.add(move.to);
                    void queueFileOperation({ operation: "move", from: move.from, to: move.to }).catch((error) => vscode.window.showWarningMessage(`Could not queue rename of ${move.from}: ${error.message}`));
                    const session = documents.get(move.from);
                    const targetUri = uriForWorkspacePath(move.to);
                    if (session) {
                        documents.delete(move.from);
                        session.filePath = move.to;
                        if (targetUri)
                            session.uri = targetUri;
                        documents.set(move.to, session);
                        documentUris.delete(move.from);
                        if (targetUri)
                            documentUris.set(move.to, targetUri);
                        if (subscribedFiles.delete(move.from))
                            subscribedFiles.add(move.to);
                    }
                }
                void persistOutbox();
            }
        }
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor)
            return;
        const session = getSession(editor.document);
        activeFilePath = session?.filePath;
        if (session)
            void subscribeDocument(editor.document);
        renderCursors(editor);
        sendCurrentCursor(editor);
    }));
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
        sendCurrentCursor(event.textEditor);
    }));
    for (const document of vscode.workspace.textDocuments)
        getSession(document);
    updateStatusBar();
}
function deactivate() {
    isManualDisconnect = true;
    clearTimeout(reconnectTimer);
    for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Extension deactivated"));
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendMessage({ type: "leave" });
        ws.close(1000, "Extension deactivated");
    }
    else if (ws && ws.readyState === WebSocket.CONNECTING)
        ws.close();
    for (const decoration of cursorDecorations.values())
        decoration.dispose();
}
//# sourceMappingURL=extension.js.map