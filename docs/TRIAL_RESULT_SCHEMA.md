# 三天试用版结构化结果 Schema

版本：V0.1  
日期：2026-08-10  
范围：`POST /api/trial/analyze` 或本地模拟分析适配器返回给前端的候选结果。

## 目标

试用版只需要支持“单图单题”的待确认草稿。模型或本地模拟适配器返回的内容不能直接成为正式错题，必须经过用户编辑和确认。

## 成功响应

```json
{
  "data": {
    "stem": "3x + 4 = 19，求 x。",
    "student_answer": "x = 4",
    "correct_answer": "x = 5",
    "knowledge_tags": ["一元一次方程"],
    "error_type": "sign_error",
    "explanation": {
      "hint": "先把常数项移到等号右边。",
      "key_steps": ["3x = 19 - 4", "3x = 15", "x = 5"],
      "full_solution": "移项后再除以 3，得到 x = 5。"
    },
    "risk_flags": []
  },
  "request_id": "trial_req_xxx"
}
```

## 错误响应

```json
{
  "error": {
    "code": "not_question",
    "message": "识别结果暂时不可用，请重试或手动填写。",
    "details": {}
  },
  "request_id": "trial_req_xxx"
}
```

## 字段规则

- `stem`：必填，题干文本；缺失时返回错误，不虚构题目。
- `student_answer`：可为 `null`；未识别时必须返回 `null` 并添加 `student_answer_missing`。
- `correct_answer`：可为 `null`；信息不足时不强行生成答案。
- `knowledge_tags`：字符串数组，最多 3 个。
- `error_type`：枚举值，允许 `sign_error`、`concept_gap`、`calculation_error`、`reading_error`、`missing_steps`、`insufficient_information`。
- `explanation.hint`：短提示，不直接替代用户作答。
- `explanation.key_steps`：关键步骤数组，允许为空数组。
- `explanation.full_solution`：完整解析，前端默认折叠。
- `risk_flags`：风险标志数组，允许 `low_image_quality`、`formula_uncertain`、`student_answer_missing`、`answer_uncertain`、`unsupported_question_type`。

## 前端处理原则

- 成功响应只生成待确认草稿。
- 用户确认前，不写入正式错题库，不创建复习任务。
- 任何未知字段都应忽略。
- 任一必填字段不合法时，前端进入可恢复失败状态。
- `risk_flags` 必须显示为需要核对的提示，而不是伪置信度。
