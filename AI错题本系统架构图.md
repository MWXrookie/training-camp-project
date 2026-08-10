# AI 错题本系统架构图

版本：V1.1  
对应文档：[AI 错题本技术方案](AI错题本技术方案.md)

## 分阶段架构

### 三天受控试用版

```mermaid
flowchart TB
    USER[3-5 名受控成年测试者]
    WEB[Next.js Web\n首页 / 上传 / 确认 / 错题 / 复习 / 我的]
    ROUTE[Route Handler\n/api/trial/analyze]
    GUARD[访问口令 / 告知版本\n文件校验 / 限额 / 支出熔断]
    ADAPTER[Multimodal Model Adapter]
    SCHEMA[JSON Schema / 风险标志\n错误拦截]
    MODEL[经审核配置的多模态模型]
    IDB[(IndexedDB\n已确认题目 / 便签 / 复习记录)]
    FEEDBACK[复习后 AI 复盘\n本次观察 / 可能卡点 / 下次检查]

    USER --> WEB
    WEB -->|临时发送单题图片| ROUTE
    ROUTE --> GUARD
    GUARD --> ADAPTER
    ADAPTER --> MODEL
    MODEL --> ADAPTER
    ADAPTER --> SCHEMA
    SCHEMA -->|结构化候选| WEB
    WEB -->|用户确认后| IDB
    WEB -->|提交作答与自评| FEEDBACK
    FEEDBACK --> MODEL
    FEEDBACK -->|复盘结果，不覆盖用户便签| IDB
    IDB --> WEB
```

试用版服务端不保存原图和结构化题目。图片只在单次分析请求中临时处理；确认后的题目、便签和复习记录保存在浏览器本机。该架构仅用于验证体验，不对外承诺跨设备、备份、恢复、正式身份或未成年人数据权利能力。

### 架构升级路径

```mermaid
flowchart LR
    T[三天试用版\n单 Next.js + IndexedDB] --> G{体验验证门槛}
    G -->|不通过| R[调整核心体验后再测\n或停止投入]
    G -->|通过| S[完整 MVP 技术 Spike\n题型 / OCR / 模型 / 合规]
    S --> F[模块化单体\nNext.js + FastAPI + Worker]
    F --> P[5 人种子测试]
    P --> I[20-50 人邀请制试点]
```

试用版到完整 MVP 的稳定边界是：确认页字段 Schema、用户确认状态、个人便签、复习评分枚举和核心页面语言。临时访问口令、IndexedDB 数据层、同步模型请求和单供应商实现均可替换，不作为兼容承诺。

## 完整 MVP 总体架构

