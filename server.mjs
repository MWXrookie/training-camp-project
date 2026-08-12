import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const WEB_DIR = join(ROOT_DIR, "web");
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 512 * 1024;
const MAX_FEEDBACK_REQUEST_BYTES = 128 * 1024;
const MAX_EXPLANATION_REQUEST_BYTES = 128 * 1024;
const CONSENT_VERSION = "trial_notice_v0.1";
const DEFAULT_VISION_TIMEOUT_MS = 75_000;
const FALLBACK_VISION_TIMEOUT_MS = 45_000;
const DEFAULT_FEEDBACK_TIMEOUT_MS = 30_000;
const DEFAULT_EXPLANATION_TIMEOUT_MS = 45_000;
const ERROR_CODES = new Set([
  "validation_failed",
  "consent_required",
  "rate_limited",
  "model_failed",
  "schema_failed",
  "not_question",
  "multiple_questions"
]);
const ERROR_TYPES = new Set([
  "sign_error",
  "concept_gap",
  "calculation_error",
  "reading_error",
  "missing_steps",
  "insufficient_information"
]);
const RISK_FLAGS = new Set([
  "low_image_quality",
  "formula_uncertain",
  "student_answer_missing",
  "answer_uncertain",
  "unsupported_question_type"
]);
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_BY_EXT = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

loadEnvFile(join(ROOT_DIR, ".env.local"));
loadEnvFile(join(ROOT_DIR, ".env"));

let serverDailyUsage = {
  date: todayKey(),
  count: 0
};
let serverFeedbackUsage = {
  date: todayKey(),
  count: 0
};
let serverExplanationUsage = {
  date: todayKey(),
  count: 0
};

export function createTrialServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/api/trial/health") {
        const analysisUsage = currentServerUsage();
        const feedbackUsage = currentServerFeedbackUsage();
        const explanationUsage = currentServerExplanationUsage();
        const analysisLimit = trialDailyAnalysisLimit();
        const feedbackLimit = trialDailyFeedbackLimit();
        const explanationLimit = trialDailyExplanationLimit();
        sendJson(res, 200, {
          ok: true,
          model_configured: Boolean(process.env.DASHSCOPE_API_KEY),
          model: process.env.QWEN_MODEL || "qwen-vl-plus",
          base_url_configured: Boolean(process.env.QWEN_BASE_URL),
          text_model_configured: Boolean(process.env.DEEPSEEK_API_KEY),
          text_model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
          text_base_url_configured: Boolean(process.env.DEEPSEEK_BASE_URL),
          trial_limits: {
            analysis: {
              limit: analysisLimit,
              used: analysisUsage.count,
              remaining: Math.max(0, analysisLimit - analysisUsage.count)
            },
            review_feedback: {
              limit: feedbackLimit,
              used: feedbackUsage.count,
              remaining: Math.max(0, feedbackLimit - feedbackUsage.count)
            },
            explanation: {
              limit: explanationLimit,
              used: explanationUsage.count,
              remaining: Math.max(0, explanationLimit - explanationUsage.count)
            }
          }
        });
        return;
      }

      if (req.method === "POST" && req.url === "/api/trial/analyze") {
        const result = await handleTrialAnalyze(req);
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method === "POST" && req.url === "/api/trial/review-feedback") {
        const result = await handleTrialReviewFeedback(req);
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method === "POST" && req.url === "/api/trial/explanation") {
        const result = await handleTrialExplanation(req);
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res);
        return;
      }

      sendJson(res, 405, errorResponse("validation_failed", "不支持的请求方法。", { method: req.method }));
    } catch (error) {
      sendJson(res, 500, errorResponse("model_failed", "分析服务暂时不可用，请稍后重试。", { stage: "server" }));
    }
  });
}

export async function handleTrialAnalyze(req) {
  if (process.env.TRIAL_AI_DISABLED === "true") {
    return {
      status: 503,
      body: errorResponse("model_failed", "真实模型分析已被服务端停用。", { stage: "disabled" })
    };
  }

  const config = readModelConfig();
  if (!config.ok) {
    return {
      status: 500,
      body: errorResponse("model_failed", "模型配置缺失，请检查本机环境变量。", { missing: config.missing })
    };
  }

  const usage = currentServerUsage();
  const limit = trialDailyAnalysisLimit();
  if (usage.count >= limit) {
    return {
      status: 429,
      body: errorResponse("rate_limited", `服务端今日真实分析次数已达 ${limit} 次。`, { limit })
    };
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      status: 400,
      body: errorResponse("validation_failed", "请使用 multipart/form-data 上传图片。", { field: "content-type" })
    };
  }

  const boundary = boundaryFromContentType(contentType);
  if (!boundary) {
    return {
      status: 400,
      body: errorResponse("validation_failed", "上传请求缺少 multipart boundary。", { field: "boundary" })
    };
  }

  const body = await readRequestBody(req, MAX_REQUEST_BYTES);
  const parts = parseMultipart(body, boundary);
  const image = parts.find((part) => part.name === "image" && part.filename);
  const consent = parts.find((part) => part.name === "consent_version");
  if (!consent || consent.data.toString("utf8").trim() !== CONSENT_VERSION) {
    return {
      status: 403,
      body: errorResponse("consent_required", "请先完成本次试用的图片处理告知。", { required: CONSENT_VERSION })
    };
  }
  const imageValidation = validateImagePart(image);
  if (!imageValidation.ok) {
    return {
      status: 400,
      body: errorResponse("validation_failed", imageValidation.message, imageValidation.details)
    };
  }

  if (looksLikePageScan(image.data)) {
    return {
      status: 200,
      body: {
        error: {
          code: "multiple_questions",
          message: "检测到这是一张可能包含多道题的整页作业，请先裁剪为一道题。",
          details: { reason: "page_scan_multiple_candidates", quota_consumed: false }
        },
        request_id: newRequestId()
      }
    };
  }

  usage.count += 1;
  const dataUrl = `data:${imageValidation.contentType};base64,${image.data.toString("base64")}`;
  const modelResult = await callQwenVision({
    ...config,
    imageDataUrl: dataUrl,
    fileName: image.filename
  });

  if (!modelResult.ok) {
    usage.count = Math.max(0, usage.count - 1);
    const errorCode = modelResult.code === "schema_failed" ? "schema_failed" : "model_failed";
    return {
      status: 502,
      body: errorResponse(errorCode, modelResult.message, modelResult.details)
    };
  }

  const normalizedPayload = normalizeTrialModelPayload(modelResult.payload);
  const validation = validateTrialAnalysisResponse(normalizedPayload);
  if (!validation.ok) {
    usage.count = Math.max(0, usage.count - 1);
    return {
      status: 502,
      body: errorResponse("schema_failed", "模型返回结构不稳定，请重试或手动填写。", {
        request_id: modelResult.requestId,
        details: validation.details
      })
    };
  }

  if (validation.value.error) {
    usage.count = Math.max(0, usage.count - 1);
    return {
      status: 200,
      body: validation.value
    };
  }

  return {
    status: 200,
    body: validation.value
  };
}

