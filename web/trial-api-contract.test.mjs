import {
  buildAnalysisPrompt,
  buildFastAnalysisPrompt,
  buildReviewFeedbackRepairPrompt,
  buildExplanationPrompt,
  buildExplanationRepairPrompt,
  extractJsonObject,
  normalizeTrialModelPayload,
  validateExplanationInput,
  validateExplanationResponse,
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

const dirtyLatexJson = extractJsonObject(`{"data":{"stem":"已知 \\sqrt{9}+\\frac{x}{2}=5","student_answer":"x = 1","correct_answer":"x = 2","knowledge_tags":["一元一次方程"],"error_type":"sign_error","explanation":{"hint":"先算根号，再看分式。","key_steps":["\\sqrt{9}=3","\\frac{x}{2}=2"],"full_solution":"由 \\sqrt{9}=3 得 \\frac{x}{2}=2。"},"risk_flags":[]},"request_id":"trial_req_dirty_latex"}`);
ok("repairs latex escapes in dirty JSON", dirtyLatexJson.data.stem.includes("\\sqrt") && dirtyLatexJson.data.stem.includes("\\frac"));

const dirtyControlChars = normalizeTrialModelPayload({
  data: {
    stem: `${String.fromCharCode(12)}rac{x}{2} = 1`,
    student_answer: `${String.fromCharCode(9)}heta = 0`,
    correct_answer: `${String.fromCharCode(8)}eta = 0`,
    knowledge_tags: ["一元一次方程"],
    error_type: "sign_error",
    explanation: {
      hint: `${String.fromCharCode(9)}ext{先看题干}`,
      key_steps: [`${String.fromCharCode(12)}rac{x}{2} = 1`],
      full_solution: `${String.fromCharCode(9)}heta = 0`
    },
    risk_flags: []
  },
  request_id: "trial_req_dirty_control_chars"
});
ok(
  "repairs control-char latex artifacts",
  dirtyControlChars.data.stem.includes("\\frac") &&
    dirtyControlChars.data.student_answer.includes("\\theta") &&
    dirtyControlChars.data.correct_answer.includes("\\beta") &&
    dirtyControlChars.data.explanation.hint.includes("\\text")
);

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

const multipleQuestions = validateTrialAnalysisResponse({
  error: {
    code: "multiple_questions",
    message: "图片中有多道题，请重新裁剪。",
    details: { reason: "multiple_questions" }
  },
  request_id: "trial_req_multiple_questions"
});
ok("accepts multiple-question error payload", multipleQuestions.ok && multipleQuestions.value.error.code === "multiple_questions");

const prompt = buildAnalysisPrompt("handwriting-math.jpg", "trial_req_prompt");
ok("analysis prompt accepts clear stem with messy handwriting", prompt.includes("单道题的印刷体题干可读") && prompt.includes("手写过程凌乱"));
ok("analysis prompt keeps data when student answer is uncertain", prompt.includes("student_answer 设为 null") && prompt.includes("必须返回 data"));
ok("analysis prompt prevents multi-question merging", prompt.includes("不要把多道题拼成一道题") && prompt.includes("multiple_questions"));
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

const explanationInput = validateExplanationInput({
  consent_version: "trial_notice_v0.1",
  question: {
    stem: "已知 2x + 3 = 9，求 x。",
    student_answer: "x = 2",
    correct_answer: "x = 3",
    hint: "先移项，再除以 2。",
    key_steps: ["2x = 6", "x = 3"],
    prior_note: "我把 9 - 3 算成了 4。"
  }
});
ok("accepts confirmed explanation input", explanationInput.ok);
const explanationPrompt = buildExplanationPrompt(explanationInput.value, "trial_req_explanation");
ok("explanation prompt is personalized and not search-first", explanationPrompt.includes("个性化解析") && explanationPrompt.includes("个人便签") && explanationPrompt.includes("不要编造"));
const explanationRepairPrompt = buildExplanationRepairPrompt(explanationInput.value, "trial_req_explanation_repair");
ok("explanation repair prompt is strict JSON", explanationRepairPrompt.includes("data 只能包含 reference、what_it_tests") && explanationRepairPrompt.includes("不要 Markdown"));
const explanation = validateExplanationResponse({
  data: {
    reference: {
      hint: "先化简等式两边，再进行移项。",
      key_steps: ["2x = 9 - 3 = 6", "x = 3"],
      full_solution: "由 2x + 3 = 9，得 2x = 6，所以 x = 3。"
    },
    what_it_tests: "考查一元一次方程的移项和系数处理。",
    your_gap: "你的答案显示移项后的常数计算还不稳定。",
    worked_example: "先写 2x = 9 - 3 = 6，再除以 2 得到 x = 3。",
    next_check: "移项后先单独检查等号右侧的计算。",
    note_suggestion: "移项后先算清常数，再除以未知数系数。"
  },
  request_id: "trial_req_explanation"
});
ok("accepts DeepSeek explanation response", explanation.ok);
const invalidExplanation = validateExplanationResponse({
  data: {
    reference: {
      hint: "提示",
      key_steps: ["步骤"],
      full_solution: "解析"
    },
    what_it_tests: "有内容",
    your_gap: "有内容",
    worked_example: "有内容",
    next_check: "有内容",
    note_suggestion: "有内容",
    extra_field: "not allowed"
  },
  request_id: "trial_req_explanation_invalid"
});
ok("rejects unknown explanation fields", !invalidExplanation.ok);

console.log(`trial api contract passed (${results.length} checks)`);
