# Recall AI 三天试用版运行手册

版本：V0.1  
日期：2026-08-10

## 1. 启动前检查

确认项目根目录存在 `.env.local`，并包含：

```env
DASHSCOPE_API_KEY=your_key
QWEN_MODEL=qwen-vl-plus
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

不要把 Key 发到聊天、截图或提交记录里。

## 2. 启动应用

默认端口：

```powershell
node .\server.mjs
```

如果 4173 已被占用：

```powershell
$env:PORT='4174'
node .\server.mjs
```

访问：

```text
http://localhost:4174/
```

受控试用口令：

```text
recall
```

## 3. 试用任务

1. 阅读告知并输入口令。
2. 上传一张脱敏的清晰单题数学图片，或用文字录入一道错题题干。
3. 等待千问返回待确认草稿。
4. 对照原图修改至少一个字段。
5. 确认入库。
6. 在详情页写一句自己的解题便签。
7. 完成一次复习并自评。

## 4. 本地检查命令

```powershell
node --check .\server.mjs
node --check .\web\app.js
node .\web\trial-api-contract.test.mjs
$env:NODE_PATH='C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:TRIAL_APP_URL='http://localhost:4174/'
node .\web\trial-smoke.test.mjs
```

## 5. 试用边界

- 只给 3-5 名已知情成年测试者使用。
- 不上传真实未成年人图片、姓名、学校、联系方式等信息。
- 本地服务端只临时转发图片给千问模型，不保存原图。
- 浏览器只保存用户确认后的错题、便签和复习记录。
- 清空本机数据不会撤回模型供应商已经处理过的历史请求。
