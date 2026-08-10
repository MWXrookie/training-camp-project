import {
  buildAnalysisPrompt,
  buildFastAnalysisPrompt,
  buildReviewFeedbackRepairPrompt,
  extractJsonObject,
  normalizeTrialModelPayload,
  validateReviewFeedbackInput,
  validateReviewFeedbackResponse,
  validateTrialAnalysisResponse
} from "../server.mjs";

const results = [];

function ok(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) {
    throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  }
}

const success = {
  data: {
    stem: "3x + 4 = 19，求 x。",
    student_answer: "x = 4",
    correct_answer: "x = 5",
    knowledge_tags: ["一元一次方程"],
    error_type: "sign_error",
    explanation: {
      hint: "先把常数项移到等号右边。",
      key_steps: ["3x = 15", "x = 5"],
      full_solution: "移项后除以 3，得到 x = 5。"
    },
    risk_flags: []
  },
  request_id: "trial_req_test"
};

const parsed = extractJsonObject(`\`\`\`json\n${JSON.stringify(success)}\n\`\`\``);
ok("extracts fenced model JSON", parsed.request_id === "trial_req_test");

const valid = validateTrialAnalysisResponse(success);
ok("accepts valid success payload", valid.ok);
ok("keeps cleaned stem", valid.value.data.stem === success.data.stem);

const invalidUnknownField = validateTrialAnalysisResponse({
  ...success,
  data: {
    ...success.data,
    extra_field: "not allowed"
  }
});
ok("rejects unknown model fields", !invalidUnknownField.ok);

const normalized = normalizeTrialModelPayload({
  data: {
    ...success.data,
    risk_flags: ["low_image_quality|formula_uncertain|unknown_flag"],
    extra_field: "model noise"
  },
  request_id: "trial_req_noisy"
});
const normalizedValidation = validateTrialAnalysisResponse(normalized);
ok("normalizes noisy model payload", normalizedValidation.ok);
ok("drops unknown risk flags", normalizedValidation.value.data.risk_flags.length === 2);

const validError = validateTrialAnalysisResponse({
  error: {
    code: "model_failed",
    message: "模型分析失败",
    details: {}
  },
  request_id: "trial_req_error"
});
ok("accepts stable error payload", validError.ok);

const notQuestion = validateTrialAnalysisResponse({
  error: {
    code: "not_question",
    message: "这张图片中没有可识别的中学数学错题。",
    details: { quota_consumed: false }
  },
  request_id: "trial_req_not_question"
});
ok("accepts non-question error payload", notQuestion.ok && notQuestion.value.error.code === "not_question");

const prompt = buildAnalysisPrompt("handwriting-math.jpg", "trial_req_prompt");
ok("analysis prompt accepts clear stem with messy handwriting", prompt.includes("只要能看清题干") && prompt.includes("手写过程凌乱"));
ok("analysis prompt keeps data when student answer is uncertain", prompt.includes("student_answer 设为 null") && prompt.includes("必须返回 data"));
const fastPrompt = buildFastAnalysisPrompt("timeout-math.jpg", "trial_req_fast_prompt");
ok("fast analysis prompt prioritizes draft creation", fastPrompt.includes("快速模式") && fastPrompt.includes("优先让用户进入待确认页"));
ok("fast analysis prompt allows incomplete analysis", fastPrompt.includes("correct_answer 可以为 null") && fastPrompt.includes("full_solution 可以为空字符串"));

const feedbackInput = validateReviewFeedbackInput({
  consent_version: "trial_notice_v0.1",
  question: {
    stem: "x + 1 = 3，求 x。",
    student_answer: "x = 1",
    correct_answer: "x = 2",
    hint: "先把 1 移到等号右边。",
    key_steps: ["x = 3 - 1", "x = 2"],
    prior_note: "我总是把移项符号写错。"
  },
  review: {
    answer: "x = 2",
    note: "这次先移项再计算。",
    rating: "good"
  }
});
ok("accepts review feedback input", feedbackInput.ok);
const feedbackRepairPrompt = buildReviewFeedbackRepairPrompt(feedbackInput.value, "trial_req_feedback_repair");
ok("review feedback repair prompt is strict JSON", feedbackRepairPrompt.includes("顶层只能包含 data 和 request_id") && feedbackRepairPrompt.includes("不要新增字段"));

const feedback = validateReviewFeedbackResponse({
  data: {
    summary: "这次先写出移项步骤，思路比上次清楚。",
    likely_gap: "之前更像是符号检查不稳定。",
    next_check: "下一次先单独检查移项后的符号。",
    note_suggestion: "移项后先停一下，检查符号再继续。"
  },
  request_id: "trial_req_feedback"
});
ok("accepts review feedback response", feedback.ok);

const invalidFeedback = validateReviewFeedbackResponse({
  data: {
    summary: "有内容",
    likely_gap: "有内容",
    next_check: "有内容",
    note_suggestion: "有内容",
    extra_field: "not allowed"
  },
  request_id: "trial_req_feedback_invalid"
});
ok("rejects unknown review feedback fields", !invalidFeedback.ok);

console.log(`trial api contract passed (${results.length} checks)`);
