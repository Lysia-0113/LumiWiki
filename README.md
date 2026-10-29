# LumiWiki

本地系统使用助手。基于 **TypeScript + Pi Coding Agent SDK 1.4.0**，结合 DeepWiki 页级知识库与真实网页生成使用文档、完整上手指南，并提供可审核发布的用户阅读入口与带核验状态的问答。源码只用于独立 DeepWiki 生成阶段，Agent 不提供源码读取、目录列表或 Shell 工具。

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

1. 所有可用问答先进行规范化精确匹配，包括尚未人工核验的条目；精确匹配到多条时优先已核验答案。停用条目不参与召回。
2. Embedding 余弦相似度达到高档阈值且候选间距足够，直接返回已有答案。
3. 达到中档阈值，Judge 判断并选择候选答案；判定失败或输出无效则回落 Agent。
4. 低相似度由 Pi 驱动探索模型。启用项目问答探索时，复用该项目的目标网页和已登录浏览器；未登录时可用项目配置的测试账号，仅针对授权数据操作。

默认阈值为 `0.82 / 0.62`，候选间距 `0.05`。这些是可调相似度阈值，并非答案正确概率。未配置 Embedding 时仍支持精确匹配；未配置 Judge 时，中档候选回落 Agent。

每条 QA 分别提供人工核验和启用/停用按钮，两种状态互不影响。只有可用状态决定是否参与召回、公开列表和推荐问题；人工核验只表示内容已由管理员确认。停用候选标为已核验也不会自动启用。首次模型回答和未核验 QA 直答都会提示“尚未经人工核验，回答可能存在错误，请结合实际情况判断”，已核验直答显示“已人工核验”。旧数据未填写 `enabled` 时默认可用。

用户端模型回答与管理端 QA 共用 `src/qa-prompt.ts` 中的提示词，并通过 `qa_finish` 提交回答、`answered / needs_clarification / insufficient_evidence` 结果、`general / context_specific` 适用范围及实际引用；该工具只记录本轮结果，不直接写 QA。完整、自包含的通用回答，且引用均为当前项目实际读取、版本仍有效的 Wiki 页时，保存为可用、未核验 QA；只要本会话读取过浏览器内容，即使模型省略网页引用，也只保存为停用候选，待管理员复核和启用。澄清、证据不足、个人或实时状态、无依据及过期引用不进入复用池。生成记录保存在 `runs/`，入库判定保存在内部 `qa-attempts/<runId>.json`。

## 使用顺序

1. 打开管理台，输入本地 `.env` 的管理口令。
2. 在“项目配置”创建或切换项目，填写源码目录、唯一目标网页；在这里管理知识库、项目问答探索开关和测试账号。
3. 在“项目配置”的知识库中点击“通过 DeepWiki 生成”，完成后自动导入；也可以上传 Markdown。
4. 在“快速上手”点击“生成指南”，连接目标网页并登录。勾选“生成完整上手指南”后，先全局只读探索并确定目录，再为每章创建独立 Pi 会话，串行深入探索、核验、标注和保存。章节之间不共享对话；宿主直接组装完整正文，不让汇总模型重新压缩。
5. 在“快速上手”查看 HTML / Markdown / JSON、各章状态和未完成范围。步骤支持多图，图中编号解释自动呈现在图下，图片内嵌可离线阅读。部分指南明确标记未完成，可重新连接并登录测试浏览器后继续任务，只补缺章；重做上游会同时更新受其影响的依赖章。
6. 指南保存后，独立 `initial-qa` Skill 按章启动新会话，只从已保存文字和编号解释整理 QA 草稿；没有浏览器或画框工具。每章最多三条，无整本二十条限制。失败可在“快速上手”选中指南单独重试，无需重跑浏览器。
7. 在“快速上手”选择指南或独立文档，预览正文和截图后点击“审核并发布”。发布保存独立图文快照；再次审核发布才更新用户版本，相同内容重复发布不会创建新版本，也可以撤回发布。
8. 在“QA 问答”提问并保存文字回答，或手动新增、编辑、核验和启用/停用。用户端“快速上手”只展示已发布指南，“QA 问答”展示可用问答并标明核验状态。

`LLM_VISION=true` 时，浏览器观察、导航到新页面、返回和主动截图会将遮挡密码及 `[data-private]` 区域的视口图片与页面文字一起发送给模型；普通填写、点击仍返回页面结构，可按需再次观察。操作继续依赖当前有效 ref。观察图片不会被当作已核验的指南证据，指南截图仍需通过原有核验流程。模型不支持图片时保持 `false`；独立公共模型可用 `PUBLIC_LLM_VISION` 覆盖主模型设置。QA 的模型输入可以包含图片，保存和展示的答案仍为纯文字；初始 QA 会话只接收文字，不传截图。

快速上手使用项目内 `skills/quick-start/SKILL.md`，初始 QA 使用 `skills/initial-qa/SKILL.md`，均由 Pi 原生技能入口显式展开，互不加载。在线问答不加载生成技能，且不注册画框或文档写入工具。技能仅来自本应用目录，不读取个人 Pi 配置或被分析仓库中的技能。

