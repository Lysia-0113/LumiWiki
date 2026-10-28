export interface ReadRequest {
  method: string;
  pathname: string;
  query: string;
  afterWrites: number;
}
/** Fixture acceptance: fresh server reads after the write, independent of SPA vs document reload. */
export function inspectAdminReadback(requests: ReadRequest[], orderId: string) {
  const write = requests.findIndex(
    (r) =>
      r.method === "POST" && r.pathname === `/api/orders/${orderId}/approve`,
  );
  const reads = requests.flatMap((r, i) =>
    i > write &&
    r.afterWrites === 1 &&
    r.method === "GET" &&
    r.pathname === "/api/orders" &&
    new URLSearchParams(r.query).get("q") === orderId
      ? [i]
      : [],
  );
  const audits = requests.flatMap((r, i) =>
    i > write &&
    r.afterWrites === 1 &&
    r.method === "GET" &&
    r.pathname === "/api/audit"
      ? [i]
      : [],
  );
  return {
    passed: write >= 0 && reads.length > 0 && audits.length > 0,
    writeIndex: write,
    readIndices: reads,
    auditIndices: audits,
    pageReloadObserved: requests.some(
      (r, i) =>
        i > write &&
        r.afterWrites === 1 &&
        r.method === "GET" &&
        r.pathname === "/",
    ),
  };
}
