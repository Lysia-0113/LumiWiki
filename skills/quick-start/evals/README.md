# 评测

**读者：维护此 Skill 的开发者与 CI。此文件说明怎样验证 Skill，不会自动注入 Agent。**

Agent 当次必须遵守的行为规则写在 [核心 SKILL.md](../SKILL.md)，操作细节在 [workflow.md](../references/workflow.md)；需要强制执行的门禁由宿主实现。这里的测试命令和测试结果不作为目标系统的功能知识。

从项目根目录执行：

```sh
node --import tsx skills/quick-start/scripts/validate.ts
./lumiwiki check
./lumiwiki test
```

`test/quick-start.test.ts` 使用真实 Chrome 和独立本地页面，不调用付费模型：

| 场景 | 预期 |
|---|---|
| 预约成功、余额不足 | 分别核对记录字段、错误及未创建记录 |
| 工单成功、必填错误 | 同一运行时，不改业务代码 |
| 只有成功提示 | 结果检查失败 |
| 创建另一条记录 | 结果检查失败 |
| 页面未加载 | 不存在检查失败 |
| 验证后继续操作 | 证据失效，不能保存文档 |
| 缺少一个场景截图 | 文档门禁拒绝 |
| 标注旧截图 ref | 使用冻结坐标成功；跨浏览器或非法坐标拒绝 |

`test/core.test.ts` 通过真实 Pi SDK + 本地 OpenAI 协议桩调用非法 document_write，检查 hook 在处理器执行前阻止，并确认 Agent 没有源码工具。

这些测试证明执行约束，不证明模型能为任意系统制定正确业务契约。语义验收还要人工检查：是否选到真正用户任务、结果是否对应同一对象、断言是否过弱、未覆盖条件是否如实展示、有没有把未执行的清理写成已完成。

真实模型与 Gymbook 使用 `scripts/live-guide.mjs`，会调用配置的模型。当前脚本只查日历和钱包，不能据此宣称预约成功/余额不足/空态已完成真实端到端验收。另一真实系统验收尚未完成。

## 复杂后台验收

`test/admin-console.test.ts` 驱动有独立HTTP后端的采购后台，覆盖三级菜单、分页筛选、同名行按钮、抽屉、虚拟滚动、联动字段、意见校验、确认提交、刷新后同一记录核验及其他记录不变。另测过滤空态、只读角色禁用原因，以及300行表格后的portal弹窗和菜单。

`node --import tsx scripts/live-admin-guide.mjs` 使用已配置的真实模型和同一独立后台生成指南，会修改本次临时数据并调用模型。它检查 admin 契约、中间与最终图片覆盖、唯一审批事件、其他记录不变以及离线图片加载；报告位于 `.webdemo/verification/complex-admin-live.json`。

这些是代表性后台验收，不覆盖所有第三方组件、SSO或生产系统。核心规则在SKILL.md；测试实现和命令不注入模型。