export async function handleTrialReviewFeedback(req) {
  if (process.env.TRIAL_AI_DISABLED === "true") {
    return {
      status: 503,
      body: errorResponse("model_failed", "真实模型分析已被服务端停用。", { stage: "disabled" })
    };
  }

  const config = readTextModelConfig();
  if (!config.ok) {
    return {
      status: 500,
      body: errorResponse("model_failed", "模型配置缺失，请检查本机环境变量。", { missing: config.missing })
    };
  }

  const usage = currentServerFeedbackUsage();
  const limit = trialDailyFeedbackLimit();
  if (usage.count >= limit) {
    return {
      status: 429,
      body: errorResponse("rate_limited", `服务端今日复盘次数已达 ${limit} 次。`, { limit })
    };
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("application/json")) {
    return {
      status: 400,
      body: errorResponse("validation_failed", "复盘请求必须使用 application/json。", { field: "content-type" })
    };
  }

  let payload;
  try {
    payload = JSON.parse((await readRequestBody(req, MAX_FEEDBACK_REQUEST_BYTES)).toString("utf8"));
  } catch {
    return {
      status: 400,
      body: errorResponse("validation_failed", "复盘请求格式不正确。", { field: "body" })
    };
  }

  const inputValidation = validateReviewFeedbackInput(payload);
  if (!inputValidation.ok) {
    return {
      status: 400,
      body: errorResponse("validation_failed", "复盘信息不完整，请先提交本次作答。", { details: inputValidation.details })
    };
  }

  usage.count += 1;
  const modelResult = await callDeepSeekReviewFeedback({
    ...config,
    input: inputValidation.value
  });
  if (!modelResult.ok) {
    usage.count = Math.max(0, usage.count - 1);
    return {
      status: 502,
      body: errorResponse("model_failed", modelResult.message, modelResult.details)
    };
  }

  const validation = validateReviewFeedbackResponse(modelResult.payload);
  if (!validation.ok) {
    usage.count = Math.max(0, usage.count - 1);
    return {
      status: 502,
      body: errorResponse("schema_failed", "AI 复盘结果暂时不可用，本次复习已经保存。", {
        request_id: modelResult.requestId,
        details: validation.details
      })
    };
  }

  return {
    status: 200,
    body: validation.value
  };
}

export async function handleTrialExplanation(req) {
  if (process.env.TRIAL_AI_DISABLED === "true") {
    return { status: 503, body: errorResponse("model_failed", "真实模型分析已被服务端停用。", { stage: "disabled" }) };
  }
  const config = readTextModelConfig();
  if (!config.ok) {
    return {
      status: 503,
      body: errorResponse("model_failed", "DeepSeek 文本模型尚未配置，请补充服务端配置后重试。", { missing: config.missing, stage: "text_model_config" })
    };
  }
  const usage = currentServerExplanationUsage();
  const limit = trialDailyExplanationLimit();
  if (usage.count >= limit) {
    return { status: 429, body: errorResponse("rate_limited", `服务端今日 AI 学习解析次数已达 ${limit} 次。`, { limit }) };
  }
  if (!(req.headers["content-type"] || "").includes("application/json")) {
    return { status: 400, body: errorResponse("validation_failed", "学习解析请求必须使用 application/json。", { field: "content-type" }) };
  }
  let payload;
  try {
    payload = JSON.parse((await readRequestBody(req, MAX_EXPLANATION_REQUEST_BYTES)).toString("utf8"));
  } catch {
    return { status: 400, body: errorResponse("validation_failed", "学习解析请求格式不正确。", { field: "body" }) };
  }
  const inputValidation = validateExplanationInput(payload);
  if (!inputValidation.ok) {
    return { status: 400, body: errorResponse("validation_failed", "确认后的错题信息不完整，无法生成学习解析。", { details: inputValidation.details }) };
  }
  usage.count += 1;
  const modelResult = await callDeepSeekExplanation({ ...config, input: inputValidation.value });
  if (!modelResult.ok) {
    usage.count = Math.max(0, usage.count - 1);
    return { status: 502, body: errorResponse(modelResult.code || "model_failed", modelResult.message, modelResult.details) };
  }
  const validation = validateExplanationResponse(modelResult.payload);
  if (!validation.ok) {
    usage.count = Math.max(0, usage.count - 1);
    return { status: 502, body: errorResponse("schema_failed", "DeepSeek 返回的学习解析格式不稳定，请稍后重试。", { request_id: modelResult.requestId, details: validation.details }) };
  }
  return { status: 200, body: validation.value };
}

export function validateExplanationInput(raw) {
  const details = [];
  if (!isPlainObject(raw)) return { ok: false, details: ["顶层请求不是对象"] };
  if (raw.consent_version !== CONSENT_VERSION) details.push("consent_version 不匹配");
  if (!isPlainObject(raw.question)) details.push("question 不是对象");
  const question = raw.question || {};
  const bounded = (value, field, limit, required = false) => {
    if (typeof value !== "string") {
      if (required) details.push(`${field} 不是字符串`);
      return "";
    }
    const text = value.trim();
    if (required && !text) details.push(`${field} 不能为空`);
    if (text.length > limit) details.push(`${field} 过长`);
    return text.slice(0, limit);
  };
  const nullable = (value, field, limit) => value == null ? null : bounded(value, field, limit);
  const value = {
    question: {
      stem: bounded(question.stem, "question.stem", 5000, true),
      student_answer: nullable(question.student_answer, "question.student_answer", 2500),
      correct_answer: nullable(question.correct_answer, "question.correct_answer", 2500),
      hint: bounded(question.hint, "question.hint", 1200),
      key_steps: normalizeStringArray(question.key_steps, 12).map((item) => item.slice(0, 600)),
      prior_note: bounded(question.prior_note, "question.prior_note", 2500)
    }
  };
  return details.length ? { ok: false, details } : { ok: true, value };
}

