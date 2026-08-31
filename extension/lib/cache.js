/**
 * Cache kết quả lồng tiếng theo IndexedDB, để xem lại bài không phải dịch/
 * tổng hợp giọng lại từ đầu.
 *
 * Lưu ý: đây là IndexedDB của TRANG (coursera.org), không phải kho riêng của
 * extension — content script không truy cập được extension storage dạng
 * IndexedDB mà không định tuyến qua background. Đơn giản hơn là dùng luôn
 * storage của trang; xoá "site data" của Coursera trong Chrome sẽ xoá luôn
 * cache này, đó là đánh đổi chấp nhận được cho một công cụ chỉ chạy trên
 * đúng site này.
 */
var DUB = globalThis.DUB || (globalThis.DUB = {});

(function () {
  const DB_NAME = 'local-ai-vi-dub';
  const STORE = 'dubs';
  const DB_VERSION = 1;
  // Mỗi bản ghi mang theo audio 5-15 MB. Không giới hạn thì IndexedDB của
  // trang phình tới khi chạm quota rồi mọi lần ghi sau đều hỏng.
  const MAX_RECORDS = 12;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Khoá cache: những gì làm bản lồng tiếng khác hẳn đi.
   *
   * CỐ TÌNH không đưa viSyllablesPerSec vào đây. Tốc độ đọc tự hiệu chỉnh sau
   * mỗi job, nên nếu nó nằm trong khoá thì lần xem lại nào cũng trượt cache và
   * phải dịch lại từ đầu. Bản đã lồng tiếng vẫn nghe bình thường dù lần sau
   * planner dùng tốc độ khác một chút.
   */
  function makeKey({ videoId, voice, planVersion, translationModel }) {
    return JSON.stringify([
      videoId,
      voice || 'default',
      planVersion || 'v1',
      translationModel || '',
    ]);
  }

  async function get(keyParts) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(makeKey(keyParts));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(keyParts, record) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key: makeKey(keyParts), ...record, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error); // quota đầy đi đường này
    });
    await trim(db);
  }

  /** Giữ MAX_RECORDS bản mới nhất, xoá phần còn lại. */
  function trim(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const records = (req.result || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        for (const stale of records.slice(MAX_RECORDS)) store.delete(stale.key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  DUB.cache = { get, put, MAX_RECORDS };
})();
