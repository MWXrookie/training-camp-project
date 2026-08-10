# AI 错题本技术方案

版本：V1.1  适用范围：三天受控试用版 + 面向学生的 AI 错题本 Web 全栈应用 MVP

本方案承接产品想法验证报告的结论：首发以中学数学为第一学科，围绕“上传/截图 -> 结构化错题 -> AI 错因 -> 复习安排 -> 变式练习 -> 学习曲线”构建闭环。

## 六、分阶段技术路线

### 试用版技术目标

先用 3 个完整工作日完成一个受控、可测试、可演进的体验版本。试用版不承担生产级规模、未成年人正式使用和跨设备数据服务，但必须保留“AI 结果经用户确认后才能入库”的业务边界。

### 试用版架构

| 层 | 试用版方案 | 约束 |
|---|---|---|
| 应用 | 单个 Next.js + TypeScript 应用 | 页面和服务端 Route Handler 同仓，不拆 FastAPI |
| UI | React + Tailwind CSS | 移动端优先，复用完整 MVP 的设计令牌和组件语义 |
| AI | 服务端 `/api/trial/analyze` 调用一个多模态模型 | API Key 不下发浏览器；输出通过严格 Schema |
| 数据 | 浏览器 IndexedDB | 只保存已确认题目、便签和复习记录，不支持跨设备 |
| 图片 | 浏览器预览，随分析请求临时发送 | 应用服务端不持久化原图，日志不得记录请求体 |
| 排期 | 轻量确定性复习规则 | 支持立即、次日和后续时间；完整 MVP 替换为 FSRS |
| 访问控制 | 受控访问口令 + 服务端调用限额 | 仅供 3-5 名已知情成年测试者，不视为正式账号系统 |
| 部署 | 单应用托管部署或本地受控演示 | 设置模型支出上限和一键停用开关 |

### 试用版数据流

1. 测试者阅读 AI 图片处理告知并进入受控应用。
2. 浏览器校验图片类型和大小，显示本地预览。
3. 图片经服务端 Route Handler 临时转发给多模态模型。
4. 服务端验证模型 JSON，移除未知字段后返回浏览器。
5. 用户对照原图编辑；确认前不写入正式本机错题库。
6. 用户确认后，结构化题目、个人便签和复习记录写入 IndexedDB。
7. 如果模型识别失败，用户可将原图保存为传统错题；该路径不调用模型、不生成 AI 分析、不创建复习排期，只写入本机错题库。
8. 用户可删除单题或清空全部本机数据。

### 试用版接口契约

```text
POST /api/trial/analyze
Content-Type: multipart/form-data

image: JPG/PNG/WEBP，大小上限由配置控制
consent_version: 当前简明告知版本
```

成功返回：

```json
{
  "data": {
    "stem": "题干",
    "student_answer": null,
    "correct_answer": "答案",
    "knowledge_tags": ["知识点"],
    "error_type": "insufficient_information",
    "explanation": {
      "hint": "提示",
      "key_steps": ["关键步骤"],
      "full_solution": "完整解析"
    },
    "risk_flags": ["student_answer_missing"]
  },
  "request_id": "req_xxx"
}
```

错误返回稳定的 `validation_failed`、`consent_required`、`rate_limited`、`model_failed` 或 `schema_failed`。模型原始自由文本不得直接返回前端。

### 试用版最小安全规则

- 只允许受控成年测试者使用，不采集学校、真实姓名、生日和联系方式；
- 上传前明确告知图片会发送给模型供应商处理；
- 供应商训练使用和日志策略未核验前，不允许真实未成年人图片进入试用；
- 服务端不持久化图片，不记录请求体、题干、答案和模型密钥；
- 限制文件类型、大小、请求频率、单日调用数和最大模型支出；
- IndexedDB 清空能力仅代表清除应用本机数据，不虚构第三方供应商删除证明。

### 向完整 MVP 的演进映射

| 试用版 | 完整 MVP | 演进方式 |
|---|---|---|
| Next.js Route Handler | FastAPI API + Worker | 保持请求/响应 Schema，替换执行位置 |
| 单一模型适配模块 | Model Gateway | 将当前适配器纳入供应商路由和审计 |
| 多模态直接识别 | 预处理 + OCR + AI 分析 | 将确认页字段契约作为兼容边界 |
| IndexedDB | PostgreSQL + S3 | 增加正式账号后提供受控迁移或重新录入 |
| 轻量复习规则 | FSRS | 保留复习评分枚举，重建调度状态 |
| 受控访问口令 | Guest/Email + 同意状态 | 替换入口，不复用口令作为用户身份 |
| 同步请求 | Redis 队列 + Worker | 引入 `job_id`、幂等、重试和状态恢复 |

