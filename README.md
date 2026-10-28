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
4. 低相似度由 Pi 驱动探索模型。启用浏览器时，必须匹配 `PUBLIC_TEST_URL`，使用独立会话和 `PUBLIC_TEST_USERNAME` / `PUBLIC_TEST_PASSWORD`，仅针对专用测试数据。

默认阈值为 `0.82 / 0.62`，候选间距 `0.05`。这些是可调相似度阈值，并非答案正确概率。未配置 Embedding 时仍支持精确匹配；未配置 Judge 时，中档候选回落 Agent。

## 使用顺序

1. 打开管理台，输入本地 `.env` 的管理口令。
2. 默认创建 Gymbook 项目，或新建项目填写源码目录及网页 URL。
3. 在知识库点击“通过 DeepWiki 生成”，完成后自动导入；也可以上传 Markdown。
4. 在助手中连接浏览器，按需在独立窗口人工登录，开始提问或生成上手指南。
5. 在“生成产物”查看 HTML / Markdown / JSON。真实截图内嵌到导出文件中。指南通常每模块3至6步，只展示关键截图；详细核验与引用保留在 JSON。指南保存后自动整理 QA 草稿，进入“问答审核”；失败可在“生成产物”单独重试，无需重跑浏览器。
6. 在“问答审核”新增草稿，人工确认后，用户端才可直答。

当前截图用于文档产物；Agent 通过页面文字和控件信息操作，尚未接入视觉模型输入。

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

快速上手默认针对后台业务任务：多级菜单、筛选分页、同行操作、抽屉/弹窗、联动表单、校验错误及跨页核验。默认 admin 契约要求成功场景至少2个中间检查点，分别验证和截图，最终结果另行核验；简单只读任务显式使用 general。浏览器增加 browser_table、browser_wait 和区域滚动。QUICK_START_MAX_TOOL_CALLS 默认120，可在本地环境调整。

复杂后台真实模型验收：

```sh
node --import tsx scripts/live-admin-guide.mjs
```

脚本启动独立本地采购后台，生成带检查点截图的审批指南，仅改变本次临时数据。报告位于 `.webdemo/verification/complex-admin-live.json`。执行规则见 `skills/quick-start/SKILL.md`；开发者验收说明另放 `evals/README.md`，不会自动注入模型。
