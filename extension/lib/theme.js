/**
 * Chặn ở đây, TRƯỚC khi CSS áp dụng — đọc lựa chọn giao diện đã lưu (nếu có)
 * và gán luôn vào <html>, để khỏi có một khung hình sáng loé lên rồi mới
 * tối. "Hệ thống" (không lưu gì) thì để CSS tự theo prefers-color-scheme.
 *
 * File riêng thay vì <script> inline trong <head> — CSP mặc định của MV3
 * cho extension_pages là "script-src 'self'", không cho phép script inline
 * dù có hay không host_permissions. options.html và popup.html cùng dùng
 * file này (nạp qua <script src="../lib/theme.js"> — external script load
 * đồng bộ, chặn parsing y hệt inline, không có độ trễ đáng kể vì đọc từ
 * gói extension, không qua mạng).
 */
(function () {
  try {
    var t = localStorage.getItem('ldub-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* localStorage có thể bị chặn — mặc định theo hệ thống */ }
})();