export function validateExplanationResponse(raw) {
  const details = [];
  if (!isPlainObject(raw)) return { ok: false, details: ["顶层结果不是对象"] };
  if (hasUnexpectedKeys(raw, new Set(["data", "request_id"]))) details.push("顶层包含未知字段");
  if (!isNonEmptyString(raw.request_id)) details.push("request_id 不能为空");
  if (!isPlainObject(raw.data)) {
    details.push("data 不是对象");
    return { ok: false, details };
  }
  const fields = ["what_it_tests", "your_gap", "worked_example", "next_check", "note_suggestion"];
  if (hasUnexpectedKeys(raw.data, new Set([...fields, "reference"]))) details.push("data 存在未知字段");
  for (const field of fields) {
    if (!isNonEmptyString(raw.data[field])) details.push(`${field} 不能为空`);
    if (typeof raw.data[field] === "string" && raw.data[field].length > 1500) details.push(`${field} 过长`);
  }
  if (!isPlainObject(raw.data.reference)) {
    details.push("data.reference 不是对象");
  } else {
    if (hasUnexpectedKeys(raw.data.reference, new Set(["hint", "key_steps", "full_solution"]))) details.push("data.reference 存在未知字段");
    if (!isNonEmptyString(raw.data.reference.hint)) details.push("data.reference.hint 不能为空");
    if (!Array.isArray(raw.data.reference.key_steps) || raw.data.reference.key_steps.length > 12 || raw.data.reference.key_steps.some((item) => !isNonEmptyString(item))) {
      details.push("data.reference.key_steps 不合法");
    }
    if (!isNonEmptyString(raw.data.reference.full_solution)) details.push("data.reference.full_solution 不能为空");
  }
  if (details.length) return { ok: false, details };
  return {
    ok: true,
    value: {
      data: {
        ...Object.fromEntries(fields.map((field) => [field, raw.data[field].trim()])),
        reference: {
          hint: raw.data.reference.hint.trim(),
          key_steps: raw.data.reference.key_steps.map((item) => item.trim()).filter(Boolean),
          full_solution: raw.data.reference.full_solution.trim()
        }
      },
      request_id: raw.request_id.trim()
    }
  };
}

export function validateReviewFeedbackInput(raw) {
  const details = [];
  if (!isPlainObject(raw)) {
    return { ok: false, details: ["顶层请求不是对象"] };
  }
  if (raw.consent_version !== CONSENT_VERSION) details.push("consent_version 不匹配");
  if (!isPlainObject(raw.question)) details.push("question 不是对象");
  if (!isPlainObject(raw.review)) details.push("review 不是对象");

  const question = raw.question || {};
  const review = raw.review || {};
  const boundedString = (value, field, limit, required = false) => {
    if (typeof value !== "string") {
      if (required) details.push(`${field} 不是字符串`);
      return "";
    }
    const text = value.trim();
    if (required && !text) details.push(`${field} 不能为空`);
    if (text.length > limit) details.push(`${field} 过长`);
    return text.slice(0, limit);
  };
  const nullableBoundedString = (value, field, limit) => {
    if (value === null || value === undefined) return null;
    return boundedString(value, field, limit);
  };

  const value = {
    question: {
      stem: boundedString(question.stem, "question.stem", 4000, true),
      student_answer: nullableBoundedString(question.student_answer, "question.student_answer", 2000),
      correct_answer: nullableBoundedString(question.correct_answer, "question.correct_answer", 2000),
      hint: boundedString(question.hint, "question.hint", 1000),
      key_steps: normalizeStringArray(question.key_steps, 12).map((item) => item.slice(0, 500)),
      prior_note: boundedString(question.prior_note, "question.prior_note", 2000)
    },
    review: {
      answer: boundedString(review.answer, "review.answer", 3000),
      note: boundedString(review.note, "review.note", 2000),
      rating: boundedString(review.rating, "review.rating", 20, true)
    }
  };
  if (!["again", "hard", "good", "easy"].includes(value.review.rating)) {
    details.push("review.rating 不合法");
  }
  if (!value.review.answer && !value.review.note) {
    details.push("本次作答和复习感受不能同时为空");
  }
  return details.length ? { ok: false, details } : { ok: true, value };
}

export function validateReviewFeedbackResponse(raw) {
  const details = [];
  if (!isPlainObject(raw)) return { ok: false, details: ["顶层结果不是对象"] };
  if (hasUnexpectedKeys(raw, new Set(["data", "request_id"]))) details.push("顶层包含未知字段");
  if (!isNonEmptyString(raw.request_id)) details.push("request_id 不能为空");
  if (!isPlainObject(raw.data)) {
    details.push("data 不是对象");
    return { ok: false, details };
  }
  if (hasUnexpectedKeys(raw.data, new Set(["summary", "likely_gap", "next_check", "note_suggestion"]))) {
    details.push("data 存在未知字段");
  }
  for (const field of ["summary", "likely_gap", "next_check", "note_suggestion"]) {
    if (!isNonEmptyString(raw.data[field])) details.push(`${field} 不能为空`);
    if (typeof raw.data[field] === "string" && raw.data[field].length > 1000) details.push(`${field} 过长`);
  }
  if (details.length) return { ok: false, details };
  return {
    ok: true,
    value: {
      data: {
        summary: raw.data.summary.trim(),
        likely_gap: raw.data.likely_gap.trim(),
        next_check: raw.data.next_check.trim(),
        note_suggestion: raw.data.note_suggestion.trim()
      },
      request_id: raw.request_id.trim()
    }
  };
}

