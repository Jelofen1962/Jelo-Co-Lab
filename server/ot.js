"use strict";

function push(parts, type, value) {
  if (value === 0 || value === "") return;
  const last = parts[parts.length - 1];
  if (last && last.type === type) {
    if (type === "insert") last.text += value;
    else last.count += value;
  } else {
    parts.push(type === "insert" ? { type, text: value } : { type, count: value });
  }
}

function normalize(operation) {
  if (!Array.isArray(operation) || operation.length > 10_000) throw new Error("Invalid operation");
  const result = [];
  for (const part of operation) {
    if (!part || typeof part !== "object") throw new Error("Invalid operation component");
    if (part.type === "insert" && typeof part.text === "string" && part.text.length <= 5_000_000) push(result, "insert", part.text);
    else if ((part.type === "retain" || part.type === "delete") && Number.isSafeInteger(part.count) && part.count > 0 && part.count <= 5_000_000) push(result, part.type, part.count);
    else throw new Error("Invalid operation component");
  }
  return result;
}

function applyOperation(text, operation) {
  if (typeof text !== "string") throw new Error("Document must be text");
  const parts = normalize(operation);
  let offset = 0;
  let result = "";
  for (const part of parts) {
    if (part.type === "retain") {
      if (offset + part.count > text.length) throw new Error("Operation retain exceeds document length");
      result += text.slice(offset, offset + part.count);
      offset += part.count;
    } else if (part.type === "delete") {
      if (offset + part.count > text.length) throw new Error("Operation delete exceeds document length");
      offset += part.count;
    } else {
      result += part.text;
    }
  }
  if (offset !== text.length) throw new Error("Operation does not cover the document");
  return result;
}

function diffText(before, after) {
  if (before === after) return before.length ? [{ type: "retain", count: before.length }] : [];
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  // Keep UTF-16 surrogate pairs intact when finding the common prefix.
  if (prefix > 0 && prefix < before.length && prefix < after.length &&
      before.charCodeAt(prefix) >= 0xDC00 && before.charCodeAt(prefix) <= 0xDFFF) prefix -= 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && suffix < before.length - prefix && suffix < after.length - prefix &&
      before.charCodeAt(before.length - suffix) >= 0xD800 && before.charCodeAt(before.length - suffix) <= 0xDBFF) suffix -= 1;
  const result = [];
  push(result, "retain", prefix);
  push(result, "delete", before.length - prefix - suffix);
  push(result, "insert", after.slice(prefix, after.length - suffix));
  push(result, "retain", suffix);
  return result;
}

function changesToOperation(before, changes, after) {
  if (!Array.isArray(changes) || !changes.length) return diffText(before, after);
  const ordered = [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset);
  const result = [];
  let offset = 0;
  for (const change of ordered) {
    if (!change || !Number.isSafeInteger(change.rangeOffset) || !Number.isSafeInteger(change.rangeLength) ||
        change.rangeOffset < offset || change.rangeLength < 0 || typeof change.text !== "string" ||
        change.rangeOffset + change.rangeLength > before.length) return diffText(before, after);
    push(result, "retain", change.rangeOffset - offset);
    push(result, "delete", change.rangeLength);
    push(result, "insert", change.text);
    offset = change.rangeOffset + change.rangeLength;
  }
  push(result, "retain", before.length - offset);
  try {
    return applyOperation(before, result) === after ? result : diffText(before, after);
  } catch {
    return diffText(before, after);
  }
}

function transformOperation(incoming, previous, incomingWinsTie = false) {
  const a = normalize(previous);
  const b = normalize(incoming);
  let ai = 0, bi = 0, ao = 0, bo = 0;
  const result = [];
  const component = (parts, index, offset) => {
    const part = parts[index];
    if (!part) return null;
    return part.type === "insert"
      ? { type: part.type, text: part.text.slice(offset), length: part.text.length - offset }
      : { type: part.type, count: part.count - offset, length: part.count - offset };
  };
  const consume = (parts, state, amount) => {
    const current = parts[state.index];
    const length = current.type === "insert" ? current.text.length : current.count;
    state.offset += amount;
    if (state.offset === length) { state.index += 1; state.offset = 0; }
  };
  const as = { index: ai, offset: ao };
  const bs = { index: bi, offset: bo };

  while (as.index < a.length || bs.index < b.length) {
    const ac = component(a, as.index, as.offset);
    const bc = component(b, bs.index, bs.offset);
    if (ac?.type === "insert" && bc?.type === "insert") {
      if (incomingWinsTie) {
        push(result, "insert", bc.text);
        consume(b, bs, bc.length);
      } else {
        push(result, "retain", ac.length);
        consume(a, as, ac.length);
      }
      continue;
    }
    if (ac?.type === "insert") {
      push(result, "retain", ac.length);
      consume(a, as, ac.length);
      continue;
    }
    if (bc?.type === "insert") {
      push(result, "insert", bc.text);
      consume(b, bs, bc.length);
      continue;
    }
    if (!ac && !bc) break;
    if (!bc) throw new Error("Incoming operation ended before consuming the base document");
    if (!ac) {
      if (bc.type !== "insert") throw new Error("Operations do not share the same base document");
      push(result, "insert", bc.text);
      consume(b, bs, bc.length);
      continue;
    }
    const amount = Math.min(ac.length, bc.length);
    if (ac.type === "retain" && bc.type === "retain") push(result, "retain", amount);
    else if (ac.type === "retain" && bc.type === "delete") push(result, "delete", amount);
    consume(a, as, amount);
    consume(b, bs, amount);
  }
  return result;
}

module.exports = { normalize, applyOperation, diffText, changesToOperation, transformOperation };
