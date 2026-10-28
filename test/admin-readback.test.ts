import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectAdminReadback,
  type ReadRequest,
} from "./fixtures/admin-readback.js";

test("业务读回验收要求提交后的同对象与日志服务端读取，支持SPA并拒绝空刷新、错对象和提交前读取", () => {
  const write: ReadRequest = {
    method: "POST",
    pathname: "/api/orders/PO-012/approve",
    query: "",
    afterWrites: 0,
  };
  const read: ReadRequest = {
    method: "GET",
    pathname: "/api/orders",
    query: "?q=PO-012",
    afterWrites: 1,
  };
  const audit: ReadRequest = {
    method: "GET",
    pathname: "/api/audit",
    query: "",
    afterWrites: 1,
  };
  const spa = inspectAdminReadback([write, read, audit], "PO-012");
  assert.equal(spa.passed, true);
  assert.equal(spa.pageReloadObserved, false);
  assert.equal(
    inspectAdminReadback(
      [write, { method: "GET", pathname: "/", query: "", afterWrites: 1 }],
      "PO-012",
    ).passed,
    false,
  );
  assert.equal(
    inspectAdminReadback(
      [write, { ...read, query: "?q=PO-011" }, audit],
      "PO-012",
    ).passed,
    false,
  );
  assert.equal(
    inspectAdminReadback(
      [{ ...read, afterWrites: 0 }, { ...audit, afterWrites: 0 }, write],
      "PO-012",
    ).passed,
    false,
  );
  assert.equal(inspectAdminReadback([write, read], "PO-012").passed, false);
});
