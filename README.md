# ELD DMS 裝置查詢工具（QA 內部用）

把「ELD DMS 後台 headless 登入與資料存取」筆記裡的四步 curl 流程，包成一個
本機小網頁：QA 團隊在瀏覽器輸入帳密登入，之後就能用篩選、排序、分頁的介面
查詢 `/device` 的資料，不用自己記 curl 指令。

## 為什麼需要一個後端，不能純前端？

DMS 後台用的是 session cookie（`dms_qa_session`）+ CSRF（`XSRF-TOKEN` /
`X-XSRF-TOKEN`），這套機制是設計給「同網域的瀏覽器」用的。如果直接在網頁的
JS 裡對 `http://13.52.48.194` 發請求，會被瀏覽器的跨網域政策擋下來（尤其這
個網頁多半跑在 `localhost`，跟 DMS 不同源）。

所以這裡用一個小的 Node.js 後端替你代打筆記裡的四步流程（GET /login 拿
cookie → POST /login 帶 CSRF 送帳密 → GET 目標頁面挖 X-Inertia-Version →
帶 X-Inertia 標頭再 GET 一次拿 JSON），前端網頁只跟這個本機後端說話，帳密
只在登入當下經過後端轉送給 DMS，不會被寫死或存檔。

## 執行需求

- 這台機器（你的電腦、內網主機或跳板機）必須連得到 DMS 站台
  （目前設定是 `http://13.52.48.194`）。
- Node.js 18 以上。

## 安裝與啟動

```bash
cd dms-device-viewer
npm install
cp .env.example .env
# 編輯 .env，至少要填 DMS_BASE_URL；DMS_EMAIL / DMS_PASS 是選填的「預設帳號」

npm start
```

啟動後打開瀏覽器進 `http://localhost:3000`，會看到登入頁。

## 使用方式

1. **登入**：在登入頁輸入 DMS 的 email / 密碼，按登入。
   - 如果 `.env` 有設定 `DMS_EMAIL` / `DMS_PASS`，登入頁上方會多一顆
     「使用預設帳號登入」按鈕，不用每次手動打字；QA 團隊其他成員仍然可以
     在下面的表單輸入自己的帳密，不受這組預設值限制。
   - 密碼只會在登入當下經過本機後端轉送給 DMS，後端不會把密碼寫進檔案或
     長期存在記憶體裡。
2. 登入成功後會看到查詢表單：`device_kind`、`serial_number`、排序欄位/方向、
   每頁筆數。按查詢就會呼叫後端，後端幫你完成 CSRF + Inertia version 的
   流程，把 `props.devices`（Laravel paginator）顯示成表格。
3. 表格右上角有「匯出 CSV」跟「檢視原始 JSON」：
   - **匯出 CSV**：把目前這一頁的查詢結果存成 `.csv`（含 UTF-8 BOM，Excel
     開啟中文欄位不會亂碼），方便丟進比對流程或測試報告。
   - **檢視原始 JSON**：切換成看後端回傳的完整 JSON（就是 `props.devices`
     那包 paginator 物件），方便你接測試腳本或比對資料時直接複製。
4. 表格下方有上一頁/下一頁，對應 paginator 的 `prev_page_url` /
   `next_page_url`。
5. 結果區塊最下面有個可展開的「除錯資訊」面板，顯示這次查詢實際打了哪個
   路徑、DMS 回應的 HTTP 狀態碼、目前快取的 `X-Inertia-Version`、是不是有
   觸發過 409 重試——文件裡最容易踩坑的地方，這裡都攤開給你看，方便排查
   "為什麼查不到資料" 這類問題。
6. 右上角「登出」會清掉這個瀏覽器分頁對應的登入狀態。

## 版本不符（409）與登入逾時是怎麼處理的

這是文件裡最容易踩坑的兩個地方，這個工具已經內建處理：

- **X-Inertia-Version 對不上**：後端第一次查詢時會先用一次整頁 GET 挖出目前
  版號，之後同一個登入 session 內會快取這個版號、直接用它查 JSON，減少
  多打一次 request。如果伺服器回 409（通常是前端剛好重新部署，版號變了），
  後端會自動重抓一次最新版號、重試一次，前端使用者完全不會感覺到。
- **Session 過期 / 尚未登入**：無論是查詢時發現 session 已經失效（伺服器把
  你導回 `/login`，或 409 附的 `X-Inertia-Location` 指向 `/login`），後端都
  會回傳 401，前端會自動把畫面切回登入頁，重新登入一次即可（若有設定預設
  帳密，按一下快速登入按鈕就好）。

## 專案結構

```
dms-device-viewer/
├── server.js            後端 Express 伺服器（路由、session 管理）
├── src/
│   └── dmsClient.js      核心邏輯：登入 / 抓版號 / 抓 JSON（四步流程）
├── public/               前端網頁（純 HTML/CSS/JS，無框架）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── mock/
│   └── mock-server.js    僅供開發測試用的假 DMS 站台（見下方說明）
├── .env.example
└── package.json
```

## 關於 `mock/mock-server.js`

這不是要給 QA 團隊查資料用的東西，是開發這個工具時，在連不到真正
DMS 站台的環境下，拿來驗證「登入 / CSRF / Inertia 版號 / 409 重試 /
session 過期偵測」這幾個邏輯有沒有正確運作的假伺服器。如果你想在沒有真實
帳密、或想確認這個網頁本身有沒有問題時先跑一次，可以：

```bash
# 一個視窗：啟動假的 DMS 站台
node mock/mock-server.js
# 印出的測試帳號：mock@example.com / password123

# 另一個視窗：讓後端指向假站台
DMS_BASE_URL=http://localhost:4000 PORT=3000 npm start
```

打開網頁後在登入頁輸入 `mock@example.com` / `password123` 即可測試整個流程。

正式使用時，把 `.env` 的 `DMS_BASE_URL` 改回 `http://13.52.48.194`（或其他
正式/QA 站台網址）即可。

## 已知限制

- 登入狀態存在後端的記憶體裡，重啟 `npm start` 之後需要重新登入一次。
- 這是給內部 QA 用的單機小工具，沒有做多人權限管理；同一台機器上開啟這個
  網頁的每個瀏覽器分頁會各自維護自己的登入狀態。
- 若 DMS 站台之後改版（例如欄位、路由、認證方式改變），需要對照新的
  逆向工程筆記調整 `src/dmsClient.js`。
