# LumiWiki

本地系统使用助手。基于 **TypeScript + Pi Coding Agent SDK 1.4.0**，结合 DeepWiki 页级知识库与真实网页生成使用文档、上手指南，并提供审核后的问答。源码只用于独立 DeepWiki 生成阶段，Agent 不提供源码读取、目录列表或 Shell 工具。

当前优先完成服务启动和核心链路。源码变化检测与自动更新暂不实现。

## 本机启动

```sh
./lumiwiki dev
```

默认地址：

| 服务                     | 地址                       |
| ------------------------ | -------------------------- |
| LumiWiki 管理台          | http://127.0.0.1:3000      |
| 用户问答                 | http://127.0.0.1:3000/user |
| DeepWiki 后端 / 接口文档 | http://127.0.0.1:8001/docs |
| Gymbook 专用临时验收环境 | http://127.0.0.1:9098      |

首次启动自动生成 `.env` 和随机管理口令。将 `QA_ADMIN_TOKEN` 填入管理台登录框；口令只保存在当前浏览器标签页。模型字段默认留空，服务仍能启动，但不会生成真实模型回答或 Wiki。

`dev` 会复用已经运行的 DeepWiki 和 Gymbook；不存在时启动它们。Gymbook 使用它自己的临时 MariaDB 脚本，通过回归后启动，退出该脚本时清理临时库。不会向日常 Gymbook 数据库灌测试数据。

```sh
./lumiwiki start   # 只启动 LumiWiki
./lumiwiki check   # TypeScript 类型检查
./lumiwiki test    # 核心测试，使用本地模型协议桩，不调用付费模型
./lumiwiki smoke   # 需服务已启动：管理台、Wiki导入、QA直答、Gymbook登录与截图
```

管理台只监听本机。数据保存在 `.webdemo/`，重启保留，不进入版本库。浏览器使用独立 Chrome 会话，不复用个人 Cookie。

## 模型配置

均采用 OpenAI 兼容接口。Base URL 填到版本前缀，例如 `https://your-service.example/v1`，不要填完整的 `/chat/completions` 或 `/embeddings` 路径。

| 用途                              | 配置                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| 管理端 Pi Agent                   | `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`                      |
| QA 相似度检索、DeepWiki 索引      | `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`    |
| 中相似度判断                      | `QA_JUDGE_BASE_URL`、`QA_JUDGE_API_KEY`、`QA_JUDGE_MODEL`       |
| 低相似度探索 Agent，例如 DeepSeek | `PUBLIC_LLM_BASE_URL`、`PUBLIC_LLM_API_KEY`、`PUBLIC_LLM_MODEL` |
| DeepWiki 生成模型                 | `DEEPWIKI_MODEL`，为空时使用 `LLM_MODEL`                        |

Embedding、Judge、公共 Agent 的 URL / Key 留空时复用 LLM 对应值；Judge 和 Embedding 模型名必须分别填写。公共 Agent 模型名为空时复用聊天模型。DeepWiki 生成端目前使用聊天端的 URL / Key。

填写 `.env` 后，**重启 LumiWiki 和 DeepWiki 两个进程**。`dev` 若提示复用已有 DeepWiki，需先在原启动终端结束该进程，再运行 `dev`，以加载新的模型配置。

问答分流：

1. 已审核问答先进行规范化精确匹配。
2. Embedding 余弦相似度达到高档阈值且候选间距足够，直接返回已有答案。
3. 达到中档阈值，Judge 判断并选择候选答案；判定失败或输出无效则回落 Agent。
4. 低相似度由 Pi 驱动探索模型。启用浏览器时，默认访问当前项目填入的目标网页，使用独立会话和该项目保存的测试账号。

在管理台「项目配置 → 当前项目设置」中，可独立设置每个项目的浏览器探索开关、测试账号和密码；有单独测试环境时，可填写「问答探索地址」，留空则始终跟随项目目标网页。切换项目后，用户问答使用对应项目的地址与账号，无需修改 `.env` 或重启服务。密码留空保留原值，也可显式清除。