试用版代码可以复用 UI、Schema、状态枚举、模型适配接口和测试，但不要求保留临时存储与访问控制实现。验证失败时应允许删除试用实现，而不是让沉没成本约束产品决策。

## 七、总体技术架构

### 技术选型

| 层 | 推荐方案 | 选择理由 |
|---|---|---|
| 前端 | Next.js + TypeScript + React + Tailwind CSS | 适合 Web/PWA、表单和响应式页面，开发效率高 |
| 后端 | FastAPI + Python + SQLAlchemy | 适合 OCR、异步任务和 AI 编排，接口文档自动生成 |
| 数据库 | PostgreSQL | 结构化数据、JSONB、全文检索和后续向量扩展都可支持 |
| 缓存/队列 | Redis + Celery 或 Dramatiq | OCR、LLM、PDF 均应异步执行，避免请求超时 |
| 文件存储 | S3 兼容对象存储 | 原图、裁剪图、PDF 与数据库分离，便于生命周期管理 |
| OCR | PaddleOCR/PP-Structure 为主，云 OCR 为兜底 | 自部署可控成本，复杂场景可切换供应商 |
| 大模型 | 统一 Model Gateway，接入 Qwen、DeepSeek 或其他 OpenAI-compatible API | 避免绑定单一模型，按任务选择速度和质量 |
| 向量检索 | PostgreSQL + pgvector | MVP 不需要独立向量数据库，减少运维成本 |
| PDF | HTML/CSS + Playwright Chromium | 中文字体、公式和图片版式更容易控制 |
| 部署 | Docker Compose + 单台云服务器 + 自动备份 | 适合低预算 MVP，后续再拆分服务 |

### 架构图

完整系统架构图已独立维护，包含用户端、接入层、业务服务、异步任务、AI 编排、数据层、安全审计和 PDF 导出链路：

[查看 AI 错题本系统架构图](AI错题本系统架构图.md)

图中的核心原则是：图片和模型处理走异步任务；所有模型调用经过统一网关；低置信度结果必须经过用户确认；原图和 PDF 放在对象存储；复习状态由 FSRS 调度器驱动。

### 核心数据流

1. 用户上传图片，API 生成 `question_upload` 记录和短期对象存储地址。
2. 图片预处理服务检测清晰度、方向和题目区域，生成裁剪图。
3. OCR 服务返回文字、坐标、公式和置信度，不直接覆盖原图。
4. AI 分析服务把 OCR 结果转换为严格 JSON，生成知识点、错因和讲解。
5. 校验服务检查字段完整性、答案格式、数学表达式和模型置信度。
6. 结果写入数据库，前端展示“已确认/需要确认/处理失败”状态。
7. 用户可编辑识别文本；编辑后的内容作为后续分析的可信输入。
8. 复习服务根据 review log 更新下一次复习时间。

## 八、AI 与 OCR 方案

### OCR 分层策略

#### 第一层：图像质量处理

- EXIF 方向纠正；
- 旋转、裁剪、去阴影、增强对比度；
- 检测图片是否过暗、模糊或遮挡；
- 题目区域切分，减少整页图片直接送模型。

#### 第二层：结构识别

输出以下结构：

```json
{
  "items": [
    {
      "question_no": "1",
      "stem": "题干文本",
      "options": [],
      "student_answer": "学生答案",
      "teacher_marks": "批改标记",
      "handwriting": [],
      "formula_latex": [],
      "bbox": [0, 0, 100, 100],
      "confidence": 0.93
    }
  ],
  "raw_text": "原始识别文本",
  "need_review": false
}
```

#### 第三层：AI 教学分析

分析结果必须符合 JSON Schema，禁止只返回自由文本：

```json
{
  "subject": "math",
  "grade": "初二",
  "knowledge_tags": [
    {"id": "math.linear_equation", "name": "一元一次方程", "confidence": 0.91}
  ],
  "error_type": {
    "code": "concept_gap",
    "name": "知识点不熟",
    "confidence": 0.78
  },
  "correct_answer": "x=3",
  "explanation": {
    "hint": "先把含 x 的项移到同一边",
    "key_steps": ["..."],
    "full_solution": "..."
  },
  "review_plan": {
    "initial_interval_days": 1,
    "difficulty": 2
  },
  "risk_flags": ["handwriting_uncertain"]
}
```