export function validateTrialAnalysisResponse(raw) {
  const details = [];
  if (!isPlainObject(raw)) {
    return { ok: false, details: ["顶层结果不是对象"] };
  }
  if (Object.hasOwn(raw, "error")) {
    if (hasUnexpectedKeys(raw, new Set(["error", "request_id"]))) details.push("顶层包含未知字段");
    if (!isPlainObject(raw.error)) details.push("error 不是对象");
    if (isPlainObject(raw.error)) {
      if (!ERROR_CODES.has(raw.error.code)) details.push("error.code 不在允许范围");
      if (!isNonEmptyString(raw.error.message)) details.push("error.message 为空");
      if (!isPlainObject(raw.error.details)) details.push("error.details 不合法");
    }
    if (!isNonEmptyString(raw.request_id)) details.push("request_id 为空");
    return details.length ? { ok: false, details } : { ok: true, value: raw };
  }

  if (hasUnexpectedKeys(raw, new Set(["data", "request_id"]))) details.push("顶层包含未知字段");
  if (!isNonEmptyString(raw.request_id)) details.push("request_id 不能为空");
  if (!isPlainObject(raw.data)) {
    details.push("data 不是对象");
    return { ok: false, details };
  }

  const data = raw.data;
  if (hasUnexpectedKeys(data, new Set(["stem", "student_answer", "correct_answer", "knowledge_tags", "error_type", "explanation", "risk_flags"]))) {
    details.push("data 存在未知字段");
  }
  if (!isNonEmptyString(data.stem)) details.push("stem 不能为空");
  if (!isNullableString(data.student_answer)) details.push("student_answer 类型不合法");
  if (!isNullableString(data.correct_answer)) details.push("correct_answer 类型不合法");
  if (!Array.isArray(data.knowledge_tags) || data.knowledge_tags.length > 3 || data.knowledge_tags.some((item) => !isNonEmptyString(item))) {
    details.push("knowledge_tags 不合法");
  }
  if (!ERROR_TYPES.has(data.error_type)) details.push("error_type 不合法");
  if (!isPlainObject(data.explanation)) {
    details.push("explanation 不是对象");
  } else {
    if (hasUnexpectedKeys(data.explanation, new Set(["hint", "key_steps", "full_solution"]))) details.push("explanation 存在未知字段");
    if (typeof data.explanation.hint !== "string") details.push("explanation.hint 不合法");
    if (!Array.isArray(data.explanation.key_steps) || data.explanation.key_steps.some((item) => typeof item !== "string")) {
      details.push("explanation.key_steps 不合法");
    }
    if (typeof data.explanation.full_solution !== "string") details.push("explanation.full_solution 不合法");
  }
  if (!Array.isArray(data.risk_flags) || data.risk_flags.some((item) => !RISK_FLAGS.has(item))) {
    details.push("risk_flags 不合法");
  }

  if (details.length) return { ok: false, details };
  return {
    ok: true,
    value: {
      data: {
        stem: data.stem.trim(),
        student_answer: nullableTrim(data.student_answer),
        correct_answer: nullableTrim(data.correct_answer),
        knowledge_tags: data.knowledge_tags.map((item) => item.trim()).slice(0, 3),
        error_type: data.error_type,
        explanation: {
          hint: data.explanation.hint.trim(),
          key_steps: data.explanation.key_steps.map((item) => item.trim()).filter(Boolean),
          full_solution: data.explanation.full_solution.trim()
        },
        risk_flags: [...new Set(data.risk_flags)]
      },
      request_id: raw.request_id.trim()
    }
  };
}

export function normalizeTrialModelPayload(raw) {
  const repairedRaw = repairLatexJsonArtifacts(raw);
  if (!isPlainObject(repairedRaw)) return repairedRaw;
  if (isPlainObject(repairedRaw.error)) {
    return {
      error: {
        code: ERROR_CODES.has(repairedRaw.error.code) ? repairedRaw.error.code : "model_failed",
        message: isNonEmptyString(repairedRaw.error.message) ? repairedRaw.error.message.trim() : "模型分析失败，请重试或手动填写。",
        details: isPlainObject(repairedRaw.error.details) ? repairedRaw.error.details : {}
      },
      request_id: isNonEmptyString(repairedRaw.request_id) ? repairedRaw.request_id.trim() : newRequestId()
    };
  }
  if (!isPlainObject(repairedRaw.data)) return repairedRaw;
  const data = repairedRaw.data;
  const errorType = normalizeErrorType(data.error_type);
  const riskFlags = normalizeRiskFlags(data.risk_flags);
  if (!ERROR_TYPES.has(data.error_type)) riskFlags.add("answer_uncertain");
  return {
    data: {
      stem: stringOrEmpty(data.stem),
      student_answer: nullableString(data.student_answer),
      correct_answer: nullableString(data.correct_answer),
      knowledge_tags: normalizeStringArray(data.knowledge_tags, 3),
      error_type: errorType,
      explanation: {
        hint: stringOrEmpty(data.explanation?.hint),
        key_steps: normalizeStringArray(data.explanation?.key_steps, 12),
        full_solution: stringOrEmpty(data.explanation?.full_solution)
      },
      risk_flags: [...riskFlags]
    },
    request_id: isNonEmptyString(repairedRaw.request_id) ? repairedRaw.request_id.trim() : newRequestId()
  };
}

export function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) throw new Error("empty model content");
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  try {
    return parseModelJsonCandidate(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("json object not found");
    return parseModelJsonCandidate(candidate.slice(start, end + 1));
  }
}

const LATEX_JSON_COMMAND_PATTERN = [
  "frac",
  "sqrt",
  "left",
  "right",
  "times",
  "cdot",
  "div",
  "pm",
  "leq",
  "geq",
  "neq",
  "approx",
  "pi",
  "theta",
  "alpha",
  "beta",
  "gamma",
  "Delta",
  "sum",
  "infty",
  "text",
  "begin",
  "end",
  "sin",
  "cos",
  "tan",
  "quad",
  "qquad"
].join("|");
const UNESCAPED_LATEX_JSON_COMMAND = new RegExp(`(^|[^\\\\])\\\\(?=(?:${LATEX_JSON_COMMAND_PATTERN})\\b)`, "g");

function parseModelJsonCandidate(candidate) {
  try {
    return repairLatexJsonArtifacts(JSON.parse(candidate));
  } catch (error) {
    const escapedCandidate = escapeUnescapedLatexBackslashes(candidate);
    if (escapedCandidate === candidate) throw error;
    return repairLatexJsonArtifacts(JSON.parse(escapedCandidate));
  }
}

