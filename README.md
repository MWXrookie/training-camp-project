# Recall AI 错题本

Recall AI 是一个 MVP 阶段的 AI 辅助错题复习产品。当前版本是三天受控试用版：面向少量已知情成年测试者，验证“上传错题 -> AI 草稿 -> 用户确认 -> 本机错题库 -> 便签 -> 复习 -> AI 复盘”这条核心链路是否成立。

它不是拍照搜答案工具。AI 只负责降低录入和复盘成本，最终题目内容、便签和学习判断仍由用户确认。

## 当前状态

- 本地 Web 端可用，默认地址为 `http://localhost:4174/`
- 已接入千问视觉模型用于图片错题分析
- 已接入复习后 AI 复盘
- 数据保存在当前浏览器本机，暂不支持跨设备同步
- 试用版只适合受控成年测试，不面向真实未成年人公开使用
- 可部署到支持 Node.js 18+ 的托管平台，平台默认子域名即可访问，不需要购买域名

详细进度见 [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md)。

## 试用前验收状态

- 前端脚本、服务端脚本、API 契约测试和浏览器冒烟测试已通过
- 本地健康检查显示千问模型配置可用
- 下一步应使用 2-3 张真实脱敏题图，人工走完上传、裁剪、AI 草稿、确认入库、便签、复习和 AI 复盘
- 人工验收通过后，再邀请 3-5 名已知情成年测试者试用

## 已实现能力

- 受控访问和 AI 图片处理告知
- 首页上传错题和文字录入错题
- 图片上传前框选题目区域
- 千问视觉识别并生成待确认草稿
- 用户编辑、核对并确认入库
- 错题库、错题详情、便签保存
- 今日复习、作答、自评和下次复习时间
- 复习提交后生成 AI 复盘
- AI 失败后保存为传统错题
- 本机数据导出和清空
- 每日试用分析次数限制
- 基础浏览器冒烟测试和 API 契约测试

## 产品边界

当前试用版不做：

- 正式账号和跨设备同步
- 未成年人正式使用与监护人同意流程
- 独立 OCR、一图多题自动切分、PDF
- 变式题、学习统计、支付和公开发布
- 生产级限流、供应商审计和成本监控

## 本地启动

1. 准备 Node.js 18 或更新版本。

2. 复制环境变量示例：

```powershell
Copy-Item .env.example .env.local
```

3. 在 `.env.local` 填入你的千问 Key：

```env
DASHSCOPE_API_KEY=your_dashscope_key_here
QWEN_MODEL=qwen-vl-plus
QWEN_TEXT_MODEL=qwen-plus
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

4. 启动本地服务：

```powershell
$env:PORT='4174'; node .\server.mjs
```

5. 打开：

```text
http://localhost:4174/
```

试用口令为：

```text
recall
```

## 受控部署

当前版本采用单个 Node 服务同时提供网页和 API。部署到支持 Node.js 18+ 的 Web Service，启动命令填写：

```text
npm start
```

部署平台会提供免费默认访问地址，不需要购买域名。生产环境必须设置 `TRIAL_ACCESS_CODE`，不要使用前端代码或启动命令保存口令。完整步骤见 [docs/TRIAL_DEPLOYMENT.md](docs/TRIAL_DEPLOYMENT.md)。

EdgeOne Pages 只适合静态前端托管，不能直接承载当前 `server.mjs` 的长时 AI API；如果使用 EdgeOne，需要另行部署 Node API 或迁移为 Cloud Functions。

## 测试命令

```powershell
node --check .\web\app.js
node --check .\server.mjs
node .\web\trial-api-contract.test.mjs
```

浏览器冒烟测试需要 Playwright/Edge 运行环境：

```powershell
$env:NODE_PATH='C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:TRIAL_APP_URL='http://localhost:4174/'
node .\web\trial-smoke.test.mjs
```

## 重要文档

- [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md)：当前项目状态
- [docs/TRIAL_TASK_ALLOCATION.md](docs/TRIAL_TASK_ALLOCATION.md)：三天试用任务看板
- [docs/API_SPEC.md](docs/API_SPEC.md)：本地 API 规格
- [docs/ERROR_LOG.md](docs/ERROR_LOG.md)：重复错误和复发问题记录
- [docs/TRIAL_PRELAUNCH_CHECKLIST.md](docs/TRIAL_PRELAUNCH_CHECKLIST.md)：试用前检查清单
- [docs/TRIAL_VALIDATION_RECORD.md](docs/TRIAL_VALIDATION_RECORD.md)：真实测试记录模板
- [Recall AI错题本产品需求文档_PRD_V2.0.md](Recall%20AI错题本产品需求文档_PRD_V2.0.md)：PRD
- [Recall AI 错题本 UIUX 设计方案.md](Recall%20AI%20错题本%20UIUX%20设计方案.md)：UIUX 基线
- [AI错题本技术方案.md](AI错题本技术方案.md)：技术方案
- [AI错题本系统架构图.md](AI错题本系统架构图.md)：系统架构

## 给测试者的提醒

- 上传图片前请尽量框住一道题，不要把整页多题全部框进去
- AI 生成的是待确认草稿，不会自动进入正式错题库
- 如果 AI 只识别出题干，可以先补充答案和便签再确认
- 如果 AI 无法识别，可以保存为传统错题，只保留图片和便签
- 复习后的 AI 复盘是辅助判断，不会覆盖你的便签或复习排期

## 安全说明

- `.env.local` 不进入版本库
- 模型 Key 只在服务端读取，不下发到浏览器
- 受控口令由服务端校验，AI API 使用 HttpOnly 会话 Cookie
- 服务端不持久化上传图片
- 当前本机数据清空只代表清除浏览器本地数据，不代表第三方供应商删除证明