### 大模型调用原则

- 使用 Model Gateway 统一封装，不在业务代码中写死某一家模型；
- 题目识别、错因分类、讲解、变式生成和复习后复盘拆成不同任务；
- 复习后复盘只输入用户本次作答、复习感受和历史便签，不重复发送原图；
- 低成本模型处理分类和摘要，高质量模型处理复杂讲解；
- 每次调用保存 `model_name`、`prompt_version`、`latency_ms`、`token_usage` 和 `confidence`；
- 不把未成年人的原图和可识别信息发送给未经审核的数据处理方；
- 默认关闭供应商训练使用，按供应商数据处理协议核验；
- 重要答案经过规则校验、计算器/符号工具或二次模型复核；
- 置信度不足时给用户确认选项，而不是伪装成确定答案。

### 变式题生成

MVP 不直接追求无限题库，采用“题型模板 + 变量约束 + 模型生成 + 校验”的方案：

1. 从原题提取题型、知识点、难度和变量。
2. 选择一个人工审核过的题型模板。
3. 让模型生成新变量和题干。
4. 让模型给出答案和步骤。
5. 使用 Python 计算器、SymPy 或规则校验答案一致性。
6. 通过重复度检查，避免只替换数字导致题目无效。
7. 低置信度或校验失败则丢弃，不展示给用户。

### 复习后 AI 复盘

试用版先实现一条轻量的复盘链路，验证 AI 是否能在“理解和复习”环节提供上传之外的价值：

1. 用户完成作答并选择掌握程度；
2. 前端先保存复习记录和下次复习时间；
3. 服务端把题干、原答案、正确答案、提示、关键步骤、历史便签、本次作答和复习感受发送给模型；
4. 模型只返回四项短文本：本次观察、可能卡点、下次先检查、便签建议；
5. 前端将结果保存到当前错题的 `reviewFeedback`，但不自动覆盖用户便签、分类或排期；
6. 模型失败时只显示降级提示，不回滚已经保存的复习记录。

该任务使用独立的日限额 `TRIAL_DAILY_FEEDBACK_LIMIT`，不占用图片分析次数。

## 九、数据库设计

### 核心表

| 表 | 关键字段 | 作用 |
|---|---|---|
| users | id, role, grade, consent_status, created_at | 用户与同意状态 |
| question_uploads | id, user_id, object_key, status, image_hash | 原图上传和处理状态 |
| questions | id, user_id, source_upload_id, stem, subject, grade, difficulty | 结构化错题 |
| question_answers | question_id, student_answer, correct_answer, solution | 答案与解析 |
| ocr_results | question_id, raw_text, blocks_json, confidence, engine | OCR 原始结果 |
| knowledge_tags | id, parent_id, subject, grade, name | 可版本化知识点树 |
| question_tags | question_id, tag_id, confidence, source | 错题与知识点关系 |
| error_analyses | question_id, error_code, explanation, confidence, model_meta | 错因分析 |
| variants | id, question_id, stem, answer, solution, validation_status | 变式题 |
| review_items | id, user_id, question_id, due_at, stability, difficulty, state | FSRS 复习卡片 |
| review_logs | id, review_item_id, rating, hint_count, duration_ms, reviewed_at | 复习行为 |
| exports | id, user_id, filter_json, object_key, status | PDF 导出任务 |
| ai_runs | id, user_id, task_type, model, prompt_version, tokens, cost, status | AI 调用审计和成本 |

### 数据生命周期

- 原始上传图默认保留 90 天，用户可立即删除；
- 结构化错题和复习记录由用户控制；
- 删除用户时删除对象存储、向量和异步任务中的关联数据；
- 日志只保留排障所需字段，不记录完整题目原文和答案；
- 备份加密，并设置恢复演练；
- 不把学生数据用于公开排行榜、广告定向或模型训练。

## 十、API 设计

### 认证与用户

```text
POST /api/v1/auth/guest
POST /api/v1/auth/email
GET  /api/v1/me
PATCH /api/v1/me/preferences
DELETE /api/v1/me
```

### 错题采集与分析