function escapeUnescapedLatexBackslashes(text) {
  return String(text || "").replace(UNESCAPED_LATEX_JSON_COMMAND, "$1\\\\");
}

export function repairLatexJsonArtifacts(value) {
  if (typeof value === "string") return repairLatexTextArtifacts(value);
  if (Array.isArray(value)) return value.map((item) => repairLatexJsonArtifacts(item));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, repairLatexJsonArtifacts(item)])
  );
}

function repairLatexTextArtifacts(value) {
  return String(value)
    .replace(/\u000c(?=[A-Za-z{])/g, "\\f")
    .replace(/\u0008(?=[A-Za-z{])/g, "\\b")
    .replace(/\u0009(?=(?:ext|heta|imes|an\b|o\b|ag\b|op\b))/g, "\\t")
    .replace(/\u000d(?=(?:ight|angle|ho|ef))/g, "\\r")
    .replace(/\n(?=(?:eq|abla|otin|ot\b))/g, "\\n");
}

async function callQwenVision({ apiKey, model, baseUrl, imageDataUrl, fileName }) {
  const requestId = `trial_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let lastParseError = null;
  let lastTimeout = false;
  const attempts = [
    {
      mode: "standard",
      prompt: buildAnalysisPrompt(fileName, requestId),
      timeoutMs: readPositiveInt(process.env.TRIAL_QWEN_VISION_TIMEOUT_MS, DEFAULT_VISION_TIMEOUT_MS),
      maxTokens: readPositiveInt(process.env.TRIAL_QWEN_VISION_MAX_TOKENS, 900)
    },
    {
      mode: "fallback",
      prompt: buildFastAnalysisPrompt(fileName, requestId),
      timeoutMs: readPositiveInt(process.env.TRIAL_QWEN_VISION_FALLBACK_TIMEOUT_MS, FALLBACK_VISION_TIMEOUT_MS),
      maxTokens: readPositiveInt(process.env.TRIAL_QWEN_VISION_FALLBACK_MAX_TOKENS, 520)
    }
  ];
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const current = attempts[attempt];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), current.timeoutMs);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: current.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "你是 Recall AI 错题本的中学数学错题结构化助手。只输出严格 JSON，不输出 Markdown。优先返回可供用户核对的草稿；无法确定时使用 null、insufficient_information 和 risk_flags，不要编造。"
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: current.prompt
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageDataUrl
                  }
                }
              ]
            }
          ]
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        clearTimeout(timeout);
        return {
          ok: false,
          message: "千问视觉模型调用失败，请稍后重试。",
          details: { status: response.status, request_id: payload?.request_id || payload?.id || requestId }
        };
      }
      const content = payload?.choices?.[0]?.message?.content;
      try {
        const parsed = extractJsonObject(content);
        if (!parsed.request_id) parsed.request_id = payload?.request_id || payload?.id || requestId;
        clearTimeout(timeout);
        return { ok: true, payload: parsed, requestId: parsed.request_id };
      } catch (error) {
        lastParseError = error;
        if (looksLikeMultipleQuestions(content)) {
          clearTimeout(timeout);
          return {
            ok: true,
            payload: {
              error: {
                code: "multiple_questions",
                message: "图片中包含多道题，请重新裁剪为一道题后再分析。",
                details: { reason: "multiple_questions" }
              },
              request_id: requestId
            },
            requestId
          };
        }
        clearTimeout(timeout);
        if (attempt < attempts.length - 1) continue;
      }
    } catch (error) {
      clearTimeout(timeout);
      lastTimeout = error?.name === "AbortError";
      if (attempt < attempts.length - 1 && lastTimeout) continue;
      return {
        ok: false,
        message: lastTimeout ? "模型分析超时，请重试、重新裁剪或保存为传统错题。" : "模型分析失败，请重试或手动填写。",
        details: { stage: lastTimeout ? "qwen_timeout" : "qwen", mode: current.mode, request_id: requestId }
      };
    }
  }
  return {
    ok: false,
    code: "schema_failed",
    message: "模型返回结构不稳定，请重试或手动填写。",
    details: { stage: "qwen_parse", request_id: requestId, reason: lastParseError?.message || "json_parse_failed" }
  };
}

function looksLikeMultipleQuestions(content) {
  const text = String(content || "");
  if (!text) return false;
  if (/multiple_questions|多道(?:独立)?题|多题合并|重新裁剪/.test(text)) return true;
  const questionMarkers = text.match(/第\s*[0-9一二三四五六七八九十]+\s*题/g) || [];
  if (new Set(questionMarkers).size >= 2) return true;
  const numberedMarkers = text.match(/(?:^|[\s"'([{])(?:[5-9]|1[0-9])[、.．:：]/g) || [];
  return numberedMarkers.length >= 2;
}

function looksLikePageScan(buffer) {
  const dimensions = readImageDimensions(buffer);
  if (!dimensions) return false;
  const ratio = dimensions.height / Math.max(1, dimensions.width);
  return dimensions.height >= 1800 && ratio >= 1.45;
}

function readImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }
  if (buffer.length >= 24 && buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf;
      if (isStartOfFrame && segmentLength >= 7) {
        return {
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5)
        };
      }
      offset += segmentLength;
    }
  }
  return null;
}

async function callDeepSeekReviewFeedback({ apiKey, model, baseUrl, input }) {
  const requestId = newRequestId();
  let lastParseError = null;
  const attempts = [
    buildReviewFeedbackPrompt(input, requestId),
    buildReviewFeedbackRepairPrompt(input, requestId)
  ];
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      readPositiveInt(process.env.TRIAL_DEEPSEEK_FEEDBACK_TIMEOUT_MS || process.env.TRIAL_QWEN_FEEDBACK_TIMEOUT_MS, DEFAULT_FEEDBACK_TIMEOUT_MS)
    );
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || model,
          temperature: 0.2,
          max_tokens: readPositiveInt(process.env.TRIAL_DEEPSEEK_FEEDBACK_MAX_TOKENS || process.env.TRIAL_QWEN_FEEDBACK_MAX_TOKENS, 650),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "你是 Recall AI 错题本的复习教练。只输出严格 JSON，不输出 Markdown。你只能根据题目、用户本次作答和自评做谨慎反馈，不要假装知道用户真实心理，不要直接替用户完成题目。"
            },
            {
              role: "user",
              content: attempts[attempt]
            }
          ]
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        clearTimeout(timeout);
        if (attempt < attempts.length - 1 && response.status >= 500) continue;
        return {
          ok: false,
          message: "DeepSeek 复习复盘调用失败，本次复习已经保存。请稍后再看。",
          details: { status: response.status, stage: "deepseek_review_feedback", request_id: payload?.request_id || payload?.id || requestId }
        };
      }
      const content = payload?.choices?.[0]?.message?.content;
      try {
        const parsed = extractJsonObject(content);
        if (!parsed.request_id) parsed.request_id = payload?.request_id || payload?.id || requestId;
        clearTimeout(timeout);
        return { ok: true, payload: parsed, requestId: parsed.request_id };
      } catch (error) {
        lastParseError = error;
        clearTimeout(timeout);
        if (attempt < attempts.length - 1) continue;
      }
    } catch (error) {
      clearTimeout(timeout);
      const isTimeout = error?.name === "AbortError";
      if (attempt < attempts.length - 1 && isTimeout) continue;
      return {
        ok: false,
        message: isTimeout
          ? "AI 复盘超时，本次复习已经保存。"
          : "DeepSeek 复盘失败，本次复习已经保存。",
        details: { stage: isTimeout ? "deepseek_review_feedback_timeout" : "deepseek_review_feedback", request_id: requestId }
      };
    }
  }
  return {
    ok: false,
    message: "DeepSeek 复盘结果格式不稳定，本次复习已经保存。",
    details: { stage: "deepseek_review_feedback_parse", request_id: requestId, reason: lastParseError?.message || "json_parse_failed" }
  };
}

async function callDeepSeekExplanation({ apiKey, model, baseUrl, input }) {
  const requestId = newRequestId();
  const prompts = [
    buildExplanationPrompt(input, requestId),
    buildExplanationRepairPrompt(input, requestId)
  ];
  let lastParseError = null;
  for (let attempt = 0; attempt < prompts.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      readPositiveInt(process.env.TRIAL_DEEPSEEK_EXPLANATION_TIMEOUT_MS, DEFAULT_EXPLANATION_TIMEOUT_MS)
    );
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: readPositiveInt(process.env.TRIAL_DEEPSEEK_EXPLANATION_MAX_TOKENS, 900),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "你是 Recall AI 错题本的学习解析教练。只输出严格 JSON，不输出 Markdown。你必须基于已确认的题目、学生答案和个人便签给出谨慎、具体、可复习的分析，不要假装知道未提供的信息。"
            },
            { role: "user", content: prompts[attempt] }
          ]
        })
      });
      const payload = await response.json().catch(() => null);
      clearTimeout(timeout);
      if (!response.ok) {
        if (attempt < prompts.length - 1 && response.status >= 500) continue;
        return {
          ok: false,
          message: "DeepSeek 学习解析调用失败，错题已经保存，请稍后重试。",
          details: { status: response.status, stage: "deepseek_explanation", request_id: payload?.request_id || payload?.id || requestId }
        };
      }
      try {
        const parsed = extractJsonObject(payload?.choices?.[0]?.message?.content);
        if (!parsed.request_id) parsed.request_id = payload?.request_id || payload?.id || requestId;
        return { ok: true, payload: parsed, requestId: parsed.request_id };
      } catch (error) {
        lastParseError = error;
        if (attempt < prompts.length - 1) continue;
      }
    } catch (error) {
      clearTimeout(timeout);
      const isTimeout = error?.name === "AbortError";
      if (attempt < prompts.length - 1 && isTimeout) continue;
      return {
        ok: false,
        message: isTimeout ? "DeepSeek 学习解析超时，错题已经保存，请稍后重试。" : "DeepSeek 学习解析失败，错题已经保存，请稍后重试。",
        details: { stage: isTimeout ? "deepseek_explanation_timeout" : "deepseek_explanation", request_id: requestId }
      };
    }
  }
  return {
    ok: false,
    code: "schema_failed",
    message: "DeepSeek 返回的学习解析格式不稳定，请稍后重试。",
    details: { stage: "deepseek_explanation_parse", request_id: requestId, reason: lastParseError?.message || "json_parse_failed" }
  };
}

function buildReviewFeedbackPrompt(input, requestId) {
  return [
    `request_id: ${requestId}`,
    "请根据下面的错题原始信息和用户本次复习输入，生成一次简短、可执行、不过度确定的复盘。",
    "summary 要说明这次复习最值得注意的地方；likely_gap 只写基于证据的可能卡点；next_check 只给下一次做题前要检查的一件事；note_suggestion 给出一句用户可以自行改写进便签的建议。",
    "不要重复完整解析，不要输出知识点分类，不要把 AI 判断当成最终结论。四个字段都使用简体中文，每项 1-2 句。",
    JSON.stringify({
      question: input.question,
      review: input.review,
      output: {
        data: {
          summary: "这次复习最值得注意的地方",
          likely_gap: "基于本次作答推测的可能卡点",
          next_check: "下一次做题前先检查的一件事",
          note_suggestion: "可以补进个人便签的提醒"
        },
        request_id: requestId
      }
    })
  ].join("\n");
}

export function buildReviewFeedbackRepairPrompt(input, requestId) {
  return [
    `request_id: ${requestId}`,
    "请重新生成一次复习复盘，只允许输出一个 JSON 对象，不要解释，不要 Markdown，不要代码块。",
    "JSON 顶层只能包含 data 和 request_id。data 只能包含 summary、likely_gap、next_check、note_suggestion 四个字符串字段。",
    "每个字段 1 句中文即可；不要输出完整解题步骤，不要新增字段。",
    JSON.stringify({
      question: input.question,
      review: input.review,
      output: {
        data: {
          summary: "本次作答中最值得注意的一点。",
          likely_gap: "基于本次输入推测的一个可能卡点。",
          next_check: "下一次先检查的一件事。",
          note_suggestion: "可以写进便签的一句话。"
        },
        request_id: requestId
      }
    })
  ].join("\n");
}

export function buildExplanationPrompt(input, requestId) {
  return [
    `request_id: ${requestId}`,
    "请针对这道已经由用户确认入库的错题，生成面向学习的个性化解析，而不是搜索式标准答案。",
    "先独立核对题目中的数学运算，不要直接相信识图模型给出的正确答案。reference.hint、reference.key_steps、reference.full_solution 是标准参考层，必须给出非空内容并修正识别结果中的计算错误。",
    "what_it_tests 说明本题真正考查的能力；your_gap 只根据学生答案和个人便签指出可能差距，不要武断下结论；worked_example 只用于解释学生可能卡住的关键转折；next_check 给出下次做题前最值得检查的一件事；note_suggestion 给出一句适合用户改写进个人便签的提醒。",
    "如果学生答案、正确答案或便签缺失，必须明确说明证据不足，并把建议聚焦于核对步骤；不要编造学生的想法。五个字段都使用简体中文，每项 1-3 句。",
    JSON.stringify({
      question: input.question,
      output: {
        data: {
          reference: {
            hint: "标准参考提示",
            key_steps: ["经过核对的关键步骤"],
            full_solution: "经过核对的标准参考解析"
          },
          what_it_tests: "本题考查的核心能力",
          your_gap: "结合学生答案和便签判断的可能差距",
          worked_example: "围绕关键转折的简短步骤讲解",
          next_check: "下一次做题前先检查什么",
          note_suggestion: "适合写进个人便签的一句话"
        },
        request_id: requestId
      }
    })
  ].join("\n");
}

export function buildExplanationRepairPrompt(input, requestId) {
  return [
    `request_id: ${requestId}`,
    "请只输出一个严格 JSON 对象，不要 Markdown，不要解释，不要新增字段。",
    "顶层只能包含 data 和 request_id；data 只能包含 reference、what_it_tests、your_gap、worked_example、next_check、note_suggestion。reference 只能包含 hint、key_steps、full_solution；reference 三项必须非空。必须独立核对计算，不要照抄错误答案。",
    JSON.stringify({ question: input.question, request_id: requestId })
  ].join("\n");
}

export function buildAnalysisPrompt(fileName, requestId) {
  return [
    `request_id: ${requestId}`,
    `image_name: ${fileName || "question image"}`,
    "请识别这张图片中的单道中学数学题或错题记录。默认图片已经由用户裁剪；只处理其中最清楚的一道题，不要把多道题拼成一道题。只要单道题的印刷体题干可读，就应该返回 data 分支；不要因为没有红叉、没有明确错题标记、学生作答缺失或手写过程凌乱而直接失败。",
    "印刷体题干、印刷体选项和印刷体答案优先。手写内容只能作为 student_answer 或风险提示，绝不能把手写演算过程拼进 stem，也不能把学生写出的答案当成 correct_answer。无法确认时使用 null。",
    "如果图片明显包含两道或更多独立编号题目，必须返回 error code multiple_questions，提示用户重新裁剪为一道题；不要选择第一道、不要合并题干、不要输出部分拼接结果。",
    "如果题干清楚但手写解答、学生答案或批改痕迹不确定，请保留可识别的题干，把 student_answer 设为 null 或只填写确定部分，并使用 insufficient_information、formula_uncertain、student_answer_missing 或 answer_uncertain 标记风险。",
    "只有当图片确实不是题目、不是中学数学题、完全无法看清题干，或裁剪区域没有题目时，才返回 not_question。不要把非题目内容编造成题干：",
    JSON.stringify({
      error: {
        code: "not_question|multiple_questions",
        message: "请根据图片情况返回具体错误提示。",
        details: {}
      },
      request_id: requestId
    }),
    "如果图片包含可识别的中学数学题干，即使无法确认学生是否做错，也必须返回下面的 data 分支：",
    JSON.stringify({
      data: {
        stem: "题干",
        student_answer: null,
        correct_answer: null,
        knowledge_tags: ["知识点，最多 3 个"],
        error_type: "sign_error|concept_gap|calculation_error|reading_error|missing_steps|insufficient_information",
        explanation: {
          hint: "短提示，不直接替代学生作答",
          key_steps: ["关键步骤 1", "关键步骤 2"],
          full_solution: "完整解析，允许为空字符串"
        },
        risk_flags: ["low_image_quality"]
      },
      request_id: requestId
    }),
    "注意：如果公式里需要反斜杠，JSON 字符串里必须写成双反斜杠，例如 \\\\frac{x}{2}、\\\\theta、\\\\text，不要写成单反斜杠。",
    "error.code 只能使用 not_question 或 multiple_questions；error 分支不要同时返回 data。multiple_questions 表示检测到多道独立题目，details.reason 必须为 multiple_questions。error_type 只能从这些值中选一个：sign_error, concept_gap, calculation_error, reading_error, missing_steps, insufficient_information。",
    "risk_flags 是数组，每个元素只能从这些值中选择：low_image_quality, formula_uncertain, student_answer_missing, answer_uncertain, unsupported_question_type。没有风险时返回空数组。",
    "要求：只输出 JSON；不要输出 Markdown；不要添加未知字段；图片包含题目但学生答案缺失或手写过程不清楚时必须返回 data，并使用 null、insufficient_information 和 risk_flags；真正没有题目时才返回 not_question。"
  ].join("\n");
}

export function buildFastAnalysisPrompt(fileName, requestId) {
  return [
    `request_id: ${requestId}`,
    `image_name: ${fileName || "question image"}`,
    "快速模式：请只做最低限度的单道题草稿识别，优先让用户进入待确认页。印刷体题干优先，手写过程不要拼入 stem。",
    "只要图片里有可见的单道中学数学题干，就必须返回 data；手写答案、批改痕迹、完整解法看不清时，不要失败，把不确定字段设为 null 或空字符串。",
    "如果图片明显包含两道或更多独立编号题目，必须返回 error code multiple_questions，不要合并题干。",
    "不要长篇推理；correct_answer 可以为 null；full_solution 可以为空字符串；hint 只写一句核对提醒。",
    "只有图片完全不是题目、完全看不清题干，或裁剪区域没有题目时，才返回 not_question。",
    "注意：如果公式里需要反斜杠，JSON 字符串里必须写成双反斜杠，例如 \\\\frac{x}{2}、\\\\theta、\\\\text，不要写成单反斜杠。",
    JSON.stringify({
      data: {
        stem: "尽可能识别出的题干",
        student_answer: null,
        correct_answer: null,
        knowledge_tags: ["数学"],
        error_type: "insufficient_information",
        explanation: {
          hint: "请先对照原图核对题干。",
          key_steps: [],
          full_solution: ""
        },
        risk_flags: ["formula_uncertain", "student_answer_missing"]
      },
      request_id: requestId
    }),
    JSON.stringify({
      error: {
        code: "not_question|multiple_questions",
        message: "请根据图片情况返回具体错误提示。",
        details: {}
      },
      request_id: requestId
    }),
    "error.code 只能使用 not_question 或 multiple_questions；multiple_questions 时 details.reason 必须为 multiple_questions。只输出 JSON；不要输出 Markdown；不要添加未知字段。"
  ].join("\n");
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(WEB_DIR, relative));
  if (!target.startsWith(WEB_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const filePath = existsSync(target) ? target : join(WEB_DIR, "index.html");
  const mime = MIME_BY_EXT.get(extname(filePath).toLowerCase()) || "application/octet-stream";
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "no-store"
  });
  if (req.method !== "HEAD") res.end(body);
  else res.end();
}

function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let position = body.indexOf(delimiter);
  while (position !== -1) {
    const next = body.indexOf(delimiter, position + delimiter.length);
    if (next === -1) break;
    let part = body.subarray(position + delimiter.length, next);
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const rawHeaders = part.subarray(0, headerEnd).toString("utf8");
      const data = part.subarray(headerEnd + 4);
      const disposition = rawHeaders.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
      const name = disposition.match(/name="([^"]+)"/i)?.[1] || "";
      const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || "";
      const contentType = rawHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
      if (name) parts.push({ name, filename, contentType, data });
    }
    position = next;
  }
  return parts;
}

function validateImagePart(image) {
  if (!image) {
    return { ok: false, message: "请上传一张 JPG、PNG 或 WEBP 图片。", details: { field: "image" } };
  }
  if (image.data.length > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "图片超过 6MB，请压缩或重新截图后再上传。", details: { size: image.data.length } };
  }
  const detectedType = detectImageType(image.data) || image.contentType;
  if (!ALLOWED_IMAGE_TYPES.has(detectedType)) {
    return { ok: false, message: "当前只支持 JPG、PNG、WEBP 图片。", details: { content_type: image.contentType || "unknown" } };
  }
  return { ok: true, contentType: detectedType };
}

function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("request too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function boundaryFromContentType(contentType) {
  return contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2] || "";
}

function readModelConfig() {
  const missing = [];
  if (!process.env.DASHSCOPE_API_KEY) missing.push("DASHSCOPE_API_KEY");
  if (!process.env.QWEN_BASE_URL) missing.push("QWEN_BASE_URL");
  return {
    ok: missing.length === 0,
    missing,
    apiKey: process.env.DASHSCOPE_API_KEY,
    model: process.env.QWEN_MODEL || "qwen-vl-plus",
    baseUrl: process.env.QWEN_BASE_URL
  };
}

function readTextModelConfig() {
  const missing = [];
  if (!process.env.DEEPSEEK_API_KEY) missing.push("DEEPSEEK_API_KEY");
  if (!process.env.DEEPSEEK_BASE_URL) missing.push("DEEPSEEK_BASE_URL");
  return {
    ok: missing.length === 0,
    missing,
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    baseUrl: process.env.DEEPSEEK_BASE_URL
  };
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (!process.env[key]) process.env[key] = value.replace(/^['"]|['"]$/g, "");
  }
}

function currentServerUsage() {
  const date = todayKey();
  if (serverDailyUsage.date !== date) {
    serverDailyUsage = { date, count: 0 };
  }
  return serverDailyUsage;
}

function currentServerFeedbackUsage() {
  const date = todayKey();
  if (serverFeedbackUsage.date !== date) {
    serverFeedbackUsage = { date, count: 0 };
  }
  return serverFeedbackUsage;
}

function currentServerExplanationUsage() {
  const date = todayKey();
  if (serverExplanationUsage.date !== date) {
    serverExplanationUsage = { date, count: 0 };
  }
  return serverExplanationUsage;
}

function errorResponse(code, message, details = {}) {
  return {
    error: {
      code: ERROR_CODES.has(code) ? code : "model_failed",
      message,
      details: isPlainObject(details) ? details : {}
    },
    request_id: newRequestId()
  };
}

function normalizeRiskFlags(value) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const flags = new Set();
  for (const item of source) {
    String(item || "")
      .split(/[|,，、\s]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach((token) => {
        if (RISK_FLAGS.has(token)) flags.add(token);
      });
  }
  return flags;
}

function normalizeErrorType(value) {
  const text = String(value || "").trim();
  if (ERROR_TYPES.has(text)) return text;
  const map = new Map([
    ["符号错误", "sign_error"],
    ["概念不清", "concept_gap"],
    ["知识点不熟", "concept_gap"],
    ["计算失误", "calculation_error"],
    ["计算错误", "calculation_error"],
    ["审题偏差", "reading_error"],
    ["阅读错误", "reading_error"],
    ["步骤遗漏", "missing_steps"],
    ["信息不足", "insufficient_information"]
  ]);
  return map.get(text) || "insufficient_information";
}

function normalizeStringArray(value, limit) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return source.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit);
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trialDailyAnalysisLimit() {
  return readPositiveInt(process.env.TRIAL_DAILY_ANALYSIS_LIMIT, 50);
}

function trialDailyFeedbackLimit() {
  return readPositiveInt(process.env.TRIAL_DAILY_FEEDBACK_LIMIT, 50);
}

function trialDailyExplanationLimit() {
  return readPositiveInt(process.env.TRIAL_DAILY_EXPLANATION_LIMIT, 50);
}

function newRequestId() {
  return `trial_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function hasUnexpectedKeys(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function nullableTrim(value) {
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function startServer(port = Number.parseInt(process.env.PORT || "4173", 10)) {
  const server = createTrialServer();
  server.listen(port, () => {
    console.log(`Recall AI trial app running at http://localhost:${port}/`);
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  startServer();
}
