# Recall AI 试用版 API 规格

版本：V0.1  
日期：2026-08-10  
范围：三天受控试用版本地服务端接口。

## 1. 基线

试用版采用本地 Node 服务 `server.mjs` 同时承载静态页面和最小 API。模型 Key 只从服务端环境变量读取，不进入浏览器代码、IndexedDB、导出数据或前端日志。

本地启动：

```powershell
node .\server.mjs
```

如果 4173 已被占用，可指定端口：

```powershell
$env:PORT='4174'; node .\server.mjs
```

## 2. 环境变量

```env
DASHSCOPE_API_KEY=your_key
QWEN_MODEL=qwen-vl-max
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DEEPSEEK_API_KEY=your_deepseek_key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
TRIAL_DAILY_ANALYSIS_LIMIT=50
TRIAL_DAILY_FEEDBACK_LIMIT=50
TRIAL_DAILY_EXPLANATION_LIMIT=50
TRIAL_QWEN_VISION_TIMEOUT_MS=75000
TRIAL_QWEN_VISION_MAX_TOKENS=900
TRIAL_QWEN_VISION_FALLBACK_TIMEOUT_MS=45000
TRIAL_QWEN_VISION_FALLBACK_MAX_TOKENS=520
TRIAL_QWEN_FEEDBACK_TIMEOUT_MS=30000
TRIAL_QWEN_FEEDBACK_MAX_TOKENS=650
TRIAL_DEEPSEEK_FEEDBACK_TIMEOUT_MS=30000
TRIAL_DEEPSEEK_FEEDBACK_MAX_TOKENS=650
TRIAL_DEEPSEEK_EXPLANATION_TIMEOUT_MS=45000
TRIAL_DEEPSEEK_EXPLANATION_MAX_TOKENS=900
```

`.env.local` 必须留在本机，已由 `.gitignore` 忽略。

视觉分析默认先用标准结构化请求；如果模型超时，会自动切到轻量草稿模式重试一次。轻量模式优先返回可供用户核对的题干草稿，允许 `correct_answer` 为 `null`、完整解析为空，避免真实题图因为长解析生成超时而无法入库。

## 3. 健康检查

```text
GET /api/trial/health
```

返回示例：

```json
{
  "ok": true,
  "model_configured": true,
  "model": "qwen-vl-plus",
  "text_model_configured": true,
  "text_model": "deepseek-chat",
  "text_base_url_configured": true,
  "base_url_configured": true,
  "trial_limits": {
    "analysis": { "limit": 50, "used": 0, "remaining": 50 },
    "review_feedback": { "limit": 50, "used": 0, "remaining": 50 },
    "explanation": { "limit": 50, "used": 0, "remaining": 50 }
  }
}
```

该接口只显示配置是否存在，不返回密钥值。

## 4. 图片分析

```text
POST /api/trial/analyze
Content-Type: multipart/form-data

image: JPG/PNG/WEBP，最大 6MB
consent_version: trial_notice_v0.1
```

成功返回：

```json
{
  "data": {
    "stem": "3x + 4 = 19，求 x。",
    "student_answer": "x = 4",
    "correct_answer": "x = 5",
    "knowledge_tags": ["一元一次方程"],
    "error_type": "calculation_error",
    "explanation": {
      "hint": "先把常数项移到等号右边。",
      "key_steps": ["3x = 15", "x = 5"],
      "full_solution": "移项后除以 3，得到 x = 5。"
    },
    "risk_flags": []
  },
  "request_id": "trial_req_xxx"
}
```

错误返回：

```json
{
  "error": {
    "code": "model_failed",
    "message": "模型分析失败，请重试或手动填写。",
    "details": {}
  },
  "request_id": "trial_req_xxx"
}
```

错误码稳定为：

- `validation_failed`
- `consent_required`
- `rate_limited`
- `model_failed`
- `schema_failed`
- `not_question`：图片中没有可识别的中学数学错题；本次前端试用额度不扣除。

## 5. 复习后 AI 复盘

```text
POST /api/trial/review-feedback
Content-Type: application/json
```

请求只发送当前错题的必要结构化信息和用户本次复习输入，不发送原图：

```json
{
  "consent_version": "trial_notice_v0.1",
  "question": {
    "stem": "题干",
    "student_answer": "学生原答案",
    "correct_answer": "正确答案",
    "hint": "提示",
    "key_steps": ["关键步骤"],
    "prior_note": "此前便签"
  },
  "review": {
    "answer": "本次作答",
    "note": "本次复习感受",
    "rating": "again|hard|good|easy"
  }
}
```

成功返回：

```json
{
  "data": {
    "summary": "这次复习最值得注意的地方",
    "likely_gap": "基于本次作答推测的可能卡点",
    "next_check": "下一次做题前先检查的一件事",
    "note_suggestion": "可以补进个人便签的提醒"
  },
  "request_id": "trial_req_xxx"
}
```

复盘使用独立的 `TRIAL_DAILY_FEEDBACK_LIMIT`，学习解析使用独立的 `TRIAL_DAILY_EXPLANATION_LIMIT`，二者都不占用图片分析的每日次数。复盘或学习解析失败时，错题与复习记录仍然保留，前端展示可理解的降级提示。

复盘和学习解析模型调用会限制输出长度，并在模型返回非 JSON 或服务端 5xx 时自动重试一次严格 JSON prompt，减少“记录已保存但 AI 结果偶发缺失”的体验问题。

## 6. 确认后 AI 学习解析

```text
POST /api/trial/explanation
Content-Type: application/json
```

该接口只在用户确认入库后调用，使用 DeepSeek 文本模型。请求只包含已确认的题干、学生答案、正确答案、千问初步提示/步骤和用户便签，不发送原图，也不在确认前调用。

成功返回：

```json
{
  "data": {
    "reference": {
      "hint": "先确认除式，再逐项相除。",
      "key_steps": ["计算除式", "被除式每一项分别相除"],
      "full_solution": "标准参考解析"
    },
    "what_it_tests": "本题考查的核心能力",
    "your_gap": "结合学生答案和便签判断的可能差距",
    "worked_example": "围绕关键转折的简短步骤讲解",
    "next_check": "下一次做题前先检查什么",
    "note_suggestion": "适合写进个人便签的一句话"
  },
  "request_id": "trial_req_xxx"
}
```

其中 `reference` 是标准参考层，供详情页和复习页的“分层解析”折叠展示；其余五个字段是结合用户答案和便签生成的个性化学习解析。两者职责不同，避免把标准答案重复塞进个性化卡片。

DeepSeek 只接收确认后的结构化学习数据；图片识别仍使用千问视觉模型。前端会在详情页突出显示个性化解析，并保留重新生成入口。

## 7. 安全与边界

- 服务端不持久化上传图片。
- 服务端不记录请求体、题干、答案和 Key。
- 经用户明确授权后，确认后的结构化学习数据会发送给 DeepSeek，用于学习解析、复习复盘和个性化建议；原图只发送给千问视觉模型。
- 模型返回内容先清洗，再按试用版 Schema 校验。
- 非题目、非目标学科或裁剪区域没有题目时返回 `not_question`；前后端都会退回本次试用额度。
- 前端收到成功结果后只生成待确认草稿；用户确认前不进入正式错题库。
- 自动测试通过接口拦截模拟分析成功和失败分支，不消耗千问调用；用户界面不提供内置示例题。
- 复习后 AI 复盘不改变复习排期，也不自动覆盖用户便签；用户确认有用后再自行改写。