`PUBLIC_BROWSER_ENABLED`、`PUBLIC_TEST_USERNAME`、`PUBLIC_TEST_PASSWORD` 只在新建项目、旧项目首次启动迁移时提供默认值，随后配置随项目持久保存。`PUBLIC_TEST_URL` 供 Gymbook 联调脚本使用，不限制或覆盖项目的问答地址。问答浏览器只允许在本次配置的网站内导航；请为需要探索的项目配置适合的测试环境和账号。

默认阈值为 `0.82 / 0.62`，候选间距 `0.05`。这些是可调相似度阈值，并非答案正确概率。未配置 Embedding 时仍支持精确匹配；未配置 Judge 时，中档候选回落 Agent。

## 使用顺序

1. 打开管理台，输入本地 `.env` 的管理口令。
2. 在“项目配置”创建或切换项目，填写源码目录及网页 URL；项目管理、知识库与服务状态都在这一栏。
3. 在“项目配置”的知识库中点击“通过 DeepWiki 生成”，完成后自动导入；也可以上传 Markdown。生成状态使用中文显示，当前标签页刷新后会继续查询已提交的任务。
4. 在“快速上手”点击“生成指南”，连接目标网页，按需在独立窗口人工登录。生成的指南与文档保存在本栏，支持选中预览和打开 HTML / Markdown / JSON。截图内嵌到导出文件中。
5. 指南保存后自动整理文字 QA 草稿，进入“QA 问答”；整理失败可在“快速上手”选中指南单独重试，无需重跑浏览器。
6. 在“QA 问答”可以向助手提问并保存文字回答，或手动新增、编辑和审核问答。编辑后退回草稿；人工审核通过后才用于用户直答。

`LLM_VISION=true` 时，浏览器观察、导航到新页面、返回和主动截图会将遮挡密码及 `[data-private]` 区域的视口图片与页面文字一起发送给模型；普通填写、点击仍返回页面结构，可按需再次观察。操作继续依赖当前有效 ref。观察图片不会被当作已核验的指南证据，指南截图仍需通过原有核验流程。模型不支持图片时设为 `false`；独立公共模型可用 `PUBLIC_LLM_VISION` 覆盖主模型设置。

QA 的模型输入可以包含图片，保存和展示的答案仍为纯文字。指南整理 QA 的独立模型会话只接收文字，不传截图；图片仅用于指南和文档展示。

快速上手使用项目内 `skills/quick-start/SKILL.md`，由 Pi 原生 `/skill:quick-start` 入口加载执行。公共探索不加载管理技能。技能仅来自本应用目录，不读取个人 Pi 配置或被分析仓库中的技能。

技能包包含任务契约 schema、跨系统示例、验证脚本和评测。Pi hooks 与宿主工具要求前置状态检查、场景结果检查、验证后截图，再写入对应模块文档；页面继续操作会撤销当前证据。`image_annotate` 可在原图冻结坐标上画编号红框，保留原图。设计和当前边界见 [通用 Skill 设计](docs/quick-start-design.md)。基础模式使用已有或人工/浏览器准备的数据，自动种子、重置和可信后端验证适配器尚未实现。

浏览器观察基于 Playwright 1.64.1 的原生可访问性树：包含父子层级、控件名称与路径、展开/选中/禁用状态及坐标。`browser_inspect` 可查看局部树，`browser_act` 支持 `hover`、`expand`、`collapse`。折叠菜单展开后重新观察实际子项；每次观察更新 ref。原生快照中的密码和 `[data-private]` 内容会在返回模型前遮挡。

## 在其他机器安装

需要 Node.js 22.19+、pnpm、Chrome。安装当前项目：

```sh
pnpm install
```

DeepWiki 使用旁边的 `../deepwiki-open` 目录，源码版本记录在 `deployment/deepwiki.json`。安装 Python 3.12 环境与依赖：

