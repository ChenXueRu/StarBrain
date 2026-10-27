// StarBrain 收件匣（Google Apps Script）
// 電腦連不到時，手機把要送出的紀錄與想法丟到這裡，存成 Google Drive 資料夾裡的一個 .json 檔；
// 電腦上的 StarBrain 開機後（之後每隔幾分鐘）來領取，匯入資料庫後再請這裡把檔案丟進垃圾桶。
//
// 兩把鑰匙：
//   PUT_TOKEN   手機用，只能放東西進來
//   ADMIN_TOKEN 電腦用，可以列出與刪除；只存在電腦的 secrets.json，不會出現在手機上
// 第一次部署前先在編輯器執行一次 setup()，到「執行紀錄」複製兩把鑰匙。

const FOLDER_NAME = 'StarBrain_Inbox'
const MAX_BYTES = 100 * 1024 // 單筆上限
const LIST_LIMIT = 50
const REF_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

// 建立資料夾與兩把隨機鑰匙（已經有就沿用），把它們印在執行紀錄裡
function setup() {
  const props = PropertiesService.getScriptProperties()
  if (!props.getProperty('FOLDER_ID')) props.setProperty('FOLDER_ID', DriveApp.createFolder(FOLDER_NAME).getId())
  if (!props.getProperty('PUT_TOKEN')) props.setProperty('PUT_TOKEN', randomToken())
  if (!props.getProperty('ADMIN_TOKEN')) props.setProperty('ADMIN_TOKEN', randomToken())
  Logger.log('PUT_TOKEN（填到 StarBrain 設定的「手機收件匣鑰匙」）：' + props.getProperty('PUT_TOKEN'))
  Logger.log('ADMIN_TOKEN（填到電腦的 secrets.json）：' + props.getProperty('ADMIN_TOKEN'))
}

function randomToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '')
}

// 只回報服務還活著，不洩漏任何資料
function doGet() {
  return json({ ok: true, service: 'starbrain-inbox' })
}

function doPost(e) {
  let request
  try {
    request = JSON.parse((e && e.postData && e.postData.contents) || '')
  } catch (err) {
    return json({ ok: false, error: 'bad-json' })
  }
  const props = PropertiesService.getScriptProperties()
  const folderId = props.getProperty('FOLDER_ID')
  if (!folderId) return json({ ok: false, error: 'not-setup' })
  const folder = DriveApp.getFolderById(folderId)

  if (request.action === 'put') {
    if (!request.token || request.token !== props.getProperty('PUT_TOKEN')) return json({ ok: false, error: 'unauthorized' })
    const item = request.item
    if (!item || typeof item !== 'object' || !REF_PATTERN.test(String(item.clientRef || ''))) return json({ ok: false, error: 'bad-item' })
    if (item.kind !== 'entry' && item.kind !== 'idea') return json({ ok: false, error: 'bad-item' })
    const content = JSON.stringify(item)
    if (Utilities.newBlob(content).getBytes().length > MAX_BYTES) return json({ ok: false, error: 'too-large' })
    const name = item.clientRef + '.json'
    // 同一筆重送不會產生第二個檔案
    const lock = LockService.getScriptLock()
    lock.waitLock(10000)
    try {
      if (!folder.getFilesByName(name).hasNext()) folder.createFile(name, content, 'application/json')
    } finally {
      lock.releaseLock()
    }
    return json({ ok: true })
  }

  if (request.action === 'list' || request.action === 'ack') {
    if (!request.token || request.token !== props.getProperty('ADMIN_TOKEN')) return json({ ok: false, error: 'unauthorized' })
  }

  if (request.action === 'list') {
    const items = []
    const files = folder.getFilesByType('application/json')
    while (files.hasNext() && items.length < LIST_LIMIT) {
      const file = files.next()
      try {
        items.push(JSON.parse(file.getBlob().getDataAsString('UTF-8')))
      } catch (err) {
        // 壞掉的檔案留著給人看，不影響其他筆
      }
    }
    return json({ ok: true, items: items })
  }

  if (request.action === 'ack') {
    const refs = Array.isArray(request.refs) ? request.refs.filter((ref) => REF_PATTERN.test(String(ref))) : []
    let removed = 0
    for (const ref of refs) {
      const files = folder.getFilesByName(ref + '.json')
      while (files.hasNext()) {
        files.next().setTrashed(true)
        removed++
      }
    }
    return json({ ok: true, removed: removed })
  }

  return json({ ok: false, error: 'unknown-action' })
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON)
}
