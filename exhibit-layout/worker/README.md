# 共用檔案庫（Cloudflare Worker + D1）部署步驟

展場配置頁會連到 `https://exhibit-layout.forest31345.workers.dev`。照下面做一次，頁面就會自動切換成共用檔案庫，不用改網頁。

1. **建資料庫**：Cloudflare 後台 → Storage & Databases → D1 → Create database，名稱 `exhibit-layout`。
2. **建 Worker**：Workers & Pages → Create → Worker（Hello World 範本），名稱一定要填 `exhibit-layout`，按 Deploy。
3. **貼程式**：進這個 Worker → Edit code → 全選刪掉 → 貼上 [`worker.js`](worker.js) 全部內容 → Deploy。
4. **接資料庫**：Worker → Settings → Bindings → Add → D1 database，Variable name 填 `DB`，資料庫選 `exhibit-layout` → 儲存（會自動重新部署）。
5. **確認**：打開 https://exhibit-layout.forest31345.workers.dev/health ，看到 `{"ok":true}` 就好了。資料表會在第一次存檔時自動建立。
6. 打開展場頁 → 檔案庫，說明文字變成「共用檔案庫」就是連上了。

## 規則
- 不用密碼；只接受來自 `aforesttw.github.io` 的網頁存檔（擋掉別的網站）。
- 每次存檔都新增一個版本，不覆蓋；刪除只是移到「最近刪除」，可復原。
- 單一檔案上限約 300 KB（一般配置只有幾 KB）。