```text
POST /api/v1/uploads/presign
POST /api/v1/questions/from-upload
GET  /api/v1/questions?subject=math&tag_id=...
GET  /api/v1/questions/{id}
PATCH /api/v1/questions/{id}
DELETE /api/v1/questions/{id}
POST /api/v1/questions/{id}/reanalyze
```

### 讲解、变式和复习

```text
POST /api/v1/questions/{id}/explain
POST /api/v1/questions/{id}/variants
POST /api/v1/variants/{id}/submit
GET  /api/v1/reviews/today
POST /api/v1/reviews/{item_id}/log
GET  /api/v1/analytics/overview
```

### PDF

```text
POST /api/v1/exports/pdf
GET  /api/v1/exports/{id}
```

所有耗时任务返回 `job_id`，前端通过轮询或 SSE 获取状态。接口要有幂等键，避免用户重复点击造成重复 OCR 和重复扣费。

## 十一、前端页面与交互

### 页面结构

- 首页：今日待复习、最近错题、上传入口；
- 上传页：图片预览、识别进度、失败重试；
- 结果页：原图与结构化题目并排、可编辑字段、置信度标记；
- 讲解页：提示、知识点、步骤、答案分层展开；
- 错题库：筛选、搜索、批量归档和复习集合；
- 练习页：变式题作答、提交、批改和错因反馈；
- 数据页：复习完成率、知识点趋势和错误类型；
- 导出页：题目选择、答案开关和 PDF 状态。

### 关键体验原则

- 首次使用不强制填写大量个人信息；
- 上传后先给可编辑结果，再给 AI 结论；
- 默认展示提示而不是完整答案；
- 页面明确区分“识别结果”“AI 推断”和“用户确认”；
- 任何错误都能回退和人工修改；
- 移动端优先，桌面端适合批量整理和 PDF 导出。

## 十二、PDF 生成方案

1. 后端根据筛选条件生成 `export_job`。
2. 读取结构化错题，使用模板渲染 HTML。
3. 公式使用 KaTeX 转换为可打印 HTML 或 SVG。
4. 通过 Playwright Chromium 生成 A4 PDF。
5. 中文字体使用服务器已安装字体，并在测试环境固定版本。
6. 生成后检查页数、空白页、图片加载和字体回退。
7. PDF 上传对象存储，返回短期下载地址。

首版不支持复杂手写过程的矢量重排，手写部分直接保留裁剪图片，保证稳定性。

## 十三、安全与合规

这不是法律意见，上线前应让熟悉中国互联网、教育和个人信息保护的专业人士审核。

### 必须落实

- 明确产品是学习辅助工具，不承诺提分，不替代教师和家长判断；
- 在注册、上传和 AI 处理前提供隐私政策、用户协议和必要的同意机制；
- 中小学生属于未成年人用户，设计监护人同意、注销、删除和数据导出流程；
- 图片、作答过程、年级和学校信息按个人信息处理，最小化采集；
- 原图和 AI 请求使用 HTTPS、对象存储私有桶和短期签名 URL；
- 对模型供应商做数据出境、训练使用、日志保存和删除能力核验；
- 生成内容标注为 AI 辅助结果，并提供纠错入口；
- 建立敏感内容、危险指令和不适当回答的拦截策略；
- 对 AI 调用、人工修改、答案纠错和数据删除保留审计记录；
- 若面向公众提供生成式 AI 服务，评估备案、算法、内容安全和相关平台责任要求；
- 不接入广告定向，不把学生画像用于与学习无关的推荐。

### 主要风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| OCR 识别错 | 错题内容错误，后续分析全错 | 原图对照、置信度、用户确认、低置信度不自动入库 |
| AI 解题错 | 直接伤害学习效果和信任 | 工具校验、二次复核、来源/置信度提示、允许纠错 |
| 学生抄答案 | 产品变成搜题工具 | 分层提示、先作答后解析、记录提示次数 |
| 成本失控 | 用户越活跃亏损越多 | 任务分级模型、缓存、配额、按任务统计成本 |
| 未成年人数据泄露 | 严重合规和声誉风险 | 最小化采集、加密、删除、权限隔离、供应商审计 |
| 与头部平台同质化 | 获客困难 | 聚焦个人错题复习闭环、低干扰和可导出资产 |
| 变式题无效 | 用户不再信任练习 | 模板、约束、自动校验、人工抽检 |

