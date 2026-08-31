/** Chặn ở đây, TRƯỚC khi CSS áp dụng — đọc lựa chọn giao diện đã lưu (nếu có) và gán luôn vào <html>, để khỏi có một khung hình sáng loé lên rồi mới tối. */
(function () {
  try {
    var t = localStorage.getItem('ldub-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* localStorage có thể bị chặn — mặc định theo hệ thống */ }
})();
