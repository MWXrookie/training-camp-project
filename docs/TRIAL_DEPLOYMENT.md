# Recall AI 受控试用部署手册

版本：V0.1  
范围：当前单体 Node 试用版，不是正式生产架构。

## 部署结论

当前版本采用一个 Node 服务同时提供网页和 `/api` 接口。部署到支持 Node.js 18+ 的托管平台后，平台会自动提供一个免费默认访问地址；受控试用不需要购买域名。

EdgeOne Pages 更适合静态前端托管。若使用 EdgeOne，需要另外部署 Node API 或迁移为 Cloud Functions，不能把当前 `server.mjs` 直接当作 Pages 静态站点的后端。

## 发布前提

- 只邀请 3-5 名已知情成年测试者；
- 不上传未成年人姓名、学校、联系方式或可识别头像；
- 已用 2-3 张脱敏题图完成真实链路验收；
- 不把 `.env.local`、模型 Key 或生产口令提交到代码仓库；
- 明确告知图片会发送给千问，确认后的结构化学习数据会发送给 DeepSeek；
- 通过 `npm run check`、`npm run test:contract` 和 `npm run test:security`。

## 托管平台配置

创建 Node.js Web Service，构建步骤可留空，启动命令填写：

```text
npm start
```

配置以下环境变量：

```env
NODE_ENV=production
HOST=0.0.0.0
TRIAL_ACCESS_CODE=仅通过平台密钥管理器填写的试用口令
DASHSCOPE_API_KEY=千问 Key
QWEN_MODEL=qwen-vl-max
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DEEPSEEK_API_KEY=DeepSeek Key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
TRIAL_DAILY_ANALYSIS_LIMIT=50
TRIAL_DAILY_FEEDBACK_LIMIT=50
TRIAL_DAILY_EXPLANATION_LIMIT=50
```

其余超时和 token 配置可按 `.env.example` 复制。不要把口令直接写进启动命令或前端文件。

## 上线检查

部署完成后依次打开：

```text
https://平台分配的默认地址/
https://平台分配的默认地址/api/trial/health
```

确认：

- 页面可以打开；
- 健康接口返回 `ok: true`；
- `access_control_configured` 为 `true`；
- 未输入口令时 AI 接口返回 `401 access_required`；
- 输入正确口令后浏览器能正常进入；
- 地址使用 HTTPS；
- 平台日志中没有 Key、原图、题干或答案；
- 服务平台不会在空闲后自动休眠到无法承受模型调用时长。

## 停用与回滚

出现模型费用异常、数据边界问题或用户无法恢复的阻断错误时，在平台环境变量中设置：

```env
TRIAL_AI_DISABLED=true
```

重新部署后，页面仍可使用文字录入、本机错题库和复习功能，但真实 AI 请求会被服务端拒绝。回滚到上一版本前先保留错误记录和验证结果。

## 当前限制

- 错题、便签和复习记录保存在浏览器本机，不支持跨设备；
- 服务端每日额度和访问会话保存在单进程内存，重启后会重置；
- 不支持正式账号、未成年人同意、数据库备份、对象存储删除审计和多实例扩容；
- 这只能作为受控试用部署，不能作为公开产品或正式生产发布。
