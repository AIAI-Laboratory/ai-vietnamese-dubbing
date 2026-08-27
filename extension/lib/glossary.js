/**
 * Thuật ngữ giữ nguyên tiếng Anh / dịch thống nhất, dùng khi sinh prompt dịch.
 *
 * Nguồn: đối chiếu với bản dịch máy sẵn có của Coursera trên bài giảng mẫu
 * "Introduction to Code Quality" — bản đó dùng lẫn lộn "lập trình viên" /
 * "nhà phát triển" (5-5), "nhóm" / "đội" (2-3), "mã sạch" / "mã nguồn sạch" /
 * "lập trình sạch" — đây chính là lỗi cần chặn bằng glossary cố định.
 *
 * Đây là danh sách khởi điểm cho nội dung lập trình/kỹ thuật nói chung.
 * Duyệt lại và bổ sung theo khoá học thực tế bạn dùng.
 */
var DUB = globalThis.DUB || (globalThis.DUB = {});

DUB.KEEP_ENGLISH = [
  'refactoring', 'refactor', 'code', 'clean code', 'code smell', 'code review',
  'bug', 'debug', 'deploy', 'commit', 'merge', 'pull request', 'unit test',
  'test', 'production', 'staging', 'API', 'framework', 'deadline', 'feature',
  'release', 'build', 'log', 'scale',
];

DUB.GLOSSARY = {
  developer: 'lập trình viên',
  developers: 'lập trình viên',
  team: 'nhóm',
  teams: 'nhóm',
  maintainability: 'khả năng bảo trì',
  readability: 'khả năng đọc hiểu',
  'technical debt': 'nợ kỹ thuật',
  shortcut: 'lối tắt',
  shortcuts: 'lối tắt',
  'software development': 'phát triển phần mềm',
  complexity: 'độ phức tạp',
  simplicity: 'sự đơn giản',
  clarity: 'sự rõ ràng',
};
