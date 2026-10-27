# STARBRAIN 專案架構與伺服器程序

本文依目前專案程式碼與部署文件整理，說明 STARBRAIN 的服務組成、資料流，以及搬到 Ubuntu Server 時會使用的程序與工具。主機端的 Ubuntu 設定是建置方案；除非特別標示，並不代表相關服務已在伺服器安裝或設定完成。

## 1. 架構總覽

```text
手機／電腦瀏覽器（React PWA）
        │ HTTPS
        ▼
Cloudflare Access（登入限制）
        │ Cloudflare Tunnel
        ▼
cloudflared（獨立常駐服務）
        │ HTTP：127.0.0.1:3700
        ▼
StarBrain Node.js 程序（由 systemd 管理）
  ├─ Hono API
  ├─ Vite 建置後的前端靜態檔
  ├─ SQLite：starbrain.db
  ├─ 每日備份排程（同一程序內）
  ├─ 手機收件匣同步輪詢（啟用設定時，同一程序內）
  └─ 選用 AI 服務連線
        │
        ├─ 本機 Ollama／OpenAI 相容模型
        └─ Claude／OpenAI／Gemini API

個人資料與金鑰：STARBRAIN_DATA_DIR（建議放 1TB HDD）
備份 JSON：STARBRAIN_BACKUP_DIR（建議放 HDD 的獨立目錄）
```

正式環境不需要分開啟動前端 Web 伺服器：`npm run build` 產生前端檔案後，後端會在同一個埠提供 API 與畫面。程式監聽 `127.0.0.1`，外部流量應經 Cloudflare Tunnel 轉送，不應直接把 3700 埠公開到區網或公網。

## 2. 專案程式與執行角色

| 元件 | 位置／工具 | 作用 | 常駐方式 |
|---|---|---|---|
| 前端 | `apps/web`：React、TypeScript、Vite、Three.js | PWA 介面、3D 宇宙、離線外殼與部分唯讀快取 | 建置成靜態檔，由後端提供；不需獨立常駐程序 |
| 後端 | `apps/server`：Node.js、Hono、TypeScript | API、資料驗證、AI 呼叫、備份及收件匣同步 | Ubuntu 上建議用 `systemd` 管理 `npm start` |
| 資料庫 | Node.js 內建 `node:sqlite` | 儲存紀錄、星體、群組、想法、設定；啟動時套用資料庫遷移 | SQLite 檔案位於資料目錄 |
| Service Worker | `apps/web/public/sw.js` | PWA 安裝、靜態檔快取、指定讀取 API 的離線唯讀快取 | 由瀏覽器執行，不是伺服器程序 |
| Tunnel | `cloudflared` | 將 Cloudflare 上的受保護主機名稱轉送到 `127.0.0.1:3700` | 作為獨立系統服務管理 |
| Access | Cloudflare Zero Trust 儀表板 | 限制哪些帳號能登入 STARBRAIN 網址 | Cloudflare 設定，不在此程式庫內 |
| SSH／防火牆 | Ubuntu `openssh-server`、`ufw` | 區域網路或 VPN 維護主機、限制網路埠 | Ubuntu 系統服務／防火牆規則 |
| 手機暫存收件匣（選用） | `tools/gas-inbox`：Google Apps Script | 電腦離線時代收手機送出的項目，伺服器之後領取 | Google Apps Script 雲端部署；伺服器端每 5 分鐘輪詢 |

### 開發與正式啟動

- `npm run dev`：以 `concurrently` 同時啟動後端監看程序及 Vite 開發伺服器；Vite 將 `/api` 轉送至後端。
- `npm run build`：先建置前端（TypeScript 檢查及 Vite），再編譯後端 TypeScript。
- `npm start`：啟動編譯後的後端；正式執行不使用 Vite 開發伺服器。
- 套件根目錄宣告 Node.js `>=22`，但 README 要求 Node.js 24 以上。伺服器建置依 README 使用 Node.js 24 LTS，以符合專案文件及內建 SQLite 的執行需求。