## 十四、成本和开发排期

### MVP 开发排期

| 阶段 | 时间 | 交付 |
|---|---:|---|
| 产品验证 | 3-5 天 | 访谈提纲、落地页、数据指标和原型 |
| 基础骨架 | 第 1 周 | 登录、上传、对象存储、基础数据库和错题列表 |
| OCR 链路 | 第 2 周 | 图片处理、OCR、题目切分和可编辑结果 |
| AI 分析 | 第 3 周 | 知识点、错因、分层讲解和调用审计 |
| 复习闭环 | 第 4 周 | FSRS、今日任务、复习记录和学习曲线 |
| 变式/PDF | 第 5 周 | 变式生成校验、PDF 导出和批量操作 |
| 试点优化 | 第 6 周 | 20-50 名用户试用、修复高频错误、准备付费测试 |

### 低预算月成本假设

以下是工程预算区间，不是供应商报价承诺：

- 云服务器、数据库、对象存储：100-500 元；
- OCR：自部署 PaddleOCR 主要产生服务器成本，云 OCR 按调用量计费；
- 大模型：500-3000 元，取决于图片数量、模型和输出长度；
- 域名、监控、备份和日志：50-300 元；
- 合计：早期试点可控制在约 650-3800 元/月，不含人力和合规服务。

控制成本的关键不是一开始选最便宜模型，而是减少重复调用：图片哈希去重、OCR 结果缓存、分析结果缓存、结构化短输出、每日配额和失败重试上限。

## 十五、MVP 验收标准

### 功能验收

- 用户可在移动端上传一张包含多道数学题的图片；
- 系统能够切分题目，并让用户修改 OCR 结果；
- 每道题生成知识点、错因、分层讲解和置信度；
- 用户可以将题目加入复习计划，并完成一次复习记录；
- 用户可以生成至少一道经过校验的基础变式题；
- 用户可以导出包含原图、题干、知识点和解析的 PDF；
- 用户可以删除单题和全部个人数据。

### 质量验收

- 清晰印刷体数学题结构化成功率达到 90% 以上；
- 低置信度结果不自动进入“已掌握/待复习”结论；
- 核心接口错误率低于 1%；
- AI 任务失败可重试，且不会重复扣费；
- 首屏在移动端 3 秒内可交互；
- 试点期间每 100 道题至少抽检 20 道，记录 OCR 和解析错误类型。


## 十七、参考来源

以下来源于 2026-08-05 检索，竞品页面中的题库数量、准确率等属于产品方或媒体的公开宣传，应视为宣传口径，不等同于独立测评。

1. [小猿 AI 官方产品页](https://www.xiaoyuankousuan.com/)：拍照检查、错题本、错因分析、举一反三等功能。
2. [小猿 AI 官方产品页（备用入口）](https://kousuan.yuanfudao.com/)：产品能力、题库和学习闭环的公开介绍。
3. [产品分析：作业帮，在线教育赛道的夺魁热门？](https://www.woshipm.com/evaluating/3707171.html)：作业帮功能矩阵和错题本入口分析。
4. [拍照搜题，尚无答案](https://m.36kr.com/p/1212921641733768)：拍照搜题、在线讲题和错题收藏的行业观察。
5. [生成式人工智能服务管理暂行办法](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm)：中央网信办公开原文。
6. [国家网信办关于生成式人工智能服务备案信息的公告](https://www.cac.gov.cn/2026-05/13/c_1780413225190669.htm)：截至 2026 年公开的备案信息信号。
7. [中华人民共和国个人信息保护法](https://www.gov.cn/xinwen/2021-08/20/content_5632486.htm)：个人信息处理和保护基础依据。
8. [未成年人网络保护条例](https://www.gov.cn/zhengce/content/2023-10/24/content_6909413.htm)：未成年人网络服务和个人信息保护要求。
9. [PaddleOCR GitHub](https://github.com/PaddlePaddle/PaddleOCR)：OCR 和文档结构化识别技术基础。
10. [FSRS GitHub](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)：间隔重复调度算法参考。


### 技术实施备注

- 本方案优先采用可替换的 OCR、模型和对象存储适配器，避免早期绑定单一供应商。
- 所有 AI 结果都必须保留置信度、模型版本和人工纠错记录。
- 先完成中学数学清晰印刷体，再逐步扩展手写、几何图形和其他学科。
