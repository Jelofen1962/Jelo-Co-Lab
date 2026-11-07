export type TextOperationPart =
  | { type: "retain"; count: number }
  | { type: "delete"; count: number }
  | { type: "insert"; text: string };
export function normalize(operation: TextOperationPart[]): TextOperationPart[];
export function applyOperation(text: string, operation: TextOperationPart[]): string;
export function diffText(before: string, after: string): TextOperationPart[];
export function changesToOperation(before: string, changes: ReadonlyArray<{ rangeOffset: number; rangeLength: number; text: string }>, after: string): TextOperationPart[];
export function transformOperation(incoming: TextOperationPart[], previous: TextOperationPart[], incomingWinsTie?: boolean): TextOperationPart[];