## 3. 請求與資料流

1. 瀏覽器透過 HTTPS 連至 Cloudflare Access，完成存取政策要求的登入。
2. Cloudflare Tunnel 將流量送至伺服器本機的 `127.0.0.1:3700`。
3. Hono 回應 `/api/*` API；其他頁面請求由同一後端提供 `apps/web/dist`。找不到的 API 路徑回傳 JSON 404。
4. API 使用 Node.js 內建 SQLite 讀寫資料。資料庫開啟 WAL 模式並啟用外鍵；初次啟動建立預設結構，之後依 `user_version` 逐版遷移。
5. 瀏覽器 Service Worker 快取 PWA 外殼及部分讀取資料。離線快取是唯讀顯示用途；待送出資料另由前端流程暫存並於連線恢復後補送。
6. 啟用 AI 時，後端依設定連線到本機模型服務或雲端模型 API。雲端模型會接收送交整理或提問的內容；使用前應按個人資料需求選擇提供者。

## 4. 資料、金鑰與備份

- `STARBRAIN_DATA_DIR`：SQLite 資料庫與 `secrets.json` 所在位置。未設定時預設為執行帳號家目錄下的 `.starbrain`。
- `STARBRAIN_BACKUP_DIR`：JSON 備份目錄。未設定時預設為資料目錄下的 `backups`。
- `STARBRAIN_BACKUP_KEEP`：備份保留份數，預設 30。
- `PORT`：後端埠號，預設 3700；目前正式啟動程式綁定 `127.0.0.1`。
- 設定程式會拒絕把個人資料目錄或備份目錄放在專案目錄內。
- 後端啟動時檢查備份：沒有備份或最新備份超過 24 小時就建立一份；之後每小時再檢查一次。備份採 JSON 暫存檔完成後改名，並修剪超出保留數量的舊備份。
- AI API 金鑰與手機收件匣 `ADMIN_TOKEN` 存在資料目錄的 `secrets.json`，不進 SQLite 匯出或備份；檔案以權限 `0600` 寫入。資料目錄因此也需要妥善限制作業系統存取權限。
- HDD 可存放 SQLite 與備份，但資料庫和備份應分開目錄；不要把開啟中的 SQLite 資料庫放進雲端同步資料夾。Ubuntu 的雲端備份同步工具目前尚未由專案部署文件指定。

建議的 Ubuntu 路徑例子（架設時建立並確認掛載後再使用）：

```dotenv
PORT=3700
STARBRAIN_DATA_DIR=/mnt/starbrain-data/data
STARBRAIN_BACKUP_DIR=/mnt/starbrain-data/backups
STARBRAIN_BACKUP_KEEP=30
```

實際路徑需依 HDD 的掛載點與目錄權限調整；不要直接照抄尚未建立的路徑。

## 5. Ubuntu Server 架設時使用的程序與工具

### 主機與維護工具

- Ubuntu Server 24.04 LTS：無桌面伺服器作業系統。
- OpenSSH Server：供區域網路或 VPN 管理；建議 SSH 金鑰登入，並在確認 Windows 端可以連線後再收緊密碼登入政策。
- `ufw`：設定主機防火牆。應只允許必要的 SSH 管理來源；StarBrain 的 3700 埠維持本機監聽，不需開放入站規則。
- Git：取得及更新專案原始碼。
- Node.js 24 LTS 與 npm：安裝相依套件、建置前端與後端、執行服務。依鎖定檔使用 `npm ci`。
- SQLite：由 Node.js 內建 `node:sqlite` 提供，不另裝獨立資料庫伺服器。

### 長駐服務

