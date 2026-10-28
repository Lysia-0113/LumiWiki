# 系统适配边界

已实现：浏览器、声明式 UI 检查、场景门禁、证据账本、标注和草稿。状态准备目前使用已有状态或人工/浏览器操作，**尚无自动种子、重置或后端验证适配器**。

后续可信宿主适配器建议接口：

```ts
interface SystemAdapter {
  id: string;
  capabilities: Array<"login" | "seed" | "reset" | "verify-domain">;
  prepare(request: { profileId: string; scenarioId: string; runId: string }): Promise<{
    fixtureId: string; accountRef: string; variables: Record<string, string>;
  }>;
  verify(request: { fixtureId: string; criterionId: string }): Promise<{
    passed: boolean; evidenceId: string;
  }>;
  cleanup(request: { fixtureId: string; runId: string }): Promise<void>;
}
```

部署者注册能力、测试域名和账号边界；模型只能提交能力 ID 和类型化参数，不能提交执行代码。登录可用人工会话、测试表单或 SSO 会话提供方；数据可用测试管理 API 或预置数据集。

状态准备需唯一运行标记、幂等重试和清理报告。没有 seed 能力时使用已有数据并核验前置状态，无法核验则 blocked；清理失败不能说已清理。

业务验证和 UI 验证分别记录。在可信业务适配器落地前，结果只标 `ui-checks`。契约本身的业务正确性仍需人复核，hooks 无法自动推导任意系统的完整规则。
