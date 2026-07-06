# 專案時程追蹤（Jobs Gantt Chart）

用甘特圖管理專案時程、記錄每日執行內容、產生週報的網頁應用。
支援 **Google 帳號登入**，每位使用者的紀錄各自儲存在資料庫中，換裝置也能看到自己的資料。

## 功能

- **專案時程管理**：記錄每個專案的開始日期與預計完成日期，以甘特圖長條呈現，可標記狀態（進行中／已完成／暫停）。
- **每日執行紀錄**：每天輸入「今天在哪個專案做了什麼」，紀錄立即以圓點顯示在甘特圖對應日期上，滑鼠移過去即可看到內容；點時間格子可補記過去某一天。
- **進度百分比（選填）**：記錄進度時可順手填「整個專案目前完成度 %」。有 % 的專案長條會變成「空心軌道＋實心已完成段」並標示趴數；當天有更新 % 的日子顯示實心圓點、純文字紀錄顯示空心圓點。填不出趴數時留空即可，長條維持原本樣式。
- **週報檢視**：逐週瀏覽每天做了哪些事、目前進行中的專案，一鍵複製純文字週報。
- **週碼標示**：甘特圖表頭與週報標題顯示「W＋年份末碼＋兩位週數」的週碼（例：2026 年第 12 週 → W612，採 ISO 週數），點甘特圖上的週碼可直接跳到該週週報。
- **Google 登入 + 雲端儲存（選用）**：登入後資料依帳號存在 Postgres，自動儲存、換裝置可存取（右上角會顯示儲存狀態）。
- **訪客模式**：不登入也能使用，資料儲存在該瀏覽器的 localStorage；之後登入時可一鍵把本機資料匯入帳號。
- **資料備份**：可隨時匯出／匯入 JSON。

## 架構

- `server.js` — Node.js + Express：Google ID token 驗證、session cookie、資料 API
- `public/index.html` — 前端（單一檔案，無建置步驟）
- 資料庫 — Postgres（讀取 `DATABASE_URL`）；未設定時退回本機 `data/store.json`（僅供開發）

## 部署到 Railway

### 1. 建立 Google OAuth 憑證

1. 到 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 建立專案（或用現有的）。
2. 「APIs & Services → OAuth consent screen」：設定同意畫面（External、填應用名稱即可）。
3. 「Credentials → Create Credentials → OAuth client ID」，類型選 **Web application**：
   - **Authorized JavaScript origins** 加入你的 Railway 網址，例如 `https://你的服務.up.railway.app`
     （本機開發再加 `http://localhost:3000`）
   - Redirect URI 不需要填（本專案使用 Google Identity Services 的 ID token 流程）。
4. 記下 **Client ID**（形如 `xxxx.apps.googleusercontent.com`）。

### 2. 建立 Railway 專案

1. 在 [Railway](https://railway.app) 選 **New Project → Deploy from GitHub repo**，選這個 repo。
2. 在同一個專案中 **Create → Database → Add PostgreSQL**。
3. 到你的服務（web service）→ **Variables**，設定：

   | 變數 | 值 |
   |---|---|
   | `GOOGLE_CLIENT_ID` | 上一步的 Client ID |
   | `SESSION_SECRET` | 任意長隨機字串（可用 `openssl rand -hex 32` 產生） |
   | `DATABASE_URL` | 參照 Postgres 服務：`${{Postgres.DATABASE_URL}}` |

4. 到 **Settings → Networking → Generate Domain** 產生公開網址。
5. 回到 Google Cloud Console，把這個網址加進 OAuth client 的 **Authorized JavaScript origins**（若第 1 步還沒加）。

部署完成後打開網址，即會看到 Google 登入畫面；登入後資料會存進你自己的帳號。

## 本機開發

```bash
npm install
GOOGLE_CLIENT_ID=你的ClientID SESSION_SECRET=dev-secret npm start
# 打開 http://localhost:3000
```

未設定 `DATABASE_URL` 時，資料會寫到本機 `data/store.json`，方便開發測試。
記得把 `http://localhost:3000` 加入 OAuth client 的 Authorized JavaScript origins 才能在本機登入。

## API 摘要

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/config` | 取得前端所需設定（Google Client ID） |
| POST | `/api/auth/google` | 以 Google ID token 登入，發 session cookie |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/me` | 目前登入的使用者 |
| GET | `/api/state` | 取得自己的專案與紀錄 |
| PUT | `/api/state` | 儲存自己的專案與紀錄 |

## 注意事項

- 登入是選用的：未登入（訪客模式）時資料只存在該瀏覽器，換裝置或清除瀏覽資料會遺失。
- 訪客模式或舊版存在 localStorage 的資料，登入後若帳號是空的，系統會詢問是否匯入。
- Session 有效期 30 天，儲存於 httpOnly cookie。