```mermaid
flowchart TB
    %% 用户端与接入层
    subgraph UX[用户端]
        WEB[Web / PWA]
        UPLOAD[上传与拍照]
        QUESTION_UI[错题库与题目详情]
        REVIEW_UI[今日复习与变式练习]
        REPORT_UI[学习曲线与 PDF 导出]
    end

    subgraph EDGE[接入与安全层]
        HTTPS[HTTPS / CORS]
        API[API Gateway\nREST API / SSE]
        AUTH[认证与权限\nGuest / Email / 家长同意]
        LIMIT[限流与幂等\n配额 / 防重复扣费]
    end

    %% 核心业务服务
    subgraph CORE[核心业务服务层]
        USER[用户与偏好服务]
        QS[错题服务\nQuestion Service]
        REVIEW[复习服务\nReview Service]
        VARIANT[变式练习服务\nVariant Service]
        ANALYTICS[学习分析服务\nAnalytics Service]
        EXPORT[导出服务\nExport Service]
    end

    %% 异步任务与 AI 编排
    subgraph ASYNC[异步任务层]
        QUEUE[Redis Queue\nCelery / Dramatiq]
        WORKER[任务 Worker\n重试 / 超时 / 死信]
    end

    subgraph AI[AI 与内容处理层]
        PREPROCESS[图像预处理\n方向 / 裁剪 / 去阴影 / 清晰度]
        OCR[OCR Adapter\nPaddleOCR / PP-Structure]
        OCR_FALLBACK[云 OCR 兜底\n复杂手写 / 公式场景]
        GATEWAY[Model Gateway\nQwen / DeepSeek / 兼容 API]
        CLASSIFY[题目结构化与知识点分类]
        EXPLAIN[错因分析与分层讲解]
        GENERATE[题型模板与变式生成]
        CHECK[答案与质量校验\n规则 / SymPy / 二次复核]
        CONFIDENCE[置信度与人工确认\n已确认 / 待确认 / 失败]
    end

    %% 数据与基础设施
    subgraph DATA[数据与基础设施层]
        PG[(PostgreSQL\n用户 / 错题 / 标签 / 复习记录)]
        VECTOR[(pgvector\n题目与知识点检索)]
        REDIS[(Redis\n缓存 / 队列 / 限流)]
        OBJECT[(S3 对象存储\n原图 / 裁剪图 / PDF)]
        FSRS[FSRS Scheduler\n间隔重复算法]
        PDF[PDF Renderer\nHTML/CSS + Playwright]
    end

    %% 安全、审计与运维
    subgraph OPS[安全与运维]
        AUDIT[AI 调用审计\n模型 / Prompt / Token / 成本]
        LOG[日志与监控\n错误 / 延迟 / 队列积压]
        BACKUP[加密备份与生命周期\n删除 / 恢复演练]
        SECRETS[密钥管理\n模型与存储凭证]
    end

    %% 用户访问链路
    WEB --> UPLOAD
    WEB --> QUESTION_UI
    WEB --> REVIEW_UI
    WEB --> REPORT_UI
    UPLOAD --> HTTPS
    QUESTION_UI --> HTTPS
    REVIEW_UI --> HTTPS
    REPORT_UI --> HTTPS
    HTTPS --> API
    API --> AUTH
    AUTH --> LIMIT
    LIMIT --> USER
    LIMIT --> QS
    LIMIT --> REVIEW
    LIMIT --> VARIANT
    LIMIT --> ANALYTICS
    LIMIT --> EXPORT

    %% 题目处理异步链路
    QS -->|上传任务| QUEUE
    QUEUE --> WORKER
    WORKER --> PREPROCESS
    PREPROCESS --> OCR
    OCR -. 低置信度或复杂场景 .-> OCR_FALLBACK
    OCR --> GATEWAY
    OCR_FALLBACK --> GATEWAY
    GATEWAY --> CLASSIFY
    GATEWAY --> EXPLAIN
    CLASSIFY --> CONFIDENCE
    EXPLAIN --> CHECK
    CHECK --> CONFIDENCE
    CONFIDENCE -->|通过或用户确认| QS
    CONFIDENCE -->|失败重试| QUEUE

    %% 变式题链路
    VARIANT --> GENERATE
    GENERATE --> GATEWAY
    GENERATE --> CHECK
    CHECK -->|校验通过| VARIANT
    CHECK -->|校验失败| QUEUE

    %% 复习与分析链路
    REVIEW --> FSRS
    FSRS --> REVIEW
    REVIEW --> ANALYTICS
    ANALYTICS --> REPORT_UI

    %% 导出链路
    EXPORT --> PDF
    PDF --> OBJECT

    %% 数据持久化
    USER <--> PG
    QS <--> PG
    REVIEW <--> PG
    VARIANT <--> PG
    ANALYTICS --> PG
    PG <--> VECTOR
    QS <--> OBJECT
    PREPROCESS --> OBJECT
    QUEUE <--> REDIS
    LIMIT <--> REDIS

    %% 审计与运维
    GATEWAY --> AUDIT
    CLASSIFY --> AUDIT
    EXPLAIN --> AUDIT
    GENERATE --> AUDIT
    API --> LOG
    WORKER --> LOG
    PG --> BACKUP
    OBJECT --> BACKUP
    SECRETS -. 注入凭证 .-> API
    SECRETS -. 注入凭证 .-> WORKER

    classDef client fill:#E8F1FF,stroke:#3B82F6,color:#0F172A
    classDef edge fill:#F1F5F9,stroke:#64748B,color:#0F172A
    classDef core fill:#E9F8F0,stroke:#16A34A,color:#0F172A
    classDef async fill:#FFF7E6,stroke:#D97706,color:#0F172A
    classDef ai fill:#F3EEFF,stroke:#7C3AED,color:#0F172A
    classDef data fill:#FFF1F2,stroke:#E11D48,color:#0F172A
    classDef ops fill:#F8FAFC,stroke:#475569,color:#0F172A

    class WEB,UPLOAD,QUESTION_UI,REVIEW_UI,REPORT_UI client
    class HTTPS,API,AUTH,LIMIT edge
    class USER,QS,REVIEW,VARIANT,ANALYTICS,EXPORT core
    class QUEUE,WORKER async
    class PREPROCESS,OCR,OCR_FALLBACK,GATEWAY,CLASSIFY,EXPLAIN,GENERATE,CHECK,CONFIDENCE ai
    class PG,VECTOR,REDIS,OBJECT,FSRS,PDF data
    class AUDIT,LOG,BACKUP,SECRETS ops
```

