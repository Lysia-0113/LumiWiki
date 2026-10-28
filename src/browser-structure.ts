export interface SnapshotNode {
  role?: string;
  name?: string;
  text?: string;
  ref?: string;
  children?: Array<SnapshotNode | string>;
  expanded?: boolean;
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean | string;
  cursor?: string;
  [key: string]: unknown;
}
export type Snapshot = Array<SnapshotNode | string>;
export function nodeText(node: SnapshotNode | string): string {
  if (typeof node === "string") return node;
  return (
    node.name || node.text || (node.children || []).map(nodeText).join(" ")
  );
}
export function allNodes(nodes: Snapshot): SnapshotNode[] {
  return nodes.flatMap((n) =>
    typeof n === "string" ? [] : [n, ...allNodes(n.children || [])],
  );
}
export function sanitizeSnapshot(
  nodes: Snapshot,
  redact: (s: string) => string,
): Snapshot {
  return nodes.map((item) => {
    if (typeof item === "string") return redact(item).slice(0, 1000);
    const node = { ...item };
    for (const key of ["name", "text", "placeholder", "value", "url"])
      if (typeof node[key] === "string")
        node[key] = redact(node[key] as string).slice(0, 2000);
    if (node.children) node.children = sanitizeSnapshot(node.children, redact);
    return node;
  });
}
export function tableRows(table: SnapshotNode): SnapshotNode[] {
  const visit = (nodes: Snapshot): SnapshotNode[] =>
    nodes.flatMap((n) => {
      if (
        typeof n === "string" ||
        ["table", "grid", "treegrid"].includes(n.role || "")
      )
        return [];
      if (n.role === "row") return [n];
      return visit(n.children || []);
    });
  return visit(table.children || []);
}
export function rowCells(row: SnapshotNode) {
  const visit = (children: Snapshot): SnapshotNode[] =>
    children.flatMap((n) => {
      if (
        typeof n === "string" ||
        ["table", "grid", "treegrid", "row"].includes(n.role || "")
      )
        return [];
      if (
        ["cell", "gridcell", "columnheader", "rowheader"].includes(n.role || "")
      )
        return [n];
      return visit(n.children || []);
    });
  return visit(row.children || []);
}
export function snapshotOutline(nodes: Snapshot) {
  const all = allNodes(nodes);
  const regionRoles = new Set([
    "navigation",
    "main",
    "form",
    "region",
    "table",
    "grid",
    "treegrid",
    "tablist",
    "dialog",
    "alertdialog",
    "listbox",
    "menu",
  ]);
  const regions = all
    .filter(
      (n) =>
        n.ref &&
        (regionRoles.has(n.role || "") || (n.role === "generic" && n.name)),
    )
    .slice(0, 50);
  const overlays = all.filter((n) =>
    ["dialog", "alertdialog", "listbox"].includes(n.role || ""),
  );
  const tables = all.filter((n) =>
    ["table", "grid", "treegrid"].includes(n.role || ""),
  );
  return {
    regions,
    // A portal dialog at the end of a huge page must not disappear behind the global tree limit.
    focus: overlays.at(-1),
    tables: tables.slice(0, 12).map((table) => {
      const rows = tableRows(table);
      const headers = rows.find((row) =>
        rowCells(row).some((c) => c.role === "columnheader"),
      );
      return {
        ref: table.ref!,
        label: table.name || "",
        columns: headers ? rowCells(headers).map(nodeText).slice(0, 40) : [],
        renderedRows: rows.filter(
          (row) => !rowCells(row).some((c) => c.role === "columnheader"),
        ).length,
      };
    }),
    alerts: all
      .filter((n) => ["alert", "status", "progressbar"].includes(n.role || ""))
      .slice(-12)
      .map((n) => ({ role: n.role, text: nodeText(n).slice(0, 600) })),
  };
}
export interface TableWindow {
  offset?: number;
  limit?: number;
  contains?: string;
}
export function selectTableWindow(
  table: SnapshotNode,
  input: TableWindow = {},
) {
  const rows = tableRows(table);
  const headers = rows.filter((r) =>
    rowCells(r).some((c) => c.role === "columnheader"),
  );
  const data = rows.filter((r) => !headers.includes(r));
  const matched = data.filter(
    (r) =>
      !input.contains ||
      nodeText(r)
        .toLocaleLowerCase()
        .includes(input.contains.toLocaleLowerCase()),
  );
  const offset = Math.max(0, input.offset || 0);
  const limit = Math.min(30, Math.max(1, input.limit || 10));
  const selected = matched.slice(offset, offset + limit);
  return { headers, data, selected, matched: matched.length, offset, limit };
}
export function windowTables(
  nodes: Snapshot,
  requested?: TableWindow,
): Snapshot {
  return nodes.map((item) => {
    if (typeof item === "string") return item;
    if (["table", "grid", "treegrid"].includes(item.role || "")) {
      const selected = selectTableWindow(item, requested);
      const allowed = new Set(
        [...selected.headers, ...selected.selected].map((r) => r.ref),
      );
      const prune = (children: Snapshot): Snapshot =>
        children.flatMap<SnapshotNode | string>((n) => {
          if (typeof n === "string") return [n];
          if (n.role === "row" && !allowed.has(n.ref)) return [];
          return [
            { ...n, ...(n.children ? { children: prune(n.children) } : {}) },
          ];
        });
      return { ...item, children: prune(item.children || []) };
    }
    return {
      ...item,
      ...(item.children
        ? { children: windowTables(item.children, requested) }
        : {}),
    };
  });
}