技能包包含任务契约 schema、跨系统示例、验证脚本和评测。Pi hooks 与宿主工具要求前置状态检查、场景结果检查、验证后截图，再写入对应模块文档；页面继续操作会撤销当前证据。`image_annotate` 只在指南章节阶段开放，在原图冻结坐标上画编号框并保留原图；拒绝重叠目标，编号自动避让，详细解释由可信 legend 自动导出。设计和当前边界见 [通用 Skill 设计](docs/quick-start-design.md)。基础模式使用已有或人工/浏览器准备的数据，自动种子、重置和可信后端验证适配器尚未实现。

浏览器观察基于 Playwright 1.64.1 的原生可访问性树：包含父子层级、控件名称与路径、展开/选中/禁用状态及坐标。`browser_inspect` 可查看局部树，`browser_act` 支持 `hover`、`expand`、`collapse`。折叠菜单展开后重新观察实际子项；每次观察更新 ref。原生快照和视觉图片中的密码与 `[data-private]` 内容都会在返回模型前遮挡。

快速上手和用户问答共用每个项目的目标网页、浏览器页面与登录状态。管理员先连接并登录，后续问答继续使用同一会话，问答结束不会关闭浏览器；切换管理台项目不清除登录。修改目标网址或登录信息、关闭浏览器或重启服务后需要重新连接。浏览器被其他任务占用时提示稍后重试，不抢占页面。

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

已接入：项目管理、Wiki 生成任务/进度/导入、页级读取、Pi 多轮流式问答与取消、浏览器观察/操作/截图、视觉输入、项目级共享浏览器、完整章节指南、独立初始 QA、指南审核发布与公开阅读、QA 核验/启用状态、结构化回答自动入库、三栏工作台。

尚未完成原目标态中的：截图箭头、公共反馈、完整 CLI 问答入口。当前指南有目录和完整离线图片，文档均作为草稿供人工复核；检查等级为 UI 检查，任务契约也需复核。

核心回归使用本地协议桩，实际运行 Pi SDK 的工具循环与 Skill 展开。浏览器测试覆盖原生层级、展开/悬停、旧 ref 失效与密码遮挡。

填写模型配置后，可显式运行真实模型验收（会调用配置的模型服务并保存指南草稿）：

```sh
node --import tsx scripts/live-guide.mjs
```

该验收使用已导入 Wiki 和专用 Gymbook 测试环境，覆盖自动登录、钱包查询、快速上手 Skill、真实截图、文档与离线指南；不会提交预约、充值或退款。结果保存在 `.webdemo/verification/live-guide.json`。

## 复杂后台任务

快速上手默认针对后台业务任务：多级菜单、筛选分页、同行操作、抽屉/弹窗、联动表单、校验错误及跨页核验。默认 admin 契约要求成功场景至少2个中间检查点，分别验证和截图，最终结果另行核验；简单只读任务显式使用 general。浏览器增加 browser_table、browser_wait 和区域滚动。`QUICK_START_MAX_TOOL_CALLS` 默认200，是每章独立预算；`QUICK_START_MAX_TOKENS` 默认8192，是单次模型输出参数，不是整本指南总额。`GUIDE_PLAN_MAX_TOOL_CALLS` 默认100，`GUIDE_CHAPTER_TIMEOUT_SECONDS` 默认1800，分别控制规划工具次数与单阶段时限。初始 QA 另有每章预算和时限，不受指南阶段耗尽影响。

复杂后台真实模型验收：

```sh
node --import tsx scripts/live-admin-guide.mjs
```

脚本启动独立本地采购后台，生成带检查点截图的审批指南，仅改变本次临时数据。报告位于 `.webdemo/verification/complex-admin-live.json`。执行规则见 `skills/quick-start/SKILL.md`；开发者验收说明另放 `evals/README.md`，不会自动注入模型。

## 指南审核与用户阅读

生成完成、任务状态为完整或部分完成、初始 QA 完成，都不会自动将指南对用户公开。在“快速上手”选择指南或独立文档，预览步骤和截图，点击“审核并发布”并确认审核。缺少步骤或引用的截图缺失时不能发布；部分模块未完成时会保留并展示限制说明。

发布会保存一份独立的图文快照，包含全部步骤图片和编号图下注解。草稿后续修改不影响已发布版本；再次审核发布才更新用户版本，相同内容的重复发布不会创建重复版本。可以撤回发布，撤回后列表、正文和各版本图片均不再对用户提供。

用户端提供“快速上手”与“QA 问答”两个栏目。管理员的“打开用户帮助”链接包含 `project`，用户入口固定到该项目；管理台切换项目不会改变此链接中的指南或 QA。用户端只展示已发布的指南内容，不提供内部核验记录、源码引用或运行日志。QA 保持纯文字。

管理接口：`GET/POST /api/projects/:projectId/publications` 查询发布状态或审核发布（`kind` 为 `guides` / `documents`，`id` 为产物 ID，`reviewed=true`）；`DELETE /api/projects/:projectId/publications/:id` 撤回。公开只读接口：`GET /api/v1/public/guides?project=:projectId`、`GET /api/v1/public/guides/:id?project=:projectId`，以及正文中引用的版本图片；`/user?project=:projectId&guide=:id` 可直达指南。
