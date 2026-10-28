# 执行规范

## 契约

工具 schema 定义参数，机器可读副本在 `schemas/task-plan.schema.json`。模块是用户任务，场景是不同初始状态下的路径。

- `audience`：角色和权限范围。
- `coverageReason`：场景选择与缺失分支。
- `goal`：业务结果。
- `setup`：已有测试状态、人工准备或宿主已注册的适配能力。
- `preconditions` / `outcomes`：可执行的只读 UI 断言。
- `cleanup`：恢复办法。写出计划不代表已执行清理，文档中要说明实际情况。

## 定位与断言

定位器支持 `{role,name}` 精确可访问名称、`{text}` 精确文本、`{testId}`、`{css}`。不执行模型提供的 JS、SQL、HTTP 请求或 shell。

表单还支持 `{label:字段标签}`，用于跨控件类型定位。未观察到的字段不能猜测 radio/combobox 等角色。`selected_label_equals` 比较当前已选中的可见选项标签，texts 为所需标签列表；`value_equals` 比较表单实际值。JSON Schema 约束结构，后台检查点数量、负向检查范围和已观察控件等跨字段要求由宿主校验器补充。

断言支持 `visible`、`hidden`、`enabled`、`disabled`、`checked`、`unchecked`、`text_contains`、`text_equals`、`value_equals`、`count`。文本填写 `texts` 数组；contains 要同一对象包含全部字段，equals 要修剪两端空白后等于唯一的 texts 值。金额/状态等精确条件使用 equals，例如不能用包含“0”判定零余额，否则“100”也会匹配。数量填写 `count`。正向检查对象须唯一且可见；不存在或零数量须指定唯一可见的 `scope`，防止页面未加载造成假通过。

记录检查应限定列表/详情范围，用唯一运行标记及关键字段核对同一对象，不能只看全页“成功”。UI 无法证明的结算、并发和后端权限隔离等事实，要记录证据不足，等待可信业务验证适配器。

## 流程

`观察与导航探路 → plan → prepare → begin → 逐步操作与checkpoint核验/截图 → verify → 结果截图/标注 → document → publish → 宿主自动整理QA草稿 → 人工审核`

锁定前先通过 `browser_navigate` 看过各任务页面，再选择真实存在的结果控件。`browser_act` 在契约前允许导航、返回、滚动、悬浮和展开；通用点击与填写要在契约后。导航结构不明确或弹窗阻碍探路时说明需要人工/适配准备，不凭 Wiki 猜测验收文本。

状态是 `pending / active / verified / blocked`。宿主生成检查结果，模型不能提交 `passed:true`。跨页面用 outcomeIds 分组验证，每组通过后先截图再导航；全部结果组均有证据才能完成。新的同站非GET/HEAD/OPTIONS请求会撤销当前场景的结果组；该计数仅表示浏览器观察到的请求，不是数据库事务版本，POST查询也会保守地撤销证据。下一场景先 prepare 再准备状态。

`quick_start_status` 返回宿主状态。block 和跳过不计为成功。预算不足时先保存证据并列出缺口。

## 深度

每个任务回答：谁操作、数据是什么、入口和层级在哪里、完成后如何核对同一对象、失败如何恢复。成功路径保留变化前后的依据，错误路径同时核对错误和不应发生的变化。

无法准备测试数据、权限不符、验证码或第三方流程不可达时标受阻。不能把缺少状态说成系统没有此功能。

迁移系统时重新观察，建立新的角色、目标和检查条件。示例控件、标记和 CSS 不代表新系统事实。基础模式用浏览器和已有状态；可靠自动回放需按 `adapter-contract.md` 增加适配能力。

默认 profile=admin：成功场景至少2个中间检查点，其他分支至少1个。每个检查点包括 id、title、checks；按 quick_start_checkpoint 验证，截图后才能继续，证据归档必须包含各检查点与最终结果的图片，用户指南只选关键图。简单只读任务显式使用 general。value_equals 检查表单当前值，texts 只填一个值；enabled/disabled 和 checked/unchecked 检查实际控件状态。

未汇总且预算允许时，Pi 收尾 hook 最多续跑2次；取消、运行错误或所有场景受阻时不自动继续。续跑不降低证据门禁。

表格结果使用 row_fields，指定 rowKey（column/value）和 fields（各column/value）。唯一匹配行的指定列必须精确相等，不拼接未来整行的名称，也不混用其他行字段。标注图可在稍后生成，但只有原图已经属于对应检查点或结果组时，派生图才能继承证据资格。
