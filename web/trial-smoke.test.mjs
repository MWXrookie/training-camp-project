import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE_URL = process.env.TRIAL_APP_URL || "http://localhost:4174/";
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const results = [];

function ok(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) {
    throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  }
}

function remainingAnalysisText(text) {
  return text.match(/今日剩余\s+(\d+)\/\d+\s*次/)?.[1] || null;
}

async function clickVisibleTab(page, tab) {
  await page.evaluate((tabName) => {
    const el = Array.from(document.querySelectorAll(`[data-tab="${tabName}"]`))
      .find((node) => node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    if (!el) throw new Error(`visible tab not found: ${tabName}`);
    el.click();
  }, tab);
  await page.waitForTimeout(250);
}

async function clickVisibleAction(page, action, options = {}) {
  await page.evaluate(({ actionName, shiftKey }) => {
    const el = Array.from(document.querySelectorAll(`[data-action="${actionName}"]`))
      .find((node) => (node.offsetWidth || node.offsetHeight || node.getClientRects().length) && !node.disabled);
    if (!el) throw new Error(`visible action not found: ${actionName}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey }));
  }, { actionName: action, shiftKey: Boolean(options.shiftKey) });
  await page.waitForTimeout(options.wait ?? 250);
}

async function enterTrial(page) {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(600);
  const gateVisible = await page.locator("#accessCode").isVisible().catch(() => false);
  if (gateVisible) {
    await page.locator("#accessCode").fill("recall");
    await page.locator("#accessNotice").check({ force: true });
    await page.locator("[data-action='accept-access']").click();
    await page.waitForTimeout(600);
  }
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  ok(`${label} no horizontal overflow`, !overflow);
}

async function runSchemaCheck() {
  const schema = JSON.parse(await readFile(new URL("./trial-schema.json", import.meta.url), "utf8"));
  ok("schema has object root", schema.type === "object");
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  ok("schema has success branch", branches.some((branch) => branch.required?.includes("data") && branch.required?.includes("request_id")));
  ok("schema has error branch", branches.some((branch) => branch.required?.includes("error") && branch.required?.includes("request_id")));
}

async function runBrowserChecks() {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) logs.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  await enterTrial(page);
  ok("access gate unlocks", !(await page.locator("#accessCode").isVisible().catch(() => false)));
  await assertNoOverflow(page, "home");
  const health = await page.evaluate(() => fetch("/api/trial/health").then((response) => response.json()));
  ok("server exposes expanded analysis limit", health?.trial_limits?.analysis?.limit === 50);
  ok("server exposes expanded review feedback limit", health?.trial_limits?.review_feedback?.limit === 50);
  ok("home identifies AI product", (await page.locator("#heroCopy").innerText()).includes("AI 错题复习"));
  ok(
    "home makes AI value visible",
    (await page.locator(".ai-value-strip").innerText()).includes("录入时") &&
      (await page.locator(".ai-value-strip").innerText()).includes("复习后") &&
      (await page.locator(".ai-value-strip").innerText()).includes("AI 复盘")
  );
  ok("home has one entry to create flow", await page.locator("[data-action='goto-create']").count() === 1);
  ok("home quick links exclude duplicate upload entry", await page.locator(".home-quick-grid [data-action='goto-create']").count() === 0);

  await clickVisibleAction(page, "goto-create");
  ok("home opens dedicated create view", (await page.locator("#appView").innerText()).includes("选择一种录入方式"));
  ok("create view keeps home tab active", await page.locator(".tab[data-tab='home'].is-active").count() === 1);
  ok(
    "trial stage exposes expanded analysis limit",
    remainingAnalysisText(await page.locator(".home-drop-zone .drop-desc").first().innerText()) === "50"
  );

  await page.locator("#textUploadStem").fill("已知 2x + 3 = 9，求 x。");
  await clickVisibleAction(page, "create-text-draft");
  const textDraftText = await page.locator("#appView").innerText();
  const textDraftStem = await page.locator("#draftForm textarea[name='stem']").inputValue();
  ok("text upload creates draft", textDraftText.includes("文字草稿") && textDraftStem.includes("2x + 3 = 9"));
  await clickVisibleAction(page, "clear-draft");

  await page.locator("#textUploadStem").fill("x^2y^3 + a_{i+1}^2 + x^(-1)");
  await clickVisibleAction(page, "create-text-draft");
  const mathDraftHtml = await page.locator("[data-math-preview='stem'] div").innerHTML();
  ok(
    "latex scripts render separate exponents and subscript exponent",
    mathDraftHtml.includes("x<sup>2</sup>y<sup>3</sup>") &&
      mathDraftHtml.includes("a<sub>i+1</sub><sup>2</sup>") &&
      mathDraftHtml.includes("x<sup>-1</sup>")
  );
  await clickVisibleAction(page, "clear-draft");

  await page.route("**/api/trial/analyze", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: `{"data":{"stem":"已知 \\frac{x^2}{2}+3=5，求 x。","student_answer":"x = 1","correct_answer":"x = 2","knowledge_tags":["一元一次方程"],"error_type":"calculation_error","explanation":{"hint":"先看 \\text{题干} 再处理 \\frac{x^2}{2}。","key_steps":["\\frac{x^2}{2}=2","x^2=4"],"full_solution":"由 \\frac{x^2}{2}+3=5 得到 x^2=4。"},"risk_flags":[]},"request_id":"trial_req_upload_mock"}`
    });
  });
  const uploadPath = join(tmpdir(), `recall-ai-upload-${Date.now()}.png`);
  await writeFile(uploadPath, Buffer.from(PNG_1X1, "base64"));
  await page.locator("#fileInput").setInputFiles(uploadPath);
  await page.waitForTimeout(500);
  ok("image upload opens cropper", (await page.locator("#appView").innerText()).includes("先框出你要分析的那一题"));
  await assertNoOverflow(page, "cropper");
  ok("cropper has drag handles", await page.locator("[data-crop-handle]").count() >= 8);
  await page.locator(".cropper-selection").scrollIntoViewIfNeeded();
  const cropReadoutBefore = await page.locator(".cropper-selection-readout").innerText();
  const cropBox = await page.locator(".cropper-selection").boundingBox();
  ok("cropper selection is visible", Boolean(cropBox));
  await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cropBox.x + cropBox.width / 2 + 24, cropBox.y + cropBox.height / 2 + 24);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const cropReadoutAfter = await page.locator(".cropper-selection-readout").innerText();
  const cropHitTarget = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName}.${el.className}` : "none";
  }, { x: cropBox.x + cropBox.width / 2, y: cropBox.y + cropBox.height / 2 });
  ok(
    "cropper drag updates selection",
    cropReadoutAfter !== cropReadoutBefore,
    `${cropReadoutBefore} -> ${cropReadoutAfter}; box=${JSON.stringify(cropBox)}; hit=${cropHitTarget}`
  );
  await clickVisibleAction(page, "analyze-crop", { wait: 1200 });
  await page.locator("#draftForm textarea[name='stem']").waitFor({ state: "visible", timeout: 5000 });
  ok("remote upload path creates draft", (await page.locator("#appView").innerText()).includes("确认前不会入库"));
  const dirtyStemValue = await page.locator("#draftForm textarea[name='stem']").inputValue();
  const dirtyHintValue = await page.locator("#draftForm textarea[name='hint']").inputValue();
  ok("dirty latex text is repaired before draft rendering", dirtyStemValue.includes("\\frac") && dirtyHintValue.includes("\\text"));
  ok("draft renders latex preview", await page.locator(".math-preview .math-frac").count() >= 1);
  await clickVisibleAction(page, "clear-draft");
  await page.unroute("**/api/trial/analyze");

  await page.route("**/api/trial/analyze", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "not_question",
          message: "这张图片中没有可识别的中学数学错题，请重新上传或重新裁剪。",
          details: { quota_consumed: false }
        },
        request_id: "trial_req_not_question_mock"
      })
    });
  });
  const quotaBeforeNotQuestion = remainingAnalysisText(await page.locator(".home-drop-zone .drop-desc").first().innerText());
  await page.locator("#fileInput").setInputFiles(uploadPath);
  await page.waitForTimeout(500);
  await page.locator(".cropper-selection").scrollIntoViewIfNeeded();
  await clickVisibleAction(page, "analyze-crop", { wait: 1200 });
  const notQuestionText = await page.locator("#appView").innerText();
  const quotaAfterNotQuestion = remainingAnalysisText(await page.locator(".home-drop-zone .drop-desc").first().innerText());
  ok("non-question image shows clear feedback", notQuestionText.includes("这张图片不是可分析的错题"));
  ok("non-question image does not consume quota", quotaBeforeNotQuestion === quotaAfterNotQuestion);
  await page.unroute("**/api/trial/analyze");

  await page.route("**/api/trial/analyze", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "schema_failed",
          message: "识别结果暂时不可用，请重试或手动填写。",
          details: {}
        },
        request_id: "trial_req_schema_mock"
      })
    });
  });
  await page.locator("#fileInput").setInputFiles(uploadPath);
  await page.waitForTimeout(500);
  await clickVisibleAction(page, "analyze-crop", { wait: 1200 });
  const schemaFailureText = await page.locator("#appView").innerText();
  ok("schema failure is recoverable", schemaFailureText.includes("结构化结果校验失败") && schemaFailureText.includes("手动填写"));
  ok("schema failure offers traditional fallback", schemaFailureText.includes("保存为传统错题"));
  await clickVisibleAction(page, "save-traditional-question", { wait: 500 });
  const traditionalText = await page.locator("#appView").innerText();
  ok("traditional question is saved", traditionalText.includes("已保存为传统错题") && traditionalText.includes("不生成 AI 分析"));
  const traditionalReviewButtons = await page.locator("[data-action='start-review']").count();
  ok("traditional question is not reviewable", traditionalReviewButtons === 0);
  await page.unroute("**/api/trial/analyze");

  await page.route("**/api/trial/analyze", (route) => {
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>Cloudflare tunnel error</body></html>"
    });
  });
  await clickVisibleTab(page, "home");
  await page.locator("#fileInput").setInputFiles(uploadPath);
  await page.waitForTimeout(500);
  await clickVisibleAction(page, "analyze-crop", { wait: 1200 });
  const nonJsonFailureText = await page.locator("#appView").innerText();
  ok("non-json analysis response explains tunnel failure", nonJsonFailureText.includes("外网转发或分析服务返回了异常页面"));
  ok("non-json analysis response offers traditional fallback", nonJsonFailureText.includes("保存为传统错题"));
  await clickVisibleAction(page, "clear-draft", { wait: 400 });
  await page.unroute("**/api/trial/analyze");

  await page.route("**/api/trial/analyze", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "schema_failed",
          message: "识别结果暂时不可用，请重试或手动填写。",
          details: {}
        },
        request_id: "trial_req_schema_manual_mock"
      })
    });
  });
  await clickVisibleTab(page, "home");
  await page.locator("#fileInput").setInputFiles(uploadPath);
  await page.waitForTimeout(500);
  await clickVisibleAction(page, "analyze-crop", { wait: 1200 });
  await page.locator("[data-action='manual-draft']").click();
  await page.waitForTimeout(400);
  ok("manual draft opens", (await page.locator("#appView").innerText()).includes("确认前不会入库"));
  await page.locator("#draftForm textarea[name='stem']").fill("化简 \\(\\frac{x^2}{2}+\\sqrt{9}\\)。");
  await page.waitForTimeout(200);
  ok("manual draft latex preview updates", await page.locator(".math-preview .math-frac").count() >= 1);
  await page.unroute("**/api/trial/analyze");

  await page.route("**/api/trial/explanation", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          reference: {
            hint: "先分别处理分式和根式。",
            key_steps: ["拆开计算", "再合并结果"],
            full_solution: "先分别处理分式和根式，再合并结果。"
          },
          what_it_tests: "考查分式与根式的基础运算。",
          your_gap: "你的步骤显示，公式书写和中间计算还需要逐步核对。",
          worked_example: "先分别处理分式和根式，再合并结果。",
          next_check: "下次先检查分母和根式是否按规则处理。",
          note_suggestion: "复杂公式先拆开算，再合并。"
        },
        request_id: "trial_req_explanation_mock"
      })
    });
  });

  await page.locator("[data-action='save-and-confirm']").click();
  await page.waitForTimeout(500);
  ok("confirmed question enters library", (await page.locator("#appView").innerText()).includes("错题详情"));
  ok("created question shows next steps", (await page.locator("#appView").innerText()).includes("已确认入库"));
  const learningExplanationText = await page.locator("#appView").innerText();
  ok("DeepSeek learning explanation is visible", learningExplanationText.includes("DeepSeek AI 学习解析") && learningExplanationText.includes("考查目标") && learningExplanationText.includes("你的答案与可能差距") && learningExplanationText.includes("下次先检查") && learningExplanationText.includes("便签建议"));
  await page.unroute("**/api/trial/explanation");

  await page.locator("[data-action='start-review']").first().click();
  await page.waitForTimeout(400);
  const uniqueNote = `smoke-review-${Date.now()}`;
  await page.route("**/api/trial/review-feedback", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          summary: "这次先写下了完整答案，复习过程比只看解析更有效。",
          likely_gap: "之前的主要问题可能是符号检查不稳定。",
          next_check: "下一次先单独检查移项后的符号。",
          note_suggestion: "移项后先检查符号，再继续计算。"
        },
        request_id: "trial_req_feedback_mock"
      })
    });
  });
  await page.locator("#reviewForm textarea[name='answer']").fill("x = 5");
  await page.locator("#reviewForm textarea[name='reviewNote']").fill(uniqueNote);
  await page.locator("[data-rating='good']").first().click();
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("[data-action='submit-review']"))
      .find((node) => (node.offsetWidth || node.offsetHeight || node.getClientRects().length) && !node.disabled);
    btn.click();
    btn.click();
  });
  await page.waitForTimeout(800);
  const timelineText = await page.locator(".timeline").innerText();
  ok("duplicate review submit is ignored", timelineText.split(uniqueNote).length - 1 === 1);
  ok("review result is visible", (await page.locator("#appView").innerText()).includes("复习已记录"));
  await page.waitForTimeout(500);
  ok("review AI feedback is visible", (await page.locator("#appView").innerText()).includes("AI 复盘"));
  await page.unroute("**/api/trial/review-feedback");

  await clickVisibleTab(page, "me");
  await page.locator("[data-action='clear-all']").click();
  await page.waitForTimeout(700);
  await clickVisibleTab(page, "library");
  ok("clear all keeps empty library", (await page.locator("#appView").innerText()).includes("还没有正式错题"));
  await assertNoOverflow(page, "library after clear");

  ok("browser has no console errors", logs.length === 0, logs.join("\\n"));
  await context.close();
  await browser.close();
}

try {
  await runSchemaCheck();
  await runBrowserChecks();
  console.log(`trial smoke passed (${results.length} checks)`);
} catch (error) {
  console.error("trial smoke failed");
  for (const result of results) {
    console.error(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.detail ? ` - ${result.detail}` : ""}`);
  }
  console.error(error);
  throw error;
}