```sh
git clone https://github.com/AsyncFuncAI/deepwiki-open.git ../deepwiki-open
git -C ../deepwiki-open checkout 3e0f503b0cc815c1525a063911524d233bda2400
uv venv --python 3.12 ../deepwiki-open/.venv
uv pip install --python ../deepwiki-open/.venv/bin/python -r deployment/deepwiki-requirements.lock
```

Gymbook 单独需要 Go 和 MariaDB。路径可通过 `.env` 的 `GYMBOOK_REPO` 和 `DEEPWIKI_REPO` 调整。

## 本阶段边界

已接入：项目管理、Wiki 生成任务/进度/导入、页级读取、Pi 多轮流式问答与取消、浏览器观察/操作/截图、文档及基础指南导出、指南自动整理 QA 草稿及人工审核、三档分流、专用测试浏览器探索。

尚未完成原目标态中的：截图箭头、公共反馈与公共指南展示、完整 CLI 问答入口。当前指南有目录和完整离线图片，文档均作为草稿供人工复核；检查等级为 UI 检查，任务契约也需复核。

核心回归使用本地协议桩，实际运行 Pi SDK 的工具循环与 Skill 展开。浏览器测试覆盖原生层级、展开/悬停、旧 ref 失效与密码遮挡。

填写模型配置后，可显式运行真实模型验收（会调用配置的模型服务并保存指南草稿）：

```sh
node --import tsx scripts/live-guide.mjs
```

该验收使用已导入 Wiki 和专用 Gymbook 测试环境，覆盖自动登录、钱包查询、快速上手 Skill、真实截图、文档与离线指南；不会提交预约、充值或退款。结果保存在 `.webdemo/verification/live-guide.json`。

## 复杂后台任务

快速上手默认针对后台业务任务：多级菜单、筛选分页、同行操作、抽屉/弹窗、联动表单、校验错误及跨页核验。默认 admin 契约要求成功场景至少2个中间检查点，分别验证和截图，最终结果另行核验；简单只读任务显式使用 general。浏览器增加 browser_table、browser_wait 和区域滚动。完整指南不限制工具调用次数，仍保留单轮30分钟超时、手动停止与同一失败操作连续三次的暂停机制；普通问答和公共端仍使用各自的调用限额。

复杂后台真实模型验收：

```sh
node --import tsx scripts/live-admin-guide.mjs
```

脚本启动独立本地采购后台，生成带检查点截图的审批指南，仅改变本次临时数据。报告位于 `.webdemo/verification/complex-admin-live.json`。执行规则见 `skills/quick-start/SKILL.md`；开发者验收说明另放 `evals/README.md`，不会自动注入模型。

## 指南任务保存与恢复

指南任务的计划、场景核验、截图引用、模块文档和任务状态会在每次工具执行后原子保存到 `.webdemo/projects/<项目>/tasks/`。一个模块核验结束后必须先保存文档，再操作下一模块。页面会明确显示运行、暂停、受阻、完整完成或部分完成。

在「快速上手」的「指南任务」中点击“继续任务”，会保留原计划、已保存文档和历史证据；再次勾选完整指南不会清空未完成任务。服务重启后先连接目标网页并登录，再恢复任务；浏览器控件 ref 不跨会话复用，模型会根据保存的任务状态重新观察剩余场景。已保存成果属于原核验时刻的证据，不代表当前页面状态。

业务操作开始前会保存待核对标记。如果进程在提交过程中中断，恢复时需要先人工核对结果，或用结果核验确认操作已完成，系统不会自动重复提交。任务记录不包含模型密钥或登录口令。刷新、断线、停止和超时会暂停本轮运行；这不是脱离请求连接持续运行的后台队列，恢复需要用户点击继续。

管理端接口：`GET /api/projects/:projectId/tasks` 列出任务，`GET /api/projects/:projectId/tasks/:taskId` 查看核验状态；`POST /api/ask` 传入 `mode=quick_start`、`taskId` 和已连接的 `browserId` 恢复任务。新建会话用于开启另一个指南任务。
