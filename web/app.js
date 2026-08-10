(() => {
  const STORAGE_KEY = "recall-ai-local-state-v1";
  const DB_NAME = "recall-ai-local-db-v1";
  const DB_VERSION = 1;
  const STATE_STORE = "state";
  const STATE_KEY = "app-state";
  const TRIAL_ACCESS_CODE = "recall";
  const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
  const DAILY_ANALYSIS_LIMIT = 8;
  const TRIAL_CONSENT_VERSION = "trial_notice_v0.1";
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const ALLOWED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
  const TAB_ORDER = ["home", "library", "review", "me"];
  const SUBJECTS = [
    "数学",
    "物理",
    "化学",
    "英语",
    "语文",
    "其他"
  ];
  const KNOWLEDGE = [
    "一元一次方程",
    "一次函数",
    "整式运算",
    "因式分解",
    "概率与统计"
  ];
  const ERROR_TYPES = [
    "符号错误",
    "概念不清",
    "计算失误",
    "审题偏差",
    "步骤遗漏",
    "信息不足"
  ];
  const REVIEW_RATINGS = {
    again: { label: "困难", days: 1, intensity: 0.15, badge: "red" },
    hard: { label: "一般", days: 2, intensity: 0.3, badge: "amber" },
    good: { label: "掌握", days: 4, intensity: 0.5, badge: "teal" },
    easy: { label: "轻松", days: 7, intensity: 0.75, badge: "blue" }
  };
  const TRIAL_ERROR_TYPE_MAP = {
    "符号错误": "sign_error",
    "概念不清": "concept_gap",
    "计算失误": "calculation_error",
    "审题偏差": "reading_error",
    "步骤遗漏": "missing_steps",
    "信息不足": "insufficient_information"
  };
  const TRIAL_ERROR_TYPE_LABELS = Object.fromEntries(
    Object.entries(TRIAL_ERROR_TYPE_MAP).map(([label, code]) => [code, label])
  );
  const TRIAL_ERROR_TYPE_VALUES = new Set(Object.values(TRIAL_ERROR_TYPE_MAP));
  const TRIAL_RISK_FLAGS = new Set([
    "low_image_quality",
    "formula_uncertain",
    "student_answer_missing",
    "answer_uncertain",
    "unsupported_question_type"
  ]);
  const TRIAL_RISK_FLAG_LABELS = {
    low_image_quality: "图片质量偏低",
    formula_uncertain: "公式识别不稳",
    student_answer_missing: "学生答案缺失",
    answer_uncertain: "答案不够确定",
    unsupported_question_type: "暂不支持的题型"
  };
  const TRIAL_ADAPTER_ERROR_MESSAGE = "识别结果暂时不可用，请重试或手动填写。";

  let state = defaultState();
  let appReady = false;
  let dbPromise = null;
  let storageDriver = "准备中";
  const ui = {
    view: "home",
    selectedId: null,
    draft: null,
    cropper: null,
    processing: null,
    analysisError: null,
    uploadError: null,
    storageNotice: null,
    noteFeedback: null,
    reviewResult: null,
    createResult: null,
    reviewSubmittingId: null,
    reviewFeedbackLoadingId: null,
    reviewFeedbackError: null,
    search: "",
    statusFilter: "confirmed",
    reviewAnswer: "",
    reviewNote: "",
    accessError: "",
    dragOver: false,
    cropDrag: null
  };

  const appView = document.getElementById("appView");
  const heroBand = document.querySelector(".hero-band");
  const heroCopy = document.getElementById("heroCopy");
  const heroStats = document.getElementById("heroStats");
  const fileInput = document.getElementById("fileInput");
  const todayChip = document.getElementById("todayChip");
  const syncChip = document.getElementById("syncChip");
  const tabButtons = () => Array.from(document.querySelectorAll("[data-tab]"));
  const stateRepository = createStateRepository();

  renderBoot();
  void init();

  async function init() {
    state = await loadState();
    const beforeCount = state.questions.length;
    state.questions = state.questions.filter((question) => !isBuiltInDemoQuestion(question));
    if (state.questions.length !== beforeCount || !state.keepEmptyOnLoad) {
      state.keepEmptyOnLoad = true;
      await persist();
    }
    ui.selectedId = state.questions[0] ? state.questions[0].id : null;
    appReady = true;
    wireEvents();
    render();
  }

  function wireEvents() {
    document.addEventListener("click", handleClick);
    document.addEventListener("input", handleInput);
    document.addEventListener("change", handleChange);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);
    document.addEventListener("pointerdown", handleCropPointerDown);
    window.addEventListener("pointermove", handleCropPointerMove);
    window.addEventListener("pointerup", handleCropPointerUp);
    window.addEventListener("pointercancel", handleCropPointerUp);
    document.addEventListener("mousedown", handleCropMouseDown);
    window.addEventListener("mousemove", handleCropMouseMove);
    window.addEventListener("mouseup", handleCropPointerUp);
    fileInput.addEventListener("change", handleFileChange);
    window.addEventListener("keydown", handleShortcut);
  }

  async function loadState() {
    const result = await stateRepository.load();
    storageDriver = result.driver;
    return result.state;
  }

  function loadLegacyState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return normalizeState({
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        profile: parsed.profile || {},
        access: parsed.access || {},
        trial: parsed.trial || {},
        keepEmptyOnLoad: Boolean(parsed.keepEmptyOnLoad),
        updatedAt: parsed.updatedAt || null
      });
    } catch (error) {
      console.warn("Failed to load legacy local state", error);
      return defaultState();
    }
  }

  async function persist() {
    state.updatedAt = new Date().toISOString();
    const result = await stateRepository.save(state);
    storageDriver = result.driver;
    if (result.ok && !result.fallback) {
      ui.storageNotice = null;
      return result;
    }
    ui.storageNotice = result.notice;
    if (appReady) render();
    return result;
  }

  function createStateRepository() {
    return {
      async load() {
        try {
          const stored = await readPersistedState();
          if (stored) {
            removeLegacyState();
            return { ok: true, state: normalizeState(stored), driver: "IndexedDB" };
          }
        } catch (error) {
          console.warn("Failed to load IndexedDB state", error);
        }

        const legacy = loadLegacyState();
        if (hasPersistedContent(legacy)) {
          try {
            await writePersistedState(legacy);
            removeLegacyState();
            return { ok: true, state: normalizeState(legacy), driver: "IndexedDB", migrated: true };
          } catch (error) {
            console.warn("Failed to migrate legacy state", error);
            return { ok: true, state: normalizeState(legacy), driver: "localStorage", fallback: true };
          }
        }

        return {
          ok: true,
          state: defaultState(),
          driver: "indexedDB" in window ? "IndexedDB" : "localStorage"
        };
      },
      async save(nextState) {
        try {
          await writePersistedState(nextState);
          return { ok: true, driver: "IndexedDB" };
        } catch (error) {
          try {
            writeLegacyState(nextState);
            console.warn("Failed to persist IndexedDB state", error);
            return {
              ok: true,
              driver: "localStorage",
              fallback: true,
              notice: {
                type: "warning",
                title: "已用本机备份保存",
                message: "IndexedDB 暂时不可用，当前数据已保存到浏览器本机备份。刷新后仍可恢复。"
              }
            };
          } catch (fallbackError) {
            console.error("Failed to persist local state", fallbackError);
            return {
              ok: false,
              driver: "保存失败",
              notice: {
                type: "error",
                title: "本机保存失败",
                message: "当前浏览器没有成功保存这次改动。请先导出或截图保留内容，再刷新重试。"
              }
            };
          }
        }
      },
      async clear() {
        try {
          removeLegacyState();
          await clearPersistedState();
          return { ok: true, driver: "IndexedDB" };
        } catch (error) {
          console.error("Failed to clear local state", error);
          return {
            ok: false,
            driver: "清空失败",
            notice: {
              type: "error",
              title: "清空本机数据失败",
              message: "当前浏览器没有完成清空操作。请刷新后重试，或先导出数据再处理。"
            }
          };
        }
      }
    };
  }

  function hasPersistedContent(nextState) {
    return Boolean(
      nextState.questions.length ||
      nextState.updatedAt ||
      nextState.keepEmptyOnLoad ||
      nextState.access?.noticeAcceptedAt
    );
  }

  function writeLegacyState(nextState) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        questions: nextState.questions,
        profile: nextState.profile,
        access: nextState.access,
        trial: nextState.trial,
        keepEmptyOnLoad: Boolean(nextState.keepEmptyOnLoad),
        updatedAt: nextState.updatedAt
      })
    );
  }

  function removeLegacyState() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function defaultState() {
    return {
      questions: [],
      profile: defaultProfile(),
      access: defaultAccess(),
      trial: defaultTrialControl(),
      keepEmptyOnLoad: false,
      updatedAt: null
    };
  }

  function normalizeState(value) {
    return {
      questions: Array.isArray(value?.questions) ? value.questions : [],
      profile: Object.assign(defaultProfile(), value?.profile || {}),
      access: Object.assign(defaultAccess(), value?.access || {}),
      trial: normalizeTrialControl(value?.trial),
      keepEmptyOnLoad: Boolean(value?.keepEmptyOnLoad),
      updatedAt: value?.updatedAt || null
    };
  }

  function defaultTrialControl() {
    return {
      analysisDisabled: false,
      dailyAnalysis: {
        date: todayKey(),
        count: 0,
        limit: DAILY_ANALYSIS_LIMIT
      }
    };
  }

  function normalizeTrialControl(value) {
    const defaultControl = defaultTrialControl();
    const savedDaily = value?.dailyAnalysis || {};
    const savedLimit = Number(savedDaily.limit);
    const savedCount = Number(savedDaily.count);
    const date = savedDaily.date === todayKey() ? savedDaily.date : todayKey();
    return {
      analysisDisabled: Boolean(value?.analysisDisabled),
      dailyAnalysis: {
        date,
        count: date === savedDaily.date && Number.isFinite(savedCount) ? Math.max(0, savedCount) : 0,
        limit: Number.isFinite(savedLimit) && savedLimit > 0 ? Math.max(1, Math.floor(savedLimit)) : defaultControl.dailyAnalysis.limit
      }
    };
  }

  function defaultProfile() {
    return {
      name: "林同学",
      classText: "初二数学",
      goal: "先确认，再入库",
      note: "本地试用版，数据只保存在当前浏览器。"
    };
  }

  function defaultAccess() {
    return {
      granted: false,
      noticeAcceptedAt: null
    };
  }

  function seedQuestions() {
    const now = Date.now();
    return [
      buildQuestion({
        title: "一元一次方程 · 待复习",
        subject: "方程",
        knowledge: "一元一次方程",
        errorType: "符号错误",
        stem: "3x + 4 = 19，求 x。",
        studentAnswer: "x = 4",
        correctAnswer: "x = 5",
        hint: "先把常数项移到等号右边，再除以 3。",
        steps: [
          "3x = 19 - 4",
          "3x = 15",
          "x = 5"
        ],
        solution: "题目关键在于把加 4 变成减 4，避免把符号看反。",
        note: "我每次都容易把移项后符号写错。",
        status: "confirmed",
        dueAt: now - 1000 * 60 * 30,
        createdAt: new Date(now - 1000 * 60 * 60 * 20).toISOString(),
        updatedAt: new Date(now - 1000 * 60 * 15).toISOString(),
        history: [
          {
            id: uid("r"),
            rating: "again",
            note: "第一次复习还不熟。",
            reviewedAt: new Date(now - 1000 * 60 * 90).toISOString(),
            duration: 42
          }
        ],
        imageData: seedImage("3x + 4 = 19", "#1f7c72", "#e6f3f1")
      }),
      buildQuestion({
        title: "一次函数 · 待确认",
        subject: "函数",
        knowledge: "一次函数",
        errorType: "审题偏差",
        stem: "已知一次函数 y = 2x - 1，求 x = 3 时的 y。",
        studentAnswer: "y = 5",
        correctAnswer: "y = 5",
        hint: "先代入 x，再化简。",
        steps: ["y = 2 × 3 - 1", "y = 6 - 1", "y = 5"],
        solution: "这题正确，但依然可以确认入库，后面按复习策略再看一遍。",
        note: "拍照时把题干裁完整。",
        status: "draft",
        dueAt: null,
        createdAt: new Date(now - 1000 * 60 * 70).toISOString(),
        updatedAt: new Date(now - 1000 * 60 * 20).toISOString(),
        history: [],
        imageData: seedImage("y = 2x - 1", "#376df1", "#e8efff")
      }),
      buildQuestion({
        title: "因式分解 · 已掌握",
        subject: "代数",
        knowledge: "因式分解",
        errorType: "计算失误",
        stem: "分解 x² - 9。",
        studentAnswer: "(x - 3)(x + 3)",
        correctAnswer: "(x - 3)(x + 3)",
        hint: "先看平方差公式。",
        steps: ["x² - 9 = x² - 3²", "(x - 3)(x + 3)"],
        solution: "平方差公式直接套用即可。",
        note: "这类题我已经会了。",
        status: "confirmed",
        dueAt: now + 1000 * 60 * 60 * 24 * 4,
        createdAt: new Date(now - 1000 * 60 * 60 * 8).toISOString(),
        updatedAt: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
        history: [
          {
            id: uid("r"),
            rating: "good",
            note: "复习结果稳定。",
            reviewedAt: new Date(now - 1000 * 60 * 30).toISOString(),
            duration: 25
          }
        ],
        imageData: seedImage("x² - 9", "#f3a41b", "#fff3d9")
      }),
      buildQuestion({
        title: "概率与统计 · 新草稿",
        subject: "统计",
        knowledge: "概率与统计",
        errorType: "步骤遗漏",
        stem: "一袋中有 3 个红球、2 个蓝球，随机取 1 个球，求取到蓝球的概率。",
        studentAnswer: "2/5",
        correctAnswer: "2/5",
        hint: "先写总数，再写蓝球数。",
        steps: ["总数 = 3 + 2 = 5", "蓝球数 = 2", "概率 = 2/5"],
        solution: "把可能结果数和总结果数写清楚。",
        note: "这题适合用来快速练手。",
        status: "draft",
        dueAt: null,
        createdAt: new Date(now - 1000 * 60 * 20).toISOString(),
        updatedAt: new Date(now - 1000 * 60 * 12).toISOString(),
        history: [],
        imageData: seedImage("2/5 概率", "#376df1", "#f5f8ff")
      })
    ];
  }

  function isBuiltInDemoQuestion(question) {
    const demoStems = new Set([
      "3x + 4 = 19，求 x。",
      "已知一次函数 y = 2x - 1，求 x = 3 时的 y。",
      "分解 x² - 9。",
      "一袋中有 3 个红球、2 个蓝球，随机取 1 个球，求取到蓝球的概率。"
    ]);
    const demoTitles = new Set([
      "一元一次方程 · 待复习",
      "一次函数 · 待确认",
      "因式分解 · 已掌握",
      "概率与统计 · 新草稿"
    ]);
    const imageData = String(question?.imageData || "");
    return demoStems.has(question?.stem) && demoTitles.has(question?.title) && imageData.startsWith("data:image/svg+xml");
  }

  function buildQuestion(payload) {
    const id = payload.id || uid("q");
    return Object.assign(
      {
        id,
        title: payload.title || "未命名错题",
        subject: normalizeSubject(payload.subject || "数学"),
        knowledge: payload.knowledge || "未分类",
        errorType: payload.errorType || "未记录",
        stem: payload.stem || "",
        studentAnswer: payload.studentAnswer || "",
        correctAnswer: payload.correctAnswer || "",
        hint: payload.hint || "",
        steps: payload.steps || [],
        solution: payload.solution || "",
        note: payload.note || "",
        status: payload.status || "draft",
        dueAt: payload.dueAt || null,
        reviewCount: payload.reviewCount || 0,
        ease: payload.ease || 0.35,
        lastReviewedAt: payload.lastReviewedAt || null,
        createdAt: payload.createdAt || new Date().toISOString(),
        updatedAt: payload.updatedAt || new Date().toISOString(),
        history: payload.history || [],
        reviewFeedback: payload.reviewFeedback || null,
        imageData: payload.imageData || null,
        sourceType: payload.sourceType || (payload.imageData ? "image" : "manual"),
        archived: !!payload.archived,
        riskFlags: Array.isArray(payload.riskFlags) ? payload.riskFlags : []
      },
      {}
    );
  }

  function buildMockTrialAnalysisResponse(fileName, imageData, forceInvalid = false) {
    const template = draftTemplateFromName(fileName);
    const requestId = uid("trial_req");
    const knowledgeTags = [template.knowledge].filter(Boolean).slice(0, 3);
    const response = {
      data: {
        stem: template.stem,
        student_answer: template.studentAnswer || null,
        correct_answer: template.correctAnswer || null,
        knowledge_tags: knowledgeTags,
        error_type: trialErrorTypeForLabel(template.errorType),
        explanation: {
          hint: template.hint,
          key_steps: Array.isArray(template.steps) ? [...template.steps] : [],
          full_solution: template.solution
        },
        risk_flags: buildTrialRiskFlags(imageData, template)
      },
      request_id: requestId
    };

    if (forceInvalid) {
      response.data = {
        ...response.data,
        explanation: {
          hint: response.data.explanation.hint
        },
        risk_flags: ["low_image_quality", "made_up_flag"],
        extra_field: "should_fail_validation"
      };
      response.request_id = "";
    }

    return response;
  }

  function validateTrialAnalysisResponse(raw) {
    if (!isPlainObject(raw)) {
      return failureResult("schema_failed", "顶层结果不是对象。", ["adapter 返回值类型不合法"]);
    }

    if (Object.prototype.hasOwnProperty.call(raw, "error")) {
      if (hasUnexpectedKeys(raw, new Set(["error", "request_id"]))) {
        return failureResult("schema_failed", TRIAL_ADAPTER_ERROR_MESSAGE, ["顶层包含未知字段"]);
      }
      const error = raw.error;
      if (!isPlainObject(error)) {
        return failureResult("schema_failed", "错误响应格式不合法。", ["error 不是对象"]);
      }
      const details = [];
      if (!isString(error.code) || !["validation_failed", "consent_required", "rate_limited", "model_failed", "schema_failed", "not_question"].includes(error.code)) {
        details.push("error.code 不在允许范围");
      }
      if (!isString(error.message) || !error.message.trim()) {
        details.push("error.message 为空");
      }
      if (!isPlainObject(error.details)) {
        details.push("error.details 不合法");
      }
      if (!isString(raw.request_id) || !raw.request_id.trim()) {
        details.push("request_id 为空");
      }
      if (details.length) {
        return failureResult("schema_failed", TRIAL_ADAPTER_ERROR_MESSAGE, details);
      }
      return failureResult(error.code, error.message.trim(), details, raw.request_id.trim(), error.details);
    }

    if (hasUnexpectedKeys(raw, new Set(["data", "request_id"]))) {
      return failureResult("schema_failed", TRIAL_ADAPTER_ERROR_MESSAGE, ["顶层包含未知字段"], raw.request_id || null);
    }

    const details = [];
    if (!isString(raw.request_id) || !raw.request_id.trim()) {
      details.push("request_id 不能为空");
    }
    if (!isPlainObject(raw.data)) {
      details.push("data 不是对象");
      return failureResult("schema_failed", TRIAL_ADAPTER_ERROR_MESSAGE, details, raw.request_id || null);
    }

    const data = raw.data;
    const allowedDataKeys = new Set(["stem", "student_answer", "correct_answer", "knowledge_tags", "error_type", "explanation", "risk_flags"]);
    if (hasUnexpectedKeys(data, allowedDataKeys)) {
      details.push("data 存在未知字段");
    }
    if (!isString(data.stem) || !data.stem.trim()) {
      details.push("stem 不能为空");
    }
    if (!isNullableString(data.student_answer)) {
      details.push("student_answer 类型不合法");
    }
    if (!isNullableString(data.correct_answer)) {
      details.push("correct_answer 类型不合法");
    }
    if (!Array.isArray(data.knowledge_tags) || data.knowledge_tags.length > 3 || data.knowledge_tags.some((item) => !isString(item) || !item.trim())) {
      details.push("knowledge_tags 不合法");
    }
    if (!isString(data.error_type) || !TRIAL_ERROR_TYPE_VALUES.has(data.error_type)) {
      details.push("error_type 不合法");
    }
    if (!isPlainObject(data.explanation)) {
      details.push("explanation 不是对象");
    } else {
      const explanationKeys = new Set(["hint", "key_steps", "full_solution"]);
      if (hasUnexpectedKeys(data.explanation, explanationKeys)) {
        details.push("explanation 存在未知字段");
      }
      if (!isString(data.explanation.hint)) {
        details.push("explanation.hint 不合法");
      }
      if (!Array.isArray(data.explanation.key_steps) || data.explanation.key_steps.some((item) => !isString(item))) {
        details.push("explanation.key_steps 不合法");
      }
      if (!isString(data.explanation.full_solution)) {
        details.push("explanation.full_solution 不合法");
      }
    }
    if (!Array.isArray(data.risk_flags) || data.risk_flags.some((flag) => !isString(flag) || !TRIAL_RISK_FLAGS.has(flag))) {
      details.push("risk_flags 不合法");
    }

    if (details.length) {
      return failureResult("schema_failed", TRIAL_ADAPTER_ERROR_MESSAGE, details, raw.request_id || null);
    }

    return {
      ok: true,
      requestId: raw.request_id.trim(),
      data: {
        stem: data.stem.trim(),
        student_answer: normalizeNullableString(data.student_answer),
        correct_answer: normalizeNullableString(data.correct_answer),
        knowledge_tags: data.knowledge_tags.map((item) => item.trim()).slice(0, 3),
        error_type: data.error_type,
        explanation: {
          hint: data.explanation.hint.trim(),
          key_steps: data.explanation.key_steps.map((item) => item.trim()),
          full_solution: data.explanation.full_solution.trim()
        },
        risk_flags: data.risk_flags.map((item) => item.trim())
      }
    };
  }

  function buildTrialAnalysisError(fileName, imageData, validation, requestId, adapter = "mock") {
    return {
      code: validation.code || "schema_failed",
      message: validation.message || TRIAL_ADAPTER_ERROR_MESSAGE,
      details: Array.isArray(validation.details) ? validation.details : [],
      modelDetails: isPlainObject(validation.modelDetails) ? validation.modelDetails : {},
      requestId: requestId || validation.requestId || null,
      fileName,
      imageData,
      adapter
    };
  }

  function failureResult(code, message, details, requestId = null, modelDetails = {}) {
    return {
      ok: false,
      code,
      message,
      details,
      modelDetails: isPlainObject(modelDetails) ? modelDetails : {},
      requestId
    };
  }

  function buildTrialRiskFlags(imageData, template) {
    const flags = [];
    if (!imageData) {
      flags.push("low_image_quality");
    }
    if (template.studentAnswer && template.studentAnswer !== template.correctAnswer) {
      flags.push("answer_uncertain");
    }
    return Array.from(new Set(flags));
  }

  function trialErrorTypeForLabel(label) {
    return TRIAL_ERROR_TYPE_MAP[label] || "concept_gap";
  }

  function subjectFromKnowledge(knowledge) {
    return knowledge ? "数学" : "";
  }

  function normalizeSubject(subject) {
    return SUBJECTS.includes(subject) ? subject : "数学";
  }

  function aiReferenceText(question) {
    if (["text", "manual"].includes(question?.sourceType) && question?.knowledge === "AI 暂无参考") {
      return "暂无 AI 分析。先以你的题干、答案和便签为准。";
    }
    const parts = [];
    if (question?.knowledge && !["未分类", "AI 暂无参考"].includes(question.knowledge)) {
      parts.push(`可能知识点：${question.knowledge}`);
    }
    if (question?.errorType && !["未记录", "信息不足"].includes(question.errorType)) {
      parts.push(`可能错因：${question.errorType}`);
    }
    return parts.length ? parts.join("；") : "AI 暂时没有稳定判断。你可以直接用便签记录自己的理解。";
  }

  function isLikelyInvalidTrialFile(fileName) {
    const lower = String(fileName || "").toLowerCase();
    return ["fail", "invalid", "schema", "bad"].some((token) => lower.includes(token));
  }

  function validateUploadFile(file) {
    if (!file) {
      return {
        ok: false,
        code: "file_missing",
        message: "没有读取到图片文件，请重新选择。"
      };
    }
    const extension = String(file.name || "").split(".").pop().toLowerCase();
    const typeAllowed = file.type ? ALLOWED_IMAGE_TYPES.has(file.type) : false;
    const extensionAllowed = ALLOWED_IMAGE_EXTENSIONS.has(extension);
    if (!typeAllowed && !extensionAllowed) {
      return {
        ok: false,
        code: "unsupported_type",
        message: "请选择 JPG、PNG 或 WEBP 格式的错题图片。"
      };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        code: "file_too_large",
        message: `这张图片是 ${formatBytes(file.size)}，超过当前 ${formatBytes(MAX_UPLOAD_BYTES)} 的试用上限。`
      };
    }
    return { ok: true };
  }

  function draftTitleFromStem(stem) {
    const text = sanitize(stem);
    if (!text) return "";
    return text.length > 18 ? `${text.slice(0, 18)}…` : text;
  }

  function createManualDraft(fileName = "手动草稿", imageData = null) {
    return buildQuestion({
      title: "手动录入错题",
      subject: "数学",
      knowledge: "AI 暂无参考",
      errorType: "信息不足",
      stem: "",
      studentAnswer: "",
      correctAnswer: "",
      hint: "",
      steps: [],
      solution: "",
      note: "",
      status: "draft",
      dueAt: null,
      imageData: imageData || null,
      sourceType: imageData ? "image" : "manual"
    });
  }

  function traditionalTitleFromFileName(fileName) {
    const cleanName = sanitize(fileName).replace(/\.[^.]+$/, "");
    if (!cleanName) return "传统错题";
    return cleanName.length > 18 ? `${cleanName.slice(0, 18)}…` : cleanName;
  }

  function createTraditionalQuestion(fileName = "传统错题", imageData = null) {
    return buildQuestion({
      title: traditionalTitleFromFileName(fileName),
      subject: "数学",
      knowledge: "传统错题",
      errorType: "未分析",
      stem: "",
      studentAnswer: "",
      correctAnswer: "",
      hint: "",
      steps: [],
      solution: "",
      note: "",
      status: "confirmed",
      dueAt: null,
      imageData: imageData || null,
      sourceType: "traditional",
      confirmedAt: new Date().toISOString()
    });
  }

  function createTextDraft(stem) {
    const cleanStem = sanitize(stem);
    const title = draftTitleFromStem(cleanStem) || "文字录入错题";
    return buildQuestion({
      title,
      subject: "数学",
      knowledge: "AI 暂无参考",
      errorType: "信息不足",
      stem: cleanStem,
      studentAnswer: "",
      correctAnswer: "",
      hint: "",
      steps: [],
      solution: "",
      note: "",
      status: "draft",
      dueAt: null,
      imageData: null,
      sourceType: "text"
    });
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isString(value) {
    return typeof value === "string";
  }

  function isNullableString(value) {
    return value === null || typeof value === "string";
  }

  function normalizeNullableString(value) {
    return typeof value === "string" ? value.trim() : null;
  }

  function hasUnexpectedKeys(value, allowedKeys) {
    return Object.keys(value).some((key) => !allowedKeys.has(key));
  }

  function seedImage(title, primary, soft) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="720" height="900" viewBox="0 0 720 900">
        <defs>
          <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stop-color="${soft}" />
            <stop offset="100%" stop-color="#ffffff" />
          </linearGradient>
        </defs>
        <rect width="720" height="900" rx="36" fill="url(#g)" />
        <rect x="60" y="68" width="600" height="764" rx="28" fill="#fff" stroke="#d8e3e5" stroke-width="4" />
        <rect x="104" y="118" width="220" height="34" rx="17" fill="${primary}" opacity="0.13" />
        <rect x="104" y="174" width="330" height="18" rx="9" fill="#d8e3e5" />
        <rect x="104" y="214" width="290" height="18" rx="9" fill="#d8e3e5" />
        <rect x="104" y="254" width="250" height="18" rx="9" fill="#d8e3e5" />
        <rect x="104" y="324" width="520" height="250" rx="24" fill="#f8fbfc" stroke="#d8e3e5" stroke-width="3" />
        <rect x="148" y="368" width="296" height="18" rx="9" fill="${primary}" opacity="0.8" />
        <rect x="148" y="410" width="248" height="18" rx="9" fill="#d8e3e5" />
        <rect x="148" y="452" width="178" height="18" rx="9" fill="#d8e3e5" />
        <rect x="104" y="624" width="520" height="144" rx="24" fill="#f8fbfc" stroke="#d8e3e5" stroke-width="3" />
        <circle cx="566" cy="182" r="46" fill="${primary}" opacity="0.12" />
        <text x="104" y="812" font-family="Arial, sans-serif" font-size="28" fill="#5d6b7a">${escapeXml(title)}</text>
      </svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function openDatabase() {
    if (!("indexedDB" in window)) {
      return Promise.resolve(null);
    }
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STATE_STORE)) {
            db.createObjectStore(STATE_STORE, { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open database"));
      });
    }
    return dbPromise;
  }

  async function readPersistedState() {
    const db = await openDatabase();
    if (!db) {
      return null;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, "readonly");
      const store = tx.objectStore(STATE_STORE);
      const request = store.get(STATE_KEY);
      request.onsuccess = () => {
        const record = request.result;
        resolve(record ? record.value : null);
      };
      request.onerror = () => reject(request.error || new Error("Failed to read state"));
    });
  }

  async function writePersistedState(nextState) {
    const db = await openDatabase();
    if (!db) {
      throw new Error("IndexedDB is unavailable");
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, "readwrite");
      const store = tx.objectStore(STATE_STORE);
      const request = store.put({
        key: STATE_KEY,
        value: {
          questions: nextState.questions,
          profile: nextState.profile,
          access: nextState.access,
          trial: nextState.trial,
          keepEmptyOnLoad: Boolean(nextState.keepEmptyOnLoad),
          updatedAt: nextState.updatedAt
        }
      });
      request.onerror = () => reject(request.error || new Error("Failed to write state"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("State transaction failed"));
    });
  }

  async function clearPersistedState() {
    const db = await openDatabase();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, "readwrite");
      const store = tx.objectStore(STATE_STORE);
      const request = store.clear();
      request.onerror = () => reject(request.error || new Error("Failed to clear state"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Clear transaction failed"));
    });
  }

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function render() {
    if (!appReady) {
      renderBoot();
      return;
    }
    const storageLabel = storageDriver === "IndexedDB"
      ? "IndexedDB"
      : storageDriver === "localStorage"
        ? "本机备份"
        : storageDriver === "保存失败"
          ? "保存失败"
          : storageDriver === "清空失败"
            ? "清空失败"
          : "本机保存";
    syncChip.textContent = state.updatedAt
      ? `${storageLabel} · ${formatShort(state.updatedAt)}`
      : storageLabel;
    todayChip.textContent = todaySummary();
    renderTabs();
    if (!hasAccess()) {
      todayChip.textContent = "待告知确认";
      renderAccessStats();
      appView.innerHTML = renderGlobalNotice() + renderAccessGate();
      hydrateIcons(appView);
      setLockedControls(true);
      return;
    }
    renderHeroContext();
    setLockedControls(false);
    renderHeroStats();
    appView.innerHTML = renderGlobalNotice() + renderView();
    hydrateIcons(appView);
    syncDraftPreview();
    syncReviewState();
  }

  function hasAccess() {
    return Boolean(state.access?.granted && state.access?.noticeAcceptedAt);
  }

  function setLockedControls(locked) {
    const guard = locked ? { ok: false } : analysisGuardStatus();
    document.querySelectorAll(".hero-actions [data-action]").forEach((button) => {
      const analysisAction = ["pick-upload"].includes(button.dataset.action);
      button.disabled = locked || (analysisAction && !guard.ok);
      button.title = locked
        ? "请先完成受控试用告知"
        : analysisAction && !guard.ok
          ? "试用分析暂不可用"
          : "";
    });
  }

  function renderAccessStats() {
    if (heroBand) heroBand.classList.remove("is-compact");
    if (heroCopy) {
      heroCopy.innerHTML = `
        <p class="eyebrow">先确认，再入库</p>
        <h1>今天要处理哪道错题？</h1>
        <p class="hero-text">
          这是一个可直接使用的本地 Web 端错题本。图片或文字会先生成待确认草稿，确认后才进入错题库和复习队列。
        </p>

        <div class="hero-actions">
          <button class="button button-primary" data-action="pick-upload">
            <span class="icon" data-icon="upload"></span>
            上传错题
          </button>
        </div>
      `;
      hydrateIcons(heroCopy);
    }
    heroStats.innerHTML = `
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">受控访问</p>
          <span class="badge amber">未开始</span>
        </div>
        <div class="stat-value">T</div>
        <p class="stat-desc">仅用于本地受控试用，不面向公开用户。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">确认原则</p>
          <span class="badge teal">必须确认</span>
        </div>
        <div class="stat-value">✓</div>
        <p class="stat-desc">上传或识别结果不会自动入库。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">本机数据</p>
          <span class="badge blue">${storageDriver}</span>
        </div>
        <div class="stat-value">本机</div>
        <p class="stat-desc">错题、便签、复习记录只保存在当前浏览器。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">当前接口</p>
          <span class="badge gray">未接 AI</span>
        </div>
        <div class="stat-value">0</div>
        <p class="stat-desc">当前版本使用本地草稿流替代模型分析。</p>
      </div>
    `;
  }

  function renderHeroContext() {
    if (!heroBand || !heroCopy) return;
    const stats = computeStats();
    const contexts = {
      home: {
        compact: false,
        eyebrow: "先确认，再入库",
        title: "今天要处理哪道错题？",
        text: "这是一个可直接使用的本地 Web 端错题本。图片或文字会先生成待确认草稿，确认后才进入错题库和复习队列。",
        actions: `
          <button class="button button-primary" data-action="pick-upload">
            <span class="icon" data-icon="upload"></span>
            上传错题
          </button>
        `
      },
      library: {
        compact: true,
        eyebrow: "错题资产",
        title: "确认后的题目在这里管理",
        text: `当前有 ${stats.confirmedCount} 道正式错题，待确认草稿 ${stats.draftCount} 道。默认只看已确认内容。`,
        actions: `
          <button class="button button-primary" data-action="pick-upload">
            <span class="icon" data-icon="upload"></span>
            上传新错题
          </button>
          <button class="button button-secondary" data-action="show-drafts">
            <span class="icon" data-icon="bookmark"></span>
            查看待确认
          </button>
        `
      },
      review: {
        compact: true,
        eyebrow: "今日复习",
        title: stats.dueCount ? `先完成 ${stats.dueCount} 道到期题` : "今天没有到期题",
        text: "复习页按队列、题目、作答、提示、自评分区。先写答案，再按需要展开提示和解析。",
        actions: `
          <button class="button button-primary" data-action="goto-review">
            <span class="icon" data-icon="review"></span>
            查看复习面板
          </button>
          <button class="button button-secondary" data-action="goto-library">
            <span class="icon" data-icon="book"></span>
            回看错题库
          </button>
        `
      },
      me: {
        compact: true,
        eyebrow: "本机数据",
        title: "管理试用数据和分析开关",
        text: "这里可以导出、清空本机数据，也可以临时停用试用分析。清空不会重置今日模型次数。",
        actions: `
          <button class="button button-primary" data-action="download-json">
            <span class="icon" data-icon="download"></span>
            导出数据
          </button>
        `
      }
    };
    const context = contexts[ui.view] || contexts.home;
    heroBand.classList.toggle("is-compact", context.compact);
    heroCopy.innerHTML = `
      <p class="eyebrow">${escapeHtml(context.eyebrow)}</p>
      <h1>${escapeHtml(context.title)}</h1>
      <p class="hero-text">${escapeHtml(context.text)}</p>
      <div class="hero-actions">${context.actions}</div>
    `;
    hydrateIcons(heroCopy);
  }

  function renderGlobalNotice() {
    if (!ui.storageNotice) return "";
    const typeClass = ui.storageNotice.type === "error" ? "is-error" : "is-warning";
    return `
      <div class="global-notice ${typeClass}">
        <div>
          <strong>${escapeHtml(ui.storageNotice.title)}</strong>
          <p>${escapeHtml(ui.storageNotice.message)}</p>
        </div>
        <button class="button button-ghost button-pill" data-action="dismiss-storage-notice">知道了</button>
      </div>
    `;
  }

  function renderAccessGate() {
    return `
      <section class="page-panel access-gate">
        <div class="panel-head">
          <div>
            <p class="eyebrow">T 阶段受控试用</p>
            <h2 class="panel-title">开始前先确认边界</h2>
            <p class="panel-subtitle">这个本地版本用于验证错题复习流程，不是公开产品，也不面向真实未成年人试用。</p>
          </div>
          <span class="badge amber">需确认</span>
        </div>

        <div class="notice-grid">
          <div class="stack-card">
            <h4>试用说明</h4>
            <ul class="notice-list">
              <li>当前版本会通过本地服务端调用千问视觉模型，上传后生成可编辑草稿。</li>
              <li>确认前不会进入错题库，也不会进入复习队列。</li>
              <li>错题、便签和复习记录只保存在当前浏览器。</li>
              <li>不要上传含真实姓名、学校、联系方式或未成年人隐私的图片。</li>
            </ul>
          </div>

          <div class="stack-card">
            <h4>访问口令</h4>
            <div class="form-grid">
              <div class="form-row">
                <label for="accessCode">试用口令</label>
                <input id="accessCode" placeholder="输入 recall" autocomplete="off" />
              </div>
              <label class="check-row">
                <input id="accessNotice" type="checkbox" />
                <span>我已理解这是受控本地试用，确认后再入库。</span>
              </label>
              ${ui.accessError ? `<p class="access-error">${escapeHtml(ui.accessError)}</p>` : ""}
              <button class="button button-primary" data-action="accept-access">
                <span class="icon" data-icon="check"></span>
                开始本地试用
              </button>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderBoot() {
    heroStats.innerHTML = `
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">本地试用版</p>
          <span class="badge blue">加载中</span>
        </div>
        <div class="stat-value">…</div>
        <p class="stat-desc">正在读取本机错题数据。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">数据层</p>
          <span class="badge gray">IndexedDB</span>
        </div>
        <div class="stat-value">IDB</div>
        <p class="stat-desc">本地保存，不依赖服务端。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">当前状态</p>
          <span class="badge gray">初始化</span>
        </div>
        <div class="stat-value">0</div>
        <p class="stat-desc">页面准备中，请稍等片刻。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">导航</p>
          <span class="badge gray">首页</span>
        </div>
        <div class="stat-value">—</div>
        <p class="stat-desc">准备好后会显示错题、复习和我的页面。</p>
      </div>
    `;
    appView.innerHTML = `
      <div class="page-panel">
        <div class="empty-state">正在从本机读取错题数据，马上就好。</div>
      </div>
    `;
    syncChip.textContent = "初始化中";
    todayChip.textContent = "准备中";
  }

  function renderTabs() {
    tabButtons().forEach((button) => {
      const active = button.dataset.tab === ui.view;
      button.classList.toggle("is-active", active);
    });
  }

  function renderHeroStats() {
    const stats = computeStats();
    heroStats.innerHTML = `
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">今日待复习</p>
          <span class="badge ${stats.dueCount > 0 ? "amber" : "teal"}">${
            stats.dueCount > 0 ? "有任务" : "已完成"
          }</span>
        </div>
        <div class="stat-value">${stats.dueCount}</div>
        <p class="stat-desc">${stats.dueCopy}</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">待确认草稿</p>
          <span class="badge ${stats.draftCount ? "blue" : "gray"}">${
            stats.draftCount ? "待确认" : "清爽"
          }</span>
        </div>
        <div class="stat-value">${stats.draftCount}</div>
        <p class="stat-desc">确认后才会进入错题库。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">本周复习</p>
          <span class="badge teal">记录</span>
        </div>
        <div class="stat-value">${stats.weeklyReviews}</div>
        <p class="stat-desc">只统计有效提交，不算打开页面。</p>
      </div>
      <div class="stat-card">
        <div class="stat-head">
          <p class="stat-title">科目记录</p>
          <span class="badge blue">本机</span>
        </div>
        <div class="stat-value">${stats.subjectCount}</div>
        <p class="stat-desc">${stats.subjectNames}</p>
      </div>
    `;
  }

  function renderView() {
    switch (ui.view) {
      case "library":
        return renderLibraryView();
      case "review":
        return renderReviewView();
      case "me":
        return renderMeView();
      case "home":
      default:
        return renderHomeView();
    }
  }

  function renderHomeView() {
    const draft = ui.draft;
    const processing = ui.processing;
    const stats = computeStats();
    const recent = recentQuestions(3);
    const pending = questionsByStatus("draft");
    const hasReviewPressure = stats.dueCount > 0;
    const guard = analysisGuardStatus();
    const usage = currentAnalysisUsage();
    const analysisDisabledAttr = guard.ok ? "" : "disabled";
    const primaryTitle = hasReviewPressure
      ? "先处理到期题，也可以继续收新错题"
      : stats.confirmedCount
        ? "继续整理下一道错题"
        : "从第一道错题开始";
    const primaryDesc = hasReviewPressure
      ? `今天有 ${stats.dueCount} 道到期题。上传仍在这里，复习入口会更靠前。`
      : "上传错题图片或直接粘贴题干后，先得到待确认草稿；确认前不会进入正式错题库。";
    return `
      <div class="page-grid">
        <div class="home-action-layout">
          <section class="upload-card home-primary-card">
            <div class="section-head">
              <div>
                <p class="eyebrow">首页主操作</p>
                <h2 class="section-title">${escapeHtml(primaryTitle)}</h2>
                <p class="section-desc">${escapeHtml(primaryDesc)}</p>
              </div>
              <span class="badge ${hasReviewPressure ? "amber" : "blue"}">${
                hasReviewPressure ? "复习增强" : "上传优先"
              }</span>
            </div>

            <div class="home-status-strip">
              ${homeMetric("已确认", stats.confirmedCount)}
              ${homeMetric("待复习", stats.dueCount)}
              ${homeMetric("待确认", stats.draftCount)}
              ${homeMetric("便签", stats.noteCount)}
            </div>

            <div class="drop-zone home-drop-zone ${ui.dragOver ? "is-dragging" : ""}" data-dropzone>
              <div class="drop-row">
                <div>
                  <p class="drop-title">上传错题</p>
                  <p class="drop-desc">拍照、截图、相册图片均可。支持 JPG、PNG、WEBP，今日剩余 ${remainingAnalysisCount()}/${usage.limit} 次试用分析。</p>
                </div>
                <button class="button button-primary" data-action="pick-upload" ${analysisDisabledAttr}>
                  <span class="icon" data-icon="upload"></span>
                  上传错题
                </button>
              </div>
              ${
                draft || ui.cropper || processing
                  ? ""
                  : `<div class="text-upload-box">
                      <div class="text-upload-head">
                        <div>
                          <p class="drop-title">文字录入错题</p>
                          <p class="drop-desc">没有图片时，直接粘贴或输入题干，也会进入待确认草稿。</p>
                        </div>
                        <span class="badge teal">不消耗 AI 次数</span>
                      </div>
                      <textarea id="textUploadStem" class="text-upload-input" placeholder="把题干粘贴在这里，例如完整题目、学生答案或你想补充的条件。"></textarea>
                      <div class="form-actions text-upload-actions">
                        <button class="button button-secondary" data-action="create-text-draft">
                          <span class="icon" data-icon="note"></span>
                          用文字创建错题
                        </button>
                      </div>
                    </div>`
              }
              ${
                draft || ui.cropper || processing || ui.analysisError || ui.uploadError
                  ? `<div class="form-actions">
                      <button class="button button-ghost" data-action="clear-draft">
                        <span class="icon" data-icon="x"></span>
                        ${processing ? "停止处理" : ui.cropper ? "取消选区" : draft || ui.analysisError ? "移除草稿" : "清空提示"}
                      </button>
                    </div>`
                  : ""
              }
              ${guard.ok ? "" : `<p class="field-tip danger">${escapeHtml(guard.message)}</p>`}

              ${
                ui.uploadError
                  ? renderUploadError(ui.uploadError)
                  : ""
              }
              ${
                ui.analysisError
                  ? renderAnalysisError(ui.analysisError)
                  : ""
              }
              ${
                processing
                  ? renderProcessingState(processing)
                  : ui.cropper
                  ? renderImageCropper(ui.cropper)
                  : draft
                  ? renderDraftEditor(draft)
                  : ui.analysisError
                  ? ""
                  : `<div class="empty-state">还没有待确认草稿。上传一张你的错题图片后，这里会出现可编辑的识别结果。</div>`
              }
            </div>
          </section>

          <section class="page-panel home-side-panel">
            ${renderHomeReviewBlock(stats)}
            ${renderHomeListBlock("最近错题", "确认后的题目会进入这里。", recent, { compact: true })}
            ${
              pending.length
                ? renderHomeListBlock("待确认草稿", "确认后才会进入正式错题库。", pending.slice(0, 3), { compact: true, draft: true })
                : ""
            }
          </section>
        </div>
      </div>
    `;
  }

  function homeMetric(label, value) {
    return `
      <div class="home-metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value))}</strong>
      </div>
    `;
  }

  function renderHomeReviewBlock(stats) {
    const hasDue = stats.dueCount > 0;
    return `
      <div class="home-block ${hasDue ? "is-priority" : ""}">
        <div class="section-head">
          <div>
            <h2 class="section-title">今日复习</h2>
            <p class="section-desc">${escapeHtml(stats.dueCopy)}</p>
          </div>
          <button class="button ${hasDue ? "button-primary" : "button-secondary"} button-pill" data-action="goto-review">
            <span class="icon" data-icon="review"></span>
            去复习
          </button>
        </div>
        ${
          hasDue
            ? `<div class="item-list">${duePreviewList(2)}</div>`
            : `<div class="home-calm-state">今天没有到期题。可以先上传一题，或者去错题库回看最近内容。</div>`
        }
      </div>
    `;
  }

  function renderHomeListBlock(title, desc, items, options = {}) {
    return `
      <div class="home-block">
        <div class="section-head compact">
          <div>
            <h2 class="section-title">${escapeHtml(title)}</h2>
            <p class="section-desc">${escapeHtml(desc)}</p>
          </div>
        </div>
        <div class="item-list">
          ${
            items.length
              ? items.map((q) => renderQuestionCard(q, options)).join("")
              : `<div class="home-calm-state">还没有内容。先确认一道错题，这里就会出现。</div>`
          }
        </div>
      </div>
    `;
  }

  function renderImageCropper(cropper) {
    const selection = normalizeCropSelection(cropper.selection);
    const style = `left:${selection.x}%;top:${selection.y}%;width:${selection.width}%;height:${selection.height}%;`;
    return `
      <div class="cropper-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">上传前选题</p>
            <h3 class="section-title">先框出你要分析的那一题</h3>
            <p class="section-desc">如果一页纸里有多道题，请只选中目标题目区域；千问只会收到你确认分析的图片。</p>
          </div>
          <span class="badge amber">待选择</span>
        </div>

        <div class="cropper-layout">
          <div class="cropper-preview-wrap">
            <div class="cropper-preview" aria-label="图片选题预览">
              <img src="${escapeAttr(cropper.imageData)}" alt="待截取的错题图片" />
              <div class="cropper-shade cropper-shade-top" style="height:${selection.y}%;"></div>
              <div class="cropper-shade cropper-shade-bottom" style="top:${selection.y + selection.height}%;"></div>
              <div class="cropper-shade cropper-shade-left" style="top:${selection.y}%;width:${selection.x}%;height:${selection.height}%;"></div>
              <div class="cropper-shade cropper-shade-right" style="top:${selection.y}%;left:${selection.x + selection.width}%;height:${selection.height}%;"></div>
              <div class="cropper-selection" style="${style}" data-crop-drag="move" role="button" aria-label="拖动选中区域">
                <span class="cropper-selection-label">拖动选区</span>
                ${renderCropHandle("nw", "左上角")}
                ${renderCropHandle("n", "上边")}
                ${renderCropHandle("ne", "右上角")}
                ${renderCropHandle("e", "右边")}
                ${renderCropHandle("se", "右下角")}
                ${renderCropHandle("s", "下边")}
                ${renderCropHandle("sw", "左下角")}
                ${renderCropHandle("w", "左边")}
              </div>
            </div>
            <p class="field-tip cropper-selection-readout">${cropSelectionText(selection)}</p>
          </div>

          <div class="cropper-controls">
            ${renderCropRange("左边距", "x", selection.x)}
            ${renderCropRange("上边距", "y", selection.y)}
            ${renderCropRange("宽度", "width", selection.width)}
            ${renderCropRange("高度", "height", selection.height)}
            <div class="cropper-note">
              <strong>怎么用</strong>
              <p>让浅绿色框尽量只包住一道题，不必非常精确，但不要把其他题一起框进去。</p>
            </div>
            <div class="form-actions cropper-actions">
              <button class="button button-primary" data-action="analyze-crop">
                <span class="icon" data-icon="spark"></span>
                分析选中区域
              </button>
              <button class="button button-secondary" data-action="analyze-whole-image">
                <span class="icon" data-icon="upload"></span>
                使用整张图分析
              </button>
              <button class="button button-ghost" data-action="cancel-cropper">
                <span class="icon" data-icon="x"></span>
                重新选择
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderCropRange(label, field, value) {
    return `
      <label class="cropper-range">
        <span>${escapeHtml(label)}</span>
        <input type="range" min="0" max="100" step="1" value="${escapeAttr(value)}" data-crop-field="${escapeAttr(field)}" />
      </label>
    `;
  }

  function renderCropHandle(handle, label) {
    return `<span class="cropper-handle cropper-handle-${escapeAttr(handle)}" data-crop-handle="${escapeAttr(handle)}" aria-label="拖动${escapeAttr(label)}调整选区"></span>`;
  }

  function renderDraftEditor(draft) {
    const image = draft.imageData
      ? `<img class="preview-image" src="${draft.imageData}" alt="上传预览" />`
      : `<div class="preview-image placeholder">${draft.sourceType === "text" ? "文字录入<br />无原图" : "图片预览<br />尚未选择"}</div>`;
    const riskFlags = Array.isArray(draft.riskFlags) ? draft.riskFlags : [];
    const lightweightDraft = draft.sourceType === "image" && !draft.correctAnswer && !draft.solution && (!Array.isArray(draft.steps) || !draft.steps.length);
    const candidateBadge = draft.sourceType === "text" ? "文字草稿" : draft.sourceType === "manual" ? "手动草稿" : "AI 生成草稿";
    return `
      <div class="confirm-workbench">
        <aside class="confirm-image-panel">
          <div class="confirm-image-head">
            <div>
              <span class="badge amber">待确认</span>
              <p>${draft.imageData ? "原图只用于本机核对" : "本题由文字录入生成"}</p>
            </div>
          </div>
          ${image}
          <div class="confirm-rule">
            <strong>确认前不会入库</strong>
            <span>${draft.imageData ? "请先对照图片核对题干、答案和你的理解。" : "请先核对题干、答案和你的理解。"}确认后才会进入错题库和复习队列。</span>
          </div>
        </aside>

        <form class="form-grid confirm-form" id="draftForm">
          <div class="confirm-banner">
            <div>
              <h3>${draft.sourceType === "image" ? "AI 生成的待确认草稿" : "创建错题草稿"}</h3>
              <p>${draft.sourceType === "image" ? "千问已经完成初步识别和分析，请你对照原图核对，再决定是否入库。" : "先核对题目内容，再决定是否加入错题库和复习队列。"}</p>
            </div>
            <span class="badge amber">${escapeHtml(candidateBadge)}</span>
          </div>
          ${
            riskFlags.length
              ? `
                <div class="stack-card is-warning">
                  <h4>需要核对</h4>
                  <div class="risk-badges">
                    ${riskFlags
                      .map(
                        (flag) =>
                          `<span class="badge amber">${escapeHtml(TRIAL_RISK_FLAG_LABELS[flag] || flag)}</span>`
                      )
                      .join("")}
                  </div>
                  <p>这些提示来自识别结果，确认前请逐项核对。</p>
                </div>
              `
              : ""
          }
          ${
            lightweightDraft
              ? `
                <div class="stack-card is-warning">
                  <h4>AI 只生成了基础草稿</h4>
                  <p>这通常发生在图片较复杂或模型响应较慢时。你仍然可以先核对题干并补充答案、便签；确认后会照常进入错题库和复习。</p>
                </div>
              `
              : ""
          }

          <section class="confirm-section">
            <div class="confirm-section-head">
              <h4>1. 题目内容</h4>
              <span>只需要确认科目，不强制按知识点或错因分类</span>
            </div>
            <div class="form-inline">
              <div class="form-row">
                <label>题目标题</label>
                <input name="title" value="${escapeAttr(draft.title || "")}" placeholder="可按题干或页码命名" />
              </div>
              <div class="form-row">
                <label>科目</label>
                <select name="subject">${renderOptions(SUBJECTS, normalizeSubject(draft.subject))}</select>
              </div>
            </div>

            <div class="form-row">
              <label>题干</label>
              <textarea name="stem" placeholder="把题目内容写在这里">${escapeHtml(draft.stem || "")}</textarea>
            </div>

            <input type="hidden" name="knowledge" value="${escapeAttr(draft.knowledge || "")}" />
            <input type="hidden" name="errorType" value="${escapeAttr(draft.errorType || "")}" />

            <div class="ai-reference">
              <span>${draft.sourceType === "image" ? "AI 初步分析，不是最终结论" : "AI 参考，不作为正式分类"}</span>
              <p>${escapeHtml(aiReferenceText(draft))}</p>
            </div>
          </section>

          <section class="confirm-section">
            <div class="confirm-section-head">
              <h4>2. 答案核对</h4>
              <span>答案可为空，但不要让系统替你假装确定</span>
            </div>
            <div class="form-inline">
            <div class="form-row">
              <label>学生答案</label>
              <textarea name="studentAnswer" placeholder="学生写了什么">${escapeHtml(draft.studentAnswer || "")}</textarea>
            </div>
            <div class="form-row">
              <label>正确答案</label>
              <textarea name="correctAnswer" placeholder="答案参考">${escapeHtml(draft.correctAnswer || "")}</textarea>
            </div>
            </div>
          </section>

          <section class="confirm-section">
            <div class="confirm-section-head">
              <h4>3. 我的理解</h4>
              <span>先留提示和自己的理解，完整解析后续默认折叠</span>
            </div>
            <div class="form-row">
              <label>提示</label>
              <textarea name="hint" placeholder="先放一个不直接给答案的提示">${escapeHtml(draft.hint || "")}</textarea>
            </div>

            <div class="form-row">
              <label>个人解题便签</label>
              <textarea name="note" placeholder="写下你自己的理解">${escapeHtml(draft.note || "")}</textarea>
            </div>
          </section>

          <div class="confirm-actions-note">
            <strong>保存草稿</strong> 只保留待确认状态；<strong>确认入库并加入复习</strong> 会创建第一次复习任务。
          </div>

          <div class="form-actions confirm-actions">
            <button class="button button-primary" data-action="save-draft">
              <span class="icon" data-icon="check"></span>
              保存为待确认
            </button>
            <button class="button button-secondary" data-action="save-and-confirm">
              <span class="icon" data-icon="arrow-right"></span>
              确认入库并加入复习
            </button>
          </div>
        </form>
      </div>
    `;
  }

  function renderProcessingState(job) {
    const image = job.imageData
      ? `<img class="preview-image" src="${job.imageData}" alt="上传预览" />`
      : `<div class="preview-image placeholder">草稿<br />处理中</div>`;
    const currentStep = job.stage === "structure" ? 2 : 1;
    const isRemote = job.adapter === "qwen";
    const adapterLabel = isRemote ? "千问视觉分析" : "本地模拟分析";
    const note = isRemote
      ? "图片会临时发送到本机服务端，再由服务端调用千问模型。确认前不会写入正式错题库。"
      : "当前使用本地测试分析，保留正式链路的等待和确认体验。";
    return `
      <div class="preview">
        <div>${image}</div>
        <div class="processing-panel">
          <div class="section-head">
            <div>
              <h3 class="section-title">正在生成待确认草稿</h3>
              <p class="section-desc">${escapeHtml(job.fileName)} · ${adapterLabel}</p>
            </div>
            <span class="badge blue">处理中</span>
          </div>

          <div class="processing-steps">
            ${renderProcessingStep("千问视觉分析", "识别题目、学生答案和图片中的关键信息", currentStep >= 1)}
            ${renderProcessingStep("生成 AI 学习草稿", "整理提示、可能的错因和关键步骤", currentStep >= 2)}
            ${renderProcessingStep("等待用户确认", "确认后才写入正式错题库", false)}
          </div>

          <div class="stack-card">
            <h4>当前说明</h4>
            <p>${escapeHtml(note)}</p>
          </div>
        </div>
      </div>
    `;
  }

  function renderAnalysisError(error) {
    const details = Array.isArray(error.details) ? error.details : [];
    const isNotQuestion = error.code === "not_question";
    const canSaveTraditional = Boolean(error.imageData);
    const recoveryText = analysisRecoveryText(error);
    return `
      <div class="stack-card is-error">
        <h4>${escapeHtml(analysisErrorTitle(error.code))}</h4>
        <p>${escapeHtml(error.message || TRIAL_ADAPTER_ERROR_MESSAGE)}</p>
        ${recoveryText ? `<p class="field-tip">${escapeHtml(recoveryText)}</p>` : ""}
        ${
          error.requestId
            ? `<p class="field-tip">request_id：${escapeHtml(error.requestId)}</p>`
            : ""
        }
        ${
          details.length
            ? `<ul>${details.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
            : ""
        }
        <div class="form-actions">
          ${
            isNotQuestion
              ? `<button class="button button-primary" data-action="pick-upload">
                  <span class="icon" data-icon="upload"></span>
                  重新上传题目
                </button>`
              : `<button class="button button-primary" data-action="retry-analysis">
                  <span class="icon" data-icon="spark"></span>
                  重试分析
                </button>`
          }
          <button class="button button-ghost" data-action="manual-draft">
            <span class="icon" data-icon="upload"></span>
            手动填写
          </button>
        </div>
        ${
          canSaveTraditional
            ? `<div class="traditional-fallback">
                <div>
                  <strong>不想等 AI？可以先保存为传统错题</strong>
                  <p>保留原图和你的便签，不生成 AI 分析，也不进入 AI 复习区。</p>
                </div>
                <button class="button button-secondary button-pill" data-action="save-traditional-question">
                  保存为传统错题
                </button>
              </div>`
            : ""
        }
      </div>
    `;
  }

  function analysisErrorTitle(code) {
    if (code === "rate_limited") return "今日分析次数已用完";
    if (code === "service_disabled") return "试用分析已停用";
    if (code === "not_question") return "这张图片不是可分析的错题";
    if (code === "model_failed") return "模型分析失败";
    return "结构化结果校验失败";
  }

  function analysisRecoveryText(error) {
    const stage = error?.modelDetails?.stage;
    if (stage === "qwen_timeout") {
      return "这通常是模型响应太慢，不代表图片一定不能识别。可以先点重试；如果还慢，就缩小选区或保存为传统错题。";
    }
    if (error?.code === "schema_failed") {
      return "模型返回了不稳定结构。建议先重试一次；如果仍失败，可以保存为传统错题，之后重新裁剪再分析。";
    }
    if (error?.code === "rate_limited") {
      return "今天的真实模型额度已经到上限，现有错题和传统错题仍可继续整理。";
    }
    if (error?.code === "not_question") {
      return "请重新框选题目区域，尽量只包含一道题的题干和必要解答过程。";
    }
    return "";
  }

  function renderUploadError(error) {
    return `
      <div class="stack-card is-error">
        <h4>图片暂时不能处理</h4>
        <p>${escapeHtml(error.message)}</p>
        <p class="field-tip">当前支持 JPG、PNG、WEBP，单张不超过 ${formatBytes(MAX_UPLOAD_BYTES)}。</p>
        <div class="form-actions">
          <button class="button button-primary" data-action="pick-upload">
            <span class="icon" data-icon="upload"></span>
            重新选择
          </button>
          <button class="button button-ghost" data-action="clear-draft">
            <span class="icon" data-icon="x"></span>
            清空提示
          </button>
        </div>
      </div>
    `;
  }

  function renderEmptyAction(title, message, actionLabel, action) {
    return `
      <div class="empty-state empty-action">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(message)}</p>
        <button class="button button-secondary button-pill" data-action="${escapeAttr(action)}">${escapeHtml(actionLabel)}</button>
      </div>
    `;
  }

  function renderProcessingStep(title, desc, active) {
    return `
      <div class="processing-step ${active ? "is-active" : ""}">
        <span class="processing-dot"></span>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(desc)}</p>
        </div>
      </div>
    `;
  }

  function renderLibraryView() {
    const list = filteredQuestions();
    const selected = list.find((item) => item.id === ui.selectedId) || list[0] || null;
    ui.selectedId = selected ? selected.id : null;
    const listEmpty = libraryEmptyCopy("list");
    const detailEmpty = libraryEmptyCopy("detail");
    return `
      <div class="page-grid split">
        <section class="page-panel">
          <div class="section-head">
            <div>
              <h2 class="section-title">错题库</h2>
              <p class="section-desc">只展示已确认且未删除的题目。支持搜索、筛选和快速打开详情。</p>
            </div>
            <button class="button button-secondary button-pill" data-action="goto-home">
              <span class="icon" data-icon="upload"></span>
              返回首页
            </button>
          </div>

          <div class="form-inline" style="margin-bottom: 12px;">
            <div class="form-row">
              <label>搜索</label>
              <input data-filter="search" value="${escapeAttr(ui.search)}" placeholder="题干、科目、便签" />
            </div>
            <div class="form-row">
              <label>状态筛选</label>
              <select data-filter="status">
                ${renderOptions([
                  { value: "all", label: "全部已确认" },
                  { value: "due", label: "待复习" },
                  { value: "traditional", label: "传统错题" },
                  { value: "confirmed", label: "已确认" },
                  { value: "draft", label: "待确认草稿" },
                  { value: "archived", label: "已归档" }
                ], ui.statusFilter)}
              </select>
            </div>
          </div>

          <div class="chip-row" style="margin-bottom: 14px;">
            ${renderChip("全部已确认", "all")}
            ${renderChip("待复习", "due")}
            ${renderChip("传统错题", "traditional")}
            ${renderChip("已确认", "confirmed")}
            ${renderChip("待确认", "draft")}
            ${renderChip("归档", "archived")}
          </div>

          <div class="item-list">
            ${list.map((q) => renderQuestionCard(q, { selected: q.id === (selected && selected.id), actions: true })).join("") || renderEmptyAction(
              listEmpty.title,
              listEmpty.message,
              listEmpty.actionLabel,
              listEmpty.action
            )}
          </div>
        </section>

        <section class="detail-card">
          ${selected ? renderDetail(selected) : renderEmptyAction(
            detailEmpty.title,
            detailEmpty.message,
            detailEmpty.actionLabel,
            detailEmpty.action
          )}
        </section>
      </div>
    `;
  }

  function libraryEmptyCopy(area) {
    const hasDrafts = questionsByStatus("draft").length > 0;
    const hasAny = state.questions.length > 0;
    const hasSearch = Boolean(ui.search.trim());
    if ((ui.statusFilter === "confirmed" || ui.statusFilter === "all") && hasDrafts) {
      return area === "detail"
        ? {
            title: "没有可查看的正式错题",
            message: "当前只有待确认草稿。确认前不会进入错题详情和复习队列。",
            actionLabel: "查看待确认草稿",
            action: "show-drafts"
          }
        : {
            title: "还没有已确认错题",
            message: "已有待确认草稿，但确认前不会进入正式错题库。",
            actionLabel: "查看待确认草稿",
            action: "show-drafts"
          };
    }
    if (hasSearch || hasAny) {
      return {
        title: "没有匹配的题目",
        message: "换个关键词或筛选条件，或者回到首页继续上传。",
        actionLabel: "返回首页",
        action: "goto-home"
      };
    }
    return area === "detail"
      ? {
          title: "详情还没有内容",
          message: "先确认一道错题，再回来查看原题、便签和解析。",
          actionLabel: "去首页上传",
          action: "goto-home"
        }
      : {
          title: "还没有正式错题",
          message: "上传你的错题图片并确认入库后，这里才会出现正式错题。",
          actionLabel: "去首页上传",
          action: "goto-home"
        };
  }

  function renderDetail(q) {
    const status = questionStatusMeta(q);
    const traditional = isTraditionalQuestion(q);
    const noteFeedback = ui.noteFeedback && ui.noteFeedback.id === q.id ? ui.noteFeedback : null;
    const reviewResult = ui.reviewResult && ui.reviewResult.id === q.id ? ui.reviewResult : null;
    const createResult = ui.createResult && ui.createResult.id === q.id ? ui.createResult : null;
    return `
      <div class="section-head">
        <div>
          <h2 class="section-title">错题详情</h2>
          <p class="section-desc">${traditional ? "传统错题只保留原图和你的便签，不进入 AI 复习区。" : "便签在前，标准解析在后，确认与复习都在这里完成。"}</p>
        </div>
        <span class="badge ${status.badge}">${status.label}</span>
      </div>

      ${createResult ? renderCreateResultNotice(createResult) : ""}
      ${reviewResult ? renderReviewResultNotice(reviewResult) : ""}

      ${q.imageData ? `<img class="detail-image" src="${q.imageData}" alt="${escapeAttr(q.title)}" />` : `<div class="empty-state">这条记录没有图片，只保留了结构化内容。</div>`}

      <div class="detail-meta">
        <span class="badge teal">科目：${escapeHtml(normalizeSubject(q.subject))}</span>
        ${traditional ? `<span class="badge gray">传统错题本：不自动排期</span>` : q.dueAt ? `<span class="badge gray">下次复习：${formatShort(q.dueAt)}</span>` : `<span class="badge gray">尚未排期</span>`}
      </div>

      <div class="detail-stack">
        <div class="stack-card">
          <h4>原题</h4>
          <p>${escapeHtml(q.stem || (traditional ? "请以图片和便签为准。" : "暂无题干"))}</p>
        </div>

        <div class="stack-card">
          <h4>我的解题便签</h4>
          <textarea class="note-box" data-note-for="${q.id}" placeholder="把你自己的理解写下来">${escapeHtml(q.note || "")}</textarea>
          ${noteFeedback ? `<p class="note-status ${noteFeedback.type === "error" ? "is-error" : noteFeedback.type === "dirty" ? "is-dirty" : "is-saved"}">${escapeHtml(noteFeedback.message)}</p>` : `<p class="note-status">便签会保存在当前浏览器。</p>`}
          <div class="note-actions">
            <button class="button button-primary" data-action="save-note" data-id="${q.id}">
              <span class="icon" data-icon="check"></span>
              保存便签
            </button>
            ${traditional ? "" : `<button class="button button-secondary" data-action="start-review" data-id="${q.id}">
              <span class="icon" data-icon="review"></span>
              开始复习
            </button>`}
          </div>
        </div>

        ${traditional ? renderTraditionalNotice() : renderReviewFeedback(q)}

        ${traditional ? "" : `<div class="stack-card ai-reference-card">
          <h4>AI 参考</h4>
          <p>${escapeHtml(aiReferenceText(q))}</p>
          <p class="field-tip">这里来自录入时的 AI 初步分析，不作为正式分类。复习后的 AI 复盘会单独记录在上方。</p>
        </div>`}

        ${traditional ? "" : `<div class="stack-card explanation-card">
          <h4>分层解析</h4>
          <div class="hint-strip">
            <span>提示</span>
            <p>${escapeHtml(q.hint || "暂无提示")}</p>
          </div>
          <details class="explain-layer">
            <summary>查看关键步骤</summary>
            <ul>
              ${(q.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("") || "<li>暂无步骤</li>"}
            </ul>
          </details>
          <details class="explain-layer">
            <summary>查看完整解析</summary>
            <p>${escapeHtml(q.solution || "暂无完整解析")}</p>
          </details>
        </div>`}

        <div class="stack-card">
          <h4>复习记录</h4>
          <div class="timeline">
            ${(q.history || []).map((item) => `
              <div class="timeline-item">
                <div class="timeline-time">${formatShort(item.reviewedAt)}</div>
                <div class="timeline-main">
                  ${ratingLabel(item.rating)} · ${escapeHtml(item.note || "未填写自评")}
                </div>
              </div>
            `).join("") || `<div class="muted">还没有复习记录。</div>`}
          </div>
        </div>

        <div class="stack-card">
          <h4>管理</h4>
          <div class="form-actions">
            ${
              q.status === "draft"
                ? `<button class="button button-primary" data-action="confirm-question" data-id="${q.id}"><span class="icon" data-icon="check"></span>确认入库</button>`
                : `<button class="button button-secondary" data-action="archive-question" data-id="${q.id}"><span class="icon" data-icon="archive"></span>归档</button>`
            }
            <button class="button button-danger" data-action="delete-question" data-id="${q.id}">
              <span class="icon" data-icon="trash"></span>
              删除
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderReviewFeedback(q) {
    const isLoading = ui.reviewFeedbackLoadingId === q.id;
    const error = ui.reviewFeedbackError && ui.reviewFeedbackError.id === q.id ? ui.reviewFeedbackError : null;
    const feedback = q.reviewFeedback;
    if (!feedback && !isLoading && !error) {
      return `
        <div class="stack-card ai-feedback-card is-empty">
          <div class="ai-feedback-head">
            <div>
              <span class="badge blue">AI 复盘</span>
              <h4>完成一次复习后，这里会出现 AI 复盘</h4>
            </div>
          </div>
          <p>它会根据你的本次作答和复习感受，帮你整理可能卡点、下次先检查什么，以及可以补进便签的提醒。</p>
        </div>
      `;
    }
    if (isLoading) {
      return `
        <div class="stack-card ai-feedback-card is-loading">
          <div class="ai-feedback-head">
            <div>
              <span class="badge blue">AI 复盘</span>
              <h4>正在复盘这次作答</h4>
            </div>
            <span class="field-tip">不影响复习记录保存</span>
          </div>
          <p>千问正在结合你刚才写下的答案、复习感受和这道题的原始信息，整理下一次可以检查的地方。</p>
        </div>
      `;
    }
    if (error) {
      return `
        <div class="stack-card ai-feedback-card is-error">
          <div class="ai-feedback-head">
            <div>
              <span class="badge amber">AI 复盘</span>
              <h4>本次复习已保存</h4>
            </div>
          </div>
          <p>${escapeHtml(error.message)}</p>
          <p class="field-tip">你仍可以根据自己的作答和便签继续复盘。</p>
        </div>
      `;
    }
    return `
      <div class="stack-card ai-feedback-card">
        <div class="ai-feedback-head">
          <div>
            <span class="badge blue">AI 复盘</span>
            <h4>这次复习，AI 看到了什么</h4>
          </div>
          <span class="field-tip">${escapeHtml(formatShort(feedback.generatedAt))}</span>
        </div>
        <div class="ai-feedback-grid">
          <div>
            <span class="ai-feedback-label">本次观察</span>
            <p>${escapeHtml(feedback.summary)}</p>
          </div>
          <div>
            <span class="ai-feedback-label">可能卡点</span>
            <p>${escapeHtml(feedback.likelyGap)}</p>
          </div>
          <div>
            <span class="ai-feedback-label">下次先检查</span>
            <p>${escapeHtml(feedback.nextCheck)}</p>
          </div>
          <div>
            <span class="ai-feedback-label">便签建议</span>
            <p>${escapeHtml(feedback.noteSuggestion)}</p>
          </div>
        </div>
        <p class="field-tip">这是基于本次作答的辅助判断，不替代你的理解。确认有用后，再把它改写进自己的便签。</p>
      </div>
    `;
  }

  function renderTraditionalNotice() {
    return `
      <div class="stack-card traditional-card">
        <div class="ai-feedback-head">
          <div>
            <span class="badge gray">传统错题本</span>
            <h4>这条错题不走 AI 复习</h4>
          </div>
        </div>
        <p>它只保存你上传的图片和自己写的便签。适合 AI 识图失败、整页截图暂时不想处理，或只想先把错题收进来的场景。</p>
        <p class="field-tip">后续需要 AI 分析时，可以重新裁剪题目区域再上传一遍。</p>
      </div>
    `;
  }

  function renderCreateResultNotice(result) {
    const isTraditional = result.mode === "traditional";
    return `
      <div class="review-result-banner is-created">
        <div>
          <strong>${isTraditional ? "已保存为传统错题" : "已确认入库"}</strong>
          <p>${escapeHtml(result.message || "这道错题已经加入错题库，并创建了第一次复习任务。")}</p>
        </div>
        <div class="result-actions">
          <button class="button button-primary button-pill" data-action="focus-note" data-id="${escapeAttr(result.id)}">补一句便签</button>
          ${isTraditional ? "" : `<button class="button button-secondary button-pill" data-action="start-review" data-id="${escapeAttr(result.id)}">开始复习</button>`}
        </div>
      </div>
    `;
  }

  function renderReviewResultNotice(result) {
    return `
      <div class="review-result-banner">
        <div>
          <strong>${escapeHtml(result.title)}</strong>
          <p>${escapeHtml(result.message)}</p>
        </div>
        <button class="button button-secondary button-pill" data-action="focus-note" data-id="${escapeAttr(result.id)}">补一句便签</button>
      </div>
    `;
  }

  function renderReviewView() {
    const queue = reviewQueue();
    const active = selectedReviewQuestion(queue) || selectedImmediateReviewQuestion();
    return `
      <div class="review-layout">
        <section class="page-panel review-sidebar">
          <div class="review-header">
            <div>
              <h2 class="section-title">今日队列</h2>
              <p class="section-desc">只显示已经确认且到期的错题。</p>
            </div>
            <span class="badge ${queue.length ? "amber" : "teal"}">${queue.length ? `${queue.length} 道待处理` : "今天已完成"}</span>
          </div>
          <div class="review-queue">
            ${queue.map((q, index) => renderReviewQueueItem(q, { index: index + 1, selected: active && active.id === q.id })).join("") || renderEmptyAction(
              "今天没有到期复习",
              state.questions.length ? "可以去错题库回看最近内容，或者继续上传新题。" : "先上传你的错题图片，确认入库后才会进入复习队列。",
              state.questions.length ? "去错题库" : "去首页上传",
              state.questions.length ? "goto-library" : "goto-home"
            )}
          </div>
        </section>

        <section class="review-card">
          ${
            active
              ? renderReviewForm(active)
              : renderEmptyAction(
                queue.length ? "选择一条待复习题" : "暂无作答面板",
                queue.length ? "选中左侧题目后，这里会出现作答、自评和折叠答案。" : "没有到期题时不会强行生成复习任务。",
                queue.length ? "去错题库" : "返回首页",
                queue.length ? "goto-library" : "goto-home"
              )
          }
        </section>
      </div>
    `;
  }

  function renderReviewQueueItem(q, options = {}) {
    const selected = Boolean(options.selected);
    return `
      <button class="review-queue-item ${selected ? "is-active" : ""}" data-action="open-review-question" data-id="${escapeAttr(q.id)}">
        <span class="queue-index">${options.index || 1}</span>
        <span class="queue-copy">
          <strong>${escapeHtml(q.title)}</strong>
          <span>${escapeHtml(normalizeSubject(q.subject))} · ${escapeHtml(formatDue(q.dueAt))}</span>
        </span>
      </button>
    `;
  }

  function selectedImmediateReviewQuestion() {
    if (!ui.selectedId) return null;
    const selected = questionById(ui.selectedId);
    if (!isReviewableQuestion(selected)) return null;
    return selected;
  }

  function renderReviewForm(q) {
    const submitting = ui.reviewSubmittingId === q.id;
    const steps = Array.isArray(q.steps) && q.steps.length
      ? q.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")
      : "<li>暂无关键步骤</li>";
    return `
      <div class="review-workbench-head">
        <div class="review-title-block">
          <span class="badge red">当前复习</span>
          <h2 class="section-title">${escapeHtml(q.title)}</h2>
          <p class="section-desc">${escapeHtml(normalizeSubject(q.subject))} · ${escapeHtml(formatDue(q.dueAt))}</p>
        </div>
        <button class="button button-secondary button-pill" data-action="goto-library">
          <span class="icon" data-icon="book"></span>
          查看详情
        </button>
      </div>

      <div class="review-focus-card">
        ${q.imageData ? `<img class="review-thumb" src="${q.imageData}" alt="${escapeAttr(q.title)}" />` : ""}
        <div>
          <div class="review-step-label"><span>1</span> 先看题目</div>
          <p class="review-question-text">${escapeHtml(q.stem || "暂无题干")}</p>
        </div>
      </div>

      <form class="review-input-group" id="reviewForm">
        <div class="review-step-card">
          <div class="review-step-label"><span>2</span> 写下你的答案或思路</div>
          <textarea class="answer-box" name="answer" placeholder="先写下你的答案或思路">${escapeHtml(ui.reviewAnswer || "")}</textarea>
        </div>

        <div class="review-step-card">
          <div class="review-step-label"><span>3</span> 需要时再看提示和答案</div>
          <div class="review-help-card">
            <div class="hint-strip">
              <span>提示</span>
              <p>${escapeHtml(q.hint || "暂无提示")}</p>
            </div>
            <details class="explain-layer">
              <summary>查看关键步骤</summary>
              <ol>${steps}</ol>
            </details>
            <details class="explain-layer">
              <summary>查看正确答案</summary>
              <p>${escapeHtml(q.correctAnswer || "暂无答案")}</p>
            </details>
            <details class="explain-layer">
              <summary>查看完整解析</summary>
              <p>${escapeHtml(q.solution || "暂无完整解析")}</p>
            </details>
          </div>
        </div>

        <div class="review-step-card">
          <div class="review-step-label"><span>4</span> 记录这次复习感受</div>
          <textarea class="note-box" name="reviewNote" placeholder="一句话写下这次为什么错 / 为什么会了">${escapeHtml(ui.reviewNote || "")}</textarea>
        </div>

        <div class="review-step-card">
          <div class="review-step-label"><span>5</span> 选择掌握程度</div>
        <div class="rating-row">
          ${renderRatingButton(q.id, "again")}
          ${renderRatingButton(q.id, "hard")}
          ${renderRatingButton(q.id, "good")}
          ${renderRatingButton(q.id, "easy")}
        </div>
        </div>

        <div class="form-actions">
          <button class="button button-primary" data-action="submit-review" data-id="${q.id}" ${submitting ? "disabled" : ""}>
            <span class="icon" data-icon="check"></span>
            ${submitting ? "提交中" : "提交复习"}
          </button>
          <button class="button button-ghost" data-action="start-review" data-id="${q.id}">
            <span class="icon" data-icon="refresh"></span>
            重新选题
          </button>
        </div>
        <div class="ai-review-teaser">
          <span class="badge blue">AI 复盘</span>
          <p>提交这次作答后，千问会根据你的答案和复习感受生成复盘，随后显示在这道题的详情页。</p>
        </div>
      </form>
    `;
  }

  function renderMeView() {
    const stats = computeStats();
    const subjectItems = topSubjects();
    const usage = currentAnalysisUsage();
    return `
      <div class="settings-grid">
        <section class="page-panel">
          <div class="section-head">
            <div>
              <h2 class="section-title">我的</h2>
              <p class="section-desc">本机数据、导出和设置都在这里。这个页面不讲概念，只管把事情收好。</p>
            </div>
            <span class="badge teal">本地保存</span>
          </div>

          <div class="settings-card">
            <div class="settings-row">
              <div class="mini-stat">
                <span class="muted">当前名称</span>
                <strong>${escapeHtml(state.profile.name)}</strong>
              </div>
              <div class="mini-stat">
                <span class="muted">学习目标</span>
                <strong>${escapeHtml(state.profile.classText)}</strong>
              </div>
            </div>

            <div class="grid-2">
              <div class="stack-card">
                <h4>数据概况</h4>
                <ul>
                  <li>已确认错题：${stats.confirmedCount}</li>
                  <li>待确认草稿：${stats.draftCount}</li>
                  <li>复习记录：${stats.reviewLogCount}</li>
                  <li>便签：${stats.noteCount}</li>
                </ul>
              </div>
              <div class="stack-card">
                <h4>科目记录</h4>
                <ul>
                  ${subjectItems.map((item) => `<li>${escapeHtml(item.name)} · ${item.count} 道</li>`).join("") || "<li>暂无数据</li>"}
                </ul>
              </div>
            </div>

            <div class="stack-card">
              <h4>试用分析保护</h4>
              <ul>
                <li>今日分析次数：${usage.count}/${usage.limit}</li>
                <li>当前状态：${state.trial.analysisDisabled ? "已停用" : "可使用"}</li>
              </ul>
              <label class="check-row">
                <input id="trialAnalysisDisabled" type="checkbox" ${state.trial.analysisDisabled ? "checked" : ""} />
                <span>暂时停用上传分析</span>
              </label>
            </div>

            <div class="form-inline">
              <div class="form-row">
                <label>你的名字</label>
                <input id="profileName" value="${escapeAttr(state.profile.name)}" />
              </div>
              <div class="form-row">
                <label>年级 / 目标</label>
                <input id="profileClassText" value="${escapeAttr(state.profile.classText)}" />
              </div>
            </div>

            <div class="form-row">
              <label>首页提示</label>
              <input id="profileGoal" value="${escapeAttr(state.profile.goal)}" />
            </div>

            <div class="form-row">
              <label>备注</label>
              <textarea id="profileNote">${escapeHtml(state.profile.note)}</textarea>
            </div>

            <div class="form-actions">
              <button class="button button-primary" data-action="save-profile">
                <span class="icon" data-icon="check"></span>
                保存设置
              </button>
              <button class="button button-secondary" data-action="download-json">
                <span class="icon" data-icon="download"></span>
                导出 JSON
              </button>
              <button class="button button-danger" data-action="clear-all">
                <span class="icon" data-icon="trash"></span>
                清空全部
              </button>
            </div>
          </div>
        </section>

        <section class="page-panel">
          <div class="section-head">
            <div>
              <h2 class="section-title">使用说明</h2>
              <p class="section-desc">这个版本先验证“上传 - 确认 - 入库 - 复习 - 便签”是否能顺畅跑通。</p>
            </div>
          </div>
          <div class="stack-card">
            <h4>现在能做什么</h4>
            <ul>
              <li>上传错题图片或文字，生成待确认草稿</li>
              <li>确认后进入错题库</li>
              <li>在复习页完成作答和自评</li>
              <li>保存自己的解题便签</li>
              <li>导出当前本机数据</li>
            </ul>
          </div>
          <div style="height: 12px"></div>
          <div class="stack-card">
            <h4>本地限制</h4>
            <ul>
              <li>图片只保存在当前浏览器</li>
              <li>没有真实 AI 服务端</li>
              <li>退出浏览器或清空数据会丢失本机内容</li>
            </ul>
          </div>
        </section>
      </div>
    `;
  }

  function summaryCard(label, value, title, note) {
    return `
      <div class="summary-card">
        <div class="summary-label">
          <span class="icon" data-icon="${label === "上传入口" ? "upload" : label === "复习压力" ? "review" : label === "本地草稿" ? "bookmark" : "note"}"></span>
          ${escapeHtml(label)}
        </div>
        <div class="summary-value">${escapeHtml(value)}</div>
        <div class="summary-note"><strong>${escapeHtml(title)}</strong><br />${escapeHtml(note)}</div>
      </div>
    `;
  }

  function renderQuestionCard(q, options = {}) {
    const meta = questionStatusMeta(q);
    const traditional = isTraditionalQuestion(q);
    const dueText = traditional ? "传统错题" : q.dueAt ? formatDue(q.dueAt) : options.draft ? "待确认" : "未排期";
    const selectedClass = options.selected ? " is-selected" : "";
    const traditionalClass = traditional ? " is-traditional" : "";
    const thumb = q.imageData
      ? `<img class="question-thumb" src="${q.imageData}" alt="${escapeAttr(q.title)}" />`
      : `<div class="question-thumb preview-image placeholder">无图</div>`;
    const mainAction = options.reviewMode
      ? `<button class="button button-primary button-pill" data-action="open-review-question" data-id="${q.id}">去复习</button>`
      : options.draft
        ? `<button class="button button-primary button-pill" data-action="confirm-question" data-id="${q.id}">确认</button>`
        : `<button class="button button-secondary button-pill" data-action="open-question" data-id="${q.id}">详情</button>`;
    const secondaryAction = options.actions && !traditional
      ? `<button class="button button-ghost button-pill" data-action="start-review" data-id="${q.id}">复习</button>`
      : "";
    return `
      <article class="question-card${selectedClass}${traditionalClass}">
        ${thumb}
        <div class="question-body">
          <h3 class="question-title">${escapeHtml(q.title)}</h3>
          <div class="question-meta">
            <span class="badge ${meta.badge}">${meta.label}</span>
            <span class="badge gray">${escapeHtml(normalizeSubject(q.subject))}</span>
            <span class="badge ${traditional ? "gray" : q.status === "draft" ? "amber" : q.dueAt && isDue(q.dueAt) ? "red" : "teal"}">${escapeHtml(dueText)}</span>
          </div>
          <div class="question-summary">${escapeHtml(q.stem || "暂无题干")}</div>
        </div>
        <div class="question-actions">
          ${mainAction}
          ${secondaryAction}
        </div>
      </article>
    `;
  }

  function renderRatingButton(questionId, key) {
    const meta = REVIEW_RATINGS[key];
    return `
      <button class="button button-secondary" data-action="pick-rating" data-id="${questionId}" data-rating="${key}">
        ${meta.label}
      </button>
    `;
  }

  function renderChip(label, value) {
    const active = ui.statusFilter === value ? "is-active" : "";
    return `<button class="chip ${active}" data-chip="${value}">${escapeHtml(label)}</button>`;
  }

  function renderOptions(options, current) {
    const normalized = options.map((option) =>
      typeof option === "string" ? { value: option, label: option } : option
    );
    return normalized
      .map((option) => {
        const value = option.value;
        const label = option.label;
        const selected = value === current ? "selected" : "";
        return `<option value="${escapeAttr(value)}" ${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");
  }

  function syncDraftPreview() {
    const draft = ui.draft;
    if (!draft) return;
    const form = document.getElementById("draftForm");
    if (!form) return;
    form.addEventListener("submit", (event) => event.preventDefault(), { once: true });
  }

  function syncReviewState() {
    const reviewForm = document.getElementById("reviewForm");
    if (!reviewForm) return;
    reviewForm.addEventListener("submit", (event) => event.preventDefault(), { once: true });
  }

  function handleClick(event) {
    const tabButton = event.target.closest("[data-tab]");
    if (tabButton) {
      event.preventDefault();
      if (!hasAccess()) {
        ui.view = "home";
        ui.accessError = "请先完成受控试用告知。";
        render();
        return;
      }
      setView(tabButton.dataset.tab);
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    const id = actionButton.dataset.id;

    if (action === "accept-access") {
      event.preventDefault();
      acceptAccess();
      return;
    }
    if (action === "dismiss-storage-notice") {
      event.preventDefault();
      ui.storageNotice = null;
      render();
      return;
    }

    if (!hasAccess()) {
      event.preventDefault();
      ui.accessError = "请先输入试用口令并确认告知。";
      render();
      return;
    }

    if (action === "pick-upload") {
      event.preventDefault();
      fileInput.click();
      return;
    }
    if (action === "retry-analysis") {
      event.preventDefault();
      if (!ui.analysisError) return;
      if (ui.analysisError.adapter === "qwen" && ui.analysisError.imageData) {
        startRemoteAnalysis(ui.analysisError.fileName || "重试图片", ui.analysisError.imageData);
      } else {
        startMockAnalysis(ui.analysisError.fileName || "重试样本", ui.analysisError.imageData, { forceInvalid: false });
      }
      return;
    }
    if (action === "analyze-crop") {
      event.preventDefault();
      void analyzeCropperSelection();
      return;
    }
    if (action === "analyze-whole-image") {
      event.preventDefault();
      analyzeWholeCropperImage();
      return;
    }
    if (action === "cancel-cropper") {
      event.preventDefault();
      ui.cropper = null;
      ui.uploadError = null;
      render();
      return;
    }
    if (action === "manual-draft") {
      event.preventDefault();
      if (!ui.analysisError) return;
      const failedFileName = ui.analysisError.fileName;
      const failedImageData = ui.analysisError.imageData;
      ui.analysisError = null;
      ui.processing = null;
      ui.cropper = null;
      ui.draft = createManualDraft(failedFileName || "手动草稿", failedImageData || null);
      render();
      return;
    }
    if (action === "save-traditional-question") {
      event.preventDefault();
      saveTraditionalQuestionFromError();
      return;
    }
    if (action === "create-text-draft") {
      event.preventDefault();
      const input = document.getElementById("textUploadStem");
      const stem = sanitize(input?.value || "");
      if (!stem) {
        ui.uploadError = {
          code: "text_missing",
          message: "请先输入或粘贴题干，再创建文字错题。"
        };
        ui.analysisError = null;
        ui.processing = null;
        render();
        return;
      }
      ui.uploadError = null;
      ui.analysisError = null;
      ui.processing = null;
      ui.cropper = null;
      ui.draft = createTextDraft(stem);
      render();
      return;
    }
    if (action === "clear-draft") {
      event.preventDefault();
      ui.draft = null;
      ui.cropper = null;
      ui.processing = null;
      ui.analysisError = null;
      ui.uploadError = null;
      render();
      return;
    }
    if (action === "show-drafts") {
      event.preventDefault();
      ui.statusFilter = "draft";
      setView("library");
      return;
    }
    if (action === "save-draft" || action === "save-and-confirm") {
      event.preventDefault();
      saveDraft(action === "save-and-confirm");
      return;
    }
    if (action === "confirm-question") {
      event.preventDefault();
      confirmQuestion(id);
      return;
    }
    if (action === "delete-question") {
      event.preventDefault();
      deleteQuestion(id);
      return;
    }
    if (action === "archive-question") {
      event.preventDefault();
      archiveQuestion(id);
      return;
    }
    if (action === "start-review" || action === "open-review-question") {
      event.preventDefault();
      const q = questionById(id);
      if (isTraditionalQuestion(q)) {
        ui.selectedId = q.id;
        setView("library");
        return;
      }
      if (q) {
        ui.selectedId = q.id;
        ui.reviewAnswer = "";
        ui.reviewNote = "";
        ui.reviewResult = null;
        setView("review");
      }
      return;
    }
    if (action === "open-question") {
      event.preventDefault();
      ui.selectedId = id;
      setView("library");
      return;
    }
    if (action === "goto-review") {
      event.preventDefault();
      setView("review");
      return;
    }
    if (action === "goto-library") {
      event.preventDefault();
      setView("library");
      return;
    }
    if (action === "goto-home") {
      event.preventDefault();
      setView("home");
      return;
    }
    if (action === "save-note") {
      event.preventDefault();
      const noteField = document.querySelector(`[data-note-for="${id}"]`);
      saveNote(id, noteField ? noteField.value : "");
      return;
    }
    if (action === "focus-note") {
      event.preventDefault();
      const noteField = document.querySelector(`[data-note-for="${id}"]`);
      if (noteField) {
        noteField.focus();
        noteField.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    if (action === "submit-review") {
      event.preventDefault();
      void submitReview(id, actionButton);
      return;
    }
    if (action === "pick-rating") {
      event.preventDefault();
      const rating = actionButton.dataset.rating;
      pickRating(id, rating);
      return;
    }
    if (action === "save-profile") {
      event.preventDefault();
      saveProfile();
      return;
    }
    if (action === "download-json") {
      event.preventDefault();
      downloadJson();
      return;
    }
    if (action === "clear-all") {
      event.preventDefault();
      clearAll();
      return;
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (target.matches("[data-filter='search']")) {
      ui.search = target.value;
      render();
      return;
    }
    if (target.matches("#profileName, #profileClassText, #profileGoal, #profileNote")) {
      return;
    }
    if (target.matches("[data-note-for]")) {
      ui.noteFeedback = {
        id: target.dataset.noteFor,
        type: "dirty",
        message: "有未保存修改。"
      };
      ui.reviewResult = ui.reviewResult && ui.reviewResult.id === target.dataset.noteFor ? null : ui.reviewResult;
      const status = target.parentElement?.querySelector(".note-status");
      if (status) {
        status.textContent = ui.noteFeedback.message;
        status.className = "note-status is-dirty";
      }
      return;
    }
    if (target.matches("#reviewForm textarea[name='answer']")) {
      ui.reviewAnswer = target.value;
      return;
    }
    if (target.matches("#reviewForm textarea[name='reviewNote']")) {
      ui.reviewNote = target.value;
      return;
    }
    if (target.matches("[data-crop-field]")) {
      updateCropperSelection(target.dataset.cropField, target.value);
      return;
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target.matches("#fileInput")) {
      return;
    }
    if (target.matches("[data-filter='status']")) {
      ui.statusFilter = target.value;
      render();
      return;
    }
    if (target.matches("select[name='knowledge'], select[name='subject'], select[name='errorType']")) {
      return;
    }
  }

  function handleDragOver(event) {
    if (!hasAccess()) return;
    if (ui.view !== "home") return;
    event.preventDefault();
    ui.dragOver = true;
    renderHomeOnly();
  }

  function handleDragLeave() {
    if (!ui.dragOver) return;
    ui.dragOver = false;
    renderHomeOnly();
  }

  function handleDrop(event) {
    if (!hasAccess()) return;
    if (ui.view !== "home") return;
    event.preventDefault();
    ui.dragOver = false;
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
      acceptFile(file);
    } else {
      renderHomeOnly();
    }
  }

  function handleCropPointerDown(event) {
    startCropDrag(event, { pointerId: event.pointerId });
  }

  function handleCropMouseDown(event) {
    if (ui.cropDrag || event.button !== 0) return;
    startCropDrag(event);
  }

  function startCropDrag(event, options = {}) {
    if (!ui.cropper) return;
    const handle = event.target.closest("[data-crop-handle]");
    const mover = event.target.closest("[data-crop-drag='move']");
    if (!handle && !mover) return;
    const preview = event.target.closest(".cropper-preview");
    if (!preview) return;
    const rect = preview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    event.preventDefault();
    ui.cropDrag = {
      mode: handle ? handle.dataset.cropHandle : "move",
      startX: event.clientX,
      startY: event.clientY,
      previewWidth: rect.width,
      previewHeight: rect.height,
      startSelection: normalizeCropSelection(ui.cropper.selection)
    };
    document.body.classList.add("is-cropping");
    if (options.pointerId !== undefined && event.target.setPointerCapture) {
      try {
        event.target.setPointerCapture(options.pointerId);
      } catch (error) {
        // Pointer capture is best-effort; window listeners still keep dragging usable.
      }
    }
  }

  function handleCropPointerMove(event) {
    updateCropDrag(event);
  }

  function handleCropMouseMove(event) {
    updateCropDrag(event);
  }

  function updateCropDrag(event) {
    if (!ui.cropDrag || !ui.cropper) return;
    event.preventDefault();
    const deltaX = ((event.clientX - ui.cropDrag.startX) / ui.cropDrag.previewWidth) * 100;
    const deltaY = ((event.clientY - ui.cropDrag.startY) / ui.cropDrag.previewHeight) * 100;
    ui.cropper.selection = selectionFromDrag(ui.cropDrag.startSelection, ui.cropDrag.mode, deltaX, deltaY);
    syncCropperDom(ui.cropper.selection);
  }

  function handleCropPointerUp() {
    if (!ui.cropDrag) return;
    ui.cropDrag = null;
    document.body.classList.remove("is-cropping");
  }

  function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (file) {
      acceptFile(file);
    }
    event.target.value = "";
  }

  function handleShortcut(event) {
    if (!hasAccess()) return;
    if (event.key === "1") setView("home");
    if (event.key === "2") setView("library");
    if (event.key === "3") setView("review");
    if (event.key === "4") setView("me");
  }

  function acceptAccess() {
    const code = sanitize(document.getElementById("accessCode")?.value).toLowerCase();
    const noticeAccepted = Boolean(document.getElementById("accessNotice")?.checked);
    if (code !== TRIAL_ACCESS_CODE) {
      ui.accessError = "试用口令不正确。";
      render();
      return;
    }
    if (!noticeAccepted) {
      ui.accessError = "请先确认你已理解试用边界。";
      render();
      return;
    }
    ui.accessError = "";
    state.access = {
      granted: true,
      noticeAcceptedAt: new Date().toISOString()
    };
    void persist();
    render();
  }

  async function acceptFile(file) {
    if (!hasAccess()) {
      ui.accessError = "请先完成受控试用告知。";
      render();
      return;
    }
    const validation = validateUploadFile(file);
    if (!validation.ok) {
      ui.view = "home";
      ui.draft = null;
      ui.processing = null;
      ui.analysisError = null;
      ui.uploadError = {
        code: validation.code,
        message: validation.message,
        fileName: file.name || "未命名文件"
      };
      render();
      return;
    }
    try {
      const dataUrl = await compressImage(file);
      await prepareCropper(file.name || "错题图片", dataUrl, {
        adapter: isLikelyInvalidTrialFile(file.name) ? "mock" : "qwen",
        forceInvalid: isLikelyInvalidTrialFile(file.name)
      });
    } catch (error) {
      ui.view = "home";
      ui.draft = null;
      ui.cropper = null;
      ui.processing = null;
      ui.analysisError = null;
      ui.uploadError = {
        code: "image_read_failed",
        message: "图片读取失败，请重新选择一张清晰图片。",
        fileName: file.name || "未命名文件"
      };
      render();
    }
  }

  async function prepareCropper(fileName, imageData, options = {}) {
    const image = await loadImage(imageData);
    ui.view = "home";
    ui.draft = null;
    ui.processing = null;
    ui.analysisError = null;
    ui.uploadError = null;
    ui.cropper = {
      fileName,
      imageData,
      naturalWidth: image.width,
      naturalHeight: image.height,
      selection: defaultCropSelection(),
      forceInvalid: Boolean(options.forceInvalid),
      adapter: options.adapter || "qwen"
    };
    render();
    window.setTimeout(() => {
      document.querySelector(".cropper-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function defaultCropSelection() {
    return {
      x: 6,
      y: 6,
      width: 88,
      height: 70
    };
  }

  function updateCropperSelection(field, value) {
    if (!ui.cropper) return;
    const next = {
      ...ui.cropper.selection,
      [field]: Number(value)
    };
    ui.cropper.selection = normalizeCropSelection(next);
    renderHomeOnly();
  }

  function selectionFromDrag(startSelection, mode, deltaX, deltaY) {
    const start = normalizeCropSelection(startSelection);
    const right = start.x + start.width;
    const bottom = start.y + start.height;
    const minSize = 15;
    if (mode === "move") {
      return normalizeCropSelection({
        x: start.x + deltaX,
        y: start.y + deltaY,
        width: start.width,
        height: start.height
      });
    }

    const next = { ...start };
    if (mode.includes("w")) {
      next.x = clampNumber(start.x + deltaX, 0, right - minSize);
      next.width = right - next.x;
    }
    if (mode.includes("e")) {
      next.width = clampNumber(start.width + deltaX, minSize, 100 - start.x);
    }
    if (mode.includes("n")) {
      next.y = clampNumber(start.y + deltaY, 0, bottom - minSize);
      next.height = bottom - next.y;
    }
    if (mode.includes("s")) {
      next.height = clampNumber(start.height + deltaY, minSize, 100 - start.y);
    }
    return normalizeCropSelection(next);
  }

  function syncCropperDom(selection) {
    const root = document.querySelector(".cropper-panel");
    if (!root) return;
    const normalized = normalizeCropSelection(selection);
    const selectionEl = root.querySelector(".cropper-selection");
    if (selectionEl) {
      selectionEl.style.left = `${normalized.x}%`;
      selectionEl.style.top = `${normalized.y}%`;
      selectionEl.style.width = `${normalized.width}%`;
      selectionEl.style.height = `${normalized.height}%`;
    }
    const shadeTop = root.querySelector(".cropper-shade-top");
    const shadeBottom = root.querySelector(".cropper-shade-bottom");
    const shadeLeft = root.querySelector(".cropper-shade-left");
    const shadeRight = root.querySelector(".cropper-shade-right");
    if (shadeTop) shadeTop.style.height = `${normalized.y}%`;
    if (shadeBottom) shadeBottom.style.top = `${normalized.y + normalized.height}%`;
    if (shadeLeft) {
      shadeLeft.style.top = `${normalized.y}%`;
      shadeLeft.style.width = `${normalized.x}%`;
      shadeLeft.style.height = `${normalized.height}%`;
    }
    if (shadeRight) {
      shadeRight.style.top = `${normalized.y}%`;
      shadeRight.style.left = `${normalized.x + normalized.width}%`;
      shadeRight.style.height = `${normalized.height}%`;
    }
    root.querySelectorAll("[data-crop-field]").forEach((input) => {
      const field = input.dataset.cropField;
      if (field && Object.prototype.hasOwnProperty.call(normalized, field)) {
        input.value = normalized[field];
      }
    });
    const readout = root.querySelector(".cropper-selection-readout");
    if (readout) readout.textContent = cropSelectionText(normalized);
  }

  function cropSelectionText(selection) {
    const normalized = normalizeCropSelection(selection);
    return `当前选区：左 ${normalized.x}% · 上 ${normalized.y}% · 宽 ${normalized.width}% · 高 ${normalized.height}%`;
  }

  async function analyzeCropperSelection() {
    if (!ui.cropper) return;
    const cropper = ui.cropper;
    try {
      const imageData = await cropImageData(cropper.imageData, cropper.selection);
      ui.cropper = null;
      if (cropper.adapter === "mock") {
        startMockAnalysis(croppedFileName(cropper.fileName), imageData, { forceInvalid: cropper.forceInvalid });
      } else {
        startRemoteAnalysis(croppedFileName(cropper.fileName), imageData);
      }
    } catch (error) {
      ui.uploadError = {
        code: "crop_failed",
        message: "选中区域截取失败，请重新选择图片，或先使用整张图分析。",
        fileName: cropper.fileName
      };
      render();
    }
  }

  function analyzeWholeCropperImage() {
    if (!ui.cropper) return;
    const cropper = ui.cropper;
    ui.cropper = null;
    if (cropper.adapter === "mock") {
      startMockAnalysis(cropper.fileName, cropper.imageData, { forceInvalid: cropper.forceInvalid });
    } else {
      startRemoteAnalysis(cropper.fileName, cropper.imageData);
    }
  }

  async function cropImageData(imageData, selection) {
    const image = await loadImage(imageData);
    const normalized = normalizeCropSelection(selection);
    let sx = Math.round((normalized.x / 100) * image.width);
    let sy = Math.round((normalized.y / 100) * image.height);
    let sw = Math.round((normalized.width / 100) * image.width);
    let sh = Math.round((normalized.height / 100) * image.height);
    sx = clampNumber(sx, 0, Math.max(0, image.width - 1));
    sy = clampNumber(sy, 0, Math.max(0, image.height - 1));
    sw = clampNumber(sw, 1, Math.max(1, image.width - sx));
    sh = clampNumber(sh, 1, Math.max(1, image.height - sy));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/jpeg", 0.84);
  }

  function croppedFileName(fileName) {
    const normalized = String(fileName || "question.jpg").replace(/\.[^.]+$/, "");
    return `${normalized}-selected.jpg`;
  }

  function normalizeCropSelection(selection = {}) {
    let width = Number.isFinite(Number(selection.width)) ? Number(selection.width) : 88;
    let height = Number.isFinite(Number(selection.height)) ? Number(selection.height) : 70;
    width = clampNumber(width, 15, 100);
    height = clampNumber(height, 15, 100);
    let x = Number.isFinite(Number(selection.x)) ? Number(selection.x) : 6;
    let y = Number.isFinite(Number(selection.y)) ? Number(selection.y) : 6;
    x = clampNumber(x, 0, 100 - width);
    y = clampNumber(y, 0, 100 - height);
    width = clampNumber(Math.round(width), 15, 100);
    height = clampNumber(Math.round(height), 15, 100);
    x = clampNumber(Math.round(x), 0, 100 - width);
    y = clampNumber(Math.round(y), 0, 100 - height);
    return { x, y, width, height };
  }

  function startMockAnalysis(fileName, imageData, options = {}) {
    startTrialAnalysis(fileName, imageData, { ...options, adapter: "mock" });
  }

  function startRemoteAnalysis(fileName, imageData, options = {}) {
    startTrialAnalysis(fileName, imageData, { ...options, adapter: "qwen" });
  }

  function startTrialAnalysis(fileName, imageData, options = {}) {
    const guard = analysisGuardStatus();
    if (!guard.ok) {
      ui.view = "home";
      ui.draft = null;
      ui.cropper = null;
      ui.processing = null;
      ui.uploadError = null;
      ui.analysisError = {
        code: guard.code,
        message: guard.message,
        details: guard.details,
        requestId: null,
        fileName,
        imageData,
        adapter: options.adapter || "mock"
      };
      render();
      return;
    }
    if ((options.adapter || "mock") === "mock") {
      registerAnalysisAttempt();
    }
    ui.view = "home";
    ui.draft = null;
    ui.cropper = null;
    ui.analysisError = null;
    ui.uploadError = null;
    ui.processing = {
      id: uid("job"),
      fileName,
      imageData,
      stage: "quality",
      startedAt: new Date().toISOString(),
      forceInvalid: !!options.forceInvalid,
      adapter: options.adapter || "mock"
    };
    const jobId = ui.processing.id;
    render();
    window.setTimeout(() => {
      if (!ui.processing || ui.processing.id !== jobId) return;
      ui.processing.stage = "structure";
      render();
    }, 420);

    if (ui.processing.adapter === "qwen") {
      void completeRemoteAnalysis(jobId, fileName, imageData);
      return;
    }

    window.setTimeout(() => {
      if (!ui.processing || ui.processing.id !== jobId) return;
      const raw = buildMockTrialAnalysisResponse(fileName, imageData, ui.processing.forceInvalid);
      const validation = validateTrialAnalysisResponse(raw);
      if (!validation.ok) {
        ui.processing = null;
        ui.draft = null;
        ui.analysisError = buildTrialAnalysisError(fileName, imageData, validation, raw?.request_id || null, "mock");
        render();
        return;
      }
      ui.draft = buildTrialDraftFromAnalysis(validation.data, fileName, imageData);
      ui.processing = null;
      ui.analysisError = null;
      render();
    }, 900);
  }

  async function completeRemoteAnalysis(jobId, fileName, imageData) {
    registerAnalysisAttempt();
    try {
      const raw = await requestTrialAnalysis(fileName, imageData);
      if (!ui.processing || ui.processing.id !== jobId) return;
      const validation = validateTrialAnalysisResponse(raw);
      if (!validation.ok) {
        refundAnalysisAttempt();
        ui.processing = null;
        ui.draft = null;
        ui.analysisError = buildTrialAnalysisError(fileName, imageData, validation, raw?.request_id || null, "qwen");
        render();
        return;
      }
      ui.draft = buildTrialDraftFromAnalysis(validation.data, fileName, imageData);
      ui.processing = null;
      ui.analysisError = null;
      render();
    } catch (error) {
      if (!ui.processing || ui.processing.id !== jobId) return;
      refundAnalysisAttempt();
      ui.processing = null;
      ui.draft = null;
      ui.analysisError = {
        code: "model_failed",
        message: "没有连上本地分析服务。请确认用 node server.mjs 启动本地应用后再上传。",
        details: ["服务端负责保管千问 Key，直接打开 HTML 或只用静态服务时不能调用真实模型。"],
        requestId: null,
        fileName,
        imageData,
        adapter: "qwen"
      };
      render();
    }
  }

  async function requestTrialAnalysis(fileName, imageData) {
    const imageBlob = await dataUrlToBlob(imageData);
    const form = new FormData();
    form.append("image", imageBlob, fileName || "question.png");
    form.append("consent_version", TRIAL_CONSENT_VERSION);
    const response = await fetch("/api/trial/analyze", {
      method: "POST",
      body: form
    });
    const payload = await response.json().catch(() => null);
    if (payload) return payload;
    return {
      error: {
        code: response.ok ? "schema_failed" : "model_failed",
        message: "分析服务返回格式不正确，请重试或手动填写。",
        details: {}
      },
      request_id: uid("trial_req")
    };
  }

  async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
  }

  function currentAnalysisUsage() {
    state.trial = normalizeTrialControl(state.trial);
    return state.trial.dailyAnalysis;
  }

  function analysisGuardStatus() {
    const usage = currentAnalysisUsage();
    if (state.trial.analysisDisabled) {
      return {
        ok: false,
        code: "service_disabled",
        message: "当前试用分析开关已停用。你仍可以查看、复习和导出已有错题。",
        details: ["可在“我的”页面重新开启试用分析。"]
      };
    }
    if (usage.count >= usage.limit) {
      return {
        ok: false,
        code: "rate_limited",
        message: `今天已完成 ${usage.count}/${usage.limit} 次试用分析。请明天再继续，或先整理已有错题。`,
        details: ["这个限制用于受控试用，避免真实模型接入后成本失控。"]
      };
    }
    return { ok: true };
  }

  function registerAnalysisAttempt() {
    const usage = currentAnalysisUsage();
    usage.count = Math.min(usage.limit, usage.count + 1);
    void persist();
  }

  function refundAnalysisAttempt() {
    const usage = currentAnalysisUsage();
    usage.count = Math.max(0, usage.count - 1);
    void persist();
  }

  function remainingAnalysisCount() {
    const usage = currentAnalysisUsage();
    return Math.max(0, usage.limit - usage.count);
  }

  function buildTrialDraftFromAnalysis(data, fileName = "新题图片", imageData = null) {
    const knowledge = data.knowledge_tags[0] || "AI 暂无参考";
    const title = draftTitleFromStem(data.stem) || "新错题草稿";
    return buildQuestion({
      title,
      subject: subjectFromKnowledge(knowledge) || "数学",
      knowledge,
      errorType: TRIAL_ERROR_TYPE_LABELS[data.error_type] || "信息不足",
      stem: data.stem,
      studentAnswer: data.student_answer ?? "",
      correctAnswer: data.correct_answer ?? "",
      hint: data.explanation.hint,
      steps: data.explanation.key_steps,
      solution: data.explanation.full_solution,
      note: "",
      status: "draft",
      dueAt: null,
      riskFlags: data.risk_flags,
      imageData: imageData || seedImage(title, "#1f7c72", "#e6f3f1")
    });
  }

  function draftTemplateFromName(fileName) {
    const index = hashString(fileName) % 5;
    const templates = [
      {
        title: "一元一次方程",
        subject: "方程",
        knowledge: "一元一次方程",
        errorType: "符号错误",
        stem: "3x + 4 = 19，求 x。",
        studentAnswer: "x = 4",
        correctAnswer: "x = 5",
        hint: "先把常数项移到右边。",
        steps: ["3x = 15", "x = 5"],
        solution: "移项后再除以 3。",
        note: "我容易把加号看成减号。"
      },
      {
        title: "一次函数代入",
        subject: "函数",
        knowledge: "一次函数",
        errorType: "审题偏差",
        stem: "已知 y = 2x - 1，求 x = 3 时的 y。",
        studentAnswer: "y = 5",
        correctAnswer: "y = 5",
        hint: "直接代入即可。",
        steps: ["2 × 3 - 1", "5"],
        solution: "别漏掉括号。",
        note: "先写代入，再写结果。"
      },
      {
        title: "平方差公式",
        subject: "代数",
        knowledge: "因式分解",
        errorType: "计算失误",
        stem: "分解 x² - 9。",
        studentAnswer: "(x - 3)(x + 3)",
        correctAnswer: "(x - 3)(x + 3)",
        hint: "这是平方差公式。",
        steps: ["a² - b² = (a - b)(a + b)"],
        solution: "x² - 9 = x² - 3²。",
        note: "平方差公式要背熟。"
      },
      {
        title: "概率入门",
        subject: "统计",
        knowledge: "概率与统计",
        errorType: "步骤遗漏",
        stem: "一袋中有 3 个红球、2 个蓝球，随机取 1 个球，求取到蓝球的概率。",
        studentAnswer: "2/5",
        correctAnswer: "2/5",
        hint: "总数和蓝球数都要写。",
        steps: ["总数 = 5", "蓝球 = 2", "概率 = 2/5"],
        solution: "按定义写分数。",
        note: "别忘了写总数。"
      },
      {
        title: "整式运算",
        subject: "代数",
        knowledge: "整式运算",
        errorType: "概念不清",
        stem: "化简 2(a + 3) - a。",
        studentAnswer: "a + 6",
        correctAnswer: "a + 6",
        hint: "先展开括号，再合并同类项。",
        steps: ["2a + 6 - a", "a + 6"],
        solution: "展开后再合并。",
        note: "括号展开要稳一点。"
      }
    ];
    return templates[index];
  }

  async function compressImage(file) {
    const dataUrl = await readFileAsDataUrl(file);
    if (!dataUrl) return null;
    const image = await loadImage(dataUrl);
    const maxWidth = 1200;
    const scale = image.width > maxWidth ? maxWidth / image.width : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function saveDraft(confirmAfterSave = false) {
    const form = document.getElementById("draftForm");
    if (!ui.draft || !form) {
      alert("请先上传错题图片、输入文字，或生成草稿。");
      return;
    }
    const data = readFormData(form, ui.draft);
    const question = buildQuestion({
      ...ui.draft,
      ...data,
      status: confirmAfterSave ? "confirmed" : "draft",
      dueAt: confirmAfterSave ? computeInitialDue() : null,
      createdAt: ui.draft.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reviewCount: ui.draft.reviewCount || 0,
      history: ui.draft.history || []
    });
    if (confirmAfterSave) {
      question.dueAt = computeInitialDue();
      question.confirmedAt = new Date().toISOString();
    }
    state.questions = [question, ...state.questions.filter((item) => item.id !== question.id)];
    ui.draft = null;
    ui.selectedId = question.id;
    if (confirmAfterSave) {
      ui.statusFilter = "confirmed";
      ui.createResult = {
        id: question.id,
        message: "这道错题已经加入错题库，并创建了第一次复习任务。现在可以补一句自己的理解，或者直接开始复习。"
      };
    } else {
      ui.createResult = null;
    }
    ui.view = confirmAfterSave ? "library" : "home";
    void persist();
    render();
    if (confirmAfterSave) {
      ui.selectedId = question.id;
      setView("library");
    }
  }

  function saveTraditionalQuestionFromError() {
    if (!ui.analysisError || !ui.analysisError.imageData) return;
    const question = createTraditionalQuestion(
      ui.analysisError.fileName || "传统错题",
      ui.analysisError.imageData
    );
    question.updatedAt = new Date().toISOString();
    state.questions = [question, ...state.questions.filter((item) => item.id !== question.id)];
    ui.analysisError = null;
    ui.processing = null;
    ui.cropper = null;
    ui.draft = null;
    ui.selectedId = question.id;
    ui.statusFilter = "traditional";
    ui.createResult = {
      id: question.id,
      mode: "traditional",
      message: "已保存为传统错题。它只保留原图和你的便签，不生成 AI 分析，也不进入 AI 复习区。"
    };
    ui.view = "library";
    void persist();
    render();
  }

  function readFormData(form, fallback) {
    const formData = new FormData(form);
    return {
      title: sanitize(formData.get("title")) || fallback.title,
      subject: normalizeSubject(sanitize(formData.get("subject")) || fallback.subject),
      knowledge: sanitize(formData.get("knowledge")) || fallback.knowledge,
      errorType: sanitize(formData.get("errorType")) || fallback.errorType,
      stem: sanitize(formData.get("stem")) || fallback.stem,
      studentAnswer: sanitize(formData.get("studentAnswer")) || fallback.studentAnswer,
      correctAnswer: sanitize(formData.get("correctAnswer")) || fallback.correctAnswer,
      hint: sanitize(formData.get("hint")) || fallback.hint,
      note: sanitize(formData.get("note")) || fallback.note,
      steps: fallback.steps || [],
      solution: fallback.solution || "",
      imageData: fallback.imageData || null,
      archived: fallback.archived || false
    };
  }

  function sanitize(value) {
    return String(value || "").trim();
  }

  function confirmQuestion(id) {
    const question = questionById(id);
    if (!question) return;
    question.status = "confirmed";
    question.confirmedAt = new Date().toISOString();
    question.dueAt = isTraditionalQuestion(question) ? null : computeInitialDue();
    question.updatedAt = new Date().toISOString();
    ui.statusFilter = isTraditionalQuestion(question) ? "traditional" : "confirmed";
    ui.selectedId = question.id;
    void persist();
    render();
  }

  function archiveQuestion(id) {
    const question = questionById(id);
    if (!question) return;
    question.status = "archived";
    question.updatedAt = new Date().toISOString();
    void persist();
    render();
  }

  function deleteQuestion(id) {
    const question = questionById(id);
    if (!question) return;
    if (!confirm(`删除「${question.title}」？这个操作无法恢复。`)) return;
    state.questions = state.questions.filter((item) => item.id !== id);
    const nextList = filteredQuestions();
    ui.selectedId = nextList[0] ? nextList[0].id : null;
    void persist();
    render();
  }

  async function saveNote(id, note) {
    const question = questionById(id);
    if (!question) return;
    question.note = sanitize(note);
    question.updatedAt = new Date().toISOString();
    const result = await persist();
    ui.noteFeedback = {
      id,
      type: result.ok ? "saved" : "error",
      message: result.ok ? `已保存：${formatShort(question.updatedAt)}` : "便签暂时没有保存成功，请稍后重试。"
    };
    if (result.ok && ui.reviewResult && ui.reviewResult.id === id) {
      ui.reviewResult = null;
    }
    render();
  }

  function pickRating(id, rating) {
    ui.reviewAnswer = ui.reviewAnswer || "";
    ui.reviewNote = ui.reviewNote || "";
    const form = document.getElementById("reviewForm");
    if (form) {
      form.dataset.rating = rating;
      Array.from(form.querySelectorAll(".rating-row button")).forEach((button) => {
        button.classList.toggle("button-primary", button.dataset.rating === rating);
        button.classList.toggle("button-secondary", button.dataset.rating !== rating);
      });
    }
  }

  async function submitReview(id, button = null) {
    if (ui.reviewSubmittingId === id) return;
    const question = questionById(id);
    if (!question) return;
    ui.reviewSubmittingId = id;
    if (button) {
      button.disabled = true;
      button.textContent = "提交中";
    }
    const form = document.getElementById("reviewForm");
    const rating = (form && form.dataset.rating) || "good";
    const answer = ui.reviewAnswer || "";
    const note = ui.reviewNote || "";
    const config = REVIEW_RATINGS[rating] || REVIEW_RATINGS.good;
    const now = new Date();
    const reviewedAt = now.toISOString();
    const intervalDays = Math.max(1, Math.round((question.reviewCount || 0) + config.days));
    const nextDue = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);
    const ease = Math.min(0.95, Math.max(0.08, (question.ease || 0.3) + config.intensity - 0.15));

    question.reviewCount = (question.reviewCount || 0) + 1;
    question.ease = ease;
    question.lastReviewedAt = reviewedAt;
    question.dueAt = nextDue.toISOString();
    question.history = [
      {
        id: uid("r"),
        rating,
        note: note || answer || "已提交复习",
        reviewedAt,
        duration: Math.max(12, Math.round((answer.length + note.length) * 0.6))
      },
      ...(question.history || [])
    ];
    question.updatedAt = reviewedAt;
    question.status = "confirmed";
    ui.reviewAnswer = "";
    ui.reviewNote = "";
    ui.reviewResult = {
      id: question.id,
      title: "复习已记录",
      message: `本次自评：${ratingLabel(rating)}。下次复习：${formatShort(question.dueAt)}。复习记录已保存，AI 正在整理这次作答的复盘。`
    };
    ui.noteFeedback = null;
    await persist();
    ui.reviewSubmittingId = null;
    ui.selectedId = question.id;
    setView("library");
    void requestReviewFeedback(question, {
      answer,
      note,
      rating
    });
  }

  async function requestReviewFeedback(question, review) {
    ui.reviewFeedbackLoadingId = question.id;
    ui.reviewFeedbackError = null;
    render();
    try {
      const response = await fetch("/api/trial/review-feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          consent_version: TRIAL_CONSENT_VERSION,
          question: {
            stem: question.stem || "",
            student_answer: question.studentAnswer || null,
            correct_answer: question.correctAnswer || null,
            hint: question.hint || "",
            key_steps: Array.isArray(question.steps) ? question.steps : [],
            prior_note: question.note || ""
          },
          review
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.data) {
        throw new Error(payload?.error?.message || "AI 复盘暂时不可用，本次复习已经保存。");
      }
      const data = payload.data;
      question.reviewFeedback = {
        summary: String(data.summary || "").trim(),
        likelyGap: String(data.likely_gap || "").trim(),
        nextCheck: String(data.next_check || "").trim(),
        noteSuggestion: String(data.note_suggestion || "").trim(),
        generatedAt: new Date().toISOString(),
        requestId: payload.request_id || null
      };
      await persist();
      ui.reviewFeedbackLoadingId = null;
      ui.reviewFeedbackError = null;
      render();
    } catch (error) {
      ui.reviewFeedbackLoadingId = null;
      ui.reviewFeedbackError = {
        id: question.id,
        message: error?.message || "AI 复盘暂时不可用，本次复习已经保存。"
      };
      render();
    }
  }

  function saveProfile() {
    const name = sanitize(document.getElementById("profileName")?.value) || defaultProfile().name;
    const classText = sanitize(document.getElementById("profileClassText")?.value) || defaultProfile().classText;
    const goal = sanitize(document.getElementById("profileGoal")?.value) || defaultProfile().goal;
    const note = sanitize(document.getElementById("profileNote")?.value) || defaultProfile().note;
    state.trial = normalizeTrialControl(state.trial);
    state.trial.analysisDisabled = Boolean(document.getElementById("trialAnalysisDisabled")?.checked);
    state.profile = { name, classText, goal, note };
    void persist();
    render();
  }

  function downloadJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      profile: state.profile,
      trial: state.trial,
      questions: state.questions
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `recall-ai-backup-${formatDateFilename(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function clearAll() {
    if (!confirm("确定清空全部本机数据吗？这会删除所有错题、便签和复习记录。")) return;
    const clearResult = await stateRepository.clear();
    storageDriver = clearResult.driver;
    if (!clearResult.ok) {
      ui.storageNotice = clearResult.notice;
      render();
      return;
    }
    const preservedAccess = state.access;
    const preservedProfile = state.profile;
    const preservedTrial = state.trial;
    state = defaultState();
    state.access = preservedAccess;
    state.profile = preservedProfile;
    state.trial = preservedTrial;
    state.keepEmptyOnLoad = true;
    ui.draft = null;
    ui.analysisError = null;
    ui.uploadError = null;
    ui.selectedId = null;
    ui.processing = null;
    ui.reviewAnswer = "";
    ui.reviewNote = "";
    await persist();
    render();
  }

  function setView(view) {
    ui.view = TAB_ORDER.includes(view) ? view : "home";
    render();
  }

  function questionById(id) {
    return state.questions.find((item) => item.id === id) || null;
  }

  function isTraditionalQuestion(question) {
    return question?.sourceType === "traditional";
  }

  function isReviewableQuestion(question) {
    return Boolean(question) && question.status !== "draft" && question.status !== "archived" && !isTraditionalQuestion(question);
  }

  function questionsByStatus(status) {
    return state.questions.filter((item) => {
      if (status === "draft") return item.status === "draft";
      if (status === "confirmed") return item.status === "confirmed";
      if (status === "archived") return item.status === "archived";
      if (status === "traditional") return item.status !== "archived" && isTraditionalQuestion(item);
      if (status === "due") return isReviewableQuestion(item) && isDue(item.dueAt);
      return true;
    });
  }

  function filteredQuestions() {
    const search = ui.search.trim().toLowerCase();
    return state.questions
      .filter((item) => {
        if (ui.statusFilter === "all") return item.status === "confirmed";
        if (ui.statusFilter === "traditional") return item.status !== "archived" && isTraditionalQuestion(item);
        if (ui.statusFilter === "due") return isReviewableQuestion(item) && isDue(item.dueAt);
        return item.status === ui.statusFilter;
      })
      .filter((item) => {
        if (!search) return true;
        const source = [item.title, item.subject, item.knowledge, item.errorType, item.stem, item.note].join(" ").toLowerCase();
        return source.includes(search);
      })
      .sort((a, b) => priorityScore(b) - priorityScore(a));
  }

  function reviewQueue() {
    return state.questions
      .filter((item) => isReviewableQuestion(item) && isDue(item.dueAt))
      .sort((a, b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0));
  }

  function selectedReviewQuestion(queue) {
    if (!queue.length) return null;
    if (ui.selectedId) {
      const selected = queue.find((item) => item.id === ui.selectedId);
      if (selected) return selected;
    }
    ui.selectedId = queue[0].id;
    return queue[0];
  }

  function recentQuestions(limit) {
    return state.questions
      .filter((item) => item.status !== "archived" && item.status !== "draft")
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .slice(0, limit);
  }

  function duePreviewList(limit) {
    return reviewQueue()
      .slice(0, limit)
      .map((q) => renderQuestionCard(q, { compact: true, actions: true, reviewMode: false }))
      .join("");
  }

  function computeStats() {
    const due = reviewQueue();
    const confirmed = questionsByStatus("confirmed");
    const draftCount = questionsByStatus("draft").length;
    const confirmedCount = confirmed.length;
    const noteCount = confirmed.filter((item) => (item.note || "").trim()).length;
    const reviewLogs = confirmed.flatMap((item) => item.history || []);
    const weeklyReviews = reviewLogs.filter((item) => {
      const time = new Date(item.reviewedAt).getTime();
      return Number.isFinite(time) && Date.now() - time <= 7 * 24 * 60 * 60 * 1000;
    }).length;
    const top = topSubjects();
    return {
      dueCount: due.length,
      draftCount,
      confirmedCount,
      noteCount,
      reviewLogCount: reviewLogs.length,
      weeklyReviews,
      subjectCount: top.length,
      subjectNames: top.length
        ? top.map((item) => `${item.name} ${item.count} 道`).join(" · ")
        : "暂时没有科目记录",
      dueCopy: due.length
        ? `有 ${due.length} 道到期题，先处理它们。`
        : "今天没有到期题，可以先上传新错题。",
      subjectItems: top
    };
  }

  function topSubjects() {
    const counts = new Map();
    state.questions
      .filter((item) => item.status === "confirmed")
      .forEach((item) => {
        const key = normalizeSubject(item.subject);
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  }

  function todaySummary() {
    const due = reviewQueue().length;
    if (due === 0) return "今日已完成";
    if (due === 1) return "1 道待复习";
    return `${due} 道待复习`;
  }

  function renderHomeOnly() {
    renderHeroStats();
    appView.innerHTML = renderHomeView();
    hydrateIcons(appView);
    syncDraftPreview();
  }

  function questionStatusMeta(q) {
    if (isTraditionalQuestion(q)) return { label: "传统错题", badge: "gray" };
    if (q.status === "draft") return { label: "待确认", badge: "amber" };
    if (q.status === "archived") return { label: "已归档", badge: "gray" };
    if (isDue(q.dueAt)) return { label: "待复习", badge: "red" };
    return { label: "已确认", badge: "teal" };
  }

  function priorityScore(question) {
    let score = 0;
    if (question.status === "draft") score -= 20;
    if (question.status === "archived") score -= 100;
    if (isDue(question.dueAt)) score += 60;
    score += question.reviewCount || 0;
    score += question.note ? 5 : 0;
    score += new Date(question.updatedAt || question.createdAt).getTime() / 1000000000000;
    return score;
  }

  function isDue(dateString) {
    if (!dateString) return false;
    const time = new Date(dateString).getTime();
    return Number.isFinite(time) && time <= Date.now();
  }

  function computeInitialDue() {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  function formatShort(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function formatDue(value) {
    if (!value) return "未排期";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未排期";
    const diff = Math.round((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (diff <= -1) return `逾期 ${Math.abs(diff)} 天`;
    if (diff === 0) return "今天到期";
    if (diff === 1) return "明天到期";
    return `${diff} 天后`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024 * 1024) {
      return `${Math.max(1, Math.round(value / 1024))}KB`;
    }
    const mb = value / (1024 * 1024);
    return `${mb.toFixed(Number.isInteger(mb) ? 0 : 1)}MB`;
  }

  function formatDateFilename(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  }

  function todayKey() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function ratingLabel(rating) {
    const map = REVIEW_RATINGS[rating] || REVIEW_RATINGS.good;
    return map.label;
  }

  function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function renderButtonIcon(name) {
    const normalized = String(name || "")
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      .replace(/^([A-Z])/, (match) => match.toLowerCase());
    const icon = ICONS[normalized] || ICONS.help;
    return icon;
  }

  const ICONS = {
    upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg>`,
    spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8Z"/><path d="m19 14 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.3"/><path d="M3 12a9 9 0 0 1 15.5-6.3"/><path d="M3 4v6h6"/><path d="M21 20v-6h-6"/></svg>`,
    review: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>`,
    x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12"/><path d="m18 6-12 12"/></svg>`,
    arrowRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>`,
    book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 3H20v18H6.5A2.5 2.5 0 0 0 4 23.5v-18A2.5 2.5 0 0 1 6.5 3Z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
    archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16v3H4z"/><path d="M6 10v10h12V10"/><path d="M10 14h4"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`,
    bookmark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4Z"/></svg>`,
    note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h10l4 4v14H7z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>`,
    arrowLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></svg>`,
    help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 18h.01"/><path d="M9.1 9a3 3 0 1 1 4.9 2.4c-.9.7-1.5 1.4-1.5 2.6"/><circle cx="12" cy="12" r="9"/></svg>`
  };

  function hydrateIcons(root) {
    root.querySelectorAll("[data-icon]").forEach((node) => {
      const name = node.getAttribute("data-icon");
      node.innerHTML = renderButtonIcon(name);
    });
  }

  hydrateIcons(document);
})();
