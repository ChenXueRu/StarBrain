# StarBrain 星腦

把每天的經驗記成星星，看見自己何時用「快思考」、何時用「慢思考」，以及哪裡需要加強。

- 每一件事是一顆 **星體**：第一次遇到誕生初星體，有成功產出就點亮，重複且認真思考過就升等。
- 目標一致的星體連成 **星系**（一項技能），再往上組成星系群、星系團……直到 **可觀測宇宙**（完整的你）。
- 以 3D 宇宙呈現，手機、電腦都能用，也可以安裝成手機 App（PWA）。
- 一句話說完發生的事，AI 幫你拆成七個思考節點；也可以直接問你的宇宙。
- 回顧畫面看快／慢思考比例、「快思考＋失敗」清單與長期黯淡的星系。

完整規劃見 [docs/PLAN.md](docs/PLAN.md)。

## 需求

- Node.js 24 以上（使用內建的 SQLite，不需另外安裝資料庫）

## 安裝與開發

```bash
npm install
cp .env.example .env
npm run dev
```

開發時打開 <http://localhost:5173>。

## 正式執行

```bash
npm run build
npm start
```

後端會同時提供 API 與前端畫面，預設在 <http://127.0.0.1:3700>。

開機自動啟動、手機連線（Cloudflare Tunnel + Access）與雲端備份的設定步驟，見 [docs/DEPLOY.md](docs/DEPLOY.md)。

## AI（選用）

不設定也能手動記錄。要用 AI 整理與「問宇宙」，在齒輪設定 → AI 對話選一個模型來源：

| 來源 | 需要 |
|---|---|
| 本地 Ollama | 安裝 [Ollama](https://ollama.com) 並下載模型 |
| 本機 OpenAI 相容 | vLLM、LM Studio 等服務的網址（填到 `/v1`） |
| Claude／OpenAI／Gemini | 該服務的 API 金鑰 |

API 金鑰只存在資料資料夾的 `secrets.json`，不會進資料庫、匯出檔或備份。
使用雲端模型時，紀錄內容會傳給該服務；本地模型不會離開你的電腦。

改了 AI 整理的提示詞後，可以用固定的 8 句口語跑回歸測試（需要模型在執行中）：

```bash
EVAL_AI_MODEL=<模型名稱> EVAL_AI_URL=http://127.0.0.1:8000/v1 npm run eval:parse -w apps/server
```

## 你的資料放在哪裡

所有個人資料都存在專案資料夾 **以外**（預設是使用者家目錄下的 `.starbrain`，可用 `.env` 的 `STARBRAIN_DATA_DIR` 修改）。
所以這個專案本身永遠是空白的，下載後你會得到一個全新的宇宙。

## 專案結構

```
apps/
  web/      前端（Vite + React + TypeScript）
  server/   後端（Node.js + Hono）
docs/       規劃文件
```

## 授權

[MIT](LICENSE)