## 图例与阅读方式

| 标识 | 含义 |
|---|---|
| 蓝色 | 用户端页面和交互入口 |
| 灰色 | HTTP 接入、认证、限流和幂等控制 |
| 绿色 | 面向业务的领域服务 |
| 黄色 | 异步任务、重试和后台 Worker |
| 紫色 | OCR、模型调用、分析、生成和质量校验 |
| 红色 | 数据库、对象存储、缓存、算法调度和 PDF 渲染 |
| 浅灰 | 安全、审计、监控、备份和密钥管理 |
| 实线箭头 | 主要数据或控制流 |
| 虚线箭头 | 兜底、失败重试或基础设施辅助关系 |

## 与技术方案的对应关系

### 上传与错题结构化

`Web/PWA -> API Gateway -> 错题服务 -> Redis Queue -> Worker -> 图像预处理 -> OCR -> Model Gateway -> 结构化/错因分析 -> 置信度确认 -> PostgreSQL`。

原图、裁剪图和处理结果放在对象存储中，数据库只保存对象键、结构化字段和处理状态。这样可以避免数据库保存大文件，也能支持原图回看和生命周期删除。

### AI 调用与质量控制

所有模型调用经过 `Model Gateway`，业务服务不直接依赖某一家模型厂商。题目分类、错因分析、分层讲解和变式生成使用不同任务模板，并由 `AI 调用审计`记录模型、Prompt 版本、Token、延迟和成本。

`答案与质量校验`负责检查字段完整性、数学表达式、答案一致性和变式题有效性。低置信度结果进入“待确认”状态，不直接作为最终答案展示。

### 复习与学习曲线

复习服务读取题目掌握状态，交给 `FSRS Scheduler`计算下一次复习时间。每次复习结果、提示次数、耗时和自评写入复习记录，再由学习分析服务生成今日任务、知识点趋势和错误类型统计。

### 变式题与 PDF

变式题采用“题型模板 -> 模型生成 -> 答案校验 -> 通过后入库”的链路；校验失败的题目进入重试队列或直接丢弃。PDF 导出由导出服务创建异步任务，使用 HTML/CSS 和 Playwright 渲染，最终文件写入对象存储。

## MVP 实现边界

首版只需要实现以下主链路：

1. Web/PWA 上传图片。
2. 中学数学清晰印刷体 OCR 和题目切分。
3. 结构化题目、知识点、错因和分层讲解。
4. 用户确认后保存错题。
5. FSRS 今日复习和复习记录。
6. 一道经过校验的基础变式题。
7. 选择错题导出 PDF。

以下能力可以延后：复杂手写识别、几何图形自动理解、多学科题库、独立向量数据库、实时协作和教师班级管理。