1. `starbrain.service`（建議名稱）：由 systemd 啟動 `npm start`，設定工作目錄、執行帳號、必要環境與故障重啟。它包住一個 Node.js 程序；備份檢查與收件匣輪詢是該程序內的計時工作，不另建 cron 工作。
2. `cloudflared.service`：獨立安裝及設定的 Cloudflare Tunnel 連線服務，轉送到 `http://127.0.0.1:3700`。Cloudflare Access 的登入政策需另外在 Zero Trust 儀表板設定。
3. `sshd.service`：Ubuntu 遠端維護服務。外部管理優先走 VPN，不應將 SSH 直接暴露到公網。

目前專案提供 Windows 工作排程器的常駐啟動步驟，尚未提供 Ubuntu 的 systemd unit、cloudflared 安裝指令或 HDD 掛載設定。以上是 Ubuntu 架設需要建立的系統層設定，不是 repo 內現成的部署檔。

### 建置與啟動流程

1. 檢查 SSD／HDD 健康狀況、網卡、LAN IP 與 DHCP 保留設定；安裝 Ubuntu Server 並先驗證 SSH。
2. 掛載 HDD，建立資料與備份目錄，設定由專用服務帳號讀寫；設定 systemd 等待資料磁碟掛載後再啟動 StarBrain。
3. 安裝 Node.js 24 LTS、npm、Git；複製專案及 `.env.example`，建立正式 `.env`。個人資料和金鑰不要放在 Git 工作目錄。
4. 在專案目錄執行 `npm ci` 和 `npm run build`。正式環境只需執行建置好的後端：`npm start`。
5. 建立並啟用 StarBrain 的 systemd 服務，確認 `systemctl status` 與日誌正常，再以本機 `curl http://127.0.0.1:3700/api/health` 驗證 API。
6. 安裝並啟用 `cloudflared` Tunnel，將 Cloudflare 主機名稱轉送到本機 3700 埠；設定 Cloudflare Access 僅允許指定帳號。
7. 以手機行動網路驗證登入、記錄與離線補送；檢查 HDD 上的資料庫和 JSON 備份，並實際演練還原。
8. 重開機確認 HDD 先掛載、StarBrain 和 Tunnel 自動恢復；停止或終止 StarBrain 程序，確認 systemd 能重新啟動服務。

部署驗收需同時確認：LAN/外網存取邊界正確、Access 可阻擋未授權登入、資料留在 HDD、備份可產生且可還原、重新開機與程序異常後能恢復。

## 6. 非必需或尚未決定的服務

- Docker／Docker Compose：目前沒有 Dockerfile 或 Compose 設定，現行架構直接以 Node.js、SQLite、systemd 運行，不需要為此另建容器方案。
- Nginx：單一 Web/API 埠由 Tunnel 轉送即可；目前專案沒有 Nginx 設定。
- AI 模型：StarBrain 可在不啟用 AI 時手動記錄。若選本機模型，需另行安裝 Ollama 或相容模型伺服器，並評估第四代 i5 的 CPU／RAM 能否負擔；不屬於基本網站服務依賴。
- 雲端備份：程式會產生本機 JSON 備份，但 repo 目前只寫 Windows 的 Google Drive 電腦版同步方式。Ubuntu 上要不要增加雲端同步工具，需另行選定和設定。
- 手機收件匣：只有設定 Google Apps Script 網址與 `ADMIN_TOKEN` 才會執行輪詢；未設定時不會阻擋主服務啟動。

## 7. 目前文件與實作的界線

- `docs/DEPLOY.md` 說明 Windows 工作排程器、Cloudflare Tunnel／Access、Windows Google Drive 電腦版與手機安裝；它不是 Ubuntu 操作手冊。
- 本文件根據目前程式碼描述架構，並列出 Ubuntu 建置需要的系統程序。要實際安裝前，仍須依主機路徑、服務帳號、網域與存取方式填入正式設定。
- README 的 Node.js 24+ 與根 `package.json` 的 `>=22` 宣告不一致；本建置規格採用 README 的 Node.js 24 LTS。
