# 部署：常駐電腦、手機連線與雲端備份

StarBrain 跑在你家裡一台常駐電腦上，手機透過 Cloudflare 連回來。這份文件依序說明：

1. 讓電腦開機後自動啟動 StarBrain
2. 用 Cloudflare Tunnel 開一個網址給手機用，並用 Cloudflare Access 限定只有你能登入
3. 把每日備份同步到 Google Drive
4. 在手機安裝 App

---

## 1. 常駐啟動（Windows）

先在專案資料夾建置一次：

```bash
npm install
npm run build
```

再用「工作排程器」讓它在登入時自動啟動。以下指令在 **PowerShell** 執行，把 `<專案資料夾>` 換成你的路徑（例如 `D:\StarBrain`）：

```powershell
$action = New-ScheduledTaskAction -Execute "npm.cmd" -Argument "start" -WorkingDirectory "<專案資料夾>"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "StarBrain" -Action $action -Trigger $trigger -Settings $settings
```

- 啟動後在電腦上開 <http://127.0.0.1:3700> 確認畫面正常。
- 更新程式後：`npm run build`，再到工作排程器把 StarBrain 工作「結束」後「執行」。
- 要移除：`Unregister-ScheduledTask -TaskName "StarBrain"`。

> 後端只聽 `127.0.0.1`，區網或外網都連不到，只能透過下一步的 Cloudflare Tunnel 進來。

---

## 2. 手機連線：Cloudflare Tunnel + Access

需要：一個託管在 Cloudflare 的網域，以及已安裝的 `cloudflared`。

### 2-1. 開一個網址

**已經有遠端管理的 Tunnel（用 token 執行的 cloudflared 服務）**：直接在儀表板加一個主機名稱即可，不必改本機設定檔，也不必重啟服務。

1. Cloudflare 儀表板 → **Zero Trust** → **Networks** → **Tunnels**
2. 點選你的 Tunnel → **Public Hostname** → **Add a public hostname**
3. 填寫：
   - Subdomain：`starbrain`
   - Domain：你的網域
   - Service：`HTTP`，URL：`127.0.0.1:3700`
4. 儲存。

**還沒有 Tunnel**：在同一頁 **Create a tunnel** → 選 **Cloudflared** → 依畫面指示在電腦安裝服務，再照上面第 2～4 步加主機名稱。

### 2-2. 只讓你自己登入

沒有這一步，任何人知道網址都能看到你的資料，**請務必設定**。

1. **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**
2. Application domain：填上一步的網址（例如 `starbrain.你的網域`）
3. Session duration：建議 `1 month`，手機才不用常常重新登入
4. 新增 Policy：
   - Action：`Allow`
   - Include → `Emails` → 填你自己的 email
5. 儲存。

之後打開網址會先看到 Cloudflare 的登入頁，輸入 email 收驗證碼即可。

### 2-3. 電腦關機時

- 手機上記的紀錄與想法會先存在手機裡，頂部列會出現「待送出」的圖示。
- 電腦開機、恢復連線後會自動補送，紀錄的時間仍是你當下記錄的時間。
- 如果 Cloudflare Access 的登入過期，也會先暫存；重新整理頁面、登入後就會送出。

---

## 3. 雲端備份：Google Drive

StarBrain 每天會自動把完整資料備份成一個 JSON 檔，預設存在資料資料夾裡的 `backups`，保留最近 30 份。要同步到雲端，最簡單的方式是讓備份寫進 Google Drive 的資料夾：

1. 安裝 [Google Drive 電腦版](https://www.google.com/drive/download/)並登入。
2. 在 Drive 裡建立資料夾，例如 `StarBrain-backups`，確認它在電腦上的路徑（例如 `H:\我的雲端硬碟\StarBrain-backups`，磁碟代號依你的電腦而定）。
3. 在專案的 `.env` 加入：

   ```
   STARBRAIN_BACKUP_DIR=H:\我的雲端硬碟\StarBrain-backups
   ```

4. 重新啟動 StarBrain。

> 資料庫本身不要放進 Google Drive 資料夾：同步程式在資料庫開啟中複製檔案，容易造成損毀。只放備份檔是安全的。

**還原**：齒輪設定 → 備份 → 在清單選一份按「還原」。還原前會先自動把目前的資料再備份一次，按錯也能找回來。

---

## 4. 在手機安裝 App

- **Android（Chrome）**：開啟網址 → 右上角選單 → **安裝應用程式**。
- **iPhone（Safari）**：開啟網址 → 分享按鈕 → **加入主畫面**。

安裝後長按 App 圖示，可以用「記下想法」捷徑直接打開想法收件匣。

---

## 疑難排解

| 狀況 | 可能原因 |
|---|---|
| 頂部列的燈是紅色 | 電腦上的 StarBrain 沒有在跑，或 Tunnel 沒連上 |
| 手機一直出現「待送出」 | 電腦關機，或 Access 登入過期（重新整理頁面） |
| 打開網址出現 502 / 530 | Tunnel 正常，但電腦上的 StarBrain 沒有啟動 |
| 手機上沒有「安裝」選項 | 必須用 https 網址開啟，並先完成 Access 登入 |
